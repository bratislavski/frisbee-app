import { useEffect, useRef, useState } from 'react'
import './App.css'
import { Frisbee, type BoardEreignis, type BoardZustand, type WurfDaten } from './ble'
import { alsWav, fuerWhisper } from './audio'
import { LABELS, zuordnen, type Label } from './erkennung'
import { akkuExportieren, exportieren, speicher, type AkkuEintrag, type Session, type Wurf } from './speicher'

const ZUSTAND_ANZEIGE: Record<BoardZustand, { text: string; icon: string }> = {
  ruhe: { text: 'Bereit', icon: '🥏' },
  launch: { text: 'Launch', icon: '🚀' },
  fly: { text: 'Fly', icon: '💨' },
  landung: { text: 'Landung …', icon: '⬇️' },
  hoere: { text: 'Sprich jetzt!', icon: '🎤' },
  sende: { text: 'Empfange Ton …', icon: '📡' },
  schlaf: { text: 'Schläft – schütteln zum Aufwecken', icon: '😴' },
}

type Verbindung = 'aus' | 'verbinde' | 'an' | 'getrennt'
type WhisperStatus = { typ: 'aus' } | { typ: 'laedt'; prozent: number } | { typ: 'bereit' } | { typ: 'fehler'; text: string }

const neueId = () => crypto.randomUUID()

// Ungefaehre Ladung eines LiPo-Akkus aus der Spannung (ohne Last)
function akkuProzent(mv: number): number {
  const kurve: [number, number][] = [[3300, 0], [3500, 5], [3650, 20], [3750, 40], [3850, 60], [4000, 80], [4150, 100]]
  if (mv <= kurve[0][0]) return 0
  for (let i = 1; i < kurve.length; i++) {
    const [v1, p1] = kurve[i - 1], [v2, p2] = kurve[i]
    if (mv <= v2) return Math.round(p1 + ((mv - v1) / (v2 - v1)) * (p2 - p1))
  }
  return 100
}

