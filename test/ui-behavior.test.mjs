import { test } from 'node:test';
import assert from 'node:assert/strict';
import { page, file, host } from './ui-harness.mjs';

test('saving a host reads credential mode independently of sign-in state', async () => {
  const p = await page();
  p.get('f-address').value = 'example.test'; p.get('f-username').value = 'test'; p.get('f-password').value = 'test fixture';
  await p.click('saveHost');
  assert.ok(p.calls.some(c => c.path === '/api/hosts' && c.method === 'POST'));
});

test('collection displays actual totals and refreshes files and capacity', async () => {
  const p = await page({ '/api/collect': { ok: true, run: true, machineId: 'demo', totals: { stored: 2, skipped: 1, failed: 0 }, collectionImplemented: true } });
  const before = p.calls.length;
  await p.click('collectNow');
  assert.doesNotMatch(p.get('collectResult').textContent, /not built yet/);
  assert.match(p.get('collectResult').textContent, /2/);
  assert.ok(p.calls.slice(before).some(c => c.path.startsWith('/api/objects')));
  assert.ok(p.calls.slice(before).some(c => c.path === '/api/usage'));
});

test('no-host collection and empty upload are disabled', async () => {
  const p = await page({ '/api/hosts': { hosts: [] } });
  assert.equal(p.get('collectNow').disabled, true);
  assert.equal(p.get('uploadFiles').disabled, true);
});

test('failed file listing displays an error and retry action', async () => {
  const p = await page({ '/api/objects': { status: 503, body: { error: 'fixture unavailable' } } });
  assert.match(p.get('objectlist').textContent, /fixture unavailable/);
  assert.ok(p.get('objectlist').querySelector('button'));
});

test('uploads reject oversize files before transmission', async () => {
  const p = await page();
  p.get('f-upload').files = [{ name: 'too-big.bin', size: 104857601 }];
  await p.get('f-upload').dispatch('change'); await p.click('uploadFiles');
  assert.match(p.get('uploadQueue').textContent, /100 MiB/);
  assert.equal(p.get('uploadFiles').disabled, true);
  assert.equal(p.calls.filter(c => c.path.startsWith('/api/files/upload')).length, 0);
});

test('upload queue continues after failure and retry sends only failed files', async () => {
  let failures = 0;
  const p = await page({ '/api/files/upload': (path) => path.includes('bad.yaml') && failures++ === 0 ? { status: 503, body: { error: 'temporary upload error' } } : { ok: true } });
  p.get('f-upload').files = [{ name: 'good.yaml', size: 10 }, { name: 'bad.yaml', size: 20 }];
  await p.get('f-upload').dispatch('change'); await p.click('uploadFiles');
  assert.match(p.get('uploadQueue').textContent, /temporary upload error/);
  assert.equal(p.get('retryUploads').disabled, false);
  await p.click('retryUploads');
  const uploads = p.calls.filter(c => c.path.startsWith('/api/files/upload'));
  assert.equal(uploads.length, 3);
  assert.equal(uploads.filter(c => c.path.includes('good.yaml')).length, 1);
  assert.equal(p.get('retryUploads').disabled, true);
});

test('upload queue retains a network failure and proceeds to the next file', async () => {
  const p = await page({ '/api/files/upload': path => path.includes('bad.yaml') ? new Error('offline fixture') : { ok: true } });
  p.get('f-upload').files = [{ name: 'bad.yaml', size: 1 }, { name: 'good.yaml', size: 1 }];
  await p.get('f-upload').dispatch('change'); await p.click('uploadFiles');
  assert.equal(p.calls.filter(c => c.path.startsWith('/api/files/upload')).length, 2);
  assert.equal(p.get('retryUploads').disabled, false);
  assert.match(p.get('uploadQueue').textContent, /Uploaded/);
});

test('available-file sharing validates password and posts the selected version id', async () => {
  const p = await page({ '/api/shares': (path, init) => init.method === 'POST' ? { ok: true, share: { url: 'http://localhost/s/fixture', expiresAt: '2026-10-09T00:00:00Z', hasPassword: true } } : { shares: [] } });
  assert.equal(p.get('makeShare').disabled, true);
  p.get('s-object').value = '1'; await p.get('s-object').dispatch('change');
  p.get('s-password').value = 'fixture password'; await p.get('s-password').dispatch('input');
  assert.equal(p.get('makeShare').disabled, false);
  await p.click('makeShare');
  const posted = p.calls.find(c => c.path === '/api/shares' && c.method === 'POST');
  assert.equal(JSON.parse(posted.body).objectId, 1);
  assert.equal(p.get('s-password').value, '');
  assert.equal(p.get('makeShare').disabled, true);
});

