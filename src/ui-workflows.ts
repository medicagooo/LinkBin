/**
 * Client workflows embedded by renderIndexPage in ui.ts. They use the existing authenticated
 * API helper and renderers; no separate bundle or network asset is loaded. See docs/ui-workflows.md
 * for request ordering, upload retries and the unchanged storage/sharing contracts.
 */
export const WORKFLOW_SCRIPT = `
  var currentView = 'files';
  var hostFormOpen = false;
  var sectionRequests = Object.create(null);
  var shareFiles = [];
  var selectedShareFile = null;
  var shareBusy = false;
  var collectBusy = false;
  var hostsLoaded = false;
  var uploadBusy = false;
  var uploadQueue = [];
  var usageCache = null;
  var verifiedMerge = null;
  var presetRequest = 0;

  function selectView(view) {
    currentView = view;
    $('app').setAttribute('data-view', view);
    document.querySelectorAll('[data-panel]').forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-panel') !== view;
    });
    $('hostform').hidden = view !== 'hosts' || !hostFormOpen;
    document.querySelectorAll('[data-view-button]').forEach(function (button) {
      var active = button.getAttribute('data-view-button') === view;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('active', active);
    });
  }

  function feedback(id, message, bad) {
    var target = $(id);
    clear(target);
    target.appendChild(node('p', bad ? 'hint error' : 'hint', message));
  }

  function mutate(button, path, payload, success, target) {
    if (button.disabled) return;
    button.disabled = true;
    return api(path, { method: 'POST', body: JSON.stringify(payload) }).then(function (result) {
      button.disabled = false;
      var old = target.querySelector('.action-error'); if (old) old.remove();
      if (!result.ok || result.body.ok === false) {
        var error = node('p', 'hint error action-error', result.body.error || t('shares.failed'));
        error.setAttribute('role', 'status'); target.appendChild(error); return;
      }
      success(result.body);
    });
  }

  // The latest request owns a section. Late search/refresh replies cannot repaint a newer result.
  function loadSection(id, path, render, retry, preserve) {
    var target = $(id);
    var request = (sectionRequests[id] || 0) + 1;
    sectionRequests[id] = request;
    target.setAttribute('aria-busy', 'true');
    if (!target.firstChild) target.appendChild(node('p', 'hint', t('ui.loading')));
    return api(path).then(function (result) {
      if (sectionRequests[id] !== request) return undefined;
      target.setAttribute('aria-busy', 'false');
      var old = target.querySelector('.load-error');
      if (old) old.remove();
      if (!result.ok || result.body.ok === false) {
        if (!preserve) clear(target);
        var error = node('div', 'load-error');
        error.setAttribute('role', 'status');
        error.appendChild(node('p', 'hint error', result.body.error || t('shares.failed')));
        var button = node('button', 'ghost small', t('ui.retry'));
        button.type = 'button';
        button.addEventListener('click', retry);
        error.appendChild(button);
        target.appendChild(error);
        return null;
      }
      if (!preserve) clear(target);
      render(result.body);
      return result.body;
    });
  }

  function updateActions() {
    $('collectNow').disabled = collectBusy || !hostsLoaded || !hostCache.some(function (h) { return !!h.enabled; });
    $('makeShare').disabled = shareBusy || !selectedShareFile || $('s-password').value.length < 8 || $('s-password').value.length > 1024;
    $('uploadFiles').disabled = uploadBusy || !uploadQueue.some(function (entry) { return entry.status === 'pending'; });
    $('retryUploads').disabled = uploadBusy || !uploadQueue.some(function (entry) { return entry.status === 'failed'; });
    $('f-upload').disabled = uploadBusy;
    $('s-search').disabled = shareBusy;
    $('s-object').disabled = shareBusy || !shareFiles.length;
    var definition = mergeDefinition();
    $('previewMerge').disabled = !definition.outputName || !definition.sources.length || $('mergePreview').getAttribute('aria-busy') === 'true';
    $('saveMerge').disabled = !verifiedMerge || verifiedMerge !== JSON.stringify(definition) || $('saveMerge').getAttribute('aria-busy') === 'true';
    $('collectHint').textContent = !hostsLoaded ? t('ui.loading') : hostCache.some(function (h) { return !!h.enabled; }) ? '' : t('ui.needHost');
  }

  function chooseShareFile() {
    selectedShareFile = shareFiles.find(function (file) { return String(file.id) === $('s-object').value; }) || null;
    $('shareSelected').textContent = selectedShareFile ? selectedShareFile.hostId + ': ' + selectedShareFile.path + ' (' + bytes(selectedShareFile.sizeBytes) + ')' : t('ui.selectFile');
    updateActions();
  }

  function loadShareFiles(selected) {
    var chosen = selected || selectedShareFile;
    var query = $('s-search').value.trim();
    $('makeShare').disabled = true;
    return loadSection('shareChoices', '/api/objects?verify=1&limit=200&sort=path&q=' + encodeURIComponent(query), function (body) {
      shareFiles = (body.objects || []).filter(function (file) { return file.live && file.bytesPresent !== false; });
      if (selected && !shareFiles.some(function (file) { return file.id === selected.id; })) shareFiles.unshift(selected);
      var select = $('s-object');
      clear(select);
      var empty = node('option', null, t('ui.selectFile')); empty.value = ''; select.appendChild(empty);
      shareFiles.forEach(function (file) {
        var option = node('option', null, file.hostId + ': ' + file.path);
        option.value = String(file.id); select.appendChild(option);
      });
      select.value = chosen && shareFiles.some(function (file) { return file.id === chosen.id; }) ? String(chosen.id) : '';
      if (body.total > 200) $('shareChoices').appendChild(node('p', 'hint', t('ui.moreFiles')));
      chooseShareFile();
    }, function () { loadShareFiles(selected); }).then(function (body) {
      if (body === null) { selectedShareFile = null; shareFiles = []; updateActions(); }
    });
  }

  function renderUploadQueue() {
    var target = $('uploadQueue'); clear(target);
    if (!uploadQueue.length) { target.appendChild(node('p', 'hint', t('ui.emptyUploads'))); updateActions(); return; }
    var list = node('ul', 'upload-list');
    uploadQueue.forEach(function (entry) {
      var row = node('li', 'upload-row');
      var name = node('span', 'upload-name', entry.name + ' (' + bytes(entry.size) + ')');
      row.appendChild(name);
      row.appendChild(chip(t('ui.upload.' + entry.status), entry.status === 'failed' || entry.status === 'blocked' ? 'err' : entry.status === 'done' ? 'ok' : 'quiet'));
      if (entry.error) row.appendChild(node('p', 'hint error', entry.error));
      list.appendChild(row);
    });
    target.appendChild(list);
    var processed = uploadQueue.filter(function (entry) { return ['done','failed','blocked'].indexOf(entry.status) >= 0; }).length;
    target.appendChild(node('p', 'hint', t('ui.processed', { done: processed, total: uploadQueue.length })));
    if (usageCache && uploadQueue.reduce(function (sum, entry) { return sum + (entry.status === 'pending' || entry.status === 'failed' ? entry.size : 0); }, 0) > usageCache.remainingBytes) {
      target.appendChild(node('p', 'hint error', t('ui.capacityWarning')));
    }
    updateActions();
  }

  // Keep failed File objects for explicit retry; release successful ones. Server admission remains authoritative.
  function uploadSelected(retry) {
    if (uploadBusy) return;
    var entries = uploadQueue.filter(function (entry) { return entry.status === (retry ? 'failed' : 'pending'); });
    if (!entries.length) return;
    uploadBusy = true;
    clear($('uploadResult'));
    var chain = Promise.resolve();
    entries.forEach(function (entry) {
      chain = chain.then(function () {
        entry.status = 'uploading'; entry.error = ''; renderUploadQueue();
        return api('/api/files/upload?name=' + encodeURIComponent(entry.name), { method: 'POST', body: entry.file, headers: { 'content-type': 'application/octet-stream' } }).then(function (result) {
          entry.status = result.ok && result.body.ok !== false ? 'done' : 'failed';
          entry.error = entry.status === 'failed' ? result.body.error || t('shares.failed') : '';
          if (entry.status === 'done') entry.file = null;
          (result.body.mergeIssues || []).forEach(function (issue) { $('uploadResult').appendChild(node('p', 'hint error', (issue.path || '') + ': ' + issue.reason)); });
          renderUploadQueue();
        });
      });
    });
    renderUploadQueue();
    return chain.then(function () {
      uploadBusy = false; $('f-upload').value = ''; renderUploadQueue();
      loadObjects(); loadUsage(); loadMerges(); loadShareFiles(); loadDirectLinks(); loadShares();
    });
  }

  function showCollection(result) {
    var body = result.body;
    clear($('collectResult'));
    if (!result.ok || body.ok === false) {
      feedback('collectResult', body.error || t('runs.collectFailed'), true);
      if (result.status === 0) $('collectResult').appendChild(node('p', 'hint', t('ui.collectUnknown')));
    } else if (!body.run) {
      feedback('collectResult', body.reason === 'out-of-time' ? t('runs.outOfTime') : t('runs.nothingToDo'), false);
    } else {
      feedback('collectResult', t(body.connected === false ? 'ui.collectUnreachable' : body.stoppedEarly ? 'ui.collectStopped' : 'ui.collectDone', { host: body.machineId }), body.connected === false || !!(body.totals && body.totals.failed));
      var totals = body.totals || {};
      $('collectResult').appendChild(node('p', 'hint', t('runs.counts', { stored: totals.stored || 0, skipped: totals.skipped || 0, failed: totals.failed || 0 })));
      if (body.error) $('collectResult').appendChild(node('p', 'hint error', body.error));
    }
    (body.notes || []).forEach(function (note) { $('collectResult').appendChild(node('p', 'hint', note)); });
    if (body.unreleasedSessions) $('collectResult').appendChild(node('p', 'hint error', t('ui.cleanupFailed', { n: body.unreleasedSessions })));
    loadRuns(); loadFreshness(); loadObjects(); loadUsage(); loadMerges(); loadShareFiles(); loadDirectLinks(); loadShares();
  }

  function mergeEdited() {
    verifiedMerge = null; presetRequest += 1;
    clear($('presetStatus')); clear($('mergePreview'));
    updateActions();
  }

  function checkPresetSources() {
    var request = ++presetRequest;
    var sources = mergePatterns();
    feedback('presetStatus', t('ui.loading'), false);
    return Promise.all(sources.map(function (source) {
      return api('/api/objects?verify=1&limit=200&q=' + encodeURIComponent(source.pattern) + (source.hostId ? '&host=' + encodeURIComponent(source.hostId) : '')).then(function (result) {
        var matched = (result.body.objects || []).filter(function (file) { return file.path === source.pattern && (!source.hostId || source.hostId === file.hostId) && file.live && file.bytesPresent !== false; });
        return { pattern: source.pattern, matched: matched.length, incomplete: result.body.total > 200, error: result.ok ? null : result.body.error || t('shares.failed') };
      });
    })).then(function (results) {
      if (presetRequest !== request) return;
      clear($('presetStatus'));
      var list = node('ul', 'source-check');
      results.forEach(function (result) {
        var row = node('li', 'merge-pattern'); row.appendChild(node('code', 'pattern', result.pattern));
        var good = !result.error && !result.incomplete && result.matched === 1;
        row.appendChild(chip(result.error || (result.incomplete ? t('ui.moreFiles') : result.matched === 0 ? t('merges.matchedNothing') : result.matched > 1 ? t('ui.ambiguous') : t('ui.sourcePresent')), good ? 'ok' : 'warn'));
        list.appendChild(row);
      });
      $('presetStatus').appendChild(list);
      $('presetStatus').appendChild(node('p', 'hint', t('ui.previewRequired')));
    });
  }

  document.querySelectorAll('[data-view-button]').forEach(function (button) {
    button.addEventListener('click', function () { selectView(button.getAttribute('data-view-button')); });
  });
  $('refreshData').addEventListener('click', function () { refreshAll(); });
  $('largestFiles').addEventListener('click', function () {
    selectView('files'); browseState.sort = 'largest'; browseState.search = ''; browseState.host = ''; browseState.history = false; browseState.skipped = 0;
    $('b-sort').value = 'largest'; $('b-search').value = ''; $('b-host').value = ''; $('b-history').checked = false; loadObjects();
  });
  $('s-object').addEventListener('change', chooseShareFile);
  $('s-password').addEventListener('input', updateActions);
  var shareSearchTimer = null;
  $('s-search').addEventListener('input', function () { clearTimeout(shareSearchTimer); shareSearchTimer = setTimeout(function () { loadShareFiles(); }, 200); });
  $('f-upload').addEventListener('change', function () {
    if (uploadBusy) return;
    uploadQueue = Array.prototype.slice.call($('f-upload').files || []).map(function (file) {
      var blocked = file.size > 104857600;
      return { file: file, name: file.name, size: file.size, status: blocked ? 'blocked' : 'pending', error: blocked ? t('ui.oversize') : '' };
    });
    renderUploadQueue();
  });
  $('retryUploads').addEventListener('click', function () { uploadSelected(true); });
  ['m-name','m-patterns','m-combination'].forEach(function (id) { $(id).addEventListener(id === 'm-combination' ? 'change' : 'input', mergeEdited); });
  selectView('files'); renderUploadQueue(); updateActions();
`;

