import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const demo = process.argv.includes('--demo');
const port = Number(process.env.PORT || (demo ? 4319 : 4318));
const url = `http://127.0.0.1:${port}`;

async function existingPanel() {
  try {
    const response = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const session = await response.json();
    if (!/^[a-f0-9]{64}$/.test(session.csrf ?? '') || !['live', 'demo'].includes(session.mode)) return null;
    const home = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!(await home.text()).includes('<title>Agetra Terminal</title>')) return null;
    return session;
  } catch { return null; }
}

function openBrowser() {
  if (process.argv.includes('--no-open')) return;
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  browser.on('error', () => console.log(`Open this address in your browser: ${url}`));
  browser.unref();
}

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This portable package requires Windows x64.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
  process.chdir(root);
  const existing = await existingPanel();
  if (existing) {
    if (existing.mode !== (demo ? 'demo' : 'live')) throw new Error(`Port ${port} is in use by the other panel mode. Close that panel first.`);
    console.log(`Agetra Terminal is already running: ${url}`);
    openBrowser();
  } else {
    // A distribution must start with real trading off, including when a local .env enables it.
    process.env.ENABLE_LIVE_TRADING = 'false';
    process.env.PORT = String(port);
    const { main } = await import('../src/server.mjs');
    const app = await main();
    try {
      if (!app.server.listening) await once(app.server, 'listening');
    } catch (error) {
      if (error.code === 'EADDRINUSE') throw new Error(`Port ${port} is in use. Close the other application and try again.`);
      throw error;
    }
    console.log(`Ready: ${url}`);
    console.log(demo ? 'DEMO: all balances and orders are simulated.' : 'Real trading starts OFF.');
    console.log('Keep this window open. Close it or press Ctrl+C to stop.');
    openBrowser();
  }
} catch (error) {
  console.error(`Cannot start Agetra Terminal: ${error.message}`);
  process.exitCode = 1;
}
