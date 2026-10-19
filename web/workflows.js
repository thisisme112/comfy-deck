/* ComfyDeck — workflow library */
'use strict';

ROUTES.workflows = { title: '工作流', render: renderWorkflows, flush: true, leave: leaveWorkflows };

function routeParams() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

async function renderWorkflows() {
  const W = state.workflows;
  $('#view').innerHTML = `<div class="wf-layout" id="wf-root">
    <div class="drop-hint">松开鼠标，导入工作流 JSON</div>
    <div class="wf-left">
      <div class="bar-top">
        <div class="row"><div class="search-wrap" style="flex:1">${icon('search')}<input class="input" id="wf-q" placeholder="搜索名称、节点、模型、标签…" value="${esc(W.filters.q)}"></div>
          <button class="btn sm primary" data-action="wf-import" title="导入 JSON，也可以直接把文件拖进来">${icon('upload')} 导入</button></div>
        <div class="row">
          <select class="select" id="wf-folder" style="flex:1;min-width:0"><option value="">全部文件夹</option></select>
          <select class="select" id="wf-sort"><option value="new">最近修改</option><option value="name">名称</option><option value="nodes">节点数</option></select>
          <button class="btn sm ${W.filters.favorite ? 'active' : ''}" id="wf-fav" title="只看收藏">${icon('star')}</button>
        </div>
      </div>
      <div class="wf-list" id="wf-list">${loadingHtml()}</div>
      <div class="dim tiny" id="wf-count" style="padding:7px 14px;border-top:1px solid var(--line)"></div>
    </div>
    <div class="wf-right" id="wf-detail"><div style="margin:auto;text-align:center" class="dim">${icon('workflow')}<div class="mt-8">从左侧选一个工作流</div></div></div>
  </div>`;
  $('#wf-sort').value = W.filters.sort;
  $('#wf-q').addEventListener('input', debounce((e) => { W.filters.q = e.target.value.trim(); renderWorkflowList(); }, 160));
  $('#wf-folder').addEventListener('change', (e) => { W.filters.folder = e.target.value; renderWorkflowList(); });
  $('#wf-sort').addEventListener('change', (e) => { W.filters.sort = e.target.value; renderWorkflowList(); });
  $('#wf-fav').addEventListener('click', () => { W.filters.favorite = !W.filters.favorite; $('#wf-fav').classList.toggle('active', W.filters.favorite); renderWorkflowList(); });
  const root = $('#wf-root');
  let depth = 0;
  root.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth += 1; root.classList.add('dragging'); } });
  root.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) root.classList.remove('dragging'); });
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; root.classList.remove('dragging');
    importWorkflowFiles(Array.from(e.dataTransfer.files || []));
  });
  await loadWorkflows();
  const want = routeParams().id;
  if (want) selectWorkflow(want);
  else if (W.selected && W.items.find((w) => w.id === W.selected)) selectWorkflow(W.selected);
}

function leaveWorkflows() {
  if (state.workflows.graph) { state.workflows.graph.destroy(); state.workflows.graph = null; }
}

