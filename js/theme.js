/* ===== MPI Dashboard — Light / dark theme =====
 * Loaded in <head> so the saved theme is applied before the page paints.
 * Choice is remembered in localStorage; with no saved choice, follows the OS setting.
 * Fires a "themechange" event on window so charts can redraw with the new colours.
 */
(function(){
  const KEY = 'mdm_theme';
  const root = document.documentElement;

  function saved(){ try { return localStorage.getItem(KEY); } catch(e){ return null; } }
  function systemDark(){ return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
  function current(){ return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }

  function apply(theme){
    root.setAttribute('data-theme', theme);
    updateButton();
    window.dispatchEvent(new CustomEvent('themechange', {detail: theme}));
  }

  function updateButton(){
    const btn = document.getElementById('themeToggle');
    if(!btn) return;
    const dark = current() === 'dark';
    btn.innerHTML = dark ? '&#9728;&#65039; Light mode' : '&#127769; Dark mode';
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-pressed', String(dark));
  }

  window.toggleTheme = function(){
    const next = current() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch(e){}
    apply(next);
  };

  // Read a theme colour token, e.g. themeColor('--chart-grid')
  window.themeColor = function(name){
    return getComputedStyle(root).getPropertyValue(name).trim();
  };

  // Initial theme (before paint)
  root.setAttribute('data-theme', saved() || (systemDark() ? 'dark' : 'light'));

  // Follow OS changes only while the user hasn't picked a theme
  if(window.matchMedia){
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = e => { if(!saved()) apply(e.matches ? 'dark' : 'light'); };
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
  }

  // Insert the toggle button into the top bar, just before Refresh
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('.topbar');
    if(!bar || document.getElementById('themeToggle')) return;
    const btn = document.createElement('button');
    btn.id = 'themeToggle';
    btn.className = 'theme-toggle';
    btn.type = 'button';
    btn.onclick = window.toggleTheme;
    bar.insertBefore(btn, bar.querySelector('.refresh-btn'));
    updateButton();
  });
})();
