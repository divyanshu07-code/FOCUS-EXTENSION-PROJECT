// ---- Focus Lock v2: background service worker ----
// Tracks time spent on user-chosen domains, honors optional per-site
// schedules and path rules, and redirects to blocked.html once today's
// limit is hit. Supports a limited daily "snooze" grace period (unless
// strict mode is on for the site), a toolbar badge showing remaining
// minutes, and threshold notifications at 80%/100% of the daily limit.

importScripts("lib.js");
const {
  dateKey,
  todayKey,
  getDomain,
  normalizeSite,
  isWithinSchedule,
  pathAllowsTracking,
  limitExceeded: pureLimitExceeded,
  computeStreak,
  mergeEarnedBadges,
} = FocusLockLib;

const TICK_ALARM = "focus-lock-tick";
const CLEANUP_ALARM = "focus-lock-cleanup";
const MAX_HISTORY_DAYS = 35;
const SNOOZE_MINUTES = 5;
const MAX_SNOOZES_PER_DAY = 2;

const BADGE_OK_COLOR = "#e8b45a";
const BADGE_WARN_COLOR = "#e0665a";

// ---------- storage ----------

async function getState() {
  const {
    sites = {},
    usage = {},
    session = null,
    snoozes = {},
    snoozeUntil = {},
    notified = {},
    earnedBadges = {},
  } = await chrome.storage.local.get([
    "sites",
    "usage",
    "session",
    "snoozes",
    "snoozeUntil",
    "notified",
    "earnedBadges",
  ]);

  const normalizedSites = {};
  for (const [domain, entry] of Object.entries(sites)) {
    normalizedSites[domain] = normalizeSite(entry);
  }

  return { sites: normalizedSites, usage, session, snoozes, snoozeUntil, notified, earnedBadges };
}

async function setState(partial) {
  await chrome.storage.local.set(partial);
}

// ---------- session tracking ----------

async function flushSession(session, state) {
  if (!session) return state.usage;
  const elapsedSec = Math.max(0, Math.round((Date.now() - session.start) / 1000));
  const day = todayKey();
  const usage = { ...state.usage };
  usage[day] = { ...(usage[day] || {}) };
  usage[day][session.domain] = (usage[day][session.domain] || 0) + elapsedSec;
  await setState({ usage });
  return usage;
}

// Recomputes the under-budget streak from current usage/sites, persists any
// newly-unlocked badges, and fires a one-time celebratory notification for
// each. Cheap enough to call on every usage flush — it's just a scan over
// at most a few hundred day keys.
async function updateStreakBadges(usage, sites, earnedBadges) {
  const streak = computeStreak(sites, usage);
  const { earnedBadges: updated, newlyEarned } = mergeEarnedBadges(earnedBadges, streak);

  if (newlyEarned.length) {
    await setState({ earnedBadges: updated });
    for (const badge of newlyEarned) {
      try {
        await chrome.notifications.create(`focus-lock-badge-${badge.id}`, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: `${badge.icon} Badge unlocked: ${badge.name}`,
          message: `${streak} days under budget in a row. Keep it up!`,
          priority: 1,
        });
      } catch {
        /* notifications may be unavailable/denied — fail silently */
      }
    }
  }
  return updated;
}

function isSnoozed(domain, snoozeUntil) {
  const until = snoozeUntil[domain];
  return !!until && Date.now() < until;
}

async function limitExceeded(domain, usage, sites, snoozeUntil) {
  const site = sites[domain];
  if (!site) return false;
  const used = (usage[todayKey()] || {})[domain] || 0;
  return pureLimitExceeded(used, site.limitMinutes, isSnoozed(domain, snoozeUntil));
}

async function redirectIfBlocked(tab, domain, usage, sites, snoozeUntil) {
  if (await limitExceeded(domain, usage, sites, snoozeUntil)) {
    const site = sites[domain];
    const blockedUrl = chrome.runtime.getURL(
      `blocked.html?site=${encodeURIComponent(domain)}` +
        `&limit=${site.limitMinutes}` +
        `&returnUrl=${encodeURIComponent(tab.url)}` +
        `&tabId=${tab.id}`
    );
    try {
      await chrome.tabs.update(tab.id, { url: blockedUrl });
    } catch {
      /* tab may already be closed */
    }
    return true;
  }
  return false;
}

// Trackable = matches a configured site, AND inside its schedule window
// (if any), AND the specific path isn't excluded / is included (if rules
// are configured).
function isTrackable(url, domain, sites) {
  const site = sites[domain];
  if (!site) return false;
  if (!isWithinSchedule(site)) return false;
  return pathAllowsTracking(site, url);
}

