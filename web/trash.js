/* ComfyDeck — recycle bin */
'use strict';

ROUTES.trash = { title: '回收站', render: renderTrash };

const TRASH_KINDS = { model: '模型', node: '插件', workflow: '工作流', image: '图片' };
let trashKind = '';

async function renderTrash() {
  $('#view').innerHTML = `<div class="page">${loadingHtml()}</div>`;
  try {
    const data = await api('/api/trash');
    if (state.route !== 'trash') return;
    state.trash = data;
    const nav = $('#nav-trash');
    if (nav) nav.textContent = data.summary.count ? String(data.summary.count) : '';
    $('#view').innerHTML = trashHtml(data);
  } catch (err) {
    if (state.route === 'trash') $('#view').innerHTML = `<div class="page">${errorHtml(err.message)}</div>`;
  }
}

function trashHtml(data) {
  const all = data.items || [];
  const items = trashKind ? all.filter((i) => i.kind === trashKind) : all;
  const counts = {};
  all.forEach((i) => { counts[i.kind] = (counts[i.kind] || 0) + 1; });
  const rows = items.map((i) => `<tr>
    <td><div class="node-name">${esc(i.name)}</div><div class="sub mono break">${esc(i.original)}</div></td>
    <td><span class="badge">${esc(TRASH_KINDS[i.kind] || i.kind)}</span></td>
    <td class="mono">${fmtBytes(i.size)}</td>
    <td class="dim">${timeAgo(i.time)}</td>
    <td><div class="row-actions"><button class="btn xs" data-action="trash-restore" data-id="${esc(i.id)}">${icon('undo')} 恢复</button><button class="btn xs danger" data-action="trash-purge" data-id="${esc(i.id)}" data-name="${esc(i.name)}">永久删除</button></div></td>
  </tr>`).join('');
  return `<div class="page">
    ${pageHead('回收站', `${all.length} 项 · 占用 ${fmtBytes(data.summary.size)} · 通过 ComfyDeck 删除的模型、插件、工作流和图片都会先放在这里`, `
      <button class="btn" data-action="open-folder" data-kind="trash">${icon('folder')} 打开文件夹</button>
      <button class="btn danger" data-action="trash-empty" ${all.length ? '' : 'disabled'}>${icon('trash')} 清空</button>`)}
    <div class="tabs">
      <button class="${trashKind === '' ? 'active' : ''}" data-action="trash-filter" data-kind="">全部 ${all.length}</button>
      ${Object.entries(TRASH_KINDS).map(([k, label]) => `<button class="${trashKind === k ? 'active' : ''}" data-action="trash-filter" data-kind="${k}">${label} ${counts[k] || 0}</button>`).join('')}
    </div>
    ${items.length ? `<div class="table-wrap"><table><thead><tr><th>名称 / 原位置</th><th>类型</th><th>大小</th><th>删除时间</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyHtml('回收站是空的。', 'trash')}
  </div>`;
}

async function trashRestore(id) {
  const out = await post('/api/trash/restore', { id });
  toast(`已恢复到 ${out.path}`);
  renderTrash();
}

async function trashPurge(id, name) {
  const res = await showConfirm({ title: '永久删除', body: `永久删除 <b>${esc(name)}</b>？这个操作无法撤销。`, confirmText: '永久删除', danger: true });
  if (!res.ok) return;
  await post('/api/trash/purge', { id });
  toast('已永久删除');
  renderTrash();
}

async function trashEmpty() {
  const label = trashKind ? TRASH_KINDS[trashKind] : '全部';
  const res = await showConfirm({ title: '清空回收站', body: `永久删除回收站里的 <b>${label}</b> 项目？这个操作无法撤销。`, confirmText: '清空', danger: true });
  if (!res.ok) return;
  const out = await post('/api/trash/purge', { all: true, kind: trashKind });
  toast(`已永久删除 ${out.purged} 项`);
  renderTrash();
}
