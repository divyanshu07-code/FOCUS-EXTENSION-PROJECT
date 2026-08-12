# Security


Focus Lock is a small, single-user, fully local Chrome extension. This document explains what data it touches, what permissions it needs and why, and what's been done to keep it safe to run.

## Data handling

- **No network requests.** The extension makes zero `fetch`/`XMLHttpRequest`/remote calls of any kind. There is no backend, no analytics, no telemetry, no third-party script loaded from a CDN.
- **No remote code execution.** Every script is bundled in the extension package. `manifest.json` sets an explicit Content-Security-Policy (`script-src 'self'; object-src 'none'; base-uri 'none'`) on top of Manifest V3's already-strict defaults, so even a compromised dependency couldn't inject or `eval` remote code — and nothing in the codebase uses `eval`, `new Function`, or dynamic `<script>` injection to begin with.
- **All data stays local.** Sites, usage history, and settings live in `chrome.storage.local`, scoped to your Chrome profile. Nothing leaves the machine. Export/import (CSV/JSON) is a manual, user-initiated file download/upload — Focus Lock never uploads it anywhere.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `storage` | Persist tracked sites, usage history, and settings. |
| `tabs` | Read the active tab's URL to know which domain/path is loaded, and redirect to the block page when a limit is hit. |
| `alarms` | Periodic (1-minute) time-tracking checkpoints and daily cleanup, resilient to the service worker being terminated and restarted. |
| `notifications` | The 80%/100% budget-threshold alerts. |
| `host_permissions: <all_urls>` | The whole point of the extension is tracking/blocking *domains you choose at runtime* — there's no fixed list to scope permissions to ahead of time. This is the standard tradeoff for any "block sites you configure" extension (compare uBlock Origin, StayFocusd, etc.), not an attempt to read content off pages. Focus Lock never reads page content, DOM, forms, or cookies — only `tab.url` for the active tab, to extract the domain and path.

## XSS / injection hardening

Several fields (domain names, path-rule patterns) are user-typed and get rendered back into the UI via `innerHTML` templates (for the dial/sparkline/chart markup). All such values are passed through a shared `escapeHTML()` helper (`lib.js`) before interpolation, so a domain like `"><img src=x onerror=...>` can't break out of the markup — this matters even though the only person who could type it is the same person viewing it (there's no multi-user/shared-data path in this extension), because it's the correct default and costs nothing.

Everywhere else (`blocked.js`), user-controlled values are inserted via `textContent`, not `innerHTML`, which never parses HTML in the first place.

## Input validation

- **Domain names** are validated against a conservative hostname pattern (`isValidDomain` in `lib.js`) before a site can be saved from the settings form — garbage input is rejected with an inline error instead of silently being stored.
- **Daily limits** are clamped to a sane range (1–1440 minutes) via `clampInt`, both on manual entry and when loading any stored/imported site — so a corrupted or malicious value can never turn into `NaN` and propagate into the badge, notifications, or chart math.
- **`normalizeSite`** (the single choke point every stored/imported site passes through) independently re-validates every field — schedule days/times, strict mode, and path-rule pattern lists are all sanitized or reset to safe defaults rather than trusted as-is, regardless of where the data came from.

## Prototype-pollution guard on import

Importing a settings JSON file merges its keys (domain names) into a plain JS object. Since object keys like `"__proto__"`, `"constructor"`, and `"prototype"` can, in some assignment patterns, be used to tamper with an object's prototype chain, the import path explicitly rejects any incoming key that matches these (`isUnsafeKey`) — in addition to requiring every key to already look like a valid domain, which excludes them anyway. Import is also capped at 500 entries per file and reports how many entries were skipped as invalid, rather than silently dropping or accepting bad data.

## Message-channel validation (blocked page ↔ background)

The block page (`blocked.html`) messages the background service worker to request a snooze. `chrome.runtime.onMessage` (as opposed to `onMessageExternal`) is only reachable from the extension's own contexts to begin with — an arbitrary web page cannot call into it. On top of that, the handler still treats every field as untrusted input rather than assuming its own shape:
- `domain` must be a non-empty string that matches an existing tracked site (looked up with `hasOwnProperty`, so a crafted `"__proto__"` domain can't resolve to `Object.prototype` and slip through as if it were a real site).
- `tabId` must be a real, currently-open tab (checked with `chrome.tabs.get` before navigating it anywhere).
- `returnUrl` must parse as an `http(s)` URL before the tab is ever navigated to it — closing off any path to navigating a tab to a `javascript:`/`chrome:`/`file:` URL even if the query string were hand-edited.

## Regex input (path-level rules)

Path-level include/exclude rules accept either a wildcard or a full regular expression (wrapped in `/like this/i`). Since these patterns run against every page load on a tracked domain, a pathological regex (catastrophic backtracking) could in theory make the pattern check slow. Mitigations in place:

- Regex compilation and matching are wrapped in `try/catch` — a malformed pattern fails closed (treated as "doesn't match") rather than throwing.
- Patterns longer than 300 characters are rejected outright as a cheap guard against absurd input, before any regex is even compiled.

This is treated as a robustness concern rather than a security boundary, since the only person who can configure a site's patterns is the same person running the browser — there's no scenario where a third party supplies the pattern.

## Reporting an issue

This is a personal/portfolio project without a formal disclosure program, but if you find a real security issue, please open a GitHub issue (or a private security advisory, if enabled on the repo) rather than a public PR with exploit details.
