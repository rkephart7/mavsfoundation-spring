// Last month's lead report as an email (count, by type / source / form, CSV attached).
import { db, esc, label, monthStart, currentMonth, TZ } from './leads.js';

export const CSV_COLS = ['id', 'created_at', 'type', 'name', 'phone', 'email', 'message', 'form', 'source', 'medium', 'campaign', 'page', 'landing_page', 'referrer', 'duration', 'recording'];
export const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows) => '\ufeff' + [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => csvCell(c === 'created_at' ? new Date(r[c]).toLocaleString('en-US', { timeZone: TZ }) : r[c])).join(','))].join('\r\n');

export function tally(rows, key) {
  const t = {};
  for (const r of rows) { const k = key(r) || '(none)'; t[k] = (t[k] || 0) + 1; }
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
}

export async function leadsIn(env, month) {
  const [y, m] = month.split('-').map(Number);
  const d = await db(env);
  if (!d) throw new Error('DB binding missing');
  const { results } = await d.prepare(
    `SELECT ${CSV_COLS.join(', ')} FROM leads WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC`,
  ).bind(monthStart(y, m), monthStart(y, m + 1)).all();
  return results;
}

export function lastMonth() {
  let [y, m] = currentMonth().split('-').map(Number);
  m -= 1;
  if (m < 1) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function monthlyEmail(rows, month, site) {
  const [y, m] = month.split('-').map(Number);
  const title = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const byType = tally(rows, (r) => label(r.type));
  const bySource = tally(rows, (r) => [r.source, r.medium].filter(Boolean).join(' / '));
  const byForm = tally(rows, (r) => r.form || (r.type === 'form' ? '' : label(r.type)));
  const n = rows.length;
  const list = (t) => t.map(([k, c]) => `  ${k}: ${c}`).join('\n') || '  none';
  const tbl = (h, t) => `<h3 style="margin:16px 0 6px">${h}</h3><table style="border-collapse:collapse">${t.map(([k, c]) => `<tr><td style="padding:3px 16px 3px 0">${esc(k)}</td><td style="font-weight:700">${c}</td></tr>`).join('') || '<tr><td>none</td></tr>'}</table>`;
  const link = `${site}/report?month=${month}`;
  return {
    subject: `Lead report for ${title}: ${n} lead${n === 1 ? '' : 's'}`,
    text: `${n} lead${n === 1 ? '' : 's'} in ${title}.\n\nBy type:\n${list(byType)}\n\nBy source:\n${list(bySource)}\n\nBy form:\n${list(byForm)}\n\nFull list: ${link}\n(CSV attached)`,
    html: `<div style="font:15px/1.5 Arial,sans-serif"><p style="font-size:22px;margin:0"><b>${n}</b> lead${n === 1 ? '' : 's'} in ${title}</p>${tbl('By type', byType)}${tbl('By source', bySource)}${tbl('By form', byForm)}<p><a href="${link}">Full list</a> (CSV attached)</p></div>`,
    attachments: [{ filename: `leads-${month}.csv`, type: 'text/csv', content: toCsv(rows) }],
  };
}
