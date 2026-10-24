import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { manifest } from './protocol.mjs';

export const DEFAULT_RPC_URL = 'https://rpc-bsc.48.club';

export function validateRpcUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\t]/.test(value)) throw new Error('请输入有效的 HTTPS RPC 地址');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入有效的 HTTPS RPC 地址'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw new Error('请使用 HTTPS RPC 地址，API Key 可放在路径或查询参数中');
  return url.href;
}

export function maskRpcUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname !== '/' ? '/••••' : ''}${url.search ? '?••••' : ''}`;
  } catch { return '已配置节点'; }
}

// 只进行只读 RPC 请求；不回传节点响应正文或包含密钥的错误内容。
export async function probeRpc(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let requestId = 0;
  async function call(method, params = []) {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    });
    if (!response.ok) throw new Error('节点连接失败，请检查地址、API Key 或服务额度');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('节点返回数据异常');
    const chunks = [];
    let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new Error('timeout');
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) { cancel(); throw new Error('节点返回数据异常'); }
        chunks.push(Buffer.from(value));
      }
    } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    const text = Buffer.concat(chunks, size).toString('utf8');
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('节点没有返回有效的 JSON-RPC 响应'); }
    if (data.error || data.id !== requestId || data.jsonrpc !== '2.0' || !Object.hasOwn(data, 'result')) throw new Error('节点不支持所需查询，或 API Key / 服务额度不可用');
    return data.result;
  }
  try {
    const chain = await call('eth_chainId');
    if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 56n) throw new Error('请选择 BNB Smart Chain 主网节点（Chain ID 56）');
    const block = await call('eth_blockNumber');
    if (typeof block !== 'string' || !/^0x[0-9a-f]+$/i.test(block) || BigInt(block) <= 0n || BigInt(block) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('节点返回的最新区块无效');
    const logs = await call('eth_getLogs', [{ address: manifest.core, fromBlock: block, toBlock: block, topics: [] }]);
    if (!Array.isArray(logs)) throw new Error('节点不支持日志读取');
    return { chainId: 56, blockNumber: Number(BigInt(block)), latencyMs: Math.round(performance.now() - started), logsSupported: true };
  } catch (error) {
    if (signal.aborted) throw new Error('节点连接超时，请检查网络或更换 RPC');
    // Only our fixed messages may reach the UI; transport errors can contain URLs.
    if (error instanceof Error && /^(节点|请选择)/.test(error.message) && !error.message.includes(url)) throw error;
    throw new Error('无法连接节点，请检查 HTTPS 地址、API Key 和网络');
  }
}

export async function createRpcSettings({ file, envUrl, probe = probeRpc, onApply = async (_url, persist) => persist() }) {
  let saved = null;
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.mode !== 'default' && data.mode !== 'custom') throw new Error('invalid mode');
    saved = data.mode === 'custom' ? { mode: 'custom', url: validateRpcUrl(data.url) } : { mode: 'default' };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('本机 RPC 配置不可读，请检查 .runtime/rpc-settings.json');
  }
  let currentUrl = saved ? saved.mode === 'custom' ? saved.url : DEFAULT_RPC_URL : envUrl || DEFAULT_RPC_URL;
  let mode = saved?.mode ?? (currentUrl === DEFAULT_RPC_URL ? 'default' : 'custom');
  let busy = false;
  const snapshot = () => ({ mode, displayUrl: maskRpcUrl(currentUrl), hasCustomUrl: mode === 'custom', source: saved ? 'local' : envUrl && envUrl !== DEFAULT_RPC_URL ? 'environment' : 'default' });
  function candidate(input) {
    if (!input || Object.keys(input).some(k => !['mode', 'url'].includes(k)) || !['default', 'custom'].includes(input.mode)) throw new Error('RPC 配置格式无效');
    if (input.url !== undefined && typeof input.url !== 'string') throw new Error('RPC 地址必须为文本');
    const url = input.mode === 'default' ? DEFAULT_RPC_URL : validateRpcUrl(input.url?.trim() || (mode === 'custom' ? currentUrl : ''));
    return { mode: input.mode, url };
  }
  async function store(data) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  return {
    snapshot, getUrl: () => currentUrl,
    async test(input) {
      if (busy) throw new Error('RPC 正在切换，请稍后再试');
      return probe(candidate(input).url);
    },
    async apply(input) {
      if (busy) throw new Error('RPC 正在切换，请稍后再试');
      const next = candidate(input);
      busy = true;
      let persisted = false;
      try {
        const check = await probe(next.url);
        const nextSaved = next.mode === 'custom' ? next : { mode: 'default' };
        await onApply(next.url, async () => { await store(nextSaved); persisted = true; });
        if (!persisted) throw new Error('not persisted');
        saved = nextSaved; mode = next.mode; currentUrl = next.url;
        return { ...snapshot(), check };
      } catch (error) {
        if (persisted) {
          if (saved) await store(saved);
          else await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
        }
        if (error instanceof Error && /^(节点|请选择|无法连接|RPC|请输入|请使用)/.test(error.message) && !error.message.includes(next.url)) throw error;
        throw new Error('RPC 未应用，请检查节点或本地配置文件的写入权限');
      } finally { busy = false; }
    },
  };
}