export const WORKFLOW_STYLES = `
[hidden] { display: none !important; }
.workspace { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 20px; align-items: start; }
.workspace-nav { position: sticky; top: 16px; padding: 12px; display: grid; gap: 8px; }
.workspace-nav button { text-align: left; width: 100%; }
.workspace-nav .active { color: var(--blue); border-color: var(--blue); background: var(--field-bg); }
.workspace-main { min-width: 0; }
.workspace-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 14px; }
.workspace-summary .hint { margin: 0; }
.grid:not([data-view="hosts"]) { grid-template-columns: minmax(0, 1fr); }
.glass { --r-xl: 20px; }
.rail, .form, .rules, .panel, .browse, .storage, .shares, .direct, .merges, .runs { padding: 24px; min-width: 0; }
.workspace-main .glass { box-shadow: 0 8px 24px -18px rgba(16,24,40,.35), var(--inset); }
h2 { font-size: 20px; line-height: 1.3; margin-bottom: 8px; }
h3 { font-size: 16px; line-height: 1.4; margin: 20px 0 8px; }
.fields { align-items: end; }
.f.narrow { flex: 1 1 150px; }
.f.output-name { flex: 1 1 240px; }
.f.combination { flex: 2 1 340px; }
.f.toggle { display: flex; align-items: center; flex: 0 1 180px; min-height: 40px; }
.f.toggle input { width: 16px; height: 16px; flex: 0 0 16px; margin: 0; }
.browse .fields .f:first-child { flex-basis: 280px; }
.upload-area { border-top: 1px solid var(--edge-line); padding-top: 18px; margin: 18px 0; }
.upload-list, .source-check { list-style: none; margin: 10px 0; padding: 0; }
.upload-row { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--edge-line); align-items: center; }
.upload-name { flex: 1 1 220px; overflow-wrap: anywhere; }
.upload-row .hint { flex: 1 1 100%; margin: 0; }
.load-error { padding: 12px 0; }
.load-error .hint { margin: 0 0 8px; }
.manual-copy { width: 100%; flex-basis: 100%; }
.share-selection { overflow-wrap: anywhere; margin: 8px 0 16px; }
.share-picker { flex: 2 1 340px; }
.source-check .merge-pattern { flex-wrap: wrap; }
.source-check .chip { white-space: normal; line-height: 1.4; }
.storage .lede { max-width: 72ch; }
.storage details { margin-top: 16px; color: var(--muted); font-size: 13px; }
.empty-actions { margin-top: 12px; }
@media (max-width: 1100px) { .grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 1000px) {
  .workspace { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .workspace-nav { position: static; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; }
  .workspace-nav button { width: auto; flex: 1 1 110px; text-align: center; padding: 8px 10px; }
}
@media (max-width: 560px) {
  .rail, .form, .rules, .panel, .browse, .storage, .shares, .direct, .merges, .runs { padding: 18px 16px; }
  .f.narrow, .f.output-name, .f.combination, .share-picker { flex: 1 1 100%; }
  .f.toggle { flex: 1 1 100%; min-height: 32px; }
  .workspace-nav button { flex-basis: 95px; font-size: 12px; }
  .workspace-summary { gap: 8px; }
  h2 { font-size: 18px; }
}
`;

