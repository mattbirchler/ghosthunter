import readline from 'node:readline';
import { linkFor } from './types.ts';
import { layout } from './layout.ts';
import type { GhostDoc, PickerAction, SearchHit } from './types.ts';

/** Lines the article pane moves per scroll keypress. */
const PREVIEW_SCROLL_LINES = 5;

export interface PickerState {
  query: string;
  hits: SearchHit[];
  selected: number;
  /** Lines the article pane is scrolled down by. */
  previewOffset: number;
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
  const offset = state.previewOffset ?? 0;

  if (name === 'escape' || (key.ctrl && name === 'c')) {
    return emit({ kind: 'cancel' });
  }

  // Shift with the arrows scrolls the article pane. Page keys do the same, for
  // keyboards where shift-arrow is intercepted.
  if ((key.shift && name === 'down') || name === 'pagedown') {
    return stay({ previewOffset: offset + PREVIEW_SCROLL_LINES });
  }
  if ((key.shift && name === 'up') || name === 'pageup') {
    return stay({ previewOffset: Math.max(0, offset - PREVIEW_SCROLL_LINES) });
  }

  // Changing the selection always resets the article back to the top.
  if (name === 'down' || (key.ctrl && name === 'n')) {
    return stay({ selected: clamp(selected + 1, maxIndex), previewOffset: 0 });
  }
  if (name === 'up' || (key.ctrl && name === 'p')) {
    return stay({ selected: clamp(selected - 1, maxIndex), previewOffset: 0 });
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
    return { state: { ...state, query: '', selected: 0, previewOffset: 0 }, requery: true };
  }

  if (name === 'backspace') {
    if (state.query === '') return stay();
    return {
      state: { ...state, query: state.query.slice(0, -1), selected: 0, previewOffset: 0 },
      requery: true,
    };
  }

  // Printable input only: one character, no modifiers, not a control code.
  const seq = key.sequence ?? '';
  if (!key.ctrl && !key.meta && seq.length === 1 && seq.codePointAt(0)! >= 32) {
    return {
      state: { ...state, query: state.query + seq, selected: 0, previewOffset: 0 },
      requery: true,
    };
  }

  return stay();
}

/** Handle given to the caller so background work can update a live picker. */
export interface PickerControl {
  /** Re-run the current query and redraw, optionally flashing a message. */
  refresh: (flash?: string) => void;
  /** Replace the footer message without re-running the query. */
  setNotice: (notice: string | null) => void;
}

export interface RunPickerOptions {
  initialQuery: string;
  run: (query: string) => SearchHit[];
  /** The site the index was built from, shown in the header. */
  site: string;
  /** Shown in the footer, for example when the index could not refresh. */
  notice?: string | null;
  /** Called once the picker is on screen, for kicking off background work. */
  onReady?: (control: PickerControl) => void;
  /**
   * Perform a chosen action. The picker stays open afterwards, so several
   * links can be copied in one session. Return a message to flash in the
   * footer as confirmation.
   */
  onAction?: (action: PickerAction) => string | null | void;
}

/** How long a flash message stays in the footer. */
const FLASH_MS = 4000;

/** Terminal control sequences for a full screen application. */
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR_BELOW = '\x1b[0J';
const ERASE_LINE = '\x1b[K';

const FALLBACK_SIZE = { width: 80, height: 24 };

/**
 * Draw the full screen picker and run until the user quits with ^C or escape.
 * Actions are performed through `onAction` without closing, so several links
 * can be copied in one session.
 *
 * Uses the alternate screen buffer, so the terminal is left exactly as it was
 * found: no scrollback is consumed and the previous contents come back on exit.
 * All layout is delegated to the pure `layout` function.
 */
export async function runPicker(opts: RunPickerOptions): Promise<void> {
  const out = process.stderr;
  let state: PickerState = {
    query: opts.initialQuery,
    hits: opts.run(opts.initialQuery),
    selected: 0,
    previewOffset: 0,
  };

  let notice: string | null = opts.notice ?? null;
  let flash: string | null = null;
  let flashTimer: NodeJS.Timeout | null = null;
  let finished = false;

  // A terminal that reports 0 is as useless as one that reports nothing, and
  // some pseudo terminals do report 0, so fall back on any falsy value.
  const size = (): { width: number; height: number } => ({
    width: process.stdout.columns || FALLBACK_SIZE.width,
    height: process.stdout.rows || FALLBACK_SIZE.height,
  });

  const draw = (): void => {
    if (finished) return;
    const frame = layout(state, size(), { site: opts.site, notice, flash });
    // Every line is erased to its end before the next is drawn. Without this a
    // shorter line leaves the tail of the previous frame on screen, which shows
    // up as stale article text next to a short post. Lines end with \r\n
    // because raw mode does not translate \n into a carriage return.
    const body = frame.map((l) => `${l}${ERASE_LINE}`).join('\r\n');
    out.write(`${HOME}${body}${CLEAR_BELOW}`);
  };

  const setFlash = (message: string): void => {
    flash = message;
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      draw();
    }, FLASH_MS);
    flashTimer.unref?.();
  };

  const control: PickerControl = {
    refresh: (message?: string) => {
      if (finished) return;
      // Keep the caret where it is: re-run the query the user currently has.
      const hits = opts.run(state.query);
      const selected = Math.min(state.selected, Math.max(0, hits.length - 1));
      state = { ...state, hits, selected };
      if (message !== undefined) setFlash(message);
      draw();
    },
    setNotice: (next: string | null) => {
      notice = next;
      draw();
    },
  };

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw === true;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  out.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
  const onResize = (): void => draw();
  process.stdout.on('resize', onResize);
  draw();

  /**
   * Put the terminal back. Idempotent, because it runs both on the normal exit
   * path and from a signal handler. A TUI that dies without doing this leaves
   * the user staring at an alternate screen with no cursor.
   */
  const restore = (): void => {
    if (finished) return;
    finished = true;
    if (flashTimer !== null) clearTimeout(flashTimer);
    process.stdout.off('resize', onResize);
    out.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
  };

  // Raw mode normally delivers ^C as a keypress rather than a signal, but if a
  // signal does arrive the terminal still has to be handed back.
  const onSignal = (): void => {
    restore();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);

  opts.onReady?.(control);

  try {
    await new Promise<void>((resolve) => {
      const onKeypress = (_str: string, key: Key | undefined): void => {
        if (key === undefined) return;

        const result = handleKey(state, key);
        state = result.state;

        if (result.requery) {
          state = { ...state, hits: opts.run(state.query), selected: 0 };
        }

        if (result.action !== undefined) {
          // Quitting is the only action that ends the session. Everything else
          // is performed in place so more than one link can be copied.
          if (result.action.kind === 'cancel') {
            process.stdin.off('keypress', onKeypress);
            resolve();
            return;
          }
          const message = opts.onAction?.(result.action);
          if (typeof message === 'string' && message !== '') setFlash(message);
        }
        draw();
      };
      process.stdin.on('keypress', onKeypress);
    });
  } finally {
    // Always restore the terminal, even if something above threw.
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    restore();
  }
}
