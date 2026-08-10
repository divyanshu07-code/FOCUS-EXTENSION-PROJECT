# Focus Lock — Reading Time & Distraction Blocker

A Chrome extension that tracks how much time you spend on sites you choose (Reddit, YouTube, Twitter, etc.) and automatically blocks them once you hit your self-set daily limit — optionally only during a schedule you define.

Built by **Divyanshu**.

## Why

Most site blockers just block a site outright, all day, every day. Focus Lock instead gives you a **daily time budget per site**, with an **optional schedule** — you can still check Reddit for 20 minutes in the evening, but it's blocked entirely during your 9-to-5 work hours, and it won't cut you off mid-task if you just need a moment to finish up (see: snooze, below). It also keeps score, so opening the popup itself feels like a small win.

## Features

**Core**
- Track any number of domains, each with its own daily minute limit
- Time is only counted while the tab is actually active/focused (not just open in the background)
- Limits reset automatically at midnight — no manual reset needed
- Automatic redirect to a block page once the daily limit is hit

**v2.0**
- **Scheduled blocking** — restrict tracking/blocking to specific days and a time window (e.g. only enforce the limit on weekdays, 9am–5pm)
- **Snooze / grace period** — from the block page, request up to 2 extra 5-minute windows per day per site, for finishing up something important without fully disabling the blocker
- **Weekly usage chart** — a 7-day bar chart per site (canvas-based, no chart library) on the settings page, with the daily limit shown as a reference line
- **Dedicated settings page** — add/edit/delete sites, configure schedules, reset a single day's usage, or wipe all data
- **CSV export** — download your full usage history for your own analysis
- **Popup dashboard** — quick-glance progress dials + a mini 7-day sparkline per tracked site, with a link into full settings

**v2.1**
- **Overall stats in the popup** — total minutes saved by staying under budget, your current streak of days under budget, and your best (lightest-usage) day this week. Meant to be the kind of thing that makes you actually want to open the extension.
- **Toolbar badge** — the remaining minutes for whatever site you're currently on shows right on the extension icon (turns red once you're in the last 20%, or hit 0), so you don't need to open the popup to know where you stand
- **Browser notifications** — a notification fires at 80% and at 100% of a site's daily limit, so you find out before (or right as) you get redirected, not just after
- **Strict mode** — an optional per-site toggle that disables snoozing entirely, for sites where you want zero escape hatch
- **Path-level rules** — per-site include/exclude lists (wildcard or full regex) matched against the page path + query string, e.g. block `youtube.com` generally but always allow a specific `watch?v=...`, or only enforce the limit on `reddit.com/r/all` and leave the rest of the domain untouched
- **Import/export settings as JSON** — back up your full site configuration (limits, schedules, strict mode, path rules) or move it to another machine, separate from the usage-history CSV export
- **Onboarding empty states** — first run shows a short numbered walkthrough instead of a blank list, in both the popup and settings page
- **Keyboard accessibility pass** — visible focus rings (`:focus-visible`) on every interactive element, proper `aria-pressed`/`aria-label`/`role="group"` on the day-of-week toggles, and a logical tab order throughout the options page
- **Unit tests** — a Jest suite covering the pure logic (`dateKey`, `isWithinSchedule`, `matchesPattern`, `pathAllowsTracking`, `limitExceeded`, `formatMinSec`, etc.), extracted into `lib.js` so it's testable outside the extension runtime

## Tech

- **Manifest V3** Chrome Extension
- Vanilla JavaScript, HTML, CSS — no frameworks, no build step, no chart library (charts are hand-drawn with the Canvas API)
- `chrome.storage.local` for persistence
- `chrome.alarms` for periodic time-tracking checkpoints and daily data cleanup (survives service worker restarts/termination)
- `chrome.tabs` / `chrome.windows` events to detect active-tab and focus changes
- `chrome.runtime` messaging between the blocked page and the background service worker (for the snooze feature)
- `chrome.action.setBadgeText` / `setBadgeBackgroundColor` for the toolbar badge
- `chrome.notifications` for the 80%/100% threshold alerts
- Jest for unit tests of the pure logic in `lib.js`

