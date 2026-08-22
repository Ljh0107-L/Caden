// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Client-side checks: the daemon's HTTP + SSE surface, and the transcript
// reducer the renderer folds events with.
//
//   node tests/client-test.mjs --url http://127.0.0.1:7838 --token XXX
//
// Runs against the mock engine, so it needs no model credentials.
import { Transcript, visibleFrom } from '../app/web/transcript.js';
import { contextUsed, pctText, windowUsage } from '../app/web/util.js';
import { keyRoute, injectProviderKey } from '../app/secret-inject.js';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const arg = name => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const BASE = (arg('--url') || 'http://127.0.0.1:7838').replace(/\/$/, '');
const TOKEN = arg('--token') || '';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : {}];
};

/// Reads an SSE stream until `done(transcript)` or the timeout.
async function stream(path, onEvent, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let count = 0;
  try {
    const res = await fetch(`${BASE}/v1${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal,
    });
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        // `event: eof` ends a non-following stream; its trailing `data: {}`
        // is a marker, not an event, so stop before it is counted.
        if (line.startsWith('event:')) {
          if (line.slice(6).trim() === 'eof') return count;
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5).trim());
        count++;
        if (onEvent(ev) === false) return count;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return count;
}

// -- provider-key injection (pure function, no daemon) ------------------------
check('keyRoute: session create', keyRoute('POST', '/v1/sessions'));
check('keyRoute: provider switch', keyRoute('PATCH', '/v1/sessions/s123'));
check('keyRoute: not messages', !keyRoute('POST', '/v1/sessions/s123/messages'));
check('keyRoute: not the event stream', !keyRoute('GET', '/v1/sessions/s123/events'));
check('keyRoute: not the session list', !keyRoute('GET', '/v1/sessions'));
{
  const lookup = id => (id === 'prov-1' ? 'sk-secret' : null);
  let body = injectProviderKey(
    { model: 'm', key_ref: 'prov-1', provider: { protocol: 'anthropic-messages' } }, lookup);
  check('inject: key lands in provider.api_key', body.provider.api_key === 'sk-secret');
  check('inject: ref is stripped', body.key_ref === undefined);
  check('inject: other provider fields survive', body.provider.protocol === 'anthropic-messages');
  body = injectProviderKey({ key_ref: 'unknown' }, lookup);
  check('inject: unknown ref stripped, no key added',
        body.key_ref === undefined && !body.provider?.api_key);
  body = injectProviderKey({ model: 'm' }, lookup);
  check('inject: no ref is a no-op', body.model === 'm' && body.provider === undefined);
}

// -- health ------------------------------------------------------------------
const [hc, health] = await call('GET', '/health');
check('health', hc === 200 && !!health.version, `heartbeat ${health.version} on ${health.os}/${health.arch}`);

// -- create a mock session (no credentials involved) -------------------------
const [cc, created] = await call('POST', '/sessions', {
  engine: 'mock', model: 'mock-1', title: 'client-test',
  provider: { protocol: 'mock' },
});
check('create session', cc === 201, created.session?.id || JSON.stringify(created).slice(0, 80));
const sid = created.session?.id;
if (!sid) { console.log('\nFAILED early'); process.exit(1); }
check('engine routing', created.session.engine === 'mock', created.session.engine);

// -- one turn, folded live ---------------------------------------------------
await call('POST', `/sessions/${sid}/messages`, { text: 'hello from the client test' });
const live = new Transcript();
let ended = false;
// Read to the end of the turn *including* the status event the daemon writes
// after turn.end -- stopping at turn.end would leave a real event unread and
// make the cursor check below look like a repeat.
const seen = await stream(`/sessions/${sid}/events?after=0&follow=1`, ev => {
  live.apply(ev);
  if (ev.type === 'turn.end') ended = true;
  if (ended && ev.type === 'status' && ev.state !== 'running') return false;
});
check('sse events', seen > 0, `${seen} events`);

const kinds = live.items.map(i => i.kind);
check('transcript: user turn', kinds.includes('user'));
check('transcript: assistant text', kinds.includes('assistant'));
check('transcript: tool card', kinds.includes('tool'));
check('transcript: todo list', kinds.includes('todo'));
check('transcript: turn summary', kinds.includes('summary'));
// The mock emits one, so the whole daemon -> SSE -> reducer path is covered.
check('transcript: compaction notice',
      live.items.some(i => i.kind === 'notice' && /context compacted/.test(i.text)),
      JSON.stringify(live.items.filter(i => i.kind === 'notice').map(i => i.text)));

const assistant = live.items.filter(i => i.kind === 'assistant');
check('delta/final dedupe',
      assistant.some(i => i.text === 'Working on your request now.'),
      JSON.stringify(assistant.map(i => i.text)));
const tool = live.items.find(i => i.kind === 'tool')?.tool;
check('tool completion', tool && !tool.running && tool.output.trim() === 'caden',
      JSON.stringify(tool?.output));

// -- replay from a cold cursor rebuilds the same thing ------------------------
const [, full] = await call('GET', `/sessions/${sid}?after=0`);
check('full replay available', full.events.length >= seen, `${full.events.length} events`);
const [, none] = await call('GET', `/sessions/${sid}?after=${live.lastSeq}`);
check('cursor replay never repeats', none.events.length === 0, `${none.events.length} after seq ${live.lastSeq}`);

const cold = new Transcript();
for (const ev of full.events) cold.apply(ev);
check('replay rebuilds identical transcript',
      cold.items.length === live.items.length,
      `${cold.items.length} vs ${live.items.length}`);
check('replay converges with the live transcript',
      JSON.stringify(cold.items.map(i => [i.kind, i.text])) ===
      JSON.stringify(live.items.map(i => [i.kind, i.text])));

// -- tail: the cold-open window ------------------------------------------------
// A long session is opened on the last N events, walked back to a turn start
// so the window never begins mid-block; "Load earlier" is the full replay.
for (let i = 0; i < 25; i++) {
  await call('POST', `/sessions/${sid}/messages`, { text: `tail turn ${i}` });
}
let tailTurns = 0;
await stream(`/sessions/${sid}/events?after=${live.lastSeq}&follow=1`, ev => {
  if (ev.type === 'turn.end' && ++tailTurns >= 25) return false;
}, 60000);
check('tail: long session built', tailTurns >= 25, `${tailTurns} turns`);

const [, fullLog] = await call('GET', `/sessions/${sid}?after=0`);
check('tail: log is longer than the window', fullLog.events.length > 300,
      `${fullLog.events.length} events`);

const [tc, t300] = await call('GET', `/sessions/${sid}?tail=300`);
check('tail: answers with the truncated flag', tc === 200 && t300.truncated === true);
// The window starts at a turn boundary: `user` when it reaches the message,
// `turn.start` when it falls inside a stretch of queued turns (whose `user`
// events were all emitted at queue time). Either way, never mid-block.
check('tail: window starts at a turn boundary',
      ['user', 'turn.start'].includes(t300.events[0]?.type), t300.events[0]?.type);
check('tail: window reaches the end of the log',
      t300.events.at(-1)?.seq === fullLog.events.at(-1)?.seq);
check('tail: window is a suffix of the log', t300.events.every((ev, i) =>
  ev.seq === fullLog.events[fullLog.events.length - t300.events.length + i].seq));
// The property the boundary walk exists for: a fold of the window must not
// leave a block streaming forever -- every block in it is complete.
const tailFold = new Transcript();
for (const ev of t300.events) tailFold.apply(ev);
const streaming = tailFold.items.filter(i => i.streaming);
check('tail: no block streams forever', streaming.length === 0,
      streaming.map(i => i.id).join(','));

const [, tBig] = await call('GET', `/sessions/${sid}?tail=5000`);
check('tail: bigger than the log is not truncated',
      tBig.truncated === false && tBig.events.length === fullLog.events.length,
      `${tBig.events.length} vs ${fullLog.events.length}`);
const [tBad] = await call('GET', `/sessions/${sid}?tail=not-a-number`);
check('tail: garbage value is a clean default, not a 500', tBad === 200);

// The tail also streams as SSE, oldest first, with a meta event up front --
// the cold-open path, which folds progressively instead of waiting on the
// whole window.
let metaTruncated = null;
let streamCount = 0;
let streamLastSeq = 0;
await stream(`/sessions/${sid}/events?tail=300&follow=0`, ev => {
  if (ev.type === '__tail_meta__') { metaTruncated = ev.truncated; return; }
  streamCount++;
  streamLastSeq = ev.seq;
}, 30000);
check('tail stream: meta arrives up front, truncated', metaTruncated === true);
check('tail stream: events flow oldest first to the end',
      streamCount > 0 && streamLastSeq === fullLog.events.at(-1)?.seq,
      `${streamCount} events, last seq ${streamLastSeq} vs ${fullLog.events.at(-1)?.seq}`);
check('tail stream: same window as the JSON tail',
      streamCount === t300.events.length,
      `${streamCount} vs ${t300.events.length}`);

// -- compaction, the phase that reads as a hang ------------------------------
// Claude Code rewrites the conversation on its own when the window fills. It
// takes minutes and puts nothing else on the wire, so an unnamed one reads as
// a hang -- and the interrupt that follows throws all of it away.
{
  const tr = new Transcript();
  let seq = 0;
  const ev = o => tr.apply({ seq: ++seq, ts: 1000 * seq, turn: 't1', ...o });
  ev({ type: 'compaction', state: 'start' });
  check('compaction: the live phase is nameable', !!tr.compacting);
  check('compaction: no row while it runs', tr.items.length === 0);
  ev({ type: 'compaction', state: 'done', pre_tokens: 167529,
       post_tokens: 10690, duration_ms: 160460 });
  check('compaction: the phase ends with it', tr.compacting === null);
  check('compaction: what it cost lands in the transcript',
        tr.items.at(-1)?.text === 'context compacted · 167.5k → 10.7k in 2m 40s',
        tr.items.at(-1)?.text);

  // Codex hands over no token counts, only that it happened and how long it
  // took. The row has to read as a sentence either way.
  const bare = new Transcript();
  let sb = 0;
  const evb = o => bare.apply({ seq: ++sb, ts: 1000 * sb, turn: 't1', ...o });
  evb({ type: 'compaction', state: 'start', trigger: 'auto' });
  evb({ type: 'compaction', state: 'done', duration_ms: 42000 });
  check('compaction: a numberless one still reads',
        bare.items.at(-1)?.text === 'context compacted in 42.0s',
        bare.items.at(-1)?.text);

  const ab = new Transcript();
  let s2 = 0;
  const ev2 = o => ab.apply({ seq: ++s2, ts: 1000 * s2, turn: 't1', ...o });
  ev2({ type: 'compaction', state: 'start' });
  ev2({ type: 'compaction', state: 'aborted' });
  check('compaction: an interrupted one says the next turn pays again',
        ab.compacting === null && /starts it over/.test(ab.items.at(-1)?.text || ''),
        ab.items.at(-1)?.text);

  // A turn killed from outside never reaches the adapter, so nothing else
  // would take the session out of the compacting phase.
  const st = new Transcript();
  let s3 = 0;
  const ev3 = o => st.apply({ seq: ++s3, ts: 1000 * s3, turn: 't1', ...o });
  ev3({ type: 'compaction', state: 'start' });
  ev3({ type: 'turn.end', usage: {}, error: 'interrupted' });
  check('compaction: a forced turn end clears the phase', st.compacting === null);

  // How long it has been quiet is the whole question when nothing is moving.
  check('live clock: the transcript tracks when anything last arrived',
        tr.lastEventTs === 2000, String(tr.lastEventTs));
}

// -- protocol -> engine routing (the rule the product is built around) --------
const [, engines] = await call('GET', '/engines');
check('engine discovery', !!engines.engines, `arch ${engines.arch}, libc ${engines.libc}`);
const [, codexArtifacts] = await call('GET', '/engines/codex/artifacts');
const codexArtifact = codexArtifacts.artifacts?.[0] || {};
check('codex install prefers its npm platform package',
      codexArtifacts.artifacts?.length === 1
      && codexArtifact.npm === '@openai/codex'
      && /^linux-|^darwin-/.test(codexArtifact.npm_tag || ''),
      JSON.stringify(codexArtifact));
for (const [proto, want] of [['anthropic-messages', 'claude'],
                             ['openai-responses', 'codex'],
                             ['openai-chat', 'codex']]) {
  const [sc, made] = await call('POST', '/sessions', {
    model: 'x', provider: { protocol: proto, api_key: 'sk-test' },
  });
  check(`routing: ${proto} → ${want}`, sc === 201 && made.session.engine === want,
        made.session?.engine || made.error);
  if (made.session) await call('DELETE', `/sessions/${made.session.id}`);
}

// -- the window gauge tracks usage as it arrives -------------------------------
// It used to be read off the last turn summary, which meant it sat frozen for
// the length of a turn -- and for a turn the engine started on its own, which
// produces no summary at all, it never moved.
{
  const tr = new Transcript();
  let seq = 0;
  const ev = o => tr.apply({ seq: ++seq, ts: Date.now(), turn: 't1', ...o });
  check('gauge: nothing before any usage', tr.usage === null);
  ev({ type: 'usage', context_usage: { input_tokens: 5, cache_read_tokens: 20000 } });
  check('gauge: a mid-turn reading lands', contextUsed(tr.usage) === 20005);
  ev({ type: 'usage', context_usage: { input_tokens: 5, cache_read_tokens: 26000 } });
  check('gauge: it keeps moving', contextUsed(tr.usage) === 26005);
  ev({ type: 'turn.end',
       usage: { input_tokens: 5, cache_read_tokens: 26000, output_tokens: 900 },
       context_usage: { input_tokens: 5, cache_read_tokens: 26000, output_tokens: 900 } });
  check('gauge: turn.end supplies the real output count',
        contextUsed(tr.usage) === 26905);
  ev({ type: 'turn.end', error: 'boom', usage: {}, context_usage: {} });
  check('gauge: a failed turn does not blank it', contextUsed(tr.usage) === 26905);
}

// -- a queued message is shown where it runs, not where it was typed ----------
//
// It is sent while another turn is still going, so it lands above everything
// that turn goes on to say. Reading the transcript afterwards, the question
// appears to have been asked before the answers that preceded it.
{
  const tr = new Transcript();
  let seq = 0;
  const ev = o => tr.apply({ seq: ++seq, ts: Date.now(), ...o });
  ev({ type: 'user', turn: 'q1', text: 'my question', queued: true });
  ev({ type: 'queued', turn: 'q1' });
  ev({ type: 'text', turn: 'running', block: 'b1', text: 'still working' });
  check('queue: the notice is there while it waits',
        tr.items.some(i => i.kind === 'notice' && i.queuedTurn === 'q1'));
  check('queue: and the message sits where it was typed',
        tr.items[0].kind === 'user' && tr.items.at(-1).text === 'still working');

  ev({ type: 'turn.start', turn: 'q1' });
  check('queue: the notice goes when the turn begins',
        !tr.items.some(i => i.kind === 'notice'));
  check('queue: and the message moves to the end',
        tr.items.at(-1).kind === 'user' && tr.items.at(-1).text === 'my question');
  check('queue: nothing else was lost',
        tr.items.length === 2 && tr.items[0].text === 'still working');

  ev({ type: 'text', turn: 'q1', block: 'b2', text: 'the answer' });
  check('queue: the reply lands after it, not on top of it',
        tr.items.at(-1).text === 'the answer');
}

// -- clearing the view hides history without losing it -------------------------
//
// A view cursor, not a delete: the server keeps every event, so the only way
// this can go wrong is by resolving to nothing and showing an empty window.
{
  const items = [
    { id: 'a', kind: 'user' }, { id: 'b', kind: 'assistant' },
    { id: 'c', kind: 'user' }, { id: 'd', kind: 'assistant' },
  ];
  check('clear: no cursor shows everything',
        visibleFrom(items, null).items.length === 4);

  const v = visibleFrom(items, 'c');
  check('clear: the view starts at the cursor', v.items[0].id === 'c');
  check('clear: and says how much it hid', v.hidden === 2 && v.items.length === 2);

  check('clear: a cursor at the top hides nothing',
        visibleFrom(items, 'a').hidden === 0);

  // The queued-message move renames nothing but reorders, and a replay from a
  // cold start may not carry the item at all.
  const gone = visibleFrom(items, 'zzz');
  check('clear: an id that is not there shows everything',
        gone.items.length === 4 && gone.hidden === 0);
  check('clear: and reports itself spent so it stops being applied',
        gone.stale === true);
}

// -- background work is session state too --------------------------------------
//
// Claude can leave a command running past the turn that started it and wake
// itself when it finishes. An idle session with a job pending is not a
// finished one, and the wake-up that follows needs a reason on screen.
{
  const tr = new Transcript();
  let seq = 0;
  const ev = o => tr.apply({ seq: ++seq, ts: Date.now(), turn: 't1', ...o });
  check('tasks: nothing until the engine says so', tr.tasks === null);
  ev({ type: 'tasks', tasks: [{ id: 'b1', description: 'Poll E860' }] });
  check('tasks: a running job lands', tr.tasks.length === 1);
  check('tasks: it is not a chat line',
        !tr.items.some(i => i.text === 'Poll E860'));
  ev({ type: 'task', task_id: 'b1', status: 'completed',
       text: 'Background command "Poll E860" completed (exit code 0)' });
  check('tasks: but finishing is',
        tr.items.at(-1).kind === 'notice' && tr.items.at(-1).text.includes('exit code 0'));
  ev({ type: 'tasks', tasks: [] });
  check('tasks: the list empties', tr.tasks.length === 0);
  check('tasks: empty is not the same as never heard', tr.tasks !== null);
}

// -- goal and activity are session state, not chat lines -----------------------
{
  const tr = new Transcript();
  let seq = 0;
  const ev = o => tr.apply({ seq: ++seq, ts: Date.now(), turn: 't1', ...o });
  ev({ type: 'goal', goal: { objective: 'ship it', status: 'active',
                             tokens_used: 10, token_budget: 100 } });
  check('goal: kept as an object', tr.goal?.status === 'active', tr.goal?.objective);
  ev({ type: 'goal', goal: { objective: 'ship it', status: 'blocked',
                             tokens_used: 90, token_budget: 100 } });
  check('goal: a status change lands', tr.goal.status === 'blocked');
  ev({ type: 'goal', goal: null });
  check('goal: clearing empties it', tr.goal === null);

  ev({ type: 'activity', category: 'awaiting', detail: 'waiting on the build',
       needs_action: true });
  check('activity: recorded', tr.activity?.category === 'awaiting'
                              && tr.activity.needsAction === true);
  // A new turn supersedes where the last one left off.
  ev({ type: 'user', text: 'go on' });
  check('activity: a new turn clears it', tr.activity === null);
}

// -- a claude goal clears itself when the turn is allowed to end ---------------
{
  const tr = new Transcript();
  let seq = 0;
  const ev = o => tr.apply({ seq: ++seq, ts: Date.now(), turn: 't1', ...o });
  ev({ type: 'goal', goal: { objective: 'until hello.txt exists', status: 'set' } });
  check('stop-goal: set', tr.goal?.status === 'set');
  ev({ type: 'goal', goal: { objective: 'until hello.txt exists',
                             status: 'hook error' } });
  check('stop-goal: an unevaluable condition shows as such',
        tr.goal.status === 'hook error');
  ev({ type: 'goal', goal: null });
  check('stop-goal: cleared only when asked', tr.goal === null);
}

// -- is the tail still moving? -------------------------------------------------
// The running indicator keys off this. A block keeps its kind after it stops
// arriving, so without `streaming` a finished paragraph passed for activity
// and the indicator vanished mid-turn -- which reads as "it stopped".
{
  const tr = new Transcript();
  let seq = 0;
  const ev = o => tr.apply({ seq: ++seq, ts: Date.now(), turn: 't1', ...o });
  ev({ type: 'turn.start' });
  ev({ type: 'text.delta', block: 'b1', text: 'half a ' });
  const mid = tr.items[tr.items.length - 1];
  check('tail: a streaming block is marked streaming',
        mid.kind === 'assistant' && mid.streaming === true);
  ev({ type: 'text', block: 'b1', text: 'half a sentence, finished.' });
  const done = tr.items[tr.items.length - 1];
  check('tail: the final event clears streaming',
        done.kind === 'assistant' && done.streaming === false, done.text);
  ev({ type: 'thinking.delta', block: 'r1', text: 'mm' });
  check('tail: reasoning streams the same way',
        tr.items[tr.items.length - 1].streaming === true);
  ev({ type: 'thinking', block: 'r1', text: 'mm hm' });
  check('tail: and settles the same way',
        tr.items[tr.items.length - 1].streaming === false);

  // A zeroed reading is worse than no reading. Codex's app-server publishes
  // one while it compacts, and it is an object, so a truthiness check let it
  // through and blanked a gauge over a window holding six hundred thousand
  // tokens: "0% full · ~0 / 631K".
  ev({ type: 'usage',
       context_usage: { input_tokens: 2684, output_tokens: 792,
                        cache_read_tokens: 602880, cache_write_tokens: 0 } });
  const real = tr.usage;
  check('usage: a real reading lands',
        real && real.cache_read_tokens === 602880, JSON.stringify(real));
  ev({ type: 'usage',
       context_usage: { input_tokens: 0, output_tokens: 0,
                        cache_read_tokens: 0, cache_write_tokens: 0,
                        reasoning_tokens: 0 } });
  check('usage: a zeroed one does not overwrite it',
        tr.usage === real, JSON.stringify(tr.usage));
  ev({ type: 'turn.end', usage: { input_tokens: 9 },
       context_usage: { input_tokens: 0, output_tokens: 0,
                        cache_read_tokens: 0, cache_write_tokens: 0 } });
  check('usage: nor does a zeroed one riding on turn.end',
        tr.usage === real, JSON.stringify(tr.usage));
  // `usage` on turn.end is the turn's total across every request it made.
  // Taking it as the window's occupancy read hundreds of times over.
  check('usage: and the turn total is not mistaken for the window',
        tr.usage === real, JSON.stringify(tr.usage));
}

// -- daemon identity ----------------------------------------------------------
// The client compares this against the heartbeat.py it ships; an old daemon that
// answers 200 and drops fields it does not know is otherwise indistinguishable
// from a working one, which is how archiving looked like a client-side bug.
{
  const ping = await fetch(`${BASE}/v1/ping`).then(r => r.json());
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const want = createHash('sha256')
    .update(readFileSync(new URL('../server/heartbeat.py', import.meta.url)))
    .digest('hex').slice(0, 12);
  check('ping carries a source revision', /^[0-9a-f]{12}$/.test(ping.revision || ''),
        ping.revision);
  check('the revision matches this checkout', ping.revision === want,
        `${ping.revision} vs ${want}`);
}

// -- the filesystem browser the workdir picker uses ---------------------------
const listing = await fetch(`${BASE}/v1/fs?path=~`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  .then(r => r.json());
check('fs browse', !!listing.path, listing.path);

// -- context accounting behind the ring and the usage tray -------------------
// The cache fields have to survive the daemon -> client trip, or the maths
// below is exercising numbers the renderer never actually receives.
{
  const done = cold.items.find(i => i.kind === 'summary' && i.summary);
  const u = (done && done.summary.usage) || {};
  check('context: cache fields reach the transcript',
        u.cache_read_tokens === 5600 && u.cache_write_tokens === 120,
        JSON.stringify(u));
  // The window gauge must read the last request, not the turn's total: a turn
  // with tool calls re-sends its prefix once per call, and summing that
  // reports several times the tokens the window is actually holding.
  const cu = (done && done.summary.contextUsage) || {};
  check('context: the window reads the last request, not the turn total',
        contextUsed(cu) === 2856 && contextUsed(u) === 5766,
        `${contextUsed(cu)} vs ${contextUsed(u)}`);
}

// The first turn of a session writes the whole prompt to cache and reads none
// of it back, which is exactly the case that used to report an empty window.
check('context: first turn counts the cache write',
      contextUsed({ input_tokens: 2, cache_write_tokens: 17000, output_tokens: 1700 })
      === 18702);
check('context: later turn counts the cache read',
      contextUsed({ input_tokens: 40, cache_read_tokens: 17000, output_tokens: 900 })
      === 17940);
check('context: no usage is zero, not NaN', contextUsed(null) === 0);
check('context: a sub-percent request is not 0%', pctText(1700, 800000) === '<1%');
check('context: an empty window stays 0%', pctText(0, 800000) === '0%');
check('context: a real fraction rounds', pctText(84000, 200000) === '42%');
// A gateway that zeroes the per-request usage must not report an empty window.
check('context: a zeroed per-request reading falls back to the turn total',
      contextUsed(windowUsage({
        contextUsage: { input_tokens: 0, output_tokens: 0 },
        usage: { input_tokens: 19966, output_tokens: 44 },
      })) === 20010);
check('context: a real per-request reading still wins',
      contextUsed(windowUsage({
        contextUsage: { input_tokens: 300, output_tokens: 20 },
        usage: { input_tokens: 900, output_tokens: 60 },
      })) === 320);

// -- provider keys: keychain round-trip through the host server ---------------
// The host server runs as a child with CADEN_CONFIG in a temp dir, so its
// keychain calls cannot touch this machine's real Caden config. Keychain calls
// can prompt on first use, so every fetch has a timeout -- a hang fails the
// section instead of the suite. macOS only: the `security` CLI is the store.
if (process.platform === 'darwin') {
  const freePort = () => new Promise(res => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-key-test-'));
  const cfgPath = path.join(tmp, 'config.json');
  const port = await freePort();
  const child = spawn(process.execPath,
    [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'app', 'server.js'),
     String(port)],
    // The entry is what is under test; installing a daemon into ~/.caden is
    // not something a test suite should leave behind.
    { env: { ...process.env, CADEN_CONFIG: cfgPath, CADEN_NO_LOCAL_INSTALL: '1' },
      stdio: 'ignore' });
  const hostCall = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return [res.status, text ? JSON.parse(text) : {}];
  };
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { await fetch(`http://127.0.0.1:${port}/host/config`); up = true; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    check('host server up for the keychain test', up);
    if (up) {
      const prov = { id: 'prov-test', name: 'Test', baseURL: 'https://example.com',
                     proto: 'anthropic-messages', apiKey: 'sk-test-key', models: [] };
      let [sc] = await hostCall('POST', '/host/providers', { providers: [prov] });
      check('providers: POST with a key succeeds', sc === 200);
      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      check('providers: key never touches config.json', !onDisk.providers[0].apiKey);
      let [, cfg] = await hostCall('GET', '/host/config');
      check('providers: GET reports hasKey', cfg.providers[0]?.hasKey === true);
      check('providers: GET hides the value', cfg.providers[0]?.apiKey === undefined);
      [sc] = await hostCall('POST', '/host/providers',
        { providers: [{ ...prov, apiKey: null }] });
      check('providers: apiKey:null removes the key', sc === 200);
      [, cfg] = await hostCall('GET', '/host/config');
      check('providers: hasKey false after removal', cfg.providers[0]?.hasKey === false);

      // The machine the app is on is a server too, and it is ready without
      // being asked: the entry is created before the host server answers its
      // first request, so the renderer's opening read already has it. Before
      // this the Servers pane could only offer hosts from ~/.ssh/config, and
      // using your own Mac meant editing config.json by hand.
      const [, cfg2] = await hostCall('GET', '/host/config');
      const here = (cfg2.servers || []).find(x => x.mode === 'direct' && !x.sshHost);
      check('servers: this machine is there without being added', !!here,
            JSON.stringify((cfg2.servers || []).map(x => x.name)));
      // `/host/config` hands the renderer a reduced server, so the shape the
      // local shell keys off -- a loopback URL and a home to install into --
      // is checked on the file the host actually wrote.
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).servers
        .find(x => x.mode === 'direct' && !x.sshHost) || {};
      check('servers: as a direct loopback server the local shell can install into',
            /^http:\/\/127\.0\.0\.1:\d+$/.test(written.directURL || '')
            && written.remoteHome === '~/.caden',
            JSON.stringify({ directURL: written.directURL, home: written.remoteHome }));
      check('servers: and only ever one of it',
            (cfg2.servers || []).filter(x => x.mode === 'direct' && !x.sshHost).length === 1);
    }
  } finally {
    child.kill();
    try { execSync('security delete-generic-password -s app.caden.secrets -a provider.prov-test',
                   { stdio: 'ignore', timeout: 5000 }); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else {
  console.log('  skip  keychain round-trip (needs the macOS keychain)');
}

await call('DELETE', `/sessions/${sid}`);
console.log(failed ? '\nclient-test: FAILED' : '\nclient-test: OK');
process.exit(failed ? 1 : 0);
