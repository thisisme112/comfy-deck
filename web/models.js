/* ComfyDeck — model library */
'use strict';

ROUTES.models = { title: '模型库', render: renderModels };

function renderModels() {
  const f = state.models.filters;
  const params = routeParams();
  if (params.usage) { f.usage = params.usage; history.replaceState(null, '', '#/models'); }
  $('#view').innerHTML = `<div class="page">
    ${pageHead('模型库', '<span id="model-summary">正在读取模型目录…</span>', `
      <button class="btn" data-action="models-scan">${icon('rotate')} 重新扫描</button>
      <button class="btn" data-action="models-match-all">${icon('link')} 匹配 CivitAI</button>
      <button class="btn" data-action="models-check-updates">${icon('arrowUp')} 检查新版本</button>
      <button class="btn" data-action="models-duplicates">${icon('copy')} 重复文件</button>`)}
    <div class="toolbar">
      <div class="search-wrap">${icon('search')}<input class="input" id="model-search" placeholder="搜索文件名、模型名、基础模型或触发词…" value="${esc(f.q)}"></div>
      <select class="select" id="model-type"><option value="">全部类型</option></select>
      <select class="select" id="model-matched">
        <option value="">匹配状态</option>
        <option value="yes" ${f.matched === 'yes' ? 'selected' : ''}>已匹配 CivitAI</option>
        <option value="no" ${f.matched === 'no' ? 'selected' : ''}>未匹配</option>
      </select>
      <select class="select" id="model-usage" title="按工作流使用情况筛选">
        <option value="">使用情况</option>
        <option value="used" ${f.usage === 'used' ? 'selected' : ''}>被工作流使用</option>
        <option value="unused" ${f.usage === 'unused' ? 'selected' : ''}>没被任何工作流用到</option>
        <option value="update" ${f.usage === 'update' ? 'selected' : ''}>有新版本</option>
      </select>
      <select class="select" id="model-sort">
        <option value="name" ${f.sort === 'name' ? 'selected' : ''}>名称</option>
        <option value="date_desc" ${f.sort === 'date_desc' ? 'selected' : ''}>最近修改</option>
        <option value="size_desc" ${f.sort === 'size_desc' ? 'selected' : ''}>体积从大到小</option>
        <option value="size_asc" ${f.sort === 'size_asc' ? 'selected' : ''}>体积从小到大</option>
        <option value="downloads" ${f.sort === 'downloads' ? 'selected' : ''}>CivitAI 下载量</option>
        <option value="type" ${f.sort === 'type' ? 'selected' : ''}>类型</option>
      </select>
      <button class="btn sm ${f.favorite ? 'active' : ''}" id="model-fav">${icon('star')} 收藏</button>
      <div class="seg" id="model-view">
        <button data-view="grid" class="${state.models.view === 'grid' ? 'active' : ''}" title="网格">${icon('grid')}</button>
        <button data-view="list" class="${state.models.view === 'list' ? 'active' : ''}" title="列表">${icon('list')}</button>
      </div>
    </div>
    <div id="model-results">${modelSkeleton()}</div>
  </div>`;
  bindModelToolbar();
  loadModels(true);
}

function bindModelToolbar() {
  const f = state.models.filters;
  $('#model-search')?.addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); loadModels(false); }, 280));
  $('#model-type')?.addEventListener('change', (e) => { f.type = e.target.value; loadModels(false); });
  $('#model-matched')?.addEventListener('change', (e) => { f.matched = e.target.value; loadModels(false); });
  $('#model-usage')?.addEventListener('change', (e) => { f.usage = e.target.value; loadModels(false); });
  $('#model-sort')?.addEventListener('change', (e) => { f.sort = e.target.value; loadModels(false); });
  $('#model-fav')?.addEventListener('click', () => {
    f.favorite = !f.favorite;
    $('#model-fav').classList.toggle('active', f.favorite);
    loadModels(false);
  });
  $$('#model-view button').forEach((btn) => btn.addEventListener('click', () => {
    state.models.view = btn.dataset.view;
    $$('#model-view button').forEach((b) => b.classList.toggle('active', b === btn));
    renderModelResults();
  }));
}

