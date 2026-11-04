# Mavericks of Spring Texas Foundation Repair

Static site for springtexasfoundationrepair.com.

- `site/` is the design-tool export. Edit the site there, the same way as before
  (`Spring Texas Foundation Repair.dc.html` is the page; `backups/` and the
  `* Options.dc.html` files are design history and are not published).
- `dist/` is what gets published: one real HTML page per URL
  (`/settlement-repair/`, `/areas/klein/`, ...). It is generated; don't edit it by hand.
- `scripts/build.mjs` turns `site/` into `dist/`.

## Rebuild after editing the site

```sh
npm install          # first time only
npm run build        # all pages -> dist/
npm run build -- / /areas/klein/   # just these pages
npm run preview      # look at dist/ on http://localhost:3000
```

The build needs Node 18+ and Playwright's Chromium (`npx playwright install chromium`
the first time on a new machine).

## How the build works

1. Copies the template to `dist/app.dc.html` with `#/` hash routing switched to
   real paths, and every `#/x` link changed to `/x/`.
2. Opens every page in headless Chromium at desktop and phone width and saves the
   rendered HTML to `dist/<path>/index.html`. View Source on any page shows its
   real title, description, H1, text and links with no JavaScript.
   The desktop render is the page's HTML; the phone render sits in a `<template>`
   and is swapped in before first paint on screens under 760px.
3. `/boot.js` then starts the normal design-tool runtime on top, so menus, the
   mobile menu and forms behave exactly as in the design tool.

Pages are discovered from the `SVC`, `GUIDES` and `AREAS` lists in the template,
plus home, the services hub, warning signs, pricing guide, about, contact,
considerations (`/spring-tx-foundation-considerations/`) and the areas hub. Add an area or
service there and rebuild; it gets its own URL automatically.

## SEO tags

- Page titles live in the `TITLES` table in the template (`site/Spring Texas Foundation Repair.dc.html`),
  keyed by URL. Descriptions are in `DESC` right below it.
- The build adds a canonical link, Open Graph and Twitter tags to every page, and writes
  `dist/sitemap.xml` and `dist/robots.txt`, all pointing at the domain in `const SITE` in the template.
