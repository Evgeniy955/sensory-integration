# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** sensory-integration (Центр сенсорной интеграции — landing/визитка)
**Generated:** 2026-08-04
**Note:** The `ui-ux-pro-max --design-system` auto-match for this query returned an off-topic result (Link-in-Bio / Exaggerated Minimalism, navy+gold, Lora/Raleway) — wrong product category for a children's therapy center. This file replaces that output with tokens sourced from targeted `--domain color/typography/icons/landing` queries and reasoning specific to the subject (sensory-sensitive children, trust-seeking parents). See rationale inline.

---

## Global Rules

### Color Palette

Deliberately avoids clinical cold-blue "healthcare app" defaults and avoids the AI-cliché warm-cream-plus-terracotta combo. Each of the three specialities gets its own recognizable hue; apricot is reserved exclusively for calls to action across the whole page.

| Role | Hex | CSS Variable | Usage |
|------|-----|--------------|-------|
| Background | `#FAF7F0` | `--color-bg` | Warm ivory, not clinical white — sensory-safe |
| Surface | `#FFFFFF` | `--color-surface` | Cards |
| Surface Alt | `#F2EEE1` | `--color-surface-alt` | Section bands |
| Foreground | `#2E3B38` | `--color-ink` | Body text — warm graphite, not pure black |
| Foreground Soft | `#5C6D66` | `--color-ink-soft` | Secondary text |
| Foreground Faint | `#8A968F` | `--color-ink-faint` | Captions, meta |
| Primary (Sensory Integration) | `#6E9B78` | `--color-sage` | Sage green — calm, nature, growth |
| Primary Deep | `#3F6249` | `--color-sage-deep` | Text-on-tint, primary buttons |
| Primary Tint | `#E7F0E5` | `--color-sage-tint` | Badges, block backgrounds |
| Secondary (ABA) | `#6F9CAE` | `--color-sky` | Dusty blue — trust, sensory calm |
| Secondary Tint | `#E7F1F4` | `--color-sky-tint` | Notes, ABA-themed accents |
| Accent / CTA (Speech therapy + all CTAs) | `#DD9C61` | `--color-apricot` | The one color that always means "act here" |
| Accent Deep | `#B57B47` | `--color-apricot-deep` | Text on apricot tint |
| Accent Tint | `#FBECDB` | `--color-apricot-tint` | Soft CTA backgrounds |
| Border | `#E6DFCE` | `--color-border` | Dividers, card borders |
| Destructive | `#DC2626` | `--color-destructive` | Form errors only |

**Dark mode** (same relationships, inverted lightness — see `styles.css :root[data-theme="dark"]`): bg `#1B2320`, surface `#222B27`, ink `#F1EEE3`, sage `#8FC299`, sky `#8FBCCB`, apricot `#E7AE79`, border `#3A453F`.

### Typography

- **Heading Font:** Comfortaa (500/700) — rounded geometric, warm without being childish (Fredoka/Baloo are too playful for a clinical-adjacent trust context). Used sparingly: H1–H3 and pull-quotes only, never body paragraphs.
- **Body Font:** PT Sans (400/700) — Paratype's Cyrillic-native humanist sans, high legibility at small sizes, warm terminals that don't fight Comfortaa's roundness.
- **Why not the DB's Lora/Raleway match:** serif display reads editorial/academic, wrong register for a children's center; discarded along with the rest of the mismatched auto-result.
- Self-hosted as local TTF in `/assets/fonts/` (no external font CDN — avoids render-blocking third-party requests and works offline for demos).

| Role | Font | Weight | Size (desktop) |
|------|------|--------|-----------------|
| H1 | Comfortaa | 700 | 40–44px / 1.2 |
| H2 | Comfortaa | 700 | 28–32px / 1.25 |
| H3 / subhead | Comfortaa | 500 | 18–20px / 1.3 |
| Body | PT Sans | 400 | 16–17px / 1.6 |
| Caption / tag | PT Sans | 700 | 12–13px / 1.4, +letter-spacing |

### Spacing

Spacious rhythm — this is a trust-building one-pager, not a dashboard.

| Token | Value |
|-------|-------|
| `--space-xs` | 6px |
| `--space-sm` | 12px |
| `--space-md` | 24px |
| `--space-lg` | 40px |
| `--space-xl` | 64px |
| `--space-2xl` | 96px |
| `--space-3xl` | 140px |

### Radius

Not `rounded-lg` everywhere by default — radius is deliberate: small on structural elements, fully round only on things tied to the "soft/organic" brand idea (pills, avatars, badges, blobs).

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-s` | 6px | inputs, small chips |
| `--radius-m` | 14px | cards |
| `--radius-l` | 28px | hero media, large panels |
| `--radius-full` | 999px | buttons, badges, avatars |

---

## Motion

**Critical constraint:** audience includes sensory-sensitive children and anxious parents. A site about sensory safety must not itself violate it — no fast, flashing, bouncy, or high-amplitude motion, anywhere, ever.

- Scroll reveal: fade + 12–16px rise, 400–500ms, `ease-out`. No overshoot/bounce easing.
- Background: slow drifting blurred blobs (sage/sky/apricot at low opacity), 40–70s loop, translate + scale only (GPU-cheap), never opacity-flicker.
- Hover: card lift 4–6px + shadow, 200ms.
- Step path (how-it-works section): line draws in as the section scrolls into view — literal metaphor for the child's progress, not decoration.
- **`prefers-reduced-motion: reduce` is mandatory, not optional** — disables background drift entirely and swaps reveal transitions for instant appearance.

---

## Anti-Patterns (Do NOT Use)

- ❌ Clinical cold blue / stark white "medical app" look
- ❌ Warm-cream + terracotta-serif combo (generic "AI design" cliché)
- ❌ Emojis as icons — use the custom line-icon set (stroke 1.5–1.75px, rounded caps)
- ❌ Fast/bouncy/flashing animation of any kind
- ❌ Numbered markers where the content isn't actually sequential (fine for the 4-step "path" section; avoid elsewhere)
- ❌ Low contrast text — 4.5:1 minimum body text
- ❌ Missing `cursor:pointer` / invisible focus states

## Pre-Delivery Checklist

- [ ] No emojis as icons
- [ ] `cursor:pointer` on all clickable elements
- [ ] Hover/transition states 150–300ms
- [ ] Text contrast ≥ 4.5:1 (checked sage/apricot text on their tints)
- [ ] Visible focus states for keyboard nav
- [ ] `prefers-reduced-motion` disables background drift + reveal animation
- [ ] Responsive at 375 / 768 / 1024 / 1440px, no horizontal scroll
- [ ] Fonts self-hosted, no external font CDN calls
