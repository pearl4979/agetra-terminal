import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = fileURLToPath(new URL('../scripts/launch-windows.mjs', import.meta.url));

async function unusedPort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function start(t, port, args = ['--demo']) {
  const child = spawn(process.execPath, [launcher, '--no-open', ...args], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ENABLE_LIVE_TRADING: 'true', BSC_RPC_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  return { child, output: () => output };
}

async function session(port, process) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) assert.fail(`Launcher exited before ready: ${process.output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return response.json();
    } catch {}
    await delay(80);
  }
  assert.fail(`Launcher did not become ready: ${process.output()}`);
}

test('portable demo starts and a second launch reuses the existing panel', async t => {
  const port = await unusedPort();
  const first = start(t, port);
  assert.equal((await session(port, first)).mode, 'demo');
  const second = start(t, port);
  const [code] = await once(second.child, 'exit');
  assert.equal(code, 0, second.output());
  assert.match(second.output(), /already running/i);
  assert.equal((await session(port, first)).mode, 'demo');
});

test('portable live launch overrides an inherited real trading flag', async t => {
  const port = await unusedPort();
  const process = start(t, port, []);
  const state = await session(port, process);
  assert.equal(state.mode, 'live');
  assert.equal(state.liveExecution, false);
});

test('portable launch reports an occupied port without replacing another service', async t => {
  const other = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise(resolve => { other.closeAllConnections(); other.close(resolve); }));
  const port = other.address().port;
  const process = start(t, port);
  const [code] = await once(process.child, 'exit');
  assert.equal(code, 1, process.output());
  assert.match(process.output(), /port.*in use/i);
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
});
