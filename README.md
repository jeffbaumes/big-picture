# Big Picture

A whole life on one printable calendar, live at https://bigpicture.io27.com.
One row per year, one square per day, fading out across the estimated life expectancy. The site only *displays*;
everything is edited by an AI app through the MCP server.

- `public/index.html` — shell and styles (sign-in, controls)
- `public/poster.js` — the calendar, laid out directly in whole device pixels and drawn on a canvas
- `public/timeline.js` — the shared-axis timeline above the calendar: one Gantt chart plus a thin band per number series
- `public/analysis.js` — analysis mode: correlation matrix of the number series and a scatter plot for a clicked pair, following the timeline's range
- `public/icons.js` — the Heroicons (v2, outline, MIT) the page uses, as inline SVG paths
- `public/app.js` — sign-in, the page title, track toggles and the Grid / Analysis tabs (choices stored only in the browser), the grid's Display menu and zoom, hover and tap details, image export
- `src/worker.js` — Worker: sign-in, `GET /api/manifest` and `GET /api/t/<uid>/<track>/<rev>`, routing for `/mcp` and OAuth
- `src/store.js` — plain data access used by the page (read) and MCP (read/write); validates, nothing clever
- `src/mcp.js` — the MCP server (`/mcp`), `src/oauth.js` — OAuth 2.1 for it (same flow as Play With Food)
- `src/life.js` — the life-expectancy fade: two numbers (expected age, spread) → a survival curve
- `migrations/` — D1 schema, `scripts/demo.mjs` — fills a demo account through OAuth + MCP (an end-to-end test)
- `scripts/derive-weight-delta.mjs` — derives a daily weight-change series from the weigh-ins already on your account: straight-line interpolation across every gap, then day-over-day differences (`--max-gap` leaves long gaps empty, `--upload` saves it)
- `scripts/import-apple-health.mjs` — turns an Apple Health `export.zip` into daily series (sleep, steps, weight, resting heart rate, …); dry run by default, `--upload` saves through OAuth + MCP

## How the calendar is drawn

