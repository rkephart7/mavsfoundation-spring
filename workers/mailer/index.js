// mavs-mailer: sends lead emails with Cloudflare Email Routing (send_email binding),
// and emails the monthly lead report on the 1st of each month.
//
// Pages Functions can't use send_email, so the site calls this Worker through the MAILER
// service binding. It has no public URL (workers_dev = false), so only the site can reach it.
//
// Nothing to set on this Worker: the site sends the recipients (MAIL_TO / RENTER_EMAIL on the
// Pages project) with each message. Every recipient must be a verified destination address
// in Email Routing. On the 1st the cron asks the site to email last month's report.
import { EmailMessage } from 'cloudflare:email';

const TZ = 'America/Chicago';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, from: env.FROM });
    if (request.method !== 'POST' || url.pathname !== '/send') return new Response('Not found', { status: 404 });
    const msg = await request.json();
    const to = recipients(env, msg.to);
    if (!to.length) return Response.json({ sent: 0, recipients: 0, error: 'no recipients: set MAIL_TO on the Pages project' }, { status: 400 });
    const sent = await sendAll(env, msg, to);
    return Response.json({ sent, recipients: to.length, error: lastError || undefined }, { status: sent ? 200 : 502 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch(`${env.SITE}/api/monthly-report?token=${env.CRON_TOKEN}`).then(async (r) => console.log('monthly report', r.status, await r.text())));
  },
};

// Recipients sent by the site, or (fallback) MAIL_TO / RENTER_EMAIL set on this Worker.
function recipients(env, list) {
  const from = Array.isArray(list) && list.length ? list : [env.MAIL_TO, env.RENTER_EMAIL];
  return [...new Set(from.filter(Boolean).join(',').split(',').map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)))];
}

let lastError = '';
async function sendAll(env, msg, list) {
  let sent = 0;
  lastError = '';
  for (const addr of list) {
    try {
      await env.SEND.send(new EmailMessage(env.FROM, addr, mime({ ...msg, from: env.FROM, fromName: env.FROM_NAME, to: addr })));
      sent++;
    } catch (e) {
      console.error('send to', addr, 'failed:', e && e.message);
      lastError = (e && e.message) || String(e);
    }
  }
  return sent;
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
