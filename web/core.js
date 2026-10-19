/* ComfyDeck — shared helpers, router, overlays, jobs and ComfyUI status */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  route: 'overview',
  settings: null,
  settingsData: null,
  nsfw: false,
  paths: {},
  overview: null,
  core: null,
  comfy: null,
  activeJobs: [],
  watching: new Set(),
  timers: {},
  drawerPath: null,
  modelDetail: null,
  civitaiDetail: null,
  lightbox: null,
  models: {
    items: [], total: 0, summary: { count: 0, size: 0, types: [] }, loading: false, loaded: false, req: 0,
    filters: { q: '', type: '', sort: 'name', matched: '', favorite: false, usage: '' },
    view: 'grid',
  },
  nodes: { items: [], summary: {}, checked_at: null, loading: false, runInstall: false },
  civitai: {
    items: [], nextCursor: null, loading: false, req: 0,
    filters: { query: '', types: '', sort: 'Most Downloaded', period: 'AllTime', baseModels: '', username: '', hideInstalled: false },
  },
  gallery: { items: [], total: 0, offset: 0, loading: false, req: 0, selected: new Set(), facets: null, view: localStorage.getItem('cd-gal-view') || 'grid', cell: Number(localStorage.getItem('cd-gal-cell')) || 190, filters: { q: '', kind: '', root: 'output', folder: '', model: '', sort: 'new', favorite: false, workflow: false } },
  workflows: { items: [], folders: [], selected: null, filters: { q: '', folder: '', favorite: false, sort: 'new' } },
};

const ROUTES = {};

const TYPE_LABELS = {
  checkpoints: 'Checkpoint', checkpoint: 'Checkpoint', loras: 'LoRA', lora: 'LoRA',
  vae: 'VAE', vae_approx: 'VAE', controlnet: 'ControlNet', embeddings: 'Embedding',
  hypernetworks: 'Hypernetwork', upscale_models: 'Upscaler', clip_vision: 'CLIP Vision',
  text_encoders: 'Text Encoder', clip: 'Text Encoder', diffusion_models: 'Diffusion',
  unet: 'UNet', style_models: 'Style', photomaker: 'PhotoMaker', gligen: 'GLIGEN',
  model_patches: 'Patch', split_files: 'Model', audio_encoders: 'Audio', detection: 'Detection',
  frame_interpolation: 'Interpolation', geometry_estimation: 'Geometry', optical_flow: 'Optical Flow',
  latent_upscale_models: 'Latent Upscaler', background_removal: 'Background', diffusers: 'Diffusers',
};

const CIVITAI_TYPE_TO_DIR = {
  Checkpoint: 'checkpoints', LORA: 'loras', LoCon: 'loras', DoRA: 'loras', Motion: 'loras',
  VAE: 'vae', Controlnet: 'controlnet', TextualInversion: 'embeddings',
  Upscaler: 'upscale_models', CLIPVision: 'clip_vision', TextEncoder: 'text_encoders',
  UNet: 'diffusion_models', DiffusionModel: 'diffusion_models', Hypernetwork: 'hypernetworks',
  AestheticGradient: 'embeddings', Poses: 'controlnet', Other: 'checkpoints',
};

const DOWNLOAD_DIRS = [
  ['checkpoints', 'Checkpoint / 主模型'], ['loras', 'LoRA / LyCORIS'], ['vae', 'VAE'],
  ['text_encoders', 'Text Encoder'], ['diffusion_models', 'Diffusion Model / UNet'],
  ['controlnet', 'ControlNet'], ['embeddings', 'Embedding'], ['upscale_models', 'Upscaler'],
  ['clip_vision', 'CLIP Vision'], ['hypernetworks', 'Hypernetwork'],
];

