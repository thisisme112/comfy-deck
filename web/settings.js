/* ComfyDeck — downloads and settings */
'use strict';

/* ------------------------------------------------------------------ downloads */
ROUTES.downloads = { title: '下载', render: renderDownloads };

async function renderDownloads() {
  $('#view').innerHTML = `<div class="page">${loadingHtml('正在读取下载任务…')}</div>`;
  try {
    const data = await api('/api/jobs?kind=download');
    if (state.route !== 'downloads') return;
    state.downloads = data.items || [];
    $('#view').innerHTML = downloadsPageHtml(state.downloads);
    if (state.timers.downloads) clearInterval(state.timers.downloads);
    state.timers.downloads = setInterval(refreshDownloads, 2500);
  } catch (err) {
    if (state.route !== 'downloads') return;
    $('#view').innerHTML = `<div class="page">${errorHtml(err.message)}</div>`;
  }
}

async function refreshDownloads() {
  if (state.route !== 'downloads' || document.hidden) return;
  try {
    const data = await api('/api/jobs?kind=download');
    state.downloads = data.items || [];
    const active = state.downloads.filter(isActiveJob);
    const history = state.downloads.filter((j) => !isActiveJob(j)).slice(0, 30);
    if ($('#download-active')) $('#download-active').innerHTML = downloadRowsHtml(active, true);
    if ($('#download-history')) $('#download-history').innerHTML = downloadRowsHtml(history, false);
    if ($('#download-sub')) $('#download-sub').innerHTML = downloadSummary(state.downloads);
  } catch (err) { /* server offline */ }
}

function isActiveJob(job) { return ['queued', 'running'].includes(job?.status); }

function downloadSummary(items) {
  const active = items.filter(isActiveJob).length;
  const done = items.filter((j) => j.status === 'done').length;
  const failed = items.filter((j) => j.status === 'error').length;
  return `${active} 个进行中 · ${done} 个已完成${failed ? ` · <span class="err-t">${failed} 个失败</span>` : ''}`;
}

function downloadsPageHtml(items) {
  const active = items.filter(isActiveJob);
  const history = items.filter((j) => !isActiveJob(j)).slice(0, 30);
  return `<div class="page narrow" style="max-width:920px">
    ${pageHead('下载', `<span id="download-sub">${downloadSummary(items)}</span>`, `<a class="btn primary" href="#/civitai">${icon('compass')} 去 CivitAI 找模型</a>`)}
    <div class="mini-label">正在下载</div>
    <div id="download-active">${downloadRowsHtml(active, true)}</div>
    <div class="mini-label mt-20">历史记录</div>
    <div id="download-history">${downloadRowsHtml(history, false)}</div>
    <div class="tiny dim mt-12">下载使用 <span class="mono">.part</span> 临时文件，中断后重新下载同一文件会自动续传。</div>
  </div>`;
}

