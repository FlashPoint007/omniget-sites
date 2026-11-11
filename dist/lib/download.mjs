import { safeFilename } from './links.mjs';

const BUFFER_LIMIT = 64 * 1024 * 1024;

export class DownloadError extends Error {}

function filenameFromResponse(response, fallback) {
  const header = response.headers.get('content-disposition') || '';
  const encoded = /filename\*=UTF-8'[^']*'([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try { return safeFilename(decodeURIComponent(encoded.trim())); } catch { /* use filename */ }
  }
  const filename = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(header);
  return filename ? safeFilename(filename[1] || filename[2]) : fallback;
}

export async function saveDirect(item, { controller, stream, onProgress }) {
  const signal = controller.signal;
  // The picker needs the original click gesture, before the first fetch.
  let target;
  if (stream) target = await window.showSaveFilePicker({ suggestedName: item.filename });

  let response;
  try {
    response = await fetch(item.url, {
      mode: 'cors',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new DownloadError('读取失败。源站可能限制跨域或链接已失效，可尝试打开源文件。');
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new DownloadError('源站返回 HTTP ' + response.status + '。');
  }

  const encoding = response.headers.get('content-encoding');
  const length = Number(response.headers.get('content-length'));
  const total = !encoding && Number.isSafeInteger(length) && length > 0 ? length : null;
  const disposition = response.headers.get('content-disposition') || '';
  const mime = response.headers.get('content-type') || '';
  if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(mime) && !/\battachment\b/i.test(disposition)) {
    await response.body.cancel();
    throw new DownloadError('源站返回网页。请改用桌面接管，或检查链接是否指向文件。');
  }
  if (!target && total > BUFFER_LIMIT) {
    await response.body.cancel();
    throw new DownloadError('文件大于 64 MiB，请使用流式保存或打开源文件。');
  }

  const chunks = [];
  const reader = response.body.getReader();
  let writer;
  let received = 0;
  let lastUpdate = 0;
  try {
    writer = target ? await target.createWritable() : null;
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (writer) await writer.write(value);
      else {
        if (received > BUFFER_LIMIT) {
          throw new DownloadError('文件大于 64 MiB，请使用流式保存或打开源文件。');
        }
        chunks.push(value);
      }
      if (performance.now() - lastUpdate > 120) {
        lastUpdate = performance.now();
        onProgress(received, total);
      }
    }
    signal.throwIfAborted();
    if (writer) await writer.close();
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writer?.abort().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!writer) {
    const objectUrl = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filenameFromResponse(response, item.filename);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
  return { received, saved: Boolean(writer) };
}
