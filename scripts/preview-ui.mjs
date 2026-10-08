import http from 'node:http';
import { renderIndexPage } from '../src/ui.ts';
import { fixture, file } from '../test/ui-harness.mjs';

// Local visual fixture only: this server has no D1/R2 binding, account or outbound service client.
const names = ['bytevirt.yaml','dartnode.yaml','rabisu.yaml','56idc.yaml','yinyun.yaml','racknerd.23.254.219.147.yaml','racknerd.192.119.78.227.yaml','racknerd.107.172.99.23.yaml'];
const files = names.map((name, index) => ({ ...file, id: index + 1, hostId: '@uploads', path: '/' + name, sizeBytes: (index + 1) * 1024 }));
files.push({ ...file, id: 20, path: '/etc/linkbin/configurations/' + 'long-path-'.repeat(12) + 'settings.yaml', sizeBytes: 8192, important: true });
const port = Number(process.env.LINKBIN_UI_PORT || 8799);
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderIndexPage(url.searchParams.get('lang') || 'en')); return;
  }
  let body = fixture(request.url);
  if (url.pathname === '/api/objects') {
    const q = url.searchParams.get('q') || ''; const source = url.searchParams.get('host');
    const selected = files.filter(f => f.path.includes(q) && (!source || f.hostId === source));
    body = { objects: selected, total: selected.length, limit: 200 };
  }
  if (url.pathname === '/api/derived/status') body = { rules: [{ ruleId: 'preview', outputName: 'merged-all.yaml', current: true, objectId: 21, sourceCount: 8, sizeBytes: 40960, sources: files.slice(0, 8) }] };
  if (url.pathname === '/api/file-links') body = { links: [{ host_id: '@uploads', path: '/bytevirt.yaml', url: `http://127.0.0.1:${port}/d/preview-token`, token: 'preview-token' }] };
  if (url.pathname === '/api/runs') body = { runs: [{ id: 1, hostId: 'demo', seconds: 2.3, stored: 8, skipped: 0, failed: 0, outcome: 'succeeded', issueCount: 0 }] };
  if (url.pathname === '/api/usage') body = { usage: { totalBytes: 245760000, budgetBytes: 10737418240, remainingBytes: 10491658240, usedFraction: 245760000 / 10737418240, maxFileBytes: 104857600, importantBytes: 8192, retainedBytes: 4096 } };
  request.resume();
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body));
});
server.listen(port, '127.0.0.1', () => console.log(`Offline UI fixture: http://127.0.0.1:${port}`));
