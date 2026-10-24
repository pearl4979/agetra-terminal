import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { formatEther } from 'ethers';
import { guardRequest, readJson } from './security.mjs';
import { createTradeService } from './trades.mjs';
import { createDemo } from './demo.mjs';
import { createAuthService } from './auth.mjs';
import { expiryMs } from './baw.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

export function createHttpServer({ monitor, baw, trades, protocol, metadata, demo = false, liveExecution = false }) {
  const csrf = randomBytes(32).toString('hex');
  let walletCache;
  let walletTime = 0;
  let walletPending;
  let walletGeneration = 0;
  let previewPending = false;
  let previewTime = 0;
  let executionRevision = 0;
  function invalidateWallet() { walletTime = 0; walletGeneration++; }
  const auth = !demo && baw.authStart ? createAuthService({ baw, onConnected: () => { invalidateWallet(); trades.setLiveExecution(false); executionRevision++; } }) : null;
  const executionEnabled = () => demo || (trades.isLiveExecution?.() ?? liveExecution);
  async function wallet(refresh = false) {
    if (refresh) invalidateWallet();
    if (walletCache && Date.now() - walletTime < 30_000) return walletCache;
    if (walletPending?.generation === walletGeneration) return walletPending.promise;
    const generation = walletGeneration;
    const promise = (async () => {
      const data = await baw.wallet();
      // CLI会按价格过滤低余额资产；链上原生BNB余额更准确，空列表不等于0。
      if (data.address && protocol.provider) {
        try { data.balance = formatEther(await protocol.provider.getBalance(data.address)); data.balanceSource = 'BSC eth_getBalance'; }
        catch (e) { data.balanceError = e.shortMessage || e.message; }
      }
      if (generation === walletGeneration) { walletCache = data; walletTime = Date.now(); }
      return data;
    })().finally(() => { if (walletPending?.generation === generation) walletPending = null; });
    walletPending = { generation, promise };
    return promise;
  }
  async function verifiedToken(address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) return null;
    return (await monitor.snapshot()).tokens.find(t => t.verified === true && t.address.toLowerCase() === address.toLowerCase());
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'none'");
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try { guardRequest(req, { port: server.address().port, csrf }); }
    catch (e) { return send(403, { error: e.message }); }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET') {
        if (path === '/api/session') return send(200, { csrf, mode: demo ? 'demo' : 'live', liveExecution: executionEnabled(), mev: { status: 'unverified', label: '防夹未验证', description: '当前 baw contract-call 广播通道未披露 MEV 保护；滑点与重新估价不等于防夹。' } });
        if (path === '/api/tokens') {
          const snapshot = await monitor.snapshot();
          return send(200, { ...snapshot, tokens: snapshot.tokens.map(t => ({ ...t, imageUrl: t.imageUrl || `/api/token-image/${t.address}`, imageSource: t.imageSource || 'Four.meme / 链上元数据', metadataStatus: t.metadataStatus || 'on-demand' })) });
        }
        if (path === '/api/wallet') return send(200, await wallet(url.searchParams.get('refresh') === '1'));
        if (path === '/api/auth/status') return send(200, demo ? { status: 'CONNECTED', message: '演示钱包，无需登录' } : auth?.snapshot() ?? { status: 'UNAVAILABLE', message: '认证模块不可用' });
        if (path === '/api/positions') {
          const token = await verifiedToken(url.searchParams.get('token'));
          if (!token) return send(404, { error: '仅支持已核验的专属模板代币' });
          const w = await wallet();
          if (!w.address) throw new Error('请先连接 Agentic Wallet');
          return send(200, { ...await protocol.positions(token.address, w.address), updatedAt: new Date().toISOString() });
        }
        if (path.startsWith('/api/token-image/')) {
          const token = await verifiedToken(path.slice('/api/token-image/'.length));
          if (!token || !metadata) return send(404, { error: '没有可用的代币图片' });
          const image = await metadata.getImage(token.address, token);
          if (!image) return send(404, { error: '没有可用的代币图片' });
          res.writeHead(200, { 'Content-Type': image.contentType, 'Cache-Control': image.cacheControl || 'private, max-age=300' }); return res.end(image.body);
        }
        if (path === '/api/orders') return send(200, { orders: trades.list() });
        if (/^\/assets\/[a-zA-Z0-9_-]+\.svg$/.test(path)) {
          try { const image = await readFile(resolve(root, 'public', path.slice(1))); res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' }); return res.end(image); }
          catch { return send(404, { error: '图片不存在' }); }
        }
        if (assets[path]) {
          const [file, type] = assets[path];
          const content = await readFile(resolve(root, 'public', file));
          res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
        }
      }
      if (req.method === 'POST' && path === '/api/auth/start') {
        await readJson(req);
        if (demo) return send(200, { status: 'CONNECTED', message: '演示模式无需登录' });
        if (!auth) throw new Error('认证模块不可用');
        return send(200, await auth.start());
      }
      if (req.method === 'POST' && path === '/api/settings/execution') {
        const body = await readJson(req);
        if (Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new Error('enabled 必须为布尔值');
        if (demo) return send(200, { liveExecution: true, message: '演示模式不会签名或广播' });
        const revision = ++executionRevision;
        if (body.enabled) {
          const w = await wallet(true);
          if (w.status !== 'CONNECTED' || !w.address) throw new Error('请先连接 Binance Agentic Wallet');
          if (!w.devMode?.enabled || (expiryMs(w.devMode.expiresAt) ?? 0) <= Date.now()) throw new Error('请在 Binance App 开启有效的 Developer Mode，然后刷新钱包');
          if (w.devMode.balanceExceeded) throw new Error('Developer Mode 钱包余额超过 App 设置的上限');
          if (revision !== executionRevision) throw new Error('开关状态已经改变，请重新操作');
        }
        trades.setLiveExecution(body.enabled);
        return send(200, { liveExecution: executionEnabled() });
      }
      if (req.method === 'POST' && path === '/api/preview') {
        if (previewPending || Date.now() - previewTime < 1500) return send(429, { error: '预览正在处理中或请求过快，请稍后再试' });
        previewPending = true; previewTime = Date.now();
        try { return send(200, await trades.preview(await readJson(req))); }
        finally { previewPending = false; }
      }
      if (req.method === 'POST' && path === '/api/execute') {
        const result = await trades.execute(await readJson(req)); invalidateWallet(); return send(200, result);
      }
      if (req.method === 'POST' && path === '/api/orders/link') return send(200, await trades.linkTransaction(await readJson(req)));
      if (req.method === 'POST' && path === '/api/orders/release') return send(200, await trades.releaseOrder(await readJson(req)));
      return send(404, { error: '接口不存在' });
    } catch (e) { send(400, { error: e.message, ...(e.cliError ? { cliError: e.cliError } : {}) }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close', () => auth?.stop());
  return server;
}

export async function main() {
  const demo = process.argv.includes('--demo');
  const liveExecution = !demo && process.env.ENABLE_LIVE_TRADING === 'true';
  const port = Number(process.env.PORT || (demo ? 4319 : 4318));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024–65535');
  let deps;
  if (demo) deps = createDemo();
  else {
    const [{ createProtocol }, { createMonitor }, { createBaw }, { createMetadataService }] = await Promise.all([import('./protocol.mjs'), import('./monitor.mjs'), import('./baw.mjs'), import('./metadata.mjs')]);
    const protocol = createProtocol({ rpcUrl: process.env.BSC_RPC_URL || 'https://rpc-bsc.48.club' });
    deps = { protocol, monitor: createMonitor({ protocol }), baw: createBaw(), metadata: createMetadataService() };
  }
  const trades = createTradeService({ ...deps, demo, liveExecution, journalPath: resolve(root, '.runtime', demo ? 'orders-demo.json' : 'orders.json') });
  const server = createHttpServer({ ...deps, trades, demo, liveExecution });
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Agetra Terminal ${demo ? '[DEMO — 不发交易]' : '[LIVE DATA]'} http://127.0.0.1:${port}`);
    console.log(`实盘执行：${liveExecution ? '开启（仍需逐笔预览与确认）' : '关闭'}`);
    Promise.resolve(deps.monitor.start()).catch(e => console.error(`监控启动失败：${e.shortMessage || e.message}`));
  });
  const receiptTimer = setInterval(() => trades.refresh().catch(e => console.error(`订单状态：${e.shortMessage || e.message}`)), 5000);
  receiptTimer.unref();
  const stop = () => { clearInterval(receiptTimer); deps.monitor.stop(); deps.protocol.provider?.destroy(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { server, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
