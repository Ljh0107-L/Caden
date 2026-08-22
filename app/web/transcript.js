// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Port of Transcript.swift: folds the daemon's event stream into the item list
// the conversation renders. Deltas and final blocks share a key so a completed
// message overwrites what was streamed — which is what lets the client
// reconnect mid-turn and replay from a cursor without duplicating text.

import { compactTokens, fmtDuration } from './util.js';

/// Is this reading worth measuring the window with?
///
/// Only if it has a prompt side. A well-formed empty reading is worse than no
/// reading: it is an object, so a truthiness check lets it through, and it
/// overwrites a real measurement with nothing. Codex's app-server publishes
/// one while it is compacting, and the gauge went to "0 tokens" over a window
/// holding six hundred thousand of them. The daemon drops these at the source
/// now; this keeps logs already carrying one from replaying the same blank.
const usableUsage = u => !!u && (
  (u.input_tokens || 0) > 0 || (u.cache_read_tokens || 0) > 0
  || (u.cache_write_tokens || 0) > 0);

export class Transcript {
  constructor() {
    this.items = [];
    this.index = new Map();
    this.lastSeq = 0;
    this.nativeId = null;
    // What the window holds right now. Kept as one value rather than looked
    // up from the last summary row: usage arrives mid-turn too, and a turn the
    // engine started on its own may never produce a summary at all.
    this.usage = null;
    this.goal = null;
    // Whether a `goal` event has been seen at all. `null` means two different
    // things -- nothing heard yet, and heard that it was cleared -- and the
    // status row has to tell them apart or clearing a goal falls back to the
    // stale snapshot the view opened with and the old goal reappears.
    this.sawGoal = false;
    this.activity = null;
    // The engine rewriting the conversation, when it is doing that now. It is
    // the one thing that takes minutes with nothing else on the wire, so the
    // view has to be able to name it instead of showing a bare spinner.
    this.compacting = null;
    // When anything last arrived. A turn that has gone quiet is only
    // distinguishable from a hung one by how long it has been quiet.
    this.lastEventTs = 0;
    // Work left running in the background. Session state, like the goal: it
    // outlives the turn that started it.
    this.tasks = null;
  }

  get isEmpty() { return this.items.length === 0; }

