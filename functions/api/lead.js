// /api/lead: the estimate forms post here.
// GET returns the public Turnstile site key so the page can load the spam check.
import { saveLead, notify, leadEmail, clean, json, sourceOf } from '../../server/leads.js';

export function onRequestGet({ env }) {
  // status: which settings this deployment can see (no secrets shown).
  return json({
    siteKey: env.TURNSTILE_SITE_KEY || '',
    status: { db: !!env.DB, mailer: !!env.MAILER, turnstile: !!env.TURNSTILE_SECRET, report: !!env.REPORT_PASSWORD },
  });
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return json({ ok: false, error: 'bad origin' }, 403);

  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: 'bad request' }, 400); }
  if (clean(b.company)) return json({ ok: true }); // honeypot field filled: a bot

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (env.TURNSTILE_SECRET) {
    const fd = new FormData();
    fd.append('secret', env.TURNSTILE_SECRET);
    fd.append('response', clean(b.token, 4096));
    if (ip) fd.append('remoteip', ip);
    let v = {};
    try {
      v = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd })).json();
    } catch (e) { console.error('turnstile', e); }
    if (!v.success) return json({ ok: false, error: 'spam check failed' }, 403);
  }

  const a = b.attribution || {};
  const lead = {
    type: 'form',
    name: clean(b.name, 120),
    phone: clean(b.phone, 40),
    email: clean(b.email, 200),
    message: clean(b.message, 4000),
    page: clean(b.page, 300),
    form: clean(b.form, 120),
    landing_page: clean(a.landing, 500),
    referrer: clean(a.referrer, 500),
    campaign: clean(a.utm_campaign, 200),
    gclid: clean(a.gclid, 200),
    ip,
    user_agent: clean(request.headers.get('User-Agent'), 300),
    ...sourceOf({
      utm_source: clean(a.utm_source, 100), utm_medium: clean(a.utm_medium, 100),
      gclid: a.gclid, msclkid: a.msclkid, fbclid: a.fbclid, referrer: clean(a.referrer, 500),
    }, url.hostname.replace(/^www\./, '')),
  };
  if (!lead.name || lead.phone.replace(/\D/g, '').length < 7) return json({ ok: false, error: 'name and phone required' }, 400);

  let saved = false;
  try { await saveLead(env, lead); saved = true; } catch (e) { console.error('saveLead', e); }
  const mailed = await notify(env, leadEmail(lead, url.origin));
  if (!saved && !mailed) return json({ ok: false, error: 'could not record lead' }, 500);
  return json({ ok: true, saved, mailed });
}
