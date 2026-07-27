import readline from 'node:readline';
import { linkFor } from './types.ts';
import type { GhostDoc, PickerAction, SearchHit } from './types.ts';

/** Rows of results shown at once. */
const VISIBLE_ROWS = 10;

export interface PickerState {
  query: string;
  hits: SearchHit[];
  selected: number;
}

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export interface PickerResult {
  state: PickerState;
  action?: PickerAction;
  /** True when the query changed and results need refreshing. */
  requery: boolean;
}

export function markdownLink(doc: GhostDoc): string {
  const title = doc.title.replaceAll('[', '\\[').replaceAll(']', '\\]');
  return `[${title}](${linkFor(doc)})`;
}

function clamp(n: number, max: number): number {
  if (max < 0) return 0;
  return Math.min(Math.max(n, 0), max);
}

/**
 * All picker decisions live here as a pure function, so the behaviour is fully
 * testable without a terminal. `runPicker` only draws and delegates.
 */
export function handleKey(state: PickerState, key: Key): PickerResult {
  const maxIndex = state.hits.length - 1;
  const selected = clamp(state.selected, maxIndex);
  const current = state.hits[selected]?.doc;

  const stay = (over: Partial<PickerState> = {}): PickerResult => ({
    state: { ...state, selected, ...over },
    requery: false,
  });

  const emit = (action: PickerAction): PickerResult => ({
    state: { ...state, selected },
    action,
    requery: false,
  });

  const name = key.name ?? '';

  if (name === 'escape' || (key.ctrl && name === 'c')) {
    return emit({ kind: 'cancel' });
  }

  if (name === 'down' || (key.ctrl && name === 'n')) {
    return stay({ selected: clamp(selected + 1, maxIndex) });
  }
  if (name === 'up' || (key.ctrl && name === 'p')) {
    return stay({ selected: clamp(selected - 1, maxIndex) });
  }

  if (name === 'return' || name === 'enter') {
    if (current === undefined) return emit({ kind: 'cancel' });
    return emit({ kind: key.meta ? 'copy-markdown' : 'copy-url', doc: current });
  }

  // Ctrl+L duplicates Option+Enter because some terminals swallow Option+Enter
  // depending on how "Use Option as Meta" is configured.
  if (key.ctrl && name === 'l') {
    if (current === undefined) return emit({ kind: 'cancel' });
    return emit({ kind: 'copy-markdown', doc: current });
  }
  if (key.ctrl && name === 'o') {
    if (current === undefined) return emit({ kind: 'cancel' });
    return emit({ kind: 'open', doc: current });
  }
  if (key.ctrl && name === 'e') {
    if (current === undefined) return emit({ kind: 'cancel' });
    return emit({ kind: 'edit', doc: current });
  }

  if (key.ctrl && name === 'u') {
    return { state: { ...state, query: '', selected: 0 }, requery: true };
  }

  if (name === 'backspace') {
    if (state.query === '') return stay();
    return {
      state: { ...state, query: state.query.slice(0, -1), selected: 0 },
      requery: true,
    };
  }

  // Printable input only: one character, no modifiers, not a control code.
  const seq = key.sequence ?? '';
  if (!key.ctrl && !key.meta && seq.length === 1 && seq.codePointAt(0)! >= 32) {
    return {
      state: { ...state, query: state.query + seq, selected: 0 },
      requery: true,
    };
  }

  return stay();
}

function formatDate(doc: GhostDoc): string {
  const raw = doc.publishedAt ?? doc.updatedAt;
  return raw.slice(0, 10);
}

function render(state: PickerState, stale: string | null): string {
  const lines: string[] = [];
  const count = state.hits.length;
  lines.push(`\x1b[1m> ${state.query}\x1b[0m  \x1b[2m(${count} ${count === 1 ? 'hit' : 'hits'})\x1b[0m`);

  const maxIndex = state.hits.length - 1;
  const selected = clamp(state.selected, maxIndex);

  // Scroll the window so the selection stays visible.
  const start = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), count - VISIBLE_ROWS));
  const window = state.hits.slice(Math.max(0, start), Math.max(0, start) + VISIBLE_ROWS);

  window.forEach((h, i) => {
    const index = Math.max(0, start) + i;
    const marker = index === selected ? '\x1b[36m❯\x1b[0m' : ' ';
    const isDraft = h.doc.status !== 'published' && h.doc.status !== 'sent';
    const tag = isDraft ? ` \x1b[33m[${h.doc.status}]\x1b[0m` : '';
    const title = index === selected ? `\x1b[1m${h.doc.title}\x1b[0m` : h.doc.title;
    lines.push(`${marker} ${title}${tag}  \x1b[2m${formatDate(h.doc)}\x1b[0m`);
  });

  if (count === 0) {
    lines.push('\x1b[2m  No matches.\x1b[0m');
  } else {
    const snip = state.hits[selected]?.snippet.replaceAll(/\s+/g, ' ').trim() ?? '';
    if (snip !== '') lines.push(`\x1b[2m  ${snip.slice(0, 200)}\x1b[0m`);
  }

  if (stale !== null) lines.push(`\x1b[33m  ${stale}\x1b[0m`);
  lines.push('\x1b[2m  enter copy URL   opt-enter or ^L markdown link   ^O open   ^E edit   esc quit\x1b[0m');

  return lines.join('\n');
}

export interface RunPickerOptions {
  initialQuery: string;
  run: (query: string) => SearchHit[];
  /** Shown as a warning line, for example when the index could not refresh. */
  notice?: string | null;
}

/**
 * Draw the picker and drive it until the user picks something or quits.
 * Rendering goes to stderr so stdout stays clean for piping.
 */
export async function runPicker(opts: RunPickerOptions): Promise<PickerAction> {
  const out = process.stderr;
  let state: PickerState = {
    query: opts.initialQuery,
    hits: opts.run(opts.initialQuery),
    selected: 0,
  };

  let lastHeight = 0;
  const draw = (): void => {
    if (lastHeight > 0) out.write(`\x1b[${lastHeight}A\x1b[0J`);
    const frame = render(state, opts.notice ?? null);
    out.write(`${frame}\n`);
    lastHeight = frame.split('\n').length;
  };

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw === true;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  draw();

  try {
    return await new Promise<PickerAction>((resolve) => {
      const onKeypress = (_str: string, key: Key | undefined): void => {
        if (key === undefined) return;

        const result = handleKey(state, key);
        state = result.state;

        if (result.requery) {
          state = { ...state, hits: opts.run(state.query), selected: 0 };
        }

        if (result.action !== undefined) {
          process.stdin.off('keypress', onKeypress);
          resolve(result.action);
          return;
        }
        draw();
      };
      process.stdin.on('keypress', onKeypress);
    });
  } finally {
    // Always restore the terminal, even if something above threw.
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
    if (lastHeight > 0) out.write(`\x1b[${lastHeight}A\x1b[0J`);
  }
}
