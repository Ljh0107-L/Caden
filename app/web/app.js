// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Caden web renderer. Same architecture as the Swift app: all state lives on
// the daemon; this is a console over REST + SSE. Layout and interaction rules
// come from docs/DESIGN.md — servers as sidebar groups, nothing modal, one
// floating composer.

import { hostConfig, DaemonAPI, sshHosts, addServer, removeServer, installViaHost,
         serverStatus, provision, startTunnel, stopTunnel,
         pickFiles, attachFile, attachBytes,
         webStatus, saveWebSettings, applyWeb, setWebPassword,
         logoutBrowsers, connectServerToWeb } from './api.js';
import { Transcript, groupRows, toolVerb, toolBucket, visibleFrom } from './transcript.js';
import { renderMarkdown } from './markdown.js';
import { renderDiff, diffFromToolInput } from './diff.js';
import { el, icon, compactTokens, contextUsed, windowUsage, pctText, usd,
         shortPath, basename, fmtDuration,
         openMenu } from './util.js';
import { loadTemplates, tpl, cls, setIcon, cIcon, fillMenuButton } from './templates.js';
import { cacheLoad, cacheSave, cacheClear } from './cache.js';

/// How much history a cold open folds. The daemon walks this back to a turn
/// start, so the window always begins at a `user` event; what it does not
/// cover is one "Load earlier" click away. Kept inside the daemon's in-memory
/// ring (2048) so the fetch costs no file I/O server-side either.
const TAIL_EVENTS = 300;

// Whether the sidebar is a column beside the canvas or an overlay on top of
// it. Same 760px as the media query in styles.css -- the two have to agree,
// and matchMedia is the only way to ask the stylesheet's question in JS.
const NARROW = window.matchMedia('(max-width: 760px)');

/// Crossing the breakpoint changes what the sidebar *is*, so it also changes
/// what "open" should mean: a window dragged wide should show the list back,
/// and one dragged narrow should not have it covering the canvas.
NARROW.addEventListener('change', ev => {
  state.sidebarOpen = !ev.matches;
  renderSidebar();
  renderMain();
});

const state = {
  config: { servers: [], models: [], defaults: {} },
  servers: new Map(),          // id -> {profile, api, status, facts, sessions, error}
  controllers: new Map(),      // sessionId -> controller
  selectedServerId: null,
  selectedSessionId: null,
  pane: null,                  // 'models' | {sessionDetail: id}
  sidebarOpen: !NARROW.matches,   // a phone opens on the content, not the list
  // Archived starts folded: it is where sessions go to stop taking up room.
  foldedRepos: new Set(['Archived']),
  // The whole repository list folds too, from its group heading.
  repoListFolded: false,
  serverStatus: new Map(),     // id -> readiness report from /host/servers/<id>/status
  serverBusy: new Map(),       // id -> what a running action is doing
  sshHosts: [],                // candidates parsed out of ~/.ssh/config
  draft: { cwd: '', modelId: null, permissionMode: '', permissionModeChosen: false },
  editing: false,          // an inline editor owns the keyboard right now
  sidebarStale: false,     // a repaint was skipped while it did
  web: null,               // the gateway's settings and state, once fetched
  webBusy: null,           // what applying it is doing right now
};

/// What the thing serving this page can do on our behalf.
///
/// The Mac app's host server can reach ssh, the filesystem and the keychain,
/// so it offers to add servers, provision them and open forwards. A console
/// served by a daemon behind a reverse proxy can do none of that, and says so
/// by declaring nothing. Absent means none, deliberately: a hand-written
/// config for that arrangement should not have to know the list to be safe.
const can = name => !!(state.config.capabilities || {})[name];

const $sidebar = document.getElementById('sidebar');
const $main = document.getElementById('main');

// ---------------------------------------------------------------- controllers

function makeController(server, session) {
  const ctl = {
    api: server.api,
    session,
    /// What is half-typed in the composer, kept out here because the composer
    /// itself does not survive a repaint -- `renderSession` builds a new one
    /// every time -- and plenty of things repaint without being asked to: a
    /// machine reconnecting on the supervisor's timer, a model or permission
    /// change, a rename. The controller outlives all of them.
    draft: { text: '', attachments: [] },
    transcript: new Transcript(),
    streamAbort: null,
    listeners: new Set(),
    notifyPending: false,
    /// Bumped on every stop(); a stream loop checks the generation it was
    /// born with and exits when it no longer matches, so a restarted loop
    /// never runs alongside the old one.
    gen: 0,
    /// A permanent stop (the session was deleted). Unlike a gen bump -- which
    /// a restart clears -- this one sticks: an in-flight start() must not
    /// call loop() after it, or the loop would re-subscribe to a dead session.
    stopped: false,
    /// The cold open folded only the tail: older events exist on the server
    /// but not here. The "Load earlier" notice shows while this is true.
    truncated: false,
    /// A full fold is running; the notice says so instead of offering again.
    loadingAll: false,
    /// Set by loadAll() so the next render keeps the reader's place instead
    /// of snapping to the new top after rows were prepended.
    keepTop: false,
    /// Id of the item the view starts at, when the older ones have been
    /// cleared away. A view cursor and nothing more: the server keeps every
    /// event, so this is undone by showing them again.
    viewFrom: null,

    /// Coalesced on purpose.
    ///
    /// Reconnecting to a long session replays every event since the client's
    /// cursor -- thousands of them, back to back -- and each listener rebuilds
    /// the whole transcript. Rendering per event made that quadratic: the app
    /// froze, and while it was frozen the newest messages had not been folded
    /// in yet, so it also looked like nothing had synced. One frame's worth of
    /// events now costs one render.
    notify() {
      if (ctl.notifyPending) return;
      ctl.notifyPending = true;
      requestAnimationFrame(() => {
        ctl.notifyPending = false;
        for (const fn of ctl.listeners) fn();
      });
    },
    notifyNow() { for (const fn of ctl.listeners) fn(); },

    async start() {
      if (ctl.streamAbort || ctl.stopped) return;
      const gen = ctl.gen;
      try {
        if (ctl.transcript.isEmpty) {
          await ctl.openCold();
        } else {
          // Restart after a full fold: one page bridges whatever arrived
          // while nothing was subscribed. The window is milliseconds, so a
          // page is far more than the race can hold.
          const env = await ctl.api.session(session.id, ctl.transcript.lastSeq);
          ctl.session = env.session;
          for (const ev of env.events || []) ctl.transcript.apply(ev);
        }
        ctl.notify();
      } catch (e) { /* stream loop will surface it */ }
      // The session may have been deleted (or a restart begun) while the
      // tail was in flight; do not leave a loop subscribed to a dead session.
      if (ctl.stopped || gen !== ctl.gen) return;
      ctl.loop();
    },

    /// Cold open. Fast path first: a local cache of this session's events
    /// folds to an instant paint, then `?after=<lastSeq>` pulls only what is
    /// new -- usually nothing, for a session that has not moved since it was
    /// last open. On a miss (or a cache the server has outgrown) the tail
    /// stream fills the view and seeds the cache.
    async openCold() {
      const serverId = server.profile.id;
      const env = await ctl.api.request('GET', `/v1/sessions/${session.id}`,
                                        { query: { events: '0' } });
      ctl.session = env.session;
      const fingerprint = env.session.created_at;

      const cached = await cacheLoad(serverId, session.id);
      if (cached && cached.fingerprint === fingerprint) {
        for (const ev of cached.events || []) ctl.transcript.apply(ev);
        ctl.truncated = !!cached.truncated;
        ctl.notify();
        const delta = await ctl.api.session(session.id, cached.lastSeq || 0);
        const fresh = delta.events || [];
        // A gap means the server trimmed its log past our cursor: the cache
        // spans a hole the server can no longer refill. Drop it and re-tail.
        if (!fresh.length || fresh[0].seq <= (cached.lastSeq || 0) + 1) {
          for (const ev of fresh) ctl.transcript.apply(ev);
          if (fresh.length) {
            cacheSave(serverId, session.id, {
              fingerprint,
              events: (cached.events || []).concat(fresh),
              lastSeq: fresh[fresh.length - 1].seq,
              truncated: ctl.truncated,
            });
          }
          return;
        }
        ctl.transcript = new Transcript();
        await cacheClear(serverId, session.id);
      }

      // Cache miss, fingerprint mismatch, or gap: stream the tail. Events
      // fold as they arrive so the transcript paints in one round trip; the
      // window is then cached for the next open.
      const tailEvents = [];
      const tail = ctl.api.streamTail(session.id, TAIL_EVENTS, ev => {
        if (ev.type === '__tail_meta__') { ctl.truncated = !!ev.truncated; return; }
        tailEvents.push(ev);
        ctl.transcript.apply(ev);
        ctl.notify();
      });
      ctl.streamAbort = tail.controller;
      try {
        await tail.done;
        if (tailEvents.length) {
          cacheSave(serverId, session.id, {
            fingerprint,
            events: tailEvents,
            lastSeq: tailEvents[tailEvents.length - 1].seq,
            truncated: ctl.truncated,
          });
        }
      } finally {
        ctl.streamAbort = null;
      }
    },

    async loop() {
      const gen = ctl.gen;
      let backoff = 500;
      for (;;) {
        if (ctl.stopped || gen !== ctl.gen) return;
        const { controller, done } = ctl.api.stream(
          ctl.session.id, ctl.transcript.lastSeq, ev => {
            ctl.transcript.apply(ev);
            ctl.absorb(ev);
            backoff = 500;
            ctl.notify();
          });
        ctl.streamAbort = controller;
        try {
          await done;
          if (ctl.stopped || gen !== ctl.gen) return;
          await sleep(300);                         // clean close: resubscribe
        } catch (e) {
          if (ctl.stopped || gen !== ctl.gen) return;
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 10000);
        }
      }
    },

    absorb(ev) {
      const s = ctl.session;
      const was = s.state;
      if (ev.type === 'status' && ev.state) s.state = ev.state;
      else if (ev.type === 'turn.start') s.state = 'running';
      else if (ev.type === 'turn.end') {
        s.state = ev.error ? 'error' : 'idle';
        if (ev.totals) s.totals = ev.totals;
        s.turns += 1;
      } else if (ev.type === 'session.init' && ev.native_id) {
        s.native_id = ev.native_id;
      }
      if (s.state !== was) ctl.syncList();
    },

    /// Carry the state the stream just reported over to the sidebar's own copy.
    ///
    /// The running dot is painted from `entry.sessions`, and only the poller
    /// refreshes that -- while the controller stopped sharing an object with
    /// it the moment it opened a session of its own (`start` and `openCold`
    /// both take the server's fresh reading). So the dot moved on a six second
    /// timer, which made it late at exactly the two moments anyone is watching
    /// it: it lagged a message going out, and it kept spinning for seconds
    /// after a turn had stopped. The stream knows both immediately.
    ///
    /// Repaints only on a real change, since this runs inside the event loop.
    syncList() {
      const found = findSession(ctl.session.id);
      if (!found || found.session.state === ctl.session.state) return;
      found.session.state = ctl.session.state;
      renderSidebar();
    },

    stop() {
      ctl.stopped = true;
      ctl.gen += 1;
      ctl.streamAbort?.abort();
      ctl.streamAbort = null;
    },

    /// The tail open's escape hatch: fold the whole event log and swap it in.
    ///
    /// The reducer is a forward fold, so earlier events cannot be prepended
    /// to the live transcript -- and must not be: the stream is appending to
    /// it meanwhile. Stop the loop, fold from zero into a fresh transcript,
    /// then restart; start()'s backfill bridges whatever arrived mid-fold.
    async loadAll() {
      if (ctl.loadingAll || !ctl.truncated) return;
      ctl.loadingAll = true;
      ctl.notifyNow();
      ctl.stop();
      try {
        const fresh = new Transcript();
        const all = [];
        for (let page = 0; page < 100; page++) {
          const env = await ctl.api.session(ctl.session.id, fresh.lastSeq);
          const evs = env.events || [];
          for (const ev of evs) fresh.apply(ev);
          all.push(...evs);
          if (!env.truncated || !evs.length) break;
        }
        ctl.transcript = fresh;
        ctl.truncated = false;
        ctl.viewFrom = null;
        ctl.keepTop = true;
        // The full fold replaces the (compacted) tail in the cache, so the
        // next open is both instant and complete.
        if (all.length) {
          cacheSave(server.profile.id, ctl.session.id, {
            fingerprint: ctl.session.created_at,
            events: all,
            lastSeq: all[all.length - 1].seq,
            truncated: false,
          });
        }
      } catch (e) {
        ctl.transcript.noteLocalError(String(e.message || e));
      } finally {
        ctl.loadingAll = false;
        // stop() set this; the restart that follows is deliberate, so clear
        // it or start() would refuse and the session would go dark.
        ctl.stopped = false;
        ctl.start();
        ctl.notifyNow();
      }
    },

    async send(text, images) {
      try {
        await ctl.api.sendMessage(ctl.session.id, text, images);
        ctl.session.state = 'running';
        ctl.syncList();
        ctl.notify();
      } catch (e) {
        ctl.transcript.noteLocalError(String(e.message || e));
        ctl.notify();
      }
    },
    /// `keepQueue` is the "stop this and get to my next message" variant:
    /// the running turn ends and whatever is queued starts immediately,
    /// instead of the queue going down with the turn.
    interrupt(opts) {
      return ctl.api.interrupt(ctl.session.id, opts).catch(() => {});
    },
  };
  return ctl;
}

function controllerFor(serverId, session) {
  let ctl = state.controllers.get(session.id);
  if (!ctl) {
    ctl = makeController(state.servers.get(serverId), session);
    state.controllers.set(session.id, ctl);
    ctl.start();
  }
  return ctl;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- servers

async function connectServer(entry) {
  entry.status = 'connecting';
  renderSidebar();
  try {
    // The forward is a child process of this app, so it dies with it. Opening
    // it here means a provisioned server is reachable at launch instead of
    // needing Set up pressed again every time.
    if (entry.profile.mode === 'tunnel' && entry.profile.provisioned) {
      await startTunnel(entry.profile.id);
    }
    entry.facts = await entry.api.health();
    entry.status = 'online';
    entry.sessions = await entry.api.sessions();
  } catch (e) {
    entry.status = 'failed';
    entry.error = String(e.message || e);
  }
  renderSidebar();
  // Not unconditionally: the supervisor retries a dropped machine every few
  // seconds, and `renderMain` rebuilds the view it lands on. The draft now
  // survives that, but the caret and the scroll position do not, and a
  // machine that is not the one on screen changed nothing worth repainting
  // for. Same reasoning as `refreshSessions`: compare before painting.
  const showing = state.selectedSessionId ? findSession(state.selectedSessionId) : null;
  if (state.pane || !showing || showing.serverId === entry.profile.id) renderMain();
}

// A server that drops has no way back on its own: its sessions vanish from
// the sidebar and nothing offers to retry it. The poller doubles as a
// supervisor, backing off so a machine that is genuinely gone does not turn
// into an ssh loop.
const retries = new Map();          // serverId -> {next, delay}

function superviseServers() {
  for (const [id, entry] of state.servers) {
    if (entry.status === 'online' || entry.status === 'connecting') {
      retries.delete(id);
      continue;
    }
    if (!entry.profile.provisioned) continue;
    const r = retries.get(id) || { next: 0, delay: 5000 };
    if (Date.now() < r.next) continue;
    retries.set(id, { next: Date.now() + r.delay, delay: Math.min(r.delay * 2, 120000) });
    connectServer(entry);
  }
}

/// Everything the sidebar draws out of a session list.
///
/// The poller runs every six seconds whether or not anything moved, and a
/// repaint is not free: `renderSidebar` rebuilds every row, which also throws
/// away whatever was hovered. Most polls find nothing new, so compare first.
const sessionsSig = entry => (entry.sessions || [])
  .map(s => [s.id, s.title, s.state, s.archived ? 1 : 0, s.cwd, s.updated_at]
    .join('\u0000'))
  .join('\u0001');

async function refreshSessions() {
  let changed = false;
  for (const entry of state.servers.values()) {
    if (entry.status !== 'online') continue;
    const before = sessionsSig(entry);
    try {
      entry.sessions = await entry.api.sessions();
    } catch { entry.status = 'failed'; changed = true; continue; }
    if (sessionsSig(entry) !== before) changed = true;
  }
  if (changed) renderSidebar();
}

function findSession(id) {
  for (const [sid, entry] of state.servers) {
    const session = (entry.sessions || []).find(s => s.id === id);
    if (session) return { serverId: sid, entry, session };
  }
  return null;
}

/// Flat model list for pickers, derived from the provider tree. Falls back
/// to the legacy flat `models` config, then to built-ins.
function models() {
  const flat = [];
  for (const p of (state.config.providers || [])) {
    for (const m of (p.models || [])) {
      flat.push({
        id: m.id, name: m.alias || m.modelID, modelID: m.modelID,
        proto: p.proto || 'anthropic-messages',
        baseURL: p.baseURL || '',
        // The renderer never holds a saved key: hasKey is all the host gives
        // back. apiKey here is only the transient value of an unsaved edit
        // (or a legacy migration in flight), so it counts as present too.
        hasKey: !!(p.hasKey || p.apiKey), providerId: p.id,
        headers: p.headers || {},
        contextWindow: m.contextWindow || 200000,
        effort: m.effort || null,
        provider: p.name || 'Provider',
      });
    }
  }
  if (flat.length) return flat;
  return state.config.models.length ? state.config.models : [
    { id: 'b1', name: 'Claude Opus 4.5', modelID: 'claude-opus-4-5', proto: 'anthropic-messages' },
    { id: 'b2', name: 'Claude Sonnet 4.5', modelID: 'claude-sonnet-4-5', proto: 'anthropic-messages' },
    { id: 'b3', name: 'GPT-5 Codex', modelID: 'gpt-5-codex', proto: 'openai-responses' },
    { id: 'b4', name: 'GPT-5', modelID: 'gpt-5', proto: 'openai-responses' },
  ];
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : Math.random().toString(36).slice(2));

async function saveProviders() {
  await fetch('/host/providers', {
    method: 'POST',
    body: JSON.stringify({ providers: state.config.providers || [] }),
  });
}

/// One-time: lift the legacy flat model list into the provider tree.
function migrateLegacyModels() {
  if ((state.config.providers || []).length) return;
  if (!state.config.models.length) return;
  const groups = new Map();
  for (const m of state.config.models) {
    const key = `${m.baseURL || ''}|${m.proto}`;
    if (!groups.has(key)) {
      let name = 'Default';
      try { name = m.baseURL ? new URL(m.baseURL).hostname : (engineLabel(m.proto) + ' (login)'); } catch {}
      groups.set(key, { id: newId(), name, baseURL: m.baseURL || '',
        apiKey: m.apiKey || '', proto: m.proto,
        headers: m.headers || {}, models: [] });
    }
    const g = groups.get(key);
    if (!g.apiKey && m.apiKey) g.apiKey = m.apiKey;
    g.models.push({ id: m.id || newId(), modelID: m.modelID,
      alias: m.name || m.modelID, contextWindow: m.contextWindow || 200000 });
  }
  state.config.providers = [...groups.values()];
  saveProviders();
}

/// Context window for a session.
///
/// The number the session declared, which the daemon makes the engine honour:
/// Codex is handed that plus a reserve for its reply and told to compact at the
/// declared figure, and Claude is given it as the auto-compaction threshold and
/// takes its own reply buffer off the top -- about four percent, which nobody
/// can see and which is not worth a second number on screen to explain.
///
/// The session's own value wins over the model list, which can be edited after
/// the session was created.
function windowOf(session) {
  if (session.context_window) return session.context_window;
  const m = models().find(x => x.modelID === session.model);
  return (m && m.contextWindow) || 200000;
}
const fmtWindow = w => w >= 1e6 ? `${(w / 1e6).toFixed(w % 1e6 ? 1 : 0)}M`
  : `${Math.round(w / 1000)}K`;

/// What the window is holding after the last turn that completed without
/// error. Deliberately the turn's *last* request rather than its total: a turn
/// that called three tools sent the same prefix three times, and summing that
/// measures work done, not space occupied.
function lastUsage(ctl) {
  return ctl.transcript.usage || null;
}


const engineOf = proto => proto === 'anthropic-messages' ? 'claude'
  : proto === 'mock' ? 'mock' : 'codex';

/// The model a live session is on, as a row from the model list. A session
/// stores the id it was created with, not the entry, and the chips above the
/// composer need the protocol as well.
const modelOfSession = session => session && {
  proto: session.engine === 'claude' ? 'anthropic-messages' : 'openai-responses',
  modelID: session.model,
};
const engineLabel = proto => proto === 'anthropic-messages' ? 'Claude Code' : 'Codex';
const PERMISSIONS = [
  { value: 'bypassPermissions', label: 'Full access' },
  { value: 'acceptEdits', label: 'Workspace write' },
  { value: 'plan', label: 'Read only' },
];
const permLabel = v =>
  (PERMISSIONS.find(p => p.value === v) || PERMISSIONS[0]).label;

// Thinking effort, mapped server-side to Claude's thinking budget /
// Codex's model_reasoning_effort. Five levels, high by default.
const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];
const effortLabel = v =>
  (EFFORTS.find(e => e.value === v) || EFFORTS[2]).label;

