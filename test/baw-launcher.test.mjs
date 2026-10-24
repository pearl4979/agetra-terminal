import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBaw } from '../src/baw.mjs';

const unconnected = { status: 'UNCONNECTED' };
const response = () => ({ stdout: JSON.stringify({ success: true, data: unconnected }), stderr: '' });

test('default local CLI starts from a path containing spaces without a shell', async t => {
  const root = await mkdtemp(join(tmpdir(), 'baw launcher '));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const modulePath = join(root, 'src', 'baw.mjs');
  const entry = join(root, 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js');
  const shim = join(root, 'node_modules', '.bin', 'baw');
  await Promise.all([mkdir(dirname(modulePath), { recursive: true }), mkdir(dirname(entry), { recursive: true }), mkdir(dirname(shim), { recursive: true })]);
  await copyFile(new URL('../src/baw.mjs', import.meta.url), modulePath);
  await writeFile(entry, `
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['wallet', 'status', '--json'])) process.exit(2);
console.log(JSON.stringify({ success: true, data: { status: 'UNCONNECTED' } }));
`);
  // npm's POSIX shim is present on Windows but cannot be execFile's executable.
  await writeFile(shim, '#!/bin/sh\nexec node "$(dirname "$0")/../@binance/agentic-wallet/dist/index.js" "$@"\n');
  await chmod(shim, 0o755);
  const { createBaw: createIsolatedBaw } = await import(pathToFileURL(modulePath).href);
  const previous = process.env.BAW_BIN;
  let baw;
  try {
    delete process.env.BAW_BIN;
    baw = createIsolatedBaw();
  } finally {
    if (previous === undefined) delete process.env.BAW_BIN;
    else process.env.BAW_BIN = previous;
  }
  assert.deepEqual(await baw.status(), unconnected);
});

test('explicit executable overrides retain their argument array and shell isolation', async () => {
  for (const binary of ['/trusted path/baw', process.execPath]) {
    const baw = createBaw({ binary, run: async (actual, args, options) => {
      assert.equal(actual, binary);
      assert.deepEqual(args, ['wallet', 'status', '--json']);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      return response();
    } });
    assert.deepEqual(await baw.status(), unconnected);
  }
});

test('BAW_BIN still overrides the bundled CLI', async () => {
  const previous = process.env.BAW_BIN;
  try {
    process.env.BAW_BIN = '/trusted path/override';
    const baw = createBaw({ run: async (binary, args, options) => {
      assert.equal(binary, process.env.BAW_BIN);
      assert.deepEqual(args, ['wallet', 'status', '--json']);
      assert.equal(options.shell, false);
      return response();
    } });
    assert.deepEqual(await baw.status(), unconnected);
  } finally {
    if (previous === undefined) delete process.env.BAW_BIN;
    else process.env.BAW_BIN = previous;
  }
});
