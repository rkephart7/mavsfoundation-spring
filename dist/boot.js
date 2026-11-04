// Loads the interactive site on top of the prerendered HTML.
// The page already shows the full content without JavaScript; this brings back
// menus, mobile layout and forms by starting the normal design-tool runtime,
// then swaps the static copy out once the live one has rendered.
(function () {
  var slug = function (t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-'); };
  function scrollToHash() {
    var want = decodeURIComponent(location.hash.slice(1));
    var el = document.getElementById(want);
    if (!el) {
      var all = document.querySelectorAll('main[data-page-main] [data-screen-label]');
      for (var i = 0; i < all.length && !el; i++) if (slug(all[i].getAttribute('data-screen-label')) === want) el = all[i];
    }
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + 2 });
  }
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
          // Land on the section named in the URL (#services, #why-choose, ...),
          // after the page's own initial scroll-to-top has run.
          if (location.hash.length > 1) setTimeout(scrollToHash, 60);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      var rt = document.createElement('script');
      rt.src = '/support.js';
      document.body.appendChild(rt);
    })
    .catch(function (e) { console.error('[boot] live site failed to load; static page stays', e); });
})();