/* ------------------------------------------------------------------ format */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtBytes(num) {
  num = Number(num) || 0;
  if (num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (num >= 1024 && i < units.length - 1) { num /= 1024; i += 1; }
  return `${num >= 100 || i === 0 ? Math.round(num) : num.toFixed(num >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtNum(num) {
  const n = Number(num) || 0;
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万`;
  return n.toLocaleString('zh-CN');
}

function toDate(ts) {
  if (!ts) return null;
  let date;
  if (typeof ts === 'number') date = new Date(ts * 1000);
  else if (typeof ts === 'string' && /^\d+(\.\d+)?$/.test(ts)) date = new Date(Number(ts) * 1000);
  else date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmtDate(ts) {
  const date = toDate(ts);
  if (!date) return '—';
  return date.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(ts) {
  const date = toDate(ts);
  if (!date) return '—';
  const sec = (Date.now() - date.getTime()) / 1000;
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)} 天前`;
  return fmtDate(ts).slice(0, 10);
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  const h = Math.floor(sec / 3600);
  return `${h} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

function fmtKB(kb) { return fmtBytes((Number(kb) || 0) * 1024); }
function typeLabel(type) { return TYPE_LABELS[String(type || '').toLowerCase()] || String(type || 'Model'); }
function shorten(text, n = 30) { const s = String(text || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function statusBadge(status) {
  const map = {
    running: ['blue', '运行中'], queued: ['gray', '排队中'], done: ['green', '已完成'],
    error: ['red', '失败'], cancelled: ['amber', '已取消'],
  };
  const [cls, label] = map[status] || ['gray', status || '未知'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function debounce(fn, wait = 260) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

/* --------------------------------------------------------------------- api */
async function api(path, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(options.headers || {}) };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const resp = await fetch(path, opts);
  const type = resp.headers.get('content-type') || '';
  let data = null;
  if (type.includes('application/json')) data = await resp.json().catch(() => null);
  else data = await resp.text().catch(() => '');
  if (!resp.ok) {
    const msg = (data && data.detail) || (typeof data === 'string' ? data : '') || `HTTP ${resp.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });

/* ------------------------------------------------------------------ toast */
function toast(message, kind = 'ok', ms = 3200) {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="dot"></span><span>${esc(message)}</span>`;
  root.appendChild(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, ms);
}

async function copyText(text, quiet = false) {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    if (!quiet) toast('已复制到剪贴板');
  } catch (err) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); if (!quiet) toast('已复制到剪贴板'); } catch (e) { toast('复制失败', 'err'); }
    ta.remove();
  }
}
function copyEl(id) {
  const el = document.getElementById(id);
  if (el) copyText(el.textContent || el.value || '');
}

/* ------------------------------------------------------------------ theme */
function resolvedTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(pref) {
  localStorage.setItem('cd-theme', pref);
  const t = resolvedTheme(pref);
  document.documentElement.dataset.theme = t;
  const btn = $('#btn-theme');
  if (btn) btn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

/* ------------------------------------------------------------- media thumb */
function mediaThumb(src, opts = {}) {
  const nsfw = !!opts.nsfw;
  const img = src
    ? `<img src="${esc(src)}" loading="lazy" decoding="async" alt="" class="${nsfw ? 'blur-media' : ''}" onerror="this.remove()">`
    : '';
  const guard = nsfw ? `<div class="media-guard"><button class="btn sm" data-action="show-media">${icon('eye')} 显示</button></div>` : '';
  return `<div class="thumb ${opts.cls || ''}" data-media-wrap><div class="ph">${opts.label ? esc(opts.label) : icon('image')}</div>${img}${guard}${opts.extra || ''}</div>`;
}

/* ------------------------------------------------------------------ modal */
function modalHead(title, sub = '') {
  return `<div class="modal-head"><div><h3>${esc(title)}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div><button class="modal-close" data-action="close-modal" title="关闭">${icon('x')}</button></div>`;
}

function showModal(html, opts = {}) {
  closeModal(true);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const cls = opts.wide ? 'wide' : (opts.medium ? 'medium' : '');
  overlay.innerHTML = `<div class="modal ${cls}">${html}</div>`;
  document.body.appendChild(overlay);
  state.modal = { overlay, onClose: opts.onClose || null };
  requestAnimationFrame(() => { overlay.classList.add('show'); overlay.firstElementChild.classList.add('show'); });
  overlay.addEventListener('mousedown', (event) => { overlay._down = event.target === overlay; });
  overlay.addEventListener('click', (event) => { if (event.target === overlay && overlay._down) closeModal(); });
  return overlay;
}

function closeModal(silent = false) {
  const modal = state.modal;
  if (!modal) return;
  if (state.timers.jobModal) { clearInterval(state.timers.jobModal); delete state.timers.jobModal; }
  state.modal = null;
  if (modal.onClose) { try { modal.onClose(); } catch (e) { /* noop */ } }
  modal.overlay.classList.remove('show');
  setTimeout(() => modal.overlay.remove(), 160);
}

function showConfirm(opts) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const data = {};
      const overlay = state.modal && state.modal.overlay;
      if (overlay) {
        overlay.querySelectorAll('[data-confirm-field]').forEach((input) => {
          data[input.dataset.confirmField] = input.type === 'checkbox' ? input.checked : input.value;
        });
      }
      closeModal();
      resolve(ok ? { ok: true, ...data } : { ok: false });
    };
    const body = `<div style="line-height:1.7;color:var(--muted)">${opts.body || esc(opts.message || '')}</div>${opts.extraHtml ? `<div class="mt-16">${opts.extraHtml}</div>` : ''}`;
    const foot = `<div class="modal-foot"><button class="btn" data-confirm-cancel>取消</button><button class="btn ${opts.danger ? 'solid-danger' : 'primary'}" data-confirm-ok>${esc(opts.confirmText || '确认')}</button></div>`;
    const overlay = showModal(modalHead(opts.title || '确认操作') + `<div class="modal-body">${body}</div>` + foot, {
      wide: !!opts.wide, medium: !!opts.medium, onClose: () => finish(false),
    });
    overlay.querySelector('[data-confirm-ok]').addEventListener('click', (e) => { e.preventDefault(); finish(true); });
    overlay.querySelector('[data-confirm-cancel]').addEventListener('click', (e) => { e.preventDefault(); finish(false); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); finish(true); }
    });
    const first = overlay.querySelector('input[type="text"], input:not([type]), textarea');
    if (first) setTimeout(() => { first.focus(); first.select?.(); }, 60);
    if (opts.onOpen) opts.onOpen(overlay);
  });
}

