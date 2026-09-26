# Orplex Docs Site

Docusaurus site for the Orplex documentation (getting-started guides, API
reference). The docs share the product's brand typography and visual language
— see `../BRAND.md` for the design tokens.

## Quickstart

```bash
cd docs-site
npm install
npm run start    # local dev at http://localhost:3000
npm run build    # production build into build/
npm run serve    # serve the production build
```

`onBrokenLinks: "throw"` is enabled, so any build that links to a nonexistent
route fails — a good thing, but note the two client-side redirect pages
(`/guides`, `/api` in `src/pages/`) exist to satisfy navbar links.

## Shared font pipeline

The docs and the Next.js app use the **same self-hosted faces** (Lexend for
UI/prose, JetBrains Mono for code, normal + italic, latin + latin-ext). They
are not vendored here manually — both sites are generated from one script at
the repo root:

```
scripts/fetch-fonts.mjs
```

It downloads the subsets from Google Fonts once, then writes them to **both**
targets:

| Target | woff2 files | Generated `@font-face` CSS |
|---|---|---|
| App | `public/fonts/` | `src/app/fonts.css` |
| **Docs** | `static/fonts/` | `src/css/fonts.css` (loaded via `customCss` in `docusaurus.config.js`) |

Both sites serve the files from `/fonts/`, so the generated CSS is
byte-identical and a single re-run keeps product + docs in sync.

### How docs get refreshed automatically

`npm run build` runs the fetcher first via the npm `prebuild` hook
(`package.json`), so **every production docs build ships the latest faces** —
no manual step. If you change the weights/styles in the fetcher's `FONTS`
config, just rebuild (or run the script directly) and both sites update.

### Verifying the sites are in sync

```bash
npm run check:fonts   # also available at the repo root as `npm run check:fonts`
```

Fails with exit 1 if the app and docs font targets ever drift (different
woff2 files/bytes or a diverged `fonts.css`); `node scripts/fetch-fonts.mjs`
regenerates both from the same bytes to fix it.

### Manual re-runs

```bash
# from the repo root
node scripts/fetch-fonts.mjs

# from this directory (works too — the script is cwd-independent)
node ../scripts/fetch-fonts.mjs
```

The script is network-resilient: if Google Fonts is unreachable (offline
build, locked-down CI) it keeps whatever fonts are already on disk and exits 0,
so a fonts hiccup never fails a docs build. To force that behavior without
touching the network:

```bash
ORPLEX_FONTS_SKIP_NETWORK=1 npm run build
```

Notes:

- Google Fonts' Lexend has **no italic axis** (only `Lexend[wght].ttf`), so
  Lexend emphasis uses the browser's synthetic oblique — a typeface
  limitation, not a pipeline gap. JetBrains Mono's italics are real.
- **Windows gotcha:** `docusaurus serve` locks the `build/` directory, so
  stop the server before running `npm run build` again, or Docusaurus will
  fail clearing `build/` with `ENOTEMPTY`.
