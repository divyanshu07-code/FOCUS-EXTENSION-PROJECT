const {
  dateKey,
  todayKey,
  lastNDays,
  cleanDomain,
  isValidDomain,
  isUnsafeKey,
  clampInt,
  MAX_LIMIT_MINUTES,
  normalizeSite,
  formatMinSec,
  escapeHTML,
} = FocusLockLib;

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// ---------- day-of-week toggle buttons ----------

let selectedDays = new Set([0, 1, 2, 3, 4, 5, 6]);

function renderDayToggles() {
  const container = document.getElementById("day-toggles");
  container.innerHTML = "";
  DAY_LABELS.forEach((label, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day-btn" + (selectedDays.has(i) ? " active" : "");
    btn.textContent = label;
    btn.setAttribute("aria-pressed", selectedDays.has(i) ? "true" : "false");
    btn.setAttribute("aria-label", `Toggle ${label}`);
    btn.addEventListener("click", () => {
      if (selectedDays.has(i)) selectedDays.delete(i);
      else selectedDays.add(i);
      renderDayToggles();
    });
    container.appendChild(btn);
  });
}
renderDayToggles();

// ---------- schedule fields show/hide ----------

const scheduleCheckbox = document.getElementById("schedule-enabled");
const scheduleFields = document.getElementById("schedule-fields");
scheduleCheckbox.addEventListener("change", () => {
  scheduleFields.classList.toggle("hidden", !scheduleCheckbox.checked);
});

// ---------- form: add / edit ----------

const form = document.getElementById("site-form");
const formTitle = document.getElementById("form-title");
const submitBtn = document.getElementById("submit-btn");
const cancelEditBtn = document.getElementById("cancel-edit");
const domainInput = document.getElementById("domain-input");
const minutesInput = document.getElementById("minutes-input");
const editOriginalField = document.getElementById("edit-domain-original");
const strictModeCheckbox = document.getElementById("strict-mode");
const excludePatternsField = document.getElementById("exclude-patterns");
const includePatternsField = document.getElementById("include-patterns");
const searchInput = document.getElementById("search-sites");

