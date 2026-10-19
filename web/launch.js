/* ComfyDeck — launcher: start/stop ComfyUI, profiles and live log */
'use strict';

ROUTES.launch = { title: '启动台', render: renderLaunch, flush: false };

const LAUNCH = {
  profiles: [], last: 'default', selected: 'default',
  file: '', offset: -1, follow: true, lineEl: null, curText: '', logs: [],
};

const LAUNCH_FLAGS = [
  ['--enable-manager', 'ComfyUI-Manager'],
  ['--lowvram', '低显存'], ['--novram', '极低显存'], ['--highvram', '高显存'], ['--gpu-only', '全部放显存'], ['--cpu', 'CPU'],
  ['--fast fp16_accumulation', 'fp16 累加'], ['--disable-smart-memory', '关闭智能显存'],
  ['--reserve-vram 1', '预留 1GB 显存'], ['--cache-none', '不缓存节点'],
  ['--use-sage-attention', 'SageAttention'], ['--use-flash-attention', 'FlashAttention'], ['--use-pytorch-cross-attention', 'PyTorch 注意力'], ['--disable-xformers', '关闭 xformers'],
  ['--preview-method auto', '实时预览'], ['--listen', '允许局域网访问'], ['--disable-all-custom-nodes', '禁用全部插件'],
];

async function renderLaunch() {
  $('#view').innerHTML = `<div class="page">
    ${pageHead('启动台', '启动、停止、重启 ComfyUI，查看实时日志。方案相当于一份可切换的启动参数。', `<button class="btn" data-action="open-folder" data-kind="logs">${icon('folder')} 日志目录</button>`)}
    <div class="launch-layout">
      <div class="launch-left">
        <div id="launch-notice"></div>
        <div class="panel pad" id="launch-status"></div>
        <div class="panel pad hidden" id="launch-ops"></div>
        <div class="panel" id="launch-profiles"></div>
      </div>
      <div class="console-wrap">
        <div class="console-bar">
          <select class="select" id="log-file" style="max-width:230px" title="历史日志"></select>
          <label class="switch" title="新日志到达时自动滚动到底部"><input type="checkbox" id="log-follow" ${LAUNCH.follow ? 'checked' : ''}><span class="track"></span><span class="label">跟随</span></label>
          <span class="grow"></span>
          <button class="btn xs ghost" id="log-clear">${icon('broom')} 清屏</button>
          <button class="btn xs ghost" id="log-copy">${icon('copy')} 复制</button>
        </div>
        <div class="console" id="console"></div>
      </div>
    </div>
  </div>`;
  LAUNCH.lineEl = null; LAUNCH.curText = ''; LAUNCH.offset = -1; LAUNCH.file = '';
  $('#log-follow').addEventListener('change', (e) => { LAUNCH.follow = e.target.checked; if (LAUNCH.follow) scrollConsole(); });
  $('#log-clear').addEventListener('click', () => { $('#console').innerHTML = ''; LAUNCH.lineEl = null; LAUNCH.curText = ''; });
  $('#log-copy').addEventListener('click', () => copyText($('#console').innerText));
  $('#log-file').addEventListener('change', (e) => {
    LAUNCH.file = e.target.value; LAUNCH.offset = -1;
    $('#console').innerHTML = ''; LAUNCH.lineEl = null; LAUNCH.curText = '';
    clearTimeout(state.timers.logPoll); pollLog();
  });
  $('#console').addEventListener('wheel', () => { /* user scroll decides follow below */ }, { passive: true });
  $('#console').addEventListener('scroll', () => {
    const box = $('#console');
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    if (!atEnd && LAUNCH.follow) { LAUNCH.follow = false; const f = $('#log-follow'); if (f) f.checked = false; }
  });
  await Promise.all([loadProfiles(), refreshLaunchStatus(), loadLogList()]);
  pollLog();
  const tick = async () => {
    if (state.route !== 'launch') return;
    await refreshLaunchStatus();
    state.timers.launchStatus = setTimeout(tick, 2000);
  };
  state.timers.launchStatus = setTimeout(tick, 2000);
}

async function loadProfiles() {
  const data = await api('/api/launcher/profiles');
  LAUNCH.profiles = data.profiles || [];
  LAUNCH.last = data.last;
  if (!LAUNCH.profiles.find((p) => p.id === LAUNCH.selected)) LAUNCH.selected = data.last || LAUNCH.profiles[0]?.id;
  if (!LAUNCH.profiles.find((p) => p.id === LAUNCH.selected)) LAUNCH.selected = LAUNCH.profiles[0]?.id;
  renderProfiles();
}

