import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 3001,
    // HTTPS is required for WebAuthn on localhost
    // For local dev, use 'localhost' which is allowed without HTTPS
  },
});
