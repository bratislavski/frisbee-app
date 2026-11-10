// Hilfen fuer die 16-kHz-Clips vom Board
export const RATE = 16000

export function fuerWhisper(pcm: Int16Array): Float32Array {
  // Gleichanteil weg und auf volle Lautstaerke bringen (Board-Mikro ist leise)
  let mittel = 0
  for (const v of pcm) mittel += v
  mittel /= pcm.length || 1
  let spitze = 1
  for (const v of pcm) spitze = Math.max(spitze, Math.abs(v - mittel))
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = ((pcm[i] - mittel) / spitze) * 0.9
  return out
}

export function alsWav(audio: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + audio.length * 2)
  const v = new DataView(buf)
  const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  text(0, 'RIFF'); v.setUint32(4, 36 + audio.length * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  text(36, 'data'); v.setUint32(40, audio.length * 2, true)
  audio.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true))
  return new Blob([buf], { type: 'audio/wav' })
}
