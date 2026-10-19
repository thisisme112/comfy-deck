/* ComfyDeck — image gallery */
'use strict';

ROUTES.gallery = { title: '图库', render: renderGallery, flush: true, leave: leaveGallery };

const GAL_PAGE = 120;

function galFilters() { return state.gallery.filters; }

async function renderGallery() {
  const g = state.gallery;
  const f = g.filters;
  $('#view').innerHTML = `<div class="gal-wrap">
    <div class="gal-bar">
      <div class="search-wrap" style="max-width:340px">${icon('search')}<input class="input" id="gal-q" placeholder="搜索提示词、模型、LoRA、种子、文件名…" value="${esc(f.q)}"></div>
      <div class="seg" id="gal-root"></div>
      <select class="select" id="gal-folder" title="文件夹"><option value="">全部文件夹</option></select>
      <select class="select" id="gal-model" title="按模型筛选" style="max-width:190px"><option value="">全部模型</option></select>
      <select class="select" id="gal-kind"><option value="">图片和视频</option><option value="image">仅图片</option><option value="video">仅视频</option></select>
      <select class="select" id="gal-sort"><option value="new">最新优先</option><option value="old">最早优先</option><option value="name">文件名</option><option value="size">体积最大</option></select>
      <button class="btn sm" id="gal-fav" title="只看收藏">${icon('star')} 收藏</button>
      <button class="btn sm" id="gal-wf" title="只看带工作流的图片">${icon('workflow')} 含工作流</button>
      <span class="grow"></span>
      <span class="index-note" id="gal-index"></span>
      <input type="range" id="gal-cell" min="120" max="360" step="10" value="${g.cell}" title="缩略图大小" style="width:90px">
      <div class="seg" id="gal-view">
        <button data-view="grid" title="网格">${icon('grid')}</button>
        <button data-view="sq" title="方形">${icon('square')}</button>
        <button data-view="flow" title="瀑布流">${icon('columns')}</button>
      </div>
      <button class="btn sm" data-action="gal-scan" title="重新扫描文件夹">${icon('refresh')}</button>
    </div>
    <div class="gal-scroll" id="gal-scroll"><div id="gal-content"></div><div id="gal-sentinel" style="height:1px"></div><div class="pagination" id="gal-more"></div></div>
  </div>`;
  $('#gal-sort').value = f.sort;
  $('#gal-kind').value = f.kind;
  $('#gal-fav').classList.toggle('active', f.favorite);
  $('#gal-wf').classList.toggle('active', f.workflow);
  syncGalView();
  bindGalleryBar();
  document.addEventListener('keydown', galleryKeys);
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadGallery(false);
  }, { root: $('#gal-scroll'), rootMargin: '600px' });
  io.observe($('#gal-sentinel'));
  g._io = io;
  await Promise.all([loadGalleryFacets(), loadGallery(true)]);
}

function leaveGallery() {
  document.removeEventListener('keydown', galleryKeys);
  if (state.gallery._io) { state.gallery._io.disconnect(); state.gallery._io = null; }
  state.gallery.selected.clear();
  removeSelbar();
}

function syncGalView() {
  const g = state.gallery;
  $$('#gal-view button').forEach((b) => b.classList.toggle('active', b.dataset.view === g.view));
}

