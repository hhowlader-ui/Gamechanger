import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      // This is our injected custom backend!
      {
        name: 'ch-pdf-proxy',
        configureServer(server) {
          server.middlewares.use('/api/pdf', (req, res) => {
            const targetUrl = req.headers['x-target-url'] as string;
            const apiKey = req.headers['x-api-key'] as string;

            if (!targetUrl || !apiKey) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ error: "Missing headers" }));
            }

            const auth = Buffer.from(apiKey.trim() + ':').toString('base64');
            let docUrlLocal = '';

            // 1. Fetch metadata
            fetch(targetUrl, { headers: { Authorization: `Basic ${auth}` } })
              .then(r => r.json())
              .then(meta => {
                docUrlLocal = meta.links?.document;
                if (!docUrlLocal) throw new Error("No document link found in Companies House.");
                // 2. Fetch doc and intercept AWS redirect
                return fetch(docUrlLocal, { headers: { Authorization: `Basic ${auth}` }, redirect: 'manual' });
              })
              .then(docRes => {
                let s3Url = docUrlLocal;
                if (docRes.status >= 300 && docRes.status < 400) {
                  s3Url = docRes.headers.get('location') || docUrlLocal;
                }
                // 3. Download from AWS S3 securely
                return fetch(s3Url); 
              })
              .then(s3Res => s3Res.arrayBuffer())
              .then(buffer => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, base64: Buffer.from(buffer).toString('base64') }));
              })
              .catch(err => {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: err.message }));
              });
          });
        }
      }
    ],
    server: {
      port: 5173,
      proxy: {
        // Standard proxy for standard Companies House JSON data
        '/api/ch': {
          target: 'https://api.company-information.service.gov.uk',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/ch/, '')
        }
      },
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});