/* ----------------------------------------------------------------- drawer */
function openDrawer(title, bodyHtml, footHtml = '') {
  closeDrawer(true);
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.innerHTML = `<div class="drawer-head"><div><h3>${esc(title)}</h3></div><button class="modal-close" data-action="close-drawer" title="关闭">${icon('x')}</button></div><div class="drawer-body">${bodyHtml}</div>${footHtml ? `<div class="drawer-foot">${footHtml}</div>` : ''}`;
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
  state.drawer = { overlay, drawer };
  requestAnimationFrame(() => { overlay.classList.add('show'); drawer.classList.add('show'); });
  overlay.addEventListener('click', () => closeDrawer());
  return drawer;
}

function closeDrawer() {
  const d = state.drawer;
  if (!d) return;
  state.drawer = null;
  state.drawerPath = null;
  d.drawer.classList.remove('show');
  d.overlay.classList.remove('show');
  setTimeout(() => { d.drawer.remove(); d.overlay.remove(); }, 240);
}

/* ------------------------------------------------- CivitAI image lightbox */
function openLightbox(image, title = '') {
  if (!image) return;
  state.lightbox = image;
  const meta = image.meta || {};
  const nsfw = Number(image.nsfwLevel) > 1 && !state.nsfw;
  const size = image.width && image.height ? `${image.width} × ${image.height}` : '';
  const prompt = meta.prompt || '';
  const negative = meta.negativePrompt || '';
  const params = [
    ['采样器', meta.sampler], ['步数', meta.steps], ['CFG', meta.cfgScale],
    ['种子', meta.seed], ['尺寸', meta.Size || size], ['模型', meta.Model],
    ['Clip Skip', meta.clipSkip], ['版本', meta.Version],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  const resources = Array.isArray(meta.resources) ? meta.resources : [];
  const box = (label, id, text) => `<div><div class="pbox-head"><span class="mini-label">${label}</span><button class="btn xs ghost" data-action="copy-el" data-id="${id}">${icon('copy')} 复制</button></div><div class="prompt-box" id="${id}">${esc(text)}</div></div>`;
  const metaHtml = (prompt || negative || params.length || resources.length)
    ? `${prompt ? box('正向提示词', 'lb-prompt', prompt) : ''}
       ${negative ? box('反向提示词', 'lb-negative', negative) : ''}
       ${params.length ? `<div><div class="mini-label">生成参数</div><div class="kv">${params.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v mono">${esc(v)}</div>`).join('')}</div></div>` : ''}
       ${resources.length ? `<div><div class="mini-label">使用资源</div><div class="chips">${resources.map((r) => `<span class="chip">${esc(r.type || '')} · ${esc(r.name || '')}${r.weight != null ? ` · ${r.weight}` : ''}</span>`).join('')}</div></div>` : ''}
       <div><button class="btn sm" data-action="copy-prompt-all">${icon('copy')} 复制提示词 + 参数</button></div>`
    : `<div class="empty" style="padding:22px">这张图片没有公开生成参数</div>`;
  const src = image.full || image.url;
  const media = image.isVideo
    ? `<video id="lb-image" src="${esc(src)}" controls autoplay loop muted playsinline class="${nsfw ? 'blur-media' : ''}"></video>`
    : `<img id="lb-image" src="${esc(src)}" alt="" class="${nsfw ? 'blur-media' : ''}">`;

  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.innerHTML = `
    <div class="lb-img pos-rel" data-media-wrap>
      ${media}
      ${nsfw ? `<div class="media-guard"><button class="btn" data-action="show-media">${icon('eye')} 显示图片</button></div>` : ''}
    </div>
    <div class="lb-side">
      <button class="icon-btn lb-close" data-action="close-lightbox">${icon('x')}</button>
      <div class="mini-label">参考图</div>
      <h3 style="font-size:14px;margin:2px 0 8px;padding-right:30px">${esc(title || 'CivitAI 参考图')}</h3>
      <div class="stat-inline mb-16">${image.username ? `<span>by <b>${esc(image.username)}</b></span>` : ''}${size ? `<span>${esc(size)}</span>` : ''}${image.nsfwLevel ? `<span class="badge ${Number(image.nsfwLevel) > 1 ? 'amber' : 'green'}">${Number(image.nsfwLevel) > 1 ? 'NSFW' : 'SFW'}</span>` : ''}</div>
      <div class="stack">${metaHtml}</div>
      <div class="divider"></div>
      <div class="row wrap">
        <button class="btn sm" data-action="open-civitai-image" data-id="${esc(image.id || '')}">${icon('external')} 在 CivitAI 查看</button>
        ${image.url ? `<a class="btn sm" href="${esc(image.url)}" target="_blank" rel="noopener">${icon('image')} 原图</a>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  state.lightboxOverlay = overlay;
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeLightbox(); });
}

function closeLightbox() {
  if (state.lightboxOverlay) { state.lightboxOverlay.remove(); state.lightboxOverlay = null; }
  state.lightbox = null;
}

/* ------------------------------------------------------------------- jobs */
async function pollJobs() {
  try {
    const data = await api('/api/jobs?active=1');
    state.activeJobs = data.items || [];
    renderJobDock();
    const dl = state.activeJobs.filter((j) => j.kind === 'download').length;
    const nav = $('#nav-downloads');
    if (nav) nav.textContent = dl ? String(dl) : '';
    const pip = $('#jobs-pip');
    if (pip) pip.textContent = state.activeJobs.length ? String(state.activeJobs.length) : '';
  } catch (e) { /* server offline */ }
}

function renderJobDock() {
  const dock = $('#job-dock');
  if (!dock) return;
  const jobs = state.activeJobs || [];
  if (!jobs.length) { dock.hidden = true; dock.innerHTML = ''; return; }
  dock.hidden = false;
  dock.innerHTML = jobs.slice(0, 3).map((job) => `
    <div class="job-card" data-action="job-open" data-id="${esc(job.id)}">
      <div class="job-top"><span class="spinner sm"></span><span class="title">${esc(job.title)}</span><span class="pct">${Math.round(job.progress)}%</span></div>
      <div class="bar"><span style="width:${Math.max(2, job.progress)}%"></span></div>
      <div class="job-msg">${esc(job.message || '')}</div>
    </div>`).join('');
}

function watchJob(id, onDone) {
  if (!id || state.watching.has(id)) return;
  state.watching.add(id);
  const tick = async () => {
    try {
      const job = await api(`/api/jobs/${id}`);
      pollJobs();
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        state.watching.delete(id);
        if (job.status === 'done') { toast(`${job.title} · 已完成`); if (onDone) onDone(job); }
        else if (job.status === 'error') { toast(job.error || `${job.title} 失败`, 'err', 5200); if (onDone) onDone(job); }
        else toast(`${job.title} 已取消`, 'err');
        return;
      }
      setTimeout(tick, 900);
    } catch (e) { state.watching.delete(id); }
  };
  setTimeout(tick, 450);
}

async function startJobRequest(path, body, opts = {}) {
  const res = await post(path, body || {});
  toast(opts.message || '任务已开始');
  pollJobs();
  if (res.id) watchJob(res.id, opts.onDone);
  return res;
}

async function openJobCenter() {
  const [active, all] = await Promise.all([api('/api/jobs?active=1'), api('/api/jobs')]);
  const rows = (items) => items.length ? `<div class="list">${items.map((job) => `
    <div class="list-row click" data-action="job-open" data-id="${esc(job.id)}">
      <div class="grow"><div class="row"><span class="t">${esc(job.title)}</span>${statusBadge(job.status)}</div>
      <div class="s">${esc(job.message || '')} · ${timeAgo(job.finished || job.started || job.created)}</div></div>
      <span class="mono dim">${Math.round(job.progress)}%</span>
    </div>`).join('')}</div>` : `<div class="empty" style="padding:20px">暂无任务</div>`;
  showModal(modalHead('任务中心', '所有后台操作都记录在这里') + `<div class="modal-body">
      <div class="mini-label">进行中</div>${rows(active.items || [])}
      <div class="mini-label mt-16">最近</div>${rows((all.items || []).filter((j) => !['running', 'queued'].includes(j.status)).slice(0, 12))}
    </div>`, { medium: true });
}

async function openJobModal(id) {
  const overlay = showModal(modalHead('任务详情') + `<div class="modal-body" id="job-modal-content"><div class="loading-page" style="padding:28px"><div class="spinner"></div></div></div>`, { wide: true });
  const refresh = async () => {
    try {
      const job = await api(`/api/jobs/${id}`);
      const el = $('#job-modal-content', overlay);
      if (!el) { clearInterval(state.timers.jobModal); return; }
      const pre = $('pre', el);
      const stick = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 12;
      el.innerHTML = jobDetailHtml(job);
      const next = $('pre', el);
      if (next && stick) next.scrollTop = next.scrollHeight;
      if (['done', 'error', 'cancelled'].includes(job.status)) { clearInterval(state.timers.jobModal); delete state.timers.jobModal; }
    } catch (e) { clearInterval(state.timers.jobModal); delete state.timers.jobModal; }
  };
  await refresh();
  state.timers.jobModal = setInterval(refresh, 1000);
}

function jobDetailHtml(job) {
  const cancel = ['running', 'queued'].includes(job.status)
    ? `<button class="btn sm danger" data-action="job-cancel" data-id="${esc(job.id)}">取消任务</button>` : '';
  return `<div class="row between mb-12"><div class="row">${statusBadge(job.status)}<span class="mono dim">${job.id}</span></div>${cancel}</div>
    <h3 style="font-size:15px;margin-bottom:3px">${esc(job.title)}</h3>
    <div class="muted small">${esc(job.message || '')}</div>
    <div class="bar mt-12"><span style="width:${Math.max(2, job.progress)}%"></span></div>
    <div class="row between mt-8 tiny dim"><span>开始 ${fmtDate(job.started || job.created)}</span><span>${Math.round(job.progress)}%</span></div>
    ${job.error ? `<div class="callout err mt-16">${icon('alert')}<div>${esc(job.error)}</div></div>` : ''}
    <div class="mini-label mt-16">运行日志</div>
    <pre class="prompt-box" style="max-height:340px">${esc(job.log || '暂无日志')}</pre>`;
}

/* ---------------------------------------------------------- ComfyUI status */
function fmtState(st) {
  if (!st) return '检测中…';
  if (st.state === 'running') return '运行中';
  if (st.state === 'starting') return '启动中';
  return '已停止';
}

function renderSideStatus() {
  const box = $('#side-status');
  if (!box) return;
  const st = state.comfy;
  if (!st) { box.innerHTML = `<div class="top"><span class="dot"></span><span>检测中…</span></div>`; return; }
  const dev = (st.devices || [])[0];
  const dotCls = st.state === 'running' ? 'ok' : st.state === 'starting' ? 'warn' : (st.last_exit?.crashed ? 'err' : '');
  let sub = '';
  if (st.state === 'running') sub = st.managed ? `${esc(st.profile_name || '')} · ${fmtDuration(st.uptime)}` : `外部启动 · 端口 ${st.port}`;
  else if (st.state === 'starting') sub = '正在加载节点与模型…';
  else if (st.last_exit?.crashed) sub = `上次异常退出 (${st.last_exit.code})`;
  else sub = `端口 ${st.port}`;
  let meter = '';
  if (dev && dev.vram_total) {
    const used = dev.vram_total - dev.vram_free;
    const pct = Math.round(used / dev.vram_total * 100);
    meter = `<div class="meter"><div class="row"><span>显存</span><span>${fmtBytes(used)} / ${fmtBytes(dev.vram_total)}</span></div><div class="bar ${pct > 90 ? 'warn' : ''}"><span style="width:${pct}%"></span></div></div>`;
  }
  const btn = st.state === 'stopped'
    ? `<button class="btn primary" data-action="comfy-start">${icon('play')} 启动 ComfyUI</button>`
    : st.state === 'starting'
      ? `<a class="btn" href="#/launch">${icon('terminal')} 查看启动日志</a>`
      : `<button class="btn" data-action="core-open">${icon('external')} 打开 ComfyUI</button>`;
  box.innerHTML = `<div class="top"><span class="dot ${dotCls}"></span><span>ComfyUI ${fmtState(st)}</span></div><div class="sub">${sub}</div>${meter}${btn}`;
}

function setComfyStatus(st) {
  if (!st) return;
  const prev = state.comfy?.state;
  state.comfy = st;
  renderSideStatus();
  if (prev && prev !== st.state) window.dispatchEvent(new CustomEvent('comfy-state', { detail: st }));
}

async function pollComfy() {
  try { setComfyStatus(await api('/api/comfy/status')); } catch (e) { /* noop */ }
}

async function openComfy() {
  if (state.comfy && state.comfy.running) {
    await post('/api/core/open');
  } else {
    toast('ComfyUI 当前未运行', 'err');
  }
}

async function startComfy(profileId) {
  setComfyStatus(await post('/api/launcher/start', profileId ? { profile_id: profileId } : {}));
  toast('正在启动 ComfyUI…');
}

/* ------------------------------------------------------------------- nav */
function updateNav(data) {
  if (!data) return;
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text || ''; };
  set('#nav-models-count', data.models?.count ? String(data.models.count) : '');
  set('#nav-nodes-updates', data.nodes?.updates ? `${data.nodes.updates}↑` : '');
  set('#nav-core-update', data.core?.update_available ? '新版' : '');
  set('#nav-gallery-count', data.gallery?.total?.n ? String(data.gallery.total.n) : '');
  set('#nav-workflows-count', data.workflows?.total ? String(data.workflows.total) : '');
  set('#nav-trash', data.trash?.count ? String(data.trash.count) : '');
}

/* ----------------------------------------------------------------- router */
function currentRouteName() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview';
  return ROUTES[raw] ? raw : 'overview';
}

function clearPageTimers() {
  Object.keys(state.timers).forEach((key) => {
    if (key === 'jobModal') return;
    clearInterval(state.timers[key]);
    clearTimeout(state.timers[key]);
    delete state.timers[key];
  });
}

function route() {
  const prev = ROUTES[state.route];
  if (prev && prev.leave) { try { prev.leave(); } catch (e) { /* noop */ } }
  const name = currentRouteName();
  state.route = name;
  closeModal(true);
  closeDrawer();
  closeLightbox();
  clearPageTimers();
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  const meta = ROUTES[name];
  $('#crumb').innerHTML = `${esc(meta.title)}`;
  document.title = `${meta.title} · ComfyDeck`;
  $('#sidebar').classList.remove('open');
  const view = $('#view');
  view.classList.toggle('flush', !!meta.flush);
  view.scrollTop = 0;
  meta.render();
}

function refreshCurrent() {
  const meta = ROUTES[state.route];
  if (meta) meta.render();
}

/* ----------------------------------------------------------- common views */
function loadingHtml(text = '加载中…') {
  return `<div class="loading-page"><div class="spinner"></div><div>${esc(text)}</div></div>`;
}
function errorHtml(message) {
  return `<div class="empty"><div>${icon('alert')}</div><div style="color:var(--err);margin-bottom:10px">${esc(message)}</div><button class="btn sm" data-action="retry">${icon('refresh')} 重试</button></div>`;
}
function emptyHtml(text, iconName = 'info') {
  return `<div class="empty"><div>${icon(iconName)}</div><div>${esc(text)}</div></div>`;
}
function pageHead(title, subtitle, actions = '') {
  return `<div class="page-head"><div><h2>${esc(title)}</h2>${subtitle ? `<div class="sub">${subtitle}</div>` : ''}</div><div class="head-actions">${actions}</div></div>`;
}
function meter(label, used, total, text) {
  const pct = total ? Math.min(100, Math.round(used / total * 100)) : 0;
  return `<div class="meter"><div class="row"><span>${esc(label)}</span><span>${esc(text || `${fmtBytes(used)} / ${fmtBytes(total)}`)}</span></div><div class="bar ${pct > 90 ? 'warn' : ''}"><span style="width:${pct}%"></span></div></div>`;
}