function bindGalleryBar() {
  const g = state.gallery;
  const f = g.filters;
  $('#gal-q').addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); loadGallery(true); }, 280));
  $('#gal-folder').addEventListener('change', (e) => { f.folder = e.target.value; loadGallery(true); });
  $('#gal-model').addEventListener('change', (e) => { f.model = e.target.value; loadGallery(true); });
  $('#gal-kind').addEventListener('change', (e) => { f.kind = e.target.value; loadGallery(true); });
  $('#gal-sort').addEventListener('change', (e) => { f.sort = e.target.value; loadGallery(true); });
  $('#gal-fav').addEventListener('click', () => { f.favorite = !f.favorite; $('#gal-fav').classList.toggle('active', f.favorite); loadGallery(true); });
  $('#gal-wf').addEventListener('click', () => { f.workflow = !f.workflow; $('#gal-wf').classList.toggle('active', f.workflow); loadGallery(true); });
  $('#gal-cell').addEventListener('input', (e) => {
    g.cell = Number(e.target.value);
    localStorage.setItem('cd-gal-cell', String(g.cell));
    $$('.gal-grid').forEach((el) => el.style.setProperty('--cell', `${g.cell}px`));
  });
  $$('#gal-view button').forEach((b) => b.addEventListener('click', () => {
    g.view = b.dataset.view;
    localStorage.setItem('cd-gal-view', g.view);
    syncGalView();
    renderGalleryContent();
  }));
  $('#gal-root').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    f.root = b.dataset.root; f.folder = ''; f.model = '';
    loadGalleryFacets();
    loadGallery(true);
  });
}

async function loadGalleryFacets() {
  const g = state.gallery;
  try {
    const data = await api(`/api/gallery/facets?root=${encodeURIComponent(g.filters.root)}`);
    g.facets = data;
    if (state.route !== 'gallery') return;
    const rootsInfo = data.roots_info || [];
    if (g.filters.root && !rootsInfo.find((r) => r.key === g.filters.root)) g.filters.root = '';
    const counts = Object.fromEntries((data.roots || []).map((r) => [r.root, r.n]));
    $('#gal-root').innerHTML = [['', '全部'], ...rootsInfo.map((r) => [r.key, r.label])]
      .map(([k, label]) => `<button data-root="${esc(k)}" class="${g.filters.root === k ? 'active' : ''}">${esc(label)}${k && counts[k] ? ` <span class="dim">${counts[k]}</span>` : ''}</button>`).join('');
    const folders = (data.folders || []).filter((x) => x.folder);
    $('#gal-folder').innerHTML = `<option value="">全部文件夹</option>${folders.map((x) => `<option value="${esc(x.folder)}" ${g.filters.folder === x.folder ? 'selected' : ''}>${esc(x.folder)} (${x.n})</option>`).join('')}`;
    $('#gal-model').innerHTML = `<option value="">全部模型</option>${(data.models || []).map((m) => `<option value="${esc(m.model)}" ${g.filters.model === m.model ? 'selected' : ''}>${esc(m.model.replace(/\.(safetensors|ckpt|gguf|pt)$/i, ''))} (${m.n})</option>`).join('')}`;
    updateGalleryIndexNote(data.indexer);
  } catch (e) { /* noop */ }
}

function updateGalleryIndexNote(ix) {
  const el = $('#gal-index');
  if (!el) return;
  el.textContent = ix && ix.running ? `正在建立索引 ${ix.done}/${ix.total || '…'}` : '';
  if (ix && ix.running) {
    clearTimeout(state.timers.galIndex);
    state.timers.galIndex = setTimeout(async () => {
      if (state.route !== 'gallery') return;
      const st = await api('/api/gallery/facets?root=' + encodeURIComponent(state.gallery.filters.root)).catch(() => null);
      if (!st) return;
      updateGalleryIndexNote(st.indexer);
      if (!st.indexer.running) { loadGalleryFacets(); loadGallery(true); }
    }, 1500);
  }
}