async function loadLogList() {
  try {
    const data = await api('/api/launcher/logs');
    LAUNCH.logs = data.items || [];
    const sel = $('#log-file');
    if (sel) {
      sel.innerHTML = `<option value="">当前 / 最近一次</option>${LAUNCH.logs.map((l) => `<option value="${esc(l.name)}" ${LAUNCH.file === l.name ? 'selected' : ''}>${esc(l.name.replace(/^run-|\.log$/g, ''))} · ${fmtBytes(l.size)}</option>`).join('')}`;
    }
  } catch (e) { /* noop */ }
}

async function refreshLaunchStatus() {
  try {
    const st = await api('/api/comfy/status');
    setComfyStatus(st);
    renderLaunchStatus(st);
  } catch (e) { /* noop */ }
}

function selectedProfile() {
  return LAUNCH.profiles.find((p) => p.id === LAUNCH.selected) || LAUNCH.profiles[0];
}

function renderLaunchStatus(st) {
  const box = $('#launch-status');
  if (!box) return;
  const prof = selectedProfile();
  const dotCls = st.state === 'running' ? 'ok' : st.state === 'starting' ? 'warn' : (st.last_exit?.crashed ? 'err' : '');
  const rows = [];
  if (st.state !== 'stopped') {
    rows.push(['方案', st.managed ? esc(st.profile_name || '—') : '外部启动']);
    rows.push(['进程 / 端口', `<span class="mono">${st.pid || '—'}</span> / <span class="mono">${st.port}</span>`]);
    if (st.managed) rows.push(['已运行', fmtDuration(st.uptime)]);
    if (st.external_name) rows.push(['进程名', esc(st.external_name)]);
  } else {
    rows.push(['将使用', esc(prof?.name || '—')]);
    rows.push(['参数', `<span class="mono tiny break">${esc(prof?.args || '（无）')}</span>`]);
  }
  let buttons;
  if (st.state === 'stopped') {
    buttons = `<button class="btn primary block" data-action="comfy-start" data-profile="${esc(LAUNCH.selected)}">${icon('play')} 启动</button>`;
  } else if (st.state === 'starting') {
    buttons = `<button class="btn danger block" data-action="comfy-stop">${icon('stop')} 取消启动</button>`;
  } else {
    buttons = `<div class="row" style="gap:6px"><button class="btn primary grow" data-action="core-open">${icon('external')} 打开</button><button class="btn" data-action="comfy-restart" data-profile="${esc(LAUNCH.selected)}" title="用选中的方案重启">${icon('refresh')} 重启</button><button class="btn danger" data-action="comfy-stop">${icon('stop')} 停止</button></div>`;
  }
  box.innerHTML = `<div class="state-line"><span class="dot ${dotCls}"></span><span class="big">${fmtState(st)}</span></div>
    <div class="kv mt-12">${rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>
    <div class="mt-16">${buttons}</div>`;

  const notice = $('#launch-notice');
  if (notice) {
    notice.innerHTML = st.last_exit?.crashed && st.state === 'stopped'
      ? `<div class="callout err">${icon('alert')}<div><b>ComfyUI 异常退出</b>（退出码 ${esc(st.last_exit.code)}）。原因通常在右侧日志末尾。</div></div>`
      : (st.external ? `<div class="callout">${icon('info')}<div>这个实例不是由 ComfyDeck 启动的，日志取自 <span class="mono">user/comfyui.log</span>。仍可停止或重启。</div></div>` : '');
  }

  const ops = $('#launch-ops');
  if (ops) {
    ops.classList.toggle('hidden', st.state !== 'running');
    if (st.state === 'running') {
      const q = st.queue || {};
      ops.innerHTML = `<div class="panel-title"><h3>${icon('gauge')} 运行中操作</h3><span class="hint">队列 ${q.running || 0} 运行 · ${q.pending || 0} 等待</span></div>
        <div class="row wrap" style="gap:6px">
          <button class="btn sm" data-action="comfy-free" title="卸载所有模型并释放显存">${icon('broom')} 释放显存</button>
          <button class="btn sm" data-action="comfy-interrupt">${icon('stop')} 中断当前任务</button>
          <button class="btn sm" data-action="comfy-clear-queue">${icon('trash')} 清空队列</button>
        </div>`;
    }
  }
}

function renderProfiles() {
  const box = $('#launch-profiles');
  if (!box) return;
  box.innerHTML = `<div class="panel-title" style="padding:12px 14px 0;margin:0 0 8px"><h3>${icon('sliders')} 启动方案</h3><button class="btn xs" data-action="profile-edit" data-id="">${icon('plus')} 新建</button></div>
    ${LAUNCH.profiles.map((p) => `<div class="profile ${p.id === LAUNCH.selected ? 'sel' : ''}" data-action="profile-select" data-id="${esc(p.id)}">
      <span class="radio"></span>
      <div class="grow"><div class="t" style="font-weight:600;font-size:12.8px">${esc(p.name)}</div><div class="args" title="${esc(p.args)}">${esc(p.args || '（无额外参数）')}</div></div>
      <button class="icon-btn" data-action="profile-edit" data-id="${esc(p.id)}" title="编辑">${icon('edit')}</button>
    </div>`).join('')}`;
  const st = state.comfy;
  if (st) renderLaunchStatus(st);
}

