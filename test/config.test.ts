import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeSiteUrl,
  saveConfig,
  loadConfig,
  configDir,
  dbPath,
  getAdminKey,
} from '../src/config.ts';

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'ghosthunter-test-'));
  const prev = process.env.GHOSTHUNTER_HOME;
  process.env.GHOSTHUNTER_HOME = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.GHOSTHUNTER_HOME;
    else process.env.GHOSTHUNTER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test('normalizeSiteUrl adds https and strips trailing slashes and admin paths', () => {
  assert.equal(normalizeSiteUrl('birchtree.me'), 'https://birchtree.me');
  assert.equal(normalizeSiteUrl('https://birchtree.me/'), 'https://birchtree.me');
  assert.equal(normalizeSiteUrl('https://birchtree.me/ghost/'), 'https://birchtree.me');
  assert.equal(normalizeSiteUrl('https://birchtree.me/ghost/#/dashboard'), 'https://birchtree.me');
  assert.equal(normalizeSiteUrl('  http://localhost:2368  '), 'http://localhost:2368');
});

test('normalizeSiteUrl keeps a non-standard port', () => {
  assert.equal(normalizeSiteUrl('localhost:2368'), 'https://localhost:2368');
  assert.equal(normalizeSiteUrl('http://127.0.0.1:2368/ghost/'), 'http://127.0.0.1:2368');
});

test('normalizeSiteUrl rejects nonsense', () => {
  assert.throws(() => normalizeSiteUrl(''), /site URL/i);
  assert.throws(() => normalizeSiteUrl('   '), /site URL/i);
  assert.throws(() => normalizeSiteUrl('not a url'), /site URL/i);
});

test('config round-trips through disk', () => {
  withHome((home) => {
    assert.equal(loadConfig(), null);
    saveConfig({ siteUrl: 'https://birchtree.me' });
    assert.deepEqual(loadConfig(), { siteUrl: 'https://birchtree.me' });
    assert.ok(configDir().startsWith(home));
    assert.ok(dbPath().startsWith(home));
  });
});

test('the config file is written with owner-only permissions', () => {
  withHome(() => {
    saveConfig({ siteUrl: 'https://birchtree.me' });
    const mode = statSync(join(configDir(), 'config.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('a corrupt config file reads as null rather than throwing', () => {
  withHome(() => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), 'config.json'), '{ broken');
    assert.equal(loadConfig(), null);
  });
});

test('a config file missing siteUrl reads as null', () => {
  withHome(() => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), 'config.json'), '{"other":1}');
    assert.equal(loadConfig(), null);
  });
});

test('GHOSTHUNTER_DB overrides the database path', () => {
  withHome(() => {
    const prev = process.env.GHOSTHUNTER_DB;
    process.env.GHOSTHUNTER_DB = '/tmp/custom-index.db';
    try {
      assert.equal(dbPath(), '/tmp/custom-index.db');
    } finally {
      if (prev === undefined) delete process.env.GHOSTHUNTER_DB;
      else process.env.GHOSTHUNTER_DB = prev;
    }
  });
});

test('getAdminKey prefers the environment variable', () => {
  const prev = process.env.GHOSTHUNTER_ADMIN_KEY;
  process.env.GHOSTHUNTER_ADMIN_KEY = 'abc:def';
  try {
    assert.equal(getAdminKey(), 'abc:def');
  } finally {
    if (prev === undefined) delete process.env.GHOSTHUNTER_ADMIN_KEY;
    else process.env.GHOSTHUNTER_ADMIN_KEY = prev;
  }
});
