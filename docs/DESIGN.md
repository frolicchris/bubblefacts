# Designing a custom look

For anyone making bubble looks for musicians, DJs and streamers. A look is a
little CSS pasted into OBS's **Custom CSS** box on the BubbleFacts browser
source. This page lists what stays put, so a look keeps working.

**Try a look without the app:** open
[`frontend/obs/design-preview.html`](../frontend/obs/design-preview.html) in a
browser. It shows sample fact bubbles, the Now Playing card and the Live Learn
banner, landscape and vertical, with a box to paste your CSS into. It loads
the overlay's own `obs-overlay.css`, so the five built-in Styles look the same
there as in OBS.

## What stays stable

**The `--bf-` settings** at the top of `frontend/obs/obs-overlay.css`. A look
sets these, usually on `:root`:

| Setting | What it does |
|---|---|
| `--bf-font`, `--bf-weight`, `--bf-letter-spacing` | Font family, weight and letter spacing of the fact bubbles. |
| `--bf-radius` | Corner radius of fact bubbles. |
| `--bf-bg-1`, `--bf-bg-2` | The two background colors of a bubble's gentle gradient. |
| `--bf-text`, `--bf-text-shadow` | Text color and shadow. |
| `--bf-accent` | Border color. |
| `--bf-border-width` | Border width. |
| `--bf-outline`, `--bf-outline-width` | The ring just outside the border. |
| `--bf-cursor` | Color of the little blinking arrow. `transparent` hides it. |
| `--bf-icon` | The icon at the left of each fact bubble: a character like `"\266B"`, or `url(...)`. Unset, the overlay rotates through its own set (Classic does this). Light, Minimal, Retro game and High contrast each set one plain character in the Style's text color. The app's **Icon** setting (`BUBBLE_ICON`) picks heart, star, moon or diamond under any Style, which are good starting points for your own. It sits in the icon gutter and never changes the bubble's size. |
| `--bf-sparkle` | Color of the three blinking sparkles. `transparent` hides them. |
| `--bf-toast-letter-spacing`, `--bf-toast-radius` | Letter spacing and corners of the Now Playing card and Live Learn banner. |
| `--bf-toast-bg-1`, `--bf-toast-bg-2` | Their background gradient. |
| `--bf-toast-text`, `--bf-toast-glow`, `--bf-toast-label` | Title color, its glow, and the color of the NOW PLAYING / LIVE LEARN label. |
| `--bf-toast-border`, `--bf-toast-border-width` | Their border. |
| `--bf-toast-highlight` | The thin highlight along the top edge. |
| `--bf-live-learn` | The Live Learn banner's border and label color. |
| `--bf-scale`, `--bf-vertical-scale` | Overall size, landscape and vertical. The app's Bubble size sets these, so a look usually leaves them alone. |

**The selectors** you may style directly:

- `.popup-bubble` (a fact bubble)
- `.song-toast` (the Now Playing card)
- `.song-toast .toast-label` (its label)
- `.song-toast.live-learn` (the Live Learn banner)

Anything else in the overlay's markup or CSS can change in any release.

**Renames.** A `--bf-` setting or selector above is never renamed or removed
without the release notes announcing it first, in the release before the change ships.

## Rules every look follows

- **No `font-size`.** Text size follows the source's height (and the app's Bubble size). The app's Bubble size is how a streamer makes text bigger.
- **Contrast of at least 4.5:1** between text and background, in every style you ship, including the Live Learn banner.
- **Animate only `transform` and `opacity`.** OBS draws browser sources without a GPU.
- **Keep `prefers-reduced-motion`.** If your look adds motion, switch it off under that setting.
- **Never hide a bubble.** No `display: none`, `visibility: hidden`, `opacity: 0` or moving one off screen, on any bubble, the credit bubble included. A look that hides bubbles looks like a bug on stream. (If bubbles vanish after a new look, empty the Custom CSS box.)

## Sharing a look

Say it's made for BubbleFacts and that it's yours (see
[TRADEMARKS.md](../TRADEMARKS.md)). Check it in the preview page, landscape and
vertical, before you share it.
