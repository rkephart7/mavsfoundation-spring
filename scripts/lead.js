// Sends the estimate forms to /api/lead (Pages Function) with a Turnstile spam check.
// The template's submit handler calls window.mavsLead(form) (wired in by scripts/build.mjs)
// and only shows "Received" once the lead is stored.
(function () {
  var PHONE = '(281) 607-0228';
  function get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  // First page of the visit, its referrer and ad/utm tags: how the visitor found the site.
  var attribution = null;
  try { attribution = JSON.parse(get('mavs-attr') || 'null'); } catch (e) {}
  if (!attribution) {
    var q = new URLSearchParams(location.search);
    attribution = { landing: location.href.split('#')[0], referrer: document.referrer || '' };
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'msclkid', 'fbclid'].forEach(function (k) {
      if (q.get(k)) attribution[k] = q.get(k);
    });
    put('mavs-attr', JSON.stringify(attribution));
  }

  // Turnstile: loaded the first time someone touches a form, so it costs nothing on page load.
  var siteKey = null, widget = null, token = '', waiters = [], started = false;
  function gotToken(t) { token = t || ''; var w = waiters; waiters = []; w.forEach(function (f) { f(); }); }
  function startTurnstile() {
    if (started) return;
    started = true;
    fetch('/api/lead', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (c) {
      siteKey = c.siteKey || '';
      if (!siteKey) return gotToken('');
      window.mavsTurnstileReady = function () {
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;right:12px;bottom:84px;z-index:2147483000';
        document.body.appendChild(box);
        widget = window.turnstile.render(box, {
          sitekey: siteKey, appearance: 'interaction-only', 'refresh-expired': 'auto',
          callback: gotToken, 'expired-callback': function () { token = ''; }, 'error-callback': function () { gotToken(''); },
        });
      };
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=mavsTurnstileReady';
      s.async = true;
      s.onerror = function () { gotToken(''); };
      document.head.appendChild(s);
    }).catch(function () { siteKey = ''; gotToken(''); });
  }
  document.addEventListener('focusin', function (e) { if (e.target.closest && e.target.closest('form')) startTurnstile(); });

  function waitToken(ms) {
    return new Promise(function (resolve) {
      if (token || siteKey === '') return resolve();
      var t = setTimeout(resolve, ms);
      waiters.push(function () { clearTimeout(t); resolve(); });
    });
  }

  var busy = false;
  window.mavsLead = function (form) {
    if (busy) return Promise.resolve(false);
    busy = true;
    var val = function (sel) { var el = form.querySelector(sel); return el ? el.value.trim() : ''; };
    var btn = form.querySelector('button[type="submit"]');
    var oldText = btn && btn.firstChild && btn.firstChild.nodeType === 3 ? btn.firstChild.nodeValue : null;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; if (oldText != null) btn.firstChild.nodeValue = 'Sending… '; }
    startTurnstile();
    var data = {
      name: val('input[autocomplete="name"]'),
      phone: val('input[type="tel"]'),
      email: val('input[type="email"]'),
      message: val('textarea'),
      page: location.href.split('#')[0],
      attribution: attribution,
    };
    return waitToken(15000).then(function () {
      data.token = token;
      return fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return r.ok && j.ok; }); })
      .catch(function () { return false; })
      .then(function (ok) {
        busy = false;
        token = '';
        if (widget != null && window.turnstile) { try { window.turnstile.reset(widget); } catch (e) {} }
        if (btn) { btn.disabled = false; btn.style.opacity = ''; if (oldText != null) btn.firstChild.nodeValue = oldText; }
        if (ok) {
          try { if (window.gtag) window.gtag('event', 'generate_lead'); } catch (e) {}
        } else {
          alert('Sorry, your request did not go through. Please call or text us at ' + PHONE + '.');
        }
        return ok;
      });
  };
})();