function profileEditor(profile) {
  const p = profile || { id: '', name: '', args: '', env: '', open_browser: true, use_proxy: false };
  return showConfirm({
    title: p.id ? '编辑启动方案' : '新建启动方案',
    confirmText: '保存',
    wide: false,
    body: '',
    extraHtml: `<div class="stack" style="gap:12px">
      <div class="field"><label>名称</label><input class="input" data-confirm-field="name" value="${esc(p.name)}" placeholder="例如：低显存 + 实时预览"></div>
      <div class="field"><label>启动参数</label><input class="input mono-in" id="prof-args" data-confirm-field="args" value="${esc(p.args)}" placeholder="--lowvram --preview-method auto">
        <span class="help">不用写 python 与 main.py；已自动带上 <span class="mono">--windows-standalone-build</span> 与 <span class="mono">--disable-auto-launch</span>。点击下方标签可开关常用参数。</span></div>
      <div class="chips flag-chips" id="prof-flags">${LAUNCH_FLAGS.map(([flag, label]) => `<button type="button" class="chip" data-flag="${esc(flag)}" title="${esc(flag)}">${esc(label)}</button>`).join('')}</div>
      <div class="field"><label>环境变量 <span class="dim">（每行 KEY=VALUE，可选）</span></label><textarea class="textarea mono-in" data-confirm-field="env" rows="2" placeholder="CUDA_VISIBLE_DEVICES=0">${esc(p.env)}</textarea></div>
      <label class="check-row"><input type="checkbox" data-confirm-field="open_browser" ${p.open_browser !== false ? 'checked' : ''}> 就绪后自动打开浏览器</label>
      <label class="check-row"><input type="checkbox" data-confirm-field="use_proxy" ${p.use_proxy ? 'checked' : ''}> 把设置里的代理传给 ComfyUI（HTTP_PROXY / HTTPS_PROXY）</label>
      ${p.id ? `<div><button class="btn sm danger" data-action="profile-delete" data-id="${esc(p.id)}">${icon('trash')} 删除这个方案</button></div>` : ''}
    </div>`,
    onOpen: (overlay) => {
      const input = overlay.querySelector('#prof-args');
      const sync = () => overlay.querySelectorAll('[data-flag]').forEach((chip) => {
        chip.classList.toggle('on', flagPresent(input.value, chip.dataset.flag));
      });
      overlay.querySelector('#prof-flags').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-flag]');
        if (!chip) return;
        input.value = toggleFlag(input.value, chip.dataset.flag);
        sync();
      });
      input.addEventListener('input', sync);
      sync();
    },
  }).then((res) => (res.ok ? { ...res, id: p.id } : null));
}

function flagPresent(text, flag) {
  const re = new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
  return re.test(text);
}

function toggleFlag(text, flag) {
  if (flagPresent(text, flag)) {
    const re = new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
    return text.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }
  return `${text.trim()} ${flag}`.trim();
}

async function editProfile(id) {
  const profile = LAUNCH.profiles.find((p) => p.id === id);
  const res = await profileEditor(profile);
  if (!res) return;
  const out = await post('/api/launcher/profiles', {
    id: res.id, name: res.name, args: res.args, env: res.env, open_browser: res.open_browser, use_proxy: res.use_proxy,
  });
  LAUNCH.selected = out.profile.id;
  await loadProfiles();
  toast('方案已保存');
}

async function deleteProfile(id) {
  const p = LAUNCH.profiles.find((x) => x.id === id);
  closeModal();
  const res = await showConfirm({ title: '删除方案', body: `确定删除启动方案 <b>${esc(p?.name || id)}</b> 吗？`, confirmText: '删除', danger: true });
  if (!res.ok) return;
  await post('/api/launcher/profiles/delete', { id });
  await loadProfiles();
  toast('方案已删除');
}