export default function App() {
  const [verbindung, setVerbindung] = useState<Verbindung>('aus')
  const [fehler, setFehler] = useState('')
  const [zustand, setZustand] = useState<BoardZustand>('ruhe')
  const [session, setSession] = useState<Session | null>(null)
  const [wuerfe, setWuerfe] = useState<Wurf[]>([])
  const [alte, setAlte] = useState<Session[]>([])
  const [whisper, setWhisper] = useState<WhisperStatus>({ typ: 'aus' })
  const [akkuMv, setAkkuMv] = useState<number | null>(null)
  const [akkuLog, setAkkuLog] = useState<{ n: number; seit: number | null }>({ n: 0, seit: null })

  // Refs, weil die Bluetooth-Rueckrufe nur einmal angelegt werden
  const sessionRef = useRef<Session | null>(null)
  const wuerfeRef = useRef<Wurf[]>([])
  const frisbee = useRef<Frisbee | null>(null)
  const worker = useRef<Worker | null>(null)
  const wakeLock = useRef<WakeLockSentinel | null>(null)
  const autoVerbinden = useRef(false)   // nach Trennung selbst neu verbinden

  // ---------- Akku-Protokoll ----------
  const akkuMerken = (e: Omit<AkkuEintrag, 'zeit'>) => {
    void speicher.akku({ zeit: Date.now(), ...e })
    if (e.typ === 'mv') setAkkuLog(l => ({ n: l.n + 1, seit: l.seit ?? Date.now() }))
  }
  const akkuLogLaden = async () => {
    const log = (await speicher.akkuLog()).filter(e => e.typ === 'mv')
    setAkkuLog({ n: log.length, seit: log[0]?.zeit ?? null })
  }
  useEffect(() => { void akkuLogLaden() }, [])

  const aendere = (id: string, patch: Partial<Wurf>) => {
    wuerfeRef.current = wuerfeRef.current.map(w => (w.id === id ? { ...w, ...patch } : w))
    const w = wuerfeRef.current.find(x => x.id === id)
    if (w) void speicher.wurf(w)
    setWuerfe(wuerfeRef.current)
  }

  // ---------- Whisper im Hintergrund ----------
  useEffect(() => {
    const wk = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    wk.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m.typ === 'laden') setWhisper({ typ: 'laedt', prozent: m.prozent })
      else if (m.typ === 'bereit') setWhisper({ typ: 'bereit' })
      else if (m.typ === 'ergebnis') {
        setWhisper({ typ: 'bereit' })
        const sl = zuordnen(m.text)
        const alt = wuerfeRef.current.find(w => w.id === m.id)
        if (!alt) return
        aendere(m.id, {
          sprachText: m.text, sprachLabel: sl, status: 'fertig',
          label: alt.vonHand ? alt.label : sl === 'unklar' ? null : sl,
        })
      } else if (m.typ === 'fehler') {
        setWhisper({ typ: 'fehler', text: m.text })
        if (m.id) aendere(m.id, { status: 'fertig', sprachText: '(Fehler bei Erkennung)', sprachLabel: 'unklar' })
      }
    }
    worker.current = wk
    void speicher.sessions().then(setAlte)
    return () => wk.terminate()
  }, [])

  const whisperLaden = () => {
    if (whisper.typ === 'aus' || whisper.typ === 'fehler') {
      setWhisper({ typ: 'laedt', prozent: 0 })
      worker.current?.postMessage({ typ: 'laden' })
    }
  }

  // ---------- Bluetooth ----------
  const beiEreignis = (e: BoardEreignis) => {
    const s = sessionRef.current
    if (!s) return
    const w: Wurf = {
      id: neueId(), sessionId: s.id, nr: e.n, zeit: Date.now(),
      board: e.board, flugMs: e.flug, stoesse: e.stoesse, unruhe: e.unruhe,
      sprachText: null, sprachLabel: null, label: null, vonHand: false, status: 'warte_ton', luecken: 0,
    }
    wuerfeRef.current = [w, ...wuerfeRef.current]
    setWuerfe(wuerfeRef.current)
    void speicher.wurf(w)
  }

  const beiWurfKomplett = (d: WurfDaten) => {
    const w = wuerfeRef.current.find(x => x.nr === d.ereignis.n && x.status === 'warte_ton')
    if (!w) return
    const audio = d.audio ? fuerWhisper(d.audio) : null
    void speicher.sensordaten({ wurfId: w.id, imu: d.imu, audio: audio ? alsWav(audio) : null })
    if (audio) {
      aendere(w.id, { status: 'erkenne', luecken: d.luecken })
      worker.current?.postMessage({ typ: 'erkennen', id: w.id, audio }, [audio.buffer])
    } else {
      aendere(w.id, { status: 'ohne_ton', luecken: d.luecken })
    }
  }

  const verbinden = async () => {
    setFehler('')
    if (!Frisbee.verfuegbar()) {
      setFehler('Dieser Browser kann kein Bluetooth. Bitte Chrome auf Android verwenden.')
      return
    }
    try {
      setVerbindung('verbinde')
      if (!frisbee.current) {
        frisbee.current = new Frisbee({
          zustand: z => { setZustand(z); if (z === 'schlaf') akkuMerken({ typ: 'schlaf' }) },
          ereignis: beiEreignis,
          wurfKomplett: beiWurfKomplett,
          getrennt: () => { setVerbindung('getrennt'); akkuMerken({ typ: 'getrennt' }); wiederVerbinden() },
          akku: mv => { setAkkuMv(mv); if (mv > 2500) akkuMerken({ typ: 'mv', mv }) },
        })
        await frisbee.current.verbinden()
      } else {
        await frisbee.current.neuVerbinden()
      }
      setVerbindung('an'); akkuMerken({ typ: 'verbunden' })
      autoVerbinden.current = true
      whisperLaden()
    } catch (err) {
      setVerbindung(frisbee.current ? 'getrennt' : 'aus')
      if (!String(err).includes('cancelled')) setFehler(String(err))
    }
  }

  // Nach einer Trennung (z. B. Schlaf, zu weit weg) alle 3 s neu versuchen
  const wiederVerbinden = () => {
    if (!autoVerbinden.current) return
    setTimeout(async () => {
      if (!autoVerbinden.current || !frisbee.current) return
      try {
        setVerbindung('verbinde')
        await frisbee.current.neuVerbinden()
        setVerbindung('an'); akkuMerken({ typ: 'verbunden' })
      } catch {
        setVerbindung('getrennt')
        wiederVerbinden()
      }
    }, 3000)
  }

  const ausschalten = async () => {
    if (!confirm('Frisbee schlafen legen? Aufwecken durch Schütteln.')) return
    await frisbee.current?.ausschalten().catch(() => {})
    setZustand('schlaf')
  }

  // ---------- Session ----------
  const sessionStarten = async () => {
    const s: Session = { id: neueId(), start: Date.now(), ende: null }
    await speicher.session(s)
    sessionRef.current = s; setSession(s)
    wuerfeRef.current = []; setWuerfe([])
    await frisbee.current?.sessionStarten().catch(() => {})
    try { wakeLock.current = await navigator.wakeLock?.request('screen') } catch { /* egal */ }
    whisperLaden()
  }

  const sessionBeenden = async () => {
    const s = sessionRef.current
    if (!s) return
    const fertig = { ...s, ende: Date.now() }
    await speicher.session(fertig)
    sessionRef.current = null; setSession(null)
    void wakeLock.current?.release(); wakeLock.current = null
    setAlte(await speicher.sessions())
  }

  const abspielen = async (id: string) => {
    const d = await speicher.holeSensordaten(id)
    if (!d?.audio) return
    const url = URL.createObjectURL(d.audio)
    const a = new Audio(url)
    a.onended = () => URL.revokeObjectURL(url)
    void a.play()
  }

  const korrigieren = (w: Wurf, l: Label) => aendere(w.id, { label: l, vonHand: true })

  // ---------- Anzeige ----------
  const z = ZUSTAND_ANZEIGE[zustand] ?? { text: zustand, icon: '❔' }
  const gezaehlt = LABELS.map(l => ({ l, n: wuerfe.filter(w => w.label === l).length }))
  const mitLabel = wuerfe.filter(w => w.label)
  const boardRichtig = mitLabel.filter(w => w.board === w.label).length

  return (
    <div className="app">
      <header className="kopf">
        <h1>🥏 Frisbee</h1>
        {akkuMv !== null && akkuMv > 2500 && verbindung === 'an' && (
          <span className={`akku ${akkuProzent(akkuMv) <= 20 ? 'leer' : ''}`} title={`${(akkuMv / 1000).toFixed(2)} V`}>
            🔋 {akkuProzent(akkuMv)} %
          </span>
        )}
        <span className={`punkt ${verbindung}`} />
        <span className="verb-text">
          {verbindung === 'an' ? 'verbunden' : verbindung === 'verbinde' ? 'verbinde …' : verbindung === 'getrennt' ? 'getrennt' : 'nicht verbunden'}
        </span>
      </header>

      {verbindung !== 'an' && (
        <button className="gross primaer" onClick={() => { autoVerbinden.current = false; void verbinden() }} disabled={verbindung === 'verbinde'}>
          {verbindung === 'getrennt' ? 'Neu verbinden' : 'Mit Frisbee verbinden'}
        </button>
      )}
      {fehler && <p className="fehler">{fehler}</p>}

      <section className={`zustand z-${zustand} ${verbindung === 'an' ? '' : 'blass'}`}>
        <div className="icon">{z.icon}</div>
        <div className="text">{z.text}</div>
      </section>

      <WhisperZeile s={whisper} />

      {session ? (
        <>
          <div className="zaehler">
            {gezaehlt.map(({ l, n }) => (
              <div key={l} className={`kachel l-${l}`}><b>{n}</b><span>{l}</span></div>
            ))}
          </div>
          {mitLabel.length > 0 && (
            <p className="treffer">Board lag {boardRichtig} von {mitLabel.length} Mal richtig</p>
          )}
          <button className="gross gefahr" onClick={sessionBeenden}>Session beenden</button>
          <ul className="liste">
            {wuerfe.map(w => <WurfZeile key={w.id} w={w} abspielen={abspielen} korrigieren={korrigieren} />)}
            {!wuerfe.length && <li className="leer">Noch keine Würfe – wirf die Frisbee!</li>}
          </ul>
        </>
      ) : (
        <>
          <button className="gross primaer" onClick={sessionStarten}>Session starten</button>
          {verbindung === 'an' && (
            <button className="gross gefahr" onClick={ausschalten}>Frisbee ausschalten</button>
          )}
          <section className="alte">
            <h2>Akku-Protokoll</h2>
            <ul><li>
              <span>
                {akkuLog.n} Messwerte
                {akkuLog.seit && <> seit {new Date(akkuLog.seit).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</>}
              </span>
              <button onClick={() => void akkuExportieren()} disabled={!akkuLog.n}>Export</button>
              <button className="klein" title="Neu beginnen (z. B. nach dem Vollladen)" onClick={async () => {
                if (confirm('Akku-Protokoll löschen und neu beginnen?')) { await speicher.akkuLoeschen(); await akkuLogLaden() }
              }}>🗑</button>
            </li></ul>
          </section>
          {alte.length > 0 && (
            <section className="alte">
              <h2>Frühere Sessions</h2>
              <ul>
                {alte.map(s => (
                  <li key={s.id}>
                    <span>{new Date(s.start).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    <button onClick={() => exportieren(s)}>Export</button>
                    <button className="klein" onClick={async () => {
                      if (confirm('Session wirklich löschen?')) { await speicher.loescheSession(s.id); setAlte(await speicher.sessions()) }
                    }}>🗑</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function WhisperZeile({ s }: { s: WhisperStatus }) {
  if (s.typ === 'aus') return null
  if (s.typ === 'laedt') return <p className="hinweis">Spracherkennung wird geladen … {s.prozent} % (nur beim ersten Mal)</p>
  if (s.typ === 'fehler') return <p className="fehler">Spracherkennung: {s.text}</p>
  return null
}

function WurfZeile({ w, abspielen, korrigieren }: { w: Wurf; abspielen: (id: string) => void; korrigieren: (w: Wurf, l: Label) => void }) {
  const stimmt = w.label ? w.label === w.board : null
  return (
    <li className="wurf">
      <div className="zeile1">
        <span className="nr">#{w.nr}</span>
        <span>Board: <b>{w.board}</b></span>
        <span className="flug">{(w.flugMs / 1000).toFixed(1)} s Flug</span>
        {stimmt !== null && <span className={stimmt ? 'ok' : 'nok'}>{stimmt ? '✓' : '✗'}</span>}
      </div>
      <div className="zeile2">
        {w.status === 'warte_ton' && <span className="hinweis">warte auf Stimme …</span>}
        {w.status === 'erkenne' && <span className="hinweis">erkenne Sprache …</span>}
        {w.status === 'ohne_ton' && <span className="hinweis">kein Ton – bitte antippen:</span>}
        {w.status === 'fertig' && (
          <>
            <button className="play" onClick={() => abspielen(w.id)} aria-label="Abspielen">▶</button>
            <span className="gesagt">„{w.sprachText || '…'}“</span>
          </>
        )}
      </div>
      <div className="wahl">
        {LABELS.map(l => (
          <button key={l} className={`l-${l} ${w.label === l ? 'an' : ''}`} onClick={() => korrigieren(w, l)}>{l}</button>
        ))}
      </div>
    </li>
  )
}
