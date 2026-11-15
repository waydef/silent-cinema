'use strict';
// runs in <head> before anything is painted: the page stays blank until the server has said
// which screen is right, and a page that was showing the film starts black, so a reload never
// flashes the lobby or the setup screen
(function () {
  const root = document.documentElement;
  root.classList.add('boot');
  try { if (sessionStorage.getItem('wp.screen') === 'watch') root.classList.add('watching'); } catch { /* private mode */ }
  window.booted = function (screen) {
    root.classList.remove('boot');
    root.classList.toggle('watching', screen === 'watch');
    try { sessionStorage.setItem('wp.screen', screen); } catch { /* private mode */ }
  };
  // without an answer the default screen appears after a moment anyway
  window.bootTimer = setTimeout(() => { if (root.classList.contains('boot') && window.bootFallback) window.bootFallback(); }, 2500);
})();
