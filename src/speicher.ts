// Speichert Sessions und Wuerfe im Handy (IndexedDB).
// Aufbau passt spaeter zu Supabase-Tabellen: sessions / wuerfe / sensordaten getrennt.
import { openDB } from 'idb'
import type { BoardEreignis } from './ble'
import type { Label, SprachLabel } from './erkennung'

export interface Session { id: string; start: number; ende: number | null }

export interface Wurf {
  id: string; sessionId: string; nr: number; zeit: number
  board: BoardEreignis['board']; flugMs: number; stoesse: number; unruhe: number
  sprachText: string | null           // was Whisper verstanden hat
  sprachLabel: SprachLabel | null     // daraus abgeleitet
  label: Label | null                 // endgueltig (gesprochen oder von Hand korrigiert)
  vonHand: boolean
  status: 'warte_ton' | 'erkenne' | 'fertig' | 'ohne_ton'
  luecken: number
}

// Akku-Protokoll: jeder Messwert (alle 10 s, solange verbunden) und Verbindungs-Ereignisse
export interface AkkuEintrag { zeit: number; typ: 'mv' | 'verbunden' | 'getrennt' | 'schlaf'; mv?: number }

export interface Sensordaten { wurfId: string; imu: Int16Array | null; audio: Blob | null }

const db = openDB('frisbee', 2, {
  upgrade(d, alt) {
    if (alt < 1) {
      d.createObjectStore('sessions', { keyPath: 'id' })
      d.createObjectStore('wuerfe', { keyPath: 'id' }).createIndex('session', 'sessionId')
      d.createObjectStore('sensordaten', { keyPath: 'wurfId' })
    }
    if (alt < 2) d.createObjectStore('akku', { autoIncrement: true })
  },
})

export const speicher = {
  async sessions(): Promise<Session[]> { return (await (await db).getAll('sessions')).sort((a, b) => b.start - a.start) },
  async session(s: Session) { await (await db).put('sessions', s) },
  async wuerfe(sessionId: string): Promise<Wurf[]> {
    return (await (await db).getAllFromIndex('wuerfe', 'session', sessionId)).sort((a, b) => b.nr - a.nr)
  },
  async wurf(w: Wurf) { await (await db).put('wuerfe', w) },
  async sensordaten(s: Sensordaten) { await (await db).put('sensordaten', s) },
  async holeSensordaten(id: string): Promise<Sensordaten | undefined> { return (await db).get('sensordaten', id) },
  async akku(e: AkkuEintrag) { await (await db).add('akku', e) },
  async akkuLog(): Promise<AkkuEintrag[]> { return (await db).getAll('akku') },
  async akkuLoeschen() { await (await db).clear('akku') },
  async loescheSession(id: string) {
    const d = await db
    for (const w of await this.wuerfe(id)) { await d.delete('wuerfe', w.id); await d.delete('sensordaten', w.id) }
    await d.delete('sessions', id)
  },
}

async function base64(b: Blob) {
  const bytes = new Uint8Array(await b.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function herunterladen(daten: unknown, name: string) {
  const blob = new Blob([JSON.stringify(daten)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

const zeitName = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace(/[:T]/g, '-')

export async function akkuExportieren() {
  const log = await speicher.akkuLog()
  herunterladen({ akku: log }, `frisbee-akku-${zeitName(log[0]?.zeit ?? Date.now())}.json`)
}

// Eine Session als JSON-Datei herunterladen (fuer Auswertung am PC)
export async function exportieren(s: Session) {
  const wuerfe = await speicher.wuerfe(s.id)
  const mitDaten = await Promise.all(wuerfe.map(async w => {
    const d = await speicher.holeSensordaten(w.id)
    return { ...w, imu: d?.imu ? Array.from(d.imu) : null, audioWavBase64: d?.audio ? await base64(d.audio) : null }
  }))
  herunterladen({ session: s, wuerfe: mitDaten }, `frisbee-session-${zeitName(s.start)}.json`)
}
