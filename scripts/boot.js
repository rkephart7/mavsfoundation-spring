// Loads the interactive site on top of the prerendered HTML.
// The page already shows the full content without JavaScript; this brings back
// menus, mobile layout and forms by starting the normal design-tool runtime,
// then swaps the static copy out once the live one has rendered.
(function () {
  var slug = function (t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-'); };
  function jumpTo(want, instant) {
    var el = document.getElementById(want);
    if (!el) {
      var all = document.querySelectorAll('main[data-page-main] [data-screen-label]');
      for (var i = 0; i < all.length && !el; i++) if (slug(all[i].getAttribute('data-screen-label')) === want) el = all[i];
    }
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + 2, behavior: instant ? 'auto' : 'smooth' });
  }
  function store(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }

  // Section to land on after this page loads: set by a menu click on another page.
  // Old-style "#section" URLs still work but the "#..." is removed from the address bar.
  var pending = load('dc-jump');
  store('dc-jump', null);
  if (!pending && location.hash.length > 1) {
    pending = decodeURIComponent(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
  }

  // Keep "#" out of the address bar for in-page links (e.g. "Request an estimate").
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var href = a.getAttribute('href');
    var section = a.getAttribute('data-section');
    if (href.charAt(0) === '#' && href.length > 1) { e.preventDefault(); jumpTo(href.slice(1)); return; }
    if (section) {
      if (a.pathname === location.pathname) { e.preventDefault(); jumpTo(section); }
      else store('dc-jump', section);
    }
  }, true);

  var hide = document.createElement('style');
  hide.textContent = 'x-dc{display:none!important}';
  document.head.appendChild(hide);

  // Start the live site after the page (and its first photos) have loaded, so the
  // runtime download does not compete with what the visitor sees first.
  function start() {
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
          var tm = document.getElementById('prerendered-mobile');
          if (tm) tm.remove();
          window.scrollTo(0, y);
          // Land on the requested section, after the page's own initial scroll-to-top.
          if (pending) setTimeout(function () { jumpTo(pending, true); }, 60);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      var rt = document.createElement('script');
      rt.src = '/support.js';
      document.body.appendChild(rt);
    })
    .catch(function (e) { console.error('[boot] live site failed to load; static page stays', e); });
  }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
