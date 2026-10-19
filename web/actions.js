/* ComfyDeck — central data-action dispatcher */
'use strict';

function withBusy(el, fn) {
  if (!el || el.dataset.busy === '1') return Promise.resolve();
  el.dataset.busy = '1';
  const isBtn = el.classList.contains('btn');
  if (isBtn) el.classList.add('loading');
  return Promise.resolve().then(fn).finally(() => {
    delete el.dataset.busy;
    if (isBtn) el.classList.remove('loading');
  });
}

async function handleAction(action, el, event) {
  const d = el.dataset;
  try {
    switch (action) {
      /* ------------------------------------------------------------ overlays */
      case 'close-modal': closeModal(); return;
      case 'close-drawer': closeDrawer(); return;
      case 'close-lightbox': closeLightbox(); return;
      case 'copy-el': copyEl(d.id); return;
      case 'copy-text': copyText(d.text); return;
      case 'copy-prompt-all': copyPromptAll(); return;
      case 'show-media': revealMedia(el, event); return;
      case 'open-civitai-image':
        if (d.id) window.open(`https://civitai.com/images/${encodeURIComponent(d.id)}`, '_blank', 'noopener');
        return;
      case 'expand-desc': document.getElementById(d.target || '')?.classList.toggle('expanded'); return;

      /* --------------------------------------------------------------- jobs */
      case 'job-center': await openJobCenter(); return;
      case 'job-open': if (d.id) await openJobModal(d.id); return;
      case 'job-cancel': await cancelJob(d.id); return;

      /* --------------------------------------------------------------- core */
      case 'core-check': await withBusy(el, runCoreCheck); return;
      case 'core-update': await withBusy(el, openCoreUpdateModal); return;
      case 'core-rollback': await withBusy(el, () => openCoreRollbackModal(d.ref || '')); return;
      case 'core-open': await withBusy(el, openComfy); return;

      /* ------------------------------------------------------------ launcher */
      case 'comfy-start': await withBusy(el, () => comfyStart(d.profile || '')); return;
      case 'comfy-stop': await withBusy(el, comfyStop); return;
      case 'comfy-restart': await withBusy(el, () => comfyRestart(d.profile || '')); return;
      case 'comfy-free': await withBusy(el, () => comfyOp('free')); return;
      case 'comfy-interrupt': await withBusy(el, () => comfyOp('interrupt')); return;
      case 'comfy-clear-queue': await withBusy(el, () => comfyOp('clear-queue')); return;
      case 'profile-select':
        LAUNCH.selected = d.id;
        renderProfiles();
        return;
      case 'profile-edit': await editProfile(d.id || ''); return;
      case 'profile-delete': await deleteProfile(d.id); return;

      /* -------------------------------------------------------------- models */
      case 'models-scan': await withBusy(el, scanModels); return;
      case 'models-match-all': await withBusy(el, startMatchAll); return;
      case 'models-check-updates': await withBusy(el, startCheckUpdates); return;
      case 'models-duplicates': await withBusy(el, openDuplicatesModal); return;
      case 'open-model': if (d.path) await openModelDetail(d.path); return;
      case 'toggle-fav':
        event?.stopPropagation();
        await toggleFavorite(d.path, d.on === '1');
        return;
      case 'model-reveal': await revealPath(d.path); return;
      case 'model-match': await withBusy(el, () => startModelMatch(d.path, true)); return;
      case 'model-hash': await withBusy(el, () => startModelHash(d.path)); return;
      case 'model-rename': await openRenameModal(d.path, d.name || ''); return;
      case 'model-delete': await deleteModel(d.path, d.name || ''); return;
      case 'model-note-save': await withBusy(el, () => saveModelNote(d.path)); return;
      case 'model-image': openModelImage(Number(d.index)); return;

      /* --------------------------------------------------------------- nodes */
      case 'nodes-check': await withBusy(el, startNodesCheck); return;
      case 'nodes-update-all': await withBusy(el, updateAllNodes); return;
      case 'nodes-install': openNodeInstallModal(); return;
      case 'node-info': openNodeInfo(d.dir); return;
      case 'node-update': await updateOneNode(d.dir, d.name || d.dir); return;
      case 'node-remove': await removeOneNode(d.dir, d.name || d.dir); return;

      /* ------------------------------------------------------------- civitai */
      case 'civ-more': await withBusy(el, () => searchCivitai(false)); return;
      case 'open-civitai':
        if (d.id) await openCivitaiModel(d.id);
        else toast('缺少模型 ID', 'err');
        return;
      case 'civ-download': openCivitaiDownload(d.version, d.file || 0); return;
      case 'civ-image': openCivitaiImage(Number(d.index)); return;

      /* ------------------------------------------------------------- gallery */
      case 'gal-cell': {
        const g = state.gallery;
        const idx = Number(d.index);
        if (g.selected.size) galToggleSelect(idx, event.shiftKey);
        else openViewer(g.items, idx);
        return;
      }
      case 'gal-select':
        event.stopPropagation();
        galToggleSelect(Number(d.index), event.shiftKey);
        return;
      case 'gal-select-all': galSelectAll(); return;
      case 'gal-select-clear': state.gallery.selected.clear(); refreshSelectionUI(); return;
      case 'gal-batch-fav': await galBatchFav(d.on === '1'); return;
      case 'gal-batch-delete': await galBatchDelete(); return;
      case 'gal-scan': await withBusy(el, galleryScan); return;
      case 'gal-scan-settings': await withBusy(el, async () => { await post('/api/gallery/scan'); toast('开始重新建立索引'); }); return;
      case 'overview-image': openOverviewImage(Number(d.index)); return;

      /* -------------------------------------------------------------- viewer */
      case 'viewer-close': closeViewer(); return;
      case 'viewer-prev': viewerGo(-1); return;
      case 'viewer-next': viewerGo(1); return;
      case 'viewer-zoom':
        if (state.viewer) { state.viewer.zoom = !state.viewer.zoom; $('#vw-stage')?.classList.toggle('zoom', state.viewer.zoom); }
        return;
      case 'viewer-fav': await viewerFav(); return;
      case 'viewer-reveal': await post('/api/gallery/reveal', { id: viewerItem().id }); return;
      case 'viewer-delete': await viewerDelete(); return;
      case 'viewer-save-wf': await withBusy(el, viewerSaveWorkflow); return;
      case 'viewer-to-input': await withBusy(el, viewerToInput); return;
      case 'viewer-copy-all': viewerCopyAll(); return;
      case 'viewer-filter': viewerFilterBy(d.model); return;

      /* ----------------------------------------------------------- workflows */
      case 'open-workflow':
        closeDrawer();
        location.hash = `#/workflows?id=${encodeURIComponent(d.id)}`;
        if (state.route === 'workflows') selectWorkflow(d.id);
        return;
      case 'wf-select': selectWorkflow(d.id); return;
      case 'wf-fit': state.workflows.graph?.fit(); return;
      case 'wf-fav': await wfToggleFav(d.id); return;
      case 'wf-duplicate': await wfDuplicate(d.id); return;
      case 'wf-rename': await wfRename(d.id); return;
      case 'wf-move': await wfMove(d.id); return;
      case 'wf-reveal': await post('/api/workflows/reveal', { id: d.id }); return;
      case 'wf-delete': await wfDelete(d.id); return;
      case 'wf-save-meta': await withBusy(el, () => wfSaveMeta(d.id)); return;
      case 'wf-import': wfImportPick(); return;
      case 'wf-find-model': wfFindModel(d.name); return;

      /* --------------------------------------------------------------- trash */
      case 'trash-restore': await trashRestore(d.id); return;
      case 'trash-purge': await trashPurge(d.id, d.name || ''); return;
      case 'trash-empty': await trashEmpty(); return;
      case 'trash-filter': trashKind = d.kind || ''; renderTrash(); return;

      /* ------------------------------------------------------------ settings */
      case 'settings-save': await withBusy(el, saveSettings); return;
      case 'settings-test-civitai': await withBusy(el, testCivitai); return;
      case 'paths-detect': await withBusy(el, () => detectPaths(false)); return;
      case 'paths-detect-deep': await withBusy(el, () => detectPaths(true)); return;
      case 'paths-browse': await withBusy(el, () => browsePath(d.kind || 'comfy')); return;
      case 'path-use': usePathCandidate(el); return;
      case 'app-quit': await quitApp(); return;
      case 'set-theme':
        applyTheme(d.value);
        $$('#set-theme button').forEach((b) => b.classList.toggle('active', b === el));
        return;
      case 'cache-clear': await withBusy(el, () => clearCache(d.prefix || '')); return;
      case 'open-folder': await withBusy(el, () => post('/api/open-folder', { kind: d.kind || '' })); return;
      case 'open-folder-path': await withBusy(el, () => openFolderPath(d.path || '')); return;
      case 'retry': refreshCurrent(); return;
      default: console.warn('Unknown action:', action);
    }
  } catch (err) {
    console.error('Action failed:', action, err);
    toast(err?.message || '操作失败', 'err', 6000);
  }
}

