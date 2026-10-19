/* ComfyDeck — custom nodes */
'use strict';

ROUTES.nodes = { title: '插件', render: renderNodes };

async function renderNodes() {
  $('#view').innerHTML = `<div class="page">${loadingHtml('正在读取 custom_nodes…')}</div>`;
  try {
    const data = await api('/api/nodes');
    if (state.route !== 'nodes') return;
    state.nodes.items = data.items || [];
    state.nodes.summary = data.summary || {};
    state.nodes.checked_at = data.checked_at || null;
    $('#view').innerHTML = nodesPageHtml(data);
    bindNodesPage();
  } catch (err) {
    if (state.route !== 'nodes') return;
    $('#view').innerHTML = `<div class="page">${errorHtml(err.message)}</div>`;
  }
}

function nodesPageHtml(data) {
  const s = data.summary || {};
  const checked = data.checked_at ? timeAgo(data.checked_at) : '从未检查';
  const stale = !data.checked_at || (Date.now() / 1000 - data.checked_at > 86400);
  return `<div class="page">
    ${pageHead('插件', `${s.enabled || 0} / ${s.total || 0} 个已启用 · ${s.git || 0} 个 Git · ${s.cnr || 0} 个 Registry · ${s.updates ? `<span class="warn-t">${s.updates} 个可更新</span>` : '全部最新'} · 上次检查 ${esc(checked)}`, `
      <button class="btn" data-action="nodes-check">${icon('refresh')} 检查更新</button>
      <button class="btn" data-action="nodes-update-all">${icon('arrowUp')} 全部更新</button>
      <button class="btn primary" data-action="nodes-install">${icon('plus')} 安装插件</button>
    `)}
    ${stale ? `<div class="callout warn mb-12">${icon('alert')}<div>还没有检查更新，或结果已超过 24 小时。检查会对每个 Git 插件执行 fetch，请保持网络畅通。</div><button class="btn xs" data-action="nodes-check">立即检查</button></div>` : ''}
    <div class="toolbar">
      <div class="search-wrap">${icon('search')}<input class="input" id="node-filter-q" placeholder="搜索插件名称、目录或仓库…"></div>
      <select class="select" id="node-filter-status">
        <option value="all">全部状态</option>
        <option value="update">有更新</option>
        <option value="disabled">已禁用</option>
        <option value="git">Git 插件</option>
        <option value="cnr">Registry 插件</option>
      </select>
      <label class="switch" style="margin-left:auto"><input type="checkbox" id="nodes-run-install" ${state.nodes.runInstall ? 'checked' : ''}><span class="track"></span><span class="label">更新时运行 install.py</span></label>
    </div>
    <div class="table-wrap">
      <table><thead><tr><th>插件</th><th>来源</th><th>版本</th><th>状态</th><th>更新</th><th style="text-align:right">操作</th></tr></thead>
      <tbody id="node-rows">${nodeRowsHtml()}</tbody></table>
    </div>
    <div class="tiny dim mt-12">启用 / 禁用通过 <span class="mono">custom_nodes/.disabled</span> 实现，重启 ComfyUI 后生效。移除的插件会进入回收站，可以恢复。</div>
  </div>`;
}

function bindNodesPage() {
  $('#node-filter-q')?.addEventListener('input', debounce(renderNodeRows, 180));
  $('#node-filter-status')?.addEventListener('change', renderNodeRows);
  $('#nodes-run-install')?.addEventListener('change', (e) => { state.nodes.runInstall = e.target.checked; });
  $('#node-rows')?.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-node-toggle]');
    if (!input) return;
    const dir = input.dataset.nodeToggle;
    const was = input.checked;
    input.disabled = true;
    try {
      const res = await api('/api/nodes/toggle', { method: 'POST', body: { dir_name: dir } });
      toast(res.enabled ? '插件已启用，重启 ComfyUI 后生效' : '插件已禁用，重启 ComfyUI 后生效');
      renderNodes();
    } catch (err) {
      input.checked = !was;
      toast(err.message, 'err');
    } finally {
      input.disabled = false;
    }
  });
}

