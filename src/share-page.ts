/** Recipient-only password form. No password is placed in its URL, markup, logs or browser storage. */
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function sharePasswordPage(token: string, filename: string, incorrect = false): Response {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>下载分享文件 · LinkBin</title><style>body{font:16px system-ui;background:#f5f6fa;color:#192338;max-width:440px;margin:12vh auto;padding:24px}main{background:white;padding:28px;border-radius:16px}h1{font-size:24px}p{overflow-wrap:anywhere}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:12px;font:inherit}button{background:#234ab7;color:white;border:0;border-radius:8px}.error{color:#a12727}</style>
<main><h1>下载分享文件</h1><p>${escape(filename)}</p><p>请输入分享密码，验证成功后直接下载。</p>${incorrect ? '<p class="error">密码错误，请重试。</p>' : ''}
<form method="post" action="/s/${encodeURIComponent(token)}"><label>分享密码<input type="password" name="password" required autocomplete="off" autofocus></label><button type="submit">确认密码并下载</button></form></main></html>`, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  }, status: incorrect ? 401 : 200 });
}

/** Bound even a chunked submission; never call unbounded formData() on this public route. */
export async function readSharePassword(request: Request): Promise<string | null> {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      // New UI caps passwords at 1,024 code units (at most 12 KiB form-encoded), while legacy API
      // passwords remain accepted. A larger public-form allowance keeps existing long passwords usable.
      if (size > 64 * 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new URLSearchParams(new TextDecoder().decode(bytes)).get('password');
}