function patternsFromTextarea(el) {
  return el.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resetForm() {
  form.reset();
  editOriginalField.value = "";
  formTitle.textContent = "Add a site";
  submitBtn.textContent = "Add site";
  cancelEditBtn.classList.add("hidden");
  domainInput.disabled = false;
  scheduleFields.classList.add("hidden");
  selectedDays = new Set([0, 1, 2, 3, 4, 5, 6]);
  renderDayToggles();
  strictModeCheckbox.checked = false;
  excludePatternsField.value = "";
  includePatternsField.value = "";
  document.getElementById("form-error").classList.add("hidden");
}

function startEdit(domain, site) {
  editOriginalField.value = domain;
  domainInput.value = domain;
  domainInput.disabled = true;
  minutesInput.value = site.limitMinutes;
  scheduleCheckbox.checked = !!site.schedule.enabled;
  scheduleFields.classList.toggle("hidden", !site.schedule.enabled);
  document.getElementById("start-time").value = site.schedule.start || "09:00";
  document.getElementById("end-time").value = site.schedule.end || "17:00";
  selectedDays = new Set(site.schedule.days || [0, 1, 2, 3, 4, 5, 6]);
  renderDayToggles();

  strictModeCheckbox.checked = !!site.strictMode;
  excludePatternsField.value = (site.pathRules.excludePatterns || []).join("\n");
  includePatternsField.value = (site.pathRules.includePatterns || []).join("\n");

  formTitle.textContent = `Edit ${domain}`;
  submitBtn.textContent = "Save changes";
  cancelEditBtn.classList.remove("hidden");
  domainInput.focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

cancelEditBtn.addEventListener("click", resetForm);

const formError = document.getElementById("form-error");

function showFormError(message) {
  formError.textContent = message;
  formError.classList.remove("hidden");
}

function clearFormError() {
  formError.textContent = "";
  formError.classList.add("hidden");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFormError();

  const originalDomain = editOriginalField.value;
  const domain = cleanDomain(domainInput.value);
  const minutes = clampInt(minutesInput.value, 1, MAX_LIMIT_MINUTES, NaN);

  if (!domain || !isValidDomain(domain)) {
    showFormError("Enter a valid domain, e.g. youtube.com or reddit.com.");
    return;
  }
  if (!Number.isFinite(minutes)) {
    showFormError(`Enter a daily limit between 1 and ${MAX_LIMIT_MINUTES} minutes.`);
    return;
  }

  const { sites = {} } = await chrome.storage.local.get(["sites"]);

  if (originalDomain && originalDomain !== domain) delete sites[originalDomain];

  sites[domain] = {
    limitMinutes: minutes,
    schedule: {
      enabled: scheduleCheckbox.checked,
      start: document.getElementById("start-time").value || "09:00",
      end: document.getElementById("end-time").value || "17:00",
      days: Array.from(selectedDays).sort(),
    },
    strictMode: strictModeCheckbox.checked,
    pathRules: {
      excludePatterns: patternsFromTextarea(excludePatternsField),
      includePatterns: patternsFromTextarea(includePatternsField),
    },
  };

  await chrome.storage.local.set({ sites });
  resetForm();
  renderSiteList();
});

// ---------- weekly chart ----------

function drawWeeklyChart(canvas, domain, limitMinutes, usage) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const days = lastNDays(7);
  const limitSec = limitMinutes * 60;
  const maxSec = Math.max(limitSec, ...days.map((d) => (usage[d] || {})[domain] || 0), 60);

  const barWidth = width / days.length;
  const padding = 6;

  days.forEach((day, i) => {
    const used = (usage[day] || {})[domain] || 0;
    const barHeight = Math.max((used / maxSec) * (height - 20), 2);
    const x = i * barWidth + padding / 2;
    const y = height - barHeight - 14;
    const isToday = i === days.length - 1;
    const over = limitSec > 0 && used >= limitSec;

    ctx.fillStyle = over ? "#e0665a" : isToday ? "#e8b45a" : "#2a2e3a";
    ctx.fillRect(x, y, barWidth - padding, barHeight);

    ctx.fillStyle = "#8b90a0";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    const label = new Date(day + "T00:00:00").toLocaleDateString(undefined, { weekday: "narrow" });
    ctx.fillText(label, x + (barWidth - padding) / 2, height - 3);
  });

  if (limitSec > 0) {
    const limitY = height - (limitSec / maxSec) * (height - 20) - 14;
    ctx.strokeStyle = "#6f8ae0";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, limitY);
    ctx.lineTo(width, limitY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------- render site list ----------

async function renderSiteList() {
  const { sites = {}, usage = {} } = await chrome.storage.local.get(["sites", "usage"]);
  const listEl = document.getElementById("site-list");
  const emptyEl = document.getElementById("empty-state");
  const filterQuery = (searchInput ? searchInput.value : "").trim().toLowerCase();

  let domains = Object.keys(sites).sort();
  if (filterQuery) {
    domains = domains.filter((d) => d.toLowerCase().includes(filterQuery));
  }

  emptyEl.classList.toggle("hidden", Object.keys(sites).length !== 0);
  listEl.innerHTML = "";

  domains.forEach((domain) => {
    const site = normalizeSite(sites[domain]);
    const usedToday = (usage[todayKey()] || {})[domain] || 0;
    const hasPathRules =
      (site.pathRules.excludePatterns && site.pathRules.excludePatterns.length) ||
      (site.pathRules.includePatterns && site.pathRules.includePatterns.length);

    const card = document.createElement("div");
    card.className = "site-card";
    card.innerHTML = `
      <div class="site-card-top">
        <div class="site-name-block">
          <div class="site-name">${escapeHTML(domain)}</div>
          <div class="site-sub">${escapeHTML(formatMinSec(usedToday))} used today / ${site.limitMinutes}m limit</div>
          <div class="tag-row">
            ${
              site.schedule.enabled
                ? `<span class="sched-pill">${escapeHTML(site.schedule.start)}\u2013${escapeHTML(site.schedule.end)} \u00b7 ${site.schedule.days
                    .map((d) => DAY_LABELS[d])
                    .join(" ")}</span>`
                : ""
            }
            ${site.strictMode ? `<span class="strict-pill">Strict mode</span>` : ""}
            ${hasPathRules ? `<span class="rules-pill">Path rules</span>` : ""}
          </div>
        </div>
        <div class="site-actions">
          <button class="icon-action" data-action="edit" data-domain="${escapeHTML(domain)}" aria-label="Edit ${escapeHTML(domain)}">Edit</button>
          <button class="icon-action" data-action="reset" data-domain="${escapeHTML(domain)}" aria-label="Reset today's usage for ${escapeHTML(domain)}">Reset today</button>
          <button class="icon-action danger" data-action="delete" data-domain="${escapeHTML(domain)}" aria-label="Delete ${escapeHTML(domain)}">Delete</button>
        </div>
      </div>
      <div class="chart-wrap">
        <canvas data-domain="${escapeHTML(domain)}" data-limit="${site.limitMinutes}" role="img" aria-label="7-day usage chart for ${escapeHTML(domain)}"></canvas>
      </div>
    `;
    listEl.appendChild(card);
  });

  listEl.querySelectorAll("canvas").forEach((canvas) => {
    drawWeeklyChart(canvas, canvas.dataset.domain, Number(canvas.dataset.limit), usage);
  });

  listEl.querySelectorAll(".icon-action").forEach((btn) => {
    btn.addEventListener("click", () => handleAction(btn.dataset.action, btn.dataset.domain));
  });
}

if (searchInput) {
  searchInput.addEventListener("input", () => renderSiteList());
}

async function handleAction(action, domain) {
  const { sites = {}, usage = {} } = await chrome.storage.local.get(["sites", "usage"]);

  if (action === "edit") {
    startEdit(domain, normalizeSite(sites[domain]));
  } else if (action === "delete") {
    if (!confirm(`Remove ${domain} from tracked sites? Its usage history will also be deleted.`)) return;
    delete sites[domain];
    Object.keys(usage).forEach((day) => {
      if (usage[day]) delete usage[day][domain];
    });
    await chrome.storage.local.set({ sites, usage });
    renderSiteList();
  } else if (action === "reset") {
    const day = todayKey();
    if (usage[day]) delete usage[day][domain];
    await chrome.storage.local.set({ usage });
    renderSiteList();
  }
}

// ---------- CSV export (usage history) ----------

document.getElementById("export-csv").addEventListener("click", async () => {
  const { usage = {} } = await chrome.storage.local.get(["usage"]);
  const rows = [["date", "domain", "seconds_used", "minutes_used"]];

  Object.keys(usage)
    .sort()
    .forEach((day) => {
      Object.entries(usage[day]).forEach(([domain, seconds]) => {
        rows.push([day, domain, seconds, (seconds / 60).toFixed(1)]);
      });
    });

  const csv = rows.map((r) => r.join(",")).join("\n");
  downloadBlob(csv, "text/csv", `focus-lock-usage-${todayKey()}.csv`);
});

// ---------- JSON export/import (full settings) ----------

document.getElementById("export-json").addEventListener("click", async () => {
  const { sites = {} } = await chrome.storage.local.get(["sites"]);
  const payload = {
    focusLockSettingsVersion: 1,
    exportedAt: new Date().toISOString(),
    sites,
  };
  downloadBlob(JSON.stringify(payload, null, 2), "application/json", `focus-lock-settings-${todayKey()}.json`);
});

const importInput = document.getElementById("import-json-input");
document.getElementById("import-json-btn").addEventListener("click", () => importInput.click());

importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  if (!file) return;

  const MAX_IMPORT_SITES = 500;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incomingSites = parsed && parsed.sites ? parsed.sites : parsed;

    if (!incomingSites || typeof incomingSites !== "object" || Array.isArray(incomingSites)) {
      throw new Error("File doesn't look like a Focus Lock settings export.");
    }

    const rawEntries = Object.entries(incomingSites).slice(0, MAX_IMPORT_SITES);
    const normalizedIncoming = {};
    let skipped = 0;

    for (const [rawDomain, entry] of rawEntries) {
      const domain = cleanDomain(rawDomain);
      if (!isValidDomain(domain) || isUnsafeKey(domain)) {
        skipped++;
        continue;
      }
      normalizedIncoming[domain] = normalizeSite(entry);
    }

    const importedCount = Object.keys(normalizedIncoming).length;
    if (importedCount === 0) {
      throw new Error("No valid sites found in that file.");
    }

    const merge = confirm(
      `Import ${importedCount} site(s) from this file?` +
        (skipped ? ` (${skipped} entr${skipped === 1 ? "y" : "ies"} skipped as invalid.)` : "") +
        `\n\nClick OK to merge with your current sites (imported sites overwrite ones with the same domain).\n` +
        `Click Cancel to abort the import.`
    );
    if (!merge) {
      importInput.value = "";
      return;
    }

    const { sites: currentSites = {} } = await chrome.storage.local.get(["sites"]);
    const merged = { ...currentSites, ...normalizedIncoming };

    await chrome.storage.local.set({ sites: merged });
    renderSiteList();
    alert(`Imported ${importedCount} site(s).${skipped ? ` Skipped ${skipped} invalid entr${skipped === 1 ? "y" : "ies"}.` : ""}`);
  } catch (err) {
    alert(`Couldn't import that file: ${err.message}`);
  } finally {
    importInput.value = "";
  }
});

function downloadBlob(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- clear all data ----------

document.getElementById("clear-all").addEventListener("click", async () => {
  if (!confirm("This deletes all tracked sites and usage history. This can't be undone. Continue?")) return;
  await chrome.storage.local.clear();
  resetForm();
  renderSiteList();
});

renderSiteList();
chrome.storage.onChanged.addListener(renderSiteList);