  /// Every file the agent touched, most recent first, deduplicated.
  get changedFiles() {
    const seen = new Set();
    const out = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind !== 'diff') continue;
      for (const f of item.files || []) {
        const key = (f.path || '') + (f.kind || '');
        if (!seen.has(f.path || key)) { seen.add(f.path || key); out.push(f); }
      }
    }
    return out;
  }

  noteLocalError(message) {
    const id = `local:${Math.random().toString(36).slice(2)}`;
    this.index.set(id, this.items.length);
    this.items.push({ id, kind: 'error', text: message, ts: Date.now() });
  }

  /// `index` maps id -> position, so anything that moves an item invalidates
  /// it from that point on. Rare enough to rebuild wholesale.
  reindex() {
    this.index.clear();
    this.items.forEach((it, i) => this.index.set(it.id, i));
  }

  upsert(id, kind, turn, ts, build) {
    let i = this.index.get(id);
    if (i === undefined) {
      const item = { id, kind, turn, ts, text: '' };
      build(item);
      this.index.set(id, this.items.length);
      this.items.push(item);
    } else {
      build(this.items[i]);
    }
  }

  apply(ev) {
    if (!(ev.seq > this.lastSeq || ev.seq === 0)) return false;
    this.lastSeq = Math.max(this.lastSeq, ev.seq);
    const turn = ev.turn || '';
    const ts = ev.ts || 0;
    if (ts) this.lastEventTs = ts;

    switch (ev.type) {
      case 'user':
        // A new turn supersedes the last one's parting status.
        this.activity = null;
        this.upsert(`u:${ev.seq}`, 'user', turn, ts, it => { it.text = ev.text || ''; });
        break;
      // `streaming` marks a block that is still arriving. The final event for
      // a block clears it: a finished paragraph looks identical to a live one
      // otherwise, and the view uses this to decide whether the tail is still
      // moving or the turn has gone quiet between saying and doing.
      case 'text.delta':
        this.upsert(`b:${ev.block ?? ev.seq}`, 'assistant', turn, ts,
                    it => { it.text += ev.text || ''; it.streaming = true; });
        break;
      case 'text':
        this.upsert(`b:${ev.block ?? ev.seq}`, 'assistant', turn, ts,
                    it => { it.text = ev.text || ''; it.streaming = false; });
        break;
      case 'thinking.delta':
        this.upsert(`t:${ev.block ?? ev.seq}`, 'thinking', turn, ts,
                    it => { it.text += ev.text || ''; it.endTs = ts; it.streaming = true; });
        break;
      case 'thinking':
        this.upsert(`t:${ev.block ?? ev.seq}`, 'thinking', turn, ts,
                    it => { it.text = ev.text || ''; it.endTs = ts; it.streaming = false; });
        break;
      case 'tool.start': {
        const tid = ev.tool_id ?? String(ev.seq);
        this.upsert(`tool:${tid}`, 'tool', turn, ts, it => {
          const call = it.tool || { id: tid, name: ev.name || 'tool',
                                    title: ev.title || '', output: '' };
          call.name = ev.name || call.name;
          call.title = ev.title || call.title;
          call.input = ev.input ?? call.input;
          call.running = true;
          call.startedAt = ts;
          it.tool = call;
        });
        break;
      }
      case 'tool.end': {
        const tid = ev.tool_id ?? String(ev.seq);
        this.upsert(`tool:${tid}`, 'tool', turn, ts, it => {
          const call = it.tool || { id: tid, name: ev.name || 'tool', title: '' };
          call.output = ev.output || '';
          call.isError = ev.is_error || false;
          call.exitCode = ev.exit_code;
          call.running = false;
          call.endedAt = ts;
          it.tool = call;
        });
        break;
      }
      case 'todo':
        this.upsert(`todo:${turn || ev.seq}`, 'todo', turn, ts,
                    it => { it.todos = ev.items || []; });
        break;
      case 'diff':
        this.upsert(`diff:${ev.seq}`, 'diff', turn, ts,
                    it => { it.files = ev.files || []; });
        break;
      case 'goal':
        this.goal = ev.goal || null;
        this.sawGoal = true;
        break;
      case 'tasks':
        this.tasks = ev.tasks || [];
        break;
      case 'task':
        // A background job finishing is the reason the engine is about to
        // start working again, so it belongs in the transcript rather than
        // only in the log.
        this.upsert(`task:${ev.task_id || ev.seq}`, 'notice', turn, ts,
                    it => { it.text = ev.text || ''; });
        break;
      case 'activity':
        // Where the engine says the turn left things. Superseded by the next
        // turn: it describes the end of one, not the middle of the next.
        this.activity = ev.category
          ? { category: ev.category, detail: ev.detail || '',
              needsAction: !!ev.needs_action }
          : null;
        break;
      case 'usage':
        if (usableUsage(ev.context_usage)) this.usage = ev.context_usage;
        break;
      case 'compaction':
        // Claude Code compacts on its own when the window fills, and says so
        // twice: once when it starts, once with the numbers when it lands.
        // The gap between the two is minutes long, which is why the start is
        // carried as live state rather than as a row.
        if (ev.state === 'start') { this.compacting = { ts }; break; }
        this.compacting = null;
        this.upsert(`compact:${ev.seq}`, 'notice', turn, ts, it => {
          if (ev.state === 'done') {
            // Claude reports what it dropped; Codex reports only that it
            // happened, so the numbers appear when there are numbers.
            const span = ev.pre_tokens && ev.post_tokens
              ? ` · ${compactTokens(ev.pre_tokens)} → ${compactTokens(ev.post_tokens)}`
              : '';
            it.text = 'context compacted' + span
              + (ev.duration_ms ? ` in ${fmtDuration(ev.duration_ms)}` : '');
          } else if (ev.state === 'aborted') {
            // Worth a row of its own: interrupting a compaction throws all of
            // it away, and the next turn pays for it again from the start.
            it.text = 'compaction interrupted — the next turn starts it over';
          } else {
            it.text = 'compaction failed' + (ev.error ? ` — ${ev.error}` : '');
          }
        });
        break;
      case 'turn.end':
        this.upsert(`end:${turn || ev.seq}`, 'summary', turn, ts, it => {
          it.summary = {
            // `usage` is the turn's total across every request it made;
            // `contextUsage` is the last request's, which is what the window
            // holds. A turn with three tool calls sends the same prefix three
            // times, so the two differ by roughly that factor.
            usage: ev.usage || {},
            contextUsage: ev.context_usage || ev.usage || {},
            totals: ev.totals || {},
            costUSD: ev.cost_usd || 0, durationMs: ev.duration_ms || 0,
            error: ev.error || null,
          };
        });
        // The turn's own reading is the corrected one -- it is the only place
        // the real output count shows up.
        // Only the per-request reading, and only a usable one. `usage` here is
        // the turn's total across every request it made -- on a long Codex
        // turn, hundreds of times what the window holds -- so falling back to
        // it does not measure occupancy, it measures work. The last real
        // reading is the better answer when this turn did not carry one.
        if (!ev.error && usableUsage(ev.context_usage)) this.usage = ev.context_usage;
        // Belt and braces: a turn forced closed from outside -- the interrupt
        // watchdog killing the engine -- never reaches the adapter, so nothing
        // else would clear a compaction left mid-flight.
        this.compacting = null;
        break;
      case 'error':
        this.upsert(`err:${ev.seq}`, 'error', turn, ts,
                    it => { it.text = ev.message || ev.error || 'unknown error'; });
        break;
      case 'queued':
        this.upsert(`q:${turn}`, 'notice', turn, ts,
                    it => { it.text = 'queued behind the running turn';
                            it.queuedTurn = turn; });
        break;
      case 'turn.start': {
        if (this.index.get(`q:${turn}`) === undefined) return false;
        // A queued message was shown where it was typed -- above whatever the
        // running turn went on to say. It runs here, so it belongs here: move
        // it to the end, and drop the notice, whose offer to jump the queue is
        // now spent. The transcript then reads in the order things happened.
        const waiting = [];
        const rest = [];
        for (const it of this.items) {
          if (it.id === `q:${turn}`) continue;
          (it.turn === turn ? waiting : rest).push(it);
        }
        this.items = rest.concat(waiting);
        this.reindex();
        break;
      }
      case 'interrupted':
        this.upsert(`int:${ev.seq}`, 'notice', turn, ts,
                    it => { it.text = 'Interrupted'; });
        break;
      case 'warning':
        // Engine advisories stay in the event log only.
        return false;
      case 'session.init':
        this.nativeId = ev.native_id || this.nativeId;
        return false;
      case 'log':
        // Daemon housekeeping ("restarting engine…") stays out of the
        // transcript; it remains in the event log for debugging.
        return false;
      default:
        return false;
    }
    return true;
  }
}

