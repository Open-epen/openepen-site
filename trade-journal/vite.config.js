import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // dev: serve from root so localhost:5173/ works directly
  // build: asset paths rooted at /trade-journal/dist/ so Netlify can serve them
  base: process.env.NODE_ENV === 'development' ? '/' : '/trade-journal/dist/',
  build: {
    outDir: 'dist',
  },
})