// Codex's `priority` service tier, which Codex itself calls Fast: 1.5x speed
// for increased usage. A tier on the turn rather than a mode on the process,
// so switching it costs neither the engine nor its cache.
//
// Claude Code has a fast mode too and Caden does not offer it. It is not a
// parameter — it asks Anthropic to route Opus to faster hardware — so behind
// a gateway the CLI reports it on while nothing upstream is any quicker,
// which is a switch that lies. The tier is a request field and travels.
//
// Which Codex models have it is the daemon's to say, from the catalog the CLI
// ships; the renderer would only have a copy going stale. So the switch is
// drawn for Codex, and a model without the tier comes back
// `model_not_supported` after the first turn.
const fastCapable = model => !!model && engineOf(model.proto) === 'codex';

const FAST_REASONS = {
  model_not_supported: 'this model has no fast tier',
};
const fastNote = session => {
  if (!session || !session.fast) return 'Codex fast tier — 1.5x speed, more usage';
  if (session.fast_state === 'on') return 'Fast tier on';
  if (session.fast_reason) {
    const why = session.fast_reason;
    return `Fast tier unavailable: ${FAST_REASONS[why] || why}`;
  }
  // Nothing recorded yet is the gap between asking and the first turn, which
  // is when the tier is chosen -- there is no state to report before then.
  return 'Fast tier starts on the next turn';
};

// ---------------------------------------------------------------- navigation

function select(sessionId, serverId) {
  state.pane = null;
  state.selectedSessionId = sessionId;
  if (serverId) state.selectedServerId = serverId;
  dismissOverlaySidebar();
  renderSidebar();
  renderMain();
}

function openPane(pane) {
  state.pane = pane;
  dismissOverlaySidebar();
  if (pane === 'web') {
    state.web = null;                       // so the pane paints "checking…"
    // The settings and the server list are already on this machine; only the
    // ticks beside them need asking. Draw what is known first, then fill the
    // answers in -- waiting for the slowest check before drawing anything is
    // what made the pane look broken rather than busy.
    webStatus({ quick: true })
      .then(w => { if (state.pane === 'web' && !state.web?.probed) {
                     state.web = w; renderWebPane(); } })
      .catch(() => {});
    webStatus().then(w => { state.web = w; renderWebPane(); })
               .catch(e => { state.web = { error: String(e.message || e) };
                             renderWebPane(); });
  }
  if (pane === 'servers') {
    if (can('servers'))
      sshHosts().then(hosts => { state.sshHosts = hosts; renderServersPane(); }).catch(() => {});
    for (const p of state.config.servers) checkServer(p.id);
  }
  renderSidebar();
  renderMain();
}

// ---------------------------------------------------------------- sidebar
//
// Built from DOM templates extracted from the running Cursor Agents window:
// Cursor's own markup, Cursor's own stylesheet, our data and handlers.

/// Below the breakpoint the sidebar covers the canvas, so tapping the canvas
/// has to put it away again. A real element rather than a pseudo-element on
/// the body, so the dismissing click has something unambiguous to land on;
/// `display: none` outside the media query keeps it out of the desktop's row.
function syncScrim() {
  const want = state.sidebarOpen && NARROW.matches;
  const existing = document.getElementById('sidebar-scrim');
  if (!want) { existing?.remove(); return; }
  if (existing) return;
  $sidebar.after(el('div', {
    class: 'sidebar-scrim', id: 'sidebar-scrim',
    onclick: () => { if (dismissOverlaySidebar()) { renderSidebar(); renderMain(); } },
  }));
}

/// Picking a session or a pane replaces whatever the overlay was covering, so
/// leaving it up would hide the thing that was just asked for. No-op on a
/// desktop, where the sidebar is a column and nothing is being covered.
function dismissOverlaySidebar() {
  if (!NARROW.matches || !state.sidebarOpen) return false;
  state.sidebarOpen = false;
  return true;
}

function renderSidebar() {
  // Deferred, not dropped: whatever changed is still there when the edit ends.
  if (state.editing) { state.sidebarStale = true; return; }
  $sidebar.classList.toggle('hidden', !state.sidebarOpen);
  document.body.classList.toggle('sidebar-hidden', !state.sidebarOpen);
  syncScrim();
  if (!state.sidebarOpen) { $sidebar.replaceChildren(); return; }

  const nav = el('nav', { class: cls('sidebarClasses') });
  nav.dataset.component = 'workspace-sidebar';
  // --sidebar-width is @property-registered with inherits:false, so it must
  // be set inline on the nav — exactly what Cursor's resize wrapper does.
  nav.style.setProperty('--sidebar-width', 'var(--sidebar-w)');

  // Top bar, straight from Cursor (windowed capture): traffic-light spacer +
  // the sidebar toggle. Without traffic lights Cursor unmounts the spacer
  // and drops data-traffic-lights; mirror that outside Electron.
  const top = tpl('sidebarTop');
  if (!document.body.classList.contains('electron'))
    top.querySelector('.traffic-spacer')?.remove();
  const toggleBtn = top.querySelector('button');
  toggleBtn.title = 'Hide the sidebar';
  toggleBtn.addEventListener('click',
    () => { state.sidebarOpen = false; renderSidebar(); renderMain(); });

  const header = tpl('navHeader');
  const rows = [...header.querySelectorAll('[data-nav-row]')];
  const fillRow = (row, { label, icon, active, onClick }) => {
    if (!row) return;
    const text = row.querySelector('.nav-row-label');
    if (text) text.textContent = label;
    if (icon) setIcon(row.querySelector('.nav-row-lead svg'), icon);
    if (active) row.dataset.active = 'true';
    else row.removeAttribute('data-active');
    row.addEventListener('click', onClick);
    row.removeAttribute('data-action-id');
  };
  // The New session row reads as selected while the empty state is showing.
  fillRow(rows[0], { label: 'New session',
                     active: !state.selectedSessionId && !state.pane,
                     onClick: () => select(null) });
  fillRow(rows[1], { label: 'Servers', icon: 'server',
                     active: state.pane === 'servers',
                     onClick: () => openPane('servers') });
  fillRow(rows[2], { label: 'Models', icon: 'robot',
                     active: state.pane === 'models',
                     onClick: () => openPane('models') });
  // Setting a gateway up is ssh and root on somebody else's machine, so it
  // belongs to the Mac. Served from a daemon there is nothing to configure
  // and the row would only lead somewhere that says so.
  if (can('servers')) {
    fillRow(rows[3], { label: 'Web', icon: 'server',
                       active: state.pane === 'web',
                       onClick: () => openPane('web') });
  } else {
    rows[3]?.remove();
  }
  // Only the first row carries a shortcut badge.
  for (const r of [rows[1], rows[2], rows[3]])
    r?.querySelectorAll('.nav-row-end').forEach(n => n.replaceChildren());

  const content = el('div', { class: cls('contentCls'), id: 'server-list' });
  const viewport = el('div', { class: cls('viewportCls') }, content);
  viewport.style.overflowY = 'auto';
  const scroll = el('div', { class: cls('scrollAreaCls') }, viewport);
  scroll.style.flex = '1';
  scroll.style.minHeight = '0';

  nav.append(...[top, header, scroll, sidebarFooter()].filter(Boolean));
  $sidebar.replaceChildren(nav);
  renderServerList();
}

function sidebarFooter() {
  const f = tpl('footer');
  const online = [...state.servers.values()].filter(e => e.status === 'online').length;
  f.querySelector('.nav-row-label').textContent = 'Caden';
  f.querySelector('.nav-row-desc').textContent =
    online ? `${online} server${online === 1 ? '' : 's'} connected` : 'Offline';
  f.querySelector('.avatar').textContent = 'C';
  return f;
}

function renderServerList() {
  const list = document.getElementById('server-list');
  if (!list) return;
  list.replaceChildren();

  const group = el('div', { class: cls('groupCls') });
  const label = tpl('groupLabel');
  label.querySelector('.group-label-title').textContent = 'Repositories';
  // The chevron is the affordance, so it has to do something: the heading
  // folds the whole list. A collapsed group keeps its chevron at rest --
  // hiding it would leave the state invisible and no way back.
  const listFolded = state.repoListFolded;
  setIcon(label.querySelector('.group-label-chevron'),
          listFolded ? 'chevron-right' : 'chevron-down');
  label.classList.toggle('folded', listFolded);
  label.addEventListener('click', () => {
    state.repoListFolded = !state.repoListFolded;
    renderServerList();
  });
  group.append(label);
  // Sections live in their own box so folding the group does not also swallow
  // the offline notice underneath it.
  const body = el('div', { class: 'sidebar-group-body' });
  if (listFolded) body.style.display = 'none';
  group.append(body);

  // The project is the axis and the machine is an attribute: sessions from
  // every connected server merge into one repository list.
  const buckets = new Map();          // key -> {label, items:[{serverId,entry,session}]}
  for (const [serverId, entry] of state.servers) {
    if (entry.status !== 'online') continue;
    const cadenHome = entry.facts?.caden_home || '';
    for (const session of entry.sessions || []) {
      const scratch = cadenHome && session.cwd.startsWith(cadenHome);
      // Archived sessions leave the repository list entirely and collect in one
      // group of their own, so getting a session out of the way does not mean
      // losing track of it.
      const key = session.archived ? '\u0000archived'
                                   : (scratch ? '\u0000norepo' : session.cwd);
      if (!buckets.has(key)) {
        buckets.set(key, {
          label: session.archived ? 'Archived' : (scratch ? 'No Repo' : basename(session.cwd)),
          cwd: (session.archived || scratch) ? null : session.cwd,
          items: [] });
      }
      buckets.get(key).items.push({ serverId, entry, session });
    }
  }
  const groups = [...buckets.values()];
  for (const g of groups) g.items.sort((a, b) => b.session.updated_at - a.session.updated_at);
  // Repositories first, then the scratch bucket, and Archived at the very
  // bottom: it is the one group you are not meant to be looking at.
  const rank = g => (g.label === 'Archived' ? 2 : g.cwd === null ? 1 : 0);
  groups.sort((a, b) => (rank(a) - rank(b))
    || ((b.items[0]?.session.updated_at || 0) - (a.items[0]?.session.updated_at || 0)));

  for (const g of groups) body.append(repoSection(g));

  const anyOnline = [...state.servers.values()].some(e => e.status === 'online');
  if (!anyOnline) {
    const entries = [...state.servers.values()];
    group.append(el('div', { class: 'offline-note' },
      entries.some(e => e.status === 'connecting')
        ? 'Connecting…'
        : (entries[0]?.error || 'No server connected.'),
      el('br'),
      el('button', {
        onclick: () => entries.forEach(e => e.status !== 'online' && connectServer(e)),
      }, 'Connect')));
  }
  list.append(group);
}

function repoSection(g) {
  const sec = el('section', { class: cls('sectionCls') });
  const folded = state.foldedRepos.has(g.label);
  // Fold contract: expanded sections carry data-expanded=true, collapsed ones
  // drop the attribute and the list zeroes out.
  if (!folded) sec.dataset.expanded = 'true';

  const head = tpl('sectionHead');
  const newHere = () => {
    const first = g.items[0];
    state.selectedServerId = first.serverId;
    if (g.cwd) { state.draft.cwd = g.cwd; state.draft.serverId = first.serverId; }
    select(null);
  };
  const headBtn = head.matches('.nav-row') ? head : head.querySelector('.nav-row');
  const headLabel = headBtn.querySelector('.section-head-title');
  if (headLabel) headLabel.textContent = g.label;
  setIcon(headBtn.querySelector('.section-head-fold'),
          folded ? 'chevron-right' : 'chevron-down');
  // Clicking the row toggles the fold; the + stays "new here".
  headBtn.addEventListener('click', () => {
    if (folded) state.foldedRepos.delete(g.label);
    else state.foldedRepos.add(g.label);
    renderServerList();
  });
  const plusBtn = headBtn.querySelector('.nav-row-actions button');
  if (plusBtn) {
    plusBtn.title = 'New session here';
    plusBtn.addEventListener('click', e => { e.stopPropagation(); newHere(); });
  }
  headBtn.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMenu(headBtn, [{ label: 'New session here', action: newHere }]);
  });
  if (g.cwd) head.title = g.cwd;

  const ul = el('ul', { class: cls('menuCls') });
  for (const item of g.items) ul.append(sessionCell(item.serverId, item.entry, item.session));
  const wrap = el('div', { class: cls('sectionContentCls') },
    el('div', { class: 'sidebar-agent-list', role: 'presentation' }, ul));
  if (folded) wrap.style.display = 'none';

  // Folded means folded: Cursor keeps the selected session pinned below a
  // collapsed section, but a row that survives collapsing defeats the point of
  // collapsing it.
  sec.append(head, wrap);
  return sec;
}

/// Rename in place, wherever it was invoked from.
///
/// Not `window.prompt`: Electron does not implement it -- it throws
/// "prompt() is not supported." -- so the rename that used to live on the
/// title did nothing at all in the packaged app.
async function commitRename(entry, session, name) {
  const title = (name || '').trim();
  if (!title || title === session.title) { renderSidebar(); renderMain(); return; }
  try {
    const updated = await entry.api.patchSession(session.id, { title });
    session.title = updated.title;
    const ctl = state.controllers.get(session.id);
    if (ctl) ctl.session = updated;
  } catch { /* leave the old title in place */ }
  await refreshSessions();
  renderMain();
}

function renameInPlace(slot, entry, session) {
  inlineEdit(slot, {
    value: session.title || '',
    placeholder: 'Session name',
    onCommit: name => commitRename(entry, session, name),
    onCancel: () => { renderSidebar(); renderMain(); },
  });
}

async function setArchived(entry, session, archived) {
  try {
    await entry.api.patchSession(session.id, { archived });
  } catch (e) {
    return;
  }
  session.archived = archived;
  if (archived && state.selectedSessionId === session.id) {
    state.selectedSessionId = null;
  }
  await refreshSessions();
  renderMain();
}

async function deleteSession(entry, session) {
  state.controllers.get(session.id)?.stop();
  state.controllers.delete(session.id);
  cacheClear(entry.profile.id, session.id);
  await entry.api.deleteSession(session.id).catch(() => {});
  if (state.selectedSessionId === session.id) state.selectedSessionId = null;
  await refreshSessions();
  renderMain();
}

