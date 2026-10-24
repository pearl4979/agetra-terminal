import { createProtocol, manifest } from '../src/protocol.mjs';

// 只读验证部署、动态入口和日志能力；不调用baw，不签名。
const protocol = createProtocol({ rpcUrl: process.env.BSC_RPC_URL || 'https://rpc-bsc.48.club' });
try {
  const state = await protocol.initialize();
  const receipt = await protocol.provider.getTransactionReceipt(manifest.deploymentTransaction);
  if (!receipt || receipt.status !== 1 || receipt.blockNumber !== manifest.deploymentBlock) throw new Error('部署交易回执不匹配');
  const head = await protocol.provider.getBlockNumber();
  const fromBlock = Math.max(manifest.deploymentBlock, head - 50);
  const logs = await protocol.provider.getLogs({ address: protocol.manager, fromBlock, toBlock: head - manifest.confirmations, topics: [protocol.createdTopic, protocol.presetTopic] });
  console.log(JSON.stringify({ verified: true, ...state, deploymentBlock: receipt.blockNumber, checkedAt: new Date().toISOString(), head, logsInRecentWindow: logs.length, note: '近期窗口计数不代表全部历史代币数量；完整索引以面板监控进度为准。' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verified: false, error: error.shortMessage || error.message }));
  process.exitCode = 1;
} finally { protocol.provider.destroy(); }
