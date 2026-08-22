// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Local host server for the Caden web UI.
//
// Serves the renderer from web/ and proxies every daemon request so the
// renderer never holds a token and never fights CORS:
//
//   ANY  /host/...                 the control plane in host.js (config, the
//                                  server list, provisioning, forwards)
//   ANY  /proxy/<serverId>/v1/...  forwarded to that server's daemon with
//                                  Authorization injected; responses stream,
//                                  so SSE passes through unbuffered.
//
// Electron's main process runs this on a random loopback port and loads the
// window from it; `node server.js 8790` serves the same thing to a normal
// browser for development. Binds 127.0.0.1 only.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const host = require('./host');
const { readConfig, daemonBase, daemonToken, providerKey } = host;
const { keyRoute, injectProviderKey } = require('./secret-inject');

const WEB_ROOT = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function proxy(req, res, serverId, rest) {
  const cfg = readConfig();
  const server = (cfg.servers || []).find(s => s.id === serverId);
  if (!server) { json(res, 404, { error: 'unknown server' }); return; }
  const token = daemonToken(server);
  if (!token) { json(res, 502, { error: 'no daemon token for this server' }); return; }

  const base = new URL(daemonBase(server));
  // Session create and the provider switch carry a credential; the renderer
  // sends only a `key_ref`, which is swapped for the real key here. Every
  // other route -- SSE streams, uploads, logs -- passes through unbuffered.
  const inject = keyRoute(req.method, rest.split('?')[0])
    && /json/i.test(req.headers['content-type'] || 'application/json');

  const sendUpstream = body => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept': req.headers['accept'] || '*/*',
      // Forward the length: without it Node switches to chunked encoding,
      // which heartbeat's stdlib HTTP server reads as an empty body.
    };
    if (body != null) headers['Content-Length'] = Buffer.byteLength(body);
    else if (req.headers['content-length']) headers['Content-Length'] = req.headers['content-length'];
    const options = {
      hostname: base.hostname,
      port: base.port || 80,
      path: rest,
      method: req.method,
      headers,
    };
    const upstream = http.request(options, up => {
      res.writeHead(up.statusCode || 502, {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      // pipe() keeps SSE flowing chunk by chunk.
      up.pipe(res);
    });
    upstream.on('error', err => {
      if (!res.headersSent) json(res, 502, { error: String(err.message || err) });
      else res.end();
    });
    if (body != null) upstream.end(body);
    else req.pipe(upstream);
    // If the browser drops the request (component unmount), drop upstream too,
    // or dangling SSE connections pile up on the daemon.
    res.on('close', () => upstream.destroy());
  };

  if (inject) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(raw || '{}'); } catch {}
      if (parsed) {
        injectProviderKey(parsed, providerKey);
        raw = JSON.stringify(parsed);
      }
      sendUpstream(raw);
    });
    req.on('error', () => sendUpstream(null));
  } else {
    sendUpstream(null);
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // The control plane owns most of /host/*; the two below stayed here because
  // they are outbound HTTP and a dev-only helper rather than app state.
  if (p.startsWith('/host/') && await host.route(req, res, url)) return;

  // Fetch a provider's model list (GET <base>/v1/models) server-side, so the
  // renderer stays free of CORS and never talks to the gateway itself.
  if (p === '/host/provider-models' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let base, key, extra;
      try {
        const b = JSON.parse(body);
        if (b.provider_id && !b.api_key) {
          // A saved provider: the renderer holds no key, so resolve the whole
          // credential set from config + keychain.
          const cfg = readConfig();
          const prov = (cfg.providers || []).find(x => x.id === b.provider_id);
          if (!prov) throw new Error('unknown provider');
          if (!prov.baseURL) throw new Error('this provider has no base URL to fetch models from');
          base = new URL('/v1/models', prov.baseURL);
          key = providerKey(prov.id) || '';
          extra = prov.headers || {};
        } else {
          // An unsaved edit being tested: use exactly what was typed.
          base = new URL('/v1/models', b.base_url);
          key = b.api_key || '';
          extra = b.headers || {};
        }
      } catch (e) { json(res, 400, { error: String(e.message || e) }); return; }
      const mod = base.protocol === 'https:' ? https : http;
      const up = mod.request(base, {
        method: 'GET',
        timeout: 10000,
        headers: {
          'Authorization': `Bearer ${key}`,
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          ...extra,
        },
      }, r => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const rows = parsed.data || parsed.models || [];
            const ids = rows.map(m => m.id || m.name || m.model).filter(Boolean);
            if (!ids.length && r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode}: ${data.slice(0, 200)}`);
            json(res, 200, { models: [...new Set(ids)].sort() });
          } catch (e) { json(res, 502, { error: String(e.message || e) }); }
        });
      });
      up.on('timeout', () => up.destroy(new Error('timed out')));
      up.on('error', e => json(res, 502, { error: String(e.message || e) }));
      up.end();
    });
    return;
  }

  // Accepts style probes from the renderer and writes them into
  // app/verify/baseline/ for the parity tools to diff (see app/verify/).
  // That directory is local and gitignored -- a probe is a picture of
  // whatever was on screen -- so it is created on first write.
  // It is a write primitive, so it stays off unless CADEN_VERIFY is set --
  // a shipped build has no reason to expose one.
  if (p === '/host/stage' && req.method === 'POST') {
    if (!process.env.CADEN_VERIFY) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, data } = JSON.parse(body);
        if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error('bad name');
        const dir = path.join(__dirname, 'verify', 'baseline');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), data);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: String(e.message || e) }); }
    });
    return;
  }

  const m = p.match(/^\/proxy\/([^/]+)(\/.*)$/);
  if (m) { proxy(req, res, m[1], m[2] + url.search); return; }

  if (req.method === 'GET') { serveStatic(req, res, p); return; }
  res.writeHead(405);
  res.end();
}

function start(port = 0) {
  // Before the first request, so the renderer's opening read of the config
  // already lists this machine. Installing the daemon into it runs on its own
  // afterwards; the server list retries an unreachable server anyway, which is
  // what brings it online when that finishes.
  const ready = host.ensureLocalServer();
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv.address().port));
  }).then(p => { ready.catch(() => {}); return p; });
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2] || 8790);
  start(port).then(p => console.log(`caden web ui on http://127.0.0.1:${p}`));
}
