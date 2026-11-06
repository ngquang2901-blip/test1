// THROWAWAY spike relay: POST /cmd {op,args} (needs X-Token) -> extension over WS -> JSON reply.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

const TOKEN = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(new URL('./.token', import.meta.url), TOKEN);
let ext = null, seq = 0;
const pending = new Map();

const server = http.createServer(async (req, res) => {
  // custom header forces a CORS preflight we never answer -> web pages cannot drive this
  if (req.headers['x-token'] !== TOKEN) { res.writeHead(403).end(); return; }
  if (req.url === '/status') { res.end(JSON.stringify({ connected: !!ext })); return; }
  let body = ''; for await (const c of req) body += c;
  if (!ext) { res.writeHead(503).end('{"error":"extension not connected"}'); return; }
  const id = ++seq, { op, args } = JSON.parse(body || '{}');
  const timer = setTimeout(() => { pending.delete(id); res.writeHead(504).end('{"error":"timeout"}'); }, 60000);
  pending.set(id, (msg) => { clearTimeout(timer); res.end(JSON.stringify(msg)); });
  ext.send(JSON.stringify({ id, op, args }));
});

const wss = new WebSocketServer({ server, path: '/ext' });
wss.on('connection', (sock, req) => {
  if (!String(req.headers.origin || '').startsWith('chrome-extension://')) { sock.close(); return; }
  ext = sock; console.log('extension connected', req.headers.origin);
  sock.on('message', (m) => { const msg = JSON.parse(m); if (msg.id) pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  sock.on('error', (e) => console.log('ws error', e.code)); // unhandled ECONNRESET on extension reload killed the relay
  sock.on('close', () => { if (ext === sock) ext = null; console.log('extension disconnected'); });
});
server.listen(17777, '127.0.0.1', () => console.log('spike relay on 127.0.0.1:17777'));
