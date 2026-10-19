/* ComfyDeck — CivitAI browser */
'use strict';

ROUTES.civitai = { title: 'CivitAI', render: renderCivitai, leave: leaveCivitai };

const CIV_TYPE_OPTIONS = [
  ['', '全部类型'], ['Checkpoint', 'Checkpoint'], ['LORA', 'LoRA'], ['LoCon', 'LyCORIS / LoCon'],
  ['DoRA', 'DoRA'], ['Controlnet', 'ControlNet'], ['TextualInversion', 'Embedding'],
  ['VAE', 'VAE'], ['Upscaler', 'Upscaler'], ['Motion', 'Motion'], ['Poses', 'Poses'],
];

const BASE_MODEL_SUGGESTIONS = ['Illustrious', 'NoobAI', 'Pony', 'SDXL 1.0', 'SD 1.5', 'Flux.1 D', 'Flux.1 S', 'ZImageTurbo', 'Anima', 'Qwen', 'Wan Video'];

function renderCivitai() {
  const f = state.civitai.filters;
  $('#view').innerHTML = `<div class="page">
    ${pageHead('CivitAI', '搜索模型、查看参考图与提示词，一键下载到对应的模型目录', `<span class="badge ${state.nsfw ? 'amber' : 'gray'}">${state.nsfw ? 'NSFW 已允许' : 'NSFW 默认模糊'}</span>`)}
    <form id="civ-search-form">
      <div class="toolbar" style="margin-bottom:8px">
        <div class="search-wrap" style="flex:2 1 320px">${icon('search')}<input class="input" id="civ-query" placeholder="搜索模型名或关键词，例如 illustrious、detail、anime…" value="${esc(f.query)}"></div>
        <div class="search-wrap" style="flex:0 1 170px">${icon('user')}<input class="input" id="civ-user" placeholder="作者用户名" value="${esc(f.username)}"></div>
        <button class="btn primary" type="submit">${icon('search')} 搜索</button>
      </div>
      <div class="toolbar">
        <select class="select" id="civ-type">${CIV_TYPE_OPTIONS.map(([v, l]) => `<option value="${v}" ${f.types === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="select" id="civ-sort">
          <option value="Most Downloaded" ${f.sort === 'Most Downloaded' ? 'selected' : ''}>最多下载</option>
          <option value="Highest Rated" ${f.sort === 'Highest Rated' ? 'selected' : ''}>最高评分</option>
          <option value="Most Liked" ${f.sort === 'Most Liked' ? 'selected' : ''}>最多点赞</option>
          <option value="Newest" ${f.sort === 'Newest' ? 'selected' : ''}>最新发布</option>
        </select>
        <select class="select" id="civ-period">
          ${[['AllTime', '全部时间'], ['Year', '最近一年'], ['Month', '最近一月'], ['Week', '最近一周'], ['Day', '今天']].map(([v, l]) => `<option value="${v}" ${f.period === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <div class="search-wrap" style="flex:0 1 190px">${icon('filter')}<input class="input" id="civ-base" list="base-model-list" placeholder="基础模型（可选）" value="${esc(f.baseModels)}"></div>
        <datalist id="base-model-list">${BASE_MODEL_SUGGESTIONS.map((b) => `<option value="${esc(b)}"></option>`).join('')}</datalist>
        <label class="switch"><input type="checkbox" id="civ-hide-installed" ${f.hideInstalled ? 'checked' : ''}><span class="track"></span><span class="label">隐藏已安装</span></label>
        <button class="btn sm ghost" type="button" id="civ-reset">${icon('rotate')} 重置</button>
        <span class="hint" id="civ-summary" style="margin-left:auto">准备搜索…</span>
      </div>
    </form>
    <div id="civ-results">${civitaiSkeleton()}</div>
    <div class="pagination" id="civ-more-wrap"></div>
  </div>`;
  bindCivitaiFilters();
  searchCivitai(true);
}

function leaveCivitai() {
  if (state.civitai._io) { state.civitai._io.disconnect(); state.civitai._io = null; }
}

function bindCivitaiFilters() {
  $('#civ-search-form').addEventListener('submit', (e) => { e.preventDefault(); searchCivitai(true); });
  ['#civ-type', '#civ-sort', '#civ-period'].forEach((sel) => $(sel)?.addEventListener('change', () => searchCivitai(true)));
  $('#civ-base')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchCivitai(true); } });
  $('#civ-base')?.addEventListener('change', () => searchCivitai(true));
  $('#civ-hide-installed')?.addEventListener('change', (e) => { state.civitai.filters.hideInstalled = e.target.checked; renderCivitaiResults(); });
  $('#civ-reset')?.addEventListener('click', () => {
    state.civitai.filters = { query: '', types: '', sort: 'Most Downloaded', period: 'AllTime', baseModels: '', username: '', hideInstalled: false };
    renderCivitai();
  });
}

