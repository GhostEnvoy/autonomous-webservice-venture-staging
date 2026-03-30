const engagedSecondsNode = document.getElementById("engaged-seconds");
const interactionCountNode = document.getElementById("interaction-count");
const visitCountNode = document.getElementById("visit-count");
const maxScrollNode = document.getElementById("max-scroll");
const sessionReadingNode = document.getElementById("session-reading");
const revealCardNode = document.getElementById("reveal-card");
const returnCopyNode = document.getElementById("return-copy");
const shareStatusNode = document.getElementById("share-status");
const shareCopyButton = document.getElementById("share-copy");
const exportButton = document.getElementById("export-engagement");

const sessionsKey = "claw:engagement:sessions";
const visitKey = "problem-signal:first-contact:visits";
const shareUnlockKey = "problem-signal:first-contact:share-unlocked";
let analyticsRuntime = null;
let umamiIdentityBound = false;
let shareIntentSignaled = false;
let collectorFlushTimer = null;
const collectorState = {
  lastSentAt: 0,
  lastSignature: "",
};

const ritualMoments = {
  "signal-clue": [
    "The most honest growth loop starts by noticing a real person arrived instead of imagining abstract traffic.",
    "A better version of this page might become a tiny daily ritual that changes with each return visit.",
  ],
  "signal-pattern": [
    "One pattern is already visible: if the first minute feels flat, nobody will ever share it.",
    "Another pattern: delight has to arrive before any request for distribution feels earned.",
  ],
  "signal-challenge": [
    "Challenge: can a site make one person stay longer without resorting to tricks, noise, or endless scroll sludge?",
    "Challenge accepted: the page should become more specific the more evidence it gathers.",
  ],
  "signal-memory": [
    "Memory check: on your second visit, this page should feel less generic and more like a system that noticed you.",
    "Memory check: repeat visitors deserve evolution, not the same untouched landing page forever.",
  ],
};

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getVisitCount() {
  const next = Math.max(1, Number(window.localStorage.getItem(visitKey) || "0") + 1);
  window.localStorage.setItem(visitKey, String(next));
  return next;
}

function classifyReferrer(referrer) {
  if (!referrer) return "direct";
  try {
    const refUrl = new URL(referrer);
    if (refUrl.host === window.location.host) return "internal";
    return refUrl.hostname.replace(/^www\./, "") || "external";
  } catch {
    return "external";
  }
}

function getCollectorConfig() {
  if (!analyticsRuntime || analyticsRuntime.enabled !== true || analyticsRuntime.provider !== "claw_collector") {
    return null;
  }
  const collectUrl = String(analyticsRuntime.collect_url || "").trim();
  if (!collectUrl) return null;
  return {
    collectUrl,
    flushIntervalMs: Number(analyticsRuntime.flush_interval_ms || 15000) || 15000,
  };
}

function buildCollectorPayload(snapshot, reason) {
  return {
    visitor_id: snapshot.visitorId,
    session_id: snapshot.sessionId,
    page_path: snapshot.path || window.location.pathname || "/",
    engaged_ms: Number(snapshot.engagedMs || 0),
    interaction_count: Number(snapshot.interactions || 0),
    max_scroll_pct: Number(snapshot.maxScrollPct || 0),
    milestones_hit: Array.isArray(snapshot.milestonesReachedSec) ? snapshot.milestonesReachedSec : [],
    scroll_milestones_hit: Array.isArray(snapshot.scrollMilestonesReachedPct) ? snapshot.scrollMilestonesReachedPct : [],
    primary_actions: snapshot.primaryActionCounts || {},
    share_intent: shareIntentSignaled || window.localStorage.getItem(shareUnlockKey) === "1",
    visit_count: visitCount,
    started_at: snapshot.sessionStartedAt ? new Date(snapshot.sessionStartedAt).toISOString() : new Date().toISOString(),
    ended_at: snapshot.capturedAt || new Date().toISOString(),
    referrer_kind: classifyReferrer(snapshot.referrer || document.referrer || ""),
    transport_reason: reason,
    site_version: "growth-loop-v2",
  };
}

function payloadSignature(payload) {
  return JSON.stringify([
    payload.session_id,
    payload.engaged_ms,
    payload.interaction_count,
    payload.max_scroll_pct,
    payload.share_intent,
    payload.visit_count,
    payload.transport_reason,
    payload.milestones_hit,
    payload.scroll_milestones_hit,
  ]);
}

