// Minimal static server for local development: node scripts/serve.js [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.argv[2] ?? process.env.PORT ?? 5173);
http
  .createServer(async (req, res) => {
    if (req.url !== '/' && req.url !== '/index.html') {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(await readFile(new URL('../index.html', import.meta.url)));
  })
  .listen(port, '127.0.0.1', () => {
    process.stdout.write(`http://127.0.0.1:${port}\n`);
  });
