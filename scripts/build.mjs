// Build: turns the DC design-tool site (hash routes like #/settlement-repair)
// into a static site with real URLs (/settlement-repair/), one index.html per page.
//
// How it works
//   1. Copies the template to dist/app.dc.html with hash routing switched to
//      path routing and every "#/x" link switched to "/x/".
//   2. Opens every route in headless Chromium, lets the page render, and saves
//      the rendered HTML as dist/<route>/index.html. That file contains the real
//      title, description, H1, text and links with no JavaScript needed.
//   3. In the browser, /boot.js then loads the normal runtime on top, so menus,
//      mobile layout and forms behave exactly as they do in the design tool.
//
// Usage:  npm run build            (all pages)
//         npm run build -- / /areas/klein/   (only these routes)

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'dist');
const TEMPLATE = 'Spring Texas Foundation Repair.dc.html';
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 }; // the template switches to its phone layout under 760px

// The runtime pulls React/Babel from unpkg. During the build we serve the same
// pinned versions from node_modules so the build works offline.
const CDN = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': path.join(ROOT, 'node_modules/react/umd/react.production.min.js'),
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': path.join(ROOT, 'node_modules/react-dom/umd/react-dom.production.min.js'),
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': path.join(ROOT, 'node_modules/@babel/standalone/babel.min.js'),
};

// ---------- 1. transform the template ----------

function must(src, re, to, label) {
  if (!re.test(src)) throw new Error(`build: expected to find ${label} in the template; it may have changed`);
  re.lastIndex = 0;
  return src.replace(re, to);
}