// ---------- badge ----------

async function updateBadge(domain, usage, sites, snoozeUntil) {
  if (!domain || !sites[domain]) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const site = sites[domain];
  const used = (usage[todayKey()] || {})[domain] || 0;
  const remainingSec = site.limitMinutes * 60 - used;
  const snoozed = isSnoozed(domain, snoozeUntil);

  if (remainingSec <= 0 && !snoozed) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_WARN_COLOR });
    await chrome.action.setBadgeText({ text: "0" });
    return;
  }

  const remainingMin = Math.max(0, Math.ceil(remainingSec / 60));
  const isLow = remainingSec <= site.limitMinutes * 60 * 0.2; // <=20% left
  await chrome.action.setBadgeBackgroundColor({ color: isLow ? BADGE_WARN_COLOR : BADGE_OK_COLOR });
  await chrome.action.setBadgeText({ text: String(remainingMin) });
}

async function clearBadge() {
  await chrome.action.setBadgeText({ text: "" });
}

// ---------- threshold notifications (80% / 100%) ----------

async function maybeNotify(domain, usage, sites, state) {
  const site = sites[domain];
  if (!site) return;
  const used = (usage[todayKey()] || {})[domain] || 0;
  const limitSec = site.limitMinutes * 60;
  if (limitSec <= 0) return;

  const day = todayKey();
  const notified = { ...state.notified };
  notified[day] = { ...(notified[day] || {}) };
  const seenForDomain = { ...(notified[day][domain] || {}) };

  const fireOnce = async (key, id, title, message) => {
    if (seenForDomain[key]) return;
    seenForDomain[key] = true;
    try {
      await chrome.notifications.create(id, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title,
        message,
        priority: 1,
      });
    } catch {
      /* notifications may be unavailable/denied — fail silently */
    }
  };

  if (used >= limitSec) {
    await fireOnce(
      "100",
      `focus-lock-100-${domain}-${day}`,
      "Focus Lock — limit reached",
      `You've used your full ${site.limitMinutes}-minute budget for ${domain} today.`
    );
  } else if (used >= limitSec * 0.8) {
    await fireOnce(
      "80",
      `focus-lock-80-${domain}-${day}`,
      "Focus Lock — almost there",
      `You've used 80% of today's ${site.limitMinutes}-minute budget for ${domain}.`
    );
  }

  notified[day][domain] = seenForDomain;
  await setState({ notified });
}

// ---------- core loop ----------

async function refreshActiveTab() {
  const state = await getState();

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const domain = tab && tab.url ? getDomain(tab.url) : null;
  const trackable = domain && tab.url && isTrackable(tab.url, domain, state.sites);

  if (
    trackable &&
    state.session &&
    state.session.tabId === tab.id &&
    state.session.domain === domain
  ) {
    return;
  }

  const usage = await flushSession(state.session, state);
  await updateStreakBadges(usage, state.sites, state.earnedBadges);

  if (!trackable || !tab) {
    await setState({ session: null });
    await clearBadge();
    return;
  }

  const blocked = await redirectIfBlocked(tab, domain, usage, state.sites, state.snoozeUntil);
  if (blocked) {
    await setState({ session: null });
    await updateBadge(domain, usage, state.sites, state.snoozeUntil);
    return;
  }

  await setState({ session: { tabId: tab.id, domain, start: Date.now() } });
  await updateBadge(domain, usage, state.sites, state.snoozeUntil);
  await maybeNotify(domain, usage, state.sites, state);
}

async function tick() {
  const state = await getState();
  if (!state.session) return;

  const site = state.sites[state.session.domain];

  let tab;
  try {
    tab = await chrome.tabs.get(state.session.tabId);
  } catch {
    await setState({ session: null });
    await clearBadge();
    return;
  }

  // If the site fell outside its schedule/path rules since we last checked
  // (e.g. work hours ended, or the user browsed to an excluded path),
  // stop tracking without blocking.
  if (!site || !tab.url || !isTrackable(tab.url, state.session.domain, state.sites)) {
    await flushSession(state.session, state);
    await setState({ session: null });
    await clearBadge();
    return;
  }

  const usage = await flushSession(state.session, state);
  await updateStreakBadges(usage, state.sites, state.earnedBadges);
  const blocked = await redirectIfBlocked(tab, state.session.domain, usage, state.sites, state.snoozeUntil);

  if (blocked) {
    await setState({ session: null });
  } else {
    await setState({ session: { ...state.session, start: Date.now() } });
  }

  await updateBadge(state.session.domain, usage, state.sites, state.snoozeUntil);
  await maybeNotify(state.session.domain, usage, state.sites, state);
}

