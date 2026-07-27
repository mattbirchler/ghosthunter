import { execFileSync } from 'node:child_process';

/** Put text on the system clipboard. macOS only, which matches the Keychain use. */
export function copyToClipboard(text: string): void {
  execFileSync('pbcopy', { input: text });
}

/** Hand a URL to the default browser. */
export function openInBrowser(url: string): void {
  execFileSync('open', [url]);
}
