'use strict';

// 所有交易由本地服务预览和执行；浏览器不连接钱包、不签名、不广播。
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    session: null, tokens: [], orders: [], wallet: null, monitor: null,
    selectedAddress: null, selectedSnapshot: null, side: 'buy', preview: null,
    previewBusy: false, executeBusy: false, tokensLoaded: false,
    tokenError: null, walletError: null, previewVersion: 0,
    loading: { tokens: false, wallet: false, orders: false }, timers: new Set(),
    orderDrafts: new Map(), ordersSignature: null,
    position: null, positionError: null, positionBusy: false, positionVersion: 0,
    auth: null, authBusy: false, authPollBusy: false, executionBusy: false, walletVersion: 0,
  };
  let toastTimer;
  const phaseLabels = { bonding: '内盘', graduated: '已毕业', unknown: '待确认' };
  const statusLabels = {
    pending: '等待确认', submitted: '已提交', broadcast: '已广播', broadcasting: '广播中',
    confirmed: '链上已确认', success: '服务端报告成功', failed: '失败', error: '失败',
    rejected: '已拒绝', simulated: '模拟完成', demo: '模拟完成', approved: '授权已确认',
    executing: '执行中', queued: '排队中', unknown: '结果待核实',
    DEMO_COMPLETED: '模拟完成', UNKNOWN: '结果待核实', SUCCESS: '服务端报告成功', FAILED: '失败',
    SUBMITTING: '提交中', BROADCASTED: '已广播', PENDING_CONFIRMATION: '等待钱包确认',
    MINED: '已打包 · 等待确认', CONFIRMED: '链上已确认', REVERTED: '链上已回滚',
    MANUALLY_RELEASED: '已释放本地阻塞',
  };

  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined && content !== null) el.textContent = String(content);
    return el;
  }

  function display(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }

  function prettyTime(value, full = false) {
    if (!value) return '—';
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      ...(full ? { month: '2-digit', day: '2-digit' } : {}),
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(time);
  }

  function showToast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').className = `toast${error ? ' error' : ''}`;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
  }

  async function copyText(value) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const input = node('textarea', 'copy-fallback', value);
        input.setAttribute('readonly', '');
        document.body.append(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('复制失败');
      }
      showToast('完整地址已复制');
    } catch {
      showToast('无法自动复制，请选中完整地址手动复制。', true);
    }
  }

  async function api(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), body ? 120000 : 20000);
    try {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.session.csrf } : {},
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      });
      let result;
      try { result = await response.json(); } catch { throw new Error('本地服务返回了无法解析的响应。'); }
      if (!response.ok) throw new Error(display(result.error, `请求失败（${response.status}）`));
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时。若正在执行交易，请先检查交易记录及链上状态，避免重复提交。');
      if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认终端服务仍在运行。');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function formatUnitsExact(raw, decimals) {
    if (!/^\d+$/.test(String(raw)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('持仓数量格式无效。');
    const value = BigInt(raw).toString().padStart(decimals + 1, '0');
    if (!decimals) return value;
    const whole = value.slice(0, -decimals);
    const fraction = value.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  }

  function parseSellPercent(percent) {
    if (!/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/.test(String(percent))) throw new Error('请输入大于 0 且不超过 100 的百分比，最多两位小数。');
    const [whole, fraction = ''] = String(percent).split('.');
    const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (bps <= 0n || bps > 10000n) throw new Error('卖出比例必须大于 0 且不超过 100%。');
    return bps;
  }

  function positionPercent(balance, decimals, percent) {
    if (!/^\d+$/.test(String(balance))) throw new Error('持仓数量格式无效。');
    return formatUnitsExact(BigInt(balance) * parseSellPercent(percent) / 10000n, decimals);
  }

  function tokenAvatar(token) {
    const container = node('div', 'token-avatar');
    container.setAttribute('aria-hidden', 'true');
    const seed = token && token.address || 'AGETRA-TERMINAL';
    let hash = 2166136261;
    for (const character of seed.toLowerCase()) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 8 8'); svg.setAttribute('shape-rendering', 'crispEdges');
    const colors = ['#7af7c2', '#ffd66b', '#8cbfff', '#e5a2ff', '#ff9da7'];
    const color = colors[hash % colors.length];
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 3; x++) {
        hash = Math.imul(hash ^ (y * 3 + x + 1), 16777619) >>> 0;
        if ((hash >>> 15) & 1) {
          for (const xx of [x + 1, 6 - x]) {
            const square = document.createElementNS(ns, 'rect');
            square.setAttribute('x', xx); square.setAttribute('y', y + 1);
            square.setAttribute('width', 1); square.setAttribute('height', 1); square.setAttribute('fill', color); svg.append(square);
          }
        }
      }
    }
    container.append(svg);
    const imageUrl = token && token.imageUrl;
    if (imageUrl) {
      try {
        const url = new URL(imageUrl, window.location.origin);
        if (url.origin === window.location.origin && /^\/(?:api\/token-image\/|assets\/demo-)/.test(url.pathname)) {
          const image = node('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
          image.addEventListener('error', () => image.remove(), { once: true });
          image.src = url.href; container.append(image);
        }
      } catch { /* Unknown metadata keeps the local deterministic identicon. */ }
    }
    return container;
  }

  function positionAvailable() {
    try { return Boolean(state.position && state.wallet && state.position.token.toLowerCase() === state.selectedAddress && state.position.address.toLowerCase() === state.wallet.address.toLowerCase() && BigInt(state.position.balance) > 0n && !state.positionError); }
    catch { return false; }
  }

  function tradeAmount() {
    const input = $('amount-input').value.trim();
    if (state.side === 'buy') return input;
    if (state.positionBusy || !positionAvailable()) throw new Error('请先读取当前钱包的代币持仓。');
    const amount = positionPercent(state.position.balance, Number(state.position.decimals), input);
    if (!/[1-9]/.test(amount)) throw new Error('此比例对应的数量不足代币最小单位，请提高比例。');
    return amount;
  }

  function renderSellEstimate() {
    $('sell-estimate').hidden = state.side !== 'sell';
    if (state.side !== 'sell') return;
    let text = state.positionBusy ? '正在读取持仓…' : !positionAvailable() ? '读取持仓后自动计算卖出数量。' : '输入持仓百分比，或选择下方快捷比例。';
    if (!state.positionBusy && positionAvailable() && $('amount-input').value.trim()) {
      try { text = `预计卖出 ${tradeAmount()} ${selectedToken()?.symbol || 'TOKEN'}`; }
      catch (error) { text = error.message; }
    }
    $('sell-estimate').textContent = text;
  }

  function renderPosition() {
    const position = state.position;
    let text = state.positionBusy ? '读取中…' : '—';
    if (position && !state.positionError) {
      try { text = formatUnitsExact(position.balance, Number(position.decimals)); }
      catch { text = '数据无效'; }
    }
    $('position-balance').textContent = text;
    $('position-balance').title = position ? `授权额度：${display(position.allowance)}（原始单位） · ${prettyTime(position.updatedAt)}` : '';
    $('position-error').hidden = !state.positionError;
    $('position-error').textContent = state.positionError || '';
  }

  async function loadPosition() {
    const version = ++state.positionVersion;
    const token = selectedToken();
    const walletAddress = state.wallet?.address;
    state.position = null;
    if (state.side === 'sell') invalidatePreview();
    if (!token || !state.wallet || !walletReadiness().ready) {
      state.position = null; state.positionBusy = false; renderSelection(); return;
    }
    state.positionBusy = true; state.positionError = null; renderSelection();
    try {
      const result = await api(`/api/positions?token=${encodeURIComponent(token.address)}`);
      if (version !== state.positionVersion) return;
      if (result.token?.toLowerCase() !== token.address.toLowerCase() || result.address?.toLowerCase() !== walletAddress?.toLowerCase() || state.wallet?.address?.toLowerCase() !== walletAddress?.toLowerCase()) throw new Error('钱包或代币已变化，请重新读取持仓。');
      if (!/^\d+$/.test(String(result.balance)) || !Number.isInteger(Number(result.decimals))) throw new Error('服务端持仓格式无效。');
      state.position = result;
    } catch (error) { if (version === state.positionVersion) { state.position = null; state.positionError = error.message; } }
    finally { if (version === state.positionVersion) { state.positionBusy = false; renderSelection(); } }
  }

  function renderDataAge() {
    const time = state.monitor && new Date(state.monitor.updatedAt).getTime();
    const seconds = time && Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 1000)) : null;
    $('monitor-age').textContent = seconds === null ? '—' : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    $('monitor-age').classList.toggle('caution', seconds !== null && seconds > 60);
  }

  function authUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (url.hostname === 'binance.com' || url.hostname.endsWith('.binance.com')) && !url.username && !url.password ? String(value) : null;
    } catch { return null; }
  }

  function authActive() { return state.auth && ['WAITING_APP', 'VERIFYING'].includes(state.auth.status); }

  function renderAuth() {
    const auth = state.auth;
    $('auth-panel').hidden = !auth;
    if (!auth) return;
    const labels = { WAITING_APP: '等待 App 确认', VERIFYING: '正在验证连接', CONNECTED: '钱包已连接', EXPIRED: '配对已过期', ERROR: '连接未完成' };
    $('auth-status').textContent = labels[auth.status] || display(auth.status);
    $('auth-message').textContent = auth.message || (authActive() ? '在 Binance App 完成登录并核对配对码。此步骤不会发起交易。' : '');
    const rawExpiry = typeof auth.expireAt === 'number' || /^\d+$/.test(String(auth.expireAt)) ? Number(auth.expireAt) : new Date(auth.expireAt).getTime();
    const expiry = Number.isFinite(rawExpiry) && rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry;
    const remaining = Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - Date.now()) / 1000)) : null;
    $('auth-countdown').textContent = authActive() && remaining !== null ? remaining > 0 ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '等待状态确认' : '';
    const link = authActive() && authUrl(auth.urlForWeb);
    $('auth-link').hidden = !link; $('auth-link').href = link || '#';
    $('pairing-container').hidden = !authActive() || !auth.pairingCode;
    $('pairing-code').textContent = display(auth.pairingCode, '');
    if (authActive() || auth.pendingVerification === true) { $('wallet-connect').textContent = auth.pendingVerification ? '核对连接结果…' : '等待 App 连接'; $('wallet-connect').disabled = true; }
    else if (!state.authBusy) renderWalletConnect();
  }

  function renderWalletConnect() {
    const readiness = walletReadiness();
    $('wallet-connect').disabled = state.authBusy || authActive() || Boolean(state.auth && state.auth.pendingVerification) || Boolean(state.wallet && state.wallet.status === 'CREATING') || !state.session || Boolean(state.session.mode === 'demo') || readiness.ready;
    $('wallet-connect').textContent = state.authBusy ? '正在创建连接…' : readiness.ready ? '钱包已连接' : state.session && state.session.mode === 'demo' ? 'DEMO 钱包' : '连接 Agent 钱包';
  }

  async function startAuth() {
    if (state.authBusy || !state.session || authActive() || state.auth && state.auth.pendingVerification) return;
    state.authBusy = true; state.auth = null; renderWalletConnect(); renderAuth();
    try {
      state.auth = await api('/api/auth/start', {});
      if (state.auth.status === 'CONNECTED') await syncConnectedSession();
    } catch (error) { state.auth = { status: 'ERROR', message: error.message }; }
    finally { state.authBusy = false; renderWalletConnect(); renderAuth(); }
  }

  async function pollAuthStatus() {
    if ((!authActive() && !(state.auth && state.auth.pendingVerification === true)) || state.authPollBusy) return;
    state.authPollBusy = true;
    try {
      const result = await api('/api/auth/status');
      state.auth = result;
      if (result.status === 'CONNECTED') { await syncConnectedSession(); showToast('Agent 钱包已连接。真实交易开关仍需手动开启。'); }
    } catch (error) { state.auth.message = error.message; }
    finally { state.authPollBusy = false; renderAuth(); }
  }

  async function syncConnectedSession() {
    // 登录完成后服务端关闭执行开关，并清理认证响应中的临时配对信息。
    state.auth = { status: 'CONNECTED', message: state.auth && state.auth.message };
    if (state.session) state.session.liveExecution = false;
    invalidatePreview(); renderMode();
    const session = await api('/api/session');
    if (!['live', 'demo'].includes(session.mode) || typeof session.csrf !== 'string') throw new Error('连接已完成，但会话刷新失败，请刷新页面。');
    state.session = session; renderMode();
    await loadWallet(true);
  }

  function renderExecutionSetting() {
    const session = state.session;
    const enabled = Boolean(session && session.mode === 'live' && session.liveExecution);
    $('execution-toggle').setAttribute('aria-checked', String(enabled));
    $('execution-toggle').setAttribute('aria-label', enabled ? '关闭真实交易' : '开启真实交易');
    $('execution-toggle').disabled = state.executionBusy || state.executeBusy || state.previewBusy || !session || session.mode === 'demo' || (!enabled && !walletReadiness().ready);
    $('execution-toggle').setAttribute('aria-label', session && session.mode === 'demo' ? '演示模式不执行真实交易' : enabled ? '关闭真实交易' : '开启真实交易');
    $('execution-label').textContent = state.executionBusy ? '更新中…' : session && session.mode === 'demo' ? '演示模式' : enabled ? '已开启' : '未开启';
  }

  async function toggleExecution() {
    if ($('execution-toggle').disabled || !state.session) return;
    state.executionBusy = true; $('execution-error').hidden = true; renderExecutionSetting();
    try {
      const result = await api('/api/settings/execution', { enabled: !state.session.liveExecution });
      state.session.liveExecution = result.liveExecution === true;
      invalidatePreview(); renderMode(); renderSelection();
      showToast(state.session.liveExecution ? '真实交易已开启；每笔交易仍需预览并手动确认。' : '真实交易已关闭。');
    } catch (error) { $('execution-error').textContent = error.message; $('execution-error').hidden = false; }
    finally { state.executionBusy = false; renderExecutionSetting(); }
  }

  function selectedToken() {
    return state.tokens.find((token) => token.address.toLowerCase() === state.selectedAddress);
  }

  function canTrade(token) {
    return Boolean(token && token.verified === true && token.tradable === true && token.phase === 'bonding');
  }

  function badge(text, tone = 'neutral') { return node('span', `badge ${tone}`, text); }

  function renderMode() {
    const session = state.session;
    if (!session) return;
    const demo = session.mode === 'demo';
    $('mode-badge').textContent = demo ? 'DEMO' : 'LIVE';
    $('mode-badge').className = `badge ${demo ? 'yellow' : 'green'}`;
    $('mode-notice').className = `mode-notice${demo ? ' demo' : ''}`;
    $('mode-notice').textContent = demo
      ? 'DEMO 演示模式 · 所有交易均为服务端模拟，不签名、不广播，也不会产生真实资产变动。'
      : session.liveExecution
        ? 'LIVE 实时模式 · 当前连接 BNB Chain。确认执行将请求本地钱包发送真实交易并消耗 Gas。'
        : 'LIVE 实时行情 · 连接钱包后可预览，真实交易开关默认关闭。';
    $('mev-status').textContent = session.mev && session.mev.label || '防夹未验证';
    renderExecutionSetting();
  }

  function renderTokens() {
    const query = $('search-input').value.trim().toLowerCase();
    const onlyBonding = $('bonding-only').checked;
    const verified = state.tokens.filter((token) => token.verified === true);
    const visible = verified.filter((token) => (!onlyBonding || token.phase === 'bonding') &&
      (!query || [token.address, token.name, token.symbol].some((value) => display(value, '').toLowerCase().includes(query))));
    const fragment = document.createDocumentFragment();
    visible.forEach((token) => {
      const row = node('tr', token.address.toLowerCase() === state.selectedAddress ? 'selected' : '');
      const identityCell = node('td');
      const identity = node('div', 'token-identity');
      identity.append(tokenAvatar(token));
      const nameBlock = node('div');
      const name = node('button', 'token-title', token.name || token.symbol || '未命名代币');
      name.type = 'button';
      name.title = display(token.name || token.symbol);
      name.addEventListener('click', () => selectToken(token));
      nameBlock.append(name, node('span', 'token-symbol', token.symbol || '—'));
      identity.append(nameBlock);
      const address = node('button', 'address-copy');
      address.type = 'button';
      address.title = `复制完整 CA：${token.address}`;
      address.setAttribute('aria-label', `复制 ${token.symbol || token.name || '代币'} 的完整合约地址`);
      address.append(node('span', '', token.address), node('span', 'copy-icon', '⧉'));
      address.addEventListener('click', () => copyText(token.address));
      identityCell.append(identity, address);
      const price = node('td', 'price-cell', display(token.price));
      const progressCell = node('td', 'progress-cell');
      const knownProgress = token.progress !== null && token.progress !== undefined && Number.isFinite(Number(token.progress));
      const progress = knownProgress ? Math.max(0, Math.min(100, Number(token.progress))) : null;
      progressCell.append(node('span', 'progress-label', progress === null ? '—' : `${progress.toFixed(1)}%`));
      if (progress !== null) {
        const bar = node('progress', 'curve-progress');
        bar.max = 100; bar.value = progress;
        bar.setAttribute('aria-label', `Curve 进度 ${progress.toFixed(1)}%`);
        progressCell.append(bar);
      }
      const volume = node('td');
      volume.append(node('span', 'volume-value', display(token.volume)), node('span', 'volume-label', token.volumeLabel || '口径未提供'));
      const phase = node('td');
      phase.append(badge(phaseLabels[token.phase] || phaseLabels.unknown, token.phase === 'bonding' ? 'green' : 'neutral'));
      const actionCell = node('td');
      const actions = node('div', 'row-actions');
      ['buy', 'sell'].forEach((side) => {
        const button = node('button', `row-action${side === 'sell' ? ' sell' : ''}`, side === 'buy' ? '买入' : '卖出');
        button.type = 'button'; button.disabled = !canTrade(token);
        button.title = canTrade(token) ? `${side === 'buy' ? '买入' : '卖出'} ${token.symbol || token.name || token.address}` : token.reason || '当前代币不可交易';
        button.addEventListener('click', () => {
          selectToken(token, side);
          if (window.innerWidth <= 900) $('trade-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
          $('amount-input').focus({ preventScroll: true });
        });
        actions.append(button);
      });
      actionCell.append(actions);
      row.append(identityCell, price, progressCell, volume, phase, actionCell);
      fragment.append(row);
    });
    $('token-rows').replaceChildren(fragment);
    $('token-count').textContent = String(verified.length);
    $('verified-count').textContent = String(verified.length);
    $('visible-count').textContent = String(visible.length);
    $('market-empty').hidden = visible.length > 0;
    if (!visible.length) {
      if (state.tokenError) {
        $('empty-title').textContent = '代币列表暂时不可用';
        $('empty-description').textContent = state.tokenError;
      } else if (!state.tokensLoaded) {
        $('empty-title').textContent = '正在读取代币列表';
        $('empty-description').textContent = '等待本地监控服务返回已验证的目标模板代币。';
      } else if (!verified.length) {
        $('empty-title').textContent = '未发现已验证目标模板代币';
        $('empty-description').textContent = '监控仅展示完成模板验证的代币。当前暂无结果，请留意上方监控状态。';
      } else {
        $('empty-title').textContent = '没有符合筛选条件的代币';
        $('empty-description').textContent = '尝试其他名称、符号或合约地址，也可以取消“仅内盘”筛选。';
      }
    }
    renderSelection();
  }

  function renderMonitor() {
    const monitor = state.monitor || {};
    const status = monitor.status || 'unknown';
    const live = ['live', 'running', 'watching', 'connected', 'ready', 'healthy'].includes(status);
    const problem = state.tokenError || ['error', 'failed', 'disconnected'].includes(status);
    const names = { live: '监控运行中', running: '监控运行中', watching: '监控运行中', connected: '已连接', ready: '监控就绪', healthy: '监控正常', scanning: '扫描中', syncing: '同步中', demo: '演示数据', disabled: '监控未启用', error: '监控异常', failed: '监控异常', disconnected: '已断开', pending: '等待验证', idle: '等待数据', unknown: '等待监控' };
    $('monitor-status').textContent = names[status] || status;
    $('monitor-status').className = `badge ${problem ? 'red' : live ? 'green' : 'yellow'}`;
    $('monitor-message').textContent = state.tokenError || display(monitor.message, '等待监控服务返回状态。');
    $('connection-dot').className = `status-dot ${problem ? 'error' : state.tokensLoaded ? 'connected' : ''}`;
    $('connection-label').textContent = problem ? '连接需检查' : state.tokensLoaded ? '每 5 秒同步' : '等待连接';
    $('monitor-block').textContent = display(monitor.lastBlock);
    $('monitor-template').textContent = display(monitor.templateId);
    $('monitor-registry').textContent = display(monitor.registry);
    $('monitor-manager').textContent = display(monitor.manager);
    $('monitor-updated').textContent = prettyTime(monitor.updatedAt, true);
    const diagnosticError = state.tokenError || monitor.error || monitor.lastError;
    $('monitor-error').hidden = !diagnosticError;
    $('monitor-error').textContent = diagnosticError ? `监控详情：${display(diagnosticError)}` : '';
    renderDataAge();
    $('market-updated').textContent = monitor.updatedAt ? `更新于 ${prettyTime(monitor.updatedAt)}` : state.tokensLoaded ? '已收到服务端数据' : '尚未更新';
  }

  function selectToken(token, side = state.side) {
    if (state.previewBusy || state.executeBusy) return;
    state.selectedAddress = token.address.toLowerCase();
    state.selectedSnapshot = token;
    state.position = null;
    state.positionError = null;
    setSide(side, false);
    invalidatePreview();
    renderTokens();
    loadPosition();
  }

  function setSide(side, invalidate = true) {
    // BNB 金额与持仓百分比不是同一单位，切换方向时不继承旧输入。
    if (state.side !== side) $('amount-input').value = '';
    state.side = side;
    ['buy', 'sell'].forEach((value) => {
      $(`side-${value}`).classList.toggle('active', side === value);
      $(`side-${value}`).setAttribute('aria-pressed', String(side === value));
    });
    $('amount-label').textContent = side === 'buy' ? '买入金额' : '卖出比例';
    $('amount-input').placeholder = side === 'buy' ? '0.00' : '0';
    $('quick-amounts').hidden = side !== 'buy';
    $('sell-amounts').hidden = side !== 'sell';
    $('preview-button').classList.toggle('sell', side === 'sell');
    if (invalidate) invalidatePreview();
    renderSelection();
  }

  function renderSelection() {
    const token = selectedToken();
    const selected = token || state.selectedSnapshot;
    if (token) state.selectedSnapshot = token;
    $('selected-name').textContent = selected ? selected.name || selected.symbol || '未命名代币' : '选择一个代币';
    $('selected-symbol').textContent = selected ? selected.symbol || '—' : '从左侧列表开始';
    $('selected-address').textContent = selected ? selected.address : '尚未选择合约';
    const avatar = $('selected-avatar');
    const avatarKey = selected ? `${selected.address}:${selected.imageUrl || ''}` : 'placeholder';
    if (avatar.dataset.tokenKey !== avatarKey) {
      avatar.replaceChildren(...tokenAvatar(selected).childNodes);
      avatar.dataset.tokenKey = avatarKey;
    }
    $('selected-avatar').classList.toggle('placeholder-avatar', !selected);
    $('selected-phase').hidden = !selected;
    $('selected-phase').textContent = token ? phaseLabels[token.phase] || '待确认' : '未在列表';
    $('selected-phase').className = `badge ${token && token.phase === 'bonding' ? 'green' : 'neutral'}`;
    const unit = state.side === 'buy' ? 'BNB' : '%';
    $('amount-unit').textContent = unit;
    $('amount-suffix').textContent = unit;
    let hint = '请先选择已验证、可交易的内盘代币。';
    let warning = false;
    if (state.selectedAddress && !token) { hint = '当前扫描未列出此代币，交易暂不可用。'; warning = true; }
    else if (token && !canTrade(token)) { hint = token.reason || '代币尚未通过验证，或已不处于可交易的内盘阶段。'; warning = true; }
    else if (state.tokenError) { hint = '市场数据同步失败，恢复连接后才能创建新的交易预览。'; warning = true; }
    else if (state.session && state.session.mode === 'live' && !walletReadiness().ready) { hint = walletReadiness().message; warning = true; }
    else if (state.session && state.session.mode === 'live' && !state.session.liveExecution && token) { hint = '真实执行设置未开启，可查看预览；执行按钮保持禁用。'; warning = true; }
    else if (token) { hint = state.side === 'buy' ? '输入 BNB 金额；Gas 费用由钱包另行支付。' : '按当前持仓比例卖出；授权额度不足时，预览会先请求授权。'; }
    $('trade-hint').textContent = hint;
    $('trade-hint').className = `trade-hint${warning ? ' warning' : ''}`;
    renderPosition();
    renderControls();
  }

  function inputError() {
    let amount;
    try { amount = tradeAmount(); } catch (error) { return error.message; }
    if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(amount) || !/[1-9]/.test(amount) || amount.length > 80) return '请输入大于 0 的十进制金额，最多 18 位小数，不使用逗号或科学计数法。';
    const slippage = Number($('slippage-input').value);
    if (!Number.isInteger(slippage) || slippage < 1 || slippage > 500) return '滑点需为 1–500 之间的整数 bps。';
    if (state.side === 'sell' && state.position) {
      try {
        const decimals = Number(state.position.decimals);
        const [whole, fraction = ''] = amount.split('.');
        if (fraction.length > decimals) return `该代币最多支持 ${decimals} 位小数。`;
        const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
        if (raw > BigInt(state.position.balance)) return '卖出数量超过当前持有余额。';
      } catch { return '持仓数据格式无效，请刷新余额后重试。'; }
    }
    return null;
  }

  function renderControls() {
    const busy = state.previewBusy || state.executeBusy;
    const walletReady = state.session && (state.session.mode === 'demo' || walletReadiness().ready);
    $('preview-button').disabled = !state.session || !canTrade(selectedToken()) || !walletReady || Boolean(state.tokenError) || busy || (state.side === 'sell' && (state.positionBusy || !positionAvailable()));
    $('preview-button').firstElementChild.textContent = state.previewBusy ? '正在获取预览…' : state.executeBusy ? '正在执行…' : `预览${state.side === 'buy' ? '买入' : '卖出'}`;
    $('side-buy').disabled = busy;
    $('side-sell').disabled = busy;
    $('amount-input').disabled = busy;
    $('slippage-input').disabled = busy;
    document.querySelectorAll('[data-slippage]').forEach((button) => {
      button.disabled = busy; button.classList.toggle('active', Number(button.dataset.slippage) === Number($('slippage-input').value));
    });
    document.querySelectorAll('[data-amount]').forEach((button) => { button.disabled = busy; });
    document.querySelectorAll('[data-percent]').forEach((button) => {
      button.disabled = busy || state.positionBusy || !positionAvailable();
      let active = false;
      try { active = state.side === 'sell' && parseSellPercent($('amount-input').value.trim()) === BigInt(button.dataset.percent) * 100n; } catch { /* 空输入或非法比例不选中快捷项。 */ }
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('position-refresh').disabled = busy || state.positionBusy || !state.selectedAddress || !walletReady;
    renderSellEstimate();
    $('slippage-warning').hidden = Number($('slippage-input').value) < 300;
    $('slippage-description').textContent = `${$('slippage-input').value || '—'} bps = ${Number($('slippage-input').value || 0) / 100}% · 限制可接受的成交偏差。`;
    $('confirm-preview').disabled = busy;
    $('close-preview').disabled = busy;
    renderExecutionSetting();
    updateExpiry();
  }

  function invalidatePreview() {
    state.previewVersion += 1;
    state.preview = null;
    $('preview-panel').hidden = true;
    $('confirm-preview').checked = false;
    $('trade-error').hidden = true;
    renderControls();
  }

  function renderRisk(target, value, missing) {
    const el = $(target);
    if (value === undefined || value === null) { el.textContent = missing; return; }
    if (Array.isArray(value)) {
      if (!value.length) { el.textContent = '服务端返回空列表；这不构成安全保证。'; return; }
      const list = node('ul');
      value.forEach((item) => list.append(node('li', '', display(item))));
      el.replaceChildren(list);
    } else { el.textContent = display(value); }
  }

  function renderPreview() {
    const preview = state.preview;
    if (!preview) return;
    const approval = preview.kind === 'approve';
    const demo = preview.demo === true;
    $('preview-title').textContent = approval ? '授权交易预览' : `${state.side === 'buy' ? '买入' : '卖出'}交易预览`;
    $('preview-kind').textContent = approval
      ? `${demo ? 'DEMO · ' : ''}本次仅授权代币额度，不会卖出。授权完成后，请重新预览卖出。`
      : demo ? 'DEMO · 本次仅模拟，不会签名或广播真实交易。' : '本次执行会请求本地钱包发送真实链上交易。';
    renderSummary(preview.summary);
    $('preview-to').textContent = display(preview.transaction.to);
    $('preview-value').textContent = display(preview.transaction.value);
    $('preview-data').textContent = display(preview.transaction.data);
    const raw = preview.raw || {};
    const simulation = raw.simulationResult || {};
    renderRisk('preview-risks', raw.risks, '服务端未返回 risks 字段，请核对完整解析结果。');
    renderRisk('preview-authority', simulation.authorityChanges ?? raw.authorityChanges, '服务端未返回 authorityChanges 字段，请核对完整解析结果。');
    renderRisk('preview-balances', simulation.balanceChanges ?? raw.balanceChanges, '服务端未返回 balanceChanges 字段，请核对完整解析结果。');
    renderRisk('preview-allowances', simulation.allowanceChanges ?? raw.allowanceChanges, '服务端未返回 allowanceChanges 字段，请核对完整解析结果。');
    $('preview-raw').textContent = display(preview.raw, '服务端未返回 raw 解析结果。');
    $('confirm-preview').checked = false;
    $('confirm-label').textContent = approval
      ? '我已核对授权对象、授权额度、风险和权限变化，理解本次只执行授权。'
      : demo ? '我已核对交易参数，理解本次为演示模拟，不会产生真实交易。' : '我已核对目标、金额、调用数据、风险和权限变化，同意执行真实交易。';
    $('execute-button').textContent = demo ? approval ? '确认模拟授权' : '确认模拟交易' : approval ? '确认并授权' : '确认并执行';
    $('execute-button').classList.toggle('sell', state.side === 'sell' && !approval);
    $('execute-hint').textContent = !demo && !state.session.liveExecution ? '当前服务为只读模式，无法执行真实交易。' : approval ? '授权不是卖出。完成后重新获取卖出预览。' : '提交后请通过交易记录及链上回执确认实际结果。';
    $('preview-panel').hidden = false;
    updateExpiry();
  }

  function renderSummary(summary) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      $('preview-summary').textContent = display(summary, '服务端未提供交易摘要，请逐项核对以下原始交易。');
      return;
    }
    const labels = {
      estimatedTokens: '预计获得代币', minTokens: '最少获得代币', estimatedSpend: '预计支出 · BNB',
      estimatedReceive: '预计收到 · BNB', minReceive: '最少收到 · BNB', estimatedGasCost: '预估 Gas 预算 · BNB',
      buyTaxBps: '买入税', sellTaxBps: '卖出税', allowance: '本次授权数量', spender: '被授权合约',
      budget: '买入预算 · BNB', amount: '输入数量', side: '交易方向', token: '代币合约', symbol: '代币符号',
      antiSniperEnabled: '防狙击开关', slippageBps: '滑点容差', estimatedTotalFee: '预计总费用 · BNB',
      estimatedGas: '预计 Gas 数量', mode: '运行模式', action: '执行说明', requiresNewPreview: '需要重新预览',
      priceImpactBps: '预估价格影响', mevProtection: '防夹保护',
      simulated: '已完成链上模拟', minAmountOutRaw: '最少代币输出 · 原始值', minQuoteReceiveRaw: '最少报价币输出 · 原始值',
    };
    const first = ['estimatedTokens', 'minTokens', 'estimatedSpend', 'estimatedReceive', 'minReceive', 'estimatedGasCost', 'buyTaxBps', 'sellTaxBps', 'allowance', 'spender'];
    const fields = [...first.filter((key) => Object.hasOwn(summary, key)), ...Object.keys(summary).filter((key) => !first.includes(key))];
    const list = node('dl', 'summary-grid');
    for (const key of fields) {
      const value = summary[key];
      let formatted = typeof value === 'boolean' ? value ? '是' : '否' : display(value);
      if (key.endsWith('Bps') && value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) formatted = `${Number(value) / 100}%（${value} bps）`;
      if (key === 'mevProtection' && value === 'unverified') formatted = '未验证';
      if (key === 'priceImpactBps' && (value === null || value === undefined)) formatted = '未提供';
      if (key === 'side') formatted = value === 'buy' ? '买入' : value === 'sell' ? '卖出' : display(value);
      list.append(node('dt', '', labels[key] || key), node('dd', '', formatted));
    }
    $('preview-summary').replaceChildren(list);
  }

  function updateExpiry() {
    const preview = state.preview;
    if (!preview) { $('execute-button').disabled = true; return; }
    const expiry = new Date(preview.expiresAt).getTime();
    const seconds = Math.ceil((expiry - Date.now()) / 1000);
    const valid = Number.isFinite(expiry) && seconds > 0;
    $('preview-expiry').textContent = valid ? `预览剩余 ${seconds} 秒 · 到期后需重新获取` : '预览已过期或有效期无效，请重新获取。';
    const modeConsistent = Boolean(state.session && (state.session.mode === 'demo') === (preview.demo === true));
    const executionAllowed = modeConsistent && (preview.demo === true || state.session.liveExecution === true);
    const walletReady = preview.demo === true || walletReadiness().ready;
    $('execute-button').disabled = !valid || !executionAllowed || !walletReady || !$('confirm-preview').checked || state.executeBusy || state.previewBusy || !canTrade(selectedToken()) || Boolean(state.tokenError);
  }

  async function requestPreview(event) {
    event.preventDefault();
    if ($('preview-button').disabled) return;
    const validationError = inputError();
    if (validationError) { $('trade-error').textContent = validationError; $('trade-error').hidden = false; return; }
    invalidatePreview();
    const version = state.previewVersion;
    state.previewBusy = true;
    renderControls();
    try {
      const result = await api('/api/preview', {
        token: selectedToken().address, side: state.side,
        amount: tradeAmount(), slippageBps: Number($('slippage-input').value),
      });
      if (version !== state.previewVersion) return;
      if (!result.id || !result.transaction || !result.transaction.to || typeof result.transaction.data !== 'string') throw new Error('服务端返回的交易预览不完整，无法执行。');
      if ((state.session.mode === 'demo') !== (result.demo === true)) throw new Error('预览模式与当前会话不一致，请刷新页面确认服务运行模式。');
      state.preview = result;
      renderPreview();
      $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      $('trade-error').textContent = error.message;
      $('trade-error').hidden = false;
    } finally {
      state.previewBusy = false;
      renderControls();
    }
  }

  async function executePreview() {
    updateExpiry();
    if ($('execute-button').disabled || !state.preview || state.executeBusy) return;
    const previewId = state.preview.id;
    state.executeBusy = true;
    $('execute-button').textContent = '正在提交，请勿重复操作…';
    renderControls();
    try {
      const order = await api('/api/execute', { previewId, confirmed: true });
      if (order && order.id) {
        state.orders = [order, ...state.orders.filter((existing) => existing.id !== order.id)];
        renderOrders();
      }
      showToast('执行请求已返回，请查看交易记录中的实际状态。');
      await Promise.allSettled([loadOrders(), loadWallet(true), loadTokens()]);
    } catch (error) {
      $('trade-error').textContent = `${error.message} 请先检查交易记录和链上状态，再决定是否重新预览。`;
      $('trade-error').hidden = false;
      showToast('执行结果需要核实，请查看错误详情与交易记录。', true);
      await loadOrders();
    } finally {
      // 执行尝试后销毁本次预览，防止超时或重试造成重复交易。
      state.preview = null;
      state.previewVersion += 1;
      $('preview-panel').hidden = true;
      $('confirm-preview').checked = false;
      state.executeBusy = false;
      renderControls();
    }
  }

  function walletReadiness() {
    const wallet = state.wallet;
    const error = state.walletError || wallet && wallet.error;
    let label;
    let message;
    if (state.walletError) {
      label = '读取失败'; message = '本地钱包信息读取失败，请检查服务后刷新。';
    } else if (!wallet || !wallet.available) {
      label = '不可用';
      message = /ENOENT|not found|未安装/i.test(display(error, ''))
        ? '未检测到 baw。请先在终端安装并配置 Binance Agent Wallet（baw），再刷新此页面。'
        : '本地 baw 钱包不可用，请先完成安装和配置。';
    } else if (wallet.status === 'UNCONNECTED') {
      label = '未连接'; message = '点击“连接 Agent 钱包”，在 Binance App 完成配对。';
    } else if (wallet.status === 'CREATING') {
      label = '创建中'; message = 'Agent 钱包正在创建，完成后刷新钱包状态。';
    } else if (error) {
      label = '部分读取失败'; message = '部分钱包信息查询失败，请检查下方错误，恢复后再交易。';
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(wallet.address || '')) {
      label = '地址未就绪'; message = '尚未取得 BSC 钱包地址，请连接钱包后刷新。';
    } else if (wallet.status !== 'CONNECTED' && (!state.session || state.session.mode !== 'demo')) {
      label = '状态待确认'; message = '尚未确认钱包登录状态，请检查本地 baw 后刷新。';
    } else {
      return { ready: true, label: '已就绪', message: '' };
    }
    if (error) message += ` 查询详情：${display(error)}`;
    return { ready: false, label, message };
  }

  function renderWallet() {
    const wallet = state.wallet;
    const readiness = walletReadiness();
    $('wallet-status').textContent = readiness.label;
    $('wallet-status').className = `badge ${readiness.ready ? 'green' : 'yellow'}`;
    $('wallet-address').textContent = wallet && wallet.address || '未连接本地钱包';
    $('wallet-address').disabled = !(wallet && wallet.address);
    $('wallet-balance').replaceChildren(document.createTextNode(display(wallet && wallet.balance)), node('small', '', ' BNB'));
    $('wallet-error').hidden = readiness.ready;
    $('wallet-error').textContent = readiness.message;
    $('wallet-cli').textContent = display(wallet && wallet.cliVersion);
    renderWalletConnect();
    $('wallet-refresh').disabled = state.loading.wallet;
    renderExecutionSetting();
    const quota = wallet && wallet.quota;
    $('quota-date').textContent = display(quota && quota.date);
    $('quota-used').textContent = display(quota && quota.quotaUsed);
    $('quota-left').textContent = display(quota && quota.quotaLeft);
    $('quota-limit').textContent = display(quota && quota.dailyLimit);
    const limit = Number(quota && quota.dailyLimit);
    const used = Number(quota && quota.quotaUsed);
    $('quota-progress').value = limit > 0 && Number.isFinite(used) ? Math.min(100, Math.max(0, used / limit * 100)) : 0;
    const dev = wallet && wallet.devMode;
    $('developer-quota').hidden = !dev;
    $('dev-quota-used').textContent = display(dev && dev.quotaUsed);
    $('dev-quota-limit').textContent = display(dev && dev.dailyLimit);
    $('dev-quota-date').textContent = display(dev && dev.quotaDate);
    $('dev-status').textContent = dev === null || dev === undefined ? '未知' : typeof dev === 'object' && typeof dev.enabled === 'boolean' ? dev.enabled ? '已开启' : '未开启' : '查看配置';
    $('dev-data').textContent = display(dev, '服务端未提供 Developer Mode 配置。');
    renderSelection();
  }

  function renderOrders() {
    const signature = JSON.stringify(state.orders);
    if (signature === state.ordersSignature) return;
    state.ordersSignature = signature;
    const active = document.activeElement;
    const activeId = active && $('order-list').contains(active) ? active.id : null;
    const selection = activeId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const fragment = document.createDocumentFragment();
    state.orders.forEach((order) => {
      const row = node('div', 'order-row');
      const side = order.kind === 'approve' || order.side === 'approve' ? '授权' : order.side === 'sell' ? '卖出' : order.side === 'buy' ? '买入' : display(order.side, '交易');
      const sideLabel = node('span', `order-side${order.side === 'sell' ? ' sell' : ''}`, side);
      const body = node('div');
      const token = typeof order.token === 'object' && order.token ? order.token.address || order.token.symbol || display(order.token) : display(order.token);
      const title = node('div', 'order-title');
      title.append(node('strong', 'mono', display(order.amount)), node('span', 'quiet small', order.side === 'buy' ? 'BNB' : side === '授权' ? '授权额度' : '代币'));
      body.append(title, node('div', 'order-meta', token));
      if (order.txHash && /^0x[0-9a-fA-F]{64}$/.test(order.txHash)) {
        const tx = node('a', 'order-tx', `Tx ${order.txHash}`);
        tx.href = `https://bscscan.com/tx/${order.txHash}`; tx.target = '_blank'; tx.rel = 'noopener noreferrer';
        body.append(tx);
      } else if (order.txHash) { body.append(node('div', 'order-meta', `Tx ${display(order.txHash)}`)); }
      if (order.error) body.append(node('p', 'order-result error', display(order.error)));
      if (order.message) body.append(node('p', 'order-result', display(order.message)));
      if (order.manualLinked) body.append(node('p', 'order-result', '已手动关联链上交易，状态继续按回执更新。'));
      if (order.status === 'MANUALLY_RELEASED') body.append(node('p', 'order-result', '仅释放本地阻塞，不代表链上交易已取消或成功。'));
      if (!order.txHash && ['UNKNOWN', 'PENDING_CONFIRMATION'].includes(order.status)) body.append(orderRecovery(order));
      const meta = node('div');
      const failed = ['failed', 'error', 'rejected', 'FAILED', 'REVERTED'].includes(order.status);
      const confirmed = ['confirmed', 'success', 'simulated', 'demo', 'approved', 'DEMO_COMPLETED', 'SUCCESS', 'CONFIRMED'].includes(order.status);
      meta.append(badge(statusLabels[order.status] || display(order.status, '未知状态'), failed ? 'red' : confirmed ? 'green' : 'yellow'), node('div', 'order-time', prettyTime(order.createdAt, true)));
      row.append(sideLabel, body, meta); fragment.append(row);
    });
    $('order-list').replaceChildren(fragment);
    $('orders-empty').hidden = state.orders.length > 0;
    $('order-count').textContent = String(state.orders.length);
    if (activeId && $(activeId)) {
      $(activeId).focus({ preventScroll: true });
      if (selection) $(activeId).setSelectionRange(...selection);
    }
  }

  function orderRecovery(order) {
    if (!state.orderDrafts.has(order.id)) state.orderDrafts.set(order.id, { hash: '', nonce: '', linkConfirmed: false, releaseConfirmed: false, open: false, busy: false, error: '' });
    const draft = state.orderDrafts.get(order.id);
    const details = node('details', 'order-recovery');
    details.open = draft.open;
    details.addEventListener('toggle', () => { draft.open = details.open; });
    details.append(node('summary', '', '核对待确认订单'));
    const linkForm = node('form', 'recovery-form');
    linkForm.append(node('h4', '', '关联已发送的链上交易'), node('p', 'field-help', '后端会核对链、钱包、目标、金额、调用数据、nonce、时间及回执；关联不会重发交易。'));
    const hashLabel = node('label', 'recovery-field', '完整交易哈希');
    const hash = node('input', 'mono');
    hash.id = `recovery-hash-${order.id}`; hash.type = 'text'; hash.autocomplete = 'off'; hash.placeholder = '0x…'; hash.value = draft.hash;
    hashLabel.append(hash);
    const nonceLabel = node('label', 'recovery-field', '交易 nonce');
    const nonce = node('input', 'mono');
    nonce.id = `recovery-nonce-${order.id}`; nonce.type = 'text'; nonce.inputMode = 'numeric'; nonce.autocomplete = 'off'; nonce.placeholder = '例如：12'; nonce.value = draft.nonce;
    nonceLabel.append(nonce);
    const linkCheckLabel = node('label', 'check-label recovery-confirm');
    const linkCheck = node('input'); linkCheck.type = 'checkbox'; linkCheck.checked = draft.linkConfirmed;
    linkCheckLabel.append(linkCheck, node('span', '', '我已确认此交易对应本订单。'));
    const linkButton = node('button', 'button subtle compact', '验证并关联'); linkButton.type = 'submit';
    linkForm.append(hashLabel, nonceLabel, linkCheckLabel, linkButton);
    const releaseForm = node('form', 'recovery-form release-form');
    releaseForm.append(node('h4', '', '释放本地阻塞'), node('p', 'field-help', '仅在原请求已被拒绝或过期时使用；后端还会检查钱包交易锁已解除。'));
    const releaseCheckLabel = node('label', 'check-label recovery-confirm');
    const releaseCheck = node('input'); releaseCheck.type = 'checkbox'; releaseCheck.checked = draft.releaseConfirmed;
    releaseCheckLabel.append(releaseCheck, node('span', '', '已在 App 确认原请求被拒绝或过期，并核对链上记录；此操作不取消链上交易。'));
    const releaseButton = node('button', 'button subtle compact', '释放本地阻塞'); releaseButton.type = 'submit';
    releaseForm.append(releaseCheckLabel, releaseButton);
    const error = node('p', 'inline-error', draft.error); error.hidden = !draft.error; error.setAttribute('role', 'alert');
    const update = () => {
      hash.disabled = nonce.disabled = linkCheck.disabled = releaseCheck.disabled = draft.busy;
      const validHash = /^0x[0-9a-fA-F]{64}$/.test(draft.hash.trim());
      const validNonce = /^\d+$/.test(draft.nonce.trim()) && Number.isSafeInteger(Number(draft.nonce)) && Number(draft.nonce) >= 0;
      linkButton.disabled = draft.busy || !draft.linkConfirmed || !validHash || !validNonce || !state.session;
      releaseButton.disabled = draft.busy || !draft.releaseConfirmed || !state.session;
      linkButton.textContent = draft.busy ? '正在核对…' : '验证并关联';
      releaseButton.textContent = draft.busy ? '正在核对…' : '释放本地阻塞';
      error.textContent = draft.error; error.hidden = !draft.error;
    };
    hash.addEventListener('input', () => { draft.hash = hash.value; update(); });
    nonce.addEventListener('input', () => { draft.nonce = nonce.value; update(); });
    linkCheck.addEventListener('change', () => { draft.linkConfirmed = linkCheck.checked; update(); });
    releaseCheck.addEventListener('change', () => { draft.releaseConfirmed = releaseCheck.checked; update(); });
    const submit = async (kind) => {
      if (draft.busy) return;
      draft.busy = true; draft.error = ''; update();
      try {
        const body = kind === 'link'
          ? { orderId: order.id, txHash: draft.hash.trim(), nonce: Number(draft.nonce), confirmed: true }
          : { orderId: order.id, confirmed: true, chainHistoryChecked: true };
        await api(`/api/orders/${kind}`, body);
        showToast(kind === 'link' ? '关联请求已返回，请查看最新订单状态。' : '释放请求已返回，请查看最新订单状态；此操作不取消链上交易。');
        await loadOrders();
      } catch (failure) { draft.error = failure.message; }
      finally { draft.busy = false; state.ordersSignature = null; renderOrders(); }
    };
    linkForm.addEventListener('submit', (event) => { event.preventDefault(); if (!linkButton.disabled) submit('link'); });
    releaseForm.addEventListener('submit', (event) => { event.preventDefault(); if (!releaseButton.disabled) submit('release'); });
    details.append(linkForm, releaseForm, error);
    update();
    return details;
  }

  async function loadTokens() {
    if (state.loading.tokens) return;
    state.loading.tokens = true;
    try {
      const result = await api('/api/tokens');
      state.tokens = Array.isArray(result.tokens) ? result.tokens.filter((token) => token && typeof token.address === 'string') : [];
      state.monitor = result.monitor || {};
      state.tokensLoaded = true; state.tokenError = null;
    } catch (error) { state.tokenError = error.message; }
    finally { state.loading.tokens = false; renderTokens(); renderMonitor(); }
  }

  async function loadWallet(refresh = false) {
    if (state.loading.wallet && !refresh) return;
    const version = ++state.walletVersion;
    state.loading.wallet = true;
    $('wallet-refresh').disabled = true;
    const previous = state.wallet && `${state.wallet.address}:${state.wallet.status}`;
    try {
      const result = await api(`/api/wallet${refresh ? '?refresh=1' : ''}`);
      if (version !== state.walletVersion) return;
      state.wallet = result; state.walletError = null;
    } catch (error) { if (version === state.walletVersion) state.walletError = error.message; }
    finally {
      if (version === state.walletVersion) {
        state.loading.wallet = false;
        const current = state.wallet && `${state.wallet.address}:${state.wallet.status}`;
        if (current !== previous) invalidatePreview();
        renderWallet();
        if (refresh || current !== previous) await loadPosition();
      }
    }
  }

  async function loadOrders() {
    if (state.loading.orders) return;
    state.loading.orders = true;
    try {
      const result = await api('/api/orders');
      state.orders = Array.isArray(result.orders) ? result.orders : [];
      $('orders-error').hidden = true; renderOrders();
    } catch (error) { $('orders-error').textContent = error.message; $('orders-error').hidden = false; }
    finally { state.loading.orders = false; }
  }

  // 任务完成后再调度下一次；每个资源还有独立锁，手动刷新不会产生重叠请求。
  function poll(task, delay) {
    const schedule = () => {
      const timer = setTimeout(async () => {
        state.timers.delete(timer);
        await run();
      }, delay);
      state.timers.add(timer);
    };
    const run = async () => {
      await task();
      schedule();
    };
    schedule();
  }

  $('search-input').addEventListener('input', renderTokens);
  $('bonding-only').addEventListener('change', renderTokens);
  $('side-buy').addEventListener('click', () => setSide('buy'));
  $('side-sell').addEventListener('click', () => setSide('sell'));
  $('amount-input').addEventListener('input', invalidatePreview);
  $('slippage-input').addEventListener('input', invalidatePreview);
  document.querySelectorAll('[data-amount]').forEach((button) => button.addEventListener('click', () => {
    $('amount-input').value = button.dataset.amount; invalidatePreview();
  }));
  document.querySelectorAll('[data-percent]').forEach((button) => button.addEventListener('click', () => {
    if (button.disabled || !state.position) return;
    try {
      $('amount-input').value = button.dataset.percent;
      invalidatePreview();
    } catch (error) { showToast(error.message, true); }
  }));
  document.querySelectorAll('[data-slippage]').forEach((button) => button.addEventListener('click', () => {
    $('slippage-input').value = button.dataset.slippage; invalidatePreview();
  }));
  $('position-refresh').addEventListener('click', loadPosition);
  $('wallet-refresh').addEventListener('click', () => loadWallet(true));
  $('wallet-connect').addEventListener('click', startAuth);
  $('pairing-copy').addEventListener('click', async () => {
    if (!state.auth || !state.auth.pairingCode) return;
    try { await navigator.clipboard.writeText(String(state.auth.pairingCode)); showToast('配对码已复制'); }
    catch { showToast('请选中配对码手动复制。', true); }
  });
  $('execution-toggle').addEventListener('click', toggleExecution);
  $('trade-form').addEventListener('submit', requestPreview);
  $('confirm-preview').addEventListener('change', updateExpiry);
  $('execute-button').addEventListener('click', executePreview);
  $('close-preview').addEventListener('click', invalidatePreview);
  $('wallet-address').addEventListener('click', () => { if (state.wallet && state.wallet.address) copyText(state.wallet.address); });
  $('refresh-button').addEventListener('click', async () => {
    $('refresh-button').disabled = true;
    await Promise.allSettled([loadTokens(), loadOrders(), loadWallet(true)]);
    $('refresh-button').disabled = false;
  });

  async function initialize() {
    try {
      state.session = await api('/api/session');
      if (!['live', 'demo'].includes(state.session.mode) || typeof state.session.csrf !== 'string') throw new Error('会话配置无效，请检查本地服务。');
      renderMode();
    } catch (error) {
      state.session = null;
      $('mode-notice').className = 'mode-notice error';
      $('mode-notice').textContent = `${error.message} 恢复服务后请重新加载页面。`;
      $('mode-badge').textContent = '离线';
      $('mode-badge').className = 'badge red';
    }
    await Promise.allSettled([loadTokens(), loadOrders(), loadWallet()]);
    poll(loadTokens, 5000); poll(loadOrders, 5000); poll(loadWallet, 30000); poll(pollAuthStatus, 5000);
    state.timers.add(setInterval(() => { updateExpiry(); renderAuth(); renderDataAge(); }, 1000));
  }
  window.addEventListener('pagehide', () => state.timers.forEach((timer) => clearTimeout(timer)));
  initialize();
})();