// "#/" -> "/", "#/klein" -> "/klein/"
const toPath = (h) => {
  const p = h.replace(/^#\/?/, '').replace(/\/+$/, '');
  if (p === '') return '/';
  return '/' + p + '/';
};

function transformTemplate(src) {
  // Route from the real path instead of the hash.
  src = must(src, /\(location\.hash \|\| ''\)\.replace\(\/\^#\\\/\?\/, ''\)/, "location.pathname", 'readHash');
  src = must(src, /window\.addEventListener\('hashchange', this\.readHash\);\s*/, '', 'hashchange listener');
  // Menu items that jump to a section of another page: remember the section,
  // load the page at its clean URL (/about/), and boot.js scrolls there. No "#" in the URL.
  src = must(src, /location\.hash = '#\/' \+ r; setTimeout\(go, 250\);/,
    "try { sessionStorage.setItem('dc-jump', label.toLowerCase().replace(/[^a-z0-9]+/g, '-')); } catch (err) {} location.href = r ? '/' + r + '/' : '/';", 'pageJump navigation');
  // Any other in-page JS navigation becomes a normal page load.
  src = src.replace(/location\.hash = /g, 'location.href = ');
  // JS-built links:  '#/' + s.slug  ->  '/' + s.slug + '/'
  src = src.replace(/'#\/(areas\/)?' \+ ([\w.]+)/g, (_, a, e) => `'/${a || ''}' + ${e} + '/'`);
  // JS string literals: '#/contact'
  src = src.replace(/'(#\/[\w\/-]*)'/g, (_, h) => `'${toPath(h)}'`);
  // Template links: href="#/areas/klein"
  src = src.replace(/href="(#\/[^"]*)"/g, (_, h) => `href="${toPath(h)}"`);
  // In-page links (href="#area-quote") -> no "#" anywhere; boot.js does the scroll.
  src = src.replace(/href="#([\w-]+)"/g, 'href="" data-section="$1"');
  // Assets must be absolute now that pages live in sub-folders.
  src = src.replace(/(["'])(?:\.\/)?(images|uploads)\//g, '$1/$2/');
  src = src.replace(/src="\.\/(support|image-slot)\.js"/g, 'src="/$1.js"');
  if (/#\//.test(src.replace(/<!--[\s\S]*?-->/g, ''))) {
    const left = [...new Set(src.match(/.{30}#\/.{30}/g))].slice(0, 5);
    console.warn('build: some "#/" references were not converted:\n  ' + left.join('\n  '));
  }
  return src;
}

// Pull every route out of the data tables in the template.
function routesFrom(src) {
  const block = (name) => {
    const m = new RegExp(`^const ${name} = \\[([\\s\\S]*?)^\\];`, 'm').exec(src);
    if (!m) throw new Error(`build: could not find const ${name} in the template`);
    // Only top-level entries: a slug that follows "{ " at the start of an entry.
    return [...m[1].matchAll(/^\s*\{\s*slug:\s*['"]([^'"]+)['"]/gm)].map((x) => x[1]);
  };
  return [
    '/', '/services/', '/warning-signs/', '/pricing-guide/', '/about/', '/contact/', '/spring-tx-foundation-considerations/', '/areas/',
    ...block('SVC').map((s) => `/${s}/`),
    ...block('GUIDES').map((s) => `/${s}/`),
    ...block('AREAS').map((s) => `/areas/${s}/`),
  ];
}

// ---------- 2. serve dist/ ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function serve(appShell) {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(DIST, url);
    if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
    try {
      if ((await stat(file)).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(await readFile(file));
        return;
      }
    } catch {}
    if (!path.extname(url)) { // a route: serve the live app so it can render
      res.writeHead(200, { 'content-type': TYPES['.html'] }).end(appShell);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---------- 3. snapshot a rendered page (runs in the browser) ----------

function snapshot() {
  const root = document.getElementById('dc-root');
  const clone = root.cloneNode(true);
  // Image slots render into shadow DOM, which does not serialize. Replace each
  // with a plain <img> in a box that keeps the slot's own sizing.
  const live = root.querySelectorAll('image-slot');
  clone.querySelectorAll('image-slot').forEach((slot, i) => {
    const box = document.createElement('div');
    // Same box the slot's own CSS gives it (:host in image-slot.js), image absolutely inside.
    box.setAttribute('style', 'display:block;position:relative;width:100%;height:100%;aspect-ratio:3/2;overflow:hidden;' + (slot.getAttribute('style') || ''));
    const src = slot.getAttribute('src');
    if (src && !src.startsWith('data:')) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = slot.getAttribute('placeholder') || '';
      img.setAttribute('style', 'position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:' + (slot.getAttribute('fit') || 'cover') + ';');
      const r = live[i] && live[i].getBoundingClientRect();
      if (r && r.width) { img.width = Math.round(r.width); img.height = Math.round(r.height); }
      img.loading = i < 2 ? 'eager' : 'lazy';
      box.appendChild(img);
    } else if (live[i]) {
      const r = live[i].getBoundingClientRect();
      if (r.height) box.style.minHeight = Math.round(r.height) + 'px';
    }
    slot.replaceWith(box);
  });
  clone.querySelectorAll('script').forEach((s) => s.remove());
  clone.querySelectorAll('a[href^="#/"]').forEach((a) => a.setAttribute('href', a.getAttribute('href').replace(/^#\/?(.*?)\/?$/, (m, p) => p ? '/' + p + '/' : '/')));

  // Head: keep styles, font links and meta; drop scripts (boot.js re-adds the runtime).
  const head = [];
  document.head.querySelectorAll('style, link[rel="stylesheet"], link[rel="preconnect"]').forEach((el) => head.push(el.outerHTML));
  const desc = document.querySelector('meta[name="description"]');
  return {
    title: document.title,
    description: desc ? desc.content : '',
    head: head.join('\n'),
    body: clone.innerHTML,
    h1: [...root.querySelectorAll('h1')].map((h) => h.textContent.trim()),
  };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The desktop render is the page's real HTML (what crawlers read, full nav links).
// The phone render rides along in a <template>, which browsers do not display and
// search engines do not index; a one-line script swaps it in on narrow screens
// before first paint, so phones never flash the desktop layout.
function page(snap, mobile, route, origin) {
  const url = origin + route;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(snap.title)}</title>
<meta name="description" content="${esc(snap.description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Mavericks of Spring Texas Foundation Repair">
<meta property="og:title" content="${esc(snap.title)}">
<meta property="og:description" content="${esc(snap.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${origin}/images/house-spring.webp">
<meta name="twitter:card" content="summary_large_image">
${snap.head}
</head>
<body>
<div id="prerendered">${snap.body}</div>
<template id="prerendered-mobile"><div id="prerendered">${mobile.body}</div></template>
<script>if(innerWidth<760){var m=document.getElementById('prerendered-mobile');document.getElementById('prerendered').replaceWith(m.content);m.remove();}</script>
<script src="/boot.js" defer></script>
</body>
</html>
`;
}

// ---------- main ----------

async function main() {
  const only = process.argv.slice(2);
  const raw = await readFile(path.join(SRC, TEMPLATE), 'utf8');
  const app = transformTemplate(raw);
  const routes = only.length ? only : routesFrom(raw);
  // The live domain, from the template (const SITE = 'example.com').
  const siteM = /^const SITE = '([^']+)';/m.exec(raw);
  if (!siteM) throw new Error('build: could not find const SITE in the template');
  const ORIGIN = 'https://' + siteM[1];

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(path.join(SRC, 'images'), path.join(DIST, 'images'), { recursive: true });
  await cp(path.join(SRC, 'support.js'), path.join(DIST, 'support.js'));
  // image-slot loads a sidecar of user-dropped images relative to the page; make it absolute.
  const slotJs = await readFile(path.join(SRC, 'image-slot.js'), 'utf8');
  await writeFile(path.join(DIST, 'image-slot.js'), must(slotJs, /const STATE_FILE = '\.image-slots\.state\.json';/, "const STATE_FILE = '/image-slots.state.json';", 'STATE_FILE'));
  await writeFile(path.join(DIST, 'image-slots.state.json'), '{}');
  await writeFile(path.join(DIST, 'app.dc.html'), app);
  await cp(path.join(ROOT, 'scripts', 'boot.js'), path.join(DIST, 'boot.js'));

  const server = await serve(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const context = async (viewport) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.route('https://unpkg.com/**', async (route) => {
      const file = CDN[route.request().url()];
      if (!file) return route.abort();
      route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
    });
    return ctx;
  };
  const desktop = await context(DESKTOP), phone = await context(MOBILE);
  const render = async (ctx, r, errors) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + r, { waitUntil: 'networkidle' });
    await p.waitForSelector('#dc-root h1', { timeout: 20000 });
    await p.waitForTimeout(300);
    const snap = await p.evaluate(snapshot);
    await p.close();
    return snap;
  };

  const report = [];
  for (const r of routes) {
    const errors = [];
    const snap = await render(desktop, r, errors);
    const mobile = await render(phone, r, errors);
    const out = path.join(DIST, r, 'index.html');
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, page(snap, mobile, r, ORIGIN));
    report.push({ route: r, title: snap.title, h1: snap.h1, errors });
    console.log(`${r.padEnd(32)} ${snap.h1.length} h1  ${snap.title.slice(0, 70)}${errors.length ? '  ERRORS: ' + errors.join('; ') : ''}`);
  }
  await writeFile(path.join(DIST, 'build-report.json'), JSON.stringify(report, null, 2));
  if (!only.length) {
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(path.join(DIST, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      routes.map((r) => `  <url><loc>${ORIGIN}${r}</loc><lastmod>${today}</lastmod></url>\n`).join('') + '</urlset>\n');
    await writeFile(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /app.dc.html\nDisallow: /build-report.json\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  }
  await browser.close();
  server.close();
  console.log(`\nBuilt ${report.length} pages into dist/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
