/* ComfyDeck — command palette (Ctrl+K) */
'use strict';

const PALETTE = { open: false, items: [], index: 0, extra: null };

function paletteCommands() {
  const st = state.comfy?.state;
  const pages = [
    ['overview', '总览', 'grid'], ['launch', '启动台', 'terminal'], ['gallery', '图库', 'image'], ['workflows', '工作流', 'workflow'],
    ['models', '模型库', 'layers'], ['civitai', 'CivitAI 浏览', 'compass'], ['downloads', '下载', 'download'],
    ['nodes', '插件', 'plug'], ['core', '核心版本', 'cpu'], ['trash', '回收站', 'trash'], ['settings', '设置', 'settings'],
  ].map(([r, label, ic]) => ({ title: `前往 ${label}`, group: '页面', icon: ic, run: () => { location.hash = `#/${r}`; } }));
  const actions = [];
  if (st === 'stopped') actions.push({ title: '启动 ComfyUI', group: '命令', icon: 'play', run: () => startComfy().catch((e) => toast(e.message, 'err')) });
  if (st === 'running') {
    actions.push({ title: '打开 ComfyUI', group: '命令', icon: 'external', run: () => openComfy() });
    actions.push({ title: '重启 ComfyUI', group: '命令', icon: 'refresh', run: () => comfyRestart().catch((e) => toast(e.message, 'err')) });
    actions.push({ title: '停止 ComfyUI', group: '命令', icon: 'stop', run: () => comfyStop().catch((e) => toast(e.message, 'err')) });
    actions.push({ title: '释放显存', group: '命令', icon: 'broom', run: () => comfyOp('free').catch((e) => toast(e.message, 'err')) });
  }
  actions.push(
    { title: '检查 ComfyUI 核心更新', group: '命令', icon: 'arrowUp', run: () => runCoreCheck().catch((e) => toast(e.message, 'err')) },
    { title: '检查插件更新', group: '命令', icon: 'plug', run: () => startNodesCheck().catch((e) => toast(e.message, 'err')) },
    { title: '检查模型新版本', group: '命令', icon: 'download', run: () => startCheckUpdates().catch((e) => toast(e.message, 'err')) },
    { title: '重新扫描图库', group: '命令', icon: 'image', run: () => post('/api/gallery/scan').then(() => toast('开始重新扫描图库')) },
    { title: '导入工作流…', group: '命令', icon: 'upload', run: () => { location.hash = '#/workflows'; setTimeout(wfImportPick, 300); } },
    { title: '切换深色 / 浅色主题', group: '命令', icon: 'sun', run: toggleTheme },
    { title: '打开 output 文件夹', group: '命令', icon: 'folder', run: () => post('/api/open-folder', { kind: 'output' }) },
    { title: '打开 models 文件夹', group: '命令', icon: 'folder', run: () => post('/api/open-folder', { kind: 'models' }) },
  );
  return [...actions, ...pages];
}

async function paletteExtras() {
  const extra = [];
  try {
    const [wf, md] = await Promise.all([
      state.workflows.items.length ? Promise.resolve({ items: state.workflows.items }) : api('/api/workflows'),
      state.models.items.length ? Promise.resolve({ items: state.models.items }) : api('/api/models?limit=3000'),
    ]);
    (wf.items || []).forEach((w) => extra.push({ title: w.name, group: '工作流', icon: 'workflow', run: () => { location.hash = `#/workflows?id=${encodeURIComponent(w.id)}`; if (state.route === 'workflows') selectWorkflow(w.id); } }));
    (md.items || []).forEach((m) => extra.push({ title: m.name, group: typeLabel(m.type), icon: 'layers', run: () => { if (state.route !== 'models') location.hash = '#/models'; setTimeout(() => openModelDetail(m.path), state.route === 'models' ? 0 : 350); } }));
  } catch (e) { /* offline */ }
  return extra;
}

function fuzzy(text, query) {
  const t = text.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((tok) => t.includes(tok));
}

function openPalette() {
  if (PALETTE.open) return;
  PALETTE.open = true;
  PALETTE.index = 0;
  const wrap = document.createElement('div');
  wrap.className = 'palette-wrap';
  wrap.innerHTML = `<div class="palette"><input id="pal-input" placeholder="输入命令、页面、工作流或模型名…" autocomplete="off"><div class="items" id="pal-items"></div></div>`;
  document.body.appendChild(wrap);
  PALETTE.wrap = wrap;
  const input = $('#pal-input', wrap);
  input.focus();
  const base = paletteCommands();
  PALETTE.items = base;
  PALETTE.extra = null;
  const render = () => {
    const q = input.value.trim();
    let list = base.filter((c) => !q || fuzzy(c.title, q));
    if (q && PALETTE.extra) list = list.concat(PALETTE.extra.filter((c) => fuzzy(c.title, q)).slice(0, 12));
    PALETTE.items = list.slice(0, 40);
    PALETTE.index = Math.min(PALETTE.index, Math.max(0, PALETTE.items.length - 1));
    $('#pal-items', wrap).innerHTML = PALETTE.items.length
      ? PALETTE.items.map((c, i) => `<div class="it ${i === PALETTE.index ? 'sel' : ''}" data-i="${i}">${icon(c.icon)}<span class="tt">${esc(c.title)}</span><span class="grp">${esc(c.group)}</span></div>`).join('')
      : `<div class="dim small" style="padding:14px">没有匹配项</div>`;
    const sel = $('.it.sel', wrap); if (sel) sel.scrollIntoView({ block: 'nearest' });
  };
  render();
  paletteExtras().then((extra) => { PALETTE.extra = extra; if (PALETTE.open) render(); });
  input.addEventListener('input', () => { PALETTE.index = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); PALETTE.index = Math.min(PALETTE.items.length - 1, PALETTE.index + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); PALETTE.index = Math.max(0, PALETTE.index - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(PALETTE.index); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closePalette(); });
  $('#pal-items', wrap).addEventListener('click', (e) => {
    const it = e.target.closest('.it');
    if (it) runPalette(Number(it.dataset.i));
  });
}

function runPalette(i) {
  const cmd = PALETTE.items[i];
  closePalette();
  if (cmd) Promise.resolve(cmd.run()).catch((err) => toast(err.message, 'err'));
}

function closePalette() {
  if (!PALETTE.open) return;
  PALETTE.open = false;
  PALETTE.wrap?.remove();
}