async function loadGallery(reset) {
  const g = state.gallery;
  if (g.loading && !reset) return;
  if (!reset && g.items.length >= g.total) return;
  const token = ++g.req;
  g.loading = true;
  if (reset) {
    g.offset = 0;
    if (!g.items.length) $('#gal-content').innerHTML = `<div class="loading-page"><div class="spinner"></div></div>`;
  }
  const f = g.filters;
  const params = new URLSearchParams({ sort: f.sort, offset: String(reset ? 0 : g.items.length), limit: String(GAL_PAGE) });
  if (f.q) params.set('q', f.q);
  if (f.kind) params.set('kind', f.kind);
  if (f.root) params.set('root', f.root);
  if (f.folder) params.set('folder', f.folder);
  if (f.model) params.set('model', f.model);
  if (f.favorite) params.set('favorite', '1');
  if (f.workflow) params.set('workflow', '1');
  try {
    const data = await api(`/api/gallery?${params.toString()}`);
    if (token !== g.req || state.route !== 'gallery') return;
    g.items = reset ? data.items : g.items.concat(data.items);
    g.total = data.total;
    g.loading = false;
    if (reset) { const sc = $('#gal-scroll'); if (sc) sc.scrollTop = 0; g.selected.clear(); updateSelbar(); }
    updateGalleryIndexNote(data.indexer);
    renderGalleryContent();
  } catch (err) {
    g.loading = false;
    if (state.route === 'gallery') $('#gal-content').innerHTML = errorHtml(err.message);
  }
}

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  const wk = '日一二三四五六'[d.getDay()];
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 周${wk}`;
}

function renderGalleryContent() {
  const g = state.gallery;
  const box = $('#gal-content');
  if (!box) return;
  if (!g.items.length) {
    const ix = g.facets?.indexer;
    box.innerHTML = ix && ix.running ? `<div class="loading-page"><div class="spinner"></div><div>正在扫描图片…</div></div>` : `<div style="padding-top:30px">${emptyHtml(g.facets?.totals?.n ? '没有符合条件的图片。' : '图库是空的。生成图片后会出现在这里；也可以在设置里添加其他图片文件夹。', 'image')}</div>`;
    $('#gal-more').innerHTML = '';
    return;
  }
  const grouped = g.filters.sort === 'new' || g.filters.sort === 'old';
  const groups = [];
  g.items.forEach((item, index) => {
    const key = grouped ? dayLabel(item.mtime) : '';
    let grp = groups[groups.length - 1];
    if (!grp || grp.key !== key) { grp = { key, cells: [] }; groups.push(grp); }
    grp.cells.push(galleryCell(item, index));
  });
  const selecting = g.selected.size > 0 ? 'selecting' : '';
  box.innerHTML = groups.map((grp) => `${grp.key ? `<div class="day">${esc(grp.key)}<span>${grp.cells.length} 项</span></div>` : ''}<div class="gal-grid ${g.view} ${selecting}" style="--cell:${g.cell}px">${grp.cells.join('')}</div>`).join('');
  $('#gal-more').innerHTML = g.items.length < g.total
    ? `<span class="dim small">${g.loading ? '加载中…' : `已显示 ${g.items.length} / ${g.total}`}</span>`
    : `<span class="dim small">共 ${fmtNum(g.total)} 项</span>`;
}

function galleryCell(item, index) {
  const g = state.gallery;
  const sel = g.selected.has(item.id);
  const ratio = g.view === 'flow' && item.width && item.height ? ` style="aspect-ratio:${item.width}/${item.height}"` : '';
  const media = item.kind === 'video'
    ? `<video src="${esc(item.url)}#t=0.1" preload="metadata" muted playsinline></video>`
    : `<img src="${esc(item.thumb)}" loading="lazy" decoding="async" alt="" onerror="this.style.opacity=0">`;
  return `<div class="gcell ${sel ? 'selected' : ''}" data-action="gal-cell" data-index="${index}" data-id="${esc(item.id)}"${ratio}>
    ${media}<div class="shade"></div><div class="cap">${esc(item.name)}</div>
    <div class="sel" data-action="gal-select" data-index="${index}">${icon('check')}</div>
    ${item.favorite ? `<span class="favmark">${icon('star')}</span>` : ''}
    ${item.kind === 'video' ? `<span class="vid tag-dark">${icon('film')} 视频</span>` : ''}
  </div>`;
}

/* ---------------------------------------------------------- selection */
function galToggleSelect(index, shift) {
  const g = state.gallery;
  const item = g.items[index];
  if (!item) return;
  if (shift && g.lastSel != null) {
    const [a, b] = [Math.min(g.lastSel, index), Math.max(g.lastSel, index)];
    for (let i = a; i <= b; i += 1) g.selected.add(g.items[i].id);
  } else if (g.selected.has(item.id)) g.selected.delete(item.id);
  else g.selected.add(item.id);
  g.lastSel = index;
  refreshSelectionUI();
}

function refreshSelectionUI() {
  const g = state.gallery;
  const selecting = g.selected.size > 0;
  $$('.gal-grid').forEach((el) => el.classList.toggle('selecting', selecting));
  $$('.gcell').forEach((el) => el.classList.toggle('selected', g.selected.has(el.dataset.id)));
  updateSelbar();
}

function removeSelbar() { $('#selbar')?.remove(); }

function updateSelbar() {
  const g = state.gallery;
  removeSelbar();
  if (!g.selected.size || state.route !== 'gallery') return;
  const bar = document.createElement('div');
  bar.id = 'selbar';
  bar.className = 'selbar';
  bar.innerHTML = `<span><b>${g.selected.size}</b> 项已选</span>
    <button class="btn sm" data-action="gal-select-all">全选已加载</button>
    <button class="btn sm" data-action="gal-batch-fav" data-on="1">${icon('star')} 收藏</button>
    <button class="btn sm" data-action="gal-batch-fav" data-on="0">取消收藏</button>
    <button class="btn sm danger" data-action="gal-batch-delete">${icon('trash')} 删除</button>
    <button class="btn sm ghost" data-action="gal-select-clear">${icon('x')}</button>`;
  $('#view').appendChild(bar);
}

function galleryKeys(e) {
  if (state.route !== 'gallery' || state.viewer || state.modal) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const g = state.gallery;
  if (e.key === 'Escape' && g.selected.size) { g.selected.clear(); refreshSelectionUI(); }
  else if (e.key === 'Delete' && g.selected.size) galBatchDelete();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); galSelectAll(); }
}

function galSelectAll() {
  const g = state.gallery;
  g.items.forEach((i) => g.selected.add(i.id));
  refreshSelectionUI();
}

async function galBatchFav(on) {
  const g = state.gallery;
  const ids = [...g.selected];
  await post('/api/gallery/flags', { ids, favorite: on });
  g.items.forEach((i) => { if (g.selected.has(i.id)) i.favorite = on; });
  toast(on ? `已收藏 ${ids.length} 项` : `已取消收藏 ${ids.length} 项`);
  if (g.filters.favorite && !on) { g.selected.clear(); loadGallery(true); loadGalleryFacets(); return; }
  renderGalleryContent(); updateSelbar();
}

async function galBatchDelete(ids) {
  const g = state.gallery;
  ids = ids || [...g.selected];
  if (!ids.length) return;
  const res = await showConfirm({ title: '删除图片', body: `把 <b>${ids.length}</b> 张图片移到回收站？之后可以在“回收站”里恢复。`, confirmText: '移到回收站', danger: true });
  if (!res.ok) return;
  const out = await post('/api/gallery/delete', { ids });
  toast(`已移到回收站 ${out.deleted} 项`);
  const gone = new Set(ids);
  g.items = g.items.filter((i) => !gone.has(i.id));
  g.total = Math.max(0, g.total - ids.length);
  g.selected.clear();
  renderGalleryContent(); updateSelbar(); loadGalleryFacets();
  return true;
}

/* ------------------------------------------------------------- viewer */
function openViewer(items, index, opts = {}) {
  closeViewer();
  const V = { items, index, zoom: false, onChange: opts.onChange || null };
  state.viewer = V;
  const el = document.createElement('div');
  el.className = 'viewer';
  document.body.appendChild(el);
  V.el = el;
  renderViewer();
  V.keys = (e) => {
    if (state.modal) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft') viewerGo(-1);
    else if (e.key === 'ArrowRight') viewerGo(1);
    else if (e.key === 'Escape') closeViewer();
    else if (e.key.toLowerCase() === 'f') viewerFav();
    else if (e.key === 'Delete') viewerDelete();
  };
  document.addEventListener('keydown', V.keys);
}

function closeViewer() {
  const V = state.viewer;
  if (!V) return;
  document.removeEventListener('keydown', V.keys);
  V.el.remove();
  state.viewer = null;
}

function viewerItem() { return state.viewer?.items[state.viewer.index]; }

function viewerGo(step) {
  const V = state.viewer;
  if (!V) return;
  const next = V.index + step;
  if (next < 0 || next >= V.items.length) return;
  V.index = next; V.zoom = false;
  renderViewer();
  if (state.route === 'gallery' && next >= V.items.length - 8) loadGallery(false).then(() => { V.items = state.gallery.items; });
}

function renderViewer() {
  const V = state.viewer;
  const item = viewerItem();
  if (!item) { closeViewer(); return; }
  const media = item.kind === 'video'
    ? `<video src="${esc(item.url)}" controls autoplay loop playsinline></video>`
    : `<img src="${esc(item.url)}" alt="" data-action="viewer-zoom">`;
  const kv = [
    ['模型', item.model ? `<button class="chip" data-action="viewer-filter" data-model="${esc(item.model)}" title="只看用这个模型生成的图">${esc(item.model.replace(/\.(safetensors|ckpt|gguf|pt)$/i, ''))}</button>` : ''],
    ['LoRA', item.loras.length ? `<div class="chips">${item.loras.map((l) => `<button class="chip" data-action="viewer-filter" data-model="${esc(l)}">${esc(l.replace(/\.(safetensors|ckpt|pt)$/i, ''))}</button>`).join('')}</div>` : ''],
    ['采样', [item.sampler, item.scheduler].filter(Boolean).map(esc).join(' / ')],
    ['步数 / CFG', [item.steps, item.cfg].filter((x) => x != null && x !== '').join(' / ')],
    ['种子', item.seed ? `<span class="mono">${esc(item.seed)}</span>` : ''],
    ['尺寸', item.width ? `${item.width} × ${item.height}` : ''],
    ['文件', `${fmtBytes(item.size)} · ${esc(item.ext.slice(1).toUpperCase())}`],
    ['时间', fmtDate(item.mtime)],
    ['位置', `<span class="mono tiny break">${esc(item.rel)}</span>`],
  ].filter(([, v]) => v);
  const box = (label, id, text) => `<div><div class="pbox-head"><span class="mini-label">${label}</span><button class="btn xs ghost" data-action="copy-el" data-id="${id}">${icon('copy')} 复制</button></div><div class="prompt-box" id="${id}">${esc(text)}</div></div>`;
  V.el.innerHTML = `
    <div class="viewer-stage ${V.zoom ? 'zoom' : ''}" id="vw-stage">
      ${V.index > 0 ? `<button class="viewer-nav prev" data-action="viewer-prev">${icon('chevronLeft')}</button>` : ''}
      ${V.index < V.items.length - 1 ? `<button class="viewer-nav next" data-action="viewer-next">${icon('chevronRight')}</button>` : ''}
      ${media}
      <div class="viewer-count">${V.index + 1} / ${V.items.length}${state.route === 'gallery' && state.gallery.total > V.items.length ? '+' : ''}</div>
    </div>
    <div class="viewer-side">
      <div class="head"><div class="t">${esc(item.name)}</div><button class="icon-btn" data-action="viewer-close" title="关闭 (Esc)">${icon('x')}</button></div>
      <div class="body">
        <div class="acts">
          <button class="btn sm ${item.favorite ? 'active' : ''}" data-action="viewer-fav" title="快捷键 F">${icon('star')} ${item.favorite ? '已收藏' : '收藏'}</button>
          <button class="btn sm" data-action="viewer-reveal">${icon('folder')} 打开位置</button>
          <a class="btn sm" href="${esc(item.url)}" download="${esc(item.name)}">${icon('download')} 原图</a>
          <button class="btn sm danger" data-action="viewer-delete" title="Delete">${icon('trash')}</button>
        </div>
        ${item.prompt ? box('正向提示词', 'vw-prompt', item.prompt) : ''}
        ${item.negative ? box('反向提示词', 'vw-negative', item.negative) : ''}
        ${!item.prompt && !item.model ? `<div class="dim small">这张图没有可识别的生成参数。</div>` : ''}
        ${kv.length ? `<div class="kv">${kv.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>` : ''}
        ${item.kind === 'image' ? `<div><div class="mini-label">工作流 / 复用</div><div class="acts">
          ${item.has_workflow ? `<button class="btn sm" data-action="viewer-save-wf">${icon('workflow')} 存入工作流库</button><a class="btn sm" href="/api/gallery/${esc(item.id)}/workflow">${icon('download')} 下载 JSON</a>` : '<span class="dim small">没有内嵌工作流</span>'}
          <button class="btn sm" data-action="viewer-to-input" title="复制到 ComfyUI/input，方便在 Load Image 里选用">${icon('send')} 用作输入图</button>
          ${item.prompt ? `<button class="btn sm" data-action="viewer-copy-all">${icon('copy')} 复制全部参数</button>` : ''}
        </div></div>` : ''}
      </div>
    </div>`;
}

function viewerCopyAll() {
  const i = viewerItem();
  if (!i) return;
  const lines = [];
  if (i.prompt) lines.push(i.prompt);
  if (i.negative) lines.push(`Negative prompt: ${i.negative}`);
  const params = [['Steps', i.steps], ['Sampler', i.sampler], ['Schedule type', i.scheduler], ['CFG scale', i.cfg], ['Seed', i.seed], ['Size', i.width ? `${i.width}x${i.height}` : ''], ['Model', i.model]].filter(([, v]) => v !== '' && v != null);
  if (params.length) lines.push(params.map(([k, v]) => `${k}: ${v}`).join(', '));
  copyText(lines.join('\n'));
}

async function viewerFav() {
  const item = viewerItem();
  if (!item) return;
  item.favorite = !item.favorite;
  await post('/api/gallery/flags', { ids: [item.id], favorite: item.favorite });
  renderViewer();
  if (state.route === 'gallery') renderGalleryContent();
}

async function viewerDelete() {
  const V = state.viewer;
  const item = viewerItem();
  if (!item) return;
  const res = await showConfirm({ title: '删除图片', body: `把 <b>${esc(item.name)}</b> 移到回收站？`, confirmText: '移到回收站', danger: true });
  if (!res.ok) return;
  await post('/api/gallery/delete', { ids: [item.id] });
  toast('已移到回收站');
  V.items.splice(V.index, 1);
  if (state.route === 'gallery') {
    state.gallery.items = state.gallery.items.filter((i) => i.id !== item.id);
    state.gallery.total = Math.max(0, state.gallery.total - 1);
    renderGalleryContent();
  }
  if (!V.items.length) { closeViewer(); return; }
  V.index = Math.min(V.index, V.items.length - 1);
  renderViewer();
}

async function viewerSaveWorkflow() {
  const item = viewerItem();
  const out = await post('/api/gallery/save-workflow', { id: item.id });
  toast(`已存入工作流库：${out.id.split('/').pop()}`);
}

async function viewerToInput() {
  const out = await post('/api/gallery/to-input', { id: viewerItem().id });
  toast(`已复制到 input：${out.name}`);
}

function viewerFilterBy(model) {
  closeViewer();
  state.gallery.filters.model = model;
  if (state.route !== 'gallery') location.hash = '#/gallery';
  else { loadGallery(true); loadGalleryFacets(); }
}

async function galleryScan() {
  await post('/api/gallery/scan');
  toast('开始重新扫描');
  loadGalleryFacets();
}