function civitaiSkeleton() {
  return `<div class="cards">${Array.from({ length: 12 }).map(() => `<div class="skeleton" style="aspect-ratio:4/6"></div>`).join('')}</div>`;
}

async function searchCivitai(reset = false) {
  const c = state.civitai;
  if (c.loading && !reset) return;
  if (!reset && !c.nextCursor) return;
  if (reset) {
    c.filters = {
      query: $('#civ-query')?.value.trim() || '',
      username: $('#civ-user')?.value.trim() || '',
      types: $('#civ-type')?.value || '',
      sort: $('#civ-sort')?.value || 'Most Downloaded',
      period: $('#civ-period')?.value || 'AllTime',
      baseModels: $('#civ-base')?.value.trim() || '',
      hideInstalled: !!$('#civ-hide-installed')?.checked,
    };
  }
  const token = ++c.req;
  c.loading = true;
  if (reset) {
    c.items = []; c.nextCursor = null;
    const box = $('#civ-results'); if (box) box.innerHTML = civitaiSkeleton();
    const s = $('#civ-summary'); if (s) s.textContent = '正在请求 CivitAI…';
  } else {
    renderCivitaiMore();
  }
  const f = c.filters;
  const params = new URLSearchParams();
  if (f.query) params.set('query', f.query);
  if (f.username) params.set('username', f.username);
  if (f.types) params.set('types', f.types);
  if (f.sort) params.set('sort', f.sort);
  if (f.period) params.set('period', f.period);
  if (f.baseModels) params.set('baseModels', f.baseModels);
  params.set('limit', '24');
  if (!reset && c.nextCursor) params.set('cursor', c.nextCursor);
  try {
    const data = await api(`/api/civitai/search?${params.toString()}`);
    if (token !== c.req || state.route !== 'civitai') return;
    c.loading = false;
    const seen = new Set(c.items.map((m) => m.id));
    c.items = reset ? (data.items || []) : c.items.concat((data.items || []).filter((m) => !seen.has(m.id)));
    c.nextCursor = data.nextCursor || null;
    const summary = $('#civ-summary');
    if (summary) summary.textContent = `已加载 ${c.items.length} 个${f.query ? ` · “${f.query}”` : ''}${f.period !== 'AllTime' ? ` · ${periodLabel(f.period)}` : ''}`;
    renderCivitaiResults();
  } catch (err) {
    if (token !== c.req || state.route !== 'civitai') return;
    c.loading = false;
    const box = $('#civ-results');
    if (box && !c.items.length) box.innerHTML = errorHtml(err.message);
    const summary = $('#civ-summary'); if (summary) summary.textContent = '请求失败';
    toast(err.message, 'err', 5200);
    renderCivitaiMore();
  }
}

function periodLabel(p) {
  return { AllTime: '全部时间', Year: '最近一年', Month: '最近一月', Week: '最近一周', Day: '今天' }[p] || p;
}

function renderCivitaiResults() {
  const c = state.civitai;
  const box = $('#civ-results');
  if (!box) return;
  const items = c.filters.hideInstalled ? c.items.filter((m) => !m.installed) : c.items;
  box.innerHTML = items.length
    ? `<div class="cards">${items.map(civitaiCardHtml).join('')}</div>`
    : emptyHtml(c.items.length ? '当前结果都已安装。' : '没有找到模型。换个关键词、基础模型或排序方式试试。', 'compass');
  renderCivitaiMore();
}

