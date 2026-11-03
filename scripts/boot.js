// Loads the interactive site on top of the prerendered HTML.
// The page already shows the full content without JavaScript; this brings back
// menus, mobile layout and forms by starting the normal design-tool runtime,
// then swaps the static copy out once the live one has rendered.
(function () {
  var hide = document.createElement('style');
  hide.textContent = 'x-dc{display:none!important}';
  document.head.appendChild(hide);

  fetch('/app.dc.html')
    .then(function (r) { return r.text(); })
    .then(function (text) {
      var doc = new DOMParser().parseFromString(text, 'text/html');
      var tpl = doc.querySelector('x-dc');
      var logic = doc.querySelector('script[data-dc-script]');
      if (!tpl || !logic) return;
      var pre = document.getElementById('prerendered');
      pre.after(document.importNode(tpl, true));
      var s = document.createElement('script');
      s.type = logic.type;
      s.setAttribute('data-dc-script', '');
      s.setAttribute('data-props', logic.getAttribute('data-props') || '');
      s.textContent = logic.textContent;
      document.body.appendChild(s);

      // Swap once the live page has rendered its heading.
      var obs = new MutationObserver(function () {
        var live = document.getElementById('dc-root');
        if (live && live.querySelector('h1')) {
          obs.disconnect();
          var y = window.scrollY;
          pre.remove();
          window.scrollTo(0, y);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      var rt = document.createElement('script');
      rt.src = '/support.js';
      document.body.appendChild(rt);
    })
    .catch(function (e) { console.error('[boot] live site failed to load; static page stays', e); });
})();
