// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// A small syntax highlighter: enough to give code shape, not a parser.
//
// It emits DOM nodes rather than markup, like the markdown renderer it serves.
// Model output is untrusted text and must never become HTML on the way to the
// screen, so there is no innerHTML anywhere in this path.

import { el } from './util.js';

const KEYWORDS = {
  js: `const let var function return if else for while class new await async
       import export from default try catch finally throw typeof instanceof of
       in null true false undefined this extends super static get set delete
       yield break continue switch case do void`,
  py: `def class return if elif else for while import from as pass raise try
       except finally with lambda None True False and or not in is global
       nonlocal yield assert del async await break continue`,
  sh: `if then else elif fi for while do done case esac function return export
       local readonly source echo cd set unset trap exit`,
  go: `func package import type struct interface return if else for range var
       const go defer chan map nil true false switch case default break
       continue`,
  rs: `fn let mut struct enum impl trait use pub mod match if else for while
       loop return Some None Ok Err true false as ref move async await dyn
       crate self`,
  sql: `select from where group by order having join left right inner outer on
        as insert into values update set delete create table drop alter index`,
};

// Comment syntax is the only thing that really differs between these families.
const LINE_COMMENT = { js: '//', go: '//', rs: '//', py: '#', sh: '#', sql: '--' };

const ALIASES = {
  javascript: 'js', typescript: 'js', ts: 'js', jsx: 'js', tsx: 'js',
  json: 'js', java: 'js', c: 'js', cpp: 'js', 'c++': 'js', cs: 'js', swift: 'js',
  python: 'py', py3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh',
  golang: 'go', rust: 'rs', postgres: 'sql', mysql: 'sql',
};

const family = lang => {
  const key = (lang || '').trim().toLowerCase();
  return KEYWORDS[key] ? key : (ALIASES[key] || null);
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function highlight(code, lang) {
  const fam = family(lang);
  const out = document.createDocumentFragment();
  if (!fam) return document.createTextNode(code);

  const words = new Set(KEYWORDS[fam].split(/\s+/).filter(Boolean));
  const lc = escapeRe(LINE_COMMENT[fam]);
  const block = fam === 'js' || fam === 'go' || fam === 'rs';
  // Python docstrings have to be matched before the single-quote forms, or a
  // leading `"""` reads as an empty string and the prose after it goes unstyled.
  // Diff lines are highlighted one at a time, so an opening `"""` usually has no
  // partner on its line: an unterminated one runs to the end of what we were given.
  const triple = fam === 'py'
    ? '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"""[\\s\\S]*|\'\'\'[\\s\\S]*|'
    : '';
  const re = new RegExp(
    `(${lc}[^\\n]*${block ? '|/\\*[\\s\\S]*?\\*/' : ''})`      // comment
    + `|(${triple}'(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*"|\`(?:\\\\.|[^\`\\\\])*\`)` // string
    + `|(\\b\\d[\\w.]*\\b)`                                     // number
    + `|([A-Za-z_$][\\w$]*)`,                                   // word
    'g');

  let last = 0, m;
  const push = (text, cls) => {
    if (!text) return;
    out.append(cls ? el('span', { class: cls }, text) : document.createTextNode(text));
  };
  while ((m = re.exec(code))) {
    push(code.slice(last, m.index));
    if (m[1]) push(m[1], 'tok-comment');
    else if (m[2]) push(m[2], 'tok-string');
    else if (m[3]) push(m[3], 'tok-number');
    else push(m[4], words.has(m[4]) ? 'tok-keyword' : null);
    last = m.index + m[0].length;
  }
  push(code.slice(last));
  return out;
}

/// The async clipboard is the right call and usually the only one needed, but
/// it is gated on permissions that some embeddings withhold; the textarea trick
/// still works there.
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const pad = el('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
    pad.value = text;
    document.body.append(pad);
    pad.select();
    const ok = document.execCommand('copy');
    pad.remove();
    return ok;
  } catch {
    return false;
  }
}

/// A fenced block: language on the left, copy on the right, code below.
export function codeBlock(code, lang) {
  const copy = el('button', { class: 'code-copy' }, 'Copy');
  copy.addEventListener('click', async () => {
    copy.textContent = (await writeClipboard(code)) ? 'Copied' : 'Failed';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
  });
  return el('div', { class: 'code-block' },
    el('div', { class: 'code-head' },
      el('span', { class: 'code-lang' }, (lang || '').trim() || 'text'),
      copy),
    el('pre', {}, el('code', {}, highlight(code, lang))));
}
