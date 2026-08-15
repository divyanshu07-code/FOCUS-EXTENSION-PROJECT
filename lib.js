// ---- Focus Lock: shared pure-function library ----
// No chrome.* calls in this file on purpose — everything here is plain
// JS so it can be unit-tested with Jest (see tests/lib.test.js) and
// reused unchanged by background.js (service worker, via importScripts),
// popup.js, and options.js (via a <script> tag).

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FocusLockLib = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULT_SCHEDULE = { enabled: false, start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4, 5, 6] };
  const DEFAULT_PATH_RULES = { includePatterns: [], excludePatterns: [] };

  // ---------- dates ----------

  function dateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate()
    ).padStart(2, "0")}`;
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function lastNDays(n, from = new Date()) {
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(from);
      d.setDate(d.getDate() - i);
      days.push(dateKey(d));
    }
    return days;
  }

  // ---------- domain / URL helpers ----------

  function getDomain(url) {
    try {
      const u = new URL(url);
      if (!u.protocol.startsWith("http")) return null;
      return u.hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function cleanDomain(raw) {
    let d = String(raw).trim().toLowerCase();
    d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
    return d.split("/")[0];
  }

  // ---------- site normalization (handles legacy v1/v2 shapes) ----------

  function sanitizePatternList(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => typeof p === "string")
      .map((p) => p.slice(0, MAX_PATTERN_LENGTH))
      .slice(0, 50); // cap list length too — no legitimate config needs more than this
  }

  function sanitizeSchedule(schedule) {
    const base = { ...DEFAULT_SCHEDULE };
    if (!schedule || typeof schedule !== "object") return base;
    const days = Array.isArray(schedule.days)
      ? schedule.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : base.days;
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    return {
      enabled: !!schedule.enabled,
      start: typeof schedule.start === "string" && timeRe.test(schedule.start) ? schedule.start : base.start,
      end: typeof schedule.end === "string" && timeRe.test(schedule.end) ? schedule.end : base.end,
      days: days.length ? [...new Set(days)] : base.days,
    };
  }

  function normalizeSite(entry) {
    if (typeof entry === "number") {
      return {
        limitMinutes: clampInt(entry, 1, MAX_LIMIT_MINUTES, 30),
        schedule: { ...DEFAULT_SCHEDULE },
        strictMode: false,
        pathRules: { ...DEFAULT_PATH_RULES },
      };
    }
    const e = entry && typeof entry === "object" ? entry : {};
    return {
      limitMinutes: clampInt(e.limitMinutes, 1, MAX_LIMIT_MINUTES, 30),
      schedule: sanitizeSchedule(e.schedule),
      strictMode: !!e.strictMode,
      pathRules: {
        includePatterns: sanitizePatternList(e.pathRules && e.pathRules.includePatterns),
        excludePatterns: sanitizePatternList(e.pathRules && e.pathRules.excludePatterns),
      },
    };
  }

  // ---------- schedule ----------

  function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function timeStrToMinutes(str) {
    const [h, m] = str.split(":").map(Number);
    return h * 60 + m;
  }

  // Is `now` inside this site's configured tracking/blocking window?
  // If scheduling isn't enabled, the site is always in-window (legacy behavior).
  function isWithinSchedule(site, now = new Date()) {
    const sched = site.schedule;
    if (!sched || !sched.enabled) return true;

    const day = now.getDay();
    if (!sched.days.includes(day)) return false;

    const nowMin = minutesSinceMidnight(now);
    const start = timeStrToMinutes(sched.start);
    const end = timeStrToMinutes(sched.end);

    if (start <= end) {
      return nowMin >= start && nowMin < end;
    }
    // overnight window, e.g. 22:00 -> 06:00
    return nowMin >= start || nowMin < end;
  }

  // ---------- path-level include/exclude rules ----------

  // A pattern is either:
  //  - a wildcard, e.g. "watch?v=abc123*"  (* matches anything, everything else literal)
  //  - a regex, wrapped in slashes, e.g. "/^\/r\/(programming|science)/i"
  // Matched against `pathname + search` of the URL (no protocol/host).
  const MAX_PATTERN_LENGTH = 300;

  function matchesPattern(pattern, str) {
    const p = String(pattern).trim();
    if (!p || p.length > MAX_PATTERN_LENGTH) return false;
    try {
      // Only treat as a /regex/flags literal if it starts with "/", has a
      // later "/" closing it, and whatever follows that closing slash is
      // nothing but valid regex flags. This keeps ordinary path wildcards
      // like "/r/all*" (which also start with "/") from being misread as
      // regex syntax.
      if (p.startsWith("/") && p.length > 1) {
        const lastSlash = p.lastIndexOf("/");
        const possibleFlags = p.slice(lastSlash + 1);
        if (lastSlash > 0 && /^[gimsuy]*$/.test(possibleFlags)) {
          const body = p.slice(1, lastSlash);
          const flags = possibleFlags || "i";
          return new RegExp(body, flags).test(str);
        }
      }
      const escaped = p.replace(/[.?+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp("^" + escaped + "$", "i").test(str);
    } catch {
      return false;
    }
  }

  // Given a site config and a full page URL, decide whether this specific
  // path should be tracked/blockable at all. Exclude patterns win over
  // include patterns. No rules configured => always trackable (whole domain).
  function pathAllowsTracking(site, url) {
    const rules = site.pathRules;
    if (!rules) return true;
    const include = rules.includePatterns || [];
    const exclude = rules.excludePatterns || [];
    if (!include.length && !exclude.length) return true;

    let pathAndQuery;
    try {
      const u = new URL(url);
      pathAndQuery = u.pathname + u.search;
    } catch {
      return true;
    }

    if (exclude.length && exclude.some((p) => matchesPattern(p, pathAndQuery))) return false;
    if (include.length) return include.some((p) => matchesPattern(p, pathAndQuery));
    return true;
  }

  // ---------- streaks & badges ----------

  // Milestones shown to the user as unlockable badges, in ascending order.
  // `days` is the length of a consecutive under-budget streak required.
  const BADGE_DEFS = [
    { id: "week", days: 7, name: "Week Streak", icon: "🔥" },
    { id: "fortnight", days: 14, name: "Two-Week Streak", icon: "⚡" },
    { id: "month", days: 30, name: "Month Master", icon: "🏆" },
  ];

  // A day counts as "under budget" if none of the currently-configured sites
  // went over its limit that day. Days with zero tracked sites don't count
  // either way (returns null) — there's nothing to judge yet.
  function dayIsUnderBudget(day, sites, usage) {
    const dayUsage = (usage && usage[day]) || {};
    const domains = Object.keys(sites || {});
    if (domains.length === 0) return null;
    return domains.every((domain) => {
      const site = sites[domain];
      const used = dayUsage[domain] || 0;
      return used < site.limitMinutes * 60;
    });
  }

  // Consecutive under-budget days counting back from `now`, inclusive of
  // today-so-far. Days with no verdict (null) are skipped without breaking
  // the streak; the walk stops at the first day that *was* over budget.
  // Capped to avoid an unbounded loop if history is somehow huge.
  function computeStreak(sites, usage, now = new Date(), maxLookback = 400) {
    let streak = 0;
    for (let i = 0; i < maxLookback; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const status = dayIsUnderBudget(dateKey(d), sites, usage);
      if (status === false) break;
      if (status === true) streak++;
    }
    return streak;
  }

  // Given a streak length, which badge ids does it qualify for?
  function badgeIdsForStreak(streak) {
    return BADGE_DEFS.filter((b) => streak >= b.days).map((b) => b.id);
  }

  // Folds newly-qualified badges into a persisted `{ [badgeId]: isoDateEarned }`
  // record. Once earned, a badge stays recorded even if the streak later
  // resets — badges mark an achievement reached, not a current state.
  // Returns { earnedBadges, newlyEarned } where newlyEarned lists badge defs
  // unlocked by *this* call (empty if nothing new).
  function mergeEarnedBadges(existingEarned, streak, now = new Date()) {
    const earnedBadges = { ...(existingEarned || {}) };
    const newlyEarned = [];
    for (const badge of BADGE_DEFS) {
      if (streak >= badge.days && !earnedBadges[badge.id]) {
        earnedBadges[badge.id] = now.toISOString();
        newlyEarned.push(badge);
      }
    }
    return { earnedBadges, newlyEarned };
  }

  // ---------- limit logic ----------

  // Pure version: caller resolves usedSeconds/limitMinutes/snoozed from storage.
  function limitExceeded(usedSeconds, limitMinutes, snoozed = false) {
    if (snoozed) return false;
    return usedSeconds >= limitMinutes * 60;
  }

  // ---------- formatting ----------

  function formatMinSec(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}m ${String(sec).padStart(2, "0")}s`;
  }

  // ---------- safety limits & validation ----------

  const MAX_DOMAIN_LENGTH = 253; // max valid DNS hostname length
  const MAX_LIMIT_MINUTES = 1440; // can't set a daily budget over 24h
  const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  // Rejects keys that would let an imported/settings object tamper with an
  // object's prototype chain when spread/assigned (e.g. `obj["__proto__"] = x`).
  // Belt-and-suspenders: domain values are also validated by shape (below),
  // which already excludes these, but this guard is applied anywhere an
  // externally-supplied string is used as an object key.
  function isUnsafeKey(key) {
    return UNSAFE_KEYS.has(String(key).toLowerCase());
  }

  // A conservative hostname check: labels of letters/digits/hyphens
  // separated by dots, ending in a 2+ letter TLD-like label. Deliberately
  // strict — this is a domain *key* used to match tabs, not a full RFC 1035
  // validator, so anything ambiguous is rejected rather than guessed at.
  function isValidDomain(domain) {
    const d = String(domain);
    if (!d || d.length > MAX_DOMAIN_LENGTH) return false;
    if (isUnsafeKey(d)) return false;
    return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d);
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // ---------- output safety ----------

  // Escapes a string for safe interpolation into innerHTML, whether it ends
  // up as text content or inside a double-quoted attribute. Domain names are
  // user-typed, so even though the only "attacker" is the same user, this
  // closes an easy self-XSS vector (e.g. a domain field containing
  // `"><img src=x onerror=...>`) and is just correct practice for any
  // untrusted string reaching innerHTML.
  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  return {
    DEFAULT_SCHEDULE,
    DEFAULT_PATH_RULES,
    MAX_DOMAIN_LENGTH,
    MAX_LIMIT_MINUTES,
    dateKey,
    todayKey,
    lastNDays,
    getDomain,
    cleanDomain,
    isValidDomain,
    isUnsafeKey,
    clampInt,
    normalizeSite,
    minutesSinceMidnight,
    timeStrToMinutes,
    isWithinSchedule,
    matchesPattern,
    pathAllowsTracking,
    limitExceeded,
    formatMinSec,
    escapeHTML,
    BADGE_DEFS,
    dayIsUnderBudget,
    computeStreak,
    badgeIdsForStreak,
    mergeEarnedBadges,
  };
});