function renderCivitaiMore() {
  const c = state.civitai;
  const more = $('#civ-more-wrap');
  if (!more) return;
  if (c.nextCursor) {
    more.innerHTML = c.loading ? `<span class="spinner"></span>` : `<button class="btn" data-action="civ-more">${icon('arrowDown')} 加载更多</button>`;
    if (!c._io) {
      c._io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && state.civitai.nextCursor && !state.civitai.loading) searchCivitai(false);
      }, { root: $('#view'), rootMargin: '500px' });
    }
    c._io.disconnect();
    c._io.observe(more);
  } else {
    more.innerHTML = c.items.length ? `<span class="dim small">已加载全部结果</span>` : '';
  }
}

function civitaiCardHtml(m) {
  const version = m.versions?.[0] || {};
  const nsfw = !state.nsfw && (Number(m.coverNsfw) > 1 || m.nsfw);
  const extra = `<div class="corner tl"><span class="tag-dark">${esc(m.type)}</span>${m.baseModels?.[0] ? `<span class="tag-dark">${esc(m.baseModels[0])}</span>` : ''}</div>
    ${m.installed ? `<div class="corner tr"><span class="tag-dark accent">${icon('check')} 已安装</span></div>` : ''}
    ${m.nsfw ? `<div class="corner bl"><span class="tag-dark" style="color:var(--err)">NSFW</span></div>` : ''}`;
  return `<article class="mcard ${m.installed ? 'owned' : ''}" data-action="open-civitai" data-id="${esc(m.id)}">
    ${mediaThumb(m.cover, { nsfw, extra })}
    <div class="body">
      <div class="name" title="${esc(m.name)}">${esc(m.name)}</div>
      <div class="meta"><span class="l">${esc(m.creator?.username || '未知作者')}${version.name ? ` · ${esc(version.name)}` : ''}</span></div>
      <div class="stats"><span>${icon('download')} ${fmtNum(m.stats?.downloadCount)}</span><span>${icon('heart')} ${fmtNum(m.stats?.thumbsUpCount)}</span>${m.stats?.rating ? `<span>${icon('star')} ${Number(m.stats.rating).toFixed(1)}</span>` : ''}</div>
    </div>
  </article>`;
}

/* ---------------------------------------------------------- detail modal */
async function openCivitaiModel(id) {
  state.civitaiDetail = { model: null, versionId: null, images: [], loadingImages: false };
  const overlay = showModal(modalHead('CivitAI 模型', '正在读取模型信息…') + `<div class="modal-body" id="civ-detail-body">${loadingHtml('正在获取模型介绍与版本…')}</div>`, { wide: true });
  try {
    const model = await api(`/api/civitai/models/${id}`);
    if (!state.modal || state.modal.overlay !== overlay) return;
    const version = model.versions?.[0] || null;
    state.civitaiDetail.model = model;
    state.civitaiDetail.versionId = version?.id || null;
    const head = overlay.querySelector('.modal-head');
    if (head) head.innerHTML = `<div><h3>${esc(model.name)}</h3><div class="sub">${esc(model.type)} · ${esc(model.creator?.username || '未知作者')} · ${fmtNum(model.stats?.downloadCount)} 次下载</div></div><button class="modal-close" data-action="close-modal">${icon('x')}</button>`;
    renderCivitaiDetail();
    loadCivitaiImages(version?.id);
  } catch (err) {
    const body = $('#civ-detail-body');
    if (body) body.innerHTML = errorHtml(err.message);
  }
}

function currentCivitaiVersion() {
  const detail = state.civitaiDetail;
  if (!detail?.model) return null;
  return (detail.model.versions || []).find((v) => v.id === detail.versionId) || detail.model.versions?.[0] || null;
}

