// ---- Focus Lock v2.2: background service worker ----
// Tracks time spent on user-chosen domains, honors optional per-site
// schedules and path rules, and redirects to html/blocked.html once today's
// limit is hit. Supports a limited daily "snooze" grace period, global pause mode,
// toolbar badges showing remaining minutes, and threshold notifications at 80%/100%.

importScripts("lib.js");
const {
  dateKey,
  todayKey,
  getDomain,
  normalizeSite,
  isWithinSchedule,
  pathAllowsTracking,
  limitExceeded: pureLimitExceeded,
  isGlobalPaused,
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
const BADGE_PAUSED_COLOR = "#7a829e";

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
    pausedUntil = null,
  } = await chrome.storage.local.get([
    "sites",
    "usage",
    "session",
    "snoozes",
    "snoozeUntil",
    "notified",
    "earnedBadges",
    "pausedUntil",
  ]);

  const normalizedSites = {};
  for (const [domain, entry] of Object.entries(sites)) {
    normalizedSites[domain] = normalizeSite(entry);
  }

  return { sites: normalizedSites, usage, session, snoozes, snoozeUntil, notified, earnedBadges, pausedUntil };
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
        /* notifications unavailable/denied */
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
      `html/blocked.html?site=${encodeURIComponent(domain)}` +
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

function isTrackable(url, domain, sites) {
  const site = sites[domain];
  if (!site) return false;
  if (!isWithinSchedule(site)) return false;
  return pathAllowsTracking(site, url);
}

// ---------- badge ----------

async function updateBadge(domain, usage, sites, snoozeUntil, pausedUntil) {
  if (isGlobalPaused(pausedUntil)) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_PAUSED_COLOR });
    await chrome.action.setBadgeText({ text: "OFF" });
    return;
  }

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
  const isLow = remainingSec <= site.limitMinutes * 60 * 0.2;
  await chrome.action.setBadgeBackgroundColor({ color: isLow ? BADGE_WARN_COLOR : BADGE_OK_COLOR });
  await chrome.action.setBadgeText({ text: String(remainingMin) });
}

async function clearBadge(pausedUntil) {
  if (isGlobalPaused(pausedUntil)) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_PAUSED_COLOR });
    await chrome.action.setBadgeText({ text: "OFF" });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
}

// ---------- threshold notifications (80% / 100%) ----------

async function maybeNotify(domain, usage, sites, state) {
  if (isGlobalPaused(state.pausedUntil)) return;
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
      /* notifications unavailable/denied */
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

  if (isGlobalPaused(state.pausedUntil)) {
    if (state.session) {
      await flushSession(state.session, state);
      await setState({ session: null });
    }
    await clearBadge(state.pausedUntil);
    return;
  }

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
    await clearBadge(state.pausedUntil);
    return;
  }

  const blocked = await redirectIfBlocked(tab, domain, usage, state.sites, state.snoozeUntil);
  if (blocked) {
    await setState({ session: null });
    await updateBadge(domain, usage, state.sites, state.snoozeUntil, state.pausedUntil);
    return;
  }

  await setState({ session: { tabId: tab.id, domain, start: Date.now() } });
  await updateBadge(domain, usage, state.sites, state.snoozeUntil, state.pausedUntil);
  await maybeNotify(domain, usage, state.sites, state);
}

async function tick() {
  const state = await getState();

  if (isGlobalPaused(state.pausedUntil)) {
    if (state.session) {
      await flushSession(state.session, state);
      await setState({ session: null });
    }
    await clearBadge(state.pausedUntil);
    return;
  }

  if (!state.session) return;

  const site = state.sites[state.session.domain];

  let tab;
  try {
    tab = await chrome.tabs.get(state.session.tabId);
  } catch {
    await setState({ session: null });
    await clearBadge(state.pausedUntil);
    return;
  }

  if (!site || !tab.url || !isTrackable(tab.url, state.session.domain, state.sites)) {
    await flushSession(state.session, state);
    await setState({ session: null });
    await clearBadge(state.pausedUntil);
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

  await updateBadge(state.session.domain, usage, state.sites, state.snoozeUntil, state.pausedUntil);
  await maybeNotify(state.session.domain, usage, state.sites, state);
}

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

// ---------- message handling ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "request-snooze") {
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
            /* tab no longer exists */
          }
        }
      }

      sendResponse({ ok: true, remaining: MAX_SNOOZES_PER_DAY - (usedToday + 1), minutes: SNOOZE_MINUTES });
    })();

    return true;
  }

  if (msg.type === "toggle-pause") {
    (async () => {
      const minutes = Number(msg.minutes) || 0;
      const pausedUntil = minutes > 0 ? Date.now() + minutes * 60 * 1000 : null;
      await setState({ pausedUntil });
      await refreshActiveTab();
      sendResponse({ ok: true, pausedUntil });
    })();
    return true;
  }
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
    await clearBadge(state.pausedUntil);
  } else {
    refreshActiveTab();
  }
});