- **A strict grid of square weeks:** 52 columns, one row per year, no gaps between years or decades (the last square of a year also holds its 1–2 leftover days). It runs from birth until the life-expectancy fade has gone, so it's a tall, portrait poster you scroll. Squares cap at 26 CSS px, so on wide screens the grid stays centered.
- **Choosing what fills the grid:** each span or numeric track chip has a ★. Starring a track makes it the main grid (bars for a span track, a heatmap for a numeric one) and switches it on if it wasn't; click the filled ★ to clear it. Clicking the chip itself shows or hides the track, and the small label on each chip says how it is drawn (bars, heatmap, chart, ticks, dots). If you haven't picked one, the first switched-on span track is the main grid, or failing that the first switched-on numeric track as a heatmap, so showing only Weight shows a weight heatmap. The first time the page is opened (and when a new track appears) every span and event track starts on and numeric series start off (they start on only if there is nothing else); `config.hidden` keeps a track off. All of this is display only and stays in the browser.
- **The grid's top bar** (it stays in view while the calendar scrolls) holds *Display* (a menu of toggles: fade by life expectancy, gaps between squares, months, bar labels, today), the zoom buttons and *Save image*.
- **Zoom:** the − / + buttons step the square size. The largest step is *fit*: the grid fills the device width exactly, so there is never sideways scrolling. The default is up to 26 CSS px, or fit on narrower screens, and the choice is remembered in the browser.
- **Bars:** the focused (main) track is drawn as rounded bars inset slightly inside their squares, so there's air between rows and between neighbouring items. One bar per item per row, square-ended where it carries on to the next row, labelled with its name in bold at the start of the bar (inside the bar when it is tall enough, otherwise as haloed text over the bar's start, skipping a label that would collide with another), repeated every few rows down a long bar. Label text is centered by cap height on whole pixels: the font size is chosen so the capitals fill a whole number of pixels with equal space above and below. Overlapping items share the square's height, so rows never change size. Squares show only where no bar is.
- **Heatmaps:** the main grid can be a *series* track instead of a span track. Every week square is then colored by its value, like a contribution calendar: counts (`chart: "bars"` or `agg: "sum"`) are summed per week and shown in five levels with zero left empty (top level starts at the 95th percentile of non-zero weeks); other series (weight…) are averaged and shown as a continuous ramp. Config hints: `agg` (`sum`|`avg`|`max`), `min`/`max` (one day's scale), `scale: "sqrt"`, `hold`, and `grain: "week"` for data stored as one number per week square (dated at Jan 1 + 7n days of each year, which is how GitHub history is stored here to keep it small); those tracks skip the per-day strips. When squares are big enough each shows its seven days as thin strips; hovering or tapping lists the week's days.
- **Markers** (events, starts, ends) sit in the square of their date with a white edge; **heat strips** run along the bottom of each square (only when squares are at least 12 CSS px; otherwise charts below carry the series). A square shows the average of any readings in its week.
- **Pixel density:** the canvas is sized to the exact number of device pixels the page gives it, and every square and gap is a whole number of those, so nothing is resampled at any density, fractional ones included (1.25×, 2.625×, 3.5×…). The true pixels-per-CSS-pixel comes from the ResizeObserver `device-pixel-content-box` (falling back to `devicePixelRatio`), and it re-lays-out when zoom or screen changes. Below 3 device pixels per square the page scrolls sideways rather than squeeze.
- **Save image:** the grid bar's button lays the poster out again at a large fixed size (4200 px wide, 3× a 1400 CSS px page) and downloads a PNG sized for print. The name, age and day count live in the page's title bar, and are drawn above the grid only in this saved image. It steps down to smaller sizes if the browser can't make a canvas that big (phones). There is no browser printing; the image is the print path.

## The timeline (above the calendar)

Everything that is switched on is drawn on **one shared time axis**, so you can see many things at once:

- **One Gantt chart** holds every switched-on span (a bar, labelled inside it) and event (a diamond milestone with its label). They are stacked together into the fewest lanes by first-fit packing in start order, over all items so rows don't shuffle while panning; an event near the right end puts its label on the left so it still fits.
- **A thin band per switched-on number series**, each with its own vertical scale: a line through the readings (a long gap with no readings is joined by a dashed, lighter straight line, and hovering there shows an ≈ interpolated value) or bars for counts and sums. Bars use the finest bucket (the data's own week or day, then week, month, quarter, year) whose bars stay at least ~3.5px wide, so zooming in shows finer bars. Any series that is switched on shows up.
- **One zoom for everything.** Drag across the plots to zoom to that range; the overview strip on top shows the window and can be dragged to pan or have its edges dragged to resize; scrolling the wheel over the plots or the date axis zooms the range around the pointer (up = zoom in; over the overview strip it zooms around the window's middle). The wheel over the label gutter on the left, and scrolling down while everything is already showing, are left alone so the page scrolls past the timeline, Shift-drag or sideways scroll pans, a trackpad pinch also zooms, double-click resets. On a touch screen: pinch to zoom, drag to pan, tap for details.
- **Hover** draws a crosshair through every band with the date and age, and lists each series' value there (bars: the bucket's total; lines: the nearest reading, or "no reading here") plus every span covering that date and any event under the pointer.

## Analysis mode

The **Analysis** tab (next to **Grid**, under the timeline) swaps the calendar for a correlation view; the timeline stays on top and its selected range (drag across it, or leave it on everything) is the range analysed, updating live. Display only, computed in the browser from the points already loaded.

- **Matrix:** Pearson r between every pair of number series (all of them, switched on or not). Cells are blue for positive and rose for negative, stronger as |r| grows; faded cells have fewer than 10 pairs, `·` means too few overlapping periods (under 3) or one series doesn't vary. The diagonal shows how many periods each series has in range.
- **Scatter plot:** click a cell. x is the column's series, y the row's (the mirrored cell swaps them). Dotted least-squares line, with r, n, R² and the fit equation; hover a dot for its day, week or month.
- **Histogram:** click a diagonal cell (it shows how many periods that series has in range). The plot becomes that series' distribution over the same range and resolution: bars of a nice width (about √n of them, never under 1 for whole numbers), a dotted line at the mean, and mean, median, standard deviation and n. Hover a bar for its band, count and share.
- **Pairing:** *Compare by* day, week or month. A week is one of the calendar's own week squares (Jan 1 + 7n). Counts (`chart: "bars"` or `agg: "sum"`) are summed per period and everything else averaged; two series pair on the periods where both have a value. A period must lie fully inside the range, a total over a period the series only partly covers (its first or last) is dropped, and the day in progress is never counted. Series stored weekly (`grain: "week"`) can't be split into days, so they show `n/a` in Day mode.
- **Quiet periods:** count series usually store only the days or weeks something happened. By default the gaps between a count series' first and last entry are read as 0 (switch it off with *Count series: no entry means 0*).
- Mode and these choices are remembered in the browser only.

## Data model


Everything hangs off **tracks**:

| kind | rows | examples |
|---|---|---|
| `span` | items with `start` and optional `end` (overlaps allowed) | school, jobs, places lived |
| `event` | items with a single date | graduation, a move, a trip |
| `series` | one number per day (`points`) | weight, height, daily counts, mood |

Items carry a `label`, optional `color` and free-form `attrs` (`{employer, title, salary…}`) shown on hover.
`track.config` is free-form; the page understands `unit`, `min`, `max`, `chart` (`line|bars`), `hold` (days a reading stays on the heatmap) and `hidden`.
On the calendar, the main grid is the starred track (bars for a span track, a heatmap for a numeric one); other span/event tracks that are switched on appear as start/end ticks and switched-on series as heat strips. Every switched-on track also appears in the timeline above the calendar. Toggles on the page switch whole tracks on or off.

## Caching

Every track has a `rev` that changes only when its items or points change (`touch()` in `src/store.js`).
The page fetches a small manifest first (revalidated with an ETag, so usually a 304), then downloads only tracks whose
`rev` it doesn't already have. Track data lives at `/api/t/<user id>/<track>/<rev>` and is served
`private, immutable`, so the browser keeps it for good; the user id in the URL keeps accounts apart on a shared browser,
and sign-out clears the cache. The page re-checks when you return to the tab (and every 5 minutes), redrawing only if something changed.

## Connect an AI app

Add `https://bigpicture.io27.com/mcp` as a remote MCP server, sign in when asked, and say what to add.

- **Claude app:** Settings → Connectors → Add custom connector, paste the address.
- **ChatGPT:** Settings → Connectors → Advanced → turn on Developer mode, then Create a connector: paste the address and choose OAuth. Use it from a chat in Developer mode. (ChatGPT's menus change often; look for "custom connector" or "MCP server".)
- **Claude Code:** `claude mcp add --transport http bigpicture https://bigpicture.io27.com/mcp`

The server speaks OAuth 2.1 with dynamic client registration, so any remote-MCP client that supports that works.

## Develop

```sh
npm install
cf d1 migrations apply <d1-id> --local   # first time only
npm run dev                              # http://localhost:8787
npm run demo                             # sample data: demo / demo-password-1
```

## Deploy

```sh
cf d1 migrations apply a5a0ad0c-53e8-4ecf-b732-f15e3c737f42   # only when migrations/ changes
npm run deploy
```

Config is in `cloudflare.config.ts` (Worker, D1 binding, `bigpicture.io27.com`). Everything runs on the free tier:
one Worker, one D1 database, static assets. Signup is open and data is per account.

## License

[MIT](LICENSE)