function sessionCell(serverId, entry, s) {
  const li = tpl('cell');
  const btn = fillMenuButton(li, {
    label: s.title || 'Untitled',
    onClick: () => select(s.id, serverId),
    onContext: e => openMenu(e.target.closest('.nav-row'), [
      // Edits the row itself, so a rename works from the list without having
      // to open the session first.
      { label: 'Rename', action: () => {
          const slot = li.querySelector('.nav-row-label');
          if (slot) renameInPlace(slot, entry, s);
        } },
      { label: s.archived ? 'Bring back' : 'Archive session',
        action: () => setArchived(entry, s, !s.archived) },
      '-',
      { label: 'Delete session', action: () => deleteSession(entry, s) },
    ]),
  });
  btn.title = s.cwd;
  if (state.selectedSessionId === s.id && !state.pane) btn.dataset.active = 'true';

  // Status slot: running gets the animated dot grid, error recolours the
  // dot, idle hides it -- the gutter stays occupied either way.
  const dot = btn.querySelector('.status-dot');
  const statusWrap = btn.querySelector('.nav-row-status');
  if (s.state === 'running' && statusWrap) {
    statusWrap.replaceWith(tpl('dotLoader'));
  } else if (dot && s.state === 'error') {
    dot.style.background = '#e8706b';
  } else if (statusWrap) {
    statusWrap.style.visibility = 'hidden';
  }

  // The hover action archives; deleting is one level further in, on the
  // context menu, because it cannot be undone.
  btn.querySelector('[title=Pin]')?.remove();
  const arch = btn.querySelector('[title=Archive]');
  if (arch) {
    if (s.archived) setIcon(arch.querySelector('i'), 'arrow-up');
    arch.title = s.archived ? 'Bring back' : 'Archive session';
    arch.addEventListener('click', async e => {
      e.stopPropagation();
      await setArchived(entry, s, !s.archived);
    });
  }
  return li;
}

// ---------------------------------------------------------------- main pane

function renderMain() {
  // Every listener a view registers is bound to that view's DOM -- the
  // transcript node, the composer, the gauge. Leaving another session's
  // listeners attached means its next streamed event renders *its* transcript
  // into whatever view is on screen now, because #transcript is looked up by
  // id and there is only ever one. Streams keep running in the background on
  // purpose; the rendering must not.
  for (const c of state.controllers.values()) {
    c.listeners.clear();
    // And the kept rows with them. They are live DOM nodes; holding a
    // transcript's worth per background session is a leak, and the view being
    // torn down is exactly the moment they stop being worth anything.
    c.rowNodes = null;
  }

  if (state.pane === 'web') { renderWebPane(); return; }
  if (state.pane === 'models') { renderModelsPane(); return; }
  if (state.pane === 'servers') { renderServersPane(); return; }
  if (state.pane?.sessionDetail) {
    renderDetailPane(state.pane.sessionDetail);
    return;
  }
  const found = state.selectedSessionId ? findSession(state.selectedSessionId) : null;
  if (found) renderSession(found);
  else renderDraft();
}

function collapsedStrip() {
  if (state.sidebarOpen) return null;
  // Collapsing unmounts the sidebar entirely; this strip puts the toggle back
  // at the head of the titlebar row, in the same place it sat before, so it
  // never moves under the pointer.
  const strip = tpl('collapsedStrip');
  const btn = strip.querySelector('button');
  btn.addEventListener('click',
    () => { state.sidebarOpen = true; renderSidebar(); renderMain(); });
  return strip;
}

// ---- session view

function renderSession({ serverId, entry, session }) {
  const ctl = controllerFor(serverId, session);

  const header = buildTopbar(ctl, entry, session);

  const conv = el('div', { class: 'conversation' },
    el('div', { class: 'conversation-inner', id: 'transcript' }));

  // Clear before buildComposer: it registers its own listener.
  ctl.listeners.clear();
  const composer = buildComposer(ctl, entry);

  $main.replaceChildren(header, conv, composer);
  renderTranscript(ctl);
  conv.scrollTop = conv.scrollHeight;

  let prevHeight = conv.scrollHeight;
  ctl.listeners.add(() => {
    const atBottom = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 80;
    const top = conv.scrollTop;
    renderTranscript(ctl);
    if (ctl.keepTop) {
      // "Load earlier" prepended rows above the viewport; keep the reader's
      // place instead of snapping to the new top.
      ctl.keepTop = false;
      conv.scrollTop = top + (conv.scrollHeight - prevHeight);
    } else if (atBottom) conv.scrollTop = conv.scrollHeight;
    // Running state shows in the sidebar loader and the composer pill —
    // Cursor's topbar carries no status dot.
    prevHeight = conv.scrollHeight;
  });
}

/// Cursor's own top bar, filled with our session. Buttons are located by
/// their captured icon names so the fill survives markup we don't control.
/// Title-less top bar for views without a session (draft, empty). Keeping
/// the same captured bar in every view pins the collapsed strip to one spot.
function bareTopbar() {
  const top = tpl('topbar');
  top.style.flex = 'none';
  // No session, so no title and no session menu -- just the strip when the
  // sidebar is away.
  top.querySelector('.icon-btn').remove();
  if (!state.sidebarOpen) top.prepend(collapsedStrip());
  return top;
}

function buildTopbar(ctl, entry, session) {
  const top = tpl('topbar');
  top.style.flex = 'none';

  // Title, the machine it runs on, and the session menu.
  top.querySelector('.icon-btn').remove();
  const titleText = top.querySelector('.title');
  titleText.textContent = ctl.session.title || 'Untitled';
  titleText.title = 'Rename';
  titleText.addEventListener('click',
    () => renameInPlace(titleText, entry, ctl.session));

  const end = top.querySelector('.header-end');
  end.append(el('span', { class: 'chip' },
    cIcon('server', 10), entry.profile.name));
  const dots = el('button', { class: 'icon-btn', type: 'button',
                              title: 'Session options' }, cIcon('ellipsis', 15));
  end.append(dots);
  dots.addEventListener('click', () => openMenu(dots, [
    { label: 'Rename session',
      action: () => renameInPlace(titleText, entry, ctl.session) },
    { label: 'Copy session id', action: () => navigator.clipboard.writeText(session.id) },
    // Nothing is deleted: a long session is slow to scroll and slower to
    // repaint, and most of the time only the exchange in progress matters.
    { label: 'Clear view', action: () => {
        const items = ctl.transcript.items;
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].kind === 'user') { ctl.viewFrom = items[i].id; break; }
        }
        renderTranscript(ctl);
      } },
    '-',
    { label: 'Delete session', action: () => deleteSession(entry, session) },
  ]));
  if (!state.sidebarOpen) top.prepend(collapsedStrip());
  return top;
}

/// The transcript is reconciled, not rebuilt.
///
/// A streamed turn asks for one render per frame, and the conversation it is
/// rendering only ever changes at the tail: everything above the running turn
/// is finished text that will not differ again. Replacing the whole subtree on
/// every delta therefore did work proportional to the entire history sixty
/// times a second -- and most of that was not building nodes (~3ms for a
/// hundred turns) but the forced relayout of every row that had just been
/// thrown away and rebuilt identically. A hundred-turn session cost 33ms a
/// frame, a four-hundred-turn one 133ms. That is where the window went stiff:
/// the main thread never came up for air, so typing and scrolling queued
/// behind it.
///
/// So rows are keyed and kept. One is rebuilt only when the data behind it
/// actually moved (`rowSig`); otherwise the node from last frame is reused
/// untouched -- which is also what lets an open fold stay open and the dot
/// loader keep its animation instead of restarting on every delta.
/// The live row's own clock.
///
/// Written straight into the DOM rather than re-rendered: the row is kept
/// across frames precisely so the dot loader's animation survives, and
/// rebuilding it once a second to move a number would restart it. Blank for
/// the first few seconds, because a wait only becomes a question once it has
/// lasted longer than a reply normally takes.
const liveElapsed = since => {
  const ms = since ? Date.now() - since : 0;
  return ms > 4000 ? fmtDuration(ms) : '';
};
setInterval(() => {
  for (const node of document.querySelectorAll('.live-elapsed')) {
    const text = liveElapsed(Number(node.dataset.since) || 0);
    if (node.textContent !== text) node.textContent = text;
  }
}, 1000);

function renderTranscript(ctl) {
  // Belt and braces for the same hazard: only the selected session owns the
  // one #transcript node.
  if (ctl.session.id !== state.selectedSessionId) return;
  const box = document.getElementById('transcript');
  if (!box) return;
  // Read before anything moves, and consulted only by rows being built this
  // pass: a reused node already carries its own open state in the DOM.
  const open = new Set([...box.querySelectorAll('[data-fold].open')]
    .map(n => n.dataset.fold));

  const view = visibleFrom(ctl.transcript.items, ctl.viewFrom);
  if (view.stale) ctl.viewFrom = null;
  const hidden = view.hidden;
  const rows = groupRows(view.items);
  const live = ctl.session.state === 'running';

  const kept = ctl.rowNodes || new Map();          // key -> {sig, node}
  const next = new Map();
  const wanted = [];
  /// Last frame's node for this key, unless its data moved.
  const place = (key, sig, build, cls) => {
    const was = kept.get(key);
    const node = (was && sigEq(was.sig, sig)) ? was.node : build();
    if (!node) return;
    if (cls !== undefined && node.className !== cls) node.className = cls;
    next.set(key, { sig, node });
    wanted.push(node);
  };

  if (ctl.truncated) {
    place('load-earlier', [ctl.loadingAll ? 'busy' : 'idle'], () =>
      el('div', { class: 'notice', style: 'margin-bottom:2px' },
        ctl.loadingAll
          ? 'loading earlier history…'
          : 'showing recent messages only',
        ctl.loadingAll
          ? null
          : el('button', { class: 'notice-action', onclick: () => ctl.loadAll() },
              'Load earlier')));
  }
  if (hidden) {
    place('hidden', ['hidden'], () =>
      el('div', { class: 'notice', style: 'margin-bottom:2px' },
        'earlier history hidden',
        el('button', { class: 'notice-action', onclick: () => {
          ctl.viewFrom = null;
          renderTranscript(ctl);
        } }, 'show all')));
  }

  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    const cls = ['t-row'];
    if (row.kind === 'item' && row.item.kind === 'user') cls.push('exchange');
    else if (prev?.kind === 'item' && prev.item.kind === 'user') cls.push('reply');
    const liveTail = live && i === rows.length - 1;
    place(`row:${row.id}`, rowSig(row, ctl, liveTail), () => {
      const inner = renderRow(row, open, liveTail, ctl);
      return inner ? el('div', {}, inner) : null;
    }, cls.join(' '));
    // The signature keeps the reasoning text out so the row survives the
    // stream; its open fold is topped up here instead. Only the tail block is
    // still growing -- every earlier one stopped being the tail, which changed
    // its header and rebuilt it once with the text it ended on.
    if (liveTail && row.kind === 'item' && row.item.kind === 'thinking') {
      growFoldBody(next.get(`row:${row.id}`)?.node, row.item);
    }
  });

  // A running turn has to show something in the transcript itself. Cursor can
  // get away with signalling activity only in the sidebar because its own
  // engine streams reasoning continuously; here a turn can legitimately go
  // quiet for many seconds -- gateways that strip reasoning summaries leave
  // nothing between the message and the first tool call -- and a transcript
  // that does not move reads as a hang.
  //
  // Nothing is added when the tail already shows activity of its own: a live
  // thinking block or a running tool card is a better indicator than a
  // generic one.
  //
  // And nothing at all until the conversation has a first row. An empty
  // transcript stays empty: a lone indicator floating in a blank column is
  // the least finished thing in the window, and the sidebar is already
  // carrying the same news for a session that has not spoken yet.
  if (live && rows.length) {
    const items = ctl.transcript.items;
    const tail = items[items.length - 1];
    // Anything that is itself moving speaks for the turn: streaming text, a
    // live reasoning block, a command still running. "Thinking…" under a reply
    // that is visibly being typed is just wrong -- it belongs to the gaps,
    // where the model has stopped saying anything and has not started doing
    // anything either.
    // `streaming` and not merely `kind`: a block keeps its kind after it has
    // finished arriving, so a completed paragraph at the tail used to pass for
    // activity and the indicator vanished while the turn was still running --
    // which reads as "it stopped".
    //
    // Reasoning is the exception, and takes `kind` alone. A model that reasons
    // continuously closes one block and opens the next milliseconds later, and
    // reading that seam as a gap put this whole row on screen for a single
    // frame between every pair of blocks -- a row appearing and vanishing as
    // fast as the transcript repainted, which is the flicker, plus the scroll
    // jump that came with it. The reasoning row is its own indicator anyway:
    // as the live tail its header already reads "Thinking…".
    const busyTail = tail && (
      (tail.kind === 'assistant' && tail.streaming)
      || tail.kind === 'thinking'
      || (tail.kind === 'tool' && tail.tool?.running));
    if (!busyTail) {
      const ran = items.some(i => i.kind === 'tool' && i.turn === tail?.turn);
      // Naming the phase matters more than the spinner does. A compaction runs
      // for minutes with nothing else on the wire; unnamed it reads as a hang,
      // and interrupting it throws the whole thing away.
      const compacting = ctl.transcript.compacting;
      const since = compacting?.ts || ctl.transcript.lastEventTs || 0;
      // `since` is deliberately not in the signature. It moves with every
      // event on the wire, so comparing it rebuilt this row on every frame of
      // a streaming turn -- and rebuilding it restarts the dot loader, which
      // is the one thing on screen whose whole job is to keep moving. It
      // stutters in place of animating, and the row it sits in is torn out and
      // put back sixty times a second underneath it. The moment it counts from
      // is written into the node instead, the same way the interval above
      // ticks the number itself.
      place('live', ['live', ran, !!compacting], () =>
        el('div', { class: 't-row reply' },
          el('div', { class: 'working-row' },
            tpl('dotLoader'),
            el('span', {}, compacting ? 'Compacting the conversation…'
                                      : ran ? 'Working…' : 'Thinking…'),
            el('span', { class: 'live-elapsed' }))));
      const clock = next.get('live')?.node.querySelector('.live-elapsed');
      if (clock && clock.dataset.since !== String(since)) {
        clock.dataset.since = String(since);
        clock.textContent = liveElapsed(since);
      }
    }
  }

  ctl.rowNodes = next;
  reconcile(box, wanted);
}

/// Bring `box`'s children into `wanted`'s order with the fewest moves. A node
/// already in the right place is not touched at all, which is the whole point:
/// an untouched node is a subtree the browser does not lay out again.
function reconcile(box, wanted) {
  let node = box.firstChild;
  for (const want of wanted) {
    if (node === want) { node = node.nextSibling; continue; }
    box.insertBefore(want, node);                  // moves it if already here
  }
  while (node) {
    const gone = node;
    node = node.nextSibling;
    box.removeChild(gone);
  }
}

const sigEq = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/// Everything `renderRow` reads about a row, flattened.
///
/// Compared field by field rather than joined into one string: the assistant
/// text alone would make that an allocation the size of the transcript on
/// every frame, which is the cost this exists to avoid. Text that has not
/// changed is the same string, so `!==` settles it on the pointer. Objects the
/// event fold replaces wholesale (`todos`, `files`, `summary`, a tool's
/// `input`) compare by identity for the same reason.
function rowSig(row, ctl, liveTail) {
  const item = row.item;
  if (row.kind === 'tools' || item.kind === 'tool' || item.kind === 'diff') {
    const items = row.kind === 'tools' ? row.items : [item];
    const sig = ['g'];
    for (const it of items) {
      if (it.kind === 'diff') { sig.push('d', it.id, it.files); continue; }
      const c = it.tool || {};
      sig.push('t', c.id, c.name, c.title, c.running, c.isError, c.exitCode,
               c.input, c.output, c.startedAt, c.durationMs);
      // A command still running prints how long it has been running, so its
      // row has to differ once a second even when nothing else has moved.
      if (c.running) sig.push(Math.floor(Date.now() / 1000));
    }
    return sig;
  }
  switch (item.kind) {
    case 'user':      return ['u', item.text];
    case 'assistant': return ['a', item.text];
    // Deliberately not the text. Reasoning arrives a few characters at a
    // frame, and a signature that moved with it rebuilt the row sixty times a
    // second: the open fold was thrown away and built again, the selection in
    // it went, and the header flickered under any model that reasons
    // continuously. Only what the header shows is compared; the body is
    // topped up in place (growFoldBody) instead.
    case 'thinking':  return ['k', thinkLabel(item, liveTail), item.text.length > 0];
    case 'todo':      return ['o', item.todos];
    case 'summary':   return ['s', item.summary];
    case 'error':     return ['e', item.text];
    case 'notice':    return ['n', item.text, item.queuedTurn, ctl.session.state];
  }
  return ['?', item.kind, item.text];
}

/// The reasoning row's header. `Thinking…` while the block is still the live
/// tail: how long it took is not a number until it has stopped arriving, and
/// a header that counted up would move -- and so rebuild the row -- once a
/// second for no reason anyone reads.
function thinkLabel(item, liveTail) {
  if (liveTail) return 'Thinking…';
  const ms = (item.endTs || 0) - (item.ts || 0);
  return ms > 500 ? `Thought for ${fmtDuration(ms)}` : 'Thought';
}

/// Top up the reasoning body that is still arriving, in place.
///
/// The row is kept across frames on purpose (see rowSig), so the fold open on
/// screen is the same node it was last frame: appending only the characters
/// that are new lays out one run instead of the whole block, and leaves the
/// selection and the scroll inside it alone. Deltas only ever append, so
/// anything else -- the first fill, the final block replacing what the deltas
/// built -- is written whole.
function growFoldBody(node, item) {
  const body = node && node.querySelector('.fold-body');
  if (!body) return;                  // fold is closed: built from the item on open
  const text = item.text || '';
  const had = body.dataset.len === undefined ? -1 : Number(body.dataset.len);
  if (had === text.length) return;
  if (item.streaming && had >= 0 && text.length > had) body.append(text.slice(had));
  else body.textContent = text || '…';
  if (text) body.dataset.len = String(text.length);
  else delete body.dataset.len;
}

