// Thin fetch wrapper around the (unchanged) FastAPI backend. Cookie auth.
export async function api(method, path, body) {
  const opts = { method, credentials: 'include' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (r.status === 401) throw new Error('Unauthorized');
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return null;
  return r.json();
}

// Multipart upload with progress (XHR — fetch can't report upload progress).
// `params` go on the query string (source_lang, target_lang, share, collection_id).
export function upload(path, file, params = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', qs ? `${path}?${qs}` : path);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText || '{}')); } catch { resolve({}); } }
      else reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

// POST that consumes an SSE stream (data: {json}\n\n), calling onEvent per event.
export async function streamPost(path, body, onEvent) {
  const r = await fetch(path, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 401) throw new Error('Unauthorized');
  if (!r.ok) throw new Error(await r.text());
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, idx).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(idx + 2);
      if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
    }
  }
}