/// What the conversation view shows, given a "start here" cursor.
///
/// The cursor is an item id, not an index: items move -- a queued message
/// jumps to the end when it runs -- and a fresh replay may not contain it at
/// all. Either way the answer is to show everything rather than to show
/// nothing, so a cursor that no longer resolves is reported as spent.
export function visibleFrom(items, viewFrom) {
  if (!viewFrom) return { items, hidden: 0, stale: false };
  const at = items.findIndex(i => i.id === viewFrom);
  if (at < 0) return { items, hidden: 0, stale: true };
  if (at === 0) return { items, hidden: 0, stale: false };
  return { items: items.slice(at), hidden: at, stale: false };
}

/// Port of TranscriptViews.grouped(): consecutive tool/diff items collapse
/// into one summary row that expands on click.
export function groupRows(items) {
  const rows = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    rows.push(pending.length === 1
      ? { kind: 'item', item: pending[0], id: pending[0].id }
      : { kind: 'tools', items: pending, id: 'tools:' + pending[0].id });
    pending = [];
  };
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'diff') pending.push(item);
    else { flush(); rows.push({ kind: 'item', item, id: item.id }); }
  }
  flush();
  return rows;
}

export const toolVerb = name => ({
  bash: 'Ran', shell: 'Ran', run_command: 'Ran',
  read: 'Read', view: 'Read',
  edit: 'Edited', write: 'Edited', multiedit: 'Edited',
  apply_patch: 'Edited', notebookedit: 'Edited',
  glob: 'Searched', grep: 'Searched', search: 'Searched',
  websearch: 'Searched the web for', web_search: 'Searched the web for',
  webfetch: 'Fetched', web_fetch: 'Fetched',
  task: 'Delegated',
}[(name || '').toLowerCase()] || name);

export const toolBucket = name => ({
  bash: 'commands', shell: 'commands', run_command: 'commands',
  read: 'files read', view: 'files read',
  edit: 'edits', write: 'edits', multiedit: 'edits',
  apply_patch: 'edits', notebookedit: 'edits',
  glob: 'searches', grep: 'searches', search: 'searches',
  websearch: 'searches', web_search: 'searches',
  webfetch: 'fetches', web_fetch: 'fetches',
}[(name || '').toLowerCase()] || (name || '').toLowerCase());