// Drop usage/snooze/notified data older than MAX_HISTORY_DAYS to keep storage tidy.
async function cleanupOldData() {
  const { usage = {}, snoozes = {}, notified = {} } = await chrome.storage.local.get([
    "usage",
    "snoozes",
    "notified",
  ]);
  const cutoff = Date.now() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;

  const prune = (obj) => {
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
      const t = new Date(key).getTime();
      if (!isNaN(t) && t >= cutoff) out[key] = val;
    }
    return out;
  };

  const prunedUsage = prune(usage);
  await setState({ usage: prunedUsage, snoozes: prune(snoozes), notified: prune(notified) });

  const { sites = {}, earnedBadges = {} } = await chrome.storage.local.get(["sites", "earnedBadges"]);
  const normalizedSites = {};
  for (const [domain, entry] of Object.entries(sites)) normalizedSites[domain] = normalizeSite(entry);
  await updateStreakBadges(prunedUsage, normalizedSites, earnedBadges);
}

// ---------- snooze handling (message from blocked.html) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "request-snooze") return;
  // onMessage (not onMessageExternal) only fires for messages sent from
  // within this extension's own contexts (background, popup, options,
  // blocked.html) — a web page cannot reach this listener. We still
  // validate every field defensively rather than trusting the shape of
  // `msg`, since blocked.html builds it from its own URL query string,
  // which the user could in principle hand-edit.
  if (typeof msg.domain !== "string" || !msg.domain) {
    sendResponse({ ok: false, reason: "bad-request" });
    return;
  }

  (async () => {
    const { sites = {}, snoozes = {}, snoozeUntil = {} } = await chrome.storage.local.get([
      "sites",
      "snoozes",
      "snoozeUntil",
    ]);

    if (!Object.prototype.hasOwnProperty.call(sites, msg.domain)) {
      sendResponse({ ok: false, reason: "unknown-site" });
      return;
    }
    const site = normalizeSite(sites[msg.domain]);

    if (site.strictMode) {
      sendResponse({ ok: false, reason: "strict-mode" });
      return;
    }

    const day = todayKey();
    const usedToday = (snoozes[day] || {})[msg.domain] || 0;

    if (usedToday >= MAX_SNOOZES_PER_DAY) {
      sendResponse({ ok: false, reason: "limit-reached" });
      return;
    }

    const newSnoozes = { ...snoozes, [day]: { ...(snoozes[day] || {}), [msg.domain]: usedToday + 1 } };
    const newSnoozeUntil = { ...snoozeUntil, [msg.domain]: Date.now() + SNOOZE_MINUTES * 60 * 1000 };
    await setState({ snoozes: newSnoozes, snoozeUntil: newSnoozeUntil });

    // Only navigate the tab back if returnUrl is a genuine http(s) page and
    // tabId is a real, currently-open tab — never trust these blindly, since
    // they came from a URL query string the user could have hand-edited.
    const tabId = Number(msg.tabId);
    if (Number.isInteger(tabId) && tabId >= 0 && typeof msg.returnUrl === "string") {
      let isHttpUrl = false;
      try {
        isHttpUrl = new URL(msg.returnUrl).protocol.startsWith("http");
      } catch {
        isHttpUrl = false;
      }
      if (isHttpUrl) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab) await chrome.tabs.update(tabId, { url: msg.returnUrl });
        } catch {
          /* tab no longer exists — nothing to navigate */
        }
      }
    }

    sendResponse({ ok: true, remaining: MAX_SNOOZES_PER_DAY - (usedToday + 1), minutes: SNOOZE_MINUTES });
  })();

  return true; // keep the message channel open for the async response
});

// ---------- event wiring ----------

function ensureAlarms() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 60 * 24 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  cleanupOldData();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  cleanupOldData();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) tick();
  if (alarm.name === CLEANUP_ALARM) cleanupOldData();
});

chrome.tabs.onActivated.addListener(() => refreshActiveTab());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) refreshActiveTab();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    const state = await getState();
    const usage = await flushSession(state.session, state);
    await updateStreakBadges(usage, state.sites, state.earnedBadges);
    await setState({ session: null });
    await clearBadge();
  } else {
    refreshActiveTab();
  }
});