function downloadRowsHtml(items, active) {
  if (!items.length) return `<div class="empty" style="padding:24px">${active ? '当前没有下载任务' : '还没有下载记录'}</div>`;
  return `<div class="list">${items.map((job) => {
    const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const path = (job.result || {}).path || '';
    return `<div class="list-row" style="align-items:flex-start">
      <div class="grow">
        <div class="row" style="gap:8px"><span class="t">${esc(job.title || '下载任务')}</span>${statusBadge(job.status)}${active ? `<span class="mono tiny dim">${Math.round(pct)}%</span>` : ''}</div>
        <div class="s" style="white-space:normal">${esc(job.message || '')}</div>
        ${active ? `<div class="bar mt-8" style="max-width:480px"><span style="width:${Math.max(2, pct)}%"></span></div>` : ''}
        ${job.error ? `<div class="s err-t" style="white-space:normal">${esc(job.error)}</div>` : ''}
        ${path ? `<div class="s mono">${esc(path)}</div>` : ''}
        <div class="s">${esc(fmtDate(job.finished || job.started || job.created))}</div>
      </div>
      <div class="row-actions" style="flex:none">
        ${path ? `<button class="btn xs" data-action="model-reveal" data-path="${esc(path)}" title="打开所在文件夹">${icon('folder')}</button>` : ''}
        <button class="btn xs" data-action="job-open" data-id="${esc(job.id)}">详情</button>
        ${active ? `<button class="btn xs danger" data-action="job-cancel" data-id="${esc(job.id)}">取消</button>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

/* ------------------------------------------------------------------- settings */
ROUTES.settings = { title: '设置', render: renderSettings };

async function renderSettings() {
  $('#view').innerHTML = `<div class="page narrow">${loadingHtml('正在读取设置…')}</div>`;
  try {
    const data = await api('/api/settings');
    if (state.route !== 'settings') return;
    state.settingsData = data;
    state.settings = data.settings || {};
    state.nsfw = !!state.settings.nsfw;
    $('#view').innerHTML = settingsPageHtml(data);
  } catch (err) {
    if (state.route !== 'settings') return;
    $('#view').innerHTML = `<div class="page">${errorHtml(err.message)}</div>`;
  }
}

function settingsPageHtml(data) {
  const s = data.settings || {};
  const paths = data.paths || {};
  const roots = data.roots || [];
  const extra = (s.extra_model_paths || []).map((p) => (typeof p === 'string' ? p : `${p.type || ''}|${p.path || ''}`)).join('\n');
  const tokenHint = (key) => (s[`${key}_set`] ? '已配置，留空或保留掩码表示不修改' : '未配置');
  const theme = localStorage.getItem('cd-theme') || 'auto';
  const rootRows = roots.length ? roots.map((r) => `<div class="root-item"><span class="type">${esc(typeLabel(r.type))}</span><span class="path" title="${esc(r.path)}">${esc(r.path)}</span><button class="btn xs ghost" data-action="open-folder-path" data-path="${esc(r.path)}" title="打开">${icon('folder')}</button></div>`).join('') : `<div class="dim small">没有扫描到模型目录</div>`;

  return `<div class="page narrow">
    ${pageHead('设置', '', `<button class="btn" data-action="settings-test-civitai">${icon('globe')} 测试 CivitAI</button><button class="btn primary" data-action="settings-save">${icon('save')} 保存</button>`)}

    <div class="setting-block">
      <h3>安装位置</h3>
      <div class="sub">自动检测会查找环境变量、正在运行的 ComfyUI 和常见安装位置；也可以直接选择文件夹。</div>
      <div class="row wrap" style="gap:6px">
        <button class="btn sm primary" data-action="paths-detect">${icon('search')} 自动检测</button>
        <button class="btn sm" data-action="paths-browse" data-kind="comfy">${icon('folder')} 选择 ComfyUI 目录</button>
        <button class="btn sm" data-action="paths-browse" data-kind="python">${icon('terminal')} 选择 Python</button>
        <button class="btn sm ghost" data-action="paths-detect-deep">${icon('compass')} 深度扫描</button>
      </div>
      <div id="path-detect-panel" class="mt-12">${(data.suggestions || []).length ? pathCandidatesHtml(data.suggestions) : ''}</div>
      <div class="stack mt-16" style="gap:12px">
        <div class="field"><label>ComfyUI 目录</label>
          <div class="row" style="gap:6px">
            <input class="input mono-in grow" id="set-comfy-dir" value="${esc(s.comfy_dir || '')}" placeholder="例如 D:\\AI\\ComfyUI_windows_portable\\ComfyUI">
            <button class="btn sm" style="flex:none" data-action="paths-browse" data-kind="comfy">${icon('folder')} 浏览</button>
          </div>
          <span class="help">目录中必须包含 main.py。修改后会重新扫描模型和插件，并清除 CivitAI / 核心版本缓存。</span>
        </div>
        <div class="field"><label>Python 解释器</label>
          <div class="row" style="gap:6px">
            <input class="input mono-in grow" id="set-python-exe" value="${esc(s.python_exe || '')}" placeholder="...\\python_embeded\\python.exe">
            <button class="btn sm" style="flex:none" data-action="paths-browse" data-kind="python">${icon('terminal')} 浏览</button>
          </div>
          <span class="help">用于启动 ComfyUI，以及安装插件和核心依赖。选择 ComfyUI 目录后会自动匹配便携版自带的 Python。</span>
        </div>
        ${data.python_exists === false ? `<div class="callout err">${icon('alert')}<div>没有找到可用的 Python。请选择 ComfyUI 目录旁的 <span class="mono">python_embeded\\python.exe</span>，否则无法启动 ComfyUI。</div></div>` : ''}
        ${data.comfy_exists === false ? `<div class="callout err">${icon('alert')}<div>当前路径下没有找到 main.py。${(data.suggestions || []).length ? '下面列出了检测到的候选目录。' : '请点击“自动检测”或手动选择目录。'}</div></div>` : ''}
      </div>
    </div>

    <div class="setting-block">
      <h3>启动</h3>
      <div class="sub">启动方案在“启动台”里管理。</div>
      <div class="stack" style="gap:12px">
        <div class="field" style="max-width:220px"><label>默认检测端口</label><input class="input mono-in" id="set-comfy-port" type="number" min="1" max="65535" value="${esc(s.comfy_port || 8188)}"><span class="help">没有通过方案指定 <span class="mono">--port</span> 时，用它判断 ComfyUI 是否在运行。</span></div>
        <label class="check-row"><input type="checkbox" id="set-auto-start" ${s.auto_start_comfy ? 'checked' : ''}> 打开 ComfyDeck 时自动启动 ComfyUI（使用上次选中的方案）</label>
        <label class="check-row"><input type="checkbox" id="set-open-browser" ${s.open_browser !== false ? 'checked' : ''}> 启动 ComfyDeck 时自动打开本页面</label>
      </div>
    </div>

    <div class="setting-block">
      <h3>模型目录</h3>
      <div class="sub">自动包含 ComfyUI/models、extra_model_paths.yaml 和下面添加的目录。每行一个，格式 <span class="mono">类型|路径</span> 或直接写路径。</div>
      <div class="field"><textarea class="textarea mono-in" id="set-extra-paths" rows="3" placeholder="loras|D:\\AI\\Models\\Lora&#10;D:\\AI\\Models\\Checkpoints">${esc(extra)}</textarea></div>
      <div class="mini-label mt-12">当前扫描到的目录 (${roots.length})</div>
      <div class="root-list">${rootRows}</div>
    </div>

    <div class="setting-block">
      <h3>图库</h3>
      <div class="sub">默认索引 ComfyUI 的 output 与 input 目录。可以再加入其他存放图片的文件夹。</div>
      <div class="field"><textarea class="textarea mono-in" id="set-gallery-dirs" rows="2" placeholder="D:\\AI\\Outputs">${esc((s.gallery_extra_dirs || []).join('\n'))}</textarea><span class="help">每行一个文件夹。</span></div>
      <div class="row wrap mt-12" style="gap:6px"><button class="btn sm" data-action="gal-scan-settings">${icon('refresh')} 重新建立索引</button><button class="btn sm" data-action="cache-clear" data-prefix="thumbs">${icon('trash')} 清除缩略图缓存</button></div>
    </div>

    <div class="setting-block">
      <h3>下载与匹配</h3>
      <div class="sub">并发过高可能触发 CivitAI 限速。</div>
      <div class="form-grid" style="max-width:420px">
        <div class="field"><label>同时下载数量</label><select class="select" id="set-max-downloads" style="width:100%">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${Number(s.max_downloads || 2) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label>哈希并发</label><select class="select" id="set-hash-workers" style="width:100%">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(s.hash_workers || 1) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
    </div>

    <div class="setting-block">
      <h3>API 与网络</h3>
      <div class="sub">API Key 只保存在本机 data/config.json。</div>
      <div class="stack" style="gap:12px">
        <div class="field"><label>CivitAI API Key <span class="badge ${s.civitai_api_key_set ? 'green' : 'gray'}">${s.civitai_api_key_set ? '已配置' : '未配置'}</span></label><input class="input mono-in" type="password" autocomplete="off" id="set-civitai-key" value="${esc(s.civitai_api_key || '')}"><span class="help">${tokenHint('civitai_api_key')}。下载需要登录 / Early Access 的模型时使用。</span></div>
        <div class="field"><label>GitHub Token</label><input class="input mono-in" type="password" autocomplete="off" id="set-github-token" value="${esc(s.github_token || '')}"><span class="help">${tokenHint('github_token')}。可提高检查 ComfyUI 版本时的 API 额度。</span></div>
        <div class="field"><label>Hugging Face Token</label><input class="input mono-in" type="password" autocomplete="off" id="set-hf-token" value="${esc(s.hf_token || '')}"><span class="help">${tokenHint('hf_token')}。下载受限模型时使用。</span></div>
        <div class="field"><label>代理服务器</label><input class="input mono-in" id="set-proxy" value="${esc(s.proxy || '')}" placeholder="http://127.0.0.1:7890"><span class="help">访问 GitHub / CivitAI / Hugging Face 时使用，留空表示直连。</span></div>
      </div>
    </div>

    <div class="setting-block">
      <h3>外观与内容</h3>
      <div class="stack" style="gap:12px">
        <div class="field"><label>主题</label><div class="seg" id="set-theme" style="align-self:flex-start">${[['auto', '跟随系统'], ['dark', '深色'], ['light', '浅色']].map(([v, l]) => `<button data-action="set-theme" data-value="${v}" class="${theme === v ? 'active' : ''}">${l}</button>`).join('')}</div></div>
        <label class="check-row"><input type="checkbox" id="set-nsfw" ${s.nsfw ? 'checked' : ''}> 允许显示 NSFW 图片（关闭时 NSFW 内容默认模糊，仍可逐张点击显示）</label>
      </div>
    </div>

    <div class="setting-block">
      <h3>缓存与数据</h3>
      <div class="sub">缓存包含 CivitAI 信息、参考图、版本检查结果。清除后会自动重新获取，不会删除模型、插件或设置。</div>
      <div class="row wrap" style="gap:6px">
        <button class="btn sm" data-action="cache-clear" data-prefix="civitai:">${icon('trash')} CivitAI 缓存</button>
        <button class="btn sm" data-action="cache-clear" data-prefix="core:">${icon('trash')} 核心版本缓存</button>
        <button class="btn sm" data-action="cache-clear" data-prefix="registry:">${icon('trash')} Registry 缓存</button>
        <button class="btn sm danger" data-action="cache-clear" data-prefix="">${icon('trash')} 清空全部</button>
      </div>
      <div class="row wrap mt-12" style="gap:6px">
        <button class="btn sm" data-action="open-folder" data-kind="data">${icon('folder')} 数据目录</button>
        <button class="btn sm" data-action="open-folder" data-kind="logs">${icon('terminal')} 日志</button>
        <button class="btn sm" data-action="open-folder" data-kind="previews">${icon('image')} 预览图缓存</button>
      </div>
      ${data.frozen ? `<div class="row wrap mt-12" style="gap:6px"><button class="btn sm danger" data-action="app-quit">${icon('power')} 退出 ComfyDeck</button></div>` : ''}
    </div>

    <div class="setting-block" style="border-bottom:0">
      <h3>关于</h3>
      <div class="kv wide mt-8">
        <div class="k">ComfyDeck</div><div class="v">${esc(data.version || '2.1.0')}</div>
        <div class="k">监听地址</div><div class="v mono">${esc(s.host || '127.0.0.1')}:${esc(s.port || 8288)}</div>
        <div class="k">数据目录</div><div class="v mono break">${esc(paths.data || '')}</div>
        <div class="k">程序目录</div><div class="v mono break">${esc(paths.manager || '')}</div>
      </div>
      <div class="hint-box mt-12">${icon('shield')}<div>只监听本机地址，拒绝来自外部 Origin / Host 的请求。删除操作都会先进入回收站。</div></div>
    </div>
  </div>`;
}

function pathCandidatesHtml(items) {
  const rows = items.map((item) => {
    const python = item.python_exe || '';
    return `<div class="list-row">
      <div class="grow">
        <div class="row wrap" style="gap:6px">
          <span class="mono t" style="word-break:break-all">${esc(item.comfy_dir)}</span>
          <span class="badge blue">${esc(item.source || '检测')}</span>
          ${python ? `<span class="badge green">Python 已匹配</span>` : `<span class="badge amber">未找到 Python</span>`}
        </div>
        ${python ? `<div class="s mono" style="word-break:break-all">${esc(python)}</div>` : ''}
      </div>
      <button class="btn xs primary" style="flex:none" data-action="path-use" data-comfy="${esc(item.comfy_dir)}" data-python="${esc(python)}">使用</button>
    </div>`;
  }).join('');
  return `<div class="mini-label">检测结果 (${items.length})</div><div class="list">${rows}</div>`;
}

async function detectPaths(deep) {
  const panel = $('#path-detect-panel');
  if (!panel) return;
  panel.innerHTML = `<div class="dim small">${deep ? '正在深度扫描磁盘，可能需要十几秒…' : '正在检测…'}</div>`;
  const data = await api(`/api/paths/detect${deep ? '?deep=true' : ''}`);
  if (!$('#path-detect-panel')) return;
  const items = data.items || [];
  $('#path-detect-panel').innerHTML = items.length
    ? pathCandidatesHtml(items)
    : `<div class="callout">${icon('alert')}<div>没有检测到 ComfyUI，请点击“选择 ComfyUI 目录”手动指定。</div></div>`;
  if (!items.length) toast('没有检测到 ComfyUI 安装', 'err', 5000);
}

async function browsePath(kind) {
  const initial = kind === 'python'
    ? ($('#set-python-exe')?.value || '')
    : ($('#set-comfy-dir')?.value || '');
  toast('正在打开系统选择窗口…', 'ok', 1800);
  const out = await post('/api/paths/browse', { kind, initial });
  if (out.cancelled || !out.path) return;
  if (kind === 'python') {
    if ($('#set-python-exe')) $('#set-python-exe').value = out.path;
    toast('已选择 Python');
    return;
  }
  if ($('#set-comfy-dir')) $('#set-comfy-dir').value = out.path;
  if (out.is_comfy === false) {
    toast('这个目录里没有 main.py，保存时会提示', 'err', 5000);
    return;
  }
  if (out.python_exe && $('#set-python-exe')) $('#set-python-exe').value = out.python_exe;
  toast(out.python_exe ? '已选择 ComfyUI 目录，并自动匹配 Python' : '已选择 ComfyUI 目录');
}

function usePathCandidate(el) {
  const comfy = el.dataset.comfy || '';
  const python = el.dataset.python || '';
  if ($('#set-comfy-dir')) $('#set-comfy-dir').value = comfy;
  if (python && $('#set-python-exe')) $('#set-python-exe').value = python;
  toast('已填入路径，点击右上角“保存”生效');
}

async function quitApp() {
  const res = await showConfirm({
    title: '退出 ComfyDeck',
    body: '将停止本地服务并关闭管理页面。由 ComfyDeck 启动的 ComfyUI 不会被停止。',
    confirmText: '退出',
    danger: true,
  });
  if (!res.ok) return;
  try { await post('/api/quit'); } catch (err) { /* server may drop the connection */ }
  document.body.innerHTML = `<div class="loading-page"><div class="spinner"></div><div>ComfyDeck 已退出，可以关闭此页面。</div></div>`;
}

function parseExtraPaths(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const idx = line.indexOf('|');
    if (idx > 0) {
      const type = line.slice(0, idx).trim();
      const path = line.slice(idx + 1).trim();
      if (type && path) return `${type}|${path}`;
    }
    return line;
  });
}

async function saveSettings() {
  const value = (id) => ($(id)?.value || '').trim();
  const checked = (id) => !!$(id)?.checked;
  const patch = {
    comfy_dir: value('#set-comfy-dir'),
    python_exe: value('#set-python-exe'),
    extra_model_paths: parseExtraPaths($('#set-extra-paths')?.value),
    gallery_extra_dirs: parseExtraPaths($('#set-gallery-dirs')?.value),
    civitai_api_key: $('#set-civitai-key')?.value || '',
    github_token: $('#set-github-token')?.value || '',
    hf_token: $('#set-hf-token')?.value || '',
    proxy: value('#set-proxy'),
    nsfw: checked('#set-nsfw'),
    open_browser: checked('#set-open-browser'),
    auto_start_comfy: checked('#set-auto-start'),
    comfy_port: Number(value('#set-comfy-port')) || 8188,
    max_downloads: Number(value('#set-max-downloads')) || 2,
    hash_workers: Number(value('#set-hash-workers')) || 1,
  };
  const out = await post('/api/settings', patch);
  state.settings = out.settings || {};
  state.nsfw = !!state.settings.nsfw;
  state.models.loaded = false;
  toast(out.python_auto ? '设置已保存，并自动匹配了 Python' : '设置已保存');
  renderSettings();
  pollComfy();
}

async function testCivitai() {
  const res = await post('/api/settings/test-civitai');
  toast(res.ok ? 'CivitAI API 连接正常' : 'CivitAI API 连接失败', res.ok ? 'ok' : 'err', 5000);
}

async function clearCache(prefix) {
  const label = prefix === 'thumbs' ? '缩略图' : (prefix ? prefix.replace(':', '') : '全部');
  const res = await showConfirm({ title: '清除缓存', body: `确定清除 <b>${esc(label)}</b> 缓存吗？不会删除模型、插件、图片或设置。`, confirmText: '清除', danger: !prefix });
  if (!res.ok) return;
  const out = await post('/api/cache/clear', { prefix });
  toast(`已清除 ${out.cleared || 0} 项缓存`);
}

async function openFolderPath(path) {
  await post('/api/models/reveal', { path });
}
