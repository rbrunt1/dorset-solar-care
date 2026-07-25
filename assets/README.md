# SolarMOT brand assets

All artwork is hand-built vector SVG — no raster source, nothing AI-generated — so it stays crisp at any size and is editable in any vector tool.

## The mark

A sun with a **checkmark knocked out of the disc**.

The sun says solar; the tick says inspected and passed. That ties the logo to the SolarMOT positioning rather than being a generic sun that any solar company could use. The tick is genuinely part of the mark's silhouette, not a badge stuck in the corner, so it survives being scaled down.

**The tick is negative space, not a drawn shape.** It shows whatever is behind the logo. That's deliberate: one file works on the white header, on the near-black footer, and in a browser tab in light or dark mode, with no variants to keep in sync.

## Files

| File | Use |
|---|---|
| `logo-lockup.svg` | **Primary logo.** Mark + wordmark, full colour. Default choice. |
| `logo-lockup-white.svg` | Reversed, for dark backgrounds. |
| `logo-lockup-mono.svg` | Single colour (`currentColor`) for print, signage, embroidery. |
| `logo-icon.svg` | Icon alone. Site header/footer, social avatars, anywhere too tight for the wordmark. |
| `logo-icon-mono.svg` | Icon alone, single colour. |
| `favicon.svg` | Browser tab. **Not a scale-down** — redrawn for 16px (see below). |
| `favicon-16.png`, `favicon-32.png` | PNG fallbacks for browsers that ignore SVG favicons. |
| `apple-touch-icon.png` | 180×180, iOS home screen. Opaque white background, as iOS doesn't honour transparency. |
| `icon-192.png`, `icon-512.png` | PWA / Android, referenced from `site.webmanifest`. |

## Why the favicon is a separate drawing

Scaling the logo down to 16px doesn't work: the padding wastes the canvas and the tick closes up into a blob. `favicon.svg` uses the same geometry with less padding, a proportionally larger disc, and a bolder tick. Both were checked by rendering at 16/24/32px, not assumed.

## Colour

| | Hex |
|---|---|
| Sun (gradient) | `#FFC15E` → `#F5A623` → `#DE8A0E` |
| Wordmark "Solar" | `#0B3A2E` |
| Wordmark "MOT" | `#F5A623` (`#FFB94A` when reversed) |

Amber was chosen for the mark because it reads as sunlight and has adequate contrast on both white and the brand's deep greens — which is what lets the logo skip a background tile.

## Usage

- **Clear space:** at least one ray-height (~12% of logo height) on all sides.
- **Minimum size:** 120px wide for the lockup. Below that, use `logo-icon.svg`.
- **Don't** re-colour the sun outside the palette, add effects, stretch it non-proportionally, or fill in the knocked-out tick.

## A note on the wordmark

The lockup SVGs set the wordmark as live `<text>` in Plus Jakarta Sans ExtraBold, which keeps the files small and editable. **Convert text to outlines before sending to a printer or signwriter**, otherwise a machine without the font will substitute one. On the website itself the wordmark is live HTML text, which is better for accessibility and SEO than an image.

## Editing

Geometry is plain `<line>`, `<circle>` and `<path>` elements on a 48×48 grid centred at (24,24) — no flattened paths — so the rays, disc radius and tick weight can all be adjusted by changing numbers directly. If you change the mark, update `logo-icon-mono.svg`, the lockups and `favicon.svg` to match; they intentionally duplicate the geometry so each file stands alone.