function renderCivitaiDetail() {
  const detail = state.civitaiDetail;
  const body = $('#civ-detail-body');
  if (!body || !detail.model) return;
  const model = detail.model;
  const version = currentCivitaiVersion();
  if (!version) { body.innerHTML = emptyHtml('该模型没有可用版本。', 'alert'); return; }
  const installed = new Set(model.installed_versions || []);
  const hasVersion = installed.has(version.id);
  const description = model.description || '';
  const versionDesc = version.description && version.description !== description ? version.description : '';
  const stats = version.stats || {};
  const files = version.files || [];
  const images = detail.images.length ? detail.images : (version.images || []);
  const hero = images.find((i) => !i.isVideo && (state.nsfw || (i.nsfwLevel || 1) <= 1)) || images.find((i) => !i.isVideo) || images[0];
  const heroNsfw = hero && Number(hero.nsfwLevel) > 1 && !state.nsfw;
  body.innerHTML = `
    <div class="grid-main" style="grid-template-columns:minmax(0,1fr) 300px;gap:20px">
      <div style="min-width:0">
        <div class="row wrap" style="gap:5px"><span class="badge accent">${esc(model.type)}</span>${model.nsfw ? '<span class="badge red">NSFW</span>' : ''}${(model.baseModels || []).slice(0, 3).map((b) => `<span class="badge">${esc(b)}</span>`).join('')}${hasVersion ? '<span class="badge green">此版本已安装</span>' : (installed.size ? '<span class="badge amber">已安装其他版本</span>' : '')}</div>
        <div class="dim small mt-8">by <b style="color:var(--text)">${esc(model.creator?.username || '未知')}</b> · 版本发布于 ${esc(fmtDate(version.publishedAt).slice(0, 10))}</div>
        <div class="stat-inline mt-12">
          <span>下载 <b>${fmtNum(model.stats?.downloadCount)}</b></span>
          <span>点赞 <b>${fmtNum(model.stats?.thumbsUpCount)}</b></span>
          ${model.stats?.rating ? `<span>评分 <b>${Number(model.stats.rating).toFixed(2)}</b></span>` : ''}
          <span>本版本下载 <b>${fmtNum(stats.downloadCount)}</b></span>
        </div>
        <div class="row wrap mt-16" style="gap:6px">
          <select class="select" id="civ-version-select" style="max-width:100%">${(model.versions || []).map((v) => `<option value="${esc(v.id)}" ${v.id === version.id ? 'selected' : ''}>${esc(v.name || '未命名版本')}${v.baseModel ? ` · ${esc(v.baseModel)}` : ''}${installed.has(v.id) ? ' ✓' : ''}</option>`).join('')}</select>
          <span class="tiny dim">共 ${(model.versions || []).length} 个版本</span>
        </div>
        ${(version.trainedWords || []).length ? `<div class="mini-label mt-16">触发词 <span class="dim" style="font-weight:400">（点击复制）</span></div><div class="chips">${version.trainedWords.map((w) => `<button class="chip trigger" data-action="copy-text" data-text="${esc(w)}">${esc(w)}</button>`).join('')}</div>` : ''}
        ${(model.tags || []).length ? `<div class="chips mt-12">${model.tags.slice(0, 12).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
        ${description ? `<div class="mini-label mt-16">模型介绍</div><div class="desc" id="civ-desc">${esc(description)}</div><button class="btn ghost xs mt-8" data-action="expand-desc" data-target="civ-desc">展开 / 收起</button>` : ''}
        ${versionDesc ? `<div class="mini-label mt-16">版本说明</div><div class="desc">${esc(versionDesc)}</div>` : ''}
        <div class="section-head mt-20"><h3>${icon('image')} 参考图与提示词</h3><span class="hint">点击图片查看生成参数</span></div>
        <div id="civ-gallery">${civitaiGalleryHtml(images)}</div>
      </div>
      <div style="min-width:0">
        ${hero ? `<div class="thumb pos-rel" style="aspect-ratio:3/4;border-radius:var(--r-lg)" data-media-wrap><div class="ph">${icon('image')}</div><img src="${esc(hero.thumb)}" class="${heroNsfw ? 'blur-media' : ''}" alt="" onerror="this.remove()">${heroNsfw ? `<div class="media-guard"><button class="btn" data-action="show-media">${icon('eye')} 显示</button></div>` : ''}</div>` : ''}
        <div class="stack mt-12" style="gap:8px">
          <button class="btn primary block" data-action="civ-download" data-version="${esc(version.id)}" data-file="0">${icon('download')} ${hasVersion ? '重新下载' : '下载模型'}</button>
          ${model.pageUrl ? `<a class="btn block" href="${esc(model.pageUrl)}" target="_blank" rel="noopener">${icon('external')} 在 CivitAI 打开</a>` : ''}
        </div>
        <div class="section-head mt-20"><h3>${icon('package')} 文件</h3></div>
        ${files.map((file, idx) => `<div class="file-row">
          <div class="grow"><div class="fname">${esc(file.name)}</div><div class="fmeta">${fmtKB(file.sizeKB)}${file.format ? ` · ${esc(file.format)}` : ''}${file.fp ? ` · ${esc(file.fp)}` : ''}${file.primary ? ' · 主文件' : ''}</div></div>
          <button class="btn xs" data-action="civ-download" data-version="${esc(version.id)}" data-file="${idx}">${icon('download')}</button>
        </div>`).join('') || '<div class="dim small">该版本没有可用文件。</div>'}
        <div class="hint-box mt-16">${icon('info')}<div>需要登录或 Early Access 的模型请先在设置里填写 CivitAI API Key。下载前请确认模型许可。</div></div>
      </div>
    </div>`;
  $('#civ-version-select', body)?.addEventListener('change', (e) => {
    detail.versionId = Number(e.target.value);
    detail.images = [];
    renderCivitaiDetail();
    loadCivitaiImages(detail.versionId);
  });
}

function civitaiGalleryHtml(images) {
  if (!images || !images.length) return `<div class="empty" style="padding:24px">没有获取到参考图</div>`;
  return `<div class="gallery">${images.slice(0, 16).map((img, idx) => {
    const nsfw = Number(img.nsfwLevel) > 1 && !state.nsfw;
    return `<div class="g-item" data-action="civ-image" data-index="${idx}">${mediaThumb(img.thumb || img.url, { nsfw })}<span class="meta-flag">${img.isVideo ? 'VIDEO' : (img.meta?.prompt ? 'PROMPT' : 'VIEW')}</span></div>`;
  }).join('')}</div>`;
}

async function loadCivitaiImages(versionId) {
  const detail = state.civitaiDetail;
  if (!detail || !versionId) return;
  detail.loadingImages = true;
  try {
    const data = await api(`/api/civitai/versions/${versionId}/images?limit=24`);
    if (!state.civitaiDetail || state.civitaiDetail.versionId !== versionId) return;
    detail.images = data.items || [];
    detail.loadingImages = false;
    const gallery = $('#civ-gallery');
    if (gallery) gallery.innerHTML = civitaiGalleryHtml(detail.images);
  } catch (err) { detail.loadingImages = false; }
}

/* -------------------------------------------------------------- download */
function openCivitaiDownload(versionId, fileIndex) {
  const detail = state.civitaiDetail;
  if (!detail?.model) return;
  const version = (detail.model.versions || []).find((v) => v.id === Number(versionId)) || currentCivitaiVersion();
  if (!version) { toast('版本不存在', 'err'); return; }
  const file = (version.files || [])[Number(fileIndex)] || (version.files || [])[0];
  if (!file) { toast('该版本没有可下载文件', 'err'); return; }
  const defaultType = CIVITAI_TYPE_TO_DIR[version.modelType] || 'checkpoints';
  const options = DOWNLOAD_DIRS.map(([value, label]) => `<option value="${value}" ${value === defaultType ? 'selected' : ''}>${label}</option>`).join('');
  showConfirm({
    title: '下载 CivitAI 模型',
    body: `<div class="file-row"><div class="grow"><div class="fname">${esc(file.name)}</div><div class="fmeta">${fmtKB(file.sizeKB)} · ${esc(version.modelName || '')} / ${esc(version.name || '')}</div></div><span class="badge blue">${esc(version.baseModel || '')}</span></div>`,
    confirmText: '开始下载',
    extraHtml: `<div class="form-grid">
        <div class="field"><label>保存到模型目录</label><select class="select" style="width:100%" data-confirm-field="type">${options}</select></div>
        <div class="field"><label>文件名</label><input class="input" data-confirm-field="filename" value="${esc(file.name)}"></div>
      </div>
      <div class="hint-box mt-12">${icon('info')}<div>下载到 <span class="mono">ComfyUI/models/&lt;类型&gt;</span>，支持断点续传（.part）。完成后自动写入 CivitAI 元数据与预览图。</div></div>
      <label class="check-row mt-12"><input type="checkbox" data-confirm-field="open_folder"> 下载完成后打开所在文件夹</label>`,
  }).then(async (res) => {
    if (!res.ok) return;
    await startJobRequest('/api/downloads', {
      version_id: version.id, file_index: Number(fileIndex) || 0, type: res.type, filename: res.filename,
    }, {
      message: '下载任务已加入队列',
      onDone: (job) => {
        if (res.open_folder && job.result?.path) post('/api/models/reveal', { path: job.result.path }).catch(() => {});
        if (state.route === 'models') loadModels(false);
        if (state.route === 'downloads') renderDownloads();
      },
    });
  });
}
