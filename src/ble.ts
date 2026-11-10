// Verbindung zur Frisbee per Web-Bluetooth (Chrome auf Android).
// Fuers iPhone kommt spaeter eine andere Datei mit denselben Funktionen (Capacitor).
const uuid = (n: number) => `a0b4000${n}-6c1e-4f2a-9d3b-5f1e2c7a9b10`
const SERVICE = uuid(1), ZUSTAND = uuid(2), BEFEHL = uuid(3), DATEN = uuid(4), EREIGNIS = uuid(5)

export type BoardZustand = 'ruhe' | 'launch' | 'fly' | 'landung' | 'hoere' | 'sende'

export interface BoardEreignis {
  n: number; board: 'catch' | 'hol' | 'touch'; flug: number; stoesse: number; unruhe: number
}

export interface WurfDaten {
  ereignis: BoardEreignis
  imu: Int16Array | null      // 400 x [ax ay az (mg), gx gy gz (°/s)], 100 Hz
  audio: Int16Array | null    // 3 s, 16 kHz
  luecken: number             // verlorene Pakete
}

export interface Rueckrufe {
  zustand: (z: BoardZustand) => void
  ereignis: (e: BoardEreignis) => void          // sofort nach der Landung
  wurfKomplett: (w: WurfDaten) => void          // wenn Messdaten + Ton da sind
  getrennt: () => void
}

const text = (v: DataView) => new TextDecoder().decode(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))

export class Frisbee {
  private geraet: BluetoothDevice | null = null
  private befehl: BluetoothRemoteGATTCharacteristic | null = null
  private aktuell: { ereignis: BoardEreignis; teile: Record<string, Uint8Array[]>; luecken: number; letzte: Record<string, number> } | null = null
  name = ''
  private r: Rueckrufe

  constructor(r: Rueckrufe) { this.r = r }

  static verfuegbar() { return typeof navigator !== 'undefined' && 'bluetooth' in navigator }

  async verbinden() {
    this.geraet = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] })
    this.name = this.geraet.name ?? 'Frisbee'
    this.geraet.addEventListener('gattserverdisconnected', () => this.r.getrennt())
    await this.koppeln()
  }

  async neuVerbinden() { if (this.geraet) await this.koppeln() }

  private async koppeln() {
    const server = await this.geraet!.gatt!.connect()
    const svc = await server.getPrimaryService(SERVICE)
    const [z, b, d, e] = await Promise.all([ZUSTAND, BEFEHL, DATEN, EREIGNIS].map(u => svc.getCharacteristic(u)))
    this.befehl = b

    z.addEventListener('characteristicvaluechanged', () => this.r.zustand(text(z.value!) as BoardZustand))
    e.addEventListener('characteristicvaluechanged', () => this.beiEreignis(text(e.value!)))
    d.addEventListener('characteristicvaluechanged', () => this.beiDaten(d.value!))
    await z.startNotifications(); await e.startNotifications(); await d.startNotifications()
    this.r.zustand(text(await z.readValue()) as BoardZustand)
  }

  trennen() { this.geraet?.gatt?.disconnect() }

  async sessionStarten() {
    await this.befehl?.writeValue(new TextEncoder().encode('start'))
  }

  private beiEreignis(json: string) {
    try {
      const e = JSON.parse(json) as BoardEreignis
      this.aktuell = { ereignis: e, teile: { I: [], A: [] }, luecken: 0, letzte: { I: -1, A: -1 } }
      this.r.ereignis(e)
    } catch { /* kaputtes Paket ignorieren */ }
  }

  private beiDaten(v: DataView) {
    const typ = String.fromCharCode(v.getUint8(0))
    const nr = v.getUint16(1, true)
    const inhalt = new Uint8Array(v.buffer.slice(v.byteOffset + 3, v.byteOffset + v.byteLength))
    const w = this.aktuell
    if (!w) return
    if (typ === 'Z') {
      this.aktuell = null
      const zusammen = (t: string) => {
        const teile = w.teile[t]
        if (!teile.length) return null
        const len = teile.reduce((s, p) => s + p.length, 0)
        const out = new Uint8Array(len - (len % 2))
        let o = 0
        for (const p of teile) { out.set(p.subarray(0, Math.min(p.length, out.length - o)), o); o += p.length }
        return new Int16Array(out.buffer)
      }
      this.r.wurfKomplett({ ereignis: w.ereignis, imu: zusammen('I'), audio: zusammen('A'), luecken: w.luecken })
      return
    }
    if (typ !== 'I' && typ !== 'A') return
    if (nr !== w.letzte[typ] + 1) w.luecken += Math.max(1, nr - w.letzte[typ] - 1)
    w.letzte[typ] = nr
    w.teile[typ].push(inhalt)
  }
}