function postCollectorSnapshot(reason, force = false) {
  const collector = getCollectorConfig();
  const snapshot = window.__clawEngagement?.snapshot?.();
  if (!collector || !snapshot) return;
  const payload = buildCollectorPayload(snapshot, reason);
  const signature = payloadSignature(payload);
  const now = Date.now();
  if (!force && signature === collectorState.lastSignature && now - collectorState.lastSentAt < collector.flushIntervalMs) {
    return;
  }

  collectorState.lastSignature = signature;
  collectorState.lastSentAt = now;
  const body = JSON.stringify(payload);

  try {
    if ((reason === "pagehide" || reason === "visibility_hidden" || reason === "beforeunload") && navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(collector.collectUrl, blob);
      return;
    }
    fetch(collector.collectUrl, {
      method: "POST",
      mode: "cors",
      headers: { "content-type": "application/json" },
      body,
      keepalive: reason !== "interval",
    }).catch(() => {});
  } catch {}
}

function scheduleCollectorFlush() {
  const collector = getCollectorConfig();
  if (!collector) return;
  if (collectorFlushTimer) {
    window.clearInterval(collectorFlushTimer);
  }
  collectorFlushTimer = window.setInterval(() => {
    postCollectorSnapshot("interval");
  }, collector.flushIntervalMs);
}

const visitCount = getVisitCount();
if (visitCountNode) {
  visitCountNode.textContent = String(visitCount);
}
if (returnCopyNode) {
  returnCopyNode.textContent =
    visitCount > 1
      ? "You have been here before. That means the next versions of this page should begin to reward return visits with deeper changes."
      : "This is the very first visit being measured. If the page earns a second visit, it should start feeling more alive, specific, and worth revisiting.";
}

let ritualClicks = 0;
let revealCounts = {
  "signal-clue": 0,
  "signal-pattern": 0,
  "signal-challenge": 0,
  "signal-memory": 0,
};

function getLatestMessage(action) {
  const options = ritualMoments[action] || ["The page is still deciding what it wants to become."];
  const index = revealCounts[action] % options.length;
  revealCounts[action] += 1;
  return options[index];
}

async function loadAnalyticsRuntime() {
  try {
    const res = await fetch("./analytics-runtime.json", { cache: "no-store" });
    if (!res.ok) return null;
    const runtime = await res.json();
    if (!runtime || runtime.enabled !== true) {
      return runtime || null;
    }
    if (runtime.provider === "umami" && runtime.script_src && runtime.website_id) {
      await new Promise((resolve, reject) => {
        if (document.querySelector('script[data-claw-umami="true"]')) {
          resolve();
          return;
        }
        const script = document.createElement("script");
        script.defer = true;
        script.dataset.websiteId = runtime.website_id;
        script.dataset.clawUmami = "true";
        script.src = runtime.script_src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Umami tracker"));
        document.head.appendChild(script);
      });
    }
    return runtime;
  } catch {
    return null;
  }
}

function trackUmami(eventName, data = undefined) {
  try {
    if (!window.umami?.track) return;
    if (data && typeof data === "object") {
      window.umami.track(eventName, data);
      return;
    }
    window.umami.track(eventName);
  } catch {}
}

function ensureUmamiIdentity() {
  if (umamiIdentityBound || analyticsRuntime?.provider !== "umami") return;
  const snapshot = window.__clawEngagement?.snapshot?.();
  const visitorId = snapshot?.visitorId;
  if (!visitorId || !window.umami?.identify) return;
  try {
    window.umami.identify(visitorId);
    umamiIdentityBound = true;
  } catch {}
}

function maybeUnlockShare(snapshot) {
  const engagedSeconds = Math.round((snapshot?.engagedMs || 0) / 1000);
  const shouldUnlock = engagedSeconds >= 45 || ritualClicks >= 3 || visitCount > 1;
  const wasUnlocked = window.localStorage.getItem(shareUnlockKey) === "1";
  if (!shouldUnlock && !wasUnlocked) return false;
  window.localStorage.setItem(shareUnlockKey, "1");
  if (shareCopyButton) {
    shareCopyButton.disabled = false;
  }
  if (shareStatusNode) {
    shareStatusNode.textContent =
      "If this feels promising, share the page with one person who would appreciate watching a website learn in public.";
  }
  if (!wasUnlocked) {
    shareIntentSignaled = true;
    trackUmami("share_unlock", { engagedSeconds, ritualClicks, visitCount });
    postCollectorSnapshot("share_unlock", true);
  }
  return true;
}