test('unavailable and replaced versions cannot be selected for sharing', async () => {
  const p = await page({ '/api/objects': { objects: [{ ...file, bytesPresent: false }, { ...file, id: 2, live: false }], total: 2 } });
  assert.equal(p.get('s-object').options.length, 1);
  assert.equal(p.get('makeShare').disabled, true);
});

test('file-row sharing opens links and selects a file outside the picker first page', async () => {
  const selected = { ...file, id: 201, path: '/outside-first-page.yaml' };
  const p = await page({ '/api/objects': path => path.includes('limit=50') ? { objects: [selected], total: 1 } : { objects: [file], total: 201 } });
  const share = p.get('objectlist').querySelectorAll('button').find(b => b.textContent === 'Share');
  await share.dispatch('click'); await p.flush();
  assert.equal(p.get('app').getAttribute('data-view'), 'links');
  assert.equal(p.get('s-object').value, '201');
  assert.match(p.get('shareSelected').textContent, /outside-first-page/);
});

test('clipboard rejection shows manual copy and never claims success', async () => {
  const p = await page({ '/api/file-links': { links: [{ host_id: 'demo', path: file.path, url: 'http://localhost/d/fixture', token: 'fixture' }] } }, { clipboard: { writeText: () => Promise.reject(new Error('denied')) }, legacyCopy: false });
  const copy = p.get('directLinks').querySelectorAll('button').find(b => b.textContent === 'Copy');
  await copy.dispatch('click'); await p.flush();
  assert.equal(copy.textContent, 'Copy');
  assert.equal(copy.disabled, false);
  assert.equal(p.get('directLinks').querySelector('.manual-copy').value, 'http://localhost/d/fixture');
});

test('clipboard confirmation waits for the actual write', async () => {
  let copied;
  const pending = new Promise(resolve => { copied = resolve; });
  const p = await page({ '/api/file-links': { links: [{ host_id: 'demo', path: file.path, url: 'http://localhost/d/fixture', token: 'fixture' }] } }, { clipboard: { writeText: () => pending } });
  const copy = p.get('directLinks').querySelectorAll('button').find(b => b.textContent === 'Copy');
  await copy.dispatch('click'); await p.flush();
  assert.equal(copy.textContent, 'Copy'); assert.equal(copy.disabled, true);
  copied(); await p.flush();
  assert.equal(copy.textContent, 'Copied');
});

test('unreachable and stopped collection receipts preserve their actual outcomes', async () => {
  for (const [body, expected] of [
    [{ connected: false, error: 'connection refused' }, /Could not connect/],
    [{ stoppedEarly: true }, /next run will resume/],
  ]) {
    const p = await page({ '/api/collect': { ok: true, run: true, machineId: 'demo', totals: { stored: 0, skipped: 0, failed: 1 }, ...body } });
    await p.click('collectNow'); assert.match(p.get('collectResult').textContent, expected);
  }
});

test('preview must succeed for the current definition before saving a merge', async () => {
  const p = await page({ '/api/derived/preview': { preview: { ok: true, sources: ['demo:/configs/a.yaml'], perPattern: [{ pattern: '/configs/*.yaml', matched: 1 }], sourceCount: 1, sourceBytes: 42, bytes: 42 } } });
  p.get('m-name').value = 'merged.yaml'; p.get('m-patterns').value = '/configs/*.yaml';
  await p.get('m-name').dispatch('input');
  assert.equal(p.get('saveMerge').disabled, true);
  await p.click('previewMerge'); assert.equal(p.get('saveMerge').disabled, false);
  await p.click('saveMerge'); assert.match(p.get('mergePreview').textContent, /Rule saved/);
  assert.equal(p.calls.filter(c => c.path === '/api/derived/run').length, 0);
  p.get('m-patterns').value = '/other.yaml'; await p.get('m-patterns').dispatch('input');
  assert.equal(p.get('saveMerge').disabled, true);
});

test('merged-all preset checks each of its eight required sources', async () => {
  const p = await page({ '/api/objects': path => path.includes('bytevirt') ? { objects: [{ ...file, path: '/bytevirt.yaml' }], total: 1 } : { objects: [file], total: 1 } });
  await p.click('profilePreset');
  assert.equal(p.get('presetStatus').querySelectorAll('li').length, 8);
  assert.match(p.get('presetStatus').textContent, /Source available/);
  assert.match(p.get('presetStatus').textContent, /matched nothing/);
  assert.equal(p.get('saveMerge').disabled, true);
});

