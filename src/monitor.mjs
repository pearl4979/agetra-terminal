import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { formatUnits } from 'ethers';
import { manifest, decodeCreationTags } from './protocol.mjs';

const runtimeDir = fileURLToPath(new URL('../.runtime/', import.meta.url));
const errorText = (error) => error?.shortMessage ?? error?.message ?? String(error);

export function createMonitor({ protocol, persist = true, pollMs = 6000, chunkSize = 1000, maxChunks = 4 } = {}) {
  const file = `${runtimeDir}/monitor-v1.json`;
  let running = false, timer, busy = false;
  let lastBlock = manifest.deploymentBlock - 1;
  let events = new Map(), tokens = new Map();
  let status = 'idle', message = '尚未启动', updatedAt = null, head = null;
  const snapshot = () => ({ tokens: [...tokens.values()].filter(token => token.verified === true).sort((a, b) => (b.createBlock ?? 0) - (a.createBlock ?? 0)), monitor: { status, message, lastBlock, targetBlock: head, unavailable: [...tokens.values()].filter(token => token.verified !== true).length, updatedAt, templateId: manifest.templateId, registry: manifest.registry, manager: protocol.manager ?? manifest.core, confirmations: manifest.confirmations } });

  async function load() {
    if (!persist) return;
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.templateId !== manifest.templateId || saved.core !== manifest.core || !Number.isSafeInteger(saved.lastBlock)) return;
      lastBlock = Math.max(manifest.deploymentBlock - 1, saved.lastBlock);
      events = new Map(saved.events ?? []);
      tokens = new Map((saved.tokens ?? []).map((token) => [token.address.toLowerCase(), { ...token, tradable: false, reason: '等待刷新链上状态' }]));
    } catch (error) { if (error.code !== 'ENOENT') message = `缓存不可读，将从部署块补扫：${errorText(error)}`; }
  }

  async function save() {
    if (!persist) return;
    await mkdir(runtimeDir, { recursive: true });
    const data = { templateId: manifest.templateId, core: manifest.core, lastBlock, events: [...events], tokens: [...tokens.values()] };
    await writeFile(`${file}.tmp`, JSON.stringify(data));
    await rename(`${file}.tmp`, file);
  }

  async function scan(from, to) {
    // 两类事件全部成功返回后才替换此范围、推进游标。
    const [created, trades] = await Promise.all([
      protocol.provider.getLogs({ address: protocol.manager, fromBlock: from, toBlock: to, topics: [protocol.createdTopic, protocol.presetTopic] }),
      protocol.provider.getLogs({ address: protocol.manager, fromBlock: from, toBlock: to, topics: [protocol.tradeTopic, null, null, protocol.presetTopic] }),
    ]);
    const next = new Map(events);
    for (const [key, event] of next) if (event.blockNumber >= from && event.blockNumber <= to) next.delete(key);
    for (const log of [...created, ...trades]) {
      if (log.removed) continue;
      const parsed = protocol.coreInterface.parseLog(log);
      if (!parsed || String(parsed.args.presetId) !== manifest.templateId) continue;
      const args = parsed.args;
      const event = { type: parsed.name, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, index: log.index, token: args.token, presetId: String(args.presetId) };
      if (parsed.name === 'TokenCreated') {
        decodeCreationTags(args.encodedTags);
        Object.assign(event, { name: args.name, symbol: args.symbol, encodedTags: args.encodedTags, tokenMetaUri: args.tokenMetaUri });
      } else Object.assign(event, { volumeRaw: args.curveQuoteAmount.toString(), quoteAsset: args.quoteAsset });
      next.set(`${log.transactionHash}:${log.index}`, event);
    }
    events = next;
    lastBlock = Math.max(lastBlock, to);
  }

  async function refreshTokens() {
    const creations = new Map([...events.values()].filter((event) => event.type === 'TokenCreated').map((event) => [event.token.toLowerCase(), event]));
    // 重扫中消失的创建事件同时移除对应代币；不保留幽灵列表。
    for (const address of tokens.keys()) if (!creations.has(address)) tokens.delete(address);
    const volumes = new Map();
    for (const event of events.values()) {
      if (event.type === 'TradeExecuted' && event.quoteAsset.toLowerCase() === manifest.wrappedNative.toLowerCase()) volumes.set(event.token.toLowerCase(), (volumes.get(event.token.toLowerCase()) ?? 0n) + BigInt(event.volumeRaw));
    }
    let unavailable = 0;
    for (const [key, event] of creations) {
      try {
        if (event.encodedTags.toLowerCase() !== manifest.encodedTags.toLowerCase()) throw new Error('创建时模块标签与已核验模板不同');
        const state = await protocol.getTokenState(event.token, { blockTag: head });
        tokens.set(key, { ...state, tokenMetaUri: event.tokenMetaUri ?? null, createdAt: tokens.get(key)?.createdAt ?? null, creationTransaction: event.transactionHash, createBlock: event.blockNumber, volume: formatUnits(volumes.get(key) ?? 0n, 18), volumeLabel: '累计成交额（部署起已索引区间，BNB）' });
      } catch (error) {
        unavailable++;
        tokens.set(key, { address: event.token, name: event.name, symbol: event.symbol, price: null, progress: null, volume: null, volumeLabel: '成交额尚未核验', phase: 'unknown', verified: false, tradable: false, reason: errorText(error), createBlock: event.blockNumber });
      }
    }
    return unavailable;
  }

  async function poll() {
    if (!running || busy) return;
    busy = true;
    try {
      await protocol.initialize();
      head = Math.max(manifest.deploymentBlock - 1, await protocol.provider.getBlockNumber() - manifest.confirmations);
      if (lastBlock > head) {
        for (const [key, event] of events) if (event.blockNumber > head) events.delete(key);
        for (const [key, token] of tokens) if (token.createBlock > head) tokens.delete(key);
        lastBlock = head;
      }
      const startTime = Date.now();
      if (lastBlock >= manifest.deploymentBlock) await scan(Math.max(manifest.deploymentBlock, lastBlock - manifest.reorgWindow + 1), Math.min(lastBlock, head));
      let chunks = 0;
      while (running && lastBlock < head && chunks < maxChunks && Date.now() - startTime < 8000) {
        await scan(lastBlock + 1, Math.min(head, lastBlock + chunkSize));
        chunks++;
      }
      const unavailable = await refreshTokens();
      status = lastBlock < head ? 'backfill' : unavailable ? 'degraded' : 'live';
      message = lastBlock < head ? `正在补扫 ${lastBlock} / ${head}，目前列表不完整` : unavailable ? `${unavailable} 个代币的链上读取失败，已禁止交易` : `已同步至 ${lastBlock}，保留 ${manifest.confirmations} 个确认`;
      await save();
    } catch (error) {
      status = 'error';
      message = `链上监控失败（不推进失败区间）：${errorText(error)}。请配置支持 eth_getLogs 的 BSC RPC。`;
      for (const [key, token] of tokens) tokens.set(key, { ...token, tradable: false, reason: '监控失联，等待重新同步' });
    } finally {
      updatedAt = new Date().toISOString(); busy = false;
      if (running) { timer = setTimeout(poll, pollMs); timer.unref?.(); }
    }
  }

  return {
    async start() { if (running) return snapshot(); running = true; status = 'starting'; message = '正在验证 OpenFour 注册表'; await load(); await poll(); return snapshot(); },
    snapshot,
    stop() { running = false; clearTimeout(timer); },
  };
}
