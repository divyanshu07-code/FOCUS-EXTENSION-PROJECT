const {
  dateKey,
  todayKey,
  lastNDays,
  normalizeSite,
  formatMinSec,
  escapeHTML,
  BADGE_DEFS,
  computeStreak,
} = FocusLockLib;

function dialSVG(fraction, isOver) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(fraction, 1));
  return `
    <svg width="36" height="36" viewBox="0 0 36 36">
      <circle class="dial-track" cx="18" cy="18" r="${r}" fill="none" stroke-width="4"></circle>
      <circle class="dial-fill ${isOver ? "over" : ""}" cx="18" cy="18" r="${r}" fill="none"
        stroke-width="4" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
        stroke-linecap="round"></circle>
    </svg>`;
}

function sparklineHTML(domain, limitMinutes, usage) {
  const days = lastNDays(7);
  const limitSec = limitMinutes * 60;
  const bars = days
    .map((day, i) => {
      const used = (usage[day] || {})[domain] || 0;
      const heightPct = limitSec > 0 ? Math.min((used / limitSec) * 100, 100) : 0;
      const isToday = i === days.length - 1;
      const over = used >= limitSec && limitSec > 0;
      return `<div class="spark-bar ${isToday ? "today" : ""} ${over ? "over-limit" : ""}"
        style="height:${Math.max(heightPct, 3)}%" title="${escapeHTML(day)}: ${escapeHTML(formatMinSec(used))}"></div>`;
    })
    .join("");
  return `<div class="sparkline">${bars}</div>`;
}

// ---------- global stats ----------

// Total minutes the person stayed *under* their daily budget, summed across
// every tracked day and site. A motivating, easy-to-explain "time saved"
// number: every day you don't blow your budget banks the unused minutes.
function computeMinutesSaved(sites, usage) {
  let savedSeconds = 0;
  Object.entries(usage).forEach(([, dayUsage]) => {
    Object.entries(dayUsage).forEach(([domain, usedSeconds]) => {
      const site = sites[domain];
      if (!site) return;
      const limitSec = site.limitMinutes * 60;
      if (limitSec <= 0) return;
      if (usedSeconds < limitSec) savedSeconds += limitSec - usedSeconds;
    });
  });
  return Math.round(savedSeconds / 60);
}

function computeBestDay(sites, usage) {
  const days = lastNDays(7);
  let best = null;
  days.forEach((day) => {
    const dayUsage = usage[day] || {};
    const total = Object.keys(sites).reduce((sum, domain) => sum + (dayUsage[domain] || 0), 0);
    if (best === null || total < best.total) {
      best = { day, total };
    }
  });
  return best;
}

function renderStats(sites, usage) {
  const panel = document.getElementById("stats-panel");
  const domainCount = Object.keys(sites).length;
  panel.classList.toggle("hidden", domainCount === 0);
  if (domainCount === 0) return;

  const saved = computeMinutesSaved(sites, usage);
  document.getElementById("stat-saved").textContent = saved.toLocaleString();

  const streak = computeStreak(sites, usage);
  document.getElementById("stat-streak").textContent = streak;
  document.getElementById("stat-streak-label").textContent = streak === 1 ? "day under budget" : "days under budget";

  const best = computeBestDay(sites, usage);
  const bestLabel = document.getElementById("stat-best-day");
  if (best) {
    const label = new Date(best.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
    bestLabel.textContent = `${label} (${formatMinSec(best.total)})`;
  } else {
    bestLabel.textContent = "—";
  }
}

// ---------- badges ----------

function renderBadges(earnedBadges, streak) {
  const row = document.getElementById("badge-row");
  row.innerHTML = BADGE_DEFS.map((badge) => {
    const earned = !!earnedBadges[badge.id];
    const toGo = badge.days - streak;
    const title = earned
      ? `${badge.name} — earned!`
      : `${badge.name} — ${toGo > 0 ? `${toGo} day${toGo === 1 ? "" : "s"} to go` : "almost there"}`;
    return `
      <div class="badge ${earned ? "earned" : "locked"}" title="${escapeHTML(title)}">
        <div class="badge-icon">${badge.icon}</div>
        <div class="badge-name">${escapeHTML(badge.name)}</div>
        <div class="badge-req">${badge.days}d</div>
      </div>`;
  }).join("");
}

// ---------- main render ----------

async function render() {
  const { sites = {}, usage = {}, earnedBadges = {} } = await chrome.storage.local.get([
    "sites",
    "usage",
    "earnedBadges",
  ]);
  const normalizedSites = {};
  Object.entries(sites).forEach(([domain, entry]) => {
    normalizedSites[domain] = normalizeSite(entry);
  });

  const todayUsage = usage[todayKey()] || {};

  document.getElementById("today-label").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  renderStats(normalizedSites, usage);

  const badgeSection = document.getElementById("badge-section");
  const hasSites = Object.keys(normalizedSites).length > 0;
  badgeSection.classList.toggle("hidden", !hasSites);
  if (hasSites) {
    renderBadges(earnedBadges, computeStreak(normalizedSites, usage));
  }

  const listEl = document.getElementById("site-list");
  const emptyEl = document.getElementById("empty-state");
  const domains = Object.keys(normalizedSites);

  emptyEl.classList.toggle("hidden", domains.length !== 0);
  listEl.innerHTML = "";

  domains.sort().forEach((domain) => {
    const site = normalizedSites[domain];
    const usedSec = todayUsage[domain] || 0;
    const limitSec = site.limitMinutes * 60;
    const fraction = limitSec > 0 ? usedSec / limitSec : 0;
    const isOver = usedSec >= limitSec;

    const row = document.createElement("div");
    row.className = "site-row";
    row.innerHTML = `
      <div class="site-top">
        <div class="dial">${dialSVG(fraction, isOver)}</div>
        <div class="site-info">
          <div class="site-domain">
            ${escapeHTML(domain)}
            ${site.schedule.enabled ? `<span class="sched-tag">${escapeHTML(site.schedule.start)}–${escapeHTML(site.schedule.end)}</span>` : ""}
            ${site.strictMode ? `<span class="strict-tag">strict</span>` : ""}
          </div>
          <div class="site-meta ${isOver ? "over" : ""}">
            ${isOver ? "Blocked for today" : `${formatMinSec(usedSec)} / ${site.limitMinutes}m`}
          </div>
        </div>
      </div>
      ${sparklineHTML(domain, site.limitMinutes, usage)}
    `;
    listEl.appendChild(row);
  });
}

document.getElementById("settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
chrome.storage.onChanged.addListener(render);
