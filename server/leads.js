// Shared code for the lead pipeline (Cloudflare Pages Functions in /functions).
//
// Bindings and settings on the Pages project:
//   DB                  D1 database (the leads table is created automatically)
//   MAILER              service binding to the mavs-mailer Worker (sends the emails)
//   TURNSTILE_SITE_KEY  Turnstile site key (public)
//   TURNSTILE_SECRET    Turnstile secret key
//   REPORT_PASSWORD     password for /report
//   WC_WEBHOOK_KEY      secret added to the WhatConverts webhook URL (?key=...)

export const TZ = 'America/Chicago';

let ready = false;
export async function db(env) {
  if (!env.DB) return null;
  if (!ready) {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT, phone TEXT, email TEXT, message TEXT,
        page TEXT, form TEXT, landing_page TEXT, referrer TEXT,
        source TEXT, medium TEXT, campaign TEXT, gclid TEXT,
        duration INTEGER, recording TEXT,
        external_id TEXT UNIQUE,
        ip TEXT, user_agent TEXT, raw TEXT
      )`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at)'),
    ]);
    ready = true;
  }
  return env.DB;
}

const COLS = ['created_at', 'type', 'name', 'phone', 'email', 'message', 'page', 'form', 'landing_page', 'referrer',
  'source', 'medium', 'campaign', 'gclid', 'duration', 'recording', 'external_id', 'ip', 'user_agent', 'raw'];

// Insert a lead. With an external_id (WhatConverts), a repeat delivery updates the row instead.
// Returns { id, isNew }.
export async function saveLead(env, lead) {
  const d = await db(env);
  if (!d) throw new Error('DB binding missing');
  const row = { created_at: new Date().toISOString(), ...lead };
  const vals = COLS.map((c) => (row[c] === undefined || row[c] === '' ? null : row[c]));
  const sql = `INSERT INTO leads (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})` +
    (row.external_id
      ? ` ON CONFLICT(external_id) DO UPDATE SET ${COLS.filter((c) => c !== 'created_at' && c !== 'external_id')
        .map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(', ')}`
      : '') + ' RETURNING id, created_at';
  const existing = row.external_id
    ? await d.prepare('SELECT id FROM leads WHERE external_id = ?').bind(row.external_id).first()
    : null;
  const r = await d.prepare(sql).bind(...vals).first();
  return { id: r.id, isNew: !existing };
}

// Send a notification through the mailer Worker. Never throws; returns true when sent.
export async function notify(env, msg) {
  if (!env.MAILER) { console.error('notify: no MAILER binding on this deployment'); return false; }
  try {
    const r = await env.MAILER.fetch('https://mailer/send', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg),
    });
    if (!r.ok) console.error('notify: mailer answered', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error('notify failed', e);
    return false;
  }
}

export const LABEL = { form: 'Web form', call: 'Phone call', text: 'Text message' };
export const label = (t) => LABEL[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Lead');

export function leadEmail(lead, site) {
  const when = new Date().toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
  const rows = [
    ['Type', label(lead.type)],
    ['Name', lead.name], ['Phone', lead.phone], ['Email', lead.email],
    ['Message', lead.message],
    ['Call length', lead.duration ? `${Math.round(lead.duration / 6) / 10} min` : ''],
    ['Recording', lead.recording],
    ['Page', lead.page], ['Form', lead.form], ['Source', [lead.source, lead.medium].filter(Boolean).join(' / ')],
    ['Received', when],
  ].filter((r) => r[1]);
  const subject = `New ${label(lead.type).toLowerCase()} lead: ${lead.name || lead.phone || 'unknown'}`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nAll leads: ${site}/report`;
  const html = `<table style="font:15px/1.5 Arial,sans-serif;border-collapse:collapse">${rows.map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${
      k === 'Phone' ? `<a href="tel:${esc(String(v).replace(/[^0-9+]/g, ''))}">${esc(v)}</a>` : esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')
  }</table><p style="font:13px Arial,sans-serif"><a href="${site}/report">All leads</a></p>`;
  return { subject, text, html, replyTo: lead.email || undefined };
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const clean = (v, max = 500) => (v == null ? '' : String(v).replace(/\u0000/g, '').trim().slice(0, max));

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

// Where a web visitor came from: utm tags first, then ad click ids, then the referrer.
export function sourceOf({ utm_source, utm_medium, gclid, msclkid, fbclid, referrer }, siteHost) {
  if (utm_source) return { source: utm_source, medium: utm_medium || '' };
  if (gclid) return { source: 'google', medium: 'cpc' };
  if (msclkid) return { source: 'bing', medium: 'cpc' };
  if (fbclid) return { source: 'facebook', medium: 'social' };
  let host = '';
  try { host = new URL(referrer).hostname.replace(/^www\./, ''); } catch (e) {}
  if (!host || host === siteHost) return { source: 'direct', medium: '' };
  const engine = /(^|\.)(google|bing|yahoo|duckduckgo|ecosia|yandex|baidu)\./.exec(host);
  if (engine) return { source: engine[2], medium: 'organic' };
  if (/chatgpt|openai|perplexity|claude|gemini|copilot/.test(host)) return { source: host, medium: 'ai' };
  if (/facebook|instagram|nextdoor|x\.com|twitter|reddit|youtube|linkedin|tiktok/.test(host)) return { source: host, medium: 'social' };
  return { source: host, medium: 'referral' };
}

// First instant of a calendar month in Central time, as a UTC ISO string.
// Month starts are never inside a DST change: Apr 1 to Nov 1 are on CDT (UTC-5), the rest CST (UTC-6).
export function monthStart(y, m) {
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  const off = m >= 4 && m <= 11 ? 5 : 6;
  return new Date(Date.UTC(y, m - 1, 1, off)).toISOString();
}

export function currentMonth() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}
