import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base = Repository-Name, weil GitHub Pages die App unter /frisbee-app/ ausliefert
export default defineConfig({
  base: '/frisbee-app/',
  plugins: [react()],
  worker: { format: 'es' },
})
