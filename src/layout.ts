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
  mark: '\x1b[43m\x1b[30m',
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

/** Break text onto lines of `w` columns, on word boundaries where possible. */
export function wrap(text: string, w: number, maxLines = Number.MAX_SAFE_INTEGER): string[] {
  if (w <= 0 || maxLines <= 0) return [];
  const lines: string[] = [];

  for (const para of text.split(/\n/)) {
    const words = para.split(/\s+/).filter((x) => x !== '');
    if (words.length === 0) {
      // Preserve the blank line between paragraphs, but never lead with one
      // and never stack two together.
      if (lines.length > 0 && lines[lines.length - 1] !== '' && lines.length < maxLines) {
        lines.push('');
      }
      continue;
    }
    let line = '';
    for (const word of words) {
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= w) line = `${line} ${word}`;
      else {
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
    if (line !== '') {
      lines.push(line);
      if (lines.length === maxLines) return lines;
    }
  }
  return lines;
}

export function isDraft(doc: GhostDoc): boolean {
  return doc.status !== 'published' && doc.status !== 'sent';
}

export function dateOf(doc: GhostDoc): string {
  return (doc.publishedAt ?? doc.updatedAt).slice(0, 10);
}

/**
 * The bare words of a query, with filters and operators removed, for
 * highlighting matches in the article text.
 */
export function highlightTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .filter((t) => t !== '' && !/^(tag|before|after|status|type|title):/i.test(t))
    .map((t) => t.replace(/^[-"]+|["]+$/g, ''))
    .filter((t) => t.length >= 2);
}

const ESCAPE_REGEX = /[.*+?^${}()|[\]\\]/g;

/** Wrap every occurrence of any term in a highlight. Case insensitive. */
export function highlight(line: string, terms: string[]): string {
  if (terms.length === 0) return line;
  const pattern = terms.map((t) => t.replace(ESCAPE_REGEX, '\\$&')).join('|');
  let re: RegExp;
  try {
    re = new RegExp(`(${pattern})`, 'gi');
  } catch {
    return line;
  }
  return line.replace(re, `${C.mark}$1${C.reset}${C.dim}`);
}

export interface LayoutState {
  query: string;
  hits: SearchHit[];
  selected: number;
  /** Lines the article pane is scrolled down by. */
  previewOffset?: number;
}

export interface LayoutContext {
  site: string;
  notice?: string | null;
  flash?: string | null;
}

export interface Size {
  width: number;
  height: number;
}

/** Rows used by the header, query line, rule and footer. */
const CHROME_ROWS = 4;
/** Below this the article pane is dropped and the list gets the full width. */
const TWO_COLUMN_MIN_WIDTH = 64;

/** Width of the result list when both columns are shown. */
export function leftWidthFor(width: number): number {
  return Math.max(26, Math.min(58, Math.round(width * 0.44)));
}

/**
 * Which slice of the results to show so the selection stays on screen.
 * Exported because off-by-one scrolling is worth pinning down in a test.
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

/** The article pane contents for a hit, as plain unstyled lines. */
export function articleLines(hit: SearchHit, width: number): string[] {
  const doc = hit.doc;
  const out: string[] = [];
  out.push(...wrap(doc.title, width));
  const meta = [dateOf(doc), doc.type, ...(doc.tags.length > 0 ? [doc.tags.join(', ')] : [])];
  if (isDraft(doc)) meta.push(doc.status);
  out.push(meta.join('  ·  '));
  out.push(linkFor(doc));
  out.push('');

  const body = doc.plaintext.trim();
  if (body !== '') {
    out.push(...wrap(body, width));
    return out;
  }

  // No body text. Show the matched passage if there is one, and otherwise say
  // plainly that the post is empty rather than leaving the pane looking broken.
  const snip = hit.snippet.replace(/\s+/g, ' ').trim();
  out.push(...wrap(snip === '' ? 'This post has no body text.' : snip, width));
  return out;
}

