// mavs-mailer: sends lead emails with Cloudflare Email Routing (send_email binding),
// and emails the monthly lead report on the 1st of each month.
//
// Pages Functions can't use send_email, so the Pages project calls this Worker through a
// service binding (MAILER). It has no public URL (workers_dev = false).
//
// Secrets (Worker > Settings > Variables and Secrets, type Secret):
//   MAIL_TO          Ryan's address (comma-separate several)
//   RENTER_EMAIL     the renter's address (optional; comma-separate several)
//   REPORT_PASSWORD  same password as /report on the site (for the monthly email)
// Every recipient must be a verified destination address in Email Routing.
import { EmailMessage } from 'cloudflare:email';

const TZ = 'America/Chicago';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/send') return new Response('Not found', { status: 404 });
    const msg = await request.json();
    const sent = await sendAll(env, msg);
    return Response.json({ sent }, { status: sent ? 200 : 502 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(monthlyReport(env));
  },
};

function recipients(env) {
  return [env.MAIL_TO, env.RENTER_EMAIL].filter(Boolean).join(',').split(',').map((s) => s.trim()).filter(Boolean);
}

async function sendAll(env, msg) {
  let sent = 0;
  for (const to of [...new Set(recipients(env))]) {
    try {
      await env.SEND.send(new EmailMessage(env.FROM, to, mime({ ...msg, from: env.FROM, fromName: env.FROM_NAME, to })));
      sent++;
    } catch (e) {
      console.error('send to', to, 'failed:', e && e.message);
    }
  }
  return sent;
}

async function monthlyReport(env) {
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(now);
  let y = +p.find((x) => x.type === 'year').value, m = +p.find((x) => x.type === 'month').value - 1;
  if (m < 1) { m = 12; y--; }
  const month = `${y}-${String(m).padStart(2, '0')}`;
  const auth = { Authorization: 'Basic ' + btoa('report:' + env.REPORT_PASSWORD) };
  const [j, csv] = await Promise.all([
    fetch(`${env.SITE}/report?month=${month}&format=json`, { headers: auth }).then((r) => { if (!r.ok) throw new Error('report json ' + r.status); return r.json(); }),
    fetch(`${env.SITE}/report?month=${month}&format=csv`, { headers: auth }).then((r) => r.text()),
  ]);
  const count = (key) => {
    const t = {};
    for (const r of j.rows) { const k = key(r) || '(none)'; t[k] = (t[k] || 0) + 1; }
    return Object.entries(t).sort((a, b) => b[1] - a[1]);
  };
  const names = { form: 'Web form', call: 'Phone call', text: 'Text message' };
  const byType = count((r) => names[r.type] || r.type);
  const bySource = count((r) => [r.source, r.medium].filter(Boolean).join(' / '));
  const byForm = count((r) => r.form || names[r.type] || r.type);
  const title = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const list = (rows) => rows.map(([k, n]) => `  ${k}: ${n}`).join('\n') || '  none';
  const tbl = (h, rows) => `<h3 style="margin:16px 0 6px">${h}</h3><table style="border-collapse:collapse">${rows.map(([k, n]) => `<tr><td style="padding:3px 16px 3px 0">${esc(k)}</td><td style="font-weight:700">${n}</td></tr>`).join('')}</table>`;
  const link = `${env.SITE}/report?month=${month}`;
  await sendAll(env, {
    subject: `Lead report for ${title}: ${j.count} lead${j.count === 1 ? '' : 's'}`,
    text: `${j.count} leads in ${title}.\n\nBy type:\n${list(byType)}\n\nBy source:\n${list(bySource)}\n\nBy form:\n${list(byForm)}\n\nFull list: ${link}\n(CSV attached)`,
    html: `<div style="font:15px/1.5 Arial,sans-serif"><p style="font-size:22px;margin:0"><b>${j.count}</b> lead${j.count === 1 ? '' : 's'} in ${title}</p>${tbl('By type', byType)}${tbl('By source', bySource)}${tbl('By form', byForm)}<p><a href="${link}">Full list</a> (CSV attached)</p></div>`,
    attachments: [{ filename: `leads-${month}.csv`, type: 'text/csv', content: csv }],
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{76}/g, '$&\r\n');
}
const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s).replace(/\r\n/g, '')}?=`);
const header = (s) => String(s || '').replace(/[\r\n]+/g, ' ');

function mime({ from, fromName, to, subject, text, html, replyTo, attachments = [] }) {
  const id = () => crypto.randomUUID().replace(/-/g, '');
  const alt = 'alt' + id(), mix = 'mix' + id();
  const head = [
    `From: ${word(header(fromName || 'Website Leads'))} <${from}>`,
    `To: <${to}>`,
    `Subject: ${word(header(subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
  ];
  if (replyTo && /^[^\s<>@,;]+@[^\s<>@,;]+$/.test(replyTo)) head.push(`Reply-To: <${replyTo}>`);
  const part = (type, body) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body)}`;
  const altBody = `--${alt}\r\n${part('text/plain', text || '')}\r\n--${alt}\r\n${part('text/html', html || esc(text || ''))}\r\n--${alt}--`;
  if (!attachments.length) return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, '', altBody].join('\r\n');
  const att = attachments.map((a) => `--${mix}\r\nContent-Type: ${a.type}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(a.content)}`).join('\r\n');
  return [...head, `Content-Type: multipart/mixed; boundary="${mix}"`, '', `--${mix}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n${altBody}`, att, `--${mix}--`].join('\r\n');
}
