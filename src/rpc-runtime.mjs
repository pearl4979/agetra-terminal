// Stable facades let monitor, wallet balances and trade checks share one active node.
export function createRpcRuntime({ rpcUrl, createProtocol, createMonitor, validationTimeoutMs = 25000 }) {
  const make = url => {
    const protocol = createProtocol({ rpcUrl: url });
    return { protocol, monitor: createMonitor({ protocol }) };
  };
  let active = make(rpcUrl);
  let switching = false;
  const facade = key => new Proxy({}, { get(_target, name) {
    const target = active[key];
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return {
    protocol: facade('protocol'), monitor: facade('monitor'),
    async apply(url, persist) {
      if (switching) throw new Error('RPC 正在切换，请稍后再试');
      switching = true;
      let next;
      let timeout;
      try {
        next = make(url);
        await Promise.race([next.protocol.initialize(), new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('timeout')), validationTimeoutMs);
        })]);
        clearTimeout(timeout);
        await persist();
        const previous = active;
        const stopped = previous.monitor.stop();
        previous.protocol.provider.destroy();
        await stopped;
        active = next;
        void Promise.resolve().then(() => next.monitor.start()).catch(() => {});
      } catch {
        next?.protocol.provider.destroy();
        throw new Error('RPC 未应用：请确认节点支持当前模板的合约读取');
      } finally { clearTimeout(timeout); switching = false; }
    },
  };
}