/* ------------------------------------------------------------------ log */
function lineClass(text) {
  if (/traceback|exception|error|failed|out of memory|cannot|can't/i.test(text) && !/^\s*$/.test(text)) return 'err';
  if (/warn/i.test(text)) return 'warn';
  if (/got prompt|prompt executed|to see the gui|starting server|import times/i.test(text)) return 'ok';
  if (text.startsWith('#')) return 'dim';
  return '';
}

function scrollConsole() {
  const box = $('#console');
  if (box) box.scrollTop = box.scrollHeight;
}

function appendLog(text) {
  const box = $('#console');
  if (!box || !text) return;
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i += 1) {
    const last = i === parts.length - 1;
    let full = parts[i];
    if (LAUNCH.lineEl) full = LAUNCH.curText + full;
    if (!LAUNCH.lineEl && last && full === '') break;
    const shown = full.split('\r').reverse().find((s) => s !== '') ?? '';
    if (!LAUNCH.lineEl) {
      LAUNCH.lineEl = document.createElement('span');
      box.appendChild(LAUNCH.lineEl);
    }
    LAUNCH.curText = full;
    LAUNCH.lineEl.textContent = shown;
    LAUNCH.lineEl.className = `ln ${lineClass(shown)}`;
    if (!last) { LAUNCH.lineEl = null; LAUNCH.curText = ''; }
  }
  while (box.childElementCount > 5000) box.firstElementChild.remove();
  if (LAUNCH.follow) scrollConsole();
}

async function pollLog() {
  if (state.route !== 'launch') return;
  let delay = 1000;
  try {
    const data = await api(`/api/launcher/log?offset=${LAUNCH.offset}&file=${encodeURIComponent(LAUNCH.file)}`);
    if (state.route !== 'launch') return;
    const cur = data.file || '';
    if (data.reset || (LAUNCH.lastServed && LAUNCH.lastServed !== cur)) {
      const box = $('#console');
      if (box) box.innerHTML = '';
      LAUNCH.lineEl = null; LAUNCH.curText = '';
      if (LAUNCH.lastServed && LAUNCH.lastServed !== cur) loadLogList();
    }
    LAUNCH.lastServed = cur;
    LAUNCH.offset = data.offset;
    appendLog(data.text);
    const st = state.comfy;
    delay = st && st.state !== 'stopped' ? 900 : 2500;
    if (!data.file && !$('#console').childElementCount) {
      $('#console').innerHTML = `<span class="ln dim"># 还没有日志。点击左侧“启动”开始。</span>`;
    }
  } catch (e) { delay = 3000; }
  state.timers.logPoll = setTimeout(pollLog, delay);
}

/* --------------------------------------------------------------- actions */
async function comfyStart(profileId) {
  await startComfy(profileId || LAUNCH.selected || undefined);
  if (state.route === 'launch') {
    LAUNCH.offset = -1; LAUNCH.file = ''; $('#log-file').value = '';
    $('#console').innerHTML = ''; LAUNCH.lineEl = null; LAUNCH.curText = ''; LAUNCH.lastServed = '';
    LAUNCH.follow = true; const f = $('#log-follow'); if (f) f.checked = true;
    loadLogList();
    clearTimeout(state.timers.logPoll); pollLog();
    refreshLaunchStatus();
  } else if (state.route === 'overview') {
    renderOverview();
  }
}

async function comfyStop() {
  const st = state.comfy;
  if (st?.queue && (st.queue.running || st.queue.pending)) {
    const res = await showConfirm({ title: '停止 ComfyUI', body: `队列里还有 <b>${st.queue.running}</b> 个运行中、<b>${st.queue.pending}</b> 个等待的任务，停止后会丢失。确定停止吗？`, confirmText: '停止', danger: true });
    if (!res.ok) return;
  }
  setComfyStatus(await post('/api/launcher/stop'));
  toast('ComfyUI 已停止');
  if (state.route === 'launch') refreshLaunchStatus();
  if (state.route === 'overview') renderOverview();
}

async function comfyRestart(profileId) {
  const st = state.comfy;
  if (st?.queue && (st.queue.running || st.queue.pending)) {
    const res = await showConfirm({ title: '重启 ComfyUI', body: `队列里还有未完成的任务，重启后会丢失。确定重启吗？`, confirmText: '重启', danger: true });
    if (!res.ok) return;
  }
  toast('正在重启 ComfyUI…');
  setComfyStatus(await post('/api/launcher/restart', profileId ? { profile_id: profileId } : {}));
  if (state.route === 'launch') {
    LAUNCH.offset = -1; LAUNCH.file = ''; $('#console').innerHTML = ''; LAUNCH.lineEl = null; LAUNCH.curText = '';
    clearTimeout(state.timers.logPoll); pollLog(); refreshLaunchStatus(); loadLogList();
  }
  if (state.route === 'overview') renderOverview();
}

async function comfyOp(kind) {
  const map = { free: ['/api/comfy/free', '已请求释放显存'], interrupt: ['/api/comfy/interrupt', '已中断当前任务'], 'clear-queue': ['/api/comfy/clear-queue', '队列已清空'] };
  const [url, msg] = map[kind];
  await post(url);
  toast(msg);
  setTimeout(pollComfy, 600);
}