function renderRow(row, open, liveTail = false, ctl = null) {
  if (row.kind === 'tools') return toolGroup(row, open);
  const item = row.item;
  switch (item.kind) {
    case 'user':
      return rowHuman(item.text);
    case 'assistant':
      return rowText(renderMarkdown(item.text));
    case 'thinking': {
      // No decorative rows: skip thinking blocks that carry no text (some
      // gateways strip thinking deltas), unless it's the live tail.
      if (!item.text.trim() && !liveTail) return null;
      return toolFold({
        key: `think:${item.id}`, open, action: thinkLabel(item, liveTail),
        buildBody: () => {
          const body = el('div', { class: 'fold-body', text: item.text || '…' });
          // How much of the block is already on screen, so a later delta can
          // append its own characters rather than rewrite the whole block.
          // Absent while the body is the placeholder -- there is nothing to
          // append to yet.
          if (item.text) body.dataset.len = String(item.text.length);
          return body;
        },
      });
    }
    case 'tool':
      return toolGroup({ items: [item], id: item.id }, open);
    case 'todo':
      return el('div', { class: 'todo' }, item.todos.map(todoRow));
    case 'diff':
      return el('div', {}, (item.files || []).map(diffRow));
    case 'summary':
      // Still no stats in the transcript -- the context gauge and its tray
      // carry the numbers. This is punctuation: a hairline where one turn ends
      // so a long conversation has somewhere to breathe, with the elapsed time
      // on it because that is the one number you look for while scrolling.
      return item.summary?.error ? summaryRow(item.summary) : turnDivider(item.summary);
    case 'error':
      return el('div', { class: 'error-block' },
        el('span', { class: 'sign' }, icon('warn', 11)), item.text);
    case 'notice': {
      const box = el('div', { class: 'notice', text: item.text });
      // A message waiting behind a long turn is the one moment where "stop
      // what you are doing" and "send this" are the same wish. Offered here
      // rather than in the composer because this is where the waiting message
      // actually is.
      if (item.queuedTurn && ctl && ctl.session.state === 'running') {
        box.append(el('button', { class: 'notice-action', onclick: async e => {
          e.currentTarget.disabled = true;
          await ctl.interrupt({ keepQueue: true });
        } }, 'interrupt and send now'));
      }
      return box;
    }
  }
  return null;
}

// ---- Cursor transcript rows, from captured markup: we fill text and wire
// the collapse; every class and state attribute is Cursor's own.

function rowHuman(text) {
  const row = tpl('rowHuman');
  row.querySelector('.human-msg-body').textContent = text;
  return row;
}

function rowText(markdownNode) {
  const row = tpl('rowText');
  row.querySelector('.md').replaceChildren(markdownNode);
  return row;
}

/// A folding row of machine detail: verb, subject, and a body built on first
/// open. Rows, not cards -- see docs/DESIGN.md on why the transcript has no
/// bordered containers.
function toolFold({ key, open, action, desc = '', summary = '',
                    failed = false, buildBody }) {
  const row = tpl('rowTool');
  const call = row.querySelector('.tool-call');
  const header = call.querySelector('.fold');
  const verb = header.querySelector('.verb');
  verb.textContent = action;
  if (failed) verb.classList.add('failed');
  header.querySelector('.subject').textContent = [desc, summary].filter(Boolean).join(' ');
  row.dataset.fold = key;

  let view = null;
  const setOpen = o => {
    row.classList.toggle('open', o);
    header.classList.toggle('open', o);
    if (o && !view) {
      view = tpl('rowToolOpen').querySelector('.fold-view');
      view.querySelector('.fold-content').replaceChildren(buildBody());
      call.append(view);
    }
    if (view) view.style.display = o ? '' : 'none';
  };
  header.addEventListener('click', () => setOpen(!row.classList.contains('open')));
  if (open.has(key)) setOpen(true);
  return row;
}

/// One tool call inside an expanded group, with the mono input/output card
/// toggling underneath it.
function toolCallLine(call, open) {
  const line = tpl('toolLine');
  line.setAttribute('data-tool-status',
    call.running ? 'running' : call.isError ? 'error' : 'completed');
  const action = line.querySelector('.tool-line-action');
  const details = line.querySelector('.tool-line-details');
  if (action) action.textContent = toolVerb(call.name);
  if (details) details.textContent = call.title || call.name;
  // A command still running says how long it has been running. Without it a
  // wait -- polling a job, sleeping between checks -- is indistinguishable
  // from a hang, which is the question people actually have when they look.
  const waiting = call.running && call.startedAt
    ? Math.max(Date.now() - call.startedAt, 0) : 0;
  const meta = call.exitCode ? ` · exit ${call.exitCode}`
    : call.durationMs > 0 ? ` · ${fmtDuration(call.durationMs)}`
    : waiting > 2000 ? ` · ${fmtDuration(waiting)} so far` : '';
  if (details && meta) details.textContent += meta;

  // Keyed and folded the same way a group is. Rows are reused across renders
  // now, so an open detail usually survives on its own -- but the row it lives
  // in is still rebuilt whenever its own data moves (another call joining the
  // group, the command finishing), and the key is what reopens it afterwards.
  // Without it a detail opened to read a command's output would close again
  // the moment that command ended, which is exactly while you are reading it.
  const key = 'call:' + (call.id || call.name);
  const isOpen = open.has(key);
  const detail = el('div', { style: isOpen ? '' : 'display:none' });
  const buildDetail = () => {
    const input = call.input?.command
      ?? (call.input ? JSON.stringify(call.input, null, 1) : '');
    if (input) detail.append(el('div', { class: 'mono-block', text: input }));
    if (call.output) {
      detail.append(el('div', {
        class: 'mono-block' + (call.isError ? ' err' : ''), text: call.output }));
    } else if (!input) {
      detail.append(el('div', { class: 'notice', style: 'padding:4px 8px' },
        call.running ? 'running…' : 'no output captured'));
    }
    detail.dataset.built = '1';
  };
  const wrap = el('div', { dataset: { fold: key }, class: isOpen ? 'open' : '' });
  const clickable = line.querySelector('.tool-line') || line;
  clickable.addEventListener('click', () => {
    if (!detail.dataset.built) buildDetail();
    const on = detail.style.display === 'none';
    detail.style.display = on ? '' : 'none';
    wrap.classList.toggle('open', on);
  });
  if (isOpen) buildDetail();
  wrap.append(line, detail);
  return wrap;
}

function fold(key, open, verb, subject, buildBody, failed = false) {
  const isOpen = open.has(key);
  const wrap = el('div', { dataset: { fold: key }, class: isOpen ? 'open' : '' });
  const chev = el('span', { class: 'chev' }, isOpen ? '▾' : '▸');
  const head = el('button', { class: 'fold' + (isOpen ? ' open' : ''), onclick: () => {
    wrap.classList.toggle('open');
    const on = wrap.classList.contains('open');
    chev.textContent = on ? '▾' : '▸';
    body.style.display = on ? '' : 'none';
    head.classList.toggle('open', on);
  } },
    el('span', { class: 'verb' + (failed ? ' failed' : '') }, verb),
    el('span', { class: 'subject' }, subject),
    chev);
  const body = el('div', { style: isOpen ? '' : 'display:none' });
  body.append(buildBody());
  wrap.append(head, body);
  return wrap;
}

/// The raw command to print after a tool row's label, if it adds anything.
function commandSuffix(call) {
  const cmd = typeof call.input?.command === 'string'
    ? call.input.command.split('\n')[0].trim() : '';
  if (!cmd) return '';
  const label = (call.title || call.name || '').trim();
  return label.startsWith(cmd) || cmd.startsWith(label) ? '' : cmd;
}

function toolGroup(row, open) {
  const calls = row.items.filter(i => i.kind === 'tool').map(i => i.tool);
  const diffs = row.items.filter(i => i.kind === 'diff').flatMap(i => i.files || []);
  const failed = calls.some(c => c.isError);

  const running = calls.some(c => c.running);
  let verb, subject;
  if (calls.length === 1) {
    verb = toolVerb(calls[0].name);
    subject = calls[0].title || calls[0].name;
  } else {
    verb = diffs.length ? 'Edited' : 'Explored';
    const counts = new Map();
    for (const c of calls) {
      const b = toolBucket(c.name);
      counts.set(b, (counts.get(b) || 0) + 1);
    }
    const parts = [...counts].map(([b, n]) => `${n} ${b}`);
    if (diffs.length) parts.unshift(`${diffs.length} file${diffs.length === 1 ? '' : 's'}`);
    subject = parts.join(', ');
  }
  // Live groups read in the present tense, as Cursor's activity rows do.
  if (running) {
    verb = { Ran: 'Running', Read: 'Reading', Edited: 'Editing',
             Searched: 'Searching', Explored: 'Exploring', Fetched: 'Fetching',
             Delegated: 'Delegating' }[verb] || verb;
    subject += subject ? '…' : '';
  }

  const single = calls.length === 1 ? calls[0] : null;
  return toolFold({
    key: `tg:${row.id}`, open, action: verb,
    desc: single ? (single.title || single.name) : subject,
    // The command, but only when the label is not already it. A shell call's
    // title *is* its command, so the row printed it twice -- invisible on a
    // long one, where the line ellipsizes before the repeat, and glaring on a
    // short one. The pair earns its place when the title is a summary of
    // something the command does not say.
    summary: single ? commandSuffix(single) : '',
    failed,
    buildBody: () => {
      const frag = document.createDocumentFragment();
      for (const call of calls) {
        frag.append(toolCallLine(call, open));
        // Claude describes an edit through the tool's arguments and sends no
        // diff of its own; codex sends one ready-made below. Both end up in
        // the same shape here.
        for (const d of (diffFromToolInput(call.name, call.input) || [])) {
          frag.append(renderDiff(d));
        }
      }
      for (const f of diffs) {
        frag.append(f.diff ? renderDiff({ path: f.path, kind: f.kind, unified: f.diff })
                           : diffRow(f));
      }
      return frag;
    },
  });
}

/// The end of a turn, as punctuation rather than a report.
function turnDivider(summary) {
  const ms = summary?.durationMs || 0;
  const row = el('div', { class: 'turn-divider' },
    ms > 0 ? el('span', {}, fmtDuration(ms)) : null);
  const u = summary?.usage || {};
  if (u.input_tokens || u.output_tokens) {
    row.title = `${compactTokens(u.input_tokens || 0)} in · `
      + `${compactTokens(u.output_tokens || 0)} out`
      + (summary.costUSD ? ` · ${usd(summary.costUSD)}` : '');
  }
  return row;
}

function todoRow(todo) {
  const done = todo.status === 'completed' || todo.status === 'done';
  const active = todo.status === 'in_progress' || todo.status === 'active';
  return el('div', { class: 'todo-item' + (done ? ' done' : active ? ' active' : '') },
    el('span', { class: 'mark' }, done ? '✓' : active ? '◌' : '○'),
    el('span', {}, todo.text));
}

function diffRow(f) {
  const op = f.kind === 'add' ? ['+', 'add'] : f.kind === 'delete' ? ['−', 'del'] : ['~', 'mod'];
  const dir = (f.path || '').split('/').slice(0, -1).join('/');
  return el('div', { class: 'diff-row', title: f.path },
    el('span', { class: `op ${op[1]}` }, op[0]),
    el('span', { class: 'f' }, basename(f.path || 'file')),
    el('span', { class: 'd' }, dir));
}

function summaryRow(sum) {
  if (!sum) return null;
  if (sum.error) {
    return el('div', { class: 'error-block' },
      el('span', { class: 'sign' }, icon('warn', 11)), sum.error);
  }
  const total = (sum.usage.input_tokens || 0) + (sum.usage.output_tokens || 0);
  const bits = [];
  if (total) bits.push(`${compactTokens(total)} tokens`);
  if (sum.usage.cache_read_tokens) bits.push(`${compactTokens(sum.usage.cache_read_tokens)} cached`);
  if (sum.costUSD) bits.push(usd(sum.costUSD));
  if (sum.durationMs) bits.push(`${(sum.durationMs / 1000).toFixed(1)}s`);
  return el('div', { class: 'summary' }, bits.map(b => el('span', {}, b)));
}

// ---- composer

