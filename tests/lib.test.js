const {
  dateKey,
  todayKey,
  lastNDays,
  getDomain,
  cleanDomain,
  isValidDomain,
  isUnsafeKey,
  clampInt,
  normalizeSite,
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
  isGlobalPaused,
  getRandomQuote,
} = require("../js/lib.js");

describe("dateKey", () => {
  test("formats a date as YYYY-MM-DD, zero-padded", () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe("2026-01-05"); // Jan 5
    expect(dateKey(new Date(2026, 10, 23))).toBe("2026-11-23"); // Nov 23
  });

  test("defaults to now when no date is passed", () => {
    expect(dateKey()).toBe(todayKey());
  });
});

describe("lastNDays", () => {
  test("returns n consecutive day keys ending on `from`, oldest first", () => {
    const from = new Date(2026, 0, 10); // Jan 10 2026
    const days = lastNDays(4, from);
    expect(days).toEqual(["2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10"]);
  });

  test("handles month/year rollover", () => {
    const from = new Date(2026, 0, 1); // Jan 1 2026
    const days = lastNDays(3, from);
    expect(days).toEqual(["2025-12-30", "2025-12-31", "2026-01-01"]);
  });
});

describe("getDomain / cleanDomain", () => {
  test("getDomain strips protocol and www", () => {
    expect(getDomain("https://www.youtube.com/watch?v=123")).toBe("youtube.com");
    expect(getDomain("http://reddit.com/r/all")).toBe("reddit.com");
  });

  test("getDomain rejects non-http(s) URLs", () => {
    expect(getDomain("chrome://extensions")).toBeNull();
    expect(getDomain("not a url")).toBeNull();
  });

  test("cleanDomain normalizes user-typed input", () => {
    expect(cleanDomain("  https://www.Reddit.com/r/all ")).toBe("reddit.com");
    expect(cleanDomain("YouTube.com")).toBe("youtube.com");
  });
});

describe("normalizeSite", () => {
  test("upgrades a legacy v1 numeric entry", () => {
    const site = normalizeSite(30);
    expect(site.limitMinutes).toBe(30);
    expect(site.schedule.enabled).toBe(false);
    expect(site.strictMode).toBe(false);
    expect(site.pathRules).toEqual({ includePatterns: [], excludePatterns: [] });
  });

  test("fills in missing fields on a partial v2 entry", () => {
    const site = normalizeSite({ limitMinutes: 15 });
    expect(site.schedule.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(site.strictMode).toBe(false);
  });

  test("preserves a fully specified entry", () => {
    const input = {
      limitMinutes: 20,
      schedule: { enabled: true, start: "08:00", end: "12:00", days: [1, 2, 3] },
      strictMode: true,
      pathRules: { includePatterns: ["/r/all*"], excludePatterns: [] },
    };
    expect(normalizeSite(input)).toEqual(input);
  });
});

describe("isWithinSchedule", () => {
  test("always true when scheduling isn't enabled", () => {
    const site = { schedule: { enabled: false } };
    expect(isWithinSchedule(site, new Date(2026, 0, 1, 3, 0))).toBe(true);
  });

  test("true inside a same-day window, on an active day", () => {
    const site = { schedule: { enabled: true, start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] } };
    const wednesdayAt10am = new Date(2026, 0, 7, 10, 0); // Jan 7 2026 is a Wednesday
    expect(isWithinSchedule(site, wednesdayAt10am)).toBe(true);
  });

  test("false outside the time window", () => {
    const site = { schedule: { enabled: true, start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] } };
    const wednesdayAt8am = new Date(2026, 0, 7, 8, 0);
    expect(isWithinSchedule(site, wednesdayAt8am)).toBe(false);
  });

  test("false on an inactive day even inside the time window", () => {
    const site = { schedule: { enabled: true, start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] } };
    const saturdayAt10am = new Date(2026, 0, 10, 10, 0); // Jan 10 2026 is a Saturday
    expect(isWithinSchedule(site, saturdayAt10am)).toBe(false);
  });

  test("handles an overnight window correctly", () => {
    const site = { schedule: { enabled: true, start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] } };
    expect(isWithinSchedule(site, new Date(2026, 0, 7, 23, 30))).toBe(true);
    expect(isWithinSchedule(site, new Date(2026, 0, 7, 3, 0))).toBe(true);
    expect(isWithinSchedule(site, new Date(2026, 0, 7, 12, 0))).toBe(false);
  });
});

