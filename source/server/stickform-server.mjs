// Stickform launcher: serves the app on this computer only (http://127.0.0.1) and lets it read and write the
// project folder's presets/, models/, renders/ and objects/ directly, in any browser. No packages needed, just Node.js.
//   node source/server/stickform-server.mjs [--no-open] [--port N] [--root DIR]
// "Start Stickform.bat" in the project folder runs this. Close its window to stop Stickform.
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = path.resolve(opt('--root') || process.env.STICKFORM_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const APP = path.join(ROOT, 'stickform.html');
const DIRS = new Set(['presets', 'models', 'renders', 'objects']);
const MAX = 1024 * 1024 * 1024; // 1 GB per file
const TYPES = { '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.vrm': 'model/gltf-binary', '.obj': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8' };
let PORT = Number(opt('--port') ?? 5178);

for (const d of DIRS) await fs.mkdir(path.join(ROOT, d), { recursive: true });

/** presets|models|renders|objects and a plain file name (no folders, no "..") → absolute path, or null. */
function target(dir, name) {
  if (!DIRS.has(dir) || !name || name.length > 200 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) return null;
  const p = path.join(ROOT, dir, name);
  return path.dirname(p) === path.join(ROOT, dir) ? p : null;
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this computer's own pages: other websites can't reach in (Host check stops DNS rebinding; the custom
    // header on every API call stops cross-site form posts, since browsers won't send it cross-origin without CORS).
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'Forbidden host' });
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/' || url.pathname === '/stickform.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return createReadStream(APP).on('error', () => res.end('stickform.html not found next to Start Stickform.')).pipe(res);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    // Changes need the custom header (a plain cross-site form can't send it). Reads are fine without it: <img> tags
    // show renders, and other sites still can't read the data (no CORS headers are sent).
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (!reading && req.headers['x-stickform'] !== '1') return send(res, 403, { error: 'Missing X-Stickform header' });
    if (url.pathname === '/api/info') return send(res, 200, { name: path.basename(ROOT), root: ROOT });
    const m = url.pathname.match(/^\/api\/(list|file|rename)\/([a-z]+)(?:\/(.+))?$/);
    if (!m) return send(res, 404, { error: 'Not found' });
    const [, kind, dir, rawName] = m;
    if (kind === 'list') {
      if (!DIRS.has(dir)) return send(res, 400, { error: 'Bad folder' });
      const out = [];
      for (const e of await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.') || e.name.includes('.part-')) continue;
        const st = await fs.stat(path.join(ROOT, dir, e.name)).catch(() => null);
        if (st) out.push({ name: e.name, size: st.size, lastModified: st.mtimeMs });
      }
      return send(res, 200, out);
    }
    let name; try { name = decodeURIComponent(rawName || ''); } catch { name = ''; }
    const p = target(dir, name);
    if (!p) return send(res, 400, { error: 'Bad file name' });
    if (kind === 'rename') {
      // POST /api/rename/<folder>/<name>  body {"to": "<new name>"}: same folder, never overwrites.
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      let body = ''; for await (const c of req) { body += c; if (body.length > 4096) return send(res, 413, { error: 'Too large' }); }
      let to; try { to = JSON.parse(body).to; } catch { to = null; }
      const q = typeof to === 'string' ? target(dir, to) : null;
      if (!q) return send(res, 400, { error: 'Bad new file name' });
      if (!(await fs.stat(p).catch(() => null))?.isFile()) return send(res, 404, { error: 'No such file' });
      if (q.toLowerCase() !== p.toLowerCase() && await fs.stat(q).catch(() => null)) return send(res, 409, { error: `${dir}/${to} already exists` });
      await fs.rename(p, q);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isFile()) return send(res, 404, { error: 'No such file' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Last-Modified': new Date(st.mtimeMs).toUTCString() });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(p).pipe(res);
    }
    if (req.method === 'PUT') {
      const tmp = p + '.part-' + process.pid;
      let size = 0; const h = await fs.open(tmp, 'w');
      try {
        for await (const chunk of req) { size += chunk.length; if (size > MAX) throw new Error('File too large'); await h.write(chunk); }
      } catch (e) { await h.close(); await fs.rm(tmp, { force: true }); return send(res, 413, { error: e.message }); }
      await h.close(); await fs.rename(tmp, p);
      return send(res, 200, { ok: true, size });
    }
    if (req.method === 'DELETE') { await fs.rm(p, { force: true }); return send(res, 200, { ok: true }); }
    return send(res, 405, { error: 'Method not allowed' });
  } catch (e) { send(res, 500, { error: String(e?.message || e) }); }
});

function listen(tries = 20) {
  server.once('error', e => { if (e.code === 'EADDRINUSE' && tries > 0 && !opt('--port')) { PORT++; listen(tries - 1); } else { console.error(e.message); process.exit(1); } });
  server.listen(PORT, '127.0.0.1', () => {
    PORT = server.address().port;
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`Stickform is running at ${url}`);
    console.log(`Project folder: ${ROOT}`);
    console.log('Keep this window open while you use Stickform. Close it (or press Ctrl+C) to stop.');
    if (process.send) process.send({ port: PORT });
    if (!args.includes('--no-open')) {
      const [cmd, a] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, a, { stdio: 'ignore', detached: true }).unref();
    }
  });
}
listen();