/* --------------------------------------------------------------- helpers */
async function revealPath(path) {
  if (path) await post('/api/models/reveal', { path });
}

async function cancelJob(id) {
  if (!id) return;
  const res = await showConfirm({ title: '取消任务', body: '确定取消这个后台任务吗？正在下载的文件会保留 <span class="mono">.part</span>，下次可以续传。', confirmText: '取消任务', danger: true });
  if (!res.ok) return;
  await post(`/api/jobs/${encodeURIComponent(id)}/cancel`);
  toast('已请求取消任务');
  pollJobs();
  if (state.route === 'downloads') refreshDownloads();
}

function revealMedia(el, event) {
  event?.stopPropagation();
  const wrap = el.closest('[data-media-wrap]') || el.parentElement;
  if (!wrap) return;
  wrap.querySelectorAll('img, video').forEach((m) => m.classList.remove('blur-media'));
  wrap.querySelectorAll('.media-guard').forEach((g) => g.remove());
}

function openModelImage(index) {
  const detail = state.modelDetail;
  const image = (detail?.civitai?.images || [])[index];
  if (!image) { toast('没有找到这张参考图', 'err'); return; }
  openLightbox(image, detail?.name || '模型参考图');
}

function openCivitaiImage(index) {
  const detail = state.civitaiDetail;
  const image = (detail?.images?.length ? detail.images : detail?.model?.versions?.[0]?.images || [])[index];
  if (!image) { toast('没有找到这张参考图', 'err'); return; }
  openLightbox(image, detail?.model?.name || 'CivitAI 参考图');
}

function copyPromptAll() {
  const image = state.lightbox;
  if (!image) return;
  const meta = image.meta || {};
  const parts = [];
  if (meta.prompt) parts.push(`Positive prompt:\n${meta.prompt}`);
  if (meta.negativePrompt) parts.push(`Negative prompt:\n${meta.negativePrompt}`);
  const params = [
    ['Steps', meta.steps], ['Sampler', meta.sampler], ['CFG scale', meta.cfgScale],
    ['Seed', meta.seed], ['Size', meta.Size || (image.width && image.height ? `${image.width}x${image.height}` : '')],
    ['Model', meta.Model], ['Model hash', meta.ModelHash], ['Clip skip', meta.clipSkip], ['Version', meta.Version],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (params.length) parts.push(params.map(([k, v]) => `${k}: ${v}`).join('\n'));
  const resources = Array.isArray(meta.resources) ? meta.resources : [];
  if (resources.length) parts.push(resources.map((r) => `${r.type || 'Resource'}: ${r.name || ''}${r.weight != null ? ` (weight ${r.weight})` : ''}`).join('\n'));
  if (!parts.length) { toast('这张图片没有可复制的生成参数', 'err'); return; }
  copyText(parts.join('\n\n'));
}