test('manual merge run reports success and offers the built file download', async () => {
  const p = await page({ '/api/derived/status': { rules: [{ ruleId: 'fixture', outputName: 'merged.yaml', current: true, objectId: 3, sources: [] }] }, '/api/derived/run': { ok: true, bytes: 42 } });
  const run = p.get('mergelist').querySelectorAll('button').find(b => b.textContent === 'Build now');
  assert.ok(run);
  await run.dispatch('click'); await p.flush();
  assert.match(p.get('mergePreview').textContent, /42/);
  assert.equal(p.get('mergelist').querySelector('a').href, '/api/files/download?id=3');
});

test('late search replies cannot replace the latest file results', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const p = await page({ '/api/objects': path => path.includes('q=old') ? pending : { objects: [{ ...file, path: '/new.yaml' }], total: 1 } });
  p.get('b-search').value = 'old'; await p.get('b-search').dispatch('input'); await p.flush();
  p.get('b-search').value = 'new'; await p.get('b-search').dispatch('input'); await p.flush();
  release({ objects: [{ ...file, path: '/old.yaml' }], total: 1 }); await p.flush();
  assert.match(p.get('objectlist').textContent, /new.yaml/);
  assert.doesNotMatch(p.get('objectlist').textContent, /old.yaml/);
});

test('failed replacement search removes old pagination and retries its first page', async () => {
  let failed = false;
  const p = await page({ '/api/objects': path => {
    if (!path.includes('q=new')) return { objects: [file], total: 60 };
    if (!failed) { failed = true; return { status: 503, body: { error: 'search unavailable' } }; }
    return { objects: [{ ...file, path: '/new.yaml' }], total: 1 };
  } });
  assert.ok(p.get('browseMore'));
  p.get('b-search').value = 'new'; await p.get('b-search').dispatch('input'); await p.flush();
  assert.equal(Boolean(p.get('browseMore')), false);
  await p.get('objectlist').querySelector('button').dispatch('click'); await p.flush();
  assert.match(p.get('objectlist').textContent, /new.yaml/);
  assert.ok(p.calls.filter(c => c.path.includes('q=new')).every(c => !c.path.includes('offset=') || c.path.includes('offset=0')));
});

test('deleting a selected sharing file clears its selection and disables creation', async () => {
  let deleted = false;
  const p = await page({ '/api/files/delete': () => { deleted = true; return { ok: true }; },
    '/api/objects': () => ({ objects: deleted ? [] : [file], total: deleted ? 0 : 1 }) });
  p.get('s-object').value = '1'; await p.get('s-object').dispatch('change');
  p.get('s-password').value = 'fixture password'; await p.get('s-password').dispatch('input');
  assert.equal(p.get('makeShare').disabled, false);
  const remove = p.get('objectlist').querySelectorAll('button').find(b => b.textContent === 'Delete file');
  await remove.dispatch('click'); await p.flush();
  assert.equal(p.get('s-object').value, '');
  assert.equal(p.get('makeShare').disabled, true);
});

test('collection and upload timeout messages use their actual request budgets', async () => {
  const aborted = Object.assign(new Error('fixture aborted'), { name: 'AbortError' });
  const p = await page({ '/api/collect': aborted, '/api/files/upload': aborted });
  await p.click('collectNow');
  assert.match(p.get('collectResult').textContent, /360 seconds/);
  p.get('f-upload').files = [{ name: 'a.yaml', size: 1 }];
  await p.get('f-upload').dispatch('change'); await p.click('uploadFiles');
  assert.match(p.get('uploadQueue').textContent, /120 seconds/);
});

test('navigation and new workflow copy work in all four locales', async () => {
  for (const locale of ['en','zh-CN','zh-TW','ja']) {
    const p = await page({}, { locale });
    const nav = p.document.querySelectorAll('[data-view-button]');
    assert.equal(nav.length, 5);
    assert.ok(nav.every(b => !b.textContent.startsWith('ui.')));
    await nav.find(b => b.getAttribute('data-view-button') === 'merges').dispatch('click');
    assert.equal(p.get('merges-panel').hidden, false);
    assert.equal(p.get('files-panel').hidden, true);
  }
});

test('a failed automatic login after password setup keeps management hidden', async () => {
  const p = await page({ '/api/auth/state': { configured: false, signedIn: false }, '/api/auth/setup': { ok: true }, '/api/auth/login': { status: 503, body: { error: 'login unavailable' } } });
  p.get('gate-password').value = 'fixture password'; await p.get('gate-form').dispatch('submit'); await p.flush();
  assert.equal(p.get('workspace').hidden, true);
  assert.match(p.get('gate-hint').textContent, /login unavailable/);
  assert.equal(p.calls.filter(c => c.path === '/api/hosts').length, 0);
});