describe("matchesPattern", () => {
  test("wildcard matches with * as a glob", () => {
    expect(matchesPattern("/watch?v=abc123*", "/watch?v=abc123&t=42")).toBe(true);
    expect(matchesPattern("/r/programming*", "/r/programming/comments/1")).toBe(true);
    expect(matchesPattern("/r/programming*", "/r/aww")).toBe(false);
  });

  test("literal (non-wildcard) pattern requires an exact match", () => {
    expect(matchesPattern("/about", "/about")).toBe(true);
    expect(matchesPattern("/about", "/about/team")).toBe(false);
  });

  test("regex pattern wrapped in slashes", () => {
    expect(matchesPattern("/^\\/r\\/(programming|science)/i", "/r/science/top")).toBe(true);
    expect(matchesPattern("/^\\/r\\/(programming|science)/i", "/r/funny")).toBe(false);
  });

  test("blank pattern never matches", () => {
    expect(matchesPattern("   ", "/anything")).toBe(false);
  });

  test("absurdly long pattern is rejected outright (cheap ReDoS guard)", () => {
    const huge = "a".repeat(400);
    expect(matchesPattern(huge, huge)).toBe(false);
  });
});

describe("pathAllowsTracking", () => {
  test("no rules configured => always trackable", () => {
    const site = { pathRules: { includePatterns: [], excludePatterns: [] } };
    expect(pathAllowsTracking(site, "https://youtube.com/watch?v=xyz")).toBe(true);
  });

  test("exclude pattern frees a specific path from tracking", () => {
    const site = { pathRules: { includePatterns: [], excludePatterns: ["/watch?v=EDU123*"] } };
    expect(pathAllowsTracking(site, "https://youtube.com/watch?v=EDU123&t=10")).toBe(false);
    expect(pathAllowsTracking(site, "https://youtube.com/watch?v=OTHER")).toBe(true);
  });

  test("include pattern restricts tracking to only matching paths", () => {
    const site = { pathRules: { includePatterns: ["/r/all*"], excludePatterns: [] } };
    expect(pathAllowsTracking(site, "https://reddit.com/r/all/top")).toBe(true);
    expect(pathAllowsTracking(site, "https://reddit.com/r/funny")).toBe(false);
  });

  test("exclude takes priority over include", () => {
    const site = {
      pathRules: { includePatterns: ["/r/*"], excludePatterns: ["/r/programming*"] },
    };
    expect(pathAllowsTracking(site, "https://reddit.com/r/programming")).toBe(false);
    expect(pathAllowsTracking(site, "https://reddit.com/r/funny")).toBe(true);
  });
});

describe("limitExceeded", () => {
  test("false while under the limit", () => {
    expect(limitExceeded(10 * 60, 30)).toBe(false);
  });

  test("true once usage reaches the limit", () => {
    expect(limitExceeded(30 * 60, 30)).toBe(true);
    expect(limitExceeded(31 * 60, 30)).toBe(true);
  });

  test("snoozed always overrides an exceeded limit", () => {
    expect(limitExceeded(60 * 60, 30, true)).toBe(false);
  });
});

describe("formatMinSec", () => {
  test("formats seconds as Xm SSs", () => {
    expect(formatMinSec(0)).toBe("0m 00s");
    expect(formatMinSec(65)).toBe("1m 05s");
    expect(formatMinSec(3600)).toBe("60m 00s");
  });

  test("rounds fractional seconds", () => {
    expect(formatMinSec(65.6)).toBe("1m 06s");
  });
});

describe("isValidDomain", () => {
  test("accepts ordinary domains", () => {
    expect(isValidDomain("youtube.com")).toBe(true);
    expect(isValidDomain("sub.example.co.uk")).toBe(true);
  });

  test("rejects garbage, empty, and unsafe-key-shaped input", () => {
    expect(isValidDomain("")).toBe(false);
    expect(isValidDomain("not a domain")).toBe(false);
    expect(isValidDomain("__proto__")).toBe(false);
    expect(isValidDomain("<script>alert(1)</script>")).toBe(false);
    expect(isValidDomain("a".repeat(300) + ".com")).toBe(false);
  });
});