function listRow(hit: SearchHit, isSel: boolean, w: number): string {
  const doc = hit.doc;
  const marker = isSel ? `${C.cyan}❯${C.reset}` : ' ';
  const date = `${C.dim}${dateOf(doc)}${C.reset}`;
  const draftTag = isDraft(doc) ? `${C.yellow}*${C.reset}` : '';

  const fixed = 3 + visibleWidth(date) + (draftTag === '' ? 0 : 1) + 2;
  const titleText = truncate(doc.title, Math.max(4, w - fixed));
  const styled = isSel ? `${C.bold}${titleText}${C.reset}` : titleText;

  const left = ` ${marker} ${styled}${draftTag}`;
  const spacer = Math.max(1, w - visibleWidth(left) - visibleWidth(date) - 1);
  return truncate(`${left}${' '.repeat(spacer)}${date} `, w);
}

export function layout(state: LayoutState, size: Size, ctx: LayoutContext): string[] {
  const w = Math.max(20, size.width);
  const h = Math.max(6, size.height);

  const twoColumn = w >= TWO_COLUMN_MIN_WIDTH;
  const leftW = twoColumn ? leftWidthFor(w) : w;
  const rightW = twoColumn ? w - leftW - 1 : 0;
  const bodyRows = Math.max(1, h - CHROME_ROWS);

  const lines: string[] = [];

  // Header
  const title = `${C.bold} GhostHunter${C.reset}`;
  const site = `${C.dim}${ctx.site} ${C.reset}`;
  const gap = Math.max(1, w - visibleWidth(title) - visibleWidth(site));
  lines.push(truncate(`${title}${' '.repeat(gap)}${site}`, w));

  // Query line
  const count = state.hits.length;
  const countText = `${C.dim}${count} ${count === 1 ? 'hit' : 'hits'}${C.reset}`;
  const typed = state.query === ''
    ? `${C.dim}type to search${C.reset}`
    : state.query;
  const prompt = `${C.cyan}❯${C.reset} ${typed}${C.green}▌${C.reset}`;
  const qGap = Math.max(1, w - 1 - visibleWidth(prompt) - visibleWidth(countText));
  lines.push(truncate(` ${prompt}${' '.repeat(qGap)}${countText}`, w));

  // Rule, with a junction where the divider starts
  lines.push(
    twoColumn
      ? `${C.dim}${'─'.repeat(leftW)}┬${'─'.repeat(Math.max(0, rightW))}${C.reset}`
      : `${C.dim}${'─'.repeat(w)}${C.reset}`,
  );

  // Result list
  const { start } = windowFor(state.selected, count, bodyRows);
  const visible = state.hits.slice(start, start + bodyRows);

  // Article pane
  const sel = state.hits[state.selected];
  const terms = highlightTerms(state.query);
  let article: string[] = [];
  if (twoColumn && sel !== undefined) {
    const all = articleLines(sel, Math.max(1, rightW - 2));
    const offset = Math.min(
      Math.max(0, state.previewOffset ?? 0),
      Math.max(0, all.length - bodyRows),
    );
    article = all.slice(offset, offset + bodyRows).map((l, i) => {
      const abs = offset + i;
      if (abs === 0) return ` ${C.bold}${l}${C.reset}`;
      if (abs === 1) return ` ${C.dim}${l}${C.reset}`;
      if (abs === 2) return ` ${C.cyan}${truncate(l, rightW - 1)}${C.reset}`;
      return ` ${C.dim}${highlight(l, terms)}${C.reset}`;
    });
  }

  for (let i = 0; i < bodyRows; i++) {
    const hit = visible[i];
    let leftCell: string;

    if (hit === undefined) {
      leftCell = ' '.repeat(leftW);
    } else {
      const isSel = start + i === state.selected;
      const row = pad(listRow(hit, isSel, leftW), leftW);
      leftCell = isSel ? `${C.invert}${row}${C.reset}` : row;
    }

    if (count === 0 && i === 0) {
      leftCell = pad(truncate(`   ${C.dim}No matches.${C.reset}`, leftW), leftW);
    }

    if (!twoColumn) {
      lines.push(truncate(leftCell, w));
      continue;
    }
    const rightCell = article[i] ?? '';
    lines.push(`${leftCell}${C.dim}│${C.reset}${truncate(rightCell, rightW)}`);
  }

  // Footer
  const keys = ctx.flash
    ? `${C.green} ${ctx.flash}${C.reset}`
    : ctx.notice
      ? `${C.yellow} ${ctx.notice}${C.reset}`
      : ` ${C.dim}↵ copy   ⌥↵ markdown   ^O open   ^E edit   ⇧↑↓ scroll   ^C quit${C.reset}`;
  lines.push(truncate(keys, w));

  return lines.slice(0, h);
}