## How it works

1. `lib.js` holds every pure function (no `chrome.*` calls) — date math, schedule checks, path-rule matching, limit checks, formatting. It's written UMD-style so the exact same file is used by `background.js` (via `importScripts`), by `popup.html`/`options.html` (via a `<script>` tag, attached to `window.FocusLockLib`), and by the Jest test suite (via `require`).
2. `background.js` runs as a service worker and listens for tab activation, tab URL changes, and window focus changes.
3. When the active tab's domain matches a tracked site, the current time falls inside that site's schedule (if one is set), **and** the specific path isn't excluded by path rules, it starts a timed "session."
4. Every minute, an alarm checkpoints the elapsed time into `chrome.storage.local`, keyed by today's date and domain; re-checks the limit; updates the toolbar badge with remaining minutes; and fires an 80%/100% notification if the site just crossed that threshold for the first time today.
5. If usage for a domain crosses its daily limit, the active tab is redirected to `blocked.html` — unless a snooze is currently active for that domain.
6. From the block page, the user can request a 5-minute snooze (max 2/day/site) — unless **strict mode** is on for that site, in which case the snooze button is disabled outright. A snooze request messages the background worker, which temporarily overrides the limit check and sends the tab back to where it was.
7. `options.html`/`options.js` is the full management UI: add/edit/delete sites, configure limits, schedules, strict mode, and path-level include/exclude rules; view a 7-day usage chart per site; reset a day's count; export usage as CSV or full settings as JSON (and import settings back in); or clear all data.
8. `popup.html`/`popup.js` is the quick-glance dashboard: overall stats (minutes saved, streak, best day) computed straight from stored usage/site data, plus per-site dials and sparklines, linking into the settings page for anything else.
9. A daily alarm prunes usage/snooze/notification records older than 35 days so storage doesn't grow unbounded.

### Path-level rules, in more detail

Each site can have an `excludePatterns` list, an `includePatterns` list, or both, matched against the URL's path + query string (not the domain, which is already the site key):

- **Exclude patterns** are always checked first — any path matching one is never tracked or blocked, no matter what.
- **Include patterns**, if set, restrict tracking/blocking to *only* the matching paths; everything else on that domain is left alone entirely.
- A pattern is a wildcard by default (`*` matches anything, e.g. `/watch?v=abc123*`), or a full regex if wrapped in slashes with optional flags (e.g. `/^\/r\/(programming|science)/i`).

## Install locally (not yet on the Chrome Web Store)

1. Clone this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder
5. Click the extension icon → **Manage tracked sites** → add a domain, a daily limit, and (optionally) a schedule, strict mode, or path rules

## Running the tests

```bash
npm install
npm test
```

This runs the Jest suite in `tests/lib.test.js` against the pure functions in `lib.js` — no browser or extension APIs required.

## Project structure

```
focus-lock/
├── manifest.json          # Extension config (Manifest V3)
├── lib.js                 # Shared pure functions (dates, schedule, path rules, limits, formatting) — tested + reused everywhere
├── background.js          # Service worker: time tracking, scheduling, path rules, blocking, snooze, badge, notifications, cleanup
├── popup.html/.css/.js    # Toolbar popup: overall stats + quick-view dashboard
├── options.html/.css/.js  # Full settings page: CRUD, schedules, strict mode, path rules, weekly charts, CSV/JSON export+import
├── blocked.html/.js       # Shown when a site's limit is hit; handles snooze requests (disabled under strict mode)
├── tests/lib.test.js      # Jest unit tests for lib.js
├── package.json           # Jest dev dependency + `npm test` script
└── icons/                 # Extension icons
```

## Roadmap / ideas for extending this further

- [ ] Sync settings across devices with `chrome.storage.sync` instead of `local`
- [ ] Custom block-page messages or motivational quotes per site
- [ ] Monthly/longer-range history view, not just 7 days
- [ ] Firefox port (the WebExtensions API used here is largely compatible)
- [ ] Publish to the Chrome Web Store

## License

MIT
