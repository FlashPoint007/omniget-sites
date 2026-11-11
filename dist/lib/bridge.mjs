const LOCAL_HOST = '127.0.0.1';
const TIMEOUT_MS = 5500;
const LOOPBACK_OPTIONS = (() => {
  try {
    return new Request('http://127.0.0.1', { targetAddressSpace: 'loopback' }).targetAddressSpace === 'loopback'
      ? { targetAddressSpace: 'loopback' }
      : {};
  } catch {
    return {};
  }
})();

export class BridgeError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

export function localBridgeOrigin(input) {
  const value = input.trim();
  const address = /^\d+$/.test(value) ? 'http://' + LOCAL_HOST + ':' + value : value;
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})(?:\/(?:v1\/pair|mcp)?)?$/i.exec(address);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BridgeError('请输入 OmniGet 显示的本机端口或 127.0.0.1 端点。');
  }
  return 'http://' + LOCAL_HOST + ':' + port;
}

async function bridgeRequest(origin, path, { token, payload } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (payload) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(origin + path, {
      ...LOOPBACK_OPTIONS,
      method: payload ? 'POST' : 'GET',
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.timeout(path === '/v1/health' ? 30_000 : TIMEOUT_MS),
    });
  } catch {
    throw new BridgeError('无法访问本机 OmniGet。确认桌面端正在运行、端口正确，并检查浏览器的本地网络权限。', 'unreachable');
  }
  if (response.status === 401) {
    throw new BridgeError('配对令牌无效。请在桌面端复制当前令牌。', 'unauthorized');
  }
  if (response.status === 404) {
    throw new BridgeError('当前桌面版缺少下载队列接口，请更新到 v0.15.1 或更新版本。', 'unsupported');
  }
  if (!response.ok) throw new BridgeError('本机 OmniGet 返回 HTTP ' + response.status + '。', 'rejected');
  try {
    return await response.json();
  } catch {
    throw new BridgeError('该端口未返回 OmniGet 接口数据。', 'invalid');
  }
}

export async function connectBridge(address, token) {
  const origin = localBridgeOrigin(address);
  const secret = token.trim();
  if (!/^[a-zA-Z0-9_-]{43}$/.test(secret)) {
    throw new BridgeError('请粘贴桌面端生成的完整配对令牌。');
  }
  const health = await bridgeRequest(origin, '/v1/health');
  if (health?.ok !== true || !/^v?\d+\.\d+\.\d+/.test(health.version)) {
    throw new BridgeError('该端口未返回 OmniGet 健康状态。');
  }
  const queue = () => bridgeRequest(origin, '/v1/queue', { token: secret });
  if (!Array.isArray(await queue())) throw new BridgeError('桌面端未返回下载队列。');
  return {
    version: health.version,
    queue,
    async enqueue(url) {
      const result = await bridgeRequest(origin, '/v1/enqueue', {
        token: secret,
        payload: { url, protocolVersion: 1, openApp: true },
      });
      if (result?.ok !== true) throw new BridgeError('桌面端未确认接收该链接。', 'rejected');
    },
  };
}

export function taskProgress(item) {
  const pct = Math.max(0, Math.min(100, Number(item.percent) || 0));
  const status = item.status;
  switch (status?.type) {
    case 'Queued': return { state: 'desktop-queued', pct: null, detail: '等待桌面端调度' };
    case 'Active': return { state: 'desktop-active', pct, detail: '' };
    case 'Paused': return { state: 'desktop-paused', pct, detail: '可在桌面端继续' };
    case 'Seeding': return { state: 'desktop-done', pct: 100, detail: '文件已完成，正在做种' };
    case 'Complete':
      return status.data?.success
        ? { state: 'desktop-done', pct: 100, detail: '' }
        : { state: 'desktop-error', pct: null, detail: '请在桌面端查看详情' };
    case 'Error': return { state: 'desktop-error', pct: null, detail: '请在桌面端查看详情' };
    default: return null;
  }
}
