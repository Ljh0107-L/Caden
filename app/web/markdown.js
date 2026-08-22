// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Minimal markdown → DOM for assistant messages: fences, headings, lists,
// paragraphs; inline code / bold / italic. Builds nodes directly (no
// innerHTML), so model output cannot inject markup.

import { el } from './util.js';
import { codeBlock } from './highlight.js';

export function renderMarkdown(raw) {
  const root = el('div', { class: 'assistant' });
  const lines = (raw || '').split('\n');
  let i = 0;

  const inline = text => {
    const frag = document.createDocumentFragment();
    // tokens: `code`  **bold**  *italic*
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('`')) frag.append(el('code', {}, tok.slice(1, -1)));
      else if (tok.startsWith('**')) frag.append(el('strong', {}, tok.slice(2, -2)));
      else frag.append(el('em', {}, tok.slice(1, -1)));
      last = m.index + tok.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;                                                   // closing fence
      root.append(codeBlock(buf.join('\n'), lang));
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      root.append(el(`h${h[1].length}`, {}, inline(h[2])));
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const ul = el('ul');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        ul.append(el('li', {}, inline(lines[i].replace(/^\s*[-*]\s+/, ''))));
        i++;
      }
      root.append(ul);
      continue;
    }

    // A table needs its separator row to be a table at all; without it the
    // pipes are just text the model happened to type.
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
      const cells = row => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
        .split('|').map(c => c.trim());
      const align = cells(lines[i + 1]).map(spec =>
        /^:-+:$/.test(spec) ? 'center' : /-+:$/.test(spec) ? 'right' : 'left');
      // Right alignment is how a markdown author marks a column of values, and
      // a value column that wraps ("50 / MB") reads worse than a narrow one.
      const cell = (tag, c, n) => el(tag, {
        class: align[n] === 'right' ? 'md-val' : null,
        style: `text-align:${align[n] || 'left'}`,
      }, inline(c));
      const table = el('table', { class: 'md-table' });
      const head = el('tr');
      cells(line).forEach((c, n) => head.append(cell('th', c, n)));
      table.append(el('thead', {}, head));
      const body = el('tbody');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const tr = el('tr');
        cells(lines[i]).forEach((c, n) => tr.append(cell('td', c, n)));
        body.append(tr);
        i++;
      }
      table.append(body);
      // The table fills the message column; the wrapper is what scrolls when a
      // row is too wide to fit, so the table itself stays a table box.
      root.append(el('div', { class: 'md-table-wrap' }, table));
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = el('ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        ol.append(el('li', {}, inline(lines[i].replace(/^\s*\d+\.\s+/, ''))));
        i++;
      }
      root.append(ol);
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== ''
           && !/^(#{1,3}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])
           && !(lines[i].includes('|')
                && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || ''))) {
      buf.push(lines[i++]);
    }
    root.append(el('p', {}, inline(buf.join('\n'))));
  }
  return root;
}