/// The composer: one surface with two rows -- the text field on top and a
/// controls row (workspace, permission mode, model, send) underneath. The
/// editor is a plain contenteditable; everything around it is built here.
/// `draft` is where the half-written message lives between repaints. The
/// composer is rebuilt from scratch by every `renderMain`, so without somewhere
/// outside it to read from and write to, a repaint nobody asked for -- a
/// machine reconnecting, a model swapped mid-sentence -- silently threw away
/// what had been typed.
function buildPromptInput({ root, placeholder, modelLabel, engine, onPlusMenu, onModelMenu,
                            isRunning, onSend, onInterrupt, onShiftTab, effort,
                            fast, permission, onPasteOther = () => {}, draft = null }) {
  root = root || tpl('promptInput');

  // A contenteditable rather than a textarea: the composer has to hold
  // attachment chips and a slash-command menu alongside the text, and a
  // textarea cannot contain anything.
  const ce = root.querySelector('[contenteditable]');
  const firstP = () => ce.querySelector('p')
    || ce.appendChild(document.createElement('p'));
  const getText = () => ce.innerText.replace(/\n+$/, '').trim();
  // The placeholder rides on the first paragraph as an attribute a ::before
  // paints, so an empty editor still has a line box to sit on.
  const syncEmpty = () => {
    const p = firstP();
    p.setAttribute('data-placeholder', placeholder);
    p.classList.toggle('is-empty',
      !ce.textContent.trim() && ce.children.length <= 1);
  };
  // A one-line composer reads as a pill; taller than that and the same radius
  // would stretch into a capsule, so the shape steps down to the 16px card
  // radius. One line is 24px; the threshold sits between that and two.
  const syncTall = () => {
    root.classList.toggle('is-tall', ce.getBoundingClientRect().height > 30);
  };
  // Measured from the observer and nowhere else, because measuring is not
  // free: `getBoundingClientRect` forces layout wherever it is called from,
  // and calling it per keystroke meant every character typed during a
  // streaming turn paid to lay out the whole transcript -- 12ms a character
  // on a long session, which is most of what "the composer is laggy" was.
  // A ResizeObserver runs inside the frame's own layout pass instead, so it
  // reads a box that has already been computed, and it fires once on
  // observation so the initial state is set without a measurement of our own.
  // It also catches the height moving without an edit at all: a paste
  // settling, the window narrowing and rewrapping.
  new ResizeObserver(syncTall).observe(ce);

  const caretToEnd = () => {
    const range = document.createRange();
    range.selectNodeContents(ce.lastElementChild || firstP());
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const setText = text => {
    const p = document.createElement('p');
    p.textContent = text;
    ce.replaceChildren(p);
    syncEmpty();
    caretToEnd();                       // caret after what we just inserted
  };

  // -- slash commands ---------------------------------------------------
  //
  // Caden only offers these; the engine runs them. The list is deliberately
  // two long -- the commands that change how a long session behaves -- rather
  // than a mirror of everything the CLIs accept.
  //
  // Both CLIs have `/goal`, but they do not mean the same thing, so neither
  // does the line describing it. For Codex it is a standing objective the
  // server works on, with a status and a token budget, and `resume` is the way
  // back from a run it stopped. For Claude it is a stop condition -- "keep
  // working until this is true" -- with no resume at all. One shared line had
  // to be vague enough to be true of both, and ended up advertising `resume`
  // on sessions that have never heard of it.
  const SLASH = [
    { name: 'goal', takesArg: true,
      desc: engine === 'codex'
        ? 'Set the objective to work toward — also: /goal clear, /goal resume'
        : 'Set a condition Claude checks before it stops — also: /goal clear' },
    { name: 'compact', takesArg: false,
      desc: 'Summarize the conversation to prevent hitting the context limit' },
  ];
  const slashMenu = el('div', { class: 'slash-menu' });
  let slashMatches = [];
  let slashPick = 0;

  const hideSlash = () => {
    slashMatches = [];
    slashMenu.remove();
  };
  const acceptSlash = i => {
    const cmd = slashMatches[i];
    if (!cmd) return;
    hideSlash();
    // Complete, never send: `/goal` still needs its objective, and a command
    // that fires the moment you finish typing its name is a trap.
    setText('/' + cmd.name + (cmd.takesArg ? ' ' : ''));
    update();
    ce.focus();
  };
  const renderSlash = () => {
    // Only while the whole message is a bare command name: `/go` matches,
    // `/goal ship it` is an argument being typed and the menu gets out of
    // the way.
    const m = /^\/([a-zA-Z]*)$/.exec(getText());
    if (!m) return hideSlash();
    slashMatches = SLASH.filter(c => c.name.startsWith(m[1].toLowerCase()));
    if (!slashMatches.length) return hideSlash();
    slashPick = Math.min(slashPick, slashMatches.length - 1);
    slashMenu.replaceChildren(...slashMatches.map((c, i) => {
      const row = el('div',
        { class: 'slash-row' + (i === slashPick ? ' picked' : '') },
        el('span', { class: 'slash-name' }, '/' + c.name),
        el('span', { class: 'slash-desc' }, c.desc));
      // mousedown, not click: the editor must not lose focus first.
      row.addEventListener('mousedown', e => { e.preventDefault(); acceptSlash(i); });
      row.addEventListener('mouseenter', () => { slashPick = i; renderSlash(); });
      return row;
    }));
    if (!slashMenu.isConnected) {
      root.parentNode?.insertBefore(slashMenu, root.nextSibling);
    }
  };

  // -- pasted images ----------------------------------------------------
  //
  // These ride along as image blocks on the message rather than as an upload:
  // a screenshot is pasted to be *looked at*, and both engines take images in
  // the turn itself. Files picked with + are the other case -- they go to the
  // server and the message carries a path.
  // The same rule the host applies to a picked file: only what a model will
  // actually take rides in the turn. Everything else is a file, wherever it
  // came from.
  const MODEL_IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const IMAGE_MAX = 4 << 20;
  // Mirrors the host's cap, checked here too so a huge paste is refused before
  // it is read into memory rather than after.
  const ATTACH_MAX = 50 << 20;
  // The same array the draft holds, not a copy: everything below mutates it
  // in place (`push`, `splice`), so staged images survive a repaint with the
  // text they were pasted alongside.
  if (draft && !draft.attachments) draft.attachments = [];
  const attachments = draft ? draft.attachments : [];
  const attRow = el('div', { class: 'att-row' });
  const renderAtt = () => {
    attRow.replaceChildren(...attachments.map((a, i) => {
      const drop = el('button', { class: 'att-x', title: 'Remove' }, '×');
      drop.addEventListener('click', e => {
        e.preventDefault();
        attachments.splice(i, 1);
        renderAtt();
        update();
      });
      return el('div', { class: 'att-chip' }, cIcon('file', 11),
                el('span', { class: 'att-name' }, a.name), drop);
    }));
    attRow.style.display = attachments.length ? '' : 'none';
  };

  const clear = () => {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    ce.replaceChildren(p);
    syncEmpty();
    hideSlash();
  };
  // Restored without touching the selection: `root` is still detached here, so
  // there is nothing to put a caret in yet. The caller focuses it after mount
  // and `focus` puts the caret at the end of what was restored.
  if (draft && draft.text) {
    const p = document.createElement('p');
    p.textContent = draft.text;
    ce.replaceChildren(p);
    syncEmpty();
  } else {
    clear();
  }
  renderAtt();

  const plus = root.querySelector('.composer-plus');
  if (plus) plus.addEventListener('click', () => onPlusMenu(plus));

  const trigger = root.querySelector('.model-trigger');
  const modelText = trigger?.querySelector('.model-label');
  const setModelLabel = text => { if (modelText) modelText.replaceChildren(text); };
  setModelLabel(modelLabel);
  if (trigger) trigger.addEventListener('click', () => onModelMenu(trigger));

  // Optional thinking-effort switch in the toolbar (draft view, where there
  // is no status row to host it).
  // `fast` is a switch rather than a menu -- two states do not need a list --
  // so it carries `onToggle` and lights up instead of naming its value.
  for (const [chip, icon] of [[permission, 'lock-locked'], [effort, 'brain'],
                              [fast, 'bolt']]) {
    if (!chip) continue;
    const btn = el('button', { class: 'effort-btn', title: chip.title || '',
                               'data-on': chip.on?.() || null },
      cIcon(icon, 12), el('span', { class: 'effort-label' }, chip.label()));
    btn.addEventListener('click',
      () => chip.onMenu ? chip.onMenu(btn) : chip.onToggle());
    root.querySelector('.composer-controls-left')?.append(btn);
  }

  const toolbar = root.querySelector('.composer-controls');
  if (toolbar) toolbar.parentNode.insertBefore(attRow, toolbar);

  const submit = root.querySelector('.send-btn');

  const doSend = () => {
    const text = getText();
    if (!text && !attachments.length) return;
    const images = attachments.splice(0, attachments.length);
    clear();
    renderAtt();
    onSend(text, images);
    update();
  };
  ce.addEventListener('keydown', e => {
    if (slashMatches.length && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : slashMatches.length - 1;
        slashPick = (slashPick + step) % slashMatches.length;
        renderSlash();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptSlash(slashPick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSlash();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    } else if (e.key === 'Tab' && e.shiftKey && onShiftTab) {
      e.preventDefault();
      onShiftTab();
    }
  });
  ce.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])]
      .filter(i => i.kind === 'file')
      .map(i => i.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      for (const file of files) onPasteFile(file);
      return;
    }
    // Plain text otherwise: strip any markup riding in on the paste.
    e.preventDefault();
    document.execCommand('insertText', false,
      e.clipboardData.getData('text/plain'));
  });

  /// A pasted image the model can read goes into the turn; anything else is a
  /// file and has to reach the server before it means anything.
  function onPasteFile(file) {
    const name = file.name || 'pasted';
    if (file.size > ATTACH_MAX) {
      insert(`[${name} is ${(file.size / (1 << 20)).toFixed(1)} MB; `
             + `attachments are capped at 50.0 MB]`);
      return;
    }
    if (MODEL_IMAGE.includes(file.type) && file.size <= IMAGE_MAX) {
      const reader = new FileReader();
      reader.onload = () => attach({
        media_type: file.type,
        data: String(reader.result).split(',')[1] || '',
        name,
      });
      reader.readAsDataURL(file);
      return;
    }
    onPasteOther(file, name);
  }
  ce.addEventListener('input', () => {
    syncEmpty(); update(); renderSlash();
  });
  if (submit) submit.addEventListener('click', () => {
    if (isRunning()) onInterrupt();
    else doSend();
  });

  // The send button carries the state: filled once there is something to
  // send, dim while the draft is empty, and a stop square while a turn runs.
  const setSubmit = (filled, kind) => {
    if (!submit) return;
    submit.className = filled ? cls('submitClsActive') : cls('submitClsDim');
    submit.replaceChildren(cIcon(kind === 'stop' ? 'stop' : 'arrow-up', 14));
  };
  function update() {
    // Every edit passes through here -- typing, send, insert, attach -- so it
    // is the one place the draft has to be written back from.
    if (draft) draft.text = getText();
    const running = isRunning();
    if (running) setSubmit(true, 'stop');
    else setSubmit(Boolean(getText() || attachments.length), 'arrow');
  }
  update();

  const insert = text => {
    const now = getText();
    setText(now ? now + ' ' + text : text);
    update();
  };
  const replace = (from, to) => {
    const now = getText();
    if (!now.includes(from)) return;
    setText(now.replace(from, to));
    update();
  };

  const attach = img => { attachments.push(img); renderAtt(); update(); };

  return { root, ce, update, setModelLabel, getText, clear, insert, replace,
           attach, focus: () => { ce.focus(); caretToEnd(); } };
}

/// The thin row under the composer: workspace, machine, live spinner —
/// Cursor's branch row with our facts.
/// Cursor's Context Usage tray, filled with the categories our daemon can
/// actually report: cached prompt / fresh input / output of the last turn.
function buildContextPanel(ctl, onClose) {
  const tray = tpl('contextPanel');
  tray.querySelector('.ctx-panel-close').addEventListener('click', onClose);
  const u = lastUsage(ctl) || {};
  // Three ways a prompt token can arrive, and they are not interchangeable:
  // read back from cache (cheap, already there), written to cache this turn
  // (full price now, cheap next turn), or sent uncached. Folding the middle
  // one into Input hides why a turn cost what it did.
  const parts = [
    { color: 'gray', label: 'Cached prompt', val: u.cache_read_tokens || 0 },
    { color: 'purple', label: 'Cache write', val: u.cache_write_tokens || 0 },
    { color: 'blue', label: 'Input', val: u.input_tokens || 0 },
    { color: 'orange', label: 'Output', val: u.output_tokens || 0 },
  ].filter(p => p.val > 0);
  const WINDOW = windowOf(ctl.session);
  const used = parts.reduce((s, p) => s + p.val, 0);

  tray.querySelector('.ctx-panel-pct').textContent = `${pctText(used, WINDOW)} full`;
  tray.querySelector('.ctx-panel-count').textContent =
    `~${compactTokens(used)} / ${fmtWindow(WINDOW)} tokens`;

  const bar = tray.querySelector('.ctx-bar');
  for (const p of parts) {
    const seg = tpl('ctxSegment');
    seg.dataset.color = p.color;
    seg.style.flexGrow = p.val;
    bar.append(seg);
  }
  // The unused part of the window is a segment of its own rather than an
  // absent one, so the bar runs the full width instead of looking like it
  // stops early.
  const free = tpl('ctxSegment');
  free.dataset.color = 'free';
  free.style.flexGrow = Math.max(WINDOW - used, 0);
  bar.append(free);

  const list = tray.querySelector('.ctx-cats');
  for (const p of parts) {
    const li = tpl('ctxCategory');
    li.dataset.color = p.color;
    li.querySelector('.ctx-cat-label').textContent = p.label;
    li.querySelector('.ctx-cat-value').textContent = compactTokens(p.val);
    list.append(li);
  }
  return tray;
}

function buildStatusRow(ctl, entry, onToggleContext) {
  const row = tpl('statusRow');
  const buttons = row.querySelectorAll('button');
  // Only the permission switch survives here: workspace and machine are
  // fixed facts of the session, not things to fiddle per message.
  const permBtn = buttons[0];
  if (buttons[1]) buttons[1].remove();
  if (permBtn) {
    permBtn.removeAttribute('disabled');
    setIcon(permBtn.querySelector('svg'), 'lock-locked');
    const label = permBtn.querySelector('span');
    label.textContent = permLabel(ctl.session.permission_mode);
    permBtn.addEventListener('click', () => openMenu(permBtn, PERMISSIONS.map(p => ({
      label: p.label, checked: p.value === ctl.session.permission_mode,
      action: async () => {
        ctl.session = await ctl.api.patchSession(ctl.session.id, { permission_mode: p.value });
        renderMain();
      },
    }))));
  }
  // Context gauge: the last completed turn's request size against the
  // model's window; totals ride the tooltip.
  const gauge = tpl('contextGauge');
  gauge.style.marginLeft = 'auto';
  const arc = gauge.querySelector('.gauge-value');
  // The ring declares pathLength=100, so the arc is a percentage of it.
  const CIRC = 100;
  const updateGauge = () => {
    const limit = windowOf(ctl.session);
    const used = contextUsed(lastUsage(ctl));
    const frac = Math.min(used / limit, 1);
    // Round the arc up to something drawable: a hairline of ink reads as
    // "a turn happened", an empty ring reads as "nothing did".
    const arcLen = used > 0 ? Math.max(frac * CIRC, 0.9) : 0;
    if (arc) arc.setAttribute('stroke-dasharray', `${arcLen.toFixed(3)} ${CIRC}`);
    const totals = ctl.session.totals || {};
    const tokens = (totals.input_tokens || 0) + (totals.output_tokens || 0);
    gauge.title = `Context ${pctText(used, limit)}`
      + (tokens ? ` · ${compactTokens(tokens)} tokens` : '')
      + (totals.cost_usd ? ` · ${usd(totals.cost_usd)}` : '');
  };
  updateGauge();
  ctl.listeners.add(updateGauge);
  if (onToggleContext) gauge.addEventListener('click', onToggleContext);

  // Thinking effort, left of the context gauge.
  const effortBtn = el('button', { class: 'effort-btn', title: 'Thinking effort' },
    cIcon('brain', 12),
    el('span', { class: 'effort-label' }, effortLabel(ctl.session.effort)));
  // The goal slot pushes everything right; the effort button no longer has to.
  gauge.style.marginLeft = '6px';
  effortBtn.addEventListener('click', () => openMenu(effortBtn, EFFORTS.map(x => ({
    label: x.label, checked: (ctl.session.effort || 'high') === x.value,
    action: async () => {
      ctl.session = await ctl.api.patchSession(ctl.session.id, { effort: x.value });
      renderMain();
    },
  }))));

  // The goal outlives the turn that set it and steers what the engine does
  // next, so it belongs on screen rather than buried in one old reply.
  //
  // Repainted on every event, like the gauge beside it. Built once, it froze
  // at whatever was true when the view opened -- the engine reports goal
  // changes continuously, but nothing was listening, so the state only moved
  // when something else happened to rebuild the row.
  const slot = el('span', { class: 'goal-slot' });
  const paintGoal = () => {
    // Not `||`: once the engine has spoken, its answer stands even when the
    // answer is "no goal". Falling back on a cleared goal resurrects the one
    // the view opened with.
    const goal = ctl.transcript.sawGoal ? ctl.transcript.goal : ctl.session.goal;
    const act = ctl.transcript.activity;
    const tasks = ctl.transcript.tasks ?? ctl.session.tasks ?? [];
    slot.replaceChildren();

    if (goal) {
      // `set` is Claude's case: the objective is what the user asked for, and
      // Caden cannot see whether the condition has been met, so it claims
      // nothing about that. Codex reports a real status.
      const tip = goal.status === 'set'
        ? [`Goal: ${goal.objective}`,
           'Claude checks this before it stops — clear it with /goal clear']
        : [`Goal: ${goal.objective}`, `status: ${goal.status}`];
      if (goal.token_budget) {
        tip.push(`${compactTokens(goal.tokens_used)} / `
                 + `${compactTokens(goal.token_budget)} tokens`);
      }
      // What the engine last said about it. On the Claude side Caden asks after
      // every turn, so this is as fresh as the last time it stopped -- and it
      // is the only place the reason a condition has not been met is stated.
      if (goal.checked) tip.push(`checked: ${goal.checked}`);
      if (goal.last_reason) tip.push(`last check: ${goal.last_reason}`);
      // The state goes first: trailing it put the one word that matters behind
      // an objective long enough to be ellipsized, so a paused goal looked
      // exactly like a running one. `active` says nothing -- no news is news,
      // and it means the goal is in force, not that a turn is running right
      // now; whether one is is already the spinner's job.
      const idle = goal.status !== 'active' && goal.status !== 'set';
      slot.append(el('span', { class: 'goal-chip', 'data-idle': idle || null,
                               title: tip.join('\n') },
        // A word rather than a pictogram, like every other label in the
        // transcript: `Ran`, `Explored`, `Update`.
        el('em', { class: 'goal-label' }, 'Goal'),
        // The state word when it is stopped, the turn count when it is
        // running: both answer "is this going anywhere", and only one of them
        // is ever true at a time.
        idle ? el('em', { class: 'goal-state' }, goal.status)
             : /\d/.test(goal.checked || '') ? el('em', { class: 'goal-state' },
                                                   goal.checked) : null,
        el('span', {}, goal.objective)));
    } else if (tasks.length) {
      // No goal, but work still running: an idle session with a job pending
      // is not a finished one, and when that job wakes the engine up the
      // restart should already have had a reason on screen.
      const first = tasks[0].description || 'background command';
      const more = tasks.length > 1 ? ` +${tasks.length - 1}` : '';
      slot.append(el('span', { class: 'goal-chip', 'data-idle': true,
                               title: tasks.map(t => t.description).join('\n') },
        el('em', { class: 'goal-label' }, 'Background'),
        el('span', {}, first + more)));
    } else if (act && act.category && act.category !== 'working') {
      // Claude keeps no standing goal, but it does report where the turn left
      // off -- awaiting, blocked, review_ready -- which is the same question.
      slot.append(el('span', { class: 'goal-chip', 'data-status': act.category,
                               title: act.detail || act.category },
        el('span', {},
           act.needsAction ? `${act.category} · needs you` : act.category)));
    }
  };
  paintGoal();
  ctl.listeners.add(paintGoal);

  // The fast tier, beside the effort switch it reads as a sibling of -- and
  // is one: both are fields on the turn. The session carries which tier the
  // last turn actually asked for, so a model without one says so on hover
  // rather than sitting lit and doing nothing.
  const fastBtn = fastCapable(modelOfSession(ctl.session))
    ? el('button', { class: 'effort-btn', title: fastNote(ctl.session),
                     'data-on': ctl.session.fast || null },
        cIcon('bolt', 12), el('span', { class: 'effort-label' }, 'Fast'))
    : null;
  if (fastBtn) {
    fastBtn.addEventListener('click', async () => {
      ctl.session = await ctl.api.patchSession(ctl.session.id,
                                               { fast: !ctl.session.fast });
      renderMain();
    });
  }

  row.append(slot, fastBtn, effortBtn, gauge);
  row.classList.add('caden-status-row');
  return row;
}

/// The + button: pick files on this machine, push them to the server, and drop
/// the paths they landed at into the message.
///
/// An attachment has to physically reach the machine the agent runs on before
/// it means anything, so "attaching" is an upload — and what the message ends
/// up carrying is a path the agent can open, not a blob the model has to be
/// handed.
async function attachFiles(entry, prompt, plus) {
  // No native panel here: raise the browser's own, and send bytes rather than
  // paths. Same destination -- the daemon's upload endpoint is what the Mac
  // route ends up calling too -- so what lands in the message is identical.
  if (!can('filePicker')) return attachFromBrowser(entry, prompt, plus);

  let files;
  try {
    files = await pickFiles();
  } catch (e) {
    prompt.insert(`[${e.message || e}]`);
    return;
  }
  if (!files.length) return;
  const was = plus?.title;
  if (plus) { plus.disabled = true; plus.title = 'Attaching…'; }
  for (const file of files) {
    try {
      const got = await attachFile(entry.profile.id, file.path);
      // The host decided which of the two an attachment is; honour it.
      if (got.kind === 'image') prompt.attach(got);
      else prompt.insert(got.path);
    } catch (e) {
      prompt.insert(`[could not attach ${file.name}: ${e.message || e}]`);
    }
  }
  if (plus) { plus.disabled = false; plus.title = was || ''; }
  prompt.focus();
}

/// The + button where there is no native panel to raise.
///
/// A browser gives bytes and a name, never a path, which is the same hand the
/// paste path is dealt -- so this walks the same road, straight at the
/// daemon. The input is created per click and dropped afterwards: a hidden
/// one parked in the DOM keeps its last selection, and picking the same file
/// twice in a row then fires no change event at all.
function attachFromBrowser(entry, prompt, plus) {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', multiple: true,
                                style: 'display:none' });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.remove();
      if (!files.length) return resolve();
      const was = plus?.title;
      if (plus) { plus.disabled = true; plus.title = 'Attaching…'; }
      for (const file of files) {
        prompt.insert(`[uploading ${file.name}…]`);
        try {
          const got = await entry.api.attachLocalFile(file);
          if (got.kind === 'image') {
            prompt.replace(`[uploading ${file.name}…]`, '');
            prompt.attach(got);
          } else {
            prompt.replace(`[uploading ${file.name}…]`, got.path);
          }
        } catch (e) {
          prompt.replace(`[uploading ${file.name}…]`,
                         `[could not attach ${file.name}: ${e.message || e}]`);
        }
      }
      if (plus) { plus.disabled = false; plus.title = was || ''; }
      prompt.focus();
      resolve();
    }, { once: true });
    document.body.append(input);
    input.click();
  });
}

