#!/usr/bin/env node

// GhostHunter runs TypeScript directly using Node's native type stripping,
// which needs Node 26. Check before importing anything, because on an older
// runtime the import itself fails with an unhelpful syntax error.
const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (major < 26) {
  process.stderr.write(
    `GhostHunter needs Node 26 or newer. This is Node ${process.versions.node}.\n` +
      'Upgrade with: brew upgrade node\n',
  );
  process.exit(1);
}

const { main } = await import('../src/cli.ts');
process.exitCode = await main(process.argv.slice(2));
