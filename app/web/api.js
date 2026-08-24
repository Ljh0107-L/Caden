// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Client for the host proxy: /host/config for app config, /proxy/<serverId>/v1/*
// for the daemon. Tokens never reach this layer — the host injects them.

export async function hostConfig() {
  const res = await fetch('/host/config');
  if (!res.ok) throw new Error(`host config: HTTP ${res.status}`);
  return res.json();
}

const hostCall = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

export const sshHosts    = ()   => hostCall('GET', '/host/ssh-hosts').then(r => r.hosts);
export const pickFiles   = ()   => hostCall('POST', '/host/files/pick').then(r => r.files);
export const attachFile  = (id, path) =>
  hostCall('POST', `/host/servers/${id}/attach`, { path });
/// For bytes that never had a path -- a file pasted out of Finder.
export const attachBytes = async (id, name, body) => {
  const res = await fetch(
    `/host/servers/${id}/attach-bytes?name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body });
  const data = JSON.parse((await res.text()) || '{}');
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};
export const addServer   = host => hostCall('POST', '/host/servers', { host });
export const removeServer= id   => hostCall('DELETE', `/host/servers/${id}`);
export const serverStatus= id   => hostCall('GET', `/host/servers/${id}/status`);

/// Install an engine with the Mac as the transport, streaming its progress.
/// Used when the server itself cannot reach the registry or GitHub.
export function installViaHost(id, engine, onStep) {
  return new Promise((resolve, reject) => {
    fetch(`/host/servers/${id}/install-via-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine }),
    }).then(async res => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.type === 'step') onStep?.(ev.text);
          if (ev.type === 'done') return ev.ok ? resolve(ev) : reject(new Error(ev.error));
        }
      }
      reject(new Error('the install stream ended without a result'));
    }).catch(reject);
  });
}
export async function provision(id, opts = {}, onStep) {
  const res = await fetch(`/host/servers/${id}/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try { message = JSON.parse(text).error || message; } catch {}
    throw new Error(message || `HTTP ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('provision stream is unavailable');
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  for (;;) {
    const { value, done: ended } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !ended });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'step') onStep?.(event.text);
      if (event.type === 'done') done = event;
    }
    if (ended) break;
  }
  if (!done) throw new Error('provision stream ended without a result');
  if (!done.ok) throw new Error(done.error || 'daemon provisioning failed');
  return done;
}
export const startTunnel = id   => hostCall('POST', `/host/servers/${id}/tunnel`);
export const stopTunnel  = id   => hostCall('DELETE', `/host/servers/${id}/tunnel`);

// Attachment rules, mirrored from app/host.js. Two copies, because the two
// entry points are on opposite sides of the wire and the rule has to be the
// same on both -- a photo picked on a phone and one dropped on the desktop
// must become the same thing.
const MODEL_IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg',
                      '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                      '.webp': 'image/webp' };
const IMAGE_MAX = 4 << 20;
const ATTACH_MAX = 50 << 20;
const CHUNK = 4 << 20;

const humanSize = n => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
                                    : `${Math.ceil(n / 1024)} KB`;