async function loadModels(showLoading = true) {
  const token = ++state.models.req;
  state.models.loading = true;
  if (showLoading && !state.models.items.length) $('#model-results').innerHTML = modelSkeleton();
  const f = state.models.filters;
  const params = new URLSearchParams();
  if (f.q) params.set('q', f.q);
  if (f.type) params.set('type', f.type);
  if (f.sort) params.set('sort', f.sort);
  if (f.matched) params.set('matched', f.matched);
  if (f.usage) params.set('usage', f.usage);
  if (f.favorite) params.set('favorite', 'yes');
  try {
    const data = await api(`/api/models?${params.toString()}`);
    if (token !== state.models.req) return;
    state.models.items = data.items || [];
    state.models.total = data.total || 0;
    state.models.summary = data.summary || { count: 0, size: 0 };
    state.models.allTypes = (data.all_summary && data.all_summary.types) || data.summary?.types || state.models.allTypes || [];
    state.models.loaded = true;
    state.models.loading = false;
    updateModelTypeSelect();
    updateModelSummary(data);
    renderModelResults();
    const nav = $('#nav-models-count');
    const n = data.all_summary?.count || data.total || 0;
    if (nav) nav.textContent = n ? String(n) : '';
  } catch (err) {
    if (token !== state.models.req) return;
    state.models.loading = false;
    const box = $('#model-results');
    if (box) box.innerHTML = errorHtml(err.message);
  }
}

function updateModelTypeSelect() {
  const sel = $('#model-type');
  if (!sel) return;
  const current = state.models.filters.type;
  sel.innerHTML = `<option value="">全部类型</option>${(state.models.allTypes || []).map((t) => `<option value="${esc(t.type)}" ${current === t.type ? 'selected' : ''}>${esc(typeLabel(t.type))} (${t.count})</option>`).join('')}`;
}

function updateModelSummary(data) {
  const el = $('#model-summary');
  if (!el) return;
  const s = data.summary || {};
  el.textContent = `${fmtNum(data.total || 0)} 个模型 · ${fmtBytes(s.size || 0)} · ${s.civitai_matched || 0} 个已匹配 CivitAI · ${(data.roots || []).length} 个模型目录`;
}

function modelSkeleton() {
  return `<div class="cards">${Array.from({ length: 10 }).map(() => `<div class="skeleton" style="aspect-ratio:4/6"></div>`).join('')}</div>`;
}

function renderModelResults() {
  const box = $('#model-results');
  if (!box) return;
  const items = state.models.items;
  if (!items.length) {
    box.innerHTML = state.models.loading ? modelSkeleton() : emptyHtml('没有找到模型。可以调整筛选条件，或在设置中添加其他模型目录。', 'layers');
    return;
  }
  box.innerHTML = state.models.view === 'list' ? modelListHtml(items) : `<div class="cards">${items.map(modelCardHtml).join('')}</div>`;
}

function modelCardHtml(m) {
  const civ = m.civitai && !m.civitai.notFound ? m.civitai : null;
  const base = civ?.baseModel || m.local_meta?.base_model || '';
  const extra = `<div class="corner tl"><span class="tag-dark">${esc(typeLabel(m.type))}</span>${m.update ? `<span class="tag-dark accent">${icon('arrowUp')} 新版</span>` : ''}</div>
    <div class="corner tr"><button class="fav-btn ${m.favorite ? 'on' : ''}" data-action="toggle-fav" data-path="${esc(m.path)}" data-on="${m.favorite ? '0' : '1'}" title="收藏">${icon('star')}</button></div>
    ${m.used_by ? `<div class="corner bl"><span class="tag-dark">${icon('workflow')} ${m.used_by}</span></div>` : ''}`;
  return `<article class="mcard sq" data-action="open-model" data-path="${esc(m.path)}">
    ${mediaThumb(m.preview_url, { label: typeLabel(m.type), extra })}
    <div class="body">
      <div class="name" title="${esc(m.name)}">${esc(m.name)}</div>
      <div class="meta"><span class="l" title="${esc(base)}">${base ? esc(base) : '未匹配'}</span><span class="mono">${fmtBytes(m.size)}</span></div>
    </div>
  </article>`;
}