function buildShareCopy(snapshot) {
  const engagedSeconds = Math.round((snapshot?.engagedMs || 0) / 1000);
  return (
    "I’m testing a living website that is trying to earn attention honestly. " +
    "I spent about " +
    engagedSeconds +
    " engaged seconds with this version. Want to see what it becomes?"
  );
}

function renderMetrics() {
  const snapshot = window.__clawEngagement?.snapshot?.();
  if (!snapshot) return;
  if (analyticsRuntime?.provider === "umami") {
    ensureUmamiIdentity();
  }
  const engagedSeconds = Math.round(snapshot.engagedMs / 1000);
  if (engagedSecondsNode) engagedSecondsNode.textContent = String(engagedSeconds);
  if (interactionCountNode) interactionCountNode.textContent = String(snapshot.interactions);
  if (maxScrollNode) maxScrollNode.textContent = String(Math.round(snapshot.maxScrollPct)) + "%";

  if (sessionReadingNode) {
    if (engagedSeconds < 15) {
      sessionReadingNode.textContent = "First contact. The page is trying to earn your attention without pretending.";
    } else if (engagedSeconds < 45) {
      sessionReadingNode.textContent = "A real session is forming. Curiosity, clarity, and a reason to share matter more than decoration.";
    } else {
      sessionReadingNode.textContent = "This is now meaningful evidence. If the experience still feels coherent, it may have earned the right to be shared.";
    }
  }

  maybeUnlockShare(snapshot);
  postCollectorSnapshot("render");
}

document.querySelectorAll("[data-engagement-action]").forEach((node) => {
  node.addEventListener("click", () => {
    const action = node.getAttribute("data-engagement-action") || "";
    trackUmami(action, { visitCount });
    if (action.startsWith("signal-")) {
      ritualClicks += 1;
      if (revealCardNode) {
        revealCardNode.textContent = getLatestMessage(action);
      }
      renderMetrics();
    }
    if (action === "begin-loop" && revealCardNode) {
      revealCardNode.textContent =
        "The first loop has started. Explore the signals below and see whether the page feels worth sharing by the end.";
    }
    postCollectorSnapshot(`action:${action}`, true);
  });
});

if (shareCopyButton) {
  shareCopyButton.addEventListener("click", async () => {
    const snapshot = window.__clawEngagement?.snapshot?.();
    const text = buildShareCopy(snapshot);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      shareStatusNode.textContent = "Share invitation copied. If the page still feels worth it later, send it to one person.";
      shareIntentSignaled = true;
      trackUmami("share_copy", { engagedSeconds: Math.round((snapshot?.engagedMs || 0) / 1000), visitCount });
      postCollectorSnapshot("share_copy", true);
    } catch {
      shareStatusNode.textContent = text;
    }
  });
}

if (exportButton) {
  exportButton.addEventListener("click", () => {
    const payload = window.__clawEngagement?.downloadExport?.();
    if (!payload || !shareStatusNode) return;
    shareStatusNode.textContent =
      "Session evidence exported at " + new Date(payload.exportedAt || Date.now()).toLocaleString() + ".";
    trackUmami("export_engagement", { sessions: payload.sessions?.length || 0 });
    postCollectorSnapshot("export", true);
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    postCollectorSnapshot("visibility_hidden", true);
  }
});
window.addEventListener("pagehide", () => postCollectorSnapshot("pagehide", true));
window.addEventListener("beforeunload", () => postCollectorSnapshot("beforeunload", true));

loadAnalyticsRuntime()
  .then((runtime) => {
    analyticsRuntime = runtime;
    if (analyticsRuntime?.provider === "claw_collector") {
      scheduleCollectorFlush();
    }
    renderMetrics();
    setInterval(renderMetrics, 1000);
  })
  .catch(() => {
    renderMetrics();
    setInterval(renderMetrics, 1000);
  });