/// A non-image pasted straight out of Finder: the renderer can read its bytes
/// but not its path, so the bytes are what gets pushed to the server.
async function uploadPastedFile(entry, prompt, file, name) {
  prompt.insert(`[uploading ${name}…]`);
  try {
    const got = await attachBytes(entry.profile.id, name, await file.arrayBuffer());
    prompt.replace(`[uploading ${name}…]`, got.path);
  } catch (e) {
    prompt.replace(`[uploading ${name}…]`, `[could not attach ${name}: ${e.message || e}]`);
  }
}

function buildComposer(ctl, entry) {
  const prompt = buildPromptInput({
    draft: ctl.draft,
    placeholder: 'Send follow-up',
    modelLabel: ctl.session.model_label || ctl.session.model || 'model',
    engine: ctl.session.engine,
    isRunning: () => ctl.session.state === 'running',
    onSend: (text, images) => ctl.send(text, images),
    onInterrupt: () => ctl.interrupt(),
    // Attachments only. The working directory is settled when the session is
    // created and the permission chip lives in the status row.
    onPlusMenu: plus => attachFiles(entry, prompt, plus),
    onPasteOther: (file, name) => uploadPastedFile(entry, prompt, file, name),
    onModelMenu: anchor => openMenu(anchor, modelMenuItems(async m => {
      ctl.session = await ctl.api.patchSession(ctl.session.id, Object.assign({
        model: m.modelID, model_label: m.name || m.modelID,
        provider: providerFor(m),
        // The window belongs to the model, so it moves with it. Left behind,
        // the engine would keep enforcing the old model's limit.
        context_window: m.contextWindow || null,
      }, credentialFor(m)));
      renderMain();
    }, ctl.session.model, ctl.session.engine)),
  });
  ctl.listeners.add(prompt.update);

  const box = el('div', { class: 'composer-area' });
  let tray = null;
  const toggleTray = () => {
    if (tray) { tray.remove(); tray = null; return; }
    tray = buildContextPanel(ctl, () => { tray?.remove(); tray = null; });
    box.prepend(tray);
  };
  box.append(prompt.root, buildStatusRow(ctl, entry, toggleTray));
  setTimeout(() => prompt.focus(), 0);
  return box;
}

function providerFor(m) {
  const provider = { protocol: m.proto };
  if (m.baseURL) provider.base_url = m.baseURL;
  if (m.headers && Object.keys(m.headers).length) provider.headers = m.headers;
  if (m.proto === 'openai-chat') provider.wire_api = 'chat';
  return provider;
}

/// The credential rides as a reference, not a value: the proxy swaps in the
/// real key from the keychain. Saved keys have hasKey; an unsaved edit (or a
/// legacy migration still in flight) carries the value transiently, and in
/// that case it goes inline -- the host has nothing to look up yet.
function credentialFor(m) {
  if (m.apiKey) return { provider: Object.assign(providerFor(m), { api_key: m.apiKey }) };
  if (m.hasKey) return { key_ref: m.providerId };
  return {};
}

/// `engine` is the engine a running session is bound to. Models on the other
/// protocol stay listed but come back disabled: the binding is fixed at
/// creation and the daemon rejects a cross-protocol change, so a greyed row
/// reads better than a model that disappears. The new-session composer passes
/// no engine and gets everything enabled.
function modelMenuItems(pick, currentId, engine) {
  const items = [];
  const byGroup = new Map();
  for (const m of models()) {
    const g = m.provider || (engineOf(m.proto) === 'claude' ? 'Claude Code' : 'Codex');
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(m);
  }
  for (const [group, list] of byGroup) {
    if (!list.length) continue;
    // A provider entry carries one protocol, so a group is uniformly
    // switchable or not.
    const off = Boolean(engine) && engineOf(list[0].proto) !== engine;
    items.push({ section: group });
    for (const m of list) {
      items.push({ label: m.name || m.modelID, checked: m.modelID === currentId,
                   disabled: off, action: off ? undefined : () => pick(m) });
    }
  }
  return items;
}

/// Directory picker as a walkable anchored menu — lightweight, non-modal.
/// A directory browser for the *server's* filesystem.
///
/// The native open panel this is modelled on can only ever browse the machine
/// it runs on, and these paths live on a server, so the listing comes from the
/// daemon's /v1/fs and the panel is ours. Files are listed but dimmed: they
/// are there to tell you where you are, not to be picked.
function browseDirectory(api, start, pick) {
  let path = start || '~';

  const crumbs = el('div', { class: 'fs-crumbs', title: 'Click to type a path' });
  // Typing a path beats walking to it when you already know where you are
  // going -- and `~` or a path pasted from a terminal both work, because the
  // daemon expands it on the machine that owns the filesystem.
  const pathInput = el('input', { class: 'fs-path', spellcheck: 'false',
                                  placeholder: '/path/to/somewhere' });
  let editing = false;
  let lastGood = path;
  const list = el('div', { class: 'fs-list' });
  const footPath = el('div', { class: 'fs-foot-path' });
  const backdrop = el('div', { class: 'fs-backdrop' });

  const onKey = e => {
    if (e.target === pathInput) return;      // the path field owns its keys
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter') { e.preventDefault(); choose(); }
  };

  const startEdit = () => {
    editing = true;
    pathInput.value = path;
    crumbs.replaceChildren(pathInput);
    pathInput.focus();
    pathInput.select();
  };
  const stopEdit = () => { editing = false; render(); };
  pathInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const next = pathInput.value.trim();
      editing = false;
      if (next) goto(next); else render();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stopEdit();
    }
  });
  pathInput.addEventListener('blur', () => { if (editing) stopEdit(); });
  // Only the bar's own blank space: a click on a crumb is a jump, not an edit.
  crumbs.addEventListener('click', e => { if (e.target === crumbs) startEdit(); });
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  function choose() { close(); pick(path); }

  const goto = next => { path = next; render(); };

  async function render() {
    list.replaceChildren(el('div', { class: 'fs-note' }, 'Loading…'));
    let listing;
    try {
      listing = await api.fsList(path);
    } catch (e) {
      // Keep the panel where it was: a path typed by hand is often a typo, and
      // stranding the browser on it would mean reopening the whole thing.
      list.replaceChildren(el('div', { class: 'fs-note' }, String(e.message || e)));
      path = lastGood;
      footPath.textContent = path;
      return;
    }
    path = listing.path;
    lastGood = path;
    footPath.textContent = path;

    const crumb = (label, target) => {
      const b = el('button', { class: 'fs-crumb' }, label);
      b.onclick = () => goto(target);
      return b;
    };
    const parts = path.split('/').filter(Boolean);
    const nodes = [crumb('/', '/')];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      nodes.push(el('span', { class: 'fs-sep' }, '›'), crumb(part, acc));
    }
    crumbs.replaceChildren(...nodes);

    const rows = [];
    if (listing.parent && listing.parent !== path) {
      const up = el('div', { class: 'fs-row dir' },
        cIcon('folder-open', 13), el('span', { class: 'fs-name' }, '..'));
      up.onclick = () => goto(listing.parent);
      rows.push(up);
    }
    const entries = [...listing.entries].sort(
      (a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      const row = el('div', { class: 'fs-row ' + (entry.dir ? 'dir' : 'file') },
        cIcon(entry.dir ? 'folder' : 'file', 13),
        el('span', { class: 'fs-name' }, entry.name),
        entry.git ? el('span', { class: 'fs-tag' }, 'git') : null,
        entry.dir ? el('span', { class: 'fs-chev' }, '›') : null);
      if (entry.dir) row.onclick = () => goto(entry.path);
      rows.push(row);
    }
    list.replaceChildren(...(rows.length ? rows
      : [el('div', { class: 'fs-note' }, 'Nothing here.')]));
    list.scrollTop = 0;
  }

  const cancel = el('button', { class: 'fs-btn' }, 'Cancel');
  cancel.onclick = close;
  const open = el('button', { class: 'fs-btn primary' }, 'Open');
  open.onclick = choose;

  backdrop.append(el('div', { class: 'fs-panel' },
    crumbs,
    list,
    el('div', { class: 'fs-foot' },
      footPath,
      el('div', { class: 'fs-actions' }, cancel, open))));
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  render();
}

// ---- draft (new session / empty state)

function renderDraft() {
  const online = [...state.servers.entries()].filter(([, e]) => e.status === 'online');
  const chosen = online.find(([id]) => id === state.selectedServerId) || online[0];

  if (!chosen) {
    $main.replaceChildren(
      bareTopbar(),
      el('div', { class: 'center-note' },
        icon('waves', 22),
        'No server is connected.\nConnect one in the sidebar to start a session.'));
    return;
  }
  const [serverId, entry] = chosen;
  const d = state.draft;
  if (!d.modelId) d.modelId = models()[0]?.id;
  // Re-derived until somebody picks one: `facts` arrives a round trip after
  // the first paint, so a mode settled on the first render would be settled
  // before the answer got here.
  if (!d.permissionModeChosen || d.serverId !== serverId) {
    d.permissionMode = defaultPermissionFor(entry);
    d.permissionModeChosen = false;
  }
  if (!d.cwd || d.serverId !== serverId) {
    d.serverId = serverId;
    const recent = (entry.sessions || [])
      .filter(s => !(entry.facts?.caden_home && s.cwd.startsWith(entry.facts.caden_home)))
      .sort((a, b) => b.updated_at - a.updated_at)[0];
    // The server's own home, never this machine's: a path from the desktop
    // ("/Users/...") does not exist on a Linux box, and creating it fails at
    // the first component.
    d.cwd = recent?.cwd || entry.facts?.home || state.config.defaults.workdir || '~';
  }
  const model = models().find(m => m.id === d.modelId) || models()[0];
  if (!d.effort) d.effort = 'high';
  // A model swap can take the switch away underneath a session that had it on.
  if (!fastCapable(model)) d.fast = false;

  // Cursor's own empty-state page, replayed whole; we only fill data in.
  const page = tpl('emptyState');
  const errBox = el('div');

  const recentCwds = () => [...new Set((entry.sessions || [])
    .filter(s2 => !s2.archived)
    .filter(s2 => !(entry.facts?.caden_home && s2.cwd.startsWith(entry.facts.caden_home)))
    .sort((a, b) => b.updated_at - a.updated_at)
    .map(s2 => s2.cwd))].slice(0, 5);

  const startSession = async (text, images, { stay = false } = {}) => {
    try {
      const session = await entry.api.createSession(Object.assign({
        title: '', engine: engineOf(model.proto), model: model.modelID,
        model_label: model.name || model.modelID,
        provider: providerFor(model),
        cwd: d.cwd, create_cwd: true,
        permission_mode: d.permissionMode,
        effort: d.effort,
        fast: d.fast || undefined,
        context_window: model.contextWindow || undefined,
        message: text,
        images: images && images.length ? images : undefined,
      }, credentialFor(model)));
      await refreshSessions();
      if (stay) renderSidebar();
      else select(session.id, serverId);
    } catch (e) {
      errBox.replaceChildren(el('div', { class: 'error-block' },
        el('span', { class: 'sign' }, cIcon('exclamation-triangle', 12)),
        String(e.message || e)));
    }
  };

  const prompt = buildPromptInput({
    root: page.querySelector('.composer'),
    // The new-session draft already outlives this view (workspace, model,
    // permission); the message it is being written for belongs with them.
    draft: d,
    placeholder: 'Describe the task…',
    modelLabel: model.name || model.modelID,
    isRunning: () => false,
    onInterrupt: () => {},
    onSend: (text, images) => startSession(text, images),
    onShiftTab: () => {
      d.permissionMode = d.permissionMode === 'plan' ? 'bypassPermissions' : 'plan';
      d.permissionModeChosen = true;
      renderMain();
    },
    // Attachments only: the workspace chip above the composer already owns the
    // working directory, and permissions moved to a chip of their own.
    onPlusMenu: plus => attachFiles(entry, prompt, plus),
    onPasteOther: (file, name) => uploadPastedFile(entry, prompt, file, name),
    permission: {
      title: 'What the agent may do',
      label: () => permLabel(d.permissionMode),
      onMenu: anchor => openMenu(anchor, PERMISSIONS.map(pm => ({
        label: pm.label, checked: pm.value === d.permissionMode,
        action: () => { d.permissionMode = pm.value;
                        d.permissionModeChosen = true; renderMain(); },
      }))),
    },
    onModelMenu: anchor => openMenu(anchor,
      modelMenuItems(m => {
        d.modelId = m.id;
        renderMain();
      }, model.modelID)),
    effort: {
      label: () => effortLabel(d.effort),
      onMenu: anchor => openMenu(anchor, EFFORTS.map(x => ({
        label: x.label, checked: d.effort === x.value,
        action: () => { d.effort = x.value; renderMain(); },
      }))),
    },
    fast: fastCapable(model) ? {
      title: 'Codex fast tier — 1.5x speed, more usage',
      label: () => 'Fast',
      on: () => !!d.fast,
      onToggle: () => { d.fast = !d.fast; renderMain(); },
    } : null,
  });

  // The two selects above the composer: workspace and machine.
  const [repoBtn, machineBtn] = page.querySelectorAll('.select-trigger');
  if (repoBtn) {
    const label = repoBtn.querySelector('span');
    label.textContent = basename(d.cwd) || '~';
    repoBtn.title = d.cwd;
    repoBtn.addEventListener('click', () => openMenu(repoBtn, [
      ...recentCwds().map(pth => ({ label: shortPath(pth), checked: pth === d.cwd,
                                    action: () => { d.cwd = pth; renderMain(); } })),
      { label: `Browse ${entry.profile.name}…`,
        action: () => browseDirectory(entry.api, d.cwd,
                                    pth => { d.cwd = pth; renderMain(); }) },
    ]));
  }
  if (machineBtn) {
    const label = machineBtn.querySelector('span');
    label.textContent = entry.profile.name;
    machineBtn.addEventListener('click', () => openMenu(machineBtn,
      online.map(([id, e2]) => ({
        label: e2.profile.name, checked: id === serverId,
        action: () => { state.selectedServerId = id; renderMain(); },
      }))));
  }

  page.querySelector('.composer')?.after(errBox);

  $main.replaceChildren(bareTopbar(), page);
  setTimeout(() => prompt.focus(), 0);
}

// ---- panes

/// Paint a full-width pane, keeping the reader where they were.
///
/// These panes repaint wholesale -- the Servers one does it again for every
/// ssh probe that lands, seconds after it was opened -- and a fresh scroller
/// starts at the top, which yanks you back up mid-read. Carrying the offset
/// across the swap makes a background refresh invisible instead of rude.
function paintPane(title, inner) {
  const prev = $main.querySelector('.pane-scroll');
  const top = prev ? prev.scrollTop : 0;
  const scroller = el('div', { class: 'pane-scroll' }, inner);
  $main.replaceChildren(paneHeader(title), scroller);
  if (top) {
    scroller.scrollHeight;          // force layout, or the assignment clamps to 0
    scroller.scrollTop = top;
  }
}

function paneHeader(title) {
  return el('div', { class: 'header' },
    collapsedStrip(),
    el('button', { class: 'icon-btn', title: 'Back — esc',
                   onclick: () => { state.pane = null; renderSidebar(); renderMain(); } },
      icon('chevL', 12)),
    el('span', { class: 'title' }, title));
}

const PROTOCOLS = [
  { value: 'anthropic-messages', label: 'Anthropic · Claude Code' },
  { value: 'openai-responses', label: 'OpenAI Responses · Codex' },
  { value: 'openai-chat', label: 'OpenAI Chat · Codex' },
];

