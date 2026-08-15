const params = new URLSearchParams(location.search);
const domain = params.get("site") || "this site";
const limit = params.get("limit") || "your";
const returnUrl = params.get("returnUrl");
const tabId = params.get("tabId");

document.getElementById("site-name").textContent = domain;
document.getElementById("limit-min").textContent = limit;
document.getElementById("back-btn").addEventListener("click", () => history.back());

const snoozeBtn = document.getElementById("snooze-btn");
const note = document.getElementById("snooze-note");

// If strict mode is on for this site, don't even offer the snooze option.
chrome.storage.local.get(["sites"], ({ sites = {} }) => {
  const strict = Object.prototype.hasOwnProperty.call(sites, domain) && FocusLockLib.normalizeSite(sites[domain]).strictMode;
  if (strict) {
    snoozeBtn.disabled = true;
    snoozeBtn.textContent = "Snoozing disabled (strict mode)";
    note.textContent = "Strict mode is on for this site — no snoozing allowed.";
  }
});

snoozeBtn.addEventListener("click", () => {
  snoozeBtn.disabled = true;
  chrome.runtime.sendMessage(
    { type: "request-snooze", domain, returnUrl, tabId },
    (res) => {
      if (!res) {
        note.textContent = "Couldn't reach the extension — try reloading.";
        snoozeBtn.disabled = false;
        return;
      }
      if (!res.ok) {
        if (res.reason === "strict-mode") {
          note.textContent = "Strict mode is on for this site — no snoozing allowed.";
          snoozeBtn.textContent = "Snoozing disabled (strict mode)";
        } else {
          note.textContent = "You've used up today's snoozes for this site.";
        }
        snoozeBtn.disabled = true;
        return;
      }
      note.textContent = `Granted ${res.minutes} minutes. ${res.remaining} snooze(s) left today.`;
      // navigation back to returnUrl is handled by background.js
    }
  );
});
