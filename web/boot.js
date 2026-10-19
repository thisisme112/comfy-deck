/* ComfyDeck — boot, global events and polling */
'use strict';

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    state.settingsData = data;
    state.settings = data.settings || {};
    state.nsfw = !!state.settings.nsfw;
  } catch (err) {
    console.warn('无法读取设置:', err.message);
  }
}

function bindGlobalEvents() {
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    if (el.tagName === 'BUTTON' && el.disabled) return;
    if (el.tagName === 'A' && el.getAttribute('href') && !el.dataset.action) return;
    if (el.tagName === 'A' && el.hasAttribute('download')) return;
    event.preventDefault();
    handleAction(el.dataset.action, el, event);
  });

  window.addEventListener('hashchange', route);

  $('#btn-refresh')?.addEventListener('click', () => { refreshCurrent(); toast('已刷新'); });
  $('#btn-jobs')?.addEventListener('click', () => openJobCenter().catch((err) => toast(err.message, 'err')));
  $('#btn-theme')?.addEventListener('click', toggleTheme);
  $('#btn-palette')?.addEventListener('click', openPalette);
  $('#menu-toggle')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));

  document.addEventListener('click', (event) => {
    if (window.innerWidth <= 900 && event.target.closest('.nav-item')) $('#sidebar')?.classList.remove('open');
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      PALETTE.open ? closePalette() : openPalette();
      return;
    }
    if (event.key !== 'Escape') return;
    if (PALETTE.open) { closePalette(); return; }
    if (state.lightboxOverlay) { closeLightbox(); return; }
    if (state.modal) { closeModal(); return; }
    if (state.drawer) closeDrawer();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) $('#sidebar')?.classList.remove('open');
  });

  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if ((localStorage.getItem('cd-theme') || 'auto') === 'auto') applyTheme('auto');
  });
}

async function init() {
  hydrateIcons();
  applyTheme(localStorage.getItem('cd-theme') || 'auto');
  bindGlobalEvents();
  await loadSettings();
  route();
  pollJobs();
  pollComfy();
  setInterval(pollJobs, 5000);
  setInterval(() => { if (!document.hidden) pollComfy(); }, 4000);
}

init();
