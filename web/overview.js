/* ComfyDeck — overview */
'use strict';

ROUTES.overview = { title: '总览', render: renderOverview };

async function renderOverview() {
  const view = $('#view');
  if (!state.overview) view.innerHTML = `<div class="page">${loadingHtml('正在读取…')}</div>`;
  try {
    const data = await api('/api/overview');
    if (state.route !== 'overview') return;
    state.overview = data;
    updateNav(data);
    if (data.comfy) setComfyStatus(data.comfy);
    view.innerHTML = `<div class="page">${overviewHtml(data)}</div>`;
  } catch (err) {
    if (state.route !== 'overview') return;
    view.innerHTML = `<div class="page">${errorHtml(err.message)}</div>`;
  }
}

function overviewHtml(data) {
  const core = data.core || {};
  const git = core.git || {};
  const models = data.models || {};
  const nodes = data.nodes || {};
  const gal = data.gallery || { recent: [], total: {} };
  const svc = data.comfy || {};
  const dev = (svc.devices || [])[0];
  const sys = svc.system || {};
  const version = core.version ? `v${core.version}` : (git.tag || '');

  if (!core.exists) {
    return `${pageHead('总览', '')}<div class="callout err">${icon('alert')}<div>没有找到 ComfyUI 安装目录，请先在设置里指定包含 <span class="mono">main.py</span> 的目录。</div><a class="btn sm" href="#/settings">打开设置</a></div>`;
  }

  const running = svc.state === 'running';
  const starting = svc.state === 'starting';
  const stateText = running ? '运行中' : starting ? '启动中' : '已停止';
  const dotCls = running ? 'ok' : starting ? 'warn' : (svc.last_exit?.crashed ? 'err' : '');
  const controls = running
    ? `<button class="btn" data-action="core-open">${icon('external')} 打开</button><button class="btn" data-action="comfy-restart">${icon('refresh')} 重启</button><button class="btn danger" data-action="comfy-stop">${icon('stop')} 停止</button>`
    : starting
      ? `<a class="btn" href="#/launch">${icon('terminal')} 查看日志</a><button class="btn danger" data-action="comfy-stop">${icon('stop')} 取消启动</button>`
      : `<button class="btn primary" data-action="comfy-start">${icon('play')} 启动 ComfyUI</button><a class="btn" href="#/launch">${icon('sliders')} 启动方案</a>`;

  const meters = [];
  if (running && dev && dev.vram_total) meters.push(meter('显存', dev.vram_total - dev.vram_free, dev.vram_total));
  if (running && sys.ram_total) meters.push(meter('内存', sys.ram_total - sys.ram_free, sys.ram_total));
  if (running && svc.queue) meters.push(`<div class="meter"><div class="row"><span>队列</span><span>${svc.queue.running} 运行 · ${svc.queue.pending} 等待</span></div><div class="bar"><span style="width:${svc.queue.running ? 60 : 0}%"></span></div></div>`);

  const status = `<div class="panel pad">
    <div class="row between wrap" style="gap:16px">
      <div style="min-width:0">
        <div class="state-line"><span class="dot ${dotCls}"></span><span class="big">ComfyUI ${stateText}</span></div>
        <div class="dim small mt-8">${esc(version || '版本未知')}${git.short ? ` · <span class="mono">${esc(git.short)}</span>` : ''}${running ? ` · ${svc.managed ? esc(svc.profile_name || '') + ' · 已运行 ' + fmtDuration(svc.uptime) : '外部启动'} · 端口 ${svc.port}` : ''}${dev ? ` · ${esc(shorten(dev.name, 36))}` : ''}</div>
      </div>
      <div class="head-actions">${controls}</div>
    </div>
    ${meters.length ? `<div class="grid-2 mt-16" style="grid-template-columns:repeat(${meters.length},1fr);gap:20px">${meters.join('')}</div>` : ''}
  </div>`;

  const todo = [];
  if (svc.last_exit?.crashed) todo.push(['err', 'alert', `<b>ComfyUI 上次异常退出</b>（退出码 ${svc.last_exit.code}）`, '#/launch', '查看日志']);
  if (core.update_available) todo.push(['warn', 'arrowUp', `ComfyUI 有新版本 <b>${esc(core.latest?.tag || '')}</b>`, '#/core', '更新']);
  if (nodes.updates) todo.push(['warn', 'plug', `<b>${nodes.updates}</b> 个插件有更新`, '#/nodes', '查看']);
  if (models.updates) todo.push(['warn', 'download', `<b>${models.updates}</b> 个模型在 CivitAI 有新版本`, '#/models?usage=update', '查看']);
  if (git.dirty) todo.push(['', 'git', `ComfyUI 仓库有 ${git.dirty_count || ''} 个本地修改，更新核心前请先处理`, '#/core', '详情']);
  if (data.trash?.count) todo.push(['', 'trash', `回收站里有 <b>${data.trash.count}</b> 项 · ${fmtBytes(data.trash.size)}`, '#/trash', '清理']);
  const todoHtml = todo.length ? `<div class="stack" style="gap:6px">${todo.map(([cls, ic, text, href, label]) => `<div class="callout ${cls}">${icon(ic)}<div>${text}</div><a class="btn xs" href="${href}">${label}</a></div>`).join('')}</div>` : '';

  const recent = (gal.recent || []).slice(0, 10);
  const recentHtml = recent.length
    ? `<div class="cards" style="--cell:104px;gap:6px">${recent.map((img, i) => `<div class="thumb" style="aspect-ratio:3/4;border-radius:5px;cursor:pointer" data-action="overview-image" data-index="${i}"><div class="ph">${icon('image')}</div><img src="${esc(img.thumb)}" loading="lazy" alt="" onerror="this.remove()"></div>`).join('')}</div>`
    : `<div class="dim small" style="padding:18px 0">还没有生成过图片。启动 ComfyUI 出第一张图吧。</div>`;

  const types = (models.types || []).slice(0, 7);
  const maxSize = types.reduce((m, t) => Math.max(m, t.size || 0), 0) || 1;
  const disk = types.map((t) => `<div class="disk-row"><span class="name">${esc(typeLabel(t.type))} <span class="dim">${t.count}</span></span><div class="bar"><span style="width:${Math.max(1, t.size / maxSize * 100)}%"></span></div><span class="size">${fmtBytes(t.size)}</span></div>`).join('');

  const jobs = (data.jobs?.recent || []).slice(0, 5);
  const jobHtml = jobs.length ? `<div class="list">${jobs.map((job) => `<div class="list-row click" data-action="job-open" data-id="${esc(job.id)}"><div class="grow"><div class="t">${esc(job.title)}</div><div class="s">${esc(job.message || '')}</div></div>${statusBadge(job.status)}<span class="dim tiny">${timeAgo(job.finished || job.started || job.created)}</span></div>`).join('')}</div>` : '';

  return `${pageHead('总览', `${esc(data.paths?.comfy || '')}`, `<button class="btn" data-action="models-scan">${icon('rotate')} 扫描模型</button><button class="btn" data-action="core-check">${icon('refresh')} 检查更新</button>`)}
    <div class="stack">
      ${status}
      ${todoHtml}
      <div class="grid-main">
        <div class="stack">
          <div class="panel pad">
            <div class="panel-title"><h3>${icon('image')} 最近生成</h3><a class="small muted" href="#/gallery">全部 ${fmtNum(gal.total?.n || 0)} 张 →</a></div>
            ${recentHtml}
          </div>
          <div class="panel pad">
            <div class="panel-title"><h3>${icon('workflow')} 最近的工作流</h3><a class="small muted" href="#/workflows">全部 ${data.workflows?.total || 0} 个 →</a></div>
            ${(data.workflows?.recent || []).length ? `<div class="list">${data.workflows.recent.slice(0, 5).map((w) => `<div class="list-row click" data-action="open-workflow" data-id="${esc(w.id)}"><div class="grow"><div class="t">${esc(w.name)}</div><div class="s">${w.node_count} 个节点 · ${w.models.length} 个模型</div></div><span class="dim tiny">${timeAgo(w.mtime)}</span></div>`).join('')}</div>` : '<div class="dim small">还没有保存的工作流</div>'}
          </div>
          ${jobHtml ? `<div class="panel pad"><div class="panel-title"><h3>${icon('activity')} 最近任务</h3><button class="btn ghost xs" data-action="job-center">任务中心</button></div>${jobHtml}</div>` : ''}
        </div>
        <div class="stack">
          <div class="panel pad">
            <div class="panel-title"><h3>${icon('layers')} 模型</h3><a class="small muted" href="#/models">管理 →</a></div>
            <div class="row" style="gap:20px;margin-bottom:8px"><div><div style="font-size:20px;font-weight:650">${fmtNum(models.count || 0)}</div><div class="dim tiny">个文件</div></div><div><div style="font-size:20px;font-weight:650">${fmtBytes(models.size || 0)}</div><div class="dim tiny">占用</div></div><div><div style="font-size:20px;font-weight:650">${models.civitai_matched || 0}</div><div class="dim tiny">已匹配 CivitAI</div></div></div>
            ${disk || '<div class="dim small">还没有模型</div>'}
          </div>
          <div class="panel pad">
            <div class="panel-title"><h3>${icon('zap')} 快捷操作</h3></div>
            <div class="row wrap" style="gap:6px">
              <a class="btn sm" href="#/civitai">${icon('compass')} 浏览 CivitAI</a>
              <button class="btn sm" data-action="models-match-all">${icon('link')} 匹配 CivitAI</button>
              <button class="btn sm" data-action="open-folder" data-kind="output">${icon('folder')} output</button>
              <button class="btn sm" data-action="open-folder" data-kind="models">${icon('folder')} models</button>
              <button class="btn sm" data-action="open-folder" data-kind="workflows">${icon('folder')} workflows</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function openOverviewImage(index) {
  const items = state.overview?.gallery?.recent || [];
  if (!items[index]) return;
  openViewer(items, index);
}