function modelListHtml(items) {
  return `<div class="table-wrap"><table><thead><tr><th>模型</th><th>类型</th><th>大小</th><th>基础模型</th><th>CivitAI</th><th>工作流</th><th></th></tr></thead><tbody>
    ${items.map((m) => {
      const civ = m.civitai && !m.civitai.notFound ? m.civitai : null;
      const base = civ?.baseModel || m.local_meta?.base_model || '—';
      return `<tr class="click" data-action="open-model" data-path="${esc(m.path)}" style="cursor:pointer">
        <td><div class="node-name">${m.favorite ? `<span style="color:#f3c94d;display:grid">${icon('star').replace('<svg', '<svg fill="currentColor" width="12" height="12"')}</span>` : ''}${esc(m.name)}</div><div class="sub mono">${esc(m.folder.replace(/\\/g, '/').split('/').slice(-2).join('/'))}</div></td>
        <td><span class="badge">${esc(typeLabel(m.type))}</span></td>
        <td class="mono">${fmtBytes(m.size)}</td>
        <td>${esc(base)}</td>
        <td>${civ ? (m.update ? '<span class="badge accent">有新版</span>' : '<span class="badge green">已匹配</span>') : '<span class="badge gray">未匹配</span>'}</td>
        <td class="dim">${m.used_by ? `${m.used_by} 个` : '—'}</td>
        <td><div class="row-actions"><button class="btn xs" data-action="model-reveal" data-path="${esc(m.path)}" title="打开所在文件夹">${icon('folder')}</button></div></td>
      </tr>`;
    }).join('')}
  </tbody></table></div>`;
}

/* --------------------------------------------------------------- detail */
async function openModelDetail(path) {
  closeModal(true);
  state.drawerPath = path;
  openDrawer('模型详情', loadingHtml('读取模型信息…'));
  try {
    const m = await api(`/api/models/detail?path=${encodeURIComponent(path)}`);
    if (state.drawerPath !== path) return;
    state.modelDetail = m;
    const drawer = state.drawer?.drawer;
    if (!drawer) return;
    drawer.querySelector('.drawer-body').innerHTML = modelDetailHtml(m);
    drawer.querySelector('.drawer-head h3').textContent = m.name;
  } catch (err) {
    const drawer = state.drawer?.drawer;
    if (drawer) drawer.querySelector('.drawer-body').innerHTML = errorHtml(err.message);
  }
}