const copy = {
  'ui.nav.files': ['Files','文件','檔案','ファイル'],
  'ui.nav.links': ['Download links','下载链接','下載連結','ダウンロードリンク'],
  'ui.nav.merges': ['Combined files','合并文件','合併檔案','結合ファイル'],
  'ui.nav.runs': ['Collection','采集记录','採集記錄','収集履歴'],
  'ui.nav.hosts': ['Hosts and rules','主机与规则','主機與規則','ホストとルール'],
  'ui.refresh': ['Refresh','刷新','重新整理','更新'],
  'ui.loading': ['Loading…','正在加载…','正在載入…','読み込み中…'],
  'ui.retry': ['Retry','重试','重試','再試行'],
  'ui.copyManual': ['Copy this value manually','请手动复制此内容','請手動複製此內容','この値を手動でコピーしてください'],
  'ui.selectFile': ['Choose a stored file','选择已存文件','選擇已存檔案','保存済みファイルを選択'],
  'ui.findFile': ['Find a file by path','按路径查找文件','依路徑查找檔案','パスでファイルを検索'],
  'ui.moreFiles': ['Showing up to 200 files. Refine the search to find more.','最多显示 200 个文件，请缩小搜索范围。','最多顯示 200 個檔案，請縮小搜尋範圍。','最大200件を表示します。検索条件を絞ってください。'],
  'ui.emptyUploads': ['Choose files to see the upload queue.','选择文件后显示上传队列。','選擇檔案後顯示上傳佇列。','ファイルを選ぶとアップロード一覧を表示します。'],
  'ui.upload.pending': ['Pending','待上传','待上傳','待機中'],
  'ui.upload.uploading': ['Uploading','正在上传','正在上傳','アップロード中'],
  'ui.upload.done': ['Uploaded','已上传','已上傳','完了'],
  'ui.upload.failed': ['Failed','上传失败','上傳失敗','失敗'],
  'ui.upload.blocked': ['Too large','超过大小限制','超過大小限制','サイズ超過'],
  'ui.oversize': ['The file exceeds the 100 MiB limit.','文件超过 100 MiB，无法上传。','檔案超過 100 MiB，無法上傳。','100 MiBを超えるファイルはアップロードできません。'],
  'ui.retryUploads': ['Retry failed files','重试失败文件','重試失敗檔案','失敗したファイルを再試行'],
  'ui.processed': ['Processed {done} of {total} files','已处理 {done} / {total} 个文件','已處理 {done} / {total} 個檔案','{total}件中{done}件を処理'],
  'ui.capacityWarning': ['The selected files exceed the remaining capacity. Uploads may be refused.','所选文件超过剩余容量，部分上传可能被拒绝。','所選檔案超過剩餘容量，部分上傳可能遭拒。','選択したファイルが空き容量を超えています。一部は拒否される可能性があります。'],
  'ui.largestFiles': ['View largest files','查看大文件','查看大型檔案','大きいファイルを表示'],
  'ui.storagePolicy': ['Storage protection and capacity policy','文件保护与容量策略','檔案保護與容量策略','保護と容量の方針'],
  'ui.needHost': ['Add or enable a host before collecting.','请先添加或启用主机。','請先新增或啟用主機。','先にホストを追加または有効にしてください。'],
  'ui.collectWorking': ['Collecting…','正在采集…','正在採集…','収集中…'],
  'ui.collectDone': ['Collection completed on {host}.','主机 {host} 采集完成。','主機 {host} 採集完成。','{host}の収集が完了しました。'],
  'ui.collectStopped': ['Collection on {host} stopped at its time budget; the next run will resume.','主机 {host} 已到本轮时间预算，下次将续跑。','主機 {host} 已達本輪時間預算，下次將續跑。','{host}の収集は時間枠で停止しました。次回再開します。'],
  'ui.collectUnreachable': ['Could not connect to {host}.','无法连接主机 {host}。','無法連線主機 {host}。','{host}に接続できませんでした。'],
  'ui.collectUnknown': ['The request ended without a receipt. Refresh collection history before trying again.','请求结束但未收到回执，请先刷新采集记录再决定是否重试。','請求結束但未收到回執，請先重新整理採集記錄再決定是否重試。','結果を受信できませんでした。再試行の前に収集履歴を更新してください。'],
  'ui.cleanupFailed': ['{n} abandoned uploads could not be released. Check collection details.','有 {n} 个遗留上传未能释放，请查看采集详情。','有 {n} 個遺留上傳未能釋放，請查看採集詳情。','未完了アップロード{n}件を解放できませんでした。収集の詳細を確認してください。'],
  'ui.mergeSaved': ['Rule saved. Run it to build the file.','规则已保存，点击运行后生成文件。','規則已儲存，點選執行後產生檔案。','ルールを保存しました。実行してファイルを作成してください。'],
  'ui.sourcePresent': ['Source available','来源可用','來源可用','ソース利用可能'],
  'ui.ambiguous': ['Multiple sources; specify a host','多个来源，请指定主机','多個來源，請指定主機','複数のソースがあります。ホストを指定してください。'],
  'ui.previewRequired': ['Preview to validate the complete configuration before saving.','请预览完整配置，验证通过后再保存。','請預覽完整設定，驗證通過後再儲存。','保存する前にプレビューで設定全体を検証してください。'],
  'ui.linksEmpty': ['No direct links yet. Create one from a stored file.','暂无直链，请从已存文件创建。','尚無直連，請從已存檔案建立。','直接リンクはありません。保存済みファイルから作成してください。'],
} as const;

export const WORKFLOW_COPY: Record<string, Record<string, string>> = {};
for (const [index, locale] of ['en', 'zh-CN', 'zh-TW', 'ja'].entries()) {
  WORKFLOW_COPY[locale] = Object.fromEntries(Object.entries(copy).map(([key, values]) => [key, values[index]]));
}
