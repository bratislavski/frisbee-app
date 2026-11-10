// Laeuft im Hintergrund, damit die App beim Erkennen nicht haengt.
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null

function laden() {
  asr ??= pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    progress_callback: (p: { status: string; progress?: number }) => {
      if (p.status === 'progress') postMessage({ typ: 'laden', prozent: Math.round(p.progress ?? 0) })
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>
  return asr
}

self.onmessage = async (e: MessageEvent<{ typ: 'laden' } | { typ: 'erkennen'; id: string; audio: Float32Array }>) => {
  try {
    const m = await laden()
    if (e.data.typ === 'laden') { postMessage({ typ: 'bereit' }); return }
    const out = await m(e.data.audio, { language: 'english', task: 'transcribe' })
    const text = Array.isArray(out) ? out.map(o => o.text).join(' ') : out.text
    postMessage({ typ: 'ergebnis', id: e.data.id, text: text.trim() })
  } catch (err) {
    postMessage({ typ: 'fehler', id: 'id' in e.data ? e.data.id : null, text: String(err) })
  }
}
