# Orplex Visual Language — Audit & Unified Proposal

Status: **proposal** (no files changed for colors). Source of truth = the app
(`src/app/globals.css`) and the actual logo mark. The docs-site is the only
surface that diverges: it was scaffolded with Docusaurus' default **indigo**
accent while the product and the logo are **orange**.

---

## 1. Audit findings

### What already matches
- **Typography** — unified (self-hosted Lexend + JetBrains Mono via
  `scripts/fetch-fonts.mjs`; both sites serve from `/fonts/`).
- **Logo** — `public/logo.png` and `docs-site/static/img/logo.png` are
  byte-identical (md5 `b238d66a…`). Dominant color **#ff6808** (63.5% of
  pixels) — the brand mark *is* orange.
- **Code face** — both use JetBrains Mono.

### Where they diverge
| Surface | App | Docs-site | Verdict |
|---|---|---|---|
| Primary accent | `#a04100` burnt orange | `#6366f1` indigo | **clash** — indigo sits next to an orange logo in the docs navbar |
| CTA / brand vivid | `#FF6B00` orange (+ `#E05500` border) | none | docs has no CTA echo of the logo |
| Tint / hover fill | `#FFF7ED` warm cream, `#2a1f14` (dark) | indigo-50-ish rgba | no warm surface language |
| Canvas | `#f9f9fa` / `#1a1c1d` (dark) | Infima white / `#1b1b1d` | near-miss; align to app values |
| Borders | `#E4E4E7` / `#404040` (dark) | Infima `#dadde1`-family | align |
| Text | `#1a1c1d` / `#5f5e5e` / `#e5e2e1`(dark) | Infima grays | align via emphasis scale |
| Radius | 4/6/8/12/20 px system | Infima 4 px default + 50% pills | adopt app scale |
| Shadows | soft warm-gray, orange ring `rgba(160,65,0,.1)` | Infima defaults | adopt app feel |
| Favicon | — | `img/favicon.ico` referenced but **file missing → 404** | fix (bug) |

### App palette (measured from `globals.css`)
Light mode
- Canvas `#f9f9fa` · Surface `#fff` · Well `#f3f3f4`/`#fafafa` · Warm tint `#FFF7ED`
- Border `#E4E4E7` (strong `#d4d4d8`)
- Text: `#1a1c1d` → `#5f5e5e` → `#999`/`#a0a0a0`
- Accent `#a04100` (links, active, focus ring `rgba(160,65,0,.1)`)
- CTA `#FF6B00` · hover `#E05500` · pressed `#C04400` · logo `#ff6808`
- Link hover `#dd8339` · alt browns `#944b00` / `#8a3800`
- Semantic: success `#16a34a` (bg `#dcfce7`), danger `#dc2626`/`#ba1a1a`, warning `#f97316`

Dark mode
- Canvas `#1a1c1d` · Well `#2a2a2a` · Warm hover `#2a1f14` · Border `#404040` (strong `#333`/`#555`)
- Text `#e5e2e1` · muted `#888`/`#a0a0a0` · code text `#d4d4d8`
- Accent becomes **`#ffb693`** (peach) for links/active text; solid CTAs stay `#ff6b00`
- Tinted fills `#ffb69320`

---

## 2. The unified language

### 2.1 Brand ramp (orange) — one ramp for both sites
| Token | Light | Dark | Role |
|---|---|---|---|
| `brand-50` | `#FFF7ED` | `#2a1f14` | tint surface, active/well backgrounds |
| `brand-100` | `#ffe8d6` | `#3a2a1c` | soft fills, badges |
| `brand-300` | `#ffb693` | `#ffb693` | dark-mode accent text (peach) |
| `brand-500` | `#dd8339` | `#ff9a5c` | hover of links / secondary accent |
| `brand-600` | `#a04100` | — | **primary**: links, active, buttons (light mode) |
| `brand-700` | `#944b00` | `#a04100` | primary hover / pressed (dark-mode buttons) |
| `brand-800` | `#8a3800` | `#8a3800` | pressed |
| `brand-vivid` | `#FF6B00` | `#ff6b00` | **CTA / logo echo** (bg + glow) |
| `brand-vivid-border` | `#E05500` | `#E05500` | CTA border/hover |
| `brand-logo` | `#ff6808` | `#ff8a3d` | logo-derived accent (marketing) |
| ring | `rgba(160,65,0,.1)` | `rgba(255,107,0,.35)` | focus rings |