/// Swap a slot's content for an input; Enter/blur commits, Esc restores.
function inlineEdit(slot, { value = '', placeholder = '', mono = false,
                            onCommit, onCancel = renderModelsPane }) {
  const input = el('input', { class: 'inline-edit' + (mono ? ' mono' : ''),
                              value, placeholder, spellcheck: 'false' });
  let settled = false;
  // Typing outranks anything arriving in the background. The sidebar repaints
  // on a 6s poll and on every session change, which used to delete the field
  // mid-rename -- the model answering a question is not a reason to take the
  // keyboard away from someone.
  state.editing = true;
  const done = ok => {
    if (settled) return;
    settled = true;
    state.editing = false;
    if (ok) onCommit(input.value.trim());
    else onCancel();
    if (state.sidebarStale) { state.sidebarStale = false; renderSidebar(); }
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    else if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
  slot.replaceChildren(input);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

async function fetchProviderModels(p, anchor, commit) {
  let data;
  try {
    // An unsaved, typed key goes inline so it can be tested before saving;
    // a saved one is referenced -- the renderer does not hold it.
    const res = await fetch('/host/provider-models', {
      method: 'POST',
      body: JSON.stringify(p.apiKey
        ? { base_url: p.baseURL, api_key: p.apiKey, headers: p.headers || {} }
        : { provider_id: p.id }),
    });
    data = await res.json();
  } catch (e) { data = { error: String(e.message || e) }; }
  if (data.error || !data.models) {
    openMenu(anchor, [{ section: 'Fetch failed' }, { label: data.error || 'no models' }]);
    return;
  }
  const have = () => new Set((p.models || []).map(m => m.modelID));
  openMenu(anchor, [
    { section: `${data.models.length} models · click to add` },
    ...data.models.map(id => ({
      label: id, checked: have().has(id),
      action: () => {
        if (have().has(id)) p.models = p.models.filter(m => m.modelID !== id);
        else (p.models = p.models || []).push(
          { id: newId(), modelID: id, alias: id, contextWindow: 200000 });
        commit();
      },
    })),
  ]);
}

function providerSection(p, provs, commit) {
  // -- title block, outside the card (Cursor settings rhythm)
  const nameEl = el('span', { class: 'prov-name' }, p.name || 'Provider');
  nameEl.title = 'Rename provider';
  nameEl.onclick = () => inlineEdit(nameEl, { value: p.name || '',
    placeholder: 'Provider name',
    onCommit: v => { p.name = v || p.name; commit(); } });

  const urlEl = el('span', { class: 'prov-url' },
    p.baseURL || 'No base URL — uses the engine login on the server');
  urlEl.title = 'Set base URL';
  urlEl.onclick = () => inlineEdit(urlEl, { value: p.baseURL || '',
    placeholder: 'https://api.example.com', mono: true,
    onCommit: v => { p.baseURL = v; commit(); } });

  const protoBtn = el('button', { class: 'prov-proto' },
    (PROTOCOLS.find(x => x.value === p.proto) || PROTOCOLS[0]).label.split(' · ')[0],
    el('span', { class: 'cd' }, '▾'));
  protoBtn.onclick = () => openMenu(protoBtn, PROTOCOLS.map(x => ({
    label: x.label, checked: x.value === p.proto,
    action: () => { p.proto = x.value; commit(); } })));

  const more = el('button', { class: 'prov-act', title: 'Provider options' },
    cIcon('sliders', 13));
  more.onclick = e => openMenu(e.currentTarget, [
    { label: (p.hasKey || p.apiKey) ? 'Change API key…' : 'Set API key…', action: () => {
        // The saved value is never shown: type to replace, leave empty to keep.
        inlineEdit(urlEl, { value: '',
          placeholder: p.hasKey ? 'saved — type to replace' : 'sk-…', mono: true,
          onCommit: v => { p.apiKey = v; commit(); } });
      } },
    ...(p.hasKey
      ? [{ label: 'Remove API key', action: () => { p.apiKey = null; commit(); } }]
      : []),
    '-',
    { label: 'Delete provider', action: () => {
        provs.splice(provs.indexOf(p), 1);
        commit();
      } },
  ]);

  const title = el('div', { class: 'prov-title-row' },
    el('div', { class: 'prov-id' }, nameEl, urlEl),
    el('div', { class: 'prov-acts' }, protoBtn, more));

  // -- card: model rows only, airy two-line rows
  const card = el('div', { class: 'prov-card' });
  for (const m of (p.models || [])) {
    const alias = el('div', { class: 'm-alias' }, m.alias || m.modelID);
    alias.title = 'Rename alias';
    alias.onclick = () => inlineEdit(alias, { value: m.alias || '',
      placeholder: m.modelID,
      onCommit: v => { m.alias = v || m.modelID; commit(); } });

    const idEl = el('div', { class: 'm-id' }, m.modelID);

    const ctx = el('button', { class: 'ctx-pill', title: 'Context window — click to edit' },
      `${fmtWindow(m.contextWindow || 200000)} context`);
    ctx.onclick = () => inlineEdit(ctx, {
      value: String(m.contextWindow || 200000), mono: true,
      onCommit: v => {
        const n = parseInt(v.replace(/[km]$/i,
          x => x.toLowerCase() === 'k' ? '000' : '000000'), 10);
        if (n > 0) m.contextWindow = n;
        commit();
      } });

    const del = el('button', { class: 'prov-act', title: 'Remove model' },
      cIcon('trash', 13));
    del.onclick = () => { p.models = p.models.filter(x => x !== m); commit(); };

    card.append(el('div', { class: 'prov-row' },
      el('div', { class: 'm-text' }, alias, idEl),
      ctx, del));
  }
  if (!(p.models || []).length) {
    card.append(el('div', { class: 'prov-empty' },
      'No models yet — fetch them from the provider, or add one by id.'));
  }

  // -- card footer: labeled ghost actions
  const foot = el('div', { class: 'prov-foot' });
  const ghost = (icon, label, fn) => {
    const b = el('button', { class: 'ghost-btn' }, cIcon(icon, 12), label);
    b.onclick = fn;
    return b;
  };
  foot.append(ghost('plus', 'Add model', () => {
    const slot = el('div', { class: 'prov-row' });
    card.append(slot);
    inlineEdit(slot, { placeholder: 'model id — e.g. claude-opus-4-5', mono: true,
      onCommit: v => {
        if (v) (p.models = p.models || []).push(
          { id: newId(), modelID: v, alias: v, contextWindow: 200000 });
        commit();
      } });
  }));
  if (p.baseURL) {
    foot.append(ghost('globe', 'Fetch from provider',
      e => fetchProviderModels(p, e.currentTarget, commit)));
  }
  card.append(foot);

  return el('div', { class: 'prov-section' }, title, card);
}

// ---------------------------------------------------------------- servers pane

/// Re-read the app config and reconcile the live server map with it.
async function reloadServers() {
  state.config = await hostConfig();
  const ids = new Set(state.config.servers.map(s => s.id));
  for (const id of [...state.servers.keys()]) if (!ids.has(id)) state.servers.delete(id);
  for (const profile of state.config.servers) {
    const existing = state.servers.get(profile.id);
    if (existing) {
      existing.profile = profile;
      // A server that just finished setting up is still marked offline from
      // the last attempt; nothing else would ever reconnect it.
      if (existing.status !== 'online' && existing.status !== 'connecting') {
        connectServer(existing);
      }
      continue;
    }
    const entry = { profile, api: new DaemonAPI(profile.id), status: 'offline', sessions: [] };
    state.servers.set(profile.id, entry);
    connectServer(entry);
  }
  renderSidebar();
}

const setBusy = (id, text) => {
  if (text) state.serverBusy.set(id, text); else state.serverBusy.delete(id);
  renderServersPane();
};

/// The configured default, unless the server it would run on cannot take it.
///
/// Claude Code refuses Full access under a uid of 0, so on a daemon running
/// as root the configured default is a refusal on every new session. A
/// refusal is the right answer to an explicit choice and the wrong one to a
/// default nobody made, so the default steps down. Choosing Full access by
/// hand still gets the explanation.
///
/// From `facts`, which is the daemon's own /v1/health and is fetched when the
/// server connects -- the readiness report is only gathered when the Servers
/// pane is open, and the composer needs an answer before that.
function defaultPermissionFor(entry) {
  const want = state.config.defaults.permissionMode || 'bypassPermissions';
  if (want !== 'bypassPermissions') return want;
  return entry?.facts?.root ? 'acceptEdits' : want;
}

/// The same report, assembled from the daemon instead of from a host.
///
/// /host/servers/<id>/status is the Mac answering questions it is uniquely
/// able to answer -- is the forward up, does the keychain have a token. None
/// of that exists behind a proxy, but most of what the pane shows does: the
/// daemon knows its own version and which engines it has, and the fact that it
/// answered at all is the liveness the host was reporting second-hand.
///
/// A forward is not a thing here, so `tunnel` is absent rather than false, and
/// nothing offers to close one. The token is the proxy's business and it
/// clearly worked, or none of this would have come back.
async function statusFromDaemon(entry) {
  const [health, engines] = await Promise.all([
    entry.api.health(),
    entry.api.engines({ latest: true }).catch(() => null),
  ]);
  return {
    daemon: true,
    token: true,
    // Claude Code will not run Full access here, so the composer must not
    // offer it as the default it never asked anyone about.
    root: !!health?.root,
    daemonVersion: health?.version || null,
    daemonRevision: health?.revision || null,
    engines: {
      claude: engines?.engines?.claude || { installed: false },
      codex: engines?.engines?.codex || { installed: false },
    },
    arch: engines?.arch,
    libc: engines?.libc,
    ready: !!(engines?.engines?.claude?.installed
              || engines?.engines?.codex?.installed),
  };
}

async function checkServer(id, { attempt = 0 } = {}) {
  const entry = state.servers.get(id);
  try {
    state.serverStatus.set(id, can('servers') || !entry
      ? await serverStatus(id)
      : await statusFromDaemon(entry));
  } catch (e) { state.serverStatus.set(id, { error: String(e.message || e) }); }
  renderServersPane();

  // The upstream version check runs in the background on the server and its
  // cache is empty after a restart, so the first status comes back before the
  // answer does. Without a second look the pane sits on "unknown" -- which
  // shows an Update button for an engine that is already current, until
  // someone happens to press Check again. Bounded, and only while the pane
  // that would show the result is open.
  const st = state.serverStatus.get(id);
  const pending = st?.daemon && ['claude', 'codex'].some(
    k => st.engines?.[k]?.installed && st.engines[k].latest_state === 'pending');
  // Long enough for the slowest path that still resolves: the daemon's own
  // lookup has to time out (20s) before this Mac takes over on its behalf,
  // which measured ~16s end to end. The old 9s window gave up mid-way and
  // left the row looking unresolved after every daemon restart.
  if (pending && attempt < 8 && state.pane === 'servers') {
    setTimeout(() => checkServer(id, { attempt: attempt + 1 }), 4000);
  }
}

/// Do whatever this server needs next, in the order the steps depend on each
/// other: the daemon is installed over ssh, and only then can the forward carry
/// HTTP to it.
async function setUpServer(profile, { restart = false } = {}) {
  const st = state.serverStatus.get(profile.id) || {};
  try {
    if (restart || !st.daemon || !st.token) {
      setBusy(profile.id, restart ? 'upgrading the daemon…'
                                  : 'installing the daemon over ssh…');
      const { result } = await provision(profile.id, { restart }, text => {
        setBusy(profile.id, text);
      });
      setBusy(profile.id, `heartbeat ${result.version || ''} on ${result.hostname}`);
    }
    if (profile.mode === 'tunnel') {
      setBusy(profile.id, 'opening the forward…');
      await startTunnel(profile.id);
    }
  } catch (e) {
    // Re-check rather than leaving the pre-action reading on screen: half the
    // steps may well have landed, and stale rows next to an error read as if
    // nothing worked.
    state.serverBusy.delete(profile.id);
    await checkServer(profile.id);
    const now = state.serverStatus.get(profile.id) || {};
    state.serverStatus.set(profile.id, { ...now, error: String(e.message || e) });
    renderServersPane();
    return;
  }
  setBusy(profile.id, null);
  await checkServer(profile.id);
  await reloadServers();
  // reloadServers only reconnects what is not already online; make sure the
  // server we just set up is the one that gets it.
  const entry = state.servers.get(profile.id);
  if (entry && entry.status !== 'online') await connectServer(entry);
  renderServersPane();
}

async function installEngineOn(profile, engine) {
  const api = state.servers.get(profile.id)?.api || new DaemonAPI(profile.id);
  setBusy(profile.id, `installing ${engine}…`);
  let failure = null;
  try {
    const job = await api.installEngine(engine);
    let finished = false;
    const stream = api.jobStream(job.id, ev => {
      if (ev.type === 'step' && ev.text) setBusy(profile.id, ev.text);
      if (ev.type === 'done') {
        finished = true;
        if (!ev.ok) failure = ev.error || `${engine} install failed`;
        // Terminal event. Stop reading rather than waiting for the stream to
        // time out on its own.
        stream?.controller.abort();
      }
    });
    try {
      await stream.done;
    } catch (e) {
      // An abort we asked for is how a finished install ends, not a failure.
      if (!finished) throw e;
    }
  } catch (e) {
    failure = String(e.message || e);
  }

  // The server could not fetch it. Try again with this Mac as the transport:
  // it downloads the build and pushes it up the chunked upload path, which is
  // the same route the offline install has always taken -- it just used to
  // need someone to drive it by hand.
  if (failure) {
    setBusy(profile.id, 'server could not download it — fetching through this Mac…');
    try {
      await installViaHost(profile.id, engine, t => setBusy(profile.id, t));
      failure = null;
    } catch (e) {
      failure += `\nfallback through this Mac also failed: ${String(e.message || e)}`;
    }
  }
  setBusy(profile.id, null);
  // Re-check first, then put the failure back on top of the fresh status.
  // The other order loses it: checkServer replaces the whole status object,
  // so the reason flashed for one frame and the row looked untouched -- an
  // install that failed was indistinguishable from a button that did nothing.
  await checkServer(profile.id);
  if (failure) {
    state.serverStatus.set(profile.id,
      { ...(state.serverStatus.get(profile.id) || {}), error: failure });
    renderServersPane();
  }
}

const MARK_GLYPH = { ok: '✓', bad: '✗', warn: '!' };
const srvLine = (mark, label, detail, action) =>
  el('div', { class: 'srv-line' },
    el('span', { class: `srv-mark ${mark}` }, MARK_GLYPH[mark] || '·'),
    el('span', { class: 'srv-label' }, label),
    el('span', { class: 'srv-detail' }, detail || ''),
    action || null);

const srvBtn = (label, onclick, extra) => {
  const b = el('button', { class: `srv-btn${extra ? ' ' + extra : ''}` }, label);
  b.onclick = onclick;
  return b;
};

function serverSection(profile) {
  const st = state.serverStatus.get(profile.id);
  const busy = state.serverBusy.get(profile.id);
  const tunnelMode = profile.mode === 'tunnel';

  const name = el('span', { class: 'prov-name' }, profile.name || profile.host);
  const where = tunnelMode
    ? `ssh ${profile.host} · 127.0.0.1:${profile.localPort} → :${profile.remotePort}`
    : 'direct HTTP';
  const acts = el('div', { class: 'prov-acts' });

  if (!busy) {
    const needsWork = !st || !st.daemon || !st.token || (tunnelMode && !st.tunnel);
    // Both of these are ssh from this Mac. Without it the row still reports
    // what it found -- which is the useful half -- but offers nothing it
    // cannot do.
    if (needsWork && can('provisioning'))
      acts.append(srvBtn('Set up', () => setUpServer(profile)));
    else if (tunnelMode && !needsWork && can('tunnels'))
      acts.append(srvBtn('Close forward', async () => {
        await stopTunnel(profile.id); await checkServer(profile.id);
      }));
    const more = el('button', { class: 'prov-act', title: 'Server options' }, cIcon('sliders', 13));
    more.onclick = e => openMenu(e.currentTarget, [
      { label: 'Check again', action: () => checkServer(profile.id) },
      { label: 'Reconnect', action: async () => {
          const entry = state.servers.get(profile.id);
          if (entry) await connectServer(entry);
          await checkServer(profile.id);
        } },
      ...(can('provisioning')
        ? [{ label: 'Upgrade the daemon',
             action: () => setUpServer(profile, { restart: true }) }]
        : []),
      // The row's button disappears once an engine is current; reinstalling is
      // still worth reaching for -- a broken install, or taking over a copy
      // that lives outside Caden.
      { label: 'Reinstall Claude Code', action: () => installEngineOn(profile, 'claude') },
      { label: 'Reinstall Codex', action: () => installEngineOn(profile, 'codex') },
      ...(can('servers')
        ? ['-',
           { label: 'Remove server', action: async () => {
               await removeServer(profile.id);
               state.serverStatus.delete(profile.id);
               await reloadServers();
               state.sshHosts = await sshHosts();
               renderServersPane();
             } }]
        : []),
    ]);
    acts.append(more);
  }

  const card = el('div', { class: 'prov-card' });
  if (busy) {
    card.append(srvLine('busy', busy, ''));
  } else if (!st) {
    card.append(srvLine('busy', 'Checking…', ''));
  } else {
    if (tunnelMode) {
      card.append(srvLine(st.ssh ? 'ok' : 'bad', 'SSH',
                          st.ssh ? `reachable as ${profile.host}` : (st.sshError || 'unreachable')));
    }
    // An out-of-date daemon is not a failure state -- it answers, it serves
    // sessions -- but anything added on the daemon side since it was
    // installed silently does nothing, so it gets said out loud here.
    card.append(st.daemonStale
      ? srvLine('warn', 'Daemon', 'older than this app — newer features do nothing',
                srvBtn('Upgrade', () => setUpServer(profile, { restart: true })))
      : srvLine(st.daemon ? 'ok' : 'bad', 'Daemon',
                st.daemon ? `heartbeat ${st.daemonVersion || ''}`
                          : (st.provisioned ? 'installed but not answering' : 'not installed')));
    if (tunnelMode) {
      card.append(srvLine(st.tunnel ? 'ok' : 'bad', 'Forward',
                          st.tunnel ? `127.0.0.1:${profile.localPort} is open` : 'closed'));
    }
    // How the daemon comes back after a crash or reboot. Older provisions
    // predate supervision and say nothing.
    if (profile.supervisor === 'systemd' || profile.supervisor === 'cron') {
      card.append(srvLine('ok', 'Supervisor',
        profile.supervisor === 'systemd' ? 'systemd user service' : 'cron watchdog'));
    } else if (profile.supervisor === 'none') {
      card.append(srvLine('warn', 'Supervisor',
        'not available — daemon will not restart automatically'));
    }
    for (const [key, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
      const info = st.engines?.[key];
      const ready = !!info?.installed;
      // Installing over an existing engine is how it gets updated: the job
      // resolves the latest build for this host's os/arch/libc and replaces
      // what is there. Same call either way, so the button just changes name.
      // Three states, and `update_available === false` is the one that earns
      // silence: we checked, it is current, so there is nothing to offer. A
      // button that does nothing is noise. Unknown (null -- the check has not
      // landed, or the box cannot reach the registry) still offers it, since
      // hiding it there would strand the machines that can never check.
      // Reinstalling a current engine stays available on the ⋯ menu.
      // `pending` is not "unknown", it is "about to be known": the check
      // always resolves, and offering Reinstall in the meantime made a button
      // appear for a few seconds after every daemon restart and then vanish.
      const settling = ready && info.latest_state === 'pending';
      const upToDate = ready && (info.update_available === false || settling);
      // "Update" claims an update exists. When the check has not landed -- or
      // never will, on a box that cannot reach the release source -- the
      // honest word for the same action is "Reinstall".
      const verb = !ready ? 'Install'
        : info.update_available ? 'Update' : 'Reinstall';
      const act = (st.daemon && st.token && !upToDate)
        ? srvBtn(verb, () => installEngineOn(profile, key))
        : null;
      if (act && info?.update_available) act.classList.add('accent');
      if (act && ready) {
        // A binary Caden did not install lives outside $CADEN_HOME, and updating
        // it means installing Caden's own copy that sessions will then resolve
        // first. Worth saying before the click, not after.
        act.title = info.managed
          ? 'Install the latest build into ~/.caden'
          : `Currently using ${info.path || 'a copy on PATH'} — updating installs `
            + "Caden's own copy, which sessions will use instead";
      }
      // Three ways to end up not knowing, and they are not the same problem.
      // They all used to surface as a bare `Reinstall`, which left the reader
      // guessing whether an update existed, whether the box could look, or
      // whether Caden could even ask.
      // `info?`, like every other read of it here: a server with no token, or
      // one whose daemon is not answering, has no engines block at all, and
      // this threw on it. The throw came out of the render, so the pane it was
      // painting stayed on "Checking…" for every server, for good -- which is
      // exactly what a fresh install looks like before anything is set up.
      const why = info?.latest_state === undefined ? ' · daemon too old to check'
        : info.latest_state === 'unreachable' ? ' · cannot reach the release source'
        : info.latest_state === 'host' ? ' · checked from this Mac'
        : '';                                    // `pending` settles on its own
      const detail = ready
        ? (info.version || 'installed')
          + (info.update_available ? ` → ${info.latest}` : '')
          + why
          + (info.managed ? '' : ' · outside Caden')
        : (st.daemon ? 'not installed' : 'unknown until the daemon answers');
      card.append(srvLine(ready ? 'ok' : 'bad', label, detail, act));
    }
    if (st.error) card.append(el('div', { class: 'srv-error' }, st.error));
    card.append(el('div', { class: `srv-verdict ${st.ready ? 'ok' : ''}` },
      st.ready ? 'Ready — you can start a session on this server.'
               : 'Not ready yet.'));
  }

  return el('div', { class: 'prov-section' },
    el('div', { class: 'prov-title-row' },
      el('div', { class: 'prov-id' }, name, el('span', { class: 'prov-url' }, where)),
      acts),
    card);
}

function sshHostSection() {
  const rows = el('div', { class: 'prov-card' });
  const candidates = state.sshHosts.filter(h => !h.added);
  if (!candidates.length) {
    rows.append(srvLine('busy', 'Nothing left to add', 'every host in ~/.ssh/config is already here'));
  }
  for (const h of candidates) {
    const add = srvBtn('Add', async () => {
      await addServer(h.host);
      state.sshHosts = await sshHosts();
      await reloadServers();
      renderServersPane();
      const added = state.config.servers.find(s => s.host === h.host);
      if (added) checkServer(added.id);
    });
    rows.append(srvLine('none', h.host, h.hostName || '', add));
  }
  return el('div', { class: 'prov-section' },
    el('div', { class: 'prov-title-row' },
      el('div', { class: 'prov-id' },
        el('span', { class: 'prov-name' }, 'From your SSH config'),
        el('span', { class: 'prov-url' }, '~/.ssh/config'))),
    rows);
}

function renderServersPane() {
  // Reached from ssh probes and status checks that finish seconds after they
  // were started. By then the user may have moved to another pane, and
  // painting into $main here would drag them back to this one.
  if (state.pane !== 'servers') return;
  const body = el('div', { class: 'models-pane' },
    el('div', { class: 'pane-intro' },
      el('div', { class: 'pane-intro-title' }, 'Servers'),
      el('div', { class: 'pane-intro-sub' },
        // Two different truths. Told from the desktop app this pane is where
        // servers get added and set up; served from a daemon behind a proxy
        // none of that is on offer, and describing it anyway sends someone
        // hunting for a button that was deliberately not drawn.
        can('servers')
          ? 'A server runs the agents. Add one, install the daemon over ssh, and '
            + 'Caden reaches it through a local forward.'
          : 'A server runs the agents. This console reaches them through the '
            + 'proxy that served it; adding and setting up servers is done '
            + 'from the desktop app.')));

  for (const profile of state.config.servers) body.append(serverSection(profile));
  if (can('servers')) body.append(sshHostSection());

  paintPane('Servers',
    el('div', { style: 'max-width:720px;margin:0 auto;padding:8px 32px 48px;width:100%' },
      body));
}

// ---------------------------------------------------------------- web pane
//
// The gateway is a reverse proxy in front of a daemon, and setting one up is
// four fiddly things -- a certificate, a password, an nginx block carrying a
// 44-character token, a ban rule -- of which exactly one is interesting. The
// pane does them; what it asks for is the three facts only a person knows.

function webField(label, value, hint, onPick) {
  const btn = el('button', { class: 'srv-btn', type: 'button' },
                 value || 'choose…');
  btn.addEventListener('click', e => onPick(e.currentTarget));
  return srvLine(value ? 'ok' : 'none', label, hint || '', btn);
}

async function webSet(patch) {
  state.web = { ...state.web, ...await saveWebSettings(patch) };
  renderWebPane();
  webStatus().then(w => { state.web = w; renderWebPane(); }).catch(() => {});
}

function renderWebPane() {
  if (state.pane !== 'web') return;
  const w = state.web;
  const body = el('div', { class: 'models-pane' },
    el('div', { class: 'pane-intro' },
      el('div', { class: 'pane-intro-title' }, 'Web'),
      el('div', { class: 'pane-intro-sub' },
        'Reach a server from a phone, with this Mac switched off. A proxy in '
        + 'front of the daemon holds the certificate and asks for the '
        + 'password.')));

  if (!w) {
    body.append(el('div', { class: 'prov-card' }, srvLine('busy', 'Checking…', '')));
    return paintPane('Web',
      el('div', { style: 'max-width:720px;margin:0 auto;padding:8px 32px 48px;width:100%' },
         body));
  }
  if (w.error) {
    body.append(el('div', { class: 'prov-card' }, el('div', { class: 'srv-error' }, w.error)));
    return paintPane('Web',
      el('div', { style: 'max-width:720px;margin:0 auto;padding:8px 32px 48px;width:100%' },
         body));
  }

  // -- the three facts only a person knows -----------------------------
  const setup = el('div', { class: 'prov-card' });
  const hostInput = el('input', { class: 'inline-edit mono', spellcheck: 'false',
                                  placeholder: 'caden.example.net',
                                  style: 'min-width:180px' });
  hostInput.value = w.hostname || '';
  const commit = () => {
    if ((hostInput.value || '').trim() !== (w.hostname || ''))
      webSet({ hostname: hostInput.value });
  };
  hostInput.addEventListener('blur', commit);
  hostInput.addEventListener('keydown', e => { if (e.key === 'Enter') hostInput.blur(); });
  setup.append(srvLine(w.hostname ? 'ok' : 'none', 'Address',
                       'an A record for it, pointing at the proxy', hostInput));

  setup.append(webField('Proxy runs on', w.gatewayHost,
    'ssh as somebody who can write /etc/nginx', anchor =>
      openMenu(anchor, (w.sshHosts || []).map(h => ({
        label: h, checked: h === w.gatewayHost,
        action: () => webSet({ gatewayHost: h }),
      })))));

  const chosen = (w.servers || []).find(s => s.id === w.serverId);
  setup.append(webField('Console from', chosen && chosen.name,
    'the daemon whose copy of the console is served', anchor =>
      openMenu(anchor, (w.servers || []).map(s => ({
        label: s.name, checked: s.id === w.serverId,
        action: () => webSet({ serverId: s.id }),
      })))));
  body.append(el('div', { class: 'prov-section' },
    el('div', { class: 'prov-title-row' },
      el('div', { class: 'prov-id' },
        el('span', { class: 'prov-name' }, 'Settings'))), setup));

  // -- what is true right now ------------------------------------------
  const state_ = el('div', { class: 'prov-card' });
  const busy = state.webBusy;
  if (busy) {
    state_.append(srvLine('busy', busy, ''));
  } else {
    state_.append(srvLine(w.cert ? 'ok' : 'bad', 'Certificate',
      w.cert ? `expires ${w.cert}` : 'none yet — applying will ask for one'));
    state_.append(srvLine(w.passwordSet ? 'ok' : 'bad', 'Password',
      w.passwordSet ? 'set on the console daemon'
                    : 'not set — nobody can sign in until it is',
      srvBtn(w.passwordSet ? 'Change' : 'Set', () => webAskPassword())));
    const reach = w.reachable;
    state_.append(srvLine(reach === 302 || reach === 200 ? 'ok' : reach ? 'warn' : 'bad',
      'Address',
      reach === 302 ? 'answering, and asking to sign in'
        : reach === 200 ? 'answering'
        : reach ? `answering with ${reach}`
        : w.hostname ? 'no answer' : 'no address yet'));
    if (w.error) state_.append(el('div', { class: 'srv-error' }, w.error));
  }
  const acts = el('div', { class: 'prov-acts' });
  if (!busy) {
    acts.append(srvBtn(w.cert ? 'Apply' : 'Set up', () => webApply(), 'accent'));
    if (w.passwordSet) {
      acts.append(srvBtn('Sign out all browsers', async () => {
        try { await logoutBrowsers(); setWebBusy('signed everyone out'); }
        catch (e) { setWebBusy(String(e.message || e)); }
        setTimeout(() => setWebBusy(null), 2500);
      }));
    }
  }
  body.append(el('div', { class: 'prov-section' },
    el('div', { class: 'prov-title-row' },
      el('div', { class: 'prov-id' },
        el('span', { class: 'prov-name' }, 'Gateway'),
        el('span', { class: 'prov-url' }, w.hostname ? `https://${w.hostname}/` : '')),
      acts), state_));

  // -- which servers the phone can reach -------------------------------
  //
  // Every server this Mac knows is listed; being on the web is a decision
  // made here, one server at a time. Provisioning used to do it as a parting
  // errand, which meant setting up a machine reached out to a third host and
  // a gateway that was down turned into a warning on an operation that had
  // otherwise gone perfectly. Adding a server and publishing it are different
  // things to want.
  const reach = w.reach || {};
  const rows = el('div', { class: 'prov-card' });
  const listed = (w.servers || []).filter(s => reach[s.id] !== 'local');
  if (!listed.length) {
    rows.append(srvLine('busy', 'No servers yet', 'provision one and it appears here'));
  }
  for (const s of listed) {
    const how = reach[s.id];
    // Reachable or not. Which of the three things is holding the tunnel open
    // was drawn here for a while, as a third state for the one that had no
    // supervisor -- but that rung restarts itself now, so the distinction
    // stopped being one the reader has to act on, and a row that is up should
    // look like a row that is up.
    // `null` is the first pass answering from the config alone: this server
    // has a tunnel and whether it carries anything has not been asked yet.
    // Drawing that as "not on the web" would offer an Add button for a server
    // that is already on it, which is worse than saying nothing for a second.
    const asking = how == null;
    const mark = asking ? 'busy'
               : how === 'gateway' || how === 'tunnel' ? 'ok'
               : how === 'down' ? 'bad' : 'none';
    const detail = asking ? 'checking…'
      : how === 'gateway' ? 'its daemon is on the proxy itself'
      : how === 'tunnel' ? 'reached through the tunnel it opens'
      : how === 'down' ? 'has a tunnel, but nothing is answering on it'
      : 'not on the web — add it here';
    const act = (asking || how === 'gateway') ? null
      : srvBtn(how === 'none' ? 'Add' : 'Reconnect',
               () => webConnect(s.id, s.name),
               how === 'none' ? 'accent' : undefined);
    rows.append(srvLine(mark, s.name, detail, act));
    if (state.webRowError?.id === s.id) {
      rows.append(el('div', { class: 'srv-error' }, state.webRowError.message));
    }
  }
  body.append(el('div', { class: 'prov-section' },
    el('div', { class: 'prov-title-row' },
      el('div', { class: 'prov-id' },
        el('span', { class: 'prov-name' }, 'Servers on the web'),
        el('span', { class: 'prov-url' },
           'each one dials the proxy; the proxy never dials back'))),
    rows));

  paintPane('Web',
    el('div', { style: 'max-width:720px;margin:0 auto;padding:8px 32px 48px;width:100%' },
       body));
}

async function webConnect(serverId, name) {
  state.webRowError = null;
  setWebBusy(`connecting ${name}…`);
  try {
    await connectServerToWeb(serverId, text => setWebBusy(`${name}: ${text}`));
    state.web = await webStatus();
    setWebBusy(null);
  } catch (e) {
    // On its own row. Reported as the pane's error, one server that would not
    // connect took the address, the gateway and every other server off screen
    // with it -- and the pane is the place you would go to see whether the
    // rest of it is still fine.
    state.webRowError = { id: serverId, message: String(e.message || e) };
    setWebBusy(null);
  }
}

function setWebBusy(text) { state.webBusy = text; renderWebPane(); }

async function webApply() {
  setWebBusy('starting…');
  try {
    await applyWeb(text => setWebBusy(text));
    state.web = await webStatus();
    setWebBusy(null);
  } catch (e) {
    state.web = { ...state.web, error: String(e.message || e) };
    setWebBusy(null);
  }
}

/// Asked for in the pane rather than typed at a terminal, and sent straight
/// through -- it is never held in the config or the keychain, because the
/// only thing that needs it is the daemon it is being set on.
function webAskPassword() {
  const row = el('div', { class: 'prov-card' });
  const input = el('input', { class: 'inline-edit', type: 'password',
                              placeholder: 'at least 8 characters',
                              style: 'min-width:200px' });
  const save = srvBtn('Save', async () => {
    try {
      await setWebPassword(input.value);
      setWebBusy('password set — every browser signed out');
      state.web = await webStatus();
    } catch (e) { setWebBusy(String(e.message || e)); }
    setTimeout(() => setWebBusy(null), 2500);
  });
  row.append(srvLine('none', 'New password',
                     'changing it signs out every browser', el('div', {}, input, save)));
  const scroll = $main.querySelector('.pane-scroll .models-pane');
  if (scroll) scroll.append(row);
  input.focus();
}

function renderModelsPane() {
  if (state.pane !== 'models') return;      // same race, from `commit()`
  const provs = state.config.providers || (state.config.providers = []);
  const commit = async () => { await saveProviders(); renderModelsPane(); };

  const body = el('div', { class: 'models-pane' },
    el('div', { class: 'pane-intro' },
      el('div', { class: 'pane-intro-title' }, 'Models'),
      el('div', { class: 'pane-intro-sub' },
        'Providers group models behind one base URL and API key.')));

  for (const p of provs) body.append(providerSection(p, provs, commit));

  const add = el('button', { class: 'ghost-btn prov-add' },
    cIcon('plus', 12), 'Add provider');
  add.onclick = () => {
    provs.push({ id: newId(), name: 'New provider', baseURL: '', apiKey: '',
                 proto: 'anthropic-messages', headers: {}, models: [] });
    commit();
  };
  body.append(add);

  paintPane('Models',
    el('div', { style: 'max-width:720px;margin:0 auto;padding:8px 32px 48px;width:100%' },
      body));
}

async function renderDetailPane(sessionId) {
  const found = findSession(sessionId);
  if (!found) { state.pane = null; renderMain(); return; }
  const { entry, session } = found;

  const body = el('div', { style: 'max-width:680px;margin:0 auto;padding:14px 24px;width:100%' });
  const detail = (k, v, mono) => el('div', { style: 'display:flex;gap:10px;padding:3px 0;font-size:12px' },
    el('span', { style: 'width:110px;text-align:right;color:var(--text-3);flex:none' }, k),
    el('span', { style: `color:var(--text-2);user-select:text;${mono ? 'font-family:var(--font-mono)' : ''}` }, v));

  body.append(
    detail('Session', session.id, true),
    detail('Engine session', session.native_id || 'not started', true),
    detail('Engine', session.engine === 'codex' ? 'Codex' : 'Claude Code'),
    detail('Model', session.model || 'default'),
    detail('Working dir', session.cwd, true),
    detail('Permissions', permLabel(session.permission_mode)),
    detail('Turns', String(session.turns)),
    el('div', { class: 'section-head', style: 'padding-left:0;padding-top:16px' }, 'Engine stderr'),
  );
  const log = el('div', { class: 'mono-block', style: 'margin-left:0;max-height:340px' }, '…');
  body.append(log);
  $main.replaceChildren(paneHeader(session.title || 'Session'),
    el('div', { style: 'border-top:1px solid var(--hairline);flex:1;overflow-y:auto' }, body));

  try {
    const env = await entry.api.session(session.id, session.seq || 0);
    log.textContent = env.session.stderr_tail || '(empty)';
  } catch (e) { log.textContent = String(e.message || e); }
}

// ---------------------------------------------------------------- boot

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.pane) {
    state.pane = null; renderSidebar(); renderMain();
  }
  if (e.key === 'n' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); select(null); }
});

async function boot() {
  if (new URLSearchParams(location.search).get('host') === 'electron') {
    document.body.classList.add('electron');
  }
  await loadTemplates();
  state.config = await hostConfig();
  migrateLegacyModels();
  for (const profile of state.config.servers) {
    const entry = { profile, api: new DaemonAPI(profile.id),
                    status: 'offline', sessions: [] };
    state.servers.set(profile.id, entry);
  }
  state.selectedServerId = state.config.servers[0]?.id || null;
  renderSidebar();
  renderMain();
  for (const entry of state.servers.values()) connectServer(entry);
  setInterval(() => { refreshSessions(); superviseServers(); }, 6000);
  // A blocked tool produces no events, so nothing would repaint the elapsed
  // time it is showing. Tick only while one is actually running.
  setInterval(() => {
    const ctl = state.selectedSessionId
      && state.controllers.get(state.selectedSessionId);
    if (!ctl || state.editing) return;
    const tail = ctl.transcript.items[ctl.transcript.items.length - 1];
    if (tail && tail.kind === 'tool' && tail.tool?.running) ctl.notify();
  }, 3000);
}

boot();