async function loadWorkflows() {
  const W = state.workflows;
  try {
    const data = await api('/api/workflows');
    W.items = data.items || [];
    W.folders = data.folders || [];
    if (state.route !== 'workflows') return;
    $('#wf-folder').innerHTML = `<option value="">全部文件夹</option>${W.folders.map((f) => `<option value="${esc(f)}" ${W.filters.folder === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}`;
    renderWorkflowList();
    const nav = $('#nav-workflows-count');
    if (nav) nav.textContent = W.items.length ? String(W.items.length) : '';
  } catch (err) {
    if (state.route === 'workflows') $('#wf-list').innerHTML = errorHtml(err.message);
  }
}

function filteredWorkflows() {
  const W = state.workflows;
  const f = W.filters;
  const tokens = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  let items = W.items.filter((w) => {
    if (f.favorite && !w.favorite) return false;
    if (f.folder && !(w.folder === f.folder || w.folder.startsWith(`${f.folder}/`))) return false;
    if (tokens.length) {
      const hay = `${w.name} ${w.folder} ${w.node_types.join(' ')} ${w.models.join(' ')} ${w.tags.join(' ')} ${w.note}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  if (f.sort === 'name') items = [...items].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  else if (f.sort === 'nodes') items = [...items].sort((a, b) => b.node_count - a.node_count);
  return items;
}

function renderWorkflowList() {
  const W = state.workflows;
  const items = filteredWorkflows();
  const box = $('#wf-list');
  if (!box) return;
  box.innerHTML = items.length ? items.map((w) => `<div class="wf-item ${w.id === W.selected ? 'active' : ''}" data-action="wf-select" data-id="${esc(w.id)}">
      <div class="n">${w.favorite ? `<span style="color:#f3c94d;display:grid">${icon('star').replace('<svg', '<svg fill="currentColor" width="12" height="12"')}</span>` : ''}<span>${esc(w.name)}</span></div>
      <div class="m"><span>${w.node_count} 节点</span><span>${w.models.length} 模型</span>${w.missing_models ? `<span class="warn-t">缺 ${w.missing_models}</span>` : ''}${w.folder ? `<span>${esc(w.folder)}</span>` : ''}<span>${timeAgo(w.mtime)}</span></div>
      ${w.tags.length ? `<div class="chips">${w.tags.slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${w.error ? `<div class="err-t tiny">${esc(w.error)}</div>` : ''}
    </div>`).join('') : `<div style="padding:30px 14px">${emptyHtml(W.items.length ? '没有符合条件的工作流' : '这里还没有工作流。在 ComfyUI 里保存，或点“导入”。', 'workflow')}</div>`;
  $('#wf-count').textContent = `${items.length} / ${W.items.length} 个工作流`;
}

/* ------------------------------------------------------------------ detail */
async function selectWorkflow(id) {
  const W = state.workflows;
  W.selected = id;
  renderWorkflowList();
  const box = $('#wf-detail');
  if (!box) return;
  const item = W.items.find((w) => w.id === id);
  if (!item) { box.innerHTML = `<div style="margin:auto" class="dim">工作流不存在</div>`; return; }
  if (W.graph) { W.graph.destroy(); W.graph = null; }
  box.innerHTML = `${wfHeadHtml(item)}<div class="graph-box"><canvas id="wf-canvas"></canvas><div class="tools"><button class="btn xs" data-action="wf-fit">${icon('maximize')} 适应</button></div><div class="legend" id="wf-legend">滚轮缩放 · 拖动平移</div></div><div class="wf-body" id="wf-body">${loadingHtml('分析中…')}</div>`;
  try {
    const [detail, check] = await Promise.all([
      api(`/api/workflows/detail?id=${encodeURIComponent(id)}`),
      api(`/api/workflows/check?id=${encodeURIComponent(id)}`).catch(() => null),
    ]);
    if (W.selected !== id || state.route !== 'workflows') return;
    const canvas = $('#wf-canvas');
    if (canvas) {
      if (detail.info.format === 'graph') { W.graph = new GraphView(canvas, detail.data); }
      else { canvas.replaceWith(Object.assign(document.createElement('div'), { className: 'empty', style: 'margin:60px', innerHTML: 'API 格式的工作流没有画布布局，无法预览节点图。' })); }
    }
    $('#wf-body').innerHTML = wfBodyHtml(item, detail.info, check);
  } catch (err) {
    if ($('#wf-body')) $('#wf-body').innerHTML = errorHtml(err.message);
  }
}

function wfHeadHtml(w) {
  return `<div class="wf-head">
    <div style="min-width:0"><h2>${esc(w.name)}</h2><div class="dim small mt-8"><span class="mono">${esc(w.rel)}</span> · ${fmtBytes(w.size)} · 修改于 ${fmtDate(w.mtime)}</div></div>
    <div class="head-actions">
      <button class="btn sm ${w.favorite ? 'active' : ''}" data-action="wf-fav" data-id="${esc(w.id)}">${icon('star')} ${w.favorite ? '已收藏' : '收藏'}</button>
      <a class="btn sm" href="/api/workflows/download?id=${encodeURIComponent(w.id)}" download>${icon('download')} 下载</a>
      <button class="btn sm" data-action="wf-duplicate" data-id="${esc(w.id)}">${icon('copy')} 副本</button>
      <button class="btn sm" data-action="wf-rename" data-id="${esc(w.id)}">${icon('edit')} 重命名</button>
      <button class="btn sm" data-action="wf-move" data-id="${esc(w.id)}">${icon('folder')} 移动</button>
      <button class="btn sm" data-action="wf-reveal" data-id="${esc(w.id)}">${icon('external')} 定位</button>
      <button class="btn sm danger" data-action="wf-delete" data-id="${esc(w.id)}">${icon('trash')}</button>
    </div>
  </div>`;
}

function wfBodyHtml(w, info, check) {
  const modelRows = check?.models || (info.models || []).map((m) => ({ ...m, found: null }));
  const active = modelRows.filter((m) => !m.inactive);
  const missing = active.filter((m) => m.found === false);
  const row = (m) => {
    let status;
    if (m.found === null) status = '<span class="badge gray">未检查</span>';
    else if (m.inactive && !m.found) status = '<span class="badge gray">节点已停用</span>';
    else if (m.found) status = '<span class="badge green">已有</span>';
    else status = '<span class="badge red">缺失</span>';
    const actions = m.found && m.path
      ? `<button class="btn xs" data-action="open-model" data-path="${esc(m.path)}">详情</button>`
      : (m.found === false ? `<button class="btn xs" data-action="wf-find-model" data-name="${esc(m.name)}">${icon('compass')} 搜索</button>` : '');
    return `<div class="list-row"><div class="grow"><div class="t" title="${esc(m.name)}">${esc(m.name.split('/').pop())}</div><div class="s">${esc(m.node)}${m.type ? ` · ${esc(typeLabel(m.type))}` : ''}${m.found && !m.exact ? ' · 子目录不同，ComfyUI 可能找不到' : ''}</div></div>${status}${actions}</div>`;
  };
  const missingNodes = check?.missing_nodes || [];
  const types = Object.entries(info.node_types || {});
  const missingSet = new Set(missingNodes.map((n) => n.type));
  const pkgs = Object.entries(info.packages || {});
  const W = state.workflows;
  const item = W.items.find((x) => x.id === w.id) || w;

  const nodeNotice = check?.nodes_checked === false
    ? `<div class="callout">${icon('info')}<div>ComfyUI 没有运行，无法检测缺失节点。</div>${state.comfy?.state === 'stopped' ? `<button class="btn xs" data-action="comfy-start">启动</button>` : ''}</div>`
    : (missingNodes.length ? `<div class="callout err">${icon('alert')}<div><b>${missingNodes.length} 种节点没有安装</b>：${missingNodes.slice(0, 6).map((n) => esc(n.type)).join('、')}${missingNodes.length > 6 ? ' 等' : ''}</div><a class="btn xs" href="#/nodes">去装插件</a></div>` : `<div class="callout ok">${icon('check')}<div>所有节点都已安装</div></div>`);

  return `<div class="stack">
      <div>
        <div class="section-head"><h3>${icon('layers')} 用到的模型 <span class="dim" style="font-weight:400">${active.length}${missing.length ? ` · <span class="err-t">缺 ${missing.length}</span>` : ''}</span></h3></div>
        ${modelRows.length ? `<div class="list">${modelRows.map(row).join('')}</div>` : '<div class="dim small">没有检测到模型文件引用</div>'}
      </div>
      <div>
        <div class="section-head"><h3>${icon('tag')} 标签与备注</h3></div>
        <div class="stack" style="gap:8px">
          <input class="input" id="wf-tags" placeholder="标签，用逗号分隔，例如：人像, SDXL, 放大" value="${esc((item.tags || []).join(', '))}">
          <textarea class="textarea" id="wf-note" rows="3" placeholder="备注：这个工作流适合做什么、要注意什么…">${esc(item.note || '')}</textarea>
          <div><button class="btn sm" data-action="wf-save-meta" data-id="${esc(w.id)}">${icon('save')} 保存</button></div>
        </div>
      </div>
    </div>
    <div class="stack">
      <div>
        <div class="section-head"><h3>${icon('plug')} 节点 <span class="dim" style="font-weight:400">${info.node_count} 个 · ${types.length} 种 · ${info.link_count} 条连线</span></h3></div>
        ${nodeNotice}
        <div class="chips mt-12">${types.slice(0, 60).map(([t, n]) => `<span class="chip" ${missingSet.has(t) ? 'style="color:var(--err);border-color:var(--err)"' : ''}>${esc(t)}${n > 1 ? ` <span class="dim">×${n}</span>` : ''}</span>`).join('')}</div>
      </div>
      ${pkgs.length ? `<div><div class="section-head"><h3>${icon('package')} 依赖的插件包</h3></div><div class="chips">${pkgs.map(([p, n]) => `<span class="chip">${esc(p)} <span class="dim">×${n}</span></span>`).join('')}</div></div>` : ''}
    </div>`;
}

/* ----------------------------------------------------------------- actions */
async function wfToggleFav(id) {
  const w = state.workflows.items.find((x) => x.id === id);
  if (!w) return;
  w.favorite = !w.favorite;
  await post('/api/workflows/meta', { id, favorite: w.favorite });
  renderWorkflowList();
  const head = $('.wf-head');
  if (head && state.workflows.selected === id) head.outerHTML = wfHeadHtml(w);
}

async function wfSaveMeta(id) {
  const tags = ($('#wf-tags')?.value || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  const note = $('#wf-note')?.value || '';
  await post('/api/workflows/meta', { id, tags, note });
  const w = state.workflows.items.find((x) => x.id === id);
  if (w) { w.tags = tags; w.note = note; }
  renderWorkflowList();
  toast('已保存');
}

async function wfRename(id) {
  const w = state.workflows.items.find((x) => x.id === id);
  const res = await showConfirm({ title: '重命名工作流', confirmText: '保存', body: '', extraHtml: `<div class="field"><label>新名称</label><input class="input" data-confirm-field="name" value="${esc(w.name)}"></div>` });
  if (!res.ok || !res.name.trim() || res.name.trim() === w.name) return;
  const out = await post('/api/workflows/rename', { id, name: res.name.trim() });
  state.workflows.selected = out.id;
  await loadWorkflows();
  selectWorkflow(out.id);
}

async function wfMove(id) {
  const W = state.workflows;
  const w = W.items.find((x) => x.id === id);
  const res = await showConfirm({
    title: '移动到文件夹', confirmText: '移动', body: '输入目标文件夹（相对于 workflows 目录，不存在会自动创建；留空表示根目录）。',
    extraHtml: `<div class="field"><label>文件夹</label><input class="input" list="wf-folder-list" data-confirm-field="folder" value="${esc(w.folder)}" placeholder="例如：人像/写实"><datalist id="wf-folder-list">${W.folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></div>`,
  });
  if (!res.ok) return;
  const out = await post('/api/workflows/move', { id, folder: res.folder.trim() });
  W.selected = out.id;
  await loadWorkflows();
  selectWorkflow(out.id);
  toast('已移动');
}

async function wfDuplicate(id) {
  const out = await post('/api/workflows/duplicate', { id });
  await loadWorkflows();
  selectWorkflow(out.id);
  toast('已创建副本');
}

async function wfDelete(id) {
  const w = state.workflows.items.find((x) => x.id === id);
  const res = await showConfirm({ title: '删除工作流', body: `把 <b>${esc(w.name)}</b> 移到回收站？之后可以在“回收站”里恢复。`, confirmText: '移到回收站', danger: true });
  if (!res.ok) return;
  await post('/api/workflows/delete', { ids: [id] });
  state.workflows.selected = null;
  if (state.workflows.graph) { state.workflows.graph.destroy(); state.workflows.graph = null; }
  $('#wf-detail').innerHTML = `<div style="margin:auto;text-align:center" class="dim">已移到回收站</div>`;
  await loadWorkflows();
}

function wfImportPick() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json'; input.multiple = true;
  input.addEventListener('change', () => importWorkflowFiles(Array.from(input.files || [])));
  input.click();
}

async function importWorkflowFiles(files) {
  files = files.filter((f) => /\.json$/i.test(f.name));
  if (!files.length) { toast('请选择 .json 工作流文件', 'err'); return; }
  const folder = state.workflows.filters.folder || '';
  let ok = 0; let lastId = '';
  for (const file of files) {
    try {
      const content = await file.text();
      const out = await post('/api/workflows/import', { content, name: file.name, folder });
      ok += 1; lastId = out.id;
    } catch (err) { toast(`${file.name}：${err.message}`, 'err', 5000); }
  }
  if (ok) {
    toast(`已导入 ${ok} 个工作流`);
    await loadWorkflows();
    if (lastId) selectWorkflow(lastId);
  }
}

function wfFindModel(name) {
  const base = name.split('/').pop().replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, '');
  state.civitai.filters.query = base;
  location.hash = '#/civitai';
}

/* --------------------------------------------------------------- graph view */
class GraphView {
  constructor(canvas, data) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.nodes = (data.nodes || []).filter((n) => n && Array.isArray(n.pos));
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = (data.links || []).map((l) => (Array.isArray(l)
      ? { id: l[0], from: l[1], fslot: l[2], to: l[3], tslot: l[4], type: l[5] }
      : { id: l.id, from: l.origin_id, fslot: l.origin_slot, to: l.target_id, tslot: l.target_slot, type: l.type }));
    this.groups = data.groups || [];
    this.scale = 1; this.ox = 0; this.oy = 0;
    this._raf = 0;
    this._bind();
    this._resize();
    this.fit();
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this.canvas.removeEventListener('wheel', this._wheel);
    window.removeEventListener('mouseup', this._up);
    window.removeEventListener('mousemove', this._move);
  }

  _size(n) {
    const s = n.size || [140, 60];
    const w = Array.isArray(s) ? s[0] : (s['0'] ?? 140);
    const h = Array.isArray(s) ? s[1] : (s['1'] ?? 60);
    return n.flags?.collapsed ? [Math.min(w, 140), 0] : [w, h];
  }

  fit() {
    if (!this.nodes.length) return;
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    this.nodes.forEach((n) => {
      const [w, h] = this._size(n);
      x1 = Math.min(x1, n.pos[0]); y1 = Math.min(y1, n.pos[1] - 30);
      x2 = Math.max(x2, n.pos[0] + w); y2 = Math.max(y2, n.pos[1] + h);
    });
    const cw = this.canvas.clientWidth; const ch = this.canvas.clientHeight;
    const bw = Math.max(1, x2 - x1); const bh = Math.max(1, y2 - y1);
    this.scale = Math.min(cw / bw, ch / bh, 1.4) * 0.94;
    this.ox = (cw - bw * this.scale) / 2 - x1 * this.scale;
    this.oy = (ch - bh * this.scale) / 2 - y1 * this.scale;
    this.draw();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.dpr = dpr;
    this.draw();
  }

  _bind() {
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.canvas);
    this._wheel = (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
      const k = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(3, Math.max(0.04, this.scale * k));
      this.ox = mx - (mx - this.ox) * (next / this.scale);
      this.oy = my - (my - this.oy) * (next / this.scale);
      this.scale = next;
      this.draw();
    };
    this.canvas.addEventListener('wheel', this._wheel, { passive: false });
    let drag = null;
    this.canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy }; this.canvas.classList.add('drag'); });
    this._move = (e) => { if (!drag) return; this.ox = drag.ox + e.clientX - drag.x; this.oy = drag.oy + e.clientY - drag.y; this.draw(); };
    this._up = () => { drag = null; this.canvas.classList.remove('drag'); };
    window.addEventListener('mousemove', this._move);
    window.addEventListener('mouseup', this._up);
    this.canvas.addEventListener('dblclick', () => this.fit());
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._paint(); });
  }

  _paint() {
    const { ctx, canvas } = this;
    const cs = getComputedStyle(document.documentElement);
    const css = (name) => cs.getPropertyValue(name).trim();
    const dpr = this.dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = css('--surface-2');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.ox, dpr * this.oy);
    const s = this.scale;

    this.groups.forEach((g) => {
      const b = g.bounding; if (!b) return;
      ctx.fillStyle = `${g.color || '#3f789e'}22`;
      ctx.strokeStyle = `${g.color || '#3f789e'}88`;
      ctx.lineWidth = 1 / s;
      ctx.fillRect(b[0], b[1], b[2], b[3]);
      ctx.strokeRect(b[0], b[1], b[2], b[3]);
      if (s > 0.2) { ctx.fillStyle = css('--muted'); ctx.font = `${Math.max(12, 16)}px sans-serif`; ctx.fillText(g.title || '', b[0] + 8, b[1] + 20); }
    });

    const colors = { IMAGE: '#64b5f6', LATENT: '#ff9cf9', MODEL: '#b39ddb', CLIP: '#ffd500', CONDITIONING: '#ffa931', VAE: '#ff6e6e', MASK: '#81c784', CONTROL_NET: '#6ee7b7' };
    ctx.lineWidth = Math.max(1, 1.6 / Math.max(s, 0.5));
    this.links.forEach((l) => {
      const a = this.byId.get(l.from); const b = this.byId.get(l.to);
      if (!a || !b) return;
      const [aw] = this._size(a);
      const ax = a.pos[0] + aw; const ay = a.pos[1] + (l.fslot + 0.7) * 20;
      const bx = b.pos[0]; const by = b.pos[1] + (l.tslot + 0.7) * 20;
      const dist = Math.max(30, Math.abs(bx - ax) * 0.5);
      ctx.strokeStyle = colors[l.type] || '#8a9';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.bezierCurveTo(ax + dist, ay, bx - dist, by, bx, by);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    this.nodes.forEach((n) => {
      const [w, h] = this._size(n);
      const x = n.pos[0]; const y = n.pos[1];
      const muted = n.mode === 2 || n.mode === 4;
      ctx.globalAlpha = muted ? 0.4 : 1;
      const body = n.bgcolor || '#353535';
      const title = n.color || '#222222';
      const r = 6;
      ctx.fillStyle = body;
      this._round(x, y - 30, w, h + 30, r); ctx.fill();
      ctx.fillStyle = title;
      this._round(x, y - 30, w, 30, r, true); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1 / s;
      this._round(x, y - 30, w, h + 30, r); ctx.stroke();
      if (s > 0.1) {
        const fs = s < 0.7 ? Math.min(40, Math.max(14, 10 / s)) : 14;
        ctx.fillStyle = '#d6d6d6';
        ctx.font = `${fs}px sans-serif`;
        const raw = n.title || n.type || '';
        const label = (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw) ? '子图' : raw).slice(0, Math.max(3, Math.floor(w / (fs * 0.55))));
        ctx.fillText(label, x + 10, y - 30 + (30 + fs * 0.7) / 2 - 2);
        if (s > 0.55 && !n.flags?.collapsed) {
          ctx.font = '12px sans-serif';
          ctx.fillStyle = '#9a9a9a';
          (n.inputs || []).forEach((slot, i) => { ctx.fillText((slot.label || slot.name || '').slice(0, 14), x + 12, y + (i + 0.7) * 20 + 4); });
          ctx.textAlign = 'right';
          (n.outputs || []).forEach((slot, i) => { ctx.fillText((slot.label || slot.name || '').slice(0, 14), x + w - 12, y + (i + 0.7) * 20 + 4); });
          ctx.textAlign = 'left';
        }
      }
      ctx.globalAlpha = 1;
    });
  }

  _round(x, y, w, h, r, topOnly = false) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    if (topOnly) { ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); } else { ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); }
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
