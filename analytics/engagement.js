(function () {
  const IDLE_TIMEOUT_MS = 15000;
  const MILESTONES_SEC = [15, 30, 60, 120, 300];
  const SCROLL_MILESTONES = [25, 50, 75, 100];
  const LAST_SESSION_KEY = "claw:engagement:last-session";
  const SESSIONS_KEY = "claw:engagement:sessions";
  const VISITOR_ID_KEY = "claw:engagement:visitor-id";
  const MAX_STORED_SESSIONS = 200;

  function randomId(prefix) {
    return prefix + "-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
  }

  function readJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function getVisitorId() {
    const existing = window.localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;
    const created = randomId("visitor");
    window.localStorage.setItem(VISITOR_ID_KEY, created);
    return created;
  }

  const state = {
    sessionId: randomId("session"),
    visitorId: getVisitorId(),
    path: window.location.pathname || "/",
    referrer: document.referrer || "",
    sessionStartedAt: Date.now(),
    lastTickAt: Date.now(),
    lastInteractionAt: Date.now(),
    engagedMs: 0,
    interactions: 0,
    maxScrollPct: 0,
    sentMilestones: new Set(),
    sentScrollMilestones: new Set(),
    primaryActionCounts: {},
  };

  function isVisible() {
    return document.visibilityState === "visible";
  }

  function isActive(now) {
    return now - state.lastInteractionAt <= IDLE_TIMEOUT_MS;
  }

  function sendMilestoneEvents() {
    const engagedSeconds = Math.floor(state.engagedMs / 1000);
    for (const milestone of MILESTONES_SEC) {
      if (engagedSeconds < milestone || state.sentMilestones.has(milestone)) continue;
      state.sentMilestones.add(milestone);
      if (typeof window.plausible === "function") {
        window.plausible("engaged_time_milestone", {
          props: { seconds: milestone },
        });
      }
    }
  }

  function sendScrollMilestoneEvents() {
    for (const milestone of SCROLL_MILESTONES) {
      if (state.maxScrollPct < milestone || state.sentScrollMilestones.has(milestone)) continue;
      state.sentScrollMilestones.add(milestone);
      if (typeof window.plausible === "function") {
        window.plausible("scroll_depth_milestone", {
          props: { percent: milestone },
        });
      }
    }
  }

  function updateEngagedTime() {
    const now = Date.now();
    const delta = Math.max(0, now - state.lastTickAt);
    state.lastTickAt = now;
    if (isVisible() && isActive(now)) {
      state.engagedMs += delta;
      sendMilestoneEvents();
    }
  }

  function markInteraction() {
    state.lastInteractionAt = Date.now();
    state.interactions += 1;
  }

  function markPrimaryAction(actionName) {
    if (!actionName) return;
    state.primaryActionCounts[actionName] = (state.primaryActionCounts[actionName] || 0) + 1;
    if (typeof window.plausible === "function") {
      window.plausible("primary_interaction", {
        props: { action: actionName },
      });
    }
  }

  function updateScrollDepth() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const scrollHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      window.innerHeight,
    );
    const pct = scrollHeight <= window.innerHeight ? 100 : (scrollTop / (scrollHeight - window.innerHeight)) * 100;
    state.maxScrollPct = Math.max(state.maxScrollPct, Math.min(100, Math.max(0, pct)));
    sendScrollMilestoneEvents();
  }

  function buildSnapshot() {
    updateEngagedTime();
    return {
      sessionId: state.sessionId,
      visitorId: state.visitorId,
      path: state.path,
      referrer: state.referrer,
      sessionStartedAt: state.sessionStartedAt,
      sessionDurationMs: Date.now() - state.sessionStartedAt,
      engagedMs: state.engagedMs,
      interactions: state.interactions,
      maxScrollPct: Number(state.maxScrollPct.toFixed(2)),
      milestonesReachedSec: [...state.sentMilestones].sort((a, b) => a - b),
      scrollMilestonesReachedPct: [...state.sentScrollMilestones].sort((a, b) => a - b),
      primaryActionCounts: { ...state.primaryActionCounts },
      capturedAt: new Date().toISOString(),
    };
  }

  function persistSession(summaryEvent) {
    const snapshot = buildSnapshot();
    writeJson(LAST_SESSION_KEY, snapshot);
    const sessions = readJson(SESSIONS_KEY, []);
    const withoutCurrent = Array.isArray(sessions) ? sessions.filter((item) => item?.sessionId !== snapshot.sessionId) : [];
    withoutCurrent.push(snapshot);
    writeJson(SESSIONS_KEY, withoutCurrent.slice(-MAX_STORED_SESSIONS));

    if (summaryEvent && typeof window.plausible === "function") {
      window.plausible("engagement_session_summary", {
        props: {
          engaged_seconds: Math.round(snapshot.engagedMs / 1000),
          interactions: snapshot.interactions,
          max_scroll_pct: snapshot.maxScrollPct,
        },
      });
    }
    return snapshot;
  }

  function exportPayload() {
    persistSession(false);
    const sessions = readJson(SESSIONS_KEY, []);
    return {
      exportedAt: new Date().toISOString(),
      source: "claw-engagement-export-v1",
      sessions: Array.isArray(sessions) ? sessions : [],
    };
  }

  function downloadExport() {
    const payload = exportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "claw-engagement-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return payload;
  }

  window.__clawEngagement = {
    snapshot: () => persistSession(false),
    exportData: exportPayload,
    downloadExport,
    debugState: state,
  };

  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    window.addEventListener(eventName, markInteraction, { passive: true });
  });
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-engagement-action]") : null;
    if (!target) return;
    markPrimaryAction(target.getAttribute("data-engagement-action") || "");
  });
  window.addEventListener(
    "scroll",
    () => {
      markInteraction();
      updateScrollDepth();
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", updateEngagedTime);
  window.addEventListener("pagehide", () => persistSession(true));
  window.addEventListener("beforeunload", () => persistSession(false));
  updateScrollDepth();
  setInterval(updateEngagedTime, 1000);
})();