function filteredNodes() {
  const q = ($('#node-filter-q')?.value || '').trim().toLowerCase();
  const status = $('#node-filter-status')?.value || 'all';
  return (state.nodes.items || []).filter((n) => {
    if (q) {
      const hay = `${n.name} ${n.dir_name} ${n.remote || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (status === 'update' && !(n.update && n.update.behind > 0)) return false;
    if (status === 'disabled' && n.enabled) return false;
    if (status === 'git' && n.kind !== 'git') return false;
    if (status === 'cnr' && n.kind !== 'cnr') return false;
    return true;
  });
}

function renderNodeRows() {
  const tbody = $('#node-rows');
  if (!tbody) return;
  tbody.innerHTML = nodeRowsHtml();
}

function nodeRowsHtml() {
  const items = filteredNodes();
  return items.length ? items.map(nodeRowHtml).join('') : `<tr><td colspan="6">${emptyHtml('没有匹配的插件', 'plug')}</td></tr>`;
}

function nodeRowHtml(n) {
  const update = n.update || {};
  const git = n.git || {};
  const behind = Number(update.behind) || 0;
  const hasUpdate = behind > 0;
  const checked = update.checked_at ? timeAgo(update.checked_at) : null;
  let updateHtml = `<span class="dim small">未检查</span>`;
  if (update.error) {
    updateHtml = `<span class="badge red" title="${esc(update.error)}">检查失败</span><span class="commit" title="${esc(update.error)}">${esc(update.error)}</span>`;
  } else if (hasUpdate) {
    updateHtml = `<span class="badge amber">${n.kind === 'cnr' ? `新版本 ${esc(update.latest_version || '')}` : `${behind} 个新提交`}</span><span class="commit" title="${esc(update.latest_subject || '')}">${esc(update.latest_subject || '')}</span>`;
  } else if (checked) {
    updateHtml = `<span class="badge green">已是最新</span><span class="commit">${esc(checked)}</span>`;
  }
  const remote = n.remote ? `<a class="remote" href="${esc(n.remote)}" target="_blank" rel="noopener">${icon('external')} ${esc(shortRemote(n.remote))}</a>` : (n.kind === 'cnr' ? '<span class="dim tiny">Comfy Registry</span>' : '<span class="dim tiny">本地安装</span>');
  return `<tr>
    <td><div class="node-name">${esc(n.name)} ${git.dirty ? '<span class="badge amber">有修改</span>' : ''}</div><div class="sub mono">${esc(n.dir_name)}</div>${remote}</td>
    <td><span class="badge ${n.kind === 'cnr' ? 'blue' : 'gray'}">${n.kind === 'git' ? 'Git' : n.kind === 'cnr' ? 'Registry' : 'Folder'}</span>${n.requirements ? '<div class="sub">requirements</div>' : ''}${n.install_py ? '<div class="sub">install.py</div>' : ''}</td>
    <td><div class="mono small">${esc(n.version || '—')}</div>${git.short ? `<div class="sub mono">${esc(git.short)}</div>` : ''}</td>
    <td><span class="status-dot ${n.enabled ? '' : 'off'}">${n.enabled ? '已启用' : '已禁用'}</span>${n.enabled ? '' : '<div class="sub">位于 .disabled</div>'}</td>
    <td><div class="update-cell">${updateHtml}</div></td>
    <td><div class="row-actions">
      <label class="switch" title="${n.enabled ? '禁用插件' : '启用插件'}"><input type="checkbox" data-node-toggle="${esc(n.dir_name)}" ${n.enabled ? 'checked' : ''}><span class="track"></span></label>
      <button class="btn xs" data-action="node-info" data-dir="${esc(n.dir_name)}">${icon('info')}</button>
      <button class="btn xs ${hasUpdate ? 'primary' : ''}" data-action="node-update" data-dir="${esc(n.dir_name)}" data-name="${esc(n.name)}" ${hasUpdate ? '' : 'disabled'}>${icon('arrowUp')} 更新</button>
      <button class="btn xs danger" data-action="node-remove" data-dir="${esc(n.dir_name)}" data-name="${esc(n.name)}">${icon('trash')}</button>
    </div></td>
  </tr>`;
}

function shortRemote(url) {
  return String(url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, '');
}

async function startNodesCheck() {
  await startJobRequest('/api/nodes/check', {}, {
    message: '开始检查插件更新',
    onDone: () => renderNodes(),
  });
}

async function updateAllNodes() {
  const targets = (state.nodes.items || []).filter((n) => n.enabled && (n.update?.behind || 0) > 0);
  if (!targets.length) { toast('没有可更新的插件，请先检查更新', 'err'); return; }
  const running = state.comfy?.running;
  const res = await showConfirm({
    title: '批量更新插件',
    body: `将更新 <b>${targets.length}</b> 个插件：${targets.slice(0, 8).map((n) => esc(n.name)).join('、')}${targets.length > 8 ? ' 等' : ''}。<br><br>更新会执行 git pull，并安装 requirements.txt；${state.nodes.runInstall ? '同时会运行 install.py。' : '不会自动运行 install.py。'}${running ? '<br><br><span class="warn-t">ComfyUI 正在运行，更新完成后需要重启。</span>' : ''}`,
    confirmText: `更新 ${targets.length} 个插件`,
    extraHtml: `<label class="check-row"><input type="checkbox" data-confirm-field="run_install" ${state.nodes.runInstall ? 'checked' : ''}> 运行 install.py（部分插件需要）</label>`,
  });
  if (!res.ok) return;
  await startJobRequest('/api/nodes/update-all', { names: targets.map((n) => n.dir_name), run_install: !!res.run_install }, {
    message: '批量更新任务已开始',
    onDone: () => renderNodes(),
  });
}

async function updateOneNode(dir, name) {
  const node = (state.nodes.items || []).find((n) => n.dir_name === dir);
  const running = state.comfy?.running;
  const res = await showConfirm({
    title: '更新插件',
    body: `更新 <b>${esc(name)}</b>？${running ? '<br><br><span class="warn-t">ComfyUI 正在运行，更新完成后需要重启。</span>' : ''}`,
    confirmText: '开始更新',
    extraHtml: `<label class="check-row"><input type="checkbox" data-confirm-field="run_install" ${state.nodes.runInstall ? 'checked' : ''}> 同时运行 install.py</label>`,
  });
  if (!res.ok) return;
  await startJobRequest('/api/nodes/update', { dir_name: dir, run_install: !!res.run_install }, {
    message: '更新任务已开始',
    onDone: () => renderNodes(),
  });
}

async function removeOneNode(dir, name) {
  const res = await showConfirm({
    title: '移除插件',
    body: `把 <b>${esc(name)}</b> 移到回收站？之后可以在“回收站”里恢复。`,
    confirmText: '移到回收站',
    danger: true,
  });
  if (!res.ok) return;
  await post('/api/nodes/remove', { dir_name: dir });
  toast('插件已移入回收站');
  renderNodes();
}

function openNodeInstallModal() {
  showConfirm({
    title: '安装自定义节点',
    body: '从 Git 仓库克隆插件到 custom_nodes。支持 GitHub / GitLab / Gitee / Hugging Face 等常见托管平台。',
    confirmText: '开始安装',
    extraHtml: `<div class="field"><label>仓库地址</label><input class="input" data-confirm-field="url" placeholder="https://github.com/作者/插件名"></div>
      <div class="field mt-12"><label>目录名（可选）</label><input class="input" data-confirm-field="name" placeholder="留空则使用仓库名"></div>
      <label class="check-row mt-12"><input type="checkbox" data-confirm-field="run_install" ${state.nodes.runInstall ? 'checked' : ''}> 安装后运行 install.py</label>`,
  }).then(async (res) => {
    if (!res.ok || !res.url) return;
    await startJobRequest('/api/nodes/install', { url: res.url, name: res.name, run_install: !!res.run_install }, {
      message: '安装任务已开始',
      onDone: () => renderNodes(),
    });
  });
}

function openNodeInfo(dir) {
  const n = (state.nodes.items || []).find((x) => x.dir_name === dir);
  if (!n) return;
  const update = n.update || {};
  const git = n.git || {};
  showModal(modalHead(n.name, n.dir_name) + `<div class="modal-body">
    <div class="kv">
      <div class="k">来源</div><div class="v">${n.kind === 'git' ? 'Git 仓库' : n.kind === 'cnr' ? 'Comfy Registry' : '手动安装目录'}</div>
      <div class="k">版本</div><div class="v mono">${esc(n.version || '—')}</div>
      <div class="k">提交</div><div class="v mono">${esc(git.short || '—')}</div>
      <div class="k">分支</div><div class="v mono">${esc(git.branch || '—')}</div>
      <div class="k">最近提交</div><div class="v">${esc(git.subject || '—')}</div>
      <div class="k">提交时间</div><div class="v">${esc(fmtDate(git.head_date))}</div>
      <div class="k">仓库</div><div class="v break">${n.remote ? `<a class="remote" href="${esc(n.remote)}" target="_blank" rel="noopener">${esc(n.remote)}</a>` : '—'}</div>
      <div class="k">依赖</div><div class="v">${n.requirements ? 'requirements.txt' : '无'}${n.install_py ? ' · install.py' : ''}</div>
      <div class="k">检查结果</div><div class="v">${update.error ? `<span class="err-t">${esc(update.error)}</span>` : update.behind ? `落后 ${update.behind} 个提交` : '已是最新'}</div>
    </div>
    ${update.latest_subject ? `<div class="mini-label mt-16">远端最新提交</div><div class="callout">${icon('git')}<div>${esc(update.latest_subject)}</div></div>` : ''}
    <div class="mt-16"><button class="btn sm" data-action="open-folder" data-kind="custom_nodes">${icon('folder')} 打开 custom_nodes</button></div>
  </div>`, { medium: true });
}
