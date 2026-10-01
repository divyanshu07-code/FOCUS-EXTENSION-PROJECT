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

**v2.0 & v2.1**
- **Scheduled blocking** — restrict tracking/blocking to specific days and a time window (e.g. weekdays 9am–5pm)
- **Snooze / grace period** — request up to 2 extra 5-minute windows per day per site
- **Weekly usage chart** — a 7-day bar chart per site (canvas-based) on the settings page
- **Toolbar badge** — remaining minutes for active site shows right on extension icon
- **Strict mode** — optional per-site toggle disabling snoozing entirely
- **Path-level rules** — wildcard/regex include/exclude lists matched against page path + query
- **Export/Import** — CSV usage history export & full JSON settings backup/restore

**v2.2 (Current)**
- **Structured Modular Architecture** — Clean separation of HTML views (`html/`), CSS styles (`css/`), JavaScript modules (`js/`), icons (`icons/`), and test suites (`tests/`)
- **Site Categorization** — Tag sites with categories (`Social`, `Video`, `News`, `Gaming`, `Shopping`, `General`)
- **Global Focus Pause Mode** — Quick 30-minute pause toggle directly from toolbar popup or keyboard shortcut
- **Extension Keyboard Shortcuts** — Press `Ctrl+Shift+F` (`Cmd+Shift+F` on Mac) to open popup or `Ctrl+Shift+P` (`Cmd+Shift+P`) to toggle 30m Global Pause
- **Inspirational Focus Quotes** — Curated motivational focus wisdom rendered on blocked screens
- **Live Search & Filter** — Instant domain search filter on the options management page

## Project Structure

```
focus-lock/
├── manifest.json            # Extension config (Manifest V3 + Commands)
├── package.json             # Jest dev dependencies & npm test scripts
├── .gitignore               # Build & node_modules exclusions
├── README.md                # Documentation & guide
├── SECURITY.md              # Security policies
├── html/                    # All extension HTML views
│   ├── popup.html           # Toolbar popup markup
│   ├── options.html         # Settings dashboard markup
│   └── blocked.html         # Limit hit block page markup
├── css/                     # All extension stylesheets
│   ├── popup.css            # Toolbar popup styles
│   ├── options.css          # Settings page styles
│   └── blocked.css          # Block page & quote card styles
├── js/                      # All JavaScript source logic
│   ├── lib.js               # Shared pure-function core library
│   ├── background.js        # Service worker (tracking, alarms, commands)
│   ├── popup.js             # Toolbar popup controller & stats dashboard
│   ├── options.js           # Settings manager & chart rendering
│   └── blocked.js           # Blocked screen controller & quote renderer
├── icons/                   # Extension icons (16x16, 48x48, 128x128)
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── tests/                   # Automated unit test suite
    └── lib.test.js          # Jest unit tests for pure logic
```

## Extension Keyboard Shortcuts

| Shortcut | Description |
| :--- | :--- |
| `Ctrl+Shift+F` (Mac: `Cmd+Shift+F`) | Open Focus Lock toolbar popup |
| `Ctrl+Shift+P` (Mac: `Cmd+Shift+P`) | Toggle 30-minute Global Focus Pause |

## Running the Tests

```bash
npm install
npm test
```

Runs the Jest test suite in `tests/lib.test.js` verifying all pure function logic in `js/lib.js`.

## Local Installation in Chrome

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select this directory.
5. Click the extension icon → **Manage tracked sites** to add your first domain and daily minute limit!
