export class BrowserDownloadError extends Error {}

async function jsonReply(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new BrowserDownloadError('下载服务返回异常，请稍后重试。'); }
  if (!response.ok) throw new BrowserDownloadError(data.error || '该链接暂时无法下载。');
  return data;
}

export async function resolveBrowserDownload(item, signal) {
  const response = await fetch('/api/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: item.url, mode: item.mode === 'direct' ? 'direct' : 'auto' }),
    signal,
  });
  const result = await jsonReply(response);
  if (!Array.isArray(result.files) || !result.files.length || result.files.some((file) =>
    typeof file.name !== 'string' || !/^\/api\/download\?t=[a-zA-Z0-9_.-]+$/.test(file.href))) {
    throw new BrowserDownloadError('未找到有效的下载文件。');
  }
  return result;
}

export async function startBrowserDownload(file, signal) {
  await jsonReply(await fetch(file.href + '&check=1', { signal, cache: 'no-store' }));
  signal.throwIfAborted();
  // An attachment response lets the browser stream to disk and manage progress,
  // retries and cancellation without collecting the file in page memory.
  const anchor = document.createElement('a');
  anchor.href = file.href;
  anchor.download = file.name;
  anchor.rel = 'noreferrer';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
