import readline from 'node:readline';
import { linkFor } from './types.ts';
import { layout } from './layout.ts';
import type { GhostDoc, PickerAction, SearchHit } from './types.ts';

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

export interface RunPickerOptions {
  initialQuery: string;
  run: (query: string) => SearchHit[];
  /** The site the index was built from, shown in the header. */
  site: string;
  /** Shown in the footer, for example when the index could not refresh. */
  notice?: string | null;
}

/** Terminal control sequences for a full screen application. */
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR_BELOW = '\x1b[0J';

const FALLBACK_SIZE = { width: 80, height: 24 };

/**
 * Draw the full screen picker and drive it until the user picks or quits.
 *
 * Uses the alternate screen buffer, so the terminal is left exactly as it was
 * found: no scrollback is consumed and the previous contents come back on exit.
 * All layout is delegated to the pure `layout` function.
 */
export async function runPicker(opts: RunPickerOptions): Promise<PickerAction> {
  const out = process.stderr;
  let state: PickerState = {
    query: opts.initialQuery,
    hits: opts.run(opts.initialQuery),
    selected: 0,
  };

  const size = (): { width: number; height: number } => ({
    width: process.stdout.columns ?? FALLBACK_SIZE.width,
    height: process.stdout.rows ?? FALLBACK_SIZE.height,
  });

  const draw = (): void => {
    const frame = layout(state, size(), { site: opts.site, notice: opts.notice ?? null });
    out.write(`${HOME}${frame.join('\n')}${CLEAR_BELOW}`);
  };

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw === true;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  out.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
  const onResize = (): void => draw();
  process.stdout.on('resize', onResize);
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
    process.stdout.off('resize', onResize);
    out.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
  }
}