describe("isUnsafeKey", () => {
  test("flags prototype-pollution-prone keys, case-insensitively", () => {
    expect(isUnsafeKey("__proto__")).toBe(true);
    expect(isUnsafeKey("Constructor")).toBe(true);
    expect(isUnsafeKey("prototype")).toBe(true);
    expect(isUnsafeKey("youtube.com")).toBe(false);
  });
});

describe("clampInt", () => {
  test("clamps within range", () => {
    expect(clampInt(5000, 1, 1440, 30)).toBe(1440);
    expect(clampInt(0, 1, 1440, 30)).toBe(1);
    expect(clampInt(45, 1, 1440, 30)).toBe(45);
  });

  test("falls back on non-numeric input", () => {
    expect(clampInt("not a number", 1, 1440, 30)).toBe(30);
    expect(clampInt(undefined, 1, 1440, 30)).toBe(30);
    expect(clampInt(NaN, 1, 1440, 30)).toBe(30);
  });
});

describe("normalizeSite defensive sanitization", () => {
  test("clamps an out-of-range or garbage limitMinutes", () => {
    expect(normalizeSite({ limitMinutes: 99999 }).limitMinutes).toBe(1440);
    expect(normalizeSite({ limitMinutes: -5 }).limitMinutes).toBe(1);
    expect(normalizeSite({ limitMinutes: "banana" }).limitMinutes).toBe(30);
  });

  test("drops invalid schedule fields instead of trusting them", () => {
    const site = normalizeSite({
      limitMinutes: 20,
      schedule: { enabled: true, start: "not-a-time", end: "17:00", days: [1, 2, 99, -1, "x"] },
    });
    expect(site.schedule.start).toBe("09:00"); // fell back to default
    expect(site.schedule.end).toBe("17:00");
    expect(site.schedule.days).toEqual([1, 2]);
  });

  test("caps path-rule pattern length and list size", () => {
    const hugePattern = "a".repeat(1000);
    const manyPatterns = Array.from({ length: 100 }, (_, i) => `/p${i}*`);
    const site = normalizeSite({
      limitMinutes: 10,
      pathRules: { excludePatterns: [hugePattern, ...manyPatterns], includePatterns: null },
    });
    expect(site.pathRules.excludePatterns[0].length).toBeLessThanOrEqual(300);
    expect(site.pathRules.excludePatterns.length).toBeLessThanOrEqual(50);
    expect(site.pathRules.includePatterns).toEqual([]);
  });

  test("handles a completely malformed entry without throwing", () => {
    expect(() => normalizeSite(null)).not.toThrow();
    expect(() => normalizeSite(undefined)).not.toThrow();
    expect(() => normalizeSite("not an object")).not.toThrow();
    expect(normalizeSite(null).limitMinutes).toBe(30);
  });
});

