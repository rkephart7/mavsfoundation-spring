// /report?month=YYYY-MM[&format=csv|json]: monthly lead report, behind REPORT_PASSWORD
// (browser login box; any username).
import { db, esc, label, monthStart, currentMonth, TZ, sendMail, recipientsOf, leadEmail } from '../server/leads.js';
import { CSV_COLS, toCsv, tally } from '../server/monthly.js';

const H = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

function authorized(request, env) {
  const m = /^Basic\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m) return false;
  let pass = '';
  try { pass = atob(m[1]).split(':').slice(1).join(':'); } catch (e) { return false; }
  const want = env.REPORT_PASSWORD;
  if (pass.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= pass.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const local = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const path = (r) => { try { return new URL(r.page || r.landing_page).pathname; } catch (e) { return r.page || ''; } };


export async function onRequestGet({ request, env }) {
  if (!env.REPORT_PASSWORD) return new Response('Set REPORT_PASSWORD on the Pages project to turn on the report.', { status: 503, headers: H });
  if (!authorized(request, env)) {
    return new Response('Login required', { status: 401, headers: { ...H, 'WWW-Authenticate': 'Basic realm="Lead report", charset="UTF-8"' } });
  }
  const url = new URL(request.url);
  // /report?test=email sends a test lead email and shows the mailer's answer, so a delivery
  // problem (no recipient set, address not verified, ...) can be read without the logs.
  if (url.searchParams.get('test') === 'email') {
    const out = { mailer: env.MAILER ? 'binding' : 'url', recipients: recipientsOf(env).length };
    if (!out.recipients) return Response.json({ ...out, error: 'MAIL_TO is not set on the Pages project (Settings > Variables and Secrets)' }, { headers: H });
    try {
      const r = await sendMail(env, leadEmail({ type: 'form', name: 'Test lead', phone: '(281) 555-0100', message: 'Test from /report?test=email' }, url.origin));
      out.status = r.status;
      try { out.answer = await r.json(); } catch (e) { out.answer = null; }
    } catch (e) { out.error = String((e && e.message) || e); }
    return Response.json(out, { headers: H });
  }
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : currentMonth();
  const [y, m] = month.split('-').map(Number);
  const format = url.searchParams.get('format');

  const d = await db(env);
  if (!d) return new Response('DB binding missing on the Pages project.', { status: 503, headers: H });
  const { results: rows } = await d.prepare(
    `SELECT ${CSV_COLS.join(', ')} FROM leads WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC`,
  ).bind(monthStart(y, m), monthStart(y, m + 1)).all();

  if (format === 'json') return Response.json({ month, count: rows.length, rows }, { headers: H });
  if (format === 'csv') {
    return new Response(toCsv(rows), { headers: { ...H, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="leads-${month}.csv"` } });
  }

  const mm = (k) => { let yy = y, mo = m + k; if (mo < 1) { mo += 12; yy--; } if (mo > 12) { mo -= 12; yy++; } return `${yy}-${String(mo).padStart(2, '0')}`; };
  const title = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const box = (h, list) => `<div class="box"><h2>${h}</h2><table>${list.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="n">${n}</td></tr>`).join('') || '<tr><td>None</td></tr>'}</table></div>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Leads ${esc(title)}</title>
<style>
body{font:15px/1.45 system-ui,Arial,sans-serif;margin:0;padding:20px 16px;color:#1d2f52;background:#faf7f0}
h1{margin:0 0 4px;font-size:26px} h2{font-size:15px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em}
a{color:#c2332b} .nav{margin:0 0 18px;display:flex;gap:16px;flex-wrap:wrap}
.big{font-size:44px;font-weight:800;margin:6px 0 16px} .grid{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.box{background:#fff;border:1px solid #ddd;padding:12px 14px;min-width:200px;flex:1}
table{border-collapse:collapse;width:100%} td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
.n{text-align:right;font-weight:700} .list{background:#fff;border:1px solid #ddd;overflow-x:auto} .list td{white-space:nowrap} .list td.msg{white-space:normal;min-width:220px}
</style></head><body>
<h1>Leads: ${esc(title)}</h1>
<div class="nav"><a href="?month=${mm(-1)}">&larr; ${mm(-1)}</a><a href="?month=${mm(1)}">${mm(1)} &rarr;</a><a href="?month=${month}&amp;format=csv">Download CSV</a></div>
<div class="big">${rows.length} lead${rows.length === 1 ? '' : 's'}</div>
<div class="grid">${box('By type', tally(rows, (r) => label(r.type)))}${box('By source', tally(rows, (r) => [r.source, r.medium].filter(Boolean).join(' / ')))}${box('By page', tally(rows, path))}${box('By form', tally(rows, (r) => r.form || (r.type === 'form' ? '' : label(r.type))))}</div>
<div class="list"><table><tr><th>When</th><th>Type</th><th>Name</th><th>Phone</th><th>Email</th><th>Source</th><th>Page / form</th><th>Message</th></tr>
${rows.map((r) => `<tr><td>${esc(local(r.created_at))}</td><td>${esc(label(r.type))}${r.duration ? ` (${Math.round(r.duration / 6) / 10} min)` : ''}</td><td>${esc(r.name)}</td><td><a href="tel:${esc((r.phone || '').replace(/[^0-9+]/g, ''))}">${esc(r.phone)}</a></td><td>${esc(r.email)}</td><td>${esc([r.source, r.medium].filter(Boolean).join(' / '))}</td><td>${esc(path(r))}${r.form ? '<br><small>' + esc(r.form) + '</small>' : ''}</td><td class="msg">${esc(r.message)}</td></tr>`).join('\n') || '<tr><td colspan="8">No leads this month.</td></tr>'}
</table></div></body></html>`;
  return new Response(html, { headers: { ...H, 'content-type': 'text/html; charset=utf-8' } });
}
