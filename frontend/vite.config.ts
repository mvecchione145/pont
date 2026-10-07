import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` outside Docker: proxy API calls to a locally running server.
    proxy: { '/api': 'http://localhost:4000' },
  },
});
