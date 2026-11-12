// /api/monthly-report?token=CRON_TOKEN: emails last month's lead report (the mailer's cron calls
// this on the 1st). Each month is sent once; ?month=YYYY-MM picks another month not yet sent.
import { db, json, sendMail, recipientsOf, CRON_TOKEN } from '../../server/leads.js';
import { leadsIn, lastMonth, monthlyEmail } from '../../server/monthly.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('token') !== CRON_TOKEN) return json({ ok: false }, 401);
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : lastMonth();
  if (!recipientsOf(env).length) return json({ ok: false, error: 'MAIL_TO is not set on the Pages project' }, 503);
  const d = await db(env);
  await d.prepare('CREATE TABLE IF NOT EXISTS sent_reports (month TEXT PRIMARY KEY, sent_at TEXT NOT NULL)').run();
  if (await d.prepare('SELECT 1 FROM sent_reports WHERE month = ?').bind(month).first()) return json({ ok: true, month, already_sent: true });
  const rows = await leadsIn(env, month);
  const r = await sendMail(env, monthlyEmail(rows, month, url.origin));
  let answer = null;
  try { answer = await r.json(); } catch (e) {}
  if (!r.ok) return json({ ok: false, month, status: r.status, answer }, 502);
  await d.prepare('INSERT INTO sent_reports (month, sent_at) VALUES (?, ?)').bind(month, new Date().toISOString()).run();
  return json({ ok: true, month, leads: rows.length, answer });
}
