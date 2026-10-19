/* ComfyDeck — ComfyUI core version */
'use strict';

ROUTES.core = { title: '核心版本', render: renderCore };

async function renderCore() {
  const view = $('#view');
  view.innerHTML = `<div class="page">${loadingHtml('读取核心信息…')}</div>`;
  try {
    const core = await api('/api/core');
    if (state.route !== 'core') return;
    state.core = core;
    if (core.service) setComfyStatus(core.service);
    applyCoreNav(core);
    view.innerHTML = `<div class="page">${corePageHtml(core)}</div>`;
  } catch (err) {
    if (state.route !== 'core') return;
    view.innerHTML = `<div class="page">${errorHtml(err.message)}</div>`;
  }
}

function applyCoreNav(core) {
  const nav = $('#nav-core-update');
  if (nav) nav.textContent = core?.update_available ? '新版' : '';
}

function corePageHtml(core) {
  const git = core.git || {};
  const latest = core.latest || {};
  const history = core.history || [];
  const service = core.service || {};
  const current = git.tag || (core.version ? `v${core.version}` : '未知');
  const canUpdate = !!core.update_available;
  const running = !!service.running;

  if (!core.exists) {
    return `${pageHead('核心版本', '')}<div class="callout err">${icon('alert')}<div>没有找到 ComfyUI 安装目录。请先在设置中指定包含 <span class="mono">main.py</span> 的目录。</div><a class="btn sm" href="#/settings">打开设置</a></div>`;
  }

  const alerts = [];
  if (canUpdate) alerts.push(`<div class="callout warn">${icon('arrowUp')}<div>有新版本 <b>${esc(latest.tag)}</b>${latest.published_at ? ` · ${esc(fmtDate(latest.published_at).slice(0, 10))}` : ''}。更新前请先停止 ComfyUI，并确认常用插件已兼容。</div><button class="btn xs primary" data-action="core-update">更新</button></div>`);
  if (running) alerts.push(`<div class="callout warn">${icon('alert')}<div>ComfyUI 正在运行。更新或回滚前请先停止；强制更新后也需要重启才会加载新代码。</div><button class="btn xs" data-action="comfy-stop">停止</button></div>`);
  if (git.dirty) alerts.push(`<div class="callout warn">${icon('alert')}<div>仓库有 ${esc(git.dirty_count || '若干')} 个未提交的本地修改。更新时默认中止；勾选“强制更新”会先 <span class="mono">git stash</span>。</div></div>`);
  if (!git.git) alerts.push(`<div class="callout err">${icon('alert')}<div>该目录不是 Git 仓库，无法自动更新或回滚。</div></div>`);
  if (latest.note) alerts.push(`<div class="callout">${icon('info')}<div>${esc(latest.note)}</div></div>`);

  const release = latest.body
    ? `<pre class="release-notes">${esc(latest.body)}</pre>`
    : `<div class="dim small">${latest.tag ? '该版本没有发布说明' : '还没有检查最新版本，点右上角“检查更新”。'}</div>`;

  const historyRows = history.length ? `<div class="list">${history.map((item) => `
    <div class="list-row">
      <div class="grow">
        <div class="row" style="gap:6px"><span class="t mono">${esc(item.to || item.tag || '—')}</span>${item.rollback ? '<span class="badge amber">回滚</span>' : '<span class="badge green">更新</span>'}</div>
        <div class="s">${item.from ? `${esc(item.from)} → ${esc(item.to || '')}` : esc(item.to || '')} · ${esc(item.time || '')}</div>
      </div>
      ${item.from ? `<button class="btn xs" data-action="core-rollback" data-ref="${esc(item.from)}">${icon('undo')} 回到 ${esc(shorten(item.from, 12))}</button>` : ''}
    </div>`).join('')}</div>` : `<div class="dim small">还没有通过 ComfyDeck 更新过核心。</div>`;

  return `${pageHead('核心版本', `<span class="mono">${esc(current)}</span> · ${canUpdate ? `<span class="warn-t">最新稳定版 ${esc(latest.tag)}</span>` : (latest.tag ? '已是最新稳定版' : '尚未检查更新')}`, `
      <button class="btn" data-action="core-check">${icon('refresh')} 检查更新</button>
      <button class="btn" data-action="core-rollback">${icon('undo')} 回滚</button>
      <button class="btn ${canUpdate ? 'primary' : ''}" data-action="core-update">${icon('arrowUp')} 更新核心</button>`)}
    <div class="stack">
      ${alerts.join('')}
      <div class="panel pad">
        <div class="panel-title"><h3>${icon('terminal')} 安装信息</h3><button class="btn ghost xs" data-action="open-folder" data-kind="comfy">${icon('folder')} 打开目录</button></div>
        <div class="kv wide">
          <div class="k">当前版本</div><div class="v mono">${esc(current)}</div>
          <div class="k">最新稳定版</div><div class="v mono">${esc(latest.tag || '—')}${latest.checked_at ? ` <span class="dim">· 检查于 ${esc(timeAgo(latest.checked_at))}</span>` : ''}</div>
          <div class="k">分支 / 提交</div><div class="v mono">${esc(git.branch || '—')} · ${esc(git.short || '—')}</div>
          <div class="k">本地修改</div><div class="v">${git.dirty ? `${esc(git.dirty_count || 0)} 个文件` : '无'}</div>
          <div class="k">仓库</div><div class="v break">${esc(git.remote || '—')}</div>
          <div class="k">安装目录</div><div class="v mono break">${esc(core.path || '')}</div>
          <div class="k">Python</div><div class="v mono break">${esc(core.python || '')}</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="panel pad">
          <div class="panel-title"><h3>${icon('file')} 发布说明</h3>${latest.url ? `<a class="btn xs ghost" href="${esc(latest.url)}" target="_blank" rel="noopener">${icon('external')} Release</a>` : ''}</div>
          ${latest.tag ? `<div class="mb-8"><b>${esc(latest.name || latest.tag)}</b></div>` : ''}${release}
        </div>
        <div class="panel pad">
          <div class="panel-title"><h3>${icon('clock')} 更新历史</h3><span class="hint">最近 ${history.length} 条</span></div>
          ${historyRows}
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ actions */
async function runCoreCheck() {
  const res = await post('/api/core/check');
  if (res.core) { state.core = res.core; applyCoreNav(res.core); }
  const tag = res.latest?.tag || res.core?.latest?.tag || '';
  toast(tag ? `检查完成，最新稳定版 ${tag}` : '检查完成，但没有获取到版本号');
  if (state.route === 'core') renderCore();
  else if (state.route === 'overview') renderOverview();
}

async function openCoreUpdateModal() {
  let core = state.core;
  if (!core || !core.exists) { core = await api('/api/core'); state.core = core; }
  if (!core.exists) { toast('没有找到 ComfyUI 安装目录', 'err'); return; }
  if (!core.latest?.tag) {
    const checked = await post('/api/core/check');
    core = checked.core || core;
    state.core = core;
  }
  const latest = core.latest || {};
  const git = core.git || {};
  const current = git.tag || (core.version ? `v${core.version}` : '未知');
  const running = !!(core.service?.running || core.running);
  const notes = (latest.body || '').slice(0, 6000);
  const body = `
    <div class="stat-inline mb-12">
      <span>当前 <b class="mono">${esc(current)}</b></span>
      <span>目标 <b class="mono">${esc(latest.tag || '最新版')}</b></span>
      ${latest.published_at ? `<span>发布于 <b>${esc(fmtDate(latest.published_at).slice(0, 10))}</b></span>` : ''}
    </div>
    <div class="field"><label>目标版本</label><input class="input mono-in" data-confirm-field="target" value="${esc(latest.tag || 'latest')}" placeholder="latest 或 v0.42.1"></div>
    <div class="mt-16"><label class="check-row"><input type="checkbox" data-confirm-field="install_requirements" checked> 更新后安装核心依赖（pip install -r requirements.txt）</label></div>
    <div class="mt-8"><label class="check-row"><input type="checkbox" data-confirm-field="force"> 强制更新（ComfyUI 运行中或有本地修改时仍继续，会自动 stash）</label></div>
    ${running ? `<div class="callout warn mt-16">${icon('alert')}<div>ComfyUI 正在运行，建议先停止。更新完成后必须重启才会加载新版本。</div></div>` : ''}
    ${git.dirty ? `<div class="callout warn mt-12">${icon('alert')}<div>仓库有未提交修改，不勾选强制更新会中止。强制更新后可用 <span class="mono">git stash pop</span> 恢复。</div></div>` : ''}
    ${notes ? `<div class="mini-label mt-16">发布说明</div><pre class="release-notes" style="max-height:220px">${esc(notes)}</pre>` : ''}`;
  const res = await showConfirm({ title: `更新 ComfyUI 到 ${latest.tag || '最新版'}`, body, confirmText: '开始更新', medium: true });
  if (!res.ok) return;
  const target = String(res.target || '').trim() || 'latest';
  await startJobRequest('/api/core/update', { target, force: !!res.force, install_requirements: res.install_requirements !== false }, {
    message: `核心更新任务已开始（${target}）`, onDone: () => refreshAfterCoreJob(),
  });
}

async function openCoreRollbackModal(ref = '') {
  const core = state.core || await api('/api/core');
  state.core = core;
  if (!core.exists) { toast('没有找到 ComfyUI 安装目录', 'err'); return; }
  const options = [];
  (core.history || []).forEach((h) => [h.to, h.from].forEach((v) => { if (v && !options.includes(v)) options.push(v); }));
  const current = core.git?.tag || (core.version ? `v${core.version}` : '');
  if (current && !options.includes(current)) options.unshift(current);
  const body = `
    <div class="callout warn">${icon('alert')}<div>回滚会执行 <span class="mono">git checkout &lt;版本&gt;</span> 并重新安装核心依赖。请先停止 ComfyUI，并确认目标版本与现有插件兼容。</div></div>
    <div class="field mt-16"><label>目标版本 / 标签 / 提交</label><input class="input mono-in" data-confirm-field="ref" list="core-ref-list" value="${esc(ref)}" placeholder="例如 v0.33.1 或提交 SHA"></div>
    <datalist id="core-ref-list">${options.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>
    <div class="mt-12"><label class="check-row"><input type="checkbox" data-confirm-field="install_requirements" checked> 回滚后重新安装核心依赖</label></div>`;
  const res = await showConfirm({ title: '回滚 ComfyUI 版本', body, confirmText: '开始回滚', danger: true });
  if (!res.ok) return;
  const target = String(res.ref || '').trim();
  if (!target) { toast('请输入目标版本', 'err'); return; }
  await startJobRequest('/api/core/rollback', { ref: target, install_requirements: res.install_requirements !== false }, {
    message: `回滚任务已开始（${target}）`, onDone: () => refreshAfterCoreJob(),
  });
}

function refreshAfterCoreJob() {
  state.core = null;
  if (state.route === 'core') renderCore();
  else if (state.route === 'overview') renderOverview();
}
