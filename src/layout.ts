import { linkFor } from './types.ts';
import type { GhostDoc, SearchHit } from './types.ts';

/**
 * Pure layout for the full screen picker. Given state and a terminal size it
 * returns exactly `height` lines, each at most `width` visible columns.
 * Keeping this free of terminal I/O is what makes the layout testable.
 */

const ANSI = /\x1b\[[0-9;]*m/g;

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  invert: '\x1b[7m',
};

/** Visible width, ignoring colour escapes. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI, '').length;
}

/** Truncate to `w` visible columns, adding an ellipsis when it does not fit. */
export function truncate(s: string, w: number): string {
  if (w <= 0) return '';
  const plain = s.replace(ANSI, '');
  if (plain.length <= w) return s;
  if (w === 1) return '…';
  return `${plain.slice(0, w - 1)}…`;
}

/** Pad with spaces to exactly `w` visible columns. */
export function pad(s: string, w: number): string {
  const diff = w - visibleWidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

/** Break text onto at most `maxLines` lines of `w` columns, on word boundaries. */
export function wrap(text: string, w: number, maxLines: number): string[] {
  if (w <= 0 || maxLines <= 0) return [];
  const words = text.split(/\s+/).filter((x) => x !== '');
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= w) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      if (lines.length === maxLines) return lines;
      line = word;
    }
    while (line.length > w) {
      lines.push(line.slice(0, w));
      if (lines.length === maxLines) return lines;
      line = line.slice(w);
    }
  }
  if (line !== '' && lines.length < maxLines) lines.push(line);
  return lines;
}

export function isDraft(doc: GhostDoc): boolean {
  return doc.status !== 'published' && doc.status !== 'sent';
}

export function dateOf(doc: GhostDoc): string {
  return (doc.publishedAt ?? doc.updatedAt).slice(0, 10);
}

export interface LayoutState {
  query: string;
  hits: SearchHit[];
  selected: number;
}

export interface LayoutContext {
  site: string;
  notice?: string | null;
  /** Shown briefly after an action, for example a copy confirmation. */
  flash?: string | null;
}

export interface Size {
  width: number;
  height: number;
}

/** Rows consumed by everything that is not the result list or detail pane. */
const CHROME_ROWS = 5;
const DETAIL_ROWS = 7;
const MIN_LIST_ROWS = 3;

/**
 * Which slice of the results to show so the selection stays on screen.
 * Exported because off-by-one scrolling is exactly the kind of thing worth
 * pinning down in a test.
 */
export function windowFor(
  selected: number,
  total: number,
  rows: number,
): { start: number; end: number } {
  if (rows <= 0 || total === 0) return { start: 0, end: 0 };
  if (total <= rows) return { start: 0, end: total };

  let start = selected - Math.floor(rows / 2);
  start = Math.max(0, Math.min(start, total - rows));
  return { start, end: start + rows };
}

export function layout(state: LayoutState, size: Size, ctx: LayoutContext): string[] {
  const w = Math.max(20, size.width);
  const h = Math.max(8, size.height);
  const inner = w - 2;

  // The detail pane is the first thing to give up space on a short terminal.
  const listRows = Math.max(MIN_LIST_ROWS, h - CHROME_ROWS - DETAIL_ROWS);
  const detailRows = Math.max(0, h - CHROME_ROWS - listRows);

  const lines: string[] = [];
  const rule = (): string => `${C.dim}${'─'.repeat(w)}${C.reset}`;

  // Header
  const title = `${C.bold} GhostHunter${C.reset}`;
  const site = `${C.dim}${ctx.site} ${C.reset}`;
  const gap = Math.max(1, w - visibleWidth(title) - visibleWidth(site));
  lines.push(truncate(`${title}${' '.repeat(gap)}${site}`, w));

  // Query line
  const count = state.hits.length;
  const countText = `${C.dim}${count} ${count === 1 ? 'hit' : 'hits'}${C.reset}`;
  const prompt = `${C.cyan}❯${C.reset} ${state.query}${C.green}▌${C.reset}`;
  const qGap = Math.max(1, w - 1 - visibleWidth(prompt) - visibleWidth(countText));
  lines.push(truncate(` ${prompt}${' '.repeat(qGap)}${countText}`, w));

  lines.push(rule());

  // Result list
  const { start, end } = windowFor(state.selected, count, listRows);
  const visible = state.hits.slice(start, end);

  for (let i = 0; i < listRows; i++) {
    const hit = visible[i];
    if (hit === undefined) {
      lines.push('');
      continue;
    }
    const index = start + i;
    const isSel = index === state.selected;
    const doc = hit.doc;

    const marker = isSel ? `${C.cyan}❯${C.reset}` : ' ';
    const date = `${C.dim}${dateOf(doc)}${C.reset}`;
    const draftTag = isDraft(doc) ? `${C.yellow} [${doc.status}]${C.reset}` : '';

    const fixed = 2 + 1 + visibleWidth(date) + visibleWidth(draftTag) + 1;
    const titleText = truncate(doc.title, Math.max(4, inner - fixed));
    const styled = isSel ? `${C.bold}${titleText}${C.reset}` : titleText;

    const left = ` ${marker} ${styled}${draftTag}`;
    const spacer = Math.max(1, w - 1 - visibleWidth(left) - visibleWidth(date));
    const row = `${left}${' '.repeat(spacer)}${date} `;
    lines.push(isSel ? `${C.invert}${pad(truncate(row, w), w)}${C.reset}` : truncate(row, w));
  }

  if (count === 0) {
    lines[3] = truncate(`   ${C.dim}No matches.${C.reset}`, w);
  }

  lines.push(rule());

  // Detail pane for the selected result
  const sel = state.hits[state.selected];
  const detail: string[] = [];
  if (sel !== undefined && detailRows > 0) {
    const doc = sel.doc;
    detail.push(truncate(` ${C.bold}${doc.title}${C.reset}`, w));

    const meta = [dateOf(doc), doc.type, ...(doc.tags.length > 0 ? [doc.tags.join(', ')] : [])];
    detail.push(truncate(` ${C.dim}${meta.join('  ·  ')}${C.reset}`, w));
    detail.push(truncate(` ${C.cyan}${linkFor(doc)}${C.reset}`, w));
    detail.push('');

    const snip = sel.snippet.replace(/\s+/g, ' ').trim();
    if (snip !== '') {
      for (const l of wrap(snip, inner - 1, Math.max(0, detailRows - 4))) {
        detail.push(` ${C.dim}${l}${C.reset}`);
      }
    }
  }
  while (detail.length < detailRows) detail.push('');
  lines.push(...detail.slice(0, detailRows));

  // Footer
  const keys = ctx.flash
    ? `${C.green} ${ctx.flash}${C.reset}`
    : ctx.notice
      ? `${C.yellow} ${ctx.notice}${C.reset}`
      : ` ${C.dim}↵ copy   ⌥↵ or ^L markdown   ^O open   ^E edit   esc quit${C.reset}`;
  lines.push(truncate(keys, w));

  return lines.slice(0, h);
}