function modelDetailHtml(m) {
  const civ = m.civitai && !m.civitai.notFound ? m.civitai : null;
  const notFound = m.civitai && m.civitai.notFound;
  const local = m.local_meta || {};
  const cover = m.preview_url
    ? `<img src="${esc(m.preview_url)}" alt="" class="cover-lg" style="max-height:260px" onerror="this.style.display='none'">`
    : '';
  const tags = [...(local.tags || []), ...((civ && civ.trainedWords) || [])].filter((v, i, a) => v && a.indexOf(v) === i);
  const stats = civ?.stats || {};
  const description = civ?.modelDescription || civ?.description || '';
  const used = m.used_in || [];

  return `${cover}
    <div class="row between ${cover ? 'mt-12' : ''}" style="align-items:flex-start">
      <div style="min-width:0"><div class="row wrap" style="gap:5px"><span class="badge">${esc(typeLabel(m.type))}</span>${m.favorite ? '<span class="badge amber">收藏</span>' : ''}${civ ? '<span class="badge green">CivitAI 已匹配</span>' : ''}</div>
      <div class="copy-line mt-8"><span class="mono small break dim" id="md-path">${esc(m.path)}</span><button class="copy-btn" data-action="copy-el" data-id="md-path" title="复制路径">${icon('copy')}</button></div></div>
      <button class="fav-btn ${m.favorite ? 'on' : ''}" data-action="toggle-fav" data-path="${esc(m.path)}" data-on="${m.favorite ? '0' : '1'}" title="收藏" style="background:var(--surface-3);width:28px;height:28px">${icon('star')}</button>
    </div>
    ${m.update ? `<div class="callout warn mt-12">${icon('arrowUp')}<div>CivitAI 上有新版本 <b>${esc(m.update.versionName)}</b>${m.update.publishedAt ? ` · ${esc(fmtDate(m.update.publishedAt).slice(0, 10))}` : ''}</div><button class="btn xs" data-action="open-civitai" data-id="${esc(civ?.modelId || '')}">查看</button></div>` : ''}
    <div class="row wrap mt-12" style="gap:6px">
      <button class="btn sm ${civ ? '' : 'primary'}" data-action="model-match" data-path="${esc(m.path)}">${icon('link')} ${civ ? '重新匹配' : '匹配 CivitAI'}</button>
      <button class="btn sm" data-action="model-hash" data-path="${esc(m.path)}">${icon('hash')} 计算哈希</button>
      <button class="btn sm" data-action="model-reveal" data-path="${esc(m.path)}">${icon('folder')} 打开目录</button>
      <button class="btn sm" data-action="model-rename" data-path="${esc(m.path)}" data-name="${esc(m.name)}">${icon('edit')} 重命名</button>
      <button class="btn sm danger" data-action="model-delete" data-path="${esc(m.path)}" data-name="${esc(m.name)}">${icon('trash')} 删除</button>
    </div>

    <div class="divider"></div>
    <div class="kv">
      <div class="k">类型</div><div class="v">${esc(typeLabel(m.type))}</div>
      <div class="k">大小</div><div class="v mono">${fmtBytes(m.size)}</div>
      <div class="k">修改时间</div><div class="v">${fmtDate(m.mtime)}</div>
      <div class="k">SHA256</div><div class="v">${m.sha256 ? `<span class="copy-line"><span class="mono tiny break" id="md-sha">${esc(m.sha256)}</span><button class="copy-btn" data-action="copy-el" data-id="md-sha">${icon('copy')}</button></span>` : '<span class="dim">未计算</span>'}</div>
      <div class="k">基础模型</div><div class="v">${esc(civ?.baseModel || local.base_model || '—')}</div>
      ${local.ss_network_module ? `<div class="k">网络模块</div><div class="v mono">${esc(local.ss_network_module)}${local.ss_network_dim ? ` · dim ${esc(local.ss_network_dim)}` : ''}</div>` : ''}
      ${local.title ? `<div class="k">标题</div><div class="v">${esc(local.title)}</div>` : ''}
    </div>
    ${tags.length ? `<div class="mini-label mt-16">触发词 / 标签 <span class="dim" style="font-weight:400">（点击复制）</span></div><div class="chips">${tags.map((t) => `<button class="chip trigger" data-action="copy-text" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}

    <div class="divider"></div>
    <div class="section-head"><h3>${icon('workflow')} 被这些工作流使用</h3></div>
    ${used.length ? `<div class="list">${used.map((w) => `<div class="list-row click" data-action="open-workflow" data-id="${esc(w.id)}"><div class="grow"><div class="t">${esc(w.name)}</div></div>${icon('chevronRight')}</div>`).join('')}</div>` : '<div class="dim small">没有找到引用它的工作流（按文件名匹配）。</div>'}

    <div class="divider"></div>
    <div class="section-head"><h3>${icon('compass')} CivitAI</h3></div>
    ${notFound ? `<div class="callout warn">${icon('alert')}<div>这个文件的 SHA256 没有被 CivitAI 收录，可能是私有 / 融合 / 新上传的模型。</div></div>` : (civ ? civSectionHtml(m, civ, stats, description) : `<div class="callout">${icon('info')}<div>还没有 CivitAI 元数据。“匹配 CivitAI”会计算 SHA256 并查询介绍、触发词、参考图和提示词。</div></div>`)}

    <div class="divider"></div>
    <div class="section-head"><h3>${icon('edit')} 备注</h3><span class="hint">仅保存在本机</span></div>
    <textarea class="textarea" id="model-note" placeholder="例如：常用人物 LoRA，权重 0.8…">${esc(m.note || '')}</textarea>
    <div class="row mt-8"><button class="btn sm" data-action="model-note-save" data-path="${esc(m.path)}">${icon('save')} 保存备注</button></div>

    ${m.duplicates && m.duplicates.length ? `<div class="divider"></div><div class="mini-label">重复文件 (${m.duplicates.length})</div>${m.duplicates.map((d) => `<div class="file-row"><div class="grow"><div class="fname">${esc(d.name)}</div><div class="fmeta">${esc(d.path)}</div></div><button class="btn xs" data-action="model-reveal" data-path="${esc(d.path)}">${icon('folder')}</button></div>`).join('')}` : ''}`;
}

function civSectionHtml(m, civ, stats, description) {
  const images = civ.images || [];
  return `<div class="row between wrap mb-12">
      <div><div style="font-weight:650;font-size:13.5px">${esc(civ.modelName || '')}</div><div class="dim small">${esc(civ.versionName || '')} · ${esc(civ.creator || '')}</div></div>
      ${civ.pageUrl ? `<a class="btn sm" href="${esc(civ.pageUrl)}" target="_blank" rel="noopener">${icon('external')} CivitAI 页面</a>` : ''}
    </div>
    <div class="stat-inline mb-12"><span>下载 <b>${fmtNum(stats.downloadCount)}</b></span><span>点赞 <b>${fmtNum(stats.thumbsUpCount)}</b></span>${stats.rating ? `<span>评分 <b>${Number(stats.rating).toFixed(2)}</b></span>` : ''}</div>
    ${description ? `<div class="mini-label">模型介绍</div><div class="desc" id="md-desc">${esc(description)}</div><button class="btn ghost xs mt-8" data-action="expand-desc" data-target="md-desc">展开 / 收起</button>` : ''}
    ${images.length ? `<div class="mini-label mt-16">参考图</div><div class="gallery">${images.slice(0, 12).map((img, idx) => `<div class="g-item" data-action="model-image" data-index="${idx}" title="查看提示词">${mediaThumb(img.thumb || img.url, { nsfw: Number(img.nsfwLevel) > 1 && !state.nsfw })}<span class="meta-flag">${img.hasMeta ? 'PROMPT' : 'VIEW'}</span></div>`).join('')}</div>` : ''}
    <div class="mt-16"><button class="btn sm" data-action="open-civitai" data-id="${esc(civ.modelId || '')}">${icon('compass')} 查看完整模型卡</button></div>`;
}

/* --------------------------------------------------------------- actions */
async function toggleFavorite(path, on) {
  await post('/api/models/flags', { path, favorite: on });
  const item = state.models.items.find((m) => m.path === path);
  if (item) item.favorite = on;
  renderModelResults();
  if (state.drawerPath === path) openModelDetail(path);
}

async function saveModelNote(path) {
  await post('/api/models/flags', { path, note: $('#model-note')?.value || '' });
  toast('备注已保存');
}

async function startModelHash(path) {
  await startJobRequest('/api/models/hash', { path }, { message: '开始计算 SHA256', onDone: () => refreshModelAfterJob(path) });
}

async function startModelMatch(path, force = false) {
  await startJobRequest('/api/models/match', { path, force }, { message: '开始匹配 CivitAI', onDone: () => refreshModelAfterJob(path) });
}

function refreshModelAfterJob(path) {
  if (state.route === 'models') loadModels(false);
  if (state.drawerPath === path) openModelDetail(path);
}

async function startMatchAll() {
  const res = await showConfirm({
    title: '匹配全部模型',
    body: '将计算所有未匹配模型的 SHA256，并逐个查询 CivitAI。大模型（10 GB 以上）计算哈希可能需要几十秒，整个任务可能持续较长时间。',
    confirmText: '开始匹配',
    extraHtml: `<label class="check-row"><input type="checkbox" data-confirm-field="force"> 强制重新匹配已匹配的模型</label>`,
  });
  if (!res.ok) return;
  await startJobRequest('/api/models/match-all', { force: !!res.force }, { message: '批量匹配任务已开始', onDone: () => { if (state.route === 'models') loadModels(false); } });
}

async function startCheckUpdates() {
  await startJobRequest('/api/models/check-updates', {}, {
    message: '开始检查模型新版本',
    onDone: (job) => {
      const n = job.result?.updates;
      if (n != null) toast(n ? `发现 ${n} 个模型有新版本` : '已匹配的模型都是最新版');
      if (state.route === 'models') loadModels(false);
    },
  });
}

async function openRenameModal(path, name) {
  const res = await showConfirm({
    title: '重命名模型', body: '只修改文件名，所在目录不变。请保留扩展名。注意：引用旧文件名的工作流需要重新选择模型。', confirmText: '保存',
    extraHtml: `<div class="field"><label>新文件名</label><input class="input" data-confirm-field="name" value="${esc(name)}"></div>`,
  });
  if (!res.ok || !res.name || res.name === name) return;
  const out = await post('/api/models/rename', { path, new_name: res.name });
  toast(`已重命名为 ${out.name}`);
  closeDrawer();
  loadModels(false);
}

async function deleteModel(path, name) {
  const res = await showConfirm({
    title: '删除模型文件', body: `把 <b>${esc(name)}</b> 移到回收站？之后可以在“回收站”里恢复。`, confirmText: '移到回收站', danger: true,
  });
  if (!res.ok) return;
  await post('/api/models/delete', { path });
  toast('模型已移入回收站');
  closeDrawer();
  loadModels(false);
}

async function scanModels() {
  const data = await post('/api/models/scan');
  toast(`扫描完成，共 ${data.total} 个模型`);
  state.models.loaded = false;
  if (state.route === 'models') loadModels(true);
  if (state.route === 'overview') renderOverview();
}

async function openDuplicatesModal() {
  const data = await api('/api/models/duplicates');
  const groups = data.groups || [];
  const body = groups.length ? groups.map((g) => `
    <div class="mb-16">
      <div class="row between mb-8"><div><b class="mono small">${esc(g.sha256.slice(0, 20))}…</b><div class="dim tiny">${fmtBytes(g.size)} × ${g.count} 个文件，可释放 ${fmtBytes(g.size * (g.count - 1))}</div></div><span class="badge amber">重复</span></div>
      ${g.models.map((m) => `<div class="file-row"><div class="grow"><div class="fname">${esc(m.name)}</div><div class="fmeta">${esc(m.path)}</div></div><button class="btn xs" data-action="open-model" data-path="${esc(m.path)}">详情</button><button class="btn xs" data-action="model-reveal" data-path="${esc(m.path)}">${icon('folder')}</button></div>`).join('')}
    </div>`).join('') : emptyHtml('没有发现重复文件。计算过 SHA256 的模型才能进行重复检测。', 'check');
  showModal(modalHead('重复模型', '按 SHA256 分组，建议保留一份并清理其余副本') + `<div class="modal-body">${body}</div>`, { medium: true });
}