describe("escapeHTML", () => {
  test("escapes all five dangerous characters", () => {
    expect(escapeHTML(`<img src=x onerror="alert('x')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;"
    );
  });

  test("passes through plain text unchanged", () => {
    expect(escapeHTML("youtube.com")).toBe("youtube.com");
  });
});

describe("dayIsUnderBudget", () => {
  const sites = { "a.com": { limitMinutes: 10 }, "b.com": { limitMinutes: 5 } };

  test("returns null when no sites are configured", () => {
    expect(dayIsUnderBudget("2026-01-01", {}, {})).toBeNull();
  });

  test("true when every configured site is under its limit that day", () => {
    const usage = { "2026-01-01": { "a.com": 100, "b.com": 200 } };
    expect(dayIsUnderBudget("2026-01-01", sites, usage)).toBe(true);
  });

  test("false when any configured site meets or exceeds its limit", () => {
    const usage = { "2026-01-01": { "a.com": 100, "b.com": 300 } }; // b.com hit 5m
    expect(dayIsUnderBudget("2026-01-01", sites, usage)).toBe(false);
  });

  test("a day with no recorded usage at all counts as under budget", () => {
    expect(dayIsUnderBudget("2026-01-01", sites, {})).toBe(true);
  });
});

describe("computeStreak", () => {
  const sites = { "a.com": { limitMinutes: 10 } };

  test("counts consecutive under-budget days ending today", () => {
    const now = new Date(2026, 0, 10); // Jan 10 2026
    const usage = {};
    for (let i = 0; i < 5; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      usage[dateKey(d)] = { "a.com": 60 }; // well under 10m limit
    }
    // Bounded to 5 days back so the (intentional) "missing usage counts as
    // clean" behavior for days before tracking began doesn't extend the walk.
    expect(computeStreak(sites, usage, now, 5)).toBe(5);
  });

  test("days with no recorded usage at all (e.g. before tracking started) don't break an otherwise unbounded walk", () => {
    const now = new Date(2026, 0, 10);
    const usage = { "2026-01-10": { "a.com": 60 } };
    expect(computeStreak(sites, usage, now, 30)).toBe(30);
  });

  test("stops counting at the first over-budget day", () => {
    const now = new Date(2026, 0, 10);
    const usage = {
      "2026-01-10": { "a.com": 60 },
      "2026-01-09": { "a.com": 60 },
      "2026-01-08": { "a.com": 700 }, // over the 10m limit
      "2026-01-07": { "a.com": 60 },
    };
    expect(computeStreak(sites, usage, now)).toBe(2);
  });

  test("returns 0 when no sites are configured", () => {
    expect(computeStreak({}, {}, new Date(2026, 0, 10))).toBe(0);
  });
});

describe("badgeIdsForStreak", () => {
  test("returns only the milestones reached, in ascending order", () => {
    expect(badgeIdsForStreak(0)).toEqual([]);
    expect(badgeIdsForStreak(6)).toEqual([]);
    expect(badgeIdsForStreak(7)).toEqual(["week"]);
    expect(badgeIdsForStreak(13)).toEqual(["week"]);
    expect(badgeIdsForStreak(14)).toEqual(["week", "fortnight"]);
    expect(badgeIdsForStreak(30)).toEqual(["week", "fortnight", "month"]);
    expect(badgeIdsForStreak(365)).toEqual(["week", "fortnight", "month"]);
  });

  test("BADGE_DEFS covers the requested 1-week / 14-day / 1-month milestones", () => {
    const days = BADGE_DEFS.map((b) => b.days);
    expect(days).toEqual([7, 14, 30]);
  });
});

describe("mergeEarnedBadges", () => {
  test("awards a badge the first time its streak length is reached", () => {
    const now = new Date(2026, 0, 10);
    const { earnedBadges, newlyEarned } = mergeEarnedBadges({}, 7, now);
    expect(newlyEarned.map((b) => b.id)).toEqual(["week"]);
    expect(earnedBadges.week).toBe(now.toISOString());
    expect(earnedBadges.fortnight).toBeUndefined();
  });

  test("does not re-award an already-earned badge", () => {
    const existing = { week: "2026-01-01T00:00:00.000Z" };
    const { earnedBadges, newlyEarned } = mergeEarnedBadges(existing, 8, new Date(2026, 0, 10));
    expect(newlyEarned).toEqual([]);
    expect(earnedBadges.week).toBe("2026-01-01T00:00:00.000Z"); // unchanged
  });

  test("a streak reset does not remove a previously-earned badge", () => {
    const existing = { week: "2026-01-01T00:00:00.000Z" };
    const { earnedBadges, newlyEarned } = mergeEarnedBadges(existing, 0, new Date(2026, 0, 10));
    expect(newlyEarned).toEqual([]);
    expect(earnedBadges.week).toBe("2026-01-01T00:00:00.000Z");
  });

  test("can award multiple new badges in a single jump", () => {
    const { earnedBadges, newlyEarned } = mergeEarnedBadges({}, 30, new Date(2026, 0, 10));
    expect(newlyEarned.map((b) => b.id)).toEqual(["week", "fortnight", "month"]);
    expect(Object.keys(earnedBadges).sort()).toEqual(["fortnight", "month", "week"]);
  });
});

describe("isGlobalPaused", () => {
  test("returns false when pause is null or in the past", () => {
    expect(isGlobalPaused(null)).toBe(false);
    expect(isGlobalPaused(Date.now() - 1000)).toBe(false);
  });

  test("returns true when pause timestamp is in the future", () => {
    expect(isGlobalPaused(Date.now() + 60000)).toBe(true);
  });
});

describe("getRandomQuote", () => {
  test("returns a quote object with quote and author properties", () => {
    const q = getRandomQuote("youtube.com");
    expect(q).toHaveProperty("quote");
    expect(q).toHaveProperty("author");
    expect(typeof q.quote).toBe("string");
  });
});