/// btoa needs a binary string, and String.fromCharCode(...bytes) overflows the
/// argument list on anything bigger than a small image.
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export class DaemonAPI {
  constructor(serverId) {
    this.base = `/proxy/${serverId}`;
  }

  async request(method, path, { query, body } = {}) {
    let url = this.base + path;
    if (query) url += '?' + new URLSearchParams(query);
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 500);
      try { msg = JSON.parse(text).error || msg; } catch {}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return text ? JSON.parse(text) : {};
  }

  health() { return this.request('GET', '/v1/health'); }
  engines() { return this.request('GET', '/v1/engines'); }
  installEngine(engine, method = 'auto') {
    return this.request('POST', '/v1/engines/install', { body: { engine, method } })
               .then(r => r.job);
  }
  sessions() { return this.request('GET', '/v1/sessions').then(r => r.sessions); }
  createSession(spec) {
    return this.request('POST', '/v1/sessions', { body: spec }).then(r => r.session);
  }
  session(id, after = 0) {
    return this.request('GET', `/v1/sessions/${id}`,
                        { query: { after: String(after), events: '1' } });
  }
  patchSession(id, patch) {
    return this.request('PATCH', `/v1/sessions/${id}`, { body: patch })
      .then(r => r.session);
  }
  deleteSession(id) { return this.request('DELETE', `/v1/sessions/${id}`); }
  sendMessage(id, text, images) {
    const body = { text };
    if (images && images.length) body.images = images;
    return this.request('POST', `/v1/sessions/${id}/messages`, { body });
  }
  /// `keepQueue` interrupts the running turn but leaves anything queued
  /// behind it in place, so the next message starts immediately.
  interrupt(id, { keepQueue = false } = {}) {
    return this.request('POST', `/v1/sessions/${id}/interrupt`,
                        keepQueue ? { query: { keep_queue: '1' } } : undefined);
  }
  stopSession(id) { return this.request('POST', `/v1/sessions/${id}/stop`); }
  /// Attach a File the browser handed us, with only the daemon to talk to.
  ///
  /// The Mac route for this is /host/servers/<id>/attach, which reads the
  /// path off disk -- a browser has no path, and behind a reverse proxy there
  /// is no /host/* at all. Everything it does is reachable from here though:
  /// /v1/uploads is a begin, some chunks and a complete.
  ///
  /// The rule about what "attach" means is copied from host.js rather than
  /// re-decided: an image the model can read rides in the turn as bytes,
  /// anything else is pushed to the server and comes back as a path. Picking
  /// a photo on a phone and dropping one on the desktop have to land in the
  /// same place.
  async attachLocalFile(file) {
    if (file.size > ATTACH_MAX) {
      throw new Error(`${file.name} is ${humanSize(file.size)}; attachments are `
                      + `capped at ${humanSize(ATTACH_MAX)}`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = MODEL_IMAGE[(file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase()];
    if (mime && file.size <= IMAGE_MAX) {
      return { kind: 'image', name: file.name, media_type: mime,
               data: base64(bytes) };
    }

    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const begun = await this.request('POST', '/v1/uploads',
      { body: { name: file.name, size: file.size, sha256: digest } });
    const id = begun.upload.id;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const chunk = bytes.subarray(offset, offset + CHUNK);
      const res = await fetch(`${this.base}/v1/uploads/${id}?offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
      if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    }
    const done = await this.request('POST', `/v1/uploads/${id}/complete`);
    return { kind: 'file', path: done.upload.path, name: file.name, size: file.size };
  }

  fsList(path, hidden = false) {
    return this.request('GET', '/v1/fs',
                        { query: { path, hidden: hidden ? '1' : '0' } });
  }

  /// The cold-open stream: the tail window as SSE, oldest first, so the
  /// transcript folds progressively and paints in one round trip instead of
  /// waiting on the whole window. Ends with eof -- the live loop is what
  /// carries the stream afterwards. A `__tail_meta__` event arrives first,
  /// saying whether older history exists.
  streamTail(id, n, onEvent) {
    return this.streamPath(`/v1/sessions/${id}/events?tail=${n}&follow=0`, onEvent);
  }

  /// SSE via streaming fetch (EventSource cannot set method/headers and the
  /// daemon emits one JSON object per data: line — same contract as the Swift
  /// client). Calls onEvent per event; resolves on clean stream end; throws on
  /// transport error. Abort via the returned controller.
  stream(sessionId, after, onEvent) {
    return this.streamPath(`/v1/sessions/${sessionId}/events?after=${after}&follow=1`,
                           onEvent);
  }

  jobStream(jobId, onEvent) {
    return this.streamPath(`/v1/jobs/${jobId}/events?after=0&follow=1`, onEvent);
  }

  /// One JSON object per `data:` line; a line that does not parse is treated as
  /// a fragment and joined with the next.
  streamPath(path, onEvent) {
    const controller = new AbortController();
    const url = this.base + path;
    const done = (async () => {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`event stream refused: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let pending = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.startsWith(':')) continue;               // keepalive
          if (line.startsWith('event:')) {
            if (line.slice(6).trim() === 'eof') return;
            continue;
          }
          if (line.startsWith('id:')) continue;
          if (!line.startsWith('data:')) continue;
          const chunk = line.slice(5).trim();
          const attempt = pending ? pending + chunk : chunk;
          try {
            onEvent(JSON.parse(attempt));
            pending = '';
          } catch {
            pending = attempt;
            if (pending.length > 1 << 20) pending = '';
          }
        }
      }
    })();
    return { controller, done };
  }
}