Rule of thumb: **`#a04100` on light / `#ffb693` on dark for text and links;
`#FF6B00` only for the primary CTA, active badges, and logo echoes** (it fails
AA at body sizes on white — 2.9:1 — so never for body text; the app already
reserves it for bold CTA labels + glow).

### 2.2 Neutrals & semantic
| Token | Light | Dark |
|---|---|---|
| canvas | `#f9f9fa` | `#1a1c1d` |
| surface | `#fff` | `#1a1c1d` (sidebar/topbar/modals) |
| well | `#f3f3f4` / `#fafafa` | `#2a2a2a` |
| border | `#E4E4E7` | `#404040` (strong `#555`) |
| text-primary | `#1a1c1d` | `#e5e2e1` |
| text-secondary | `#5f5e5e` | `#a0a0a0` |
| text-tertiary | `#999` | `#888` |
| success | `#16a34a` (bg `#dcfce7`) | `#4ade80` (bg `#14321f`) |
| danger | `#dc2626` (bg `#fee2e2`) | `#f87171` (bg `#3a1515`) |
| warning | `#f97316` | `#fb923c` |

### 2.3 Radius, spacing, shadow (app's scale)
- Radius: **4** (fields/badges) · **6** (small cards/buttons) · **8** (cards, code blocks, search) · **12** (bubbles/modals) · **20** (CTA pills) — Infima `--ifm-global-radius` → `6px`, components opt into 8/12.
- Borders: `1px` hairline; code blocks get the app treatment (header `#f3f3f4`/dark `#2a2a2a`, body well, radius 8).
- Spacing rhythm: 4 / 8 / 12 / 16 / 24; sidebar/nav rail 256 px.
- Shadows: subtle float `0 4px 16px rgba(0,0,0,.1)`; modal `0 20px 60px rgba(0,0,0,.2)`; CTA glow `0 2px 8px rgba(255,107,0,.3)`.

### 2.4 Code blocks (docs prism)
Keep neutral, frame it like the app: header chip with brand-600 label on
`#f3f3f4` (dark `#2a2a2a`), well background `#fafafa` (dark `#1a1c1d`),
JetBrains Mono 13 px. Recolor the dark Dracula background from its default to
`#1a1c1d` for exact product parity (token colors themselves may stay).

---

## 3. Migration plan (when approved)

1. **docs-site/src/css/custom.css** — swap the indigo ramps for the brand ramp
   above (light + `[data-theme="dark"]`), map Infima tokens:
   `--ifm-color-primary` → `#a04100` family, `--ifm-background-color`,
   `--ifm-navbar-background-color`, `--ifm-code-background`, emphasis scale,
   radius, link colors (`#dd8339` hover), code-block framing.
2. **favicon** — copy `logo.png` as `docs-site/static/img/favicon.ico`-source
   (PNG favicon is fine; drop the `.ico` reference or ship a real 32×32 icon)
   to kill the 404 in the config.
3. **CTA echo** — one `#FF6B00` call-to-action on the docs home so the docs
   feel like the product, not a template.
4. **App (optional cleanup, no visual change)** — the app hard-codes hexes ~140
   times for one border color; centralizing into the `:root` tokens above would
   make future theming trivial. Visual result identical.
5. **A11y gate** — verify AA: `#a04100` on white = 6.4:1 ✓ (text), `#ffb693`
   on `#1a1c1d` = ~10:1 ✓ (dark text), `#FF6B00` + white = 2.9:1 ✗ → CTA-only.
