// Ordnet Whispers Text einem unserer Woerter zu.
// Regel aus dem Test: catch und touch erkennt Whisper fast immer richtig,
// bei "hol" kommt irgendetwas anderes. Also: passt nichts -> hol, leer -> unklar.
export type Label = 'catch' | 'hol' | 'touch'
export type SprachLabel = Label | 'unklar'
export const LABELS: Label[] = ['catch', 'hol', 'touch']

function aehnlichkeit(a: string, b: string): number {
  // Anteil gemeinsamer Zeichen in gleicher Reihenfolge (wie Pythons difflib, vereinfacht)
  const m = a.length, n = b.length
  if (!m || !n) return 0
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1])
  return (2 * d[m][n]) / (m + n)
}

export function zuordnen(text: string): SprachLabel {
  const woerter = text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean)
  if (!woerter.length) return 'unklar'
  let best: SprachLabel = 'hol', score = 0
  for (const ziel of LABELS) {
    for (const w of woerter) {
      const s = aehnlichkeit(w, ziel)
      if (s > score) { score = s; best = ziel }
    }
  }
  if (best === 'hol') return 'hol'
  return score >= 0.6 ? best : 'hol'
}
