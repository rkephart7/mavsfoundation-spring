// /api/whatconverts?key=WC_WEBHOOK_KEY: WhatConverts webhook for call and text leads.
// Accepts JSON or form-encoded bodies. A repeat delivery for the same WhatConverts lead
// updates the row. No email: WhatConverts already alerts on calls and texts
// (set NOTIFY_WC=on on the Pages project to email them too).
import { saveLead, notify, leadEmail, clean, json } from '../../server/leads.js';

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!env.WC_WEBHOOK_KEY || url.searchParams.get('key') !== env.WC_WEBHOOK_KEY) return json({ ok: false }, 401);

  const text = await request.text();
  let p = {};
  try { p = JSON.parse(text); } catch (e) { p = Object.fromEntries(new URLSearchParams(text)); }
  if (Array.isArray(p)) p = p[0] || {};
  if (p.lead && typeof p.lead === 'object') p = { ...p, ...p.lead };
  if (p.leads && Array.isArray(p.leads)) p = { ...p, ...p.leads[0] };

  const get = (...keys) => {
    for (const k of keys) if (p[k] != null && p[k] !== '') return String(p[k]);
    return '';
  };
  const rawType = get('lead_type', 'type').toLowerCase();
  const type = /call|phone/.test(rawType) ? 'call' : /text|sms/.test(rawType) ? 'text' : /form/.test(rawType) ? 'wc-form' : (rawType || 'other');
  const dur = parseInt(get('call_duration_seconds', 'call_duration', 'duration'), 10);

  const lead = {
    type,
    external_id: get('lead_id', 'id') ? 'wc:' + get('lead_id', 'id') : null,
    name: clean(get('contact_name', 'caller_name', 'name'), 120),
    phone: clean(get('contact_phone_number', 'caller_number', 'phone_number_from', 'phone'), 40),
    email: clean(get('contact_email_address', 'email_address', 'email'), 200),
    message: clean(get('message', 'text_body', 'sms_message', 'lead_summary', 'notes'), 4000),
    page: clean(get('lead_url', 'page_url'), 300),
    landing_page: clean(get('landing_url'), 500),
    referrer: clean(get('referring_url', 'referrer'), 500),
    source: clean(get('lead_source', 'source'), 100),
    medium: clean(get('lead_medium', 'medium'), 100),
    campaign: clean(get('lead_campaign', 'campaign'), 200),
    gclid: clean(get('gclid'), 200),
    duration: Number.isFinite(dur) ? dur : null,
    recording: clean(get('recording', 'recording_url', 'call_recording'), 500),
    raw: text.slice(0, 20000),
  };

  let r;
  try { r = await saveLead(env, lead); } catch (e) {
    console.error('saveLead', e);
    return json({ ok: false }, 500);
  }
  if (r.isNew && env.NOTIFY_WC === 'on') await notify(env, leadEmail(lead, url.origin));
  return json({ ok: true, id: r.id });
}
