// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// File changes, rendered the way a coding agent's edits deserve: line numbers,
// a gutter, and the code itself still syntax-coloured.
//
// The two engines hand us different raw material. Codex sends a unified diff
// per file, already computed on the server. Claude sends the edit's `before`
// and `after` text as the tool's arguments and no diff at all, so one has to
// be produced here -- which is what `diffLines` is for.

import { el } from './util.js';
import { highlight } from './highlight.js';

const LANG_BY_EXT = {
  py: 'python', js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
  json: 'json', go: 'go', rs: 'rust', sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', java: 'java', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', swift: 'swift',
};
const langOf = path => LANG_BY_EXT[(path || '').split('.').pop().toLowerCase()] || '';

/// Longest common subsequence over lines: the smallest honest description of
/// what changed between two texts.
///
/// The table is O(n*m), which is the right trade for edit-sized inputs and the
/// wrong one for whole files -- so callers with something huge get a plain
/// replacement instead of a diff nobody would read anyway.
export function diffLines(before, after, cap = 2000) {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');
  if (a.length > cap || b.length > cap) {
    return [...a.map(text => ({ op: '-', text })),
            ...b.map(text => ({ op: '+', text }))];
  }
  const n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1
                                  : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ op: '-', text: a[i++] }); }
    else { out.push({ op: '+', text: b[j++] }); }
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

/// A unified diff -> the same line shape, with the numbers the hunk headers
/// carry. Anything that is not a hunk line (the ---/+++ preamble, "\ No
/// newline") is dropped: it is bookkeeping, not content.
export function parseUnified(text) {
  const out = [];
  let oldNo = 0, newNo = 0, seenHunk = false;
  for (const line of (text || '').split('\n')) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (hunk) {
      if (seenHunk) out.push({ op: '@', text: '' });     // gap between hunks
      seenHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (!seenHunk) continue;
    if (line.startsWith('\\')) continue;
    const op = line[0];
    const body = line.slice(1);
    if (op === '+') out.push({ op: '+', text: body, no: newNo++ });
    else if (op === '-') out.push({ op: '-', text: body, no: oldNo++ });
    else if (op === ' ' || line === '') { out.push({ op: ' ', text: body, no: newNo++ }); oldNo++; }
  }
  return out;
}

/// Number the lines a synthesized diff could not know about on its own.
function number(lines, startOld = 1, startNew = 1) {
  let o = startOld, n = startNew;
  return lines.map(l => {
    if (l.op === '-') return { ...l, no: o++ };
    if (l.op === '+') return { ...l, no: n++ };
    const at = n;
    o++; n++;
    return { ...l, no: at };
  });
}

const VERB = { add: 'Create', delete: 'Delete', edit: 'Update', update: 'Update' };

/// One file's worth of change.
export function renderDiff({ path, kind, unified, before, after, startLine }) {
  const lines = unified ? parseUnified(unified)
                        : number(diffLines(before, after), startLine || 1, startLine || 1);
  const added = lines.filter(l => l.op === '+').length;
  const removed = lines.filter(l => l.op === '-').length;
  const lang = langOf(path);

  const head = el('div', { class: 'fd-head' },
    el('span', { class: 'fd-verb' }, VERB[kind] || 'Update'),
    el('span', { class: 'fd-path', title: path }, path || 'file'));
  const stat = el('div', { class: 'fd-stat' },
    added ? el('span', { class: 'add' }, `+${added}`) : null,
    removed ? el('span', { class: 'del' }, `−${removed}`) : null);

  const body = el('div', { class: 'fd-lines' });
  for (const line of lines) {
    if (line.op === '@') {
      body.append(el('div', { class: 'fd-line gap' },
        el('span', { class: 'fd-no' }, ''), el('span', { class: 'fd-sign' }, '⋯'),
        el('span', { class: 'fd-code' }, '')));
      continue;
    }
    const cls = line.op === '+' ? 'add' : line.op === '-' ? 'del' : '';
    body.append(el('div', { class: `fd-line ${cls}` },
      el('span', { class: 'fd-no' }, line.no === undefined ? '' : String(line.no)),
      el('span', { class: 'fd-sign' }, line.op === ' ' ? '' : line.op),
      el('span', { class: 'fd-code' }, highlight(line.text, lang))));
  }

  return el('div', { class: 'file-diff' },
    el('div', { class: 'fd-top' }, head, stat), body);
}

/// The edit-shaped tool calls Claude Code makes, turned into the same thing.
/// Returns null for a tool that is not an edit, or one whose arguments do not
/// carry enough to show what changed.
export function diffFromToolInput(name, input) {
  const n = (name || '').toLowerCase();
  const arg = input && typeof input === 'object' ? input : {};
  const path = arg.file_path || arg.path || arg.notebook_path;
  if (!path) return null;

  if (n === 'write' && typeof arg.content === 'string') {
    return [{ path, kind: 'add', before: '', after: arg.content }];
  }
  if (n === 'multiedit' && Array.isArray(arg.edits)) {
    return arg.edits
      .filter(e => e && typeof e.old_string === 'string')
      .map(e => ({ path, kind: 'edit', before: e.old_string, after: e.new_string || '' }));
  }
  if (typeof arg.old_string === 'string') {
    return [{ path, kind: 'edit', before: arg.old_string, after: arg.new_string || '' }];
  }
  return null;
}
