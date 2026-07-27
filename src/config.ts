import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Keychain coordinates for the Admin API key. */
const KEYCHAIN_ACCOUNT = 'ghosthunter';
const KEYCHAIN_SERVICE = 'ghosthunter-admin-key';

export interface Config {
  siteUrl: string;
}

export function configDir(): string {
  return process.env['GHOSTHUNTER_HOME'] ?? join(homedir(), '.config', 'ghosthunter');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function dbPath(): string {
  return process.env['GHOSTHUNTER_DB'] ?? join(configDir(), 'index.db');
}

/**
 * Accepts what a person would actually paste: a bare domain, a URL with a
 * trailing slash, or the admin URL they were already looking at. Returning
 * `origin` discards `/ghost/`, hash routes, and trailing slashes in one move.
 */
export function normalizeSiteUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('That does not look like a valid site URL.');
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like a valid site URL.');
  }

  if (url.hostname === '' || url.hostname.includes(' ')) {
    throw new Error('That does not look like a valid site URL.');
  }

  return url.origin;
}

export function loadConfig(): Config | null {
  let text: string;
  try {
    text = readFileSync(configPath(), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['siteUrl'] === 'string'
    ) {
      return { siteUrl: (parsed as Record<string, unknown>)['siteUrl'] as string };
    }
  } catch {
    // A corrupt file is recoverable by running init again, so it is not fatal.
  }
  return null;
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The Admin key, from the environment if set, otherwise the macOS Keychain.
 * The env var exists so tests and non-macOS platforms have a path that does not
 * touch the real Keychain.
 */
export function getAdminKey(): string | null {
  const fromEnv = process.env['GHOSTHUNTER_ADMIN_KEY'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  if (process.platform !== 'darwin') return null;

  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const key = out.trim();
    return key === '' ? null : key;
  } catch {
    // A non-zero exit means the item is not in the Keychain.
    return null;
  }
}

export function setAdminKey(key: string): void {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Storing the key requires macOS. On other platforms set GHOSTHUNTER_ADMIN_KEY instead.',
    );
  }

  // execFile rather than exec: the key never passes through a shell, so it
  // cannot leak into a command line another process could read.
  execFileSync(
    'security',
    [
      'add-generic-password',
      '-a', KEYCHAIN_ACCOUNT,
      '-s', KEYCHAIN_SERVICE,
      '-w', key,
      '-U',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
}
