let isEmployer = false;

const STORAGE_USERS_KEY = "mockUsers";
const STORAGE_CURRENT_USER_KEY = "currentUserId";
const STORAGE_AUTH_TOKEN_KEY = "authToken";
// Legacy: older UI used "saved searches". We now show "saved jobs" but keep this key around
// so existing code doesn't break if referenced elsewhere.
const STORAGE_SAVED_SEARCHES_KEY = "savedSearches";
const STORAGE_SAVED_JOBS_PREFIX = "savedJobs:";
const STORAGE_NOTIF_LAST_SEEN_PREFIX = "notifLastSeen:";
const STORAGE_NOTIF_SEEN_MSG_PREFIX = "notifSeenMsgAt:";
const STORAGE_SYNC_EVENT_KEY = "smartHuntSyncEvent";
const TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let syncChannel = null;
let syncRefreshTimer = null;
let lastHandledSyncTs = 0;
let liveRefreshTimer = null;
let serverEventsSource = null;
const SEEKER_PROFILE_CACHE_KEY_PREFIX = "smartHuntProfileCache_v1:seeker:";
const SEEKER_PROFILE_TITLE_CACHE_TTL_MS = 2 * 60 * 1000;
let cachedJobs = null;
let cachedJobsFetchedAt = 0;
let jobsSnapshotPromise = null;
let seekerSearchState = { keywords: "", location: "" };
let seekerRecommendationProfile = { userId: "", title: "", fetchedAt: 0, refreshPromise: null };
let employerApplicantsSearchTimer = null;
let employerApplicantsJobsSearchTimer = null;
let employerApplicantsSelectedJobId = "";
let employerApplicantsSelectedJob = null;
let employerPostedJobsShowAll = false;
let employerApplicantsJobsFilterMode = "active"; // active | archived | all
let employerApplicantsJobsSortMode = "newest"; // newest | oldest | applicants | title
let employerApplicantsLastLoadedAt = 0;
let employerApplicantsDirty = true;
let employerOverviewRefreshTimer = null;
let dataViewsRefreshTimer = null;
let googleClientIdBootstrapPromise = null;
const EMPLOYER_APPLICANTS_REFRESH_MS = 20000;
const EMPLOYER_JOB_APPLICANTS_CACHE_TTL_MS = 30000;
const employerJobApplicantsCache = new Map(); // jobId -> { apps, fetchedAt }
let employerApplicantsSelectedJobApps = [];
let notificationsDirty = { seeker: true, employer: true };
const NOTIFICATIONS_REFRESH_MS = 20000;
const notificationsCache = new Map(); // `${role}:${userId}` -> { notes, fetchedAt }
const USER_PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;
const userProfileCache = new Map(); // userId -> { payload, fetchedAt }
let seekerChatSuppressRefreshUntil = 0;
let seekerChatSearchTerm = "";
let seekerChatFilterMode = "all";
let addJobDraftAutosaveTimer = null;
let notificationsReturnState = null;
let pageLoaderDepth = 0;
let pageLoaderStartedAt = 0;

function ensurePageLoader() {
  if (typeof document === "undefined" || !document.body) return null;
  let loader = document.getElementById("globalPageLoader");
  if (loader) return loader;

  loader = document.createElement("div");
  loader.id = "globalPageLoader";
  loader.className = "global-page-loader";
  loader.setAttribute("aria-hidden", "true");
  loader.innerHTML = `
    <div class="global-page-loader__panel" role="status" aria-live="polite">
      <div class="global-page-loader__spinner" aria-hidden="true"></div>
      <div class="global-page-loader__text" id="globalPageLoaderText">Loading...</div>
    </div>
  `;
  document.body.appendChild(loader);
  return loader;
}

function showPageLoader(message = "Loading...") {
  const loader = ensurePageLoader();
  if (!loader) return;
  const text = document.getElementById("globalPageLoaderText");
  if (text) text.textContent = String(message || "Loading...");
  pageLoaderDepth += 1;
  pageLoaderStartedAt = Date.now();
  loader.classList.add("is-visible");
  loader.setAttribute("aria-hidden", "false");
  document.body.classList.add("page-loading");
}

function hidePageLoader({ force = false, minDuration = 320 } = {}) {
  const loader = document.getElementById("globalPageLoader");
  if (!loader) return;
  if (force) {
    pageLoaderDepth = 0;
  } else {
    pageLoaderDepth = Math.max(0, pageLoaderDepth - 1);
  }
  if (pageLoaderDepth > 0) return;

  const elapsed = Date.now() - pageLoaderStartedAt;
  const wait = Math.max(0, Number(minDuration || 0) - elapsed);
  window.setTimeout(() => {
    if (pageLoaderDepth > 0) return;
    loader.classList.remove("is-visible");
    loader.setAttribute("aria-hidden", "true");
    if (document.body) document.body.classList.remove("page-loading");
  }, wait);
}

async function withPageLoader(task, { message = "Loading...", minDuration = 320 } = {}) {
  showPageLoader(message);
  try {
    return await task();
  } finally {
    hidePageLoader({ minDuration });
  }
}

function navigateWithLoader(url, { message = "Loading page...", delay = 0 } = {}) {
  const to = String(url || "").trim();
  if (!to) return;
  const navDelay = Math.max(0, Number(delay || 0));

  // Show the loader only if the navigation doesn't happen instantly.
  const showTimer = window.setTimeout(() => {
    showPageLoader(message);
  }, 140);

  window.setTimeout(() => {
    try {
      window.location.href = to;
    } finally {
      window.clearTimeout(showTimer);
    }
  }, navDelay);
}

function finishInitialRender() {
  if (!document || !document.body) return;
  document.body.classList.remove("app-booting");
  document.body.classList.add("app-ready");
}

window.addEventListener("load", () => {
  finishInitialRender();
});

function cycleEmployerApplicantsJobsFilter() {
  const order = ["active", "archived", "all"];
  const idx = order.indexOf(employerApplicantsJobsFilterMode);
  employerApplicantsJobsFilterMode = order[(idx + 1) % order.length] || "active";
}

function cycleEmployerApplicantsJobsSort() {
  const order = ["newest", "oldest", "applicants", "title"];
  const idx = order.indexOf(employerApplicantsJobsSortMode);
  employerApplicantsJobsSortMode = order[(idx + 1) % order.length] || "newest";
}

function updateEmployerApplicantsJobsControls() {
  const filterBtn = document.getElementById("employerApplicantsJobsFilterBtn");
  const sortBtn = document.getElementById("employerApplicantsJobsSortBtn");
  if (filterBtn) {
    const label =
      employerApplicantsJobsFilterMode === "archived"
        ? "Filter: Archived"
        : employerApplicantsJobsFilterMode === "all"
          ? "Filter: All"
          : "Filter: Active";
    filterBtn.innerHTML = `<i class="fa-solid fa-filter"></i> ${label}`;
  }
  if (sortBtn) {
    const label =
      employerApplicantsJobsSortMode === "oldest"
        ? "Sort: Oldest"
        : employerApplicantsJobsSortMode === "applicants"
          ? "Sort: Applicants"
          : employerApplicantsJobsSortMode === "title"
            ? "Sort: Title"
            : "Sort: Newest";
    sortBtn.innerHTML = `<i class="fa-solid fa-arrow-down-short-wide"></i> ${label}`;
  }
}

function setupEmployerApplicantsJobsFilterSort() {
  const filterBtn = document.getElementById("employerApplicantsJobsFilterBtn");
  const sortBtn = document.getElementById("employerApplicantsJobsSortBtn");
  if (filterBtn) {
    filterBtn.addEventListener("click", () => {
      cycleEmployerApplicantsJobsFilter();
      updateEmployerApplicantsJobsControls();
      loadEmployerApplicantsFromBackend().catch(() => {});
    });
  }
  if (sortBtn) {
    sortBtn.addEventListener("click", () => {
      cycleEmployerApplicantsJobsSort();
      updateEmployerApplicantsJobsControls();
      loadEmployerApplicantsFromBackend().catch(() => {});
    });
  }
  updateEmployerApplicantsJobsControls();
}

function sortEmployerApplicantsJobs(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (employerApplicantsJobsSortMode === "oldest") {
    arr.sort((a, b) => (String(a?.createdAt || "")).localeCompare(String(b?.createdAt || "")));
    return arr;
  }
  if (employerApplicantsJobsSortMode === "applicants") {
    arr.sort((a, b) => (Number(b?.applicantCount) || 0) - (Number(a?.applicantCount) || 0));
    return arr;
  }
  if (employerApplicantsJobsSortMode === "title") {
    arr.sort((a, b) => (String(a?.title || "")).localeCompare(String(b?.title || ""), undefined, { sensitivity: "base" }));
    return arr;
  }
  // newest (default)
  arr.sort((a, b) => (String(b?.createdAt || "")).localeCompare(String(a?.createdAt || "")));
  return arr;
}

function scheduleSyncRefresh() {
  if (syncRefreshTimer) return;
  syncRefreshTimer = setTimeout(async () => {
    syncRefreshTimer = null;
    if (!getLoggedIn()) return;
    await refreshDataViews();

    // If the user is already on a notifications page, refresh it too.
    const role = getLoggedInRole();
    if (role === "seeker") {
      const page = document.getElementById("seekerNotificationsPage");
      const visible = page && page.style.display !== "none";
      if (visible) {
        notificationsDirty.seeker = true;
        loadAndShowNotifications("seeker", { quiet: true }).catch(() => {});
      }
      const chat = document.getElementById("seekerChatModal");
      const appId = chat ? String(chat.getAttribute("data-application-id") || "") : "";
      if (appId && chat && chat.style.display === "flex") {
        loadSeekerChatThread(appId).catch(() => {});
        loadSeekerConversationsFromBackend().catch(() => {});
      }
    } else if (role === "employer") {
      const page = document.getElementById("employerNotifications");
      const visible = page && page.style.display !== "none";
      if (visible) {
        notificationsDirty.employer = true;
        loadAndShowNotifications("employer", { quiet: true }).catch(() => {});
      }
      const applicants = document.getElementById("employerApplicants");
      const appsVisible = applicants && applicants.style.display !== "none";
      if (appsVisible) {
        employerApplicantsDirty = true;
        maybeRefreshEmployerApplicants({ quiet: true }).catch(() => {});
      }
    }
  }, 250);
}

function markConversationNotificationsSeen(applicationId, msgs) {
  const role = getLoggedInRole();
  const userId = localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "";
  const appId = String(applicationId || "").trim();
  if (!role || !userId || !appId || !Array.isArray(msgs) || !msgs.length) return;

  const latestInboundMs = msgs.reduce((latest, msg) => {
    if (!msg || typeof msg !== "object") return latest;
    const fromRole = String(msg.fromRole || "").toLowerCase();
    if (!fromRole || fromRole === role) return latest;
    return Math.max(latest, isoToMs(msg.createdAt || ""));
  }, 0);

  if (!latestInboundMs) return;
  const key = getNotifSeenMsgKey(role, userId, appId);
  const existing = Number.parseInt(localStorage.getItem(key) || "0", 10) || 0;
  if (latestInboundMs > existing) {
    localStorage.setItem(key, String(latestInboundMs));
  }
}

function renderConversationThread(thread, msgs, applicationId = "") {
  if (!thread) return;
  thread.innerHTML = "";
  if (!Array.isArray(msgs) || !msgs.length) {
    const empty = document.createElement("div");
    empty.style.color = "#9aa4b2";
    empty.style.fontSize = "12px";
    empty.textContent = "No messages yet.";
    thread.appendChild(empty);
    return;
  }
  markConversationNotificationsSeen(applicationId, msgs);
  msgs.forEach((msg) => {
    const bubble = createConversationBubble(msg);
    if (!bubble) return;
    thread.appendChild(bubble);
  });
  thread.scrollTop = thread.scrollHeight;
}

function appendConversationBubble(thread, payload, role) {
  if (!thread) return null;
  const bubble = createConversationBubble(
    typeof payload === "object" && payload
      ? { ...payload, fromRole: role || payload.fromRole || "employer" }
      : { text: String(payload || ""), fromRole: role || "employer" },
  );
  if (!bubble) return null;
  const empty = thread.firstElementChild;
  if (empty && thread.children.length === 1 && !empty.classList.contains("chat-bubble")) {
    thread.innerHTML = "";
  }
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
  return bubble;
}

const MESSAGE_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

function isConversationAttachmentImage(attachment) {
  return /^image\//i.test(String(attachment?.type || "").trim());
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read the selected file."));
    reader.readAsDataURL(file);
  });
}

async function buildConversationAttachment(file) {
  if (!file) return null;
  if (file.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
    throw new Error("File is too large. Maximum size is 4 MB.");
  }
  const dataUrl = await fileToDataUrl(file);
  return {
    name: String(file.name || "attachment").trim() || "attachment",
    type: String(file.type || "application/octet-stream").trim(),
    size: Number(file.size) || 0,
    dataUrl,
  };
}

function downloadConversationAttachment(attachment) {
  if (!attachment || !attachment.dataUrl) return;
  const a = document.createElement("a");
  a.href = attachment.dataUrl;
  a.download = String(attachment.name || "attachment").trim() || "attachment";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function createConversationBubble(message) {
  if (!message || typeof message !== "object") return null;
  const fromRole = String(message.fromRole || "").toLowerCase() === "seeker" ? "seeker" : "employer";
  const myRole = String(getLoggedInRole() || "").toLowerCase();
  const roleClass = fromRole === "seeker" ? "seeker" : "employer";
  const sideClass = myRole && fromRole === myRole ? "me" : "them";
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${roleClass} ${sideClass}`;

  const text = String(message.text || "").trim();
  if (text) {
    const textEl = document.createElement("div");
    textEl.className = "chat-bubble-text";
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }

  const attachment = message.attachment && typeof message.attachment === "object" ? message.attachment : null;
  if (attachment && attachment.dataUrl) {
    const attachmentEl = document.createElement("div");
    attachmentEl.className = "chat-attachment";

    if (isConversationAttachmentImage(attachment)) {
      const preview = document.createElement("img");
      preview.className = "chat-attachment-preview";
      preview.src = attachment.dataUrl;
      preview.alt = String(attachment.name || "Attachment");
      preview.addEventListener("click", () => openUploadedFile(attachment));
      attachmentEl.appendChild(preview);
    }

    const meta = document.createElement("div");
    meta.className = "chat-attachment-meta";
    const nameEl = document.createElement("div");
    nameEl.className = "chat-attachment-name";
    nameEl.textContent = String(attachment.name || "Attachment");
    meta.appendChild(nameEl);

    const actions = document.createElement("div");
    actions.className = "chat-attachment-actions";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "chat-attachment-btn";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => openUploadedFile(attachment));

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "chat-attachment-btn";
    downloadBtn.textContent = "Download";
    downloadBtn.addEventListener("click", () => downloadConversationAttachment(attachment));

    actions.appendChild(openBtn);
    actions.appendChild(downloadBtn);
    meta.appendChild(actions);
    attachmentEl.appendChild(meta);
    bubble.appendChild(attachmentEl);
  }

  if (!bubble.childNodes.length) {
    const empty = document.createElement("div");
    empty.className = "chat-bubble-text";
    empty.textContent = "Attachment";
    bubble.appendChild(empty);
  }

  return bubble;
}

async function refreshOpenEmployerConversationThreads() {
  const details = Array.from(document.querySelectorAll(".posted-applicant-detail.show[data-application-id]"));
  if (!details.length || !hasBackendToken()) return false;

  await Promise.all(
    details.map(async (detail) => {
      const applicationId = String(detail.getAttribute("data-application-id") || "").trim();
      const thread = detail.querySelector("[data-thread]");
      if (!applicationId || !thread) return;
      try {
        const data = await apiRequest(`/api/messages?applicationId=${encodeURIComponent(applicationId)}`, {
          method: "GET",
          auth: true,
        });
        const msgs = data && data.ok && Array.isArray(data.messages) ? data.messages : [];
        renderConversationThread(thread, msgs, applicationId);
      } catch {
        // leave the current thread as-is on refresh failures
      }
    }),
  );

  return true;
}

function scheduleMessageRefresh(payload = {}) {
  if (syncRefreshTimer) return;
  syncRefreshTimer = setTimeout(async () => {
    syncRefreshTimer = null;
    if (!getLoggedIn()) return;

    const role = getLoggedInRole();
    if (role === "seeker") {
      const page = document.getElementById("seekerNotificationsPage");
      const visible = page && page.style.display !== "none";
      if (visible) loadAndShowNotifications("seeker").catch(() => {});

      const chat = document.getElementById("seekerChatModal");
      const appId = chat ? String(chat.getAttribute("data-application-id") || "") : "";
      const shouldRefreshThread = Date.now() >= seekerChatSuppressRefreshUntil;
      const payloadAppId = String(payload.applicationId || "").trim();
      const payloadFromRole = String(payload.fromRole || "").trim().toLowerCase();
      const isOwnOpenThreadMessage =
        payloadFromRole === "seeker" && payloadAppId && appId && payloadAppId === appId && chat && chat.style.display === "flex";
      if (appId && chat && chat.style.display === "flex" && shouldRefreshThread && !isOwnOpenThreadMessage) {
        loadSeekerChatThread(appId).catch(() => {});
      }
      loadSeekerConversationsFromBackend().catch(() => {});
      return;
    }

    if (role === "employer") {
      const page = document.getElementById("employerNotifications");
      const visible = page && page.style.display !== "none";
      if (visible) loadAndShowNotifications("employer").catch(() => {});
      refreshOpenEmployerConversationThreads().catch(() => {});
    }
  }, 200);
}

function scheduleLiveRefresh() {
  if (liveRefreshTimer) return;
  liveRefreshTimer = setTimeout(async () => {
    liveRefreshTimer = null;
    await refreshDataViews();
  }, 200);
}

function handleSyncEvent(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.sender === TAB_ID) return;
  const ts = Number(msg.ts) || 0;
  if (ts && ts <= lastHandledSyncTs) return;
  if (ts) lastHandledSyncTs = ts;
  scheduleSyncRefresh();
}

function getApiBaseForLiveEvents() {
  const DEFAULT_API_BASE = "http://localhost:3000";
  try {
    const stored = String(localStorage.getItem("smartHuntApiBase") || "").trim();
    return stored || DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function setupServerEvents() {
  if (serverEventsSource) return;
  const proto = window.location && window.location.protocol ? window.location.protocol : "";
  if (proto !== "http:" && proto !== "https:" && proto !== "file:") return;

  const base = proto === "file:" ? getApiBaseForLiveEvents().replace(/\/+$/, "") : "";
  const url = base ? `${base}/api/events` : "/api/events";

  try {
    serverEventsSource = new EventSource(url);
  } catch {
    serverEventsSource = null;
    return;
  }

  const hotReloadStyles = () => {
    document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const href = String(link.getAttribute("href") || "");
      if (!href) return;
      if (/^https?:\/\//i.test(href)) return; // don't mutate CDN styles
      try {
        const next = new URL(href, window.location.href);
        next.searchParams.set("v", String(Date.now()));
        link.setAttribute("href", next.toString());
      } catch {
        // ignore
      }
    });
  };

  serverEventsSource.onmessage = (ev) => {
    if (!ev || !ev.data) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const type = String(msg.type || "");
    if (type === "dev_css") {
      hotReloadStyles();
      return;
    }
    if (type === "dev_reload") {
      window.location.reload();
      return;
    }
    if (type === "jobs_updated") {
      scheduleLiveRefresh();
    }
    if (type === "messages_updated") {
      scheduleMessageRefresh(msg.payload || {});
      return;
    }
    if (type === "jobs_updated" || type === "applications_updated" || type === "profile_updated") {
      scheduleSyncRefresh();
    }
  };

  serverEventsSource.onerror = () => {
    // Browser auto-retries; nothing to do.
  };
}

function emitSyncEvent(type, payload = {}) {
  const msg = { sender: TAB_ID, type: String(type || "update"), ts: Date.now(), payload };
  try {
    if (syncChannel) syncChannel.postMessage(msg);
  } catch {
    // ignore
  }
  try {
    localStorage.setItem(STORAGE_SYNC_EVENT_KEY, JSON.stringify(msg));
  } catch {
    // ignore
  }
}

function setupSyncBus() {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      syncChannel = new BroadcastChannel("smartHuntSync");
      syncChannel.onmessage = (ev) => handleSyncEvent(ev && ev.data ? ev.data : null);
    }
  } catch {
    syncChannel = null;
  }

  window.addEventListener("storage", (ev) => {
    if (!ev || ev.key !== STORAGE_SYNC_EVENT_KEY || !ev.newValue) return;
    try {
      const msg = JSON.parse(ev.newValue);
      handleSyncEvent(msg);
    } catch {
      // ignore
    }
  });
}

function smartHuntFactoryReset({ reload = true } = {}) {
  // Clears local demo users + all local login/session state (does not touch server DB).
  try {
    clearAuth();
  } catch {
    // ignore
  }

  const keys = [
    STORAGE_USERS_KEY,
    STORAGE_CURRENT_USER_KEY,
    STORAGE_AUTH_TOKEN_KEY,
    STORAGE_SAVED_SEARCHES_KEY,
    "currentUserEmail",
    "currentUserName",
    "isLoggedIn",
    "userRole",
    "jobDraft",
    "postSignupWelcome",
    "postLoginTarget",
    "finishProfileDone_employer",
    "finishProfileDone_seeker",
  ];
  keys.forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore
    }
  });

  // Remove any per-user saved jobs.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_SAVED_JOBS_PREFIX)) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // ignore
  }

  // Remove any other finish/profile flags (future-proofing).
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("finishProfileDone_")) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // ignore
  }

  try {
    updateAuthUI();
  } catch {
    // ignore
  }

  if (reload) {
    window.location.reload();
  }
}

window.smartHuntFactoryReset = smartHuntFactoryReset;

function getSavedJobsStorageKey() {
  const userId = localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "anon";
  return `${STORAGE_SAVED_JOBS_PREFIX}${userId}`;
}

function getSavedJobs() {
  const raw = localStorage.getItem(getSavedJobsStorageKey());
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Backwards-compat: older builds stored just an array of ids.
    if (parsed.length && typeof parsed[0] === "string") {
      return parsed.map((id) => ({ id: String(id) }));
    }

    return parsed
      .filter((j) => j && typeof j === "object")
      .map((j) => ({
        id: String(j.id || ""),
        title: String(j.title || ""),
        companyLine: String(j.companyLine || ""),
        salary: String(j.salary || ""),
        badge: String(j.badge || ""),
        tags: Array.isArray(j.tags) ? j.tags.map((t) => String(t)) : [],
      }))
      .filter((j) => j.id);
  } catch {
    return [];
  }
}

function setSavedJobs(jobs) {
  const cleaned = (Array.isArray(jobs) ? jobs : [])
    .filter((j) => j && typeof j === "object")
    .map((j) => ({
      id: String(j.id || ""),
      title: String(j.title || ""),
      companyLine: String(j.companyLine || ""),
      salary: String(j.salary || ""),
      badge: String(j.badge || ""),
      tags: Array.isArray(j.tags) ? j.tags.map((t) => String(t)) : [],
    }))
    .filter((j) => j.id);

  // Dedupe by id (keep latest snapshot)
  const byId = new Map();
  cleaned.forEach((j) => byId.set(j.id, j));
  localStorage.setItem(getSavedJobsStorageKey(), JSON.stringify(Array.from(byId.values())));
}

function getSavedJobIds() {
  return getSavedJobs().map((j) => String(j.id));
}

function isJobSaved(jobId) {
  if (!jobId) return false;
  return getSavedJobIds().includes(String(jobId));
}

function unsaveJobById(jobId) {
  const id = String(jobId || "");
  if (!id) return;
  const jobs = getSavedJobs().filter((j) => String(j.id) !== id);
  setSavedJobs(jobs);
  renderSavedJobs();
  syncBookmarkButtons(document);
}

function openQuickViewFromSaved(job) {
  const modal = document.getElementById("quickViewModal");
  if (!modal) return;
  const fullJob = findRenderedJobById(job.id) || {
    ...job,
    company: String(job.companyLine || "").replace(/^Company:\s*/i, "").split("•")[0].trim(),
    location: "",
    requirements: Array.isArray(job.tags) ? job.tags.join("\n") : "",
    description: "",
    createdAt: "",
  };
  renderQuickViewDetails(fullJob);
  try {
    modal.setAttribute("data-job-id", String(fullJob.id || job.id || ""));
  } catch {
    // ignore
  }
  syncSeekerApplyButtons(document);
  modal.style.display = "flex";
}

function enrichSavedJobFromDom(job) {
  if (!job || !job.id) return job;
  if (job.title && job.companyLine && job.salary && job.badge && Array.isArray(job.tags) && job.tags.length) {
    return job;
  }
  const esc = (window.CSS && typeof window.CSS.escape === "function")
    ? window.CSS.escape(String(job.id))
    : String(job.id).replace(/\"/g, "\\\"");
  const card = document.querySelector(`.job-card[data-job-id="${esc}"]`);
  if (!card) return job;
  const snap = snapshotJobFromCard(card, job.id);
  return {
    ...job,
    title: job.title || snap.title,
    companyLine: job.companyLine || snap.companyLine,
    salary: job.salary || snap.salary,
    badge: job.badge || snap.badge,
    tags: (job.tags && job.tags.length) ? job.tags : snap.tags,
  };
}

function renderSavedJobs() {
  const list = document.getElementById("savedJobsList");
  const modalList = document.getElementById("savedJobsModalList");
  const empty = document.getElementById("savedJobsEmpty");
  const modalEmpty = document.getElementById("savedJobsModalEmpty");

  let jobs = getSavedJobs();
  // Best-effort enrichment for older saved items that only had ids.
  const enriched = jobs.map(enrichSavedJobFromDom);
  const changed = enriched.some((j, i) => (j.title || "") !== (jobs[i].title || "") || (j.companyLine || "") !== (jobs[i].companyLine || ""));
  jobs = enriched;
  if (changed) setSavedJobs(jobs);

  const clearCards = (target, emptyId) => {
    if (!target) return;
    Array.from(target.children).forEach((child) => {
      if (child && child.id === emptyId) return;
      child.remove();
    });
  };

  const renderInto = (target, emptyId) => {
    if (!target) return;
    clearCards(target, emptyId);
    jobs.forEach((j) => {
      const card = document.createElement("div");
      card.className = "saved-search";
      card.setAttribute("data-saved-job-id", String(j.id));
      card.innerHTML = `
        <div>
          <h4></h4>
          <p></p>
        </div>
        <div class="saved-search-actions">
          <button class="pill-btn" type="button">Quick View</button>
          <button class="ghost-btn unsave-btn" type="button">Unsave</button>
        </div>
      `;
      const h4 = card.querySelector("h4");
      const p = card.querySelector("p");
      if (h4) h4.textContent = j.title || "Saved Job";
      if (p) p.textContent = j.companyLine || "Company • Location";

      const viewBtn = card.querySelector(".pill-btn");
      if (viewBtn) {
        viewBtn.addEventListener("click", () => openQuickViewFromSaved(j));
      }
      const unsaveBtn = card.querySelector(".unsave-btn");
      if (unsaveBtn) {
        unsaveBtn.addEventListener("click", () => unsaveJobById(j.id));
      }

      target.appendChild(card);
    });
  };

  renderInto(list, "savedJobsEmpty");
  renderInto(modalList, "savedJobsModalEmpty");

  const isEmpty = jobs.length === 0;
  if (empty) empty.style.display = isEmpty ? "block" : "none";
  if (modalEmpty) modalEmpty.style.display = isEmpty ? "block" : "none";
}

function getOrCreateJobIdFromCard(card) {
  if (!card) return "";
  const existing = card.getAttribute("data-job-id");
  if (existing) return existing;
  // For static demo cards (no backend id), generate a stable-ish id from visible text.
  const title = (card.querySelector("h3")?.textContent || "").trim().toLowerCase();
  const company = (card.querySelector("p")?.textContent || "").trim().toLowerCase();
  const base = `${title}|${company}`.replace(/\s+/g, " ").trim();
  const slug = base
    .replace(/[^a-z0-9\|\- ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  const id = slug ? `demo_${slug}` : `demo_${Date.now()}`;
  card.setAttribute("data-job-id", id);
  return id;
}

function snapshotJobFromCard(card, jobId) {
  if (!card) return { id: String(jobId || "") };
  const title = (card.querySelector("h3")?.textContent || "").trim();
  const companyLine = (card.querySelector("p")?.textContent || "").trim();
  const salary = (card.querySelector(".job-footer strong")?.textContent || "").trim();
  const badge = (card.querySelector(".job-badge")?.textContent || "").trim();
  const tags = Array.from(card.querySelectorAll(".tag-row span"))
    .map((s) => (s.textContent || "").trim())
    .filter(Boolean);
  return {
    id: String(jobId || ""),
    title,
    companyLine,
    salary,
    badge,
    tags,
  };
}

function setBookmarkButtonState(btn, saved) {
  if (!btn) return;
  btn.setAttribute("aria-pressed", saved ? "true" : "false");
  btn.setAttribute("aria-label", saved ? "Unsave job" : "Save job");
  btn.title = saved ? "Saved" : "Save";
  const icon = btn.querySelector("i");
  if (!icon) return;
  icon.classList.toggle("fa-solid", saved);
  icon.classList.toggle("fa-regular", !saved);
}

function syncBookmarkButtons(root = document) {
  const buttons = root.querySelectorAll("[data-save-job=\"1\"]");
  buttons.forEach((btn) => {
    const card = btn.closest(".job-card");
    const jobId = getOrCreateJobIdFromCard(card);
    setBookmarkButtonState(btn, isJobSaved(jobId));
  });
}

async function apiRequest(pathname, { method = "GET", body = null, auth = false } = {}) {
  const DEFAULT_API_BASE = "http://localhost:3000";
  const getApiBase = () => {
    try {
      const stored = String(localStorage.getItem("smartHuntApiBase") || "").trim();
      return stored || DEFAULT_API_BASE;
    } catch {
      return DEFAULT_API_BASE;
    }
  };
  const resolveApiUrl = (p) => {
    const value = String(p || "");
    if (/^https?:\/\//i.test(value)) return value;
    const proto = window.location && window.location.protocol ? window.location.protocol : "";
    if (proto === "file:") {
      const base = getApiBase().replace(/\/+$/, "");
      if (!value) return base;
      if (value.startsWith("/")) return `${base}${value}`;
      return `${base}/${value}`;
    }
    return value;
  };

  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = localStorage.getItem(STORAGE_AUTH_TOKEN_KEY);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const url = resolveApiUrl(pathname);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });
  } catch (e) {
    const message =
      (window.location && window.location.protocol === "file:")
        ? `Backend API not reachable. Start the server (node server.js) and refresh. (${url})`
        : `Network error calling API. (${url})`;
    const err = new Error(message);
    throw err;
  }

  const contentType = res.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await res.json() : null;
  if (!res.ok) {
    const message = payload && payload.error ? payload.error : `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return payload;
}

function isNetworkError(err) {
  return !(err && typeof err.status === "number");
}

async function tryApi(pathname, options) {
  try {
    return await apiRequest(pathname, options);
  } catch (err) {
    if (isNetworkError(err)) return null;
    throw err;
  }
}

function getLoggedInRole() {
  return localStorage.getItem("userRole") || "";
}

function getLoggedIn() {
  return localStorage.getItem("isLoggedIn") === "true";
}

async function fetchJobs() {
  const data = await tryApi("/api/jobs", { method: "GET" });
  return data && data.ok && Array.isArray(data.jobs) ? data.jobs : null;
}

async function setEmployerJobPostingStatus(jobId, status) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("Job id required");
  const next = String(status || "").trim().toLowerCase();
  if (next !== "open" && next !== "closed") throw new Error("Invalid job status");
  await apiRequest(`/api/jobs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    auth: true,
    body: { status: next },
  });
  emitSyncEvent("jobs_updated", { jobId: id, status: next });
}

function formatJobCompany(job) {
  const company = job.company || "Company";
  const location = job.location ? ` - ${job.location}` : "";
  return `${company}${location}`;
}

function isPlaceholderText(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return !v || v === "n/a" || v === "na" || v === "none" || v === "null" || v === "tbd" || v === "not applicable";
}

function formatSeekerJobMeta(job) {
  const companyRaw = String(job && job.company ? job.company : "").trim();
  const locationRaw = String(job && job.location ? job.location : "").trim();
  const company = companyRaw && !isPlaceholderText(companyRaw) ? companyRaw : "Not specified";
  const location = locationRaw && !isPlaceholderText(locationRaw) ? locationRaw : "Not specified";
  return `Company: ${company} \u2022 Location: ${location}`;
}

function formatSeekerJobCompany(job) {
  const companyRaw = String(job && job.company ? job.company : "").trim();
  return companyRaw && !isPlaceholderText(companyRaw) ? companyRaw : "Not specified";
}

function formatSeekerJobLocation(job) {
  const locationRaw = String(job && job.location ? job.location : "").trim();
  return locationRaw && !isPlaceholderText(locationRaw) ? locationRaw : "Not specified";
}

function formatSeekerJobPay(job) {
  const raw = String(job && job.salary ? job.salary : "")
    .replace(/\s+/g, " ")
    .trim();
  if (isPlaceholderText(raw)) return "Not specified";
  // Prevent awkward wrapping where a hyphen ends up alone at the start of a new line on mobile.
  return raw.replace(/\s*-\s*/g, "\u00A0\u2013\u00A0");
}

function getSeekerJobBadge(job) {
  const createdMs = isoToMs(job && job.createdAt ? job.createdAt : "");
  if (!createdMs) return "Open";
  const days = Math.floor((Date.now() - createdMs) / (24 * 60 * 60 * 1000));
  return days <= 7 ? "New" : "Open";
}

function getSeekerPostedLabel(job) {
  const createdMs = isoToMs(job && job.createdAt ? job.createdAt : "");
  if (!createdMs) return "Recently";
  const diffDays = Math.max(0, Math.floor((Date.now() - createdMs) / (24 * 60 * 60 * 1000)));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

function getSeekerJobDescription(job) {
  const raw = String(job && job.description ? job.description : "").trim();
  if (!raw || isPlaceholderText(raw)) return "No description provided.";
  return raw;
}

function getSeekerJobSummary(job) {
  const description = getSeekerJobDescription(job);
  if (description === "No description provided.") return description;
  return description.length > 140 ? `${description.slice(0, 140).trimEnd()}...` : description;
}

function getSeekerJobTags(job) {
  const rawLines = String(job && job.requirements ? job.requirements : "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\-\*\u2022]\s*/, "").trim())
    .filter(Boolean);

  const cleaned = rawLines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => !isPlaceholderText(line))
    .slice(0, 2);

  return cleaned.length ? cleaned : ["No requirements listed"];
}

function getSeekerJobRequirementList(job) {
  const rawLines = String(job && job.requirements ? job.requirements : "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\-\*\u2022]\s*/, "").trim())
    .filter(Boolean);

  const cleaned = rawLines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => !isPlaceholderText(line));

  return cleaned.length ? cleaned : ["No requirements listed."];
}

function isJobOpen(job) {
  return String(job && job.status ? job.status : "open").toLowerCase() !== "closed";
}

function isElementVisibleForRender(id) {
  const el = document.getElementById(id);
  return Boolean(el && el.style.display !== "none");
}

function renderSeekerJobs(jobs, { emptyText = "" } = {}) {
  const grid = document.getElementById("recommendedJobsGrid");
  if (!grid) return;
  const empty = document.getElementById("recommendedJobsEmpty");
  grid.replaceChildren();
  const list = Array.isArray(jobs) ? jobs : [];
  if (empty) {
    empty.style.display = list.length ? "none" : "block";
    if (!list.length) {
      empty.textContent = emptyText || "No jobs posted yet.";
    }
  }
  const fragment = document.createDocumentFragment();
  list.forEach((job, index) => {
    const card = document.createElement("article");
    card.className = "job-card" + (index >= 3 ? " hidden-reco" : "");
    card.setAttribute("data-job-id", job.id);

    const pay = formatSeekerJobPay(job);
    const badgeText = getSeekerJobBadge(job);

    card.innerHTML = `
      <div class="job-header">
        <span class="job-badge"></span>
        <button class="icon-btn small" type="button" data-save-job="1" aria-label="Save job"><i class="fa-regular fa-bookmark"></i></button>
      </div>
      <h3></h3>
      <p class="job-meta-line"></p>
      <div class="job-facts"></div>
      <div class="job-footer">
        <div class="job-pay">
          <span class="job-pay-label">Pay</span>
          <strong></strong>
        </div>
        <div class="job-actions">
          <button class="pill-btn secondary" type="button" onclick="openQuickView(this)">View Info</button>
          <button class="pill-btn" type="button" onclick="openApplyForm(this)">Apply</button>
        </div>
      </div>
    `;

    const badgeEl = card.querySelector(".job-badge");
    const titleEl = card.querySelector("h3");
    const companyEl = card.querySelector("p");
    const factsEl = card.querySelector(".job-facts");
    const salaryEl = card.querySelector(".job-footer strong");
    if (badgeEl) badgeEl.textContent = badgeText;
    if (titleEl) titleEl.textContent = job.title || "Job";
    if (companyEl) companyEl.textContent = formatSeekerJobCompany(job);
    if (factsEl) {
      factsEl.innerHTML = "";
      [formatSeekerJobLocation(job), getSeekerPostedLabel(job)].forEach((value) => {
        const span = document.createElement("span");
        span.textContent = value;
        factsEl.appendChild(span);
      });
    }
    if (salaryEl) salaryEl.textContent = pay;

    fragment.appendChild(card);
  });
  grid.appendChild(fragment);

  // Update bookmark state after rendering.
  syncBookmarkButtons(grid);
  // Lock "Apply" buttons for jobs the hunter already applied to.
  syncSeekerApplyButtons(grid);

  const viewBtn = document.getElementById("recoViewAllBtn");
  const returnBtn = document.getElementById("recoReturnBtn");
  const hasMore = list.length > 3;
  if (viewBtn) viewBtn.classList.toggle("is-hidden", !hasMore);
  if (returnBtn) returnBtn.classList.add("is-hidden");
}

function findRenderedJobById(jobId) {
  const id = String(jobId || "").trim();
  if (!id || !Array.isArray(cachedJobs)) return null;
  return cachedJobs.find((job) => String(job && job.id ? job.id : "") === id) || null;
}

async function openQuickViewForJobId(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return;
  const modal = document.getElementById("quickViewModal");
  if (!modal) return;

  let job = findRenderedJobById(id);
  if (!job) {
    try {
      const jobs = await getJobsSnapshot();
      if (Array.isArray(jobs)) {
        job = jobs.find((j) => String(j && j.id ? j.id : "") === id) || null;
      }
    } catch {
      job = null;
    }
  }

  if (!job) {
    alert("Job not found.");
    return;
  }
  renderQuickViewDetails(job);
  try {
    modal.setAttribute("data-job-id", String(job.id || id));
  } catch {
    // ignore
  }
  syncSeekerApplyButtons(document);
  modal.style.display = "flex";
}

function renderQuickViewDetails(job) {
  const badgeEl = document.getElementById("quickViewBadge");
  const titleEl = document.getElementById("quickViewTitle");
  const companyEl = document.getElementById("quickViewCompany");
  const salaryEl = document.getElementById("quickViewSalary");
  const tagsEl = document.getElementById("quickViewTags");
  const locationEl = document.getElementById("quickViewLocation");
  const postedEl = document.getElementById("quickViewPosted");
  const descriptionEl = document.getElementById("quickViewDescription");
  const requirementsEl = document.getElementById("quickViewRequirements");

  if (badgeEl) badgeEl.textContent = getSeekerJobBadge(job);
  if (titleEl) titleEl.textContent = job.title || "Role Overview";
  if (companyEl) companyEl.textContent = `${formatSeekerJobCompany(job)} • ${formatSeekerJobLocation(job)}`;
  if (salaryEl) salaryEl.textContent = formatSeekerJobPay(job);
  if (locationEl) locationEl.textContent = formatSeekerJobLocation(job);
  if (postedEl) postedEl.textContent = getSeekerPostedLabel(job);
  if (descriptionEl) descriptionEl.textContent = getSeekerJobDescription(job);
  if (tagsEl) {
    tagsEl.innerHTML = "";
    // Tags were duplicates of requirements; keep the section hidden in the Quick View.
    try {
      tagsEl.style.display = "none";
    } catch {
      // ignore
    }
  }
  if (requirementsEl) {
    requirementsEl.innerHTML = "";
    getSeekerJobRequirementList(job).forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      requirementsEl.appendChild(li);
    });
  }
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\-_\/]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSeekerProfileCacheKey(userId) {
  const id = String(userId || "").trim();
  return id ? `${SEEKER_PROFILE_CACHE_KEY_PREFIX}${id}` : "";
}

function getSeekerRecommendationTitleFromProfile(profile) {
  if (!profile || typeof profile !== "object") return "";
  return String(profile.title || profile.headline || "").trim();
}

function readSeekerRecommendationTitleFromLocalCache(userId) {
  const key = getSeekerProfileCacheKey(userId);
  if (!key) return "";
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    return getSeekerRecommendationTitleFromProfile(parsed);
  } catch {
    return "";
  }
}

function getSeekerRecommendationTitle() {
  if (!getLoggedIn() || getLoggedInRole() !== "seeker") return "";
  const userId = String(localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "").trim();
  if (!userId) return "";

  const now = Date.now();
  if (
    seekerRecommendationProfile.userId === userId &&
    now - (Number(seekerRecommendationProfile.fetchedAt) || 0) < SEEKER_PROFILE_TITLE_CACHE_TTL_MS
  ) {
    return String(seekerRecommendationProfile.title || "").trim();
  }

  const title = readSeekerRecommendationTitleFromLocalCache(userId);
  seekerRecommendationProfile = {
    userId,
    title,
    fetchedAt: now,
    refreshPromise: seekerRecommendationProfile.refreshPromise || null,
  };
  return title;
}

async function refreshSeekerRecommendationTitle() {
  if (!getLoggedIn() || getLoggedInRole() !== "seeker") return false;
  const userId = String(localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "").trim();
  if (!userId) return false;
  if (seekerRecommendationProfile.userId !== userId) {
    seekerRecommendationProfile = { userId, title: "", fetchedAt: 0, refreshPromise: null };
  }
  if (seekerRecommendationProfile.refreshPromise) {
    return seekerRecommendationProfile.refreshPromise;
  }

  const request = (async () => {
    try {
      const data = await tryApi("/api/profile", { method: "GET", auth: true });
      const nextTitle = getSeekerRecommendationTitleFromProfile(data && data.ok ? data.profile : null);
      const prevTitle = String(seekerRecommendationProfile.title || "").trim();
      seekerRecommendationProfile = {
        userId,
        title: nextTitle,
        fetchedAt: Date.now(),
        refreshPromise: null,
      };
      return nextTitle !== prevTitle;
    } catch {
      seekerRecommendationProfile = {
        userId,
        title: seekerRecommendationProfile.title || "",
        fetchedAt: Date.now(),
        refreshPromise: null,
      };
      return false;
    }
  })();

  seekerRecommendationProfile.refreshPromise = request;
  return request;
}

function getRecommendationTerms(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter(Boolean)
    .filter((term) => term.length > 1)
    .filter((term) => !["a", "an", "and", "for", "of", "the", "to", "with"].includes(term));
}

function expandRecommendationTerms(terms) {
  const expanded = new Set(Array.isArray(terms) ? terms : []);
  const synonymGroups = [
    ["developer", "developers", "engineer", "engineers", "programmer", "programmers", "coder", "coders"],
    ["frontend", "front", "ui", "web"],
    ["backend", "back", "server", "api"],
    ["fullstack", "full", "stack"],
    ["mobile", "android", "ios", "app"],
    ["data", "analyst", "analytics", "bi"],
    ["design", "designer", "ux", "ui"],
    ["marketing", "marketer", "seo", "content"],
    ["teacher", "tutor", "instructor", "educator"],
    ["accounting", "accountant", "finance", "bookkeeper"],
    ["sales", "seller", "business", "development"],
    ["support", "service", "customer"],
  ];

  expanded.forEach((term) => {
    synonymGroups.forEach((group) => {
      if (!group.includes(term)) return;
      group.forEach((alt) => expanded.add(alt));
    });
  });

  return expanded;
}

function getSeekerRecommendationScore(job, profileTitle) {
  const targetTitle = normalizeSearchText(profileTitle);
  const jobTitle = normalizeSearchText(job && job.title ? job.title : "");
  if (!targetTitle || !jobTitle) return 0;

  let score = 0;
  if (jobTitle === targetTitle) score += 200;
  if (jobTitle.includes(targetTitle)) score += 120;
  if (targetTitle.includes(jobTitle)) score += 80;

  const profileTerms = getRecommendationTerms(profileTitle);
  const expandedTerms = expandRecommendationTerms(profileTerms);
  const titleTerms = new Set(getRecommendationTerms(jobTitle));
  const bodyTerms = new Set(getRecommendationTerms(`${job && job.description ? job.description : ""} ${job && job.requirements ? job.requirements : ""}`));

  profileTerms.forEach((term) => {
    if (titleTerms.has(term)) score += 32;
    else if (bodyTerms.has(term)) score += 10;
  });

  expandedTerms.forEach((term) => {
    if (profileTerms.includes(term)) return;
    if (titleTerms.has(term)) score += 12;
    else if (bodyTerms.has(term)) score += 4;
  });

  return score;
}

function rankJobsForSeekerProfile(jobs, profileTitle) {
  const list = Array.isArray(jobs) ? jobs.slice() : [];
  const title = String(profileTitle || "").trim();
  if (!title) return list;

  return list
    .map((job, index) => ({
      job,
      index,
      score: getSeekerRecommendationScore(job, title),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const byDate = String(b.job && b.job.createdAt ? b.job.createdAt : "").localeCompare(
        String(a.job && a.job.createdAt ? a.job.createdAt : ""),
      );
      if (byDate !== 0) return byDate;
      return a.index - b.index;
    })
    .map((entry) => entry.job);
}

function filterJobs(jobs, { keywords = "", location = "" } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const kw = normalizeSearchText(keywords);
  const loc = normalizeSearchText(location);
  const terms = kw ? kw.split(" ").filter(Boolean) : [];

  return list.filter((job) => {
    const hayTitle = normalizeSearchText(job && job.title ? job.title : "");
    const hayCompany = normalizeSearchText(job && job.company ? job.company : "");
    const hayLocation = normalizeSearchText(job && job.location ? job.location : "");
    const hayDesc = normalizeSearchText(job && job.description ? job.description : "");
    const hayReq = normalizeSearchText(job && job.requirements ? job.requirements : "");
    const hayAll = `${hayTitle} ${hayCompany} ${hayLocation} ${hayDesc} ${hayReq}`.trim();

    const matchKw = !terms.length || terms.every((t) => hayAll.includes(t));
    const matchLoc = !loc || hayLocation.includes(loc) || hayAll.includes(loc);
    return matchKw && matchLoc;
  });
}

function getActiveSearch() {
  const keywords = seekerSearchState ? String(seekerSearchState.keywords || "") : "";
  const location = seekerSearchState ? String(seekerSearchState.location || "") : "";
  const hasQuery = Boolean(normalizeSearchText(keywords) || normalizeSearchText(location));
  return { keywords, location, hasQuery };
}

function renderSeekerJobsWithSearch(jobs) {
  const openJobs = Array.isArray(jobs) ? jobs.filter(isJobOpen) : jobs;
  const { keywords, location, hasQuery } = getActiveSearch();
  if (!hasQuery) {
    renderSeekerJobs(rankJobsForSeekerProfile(openJobs, getSeekerRecommendationTitle()));
    refreshSeekerRecommendationTitle()
      .then((changed) => {
        if (changed && cachedJobs) renderSeekerJobsWithSearch(cachedJobs);
      })
      .catch(() => {});
    return;
  }

  const results = filterJobs(openJobs, { keywords, location });
  renderSeekerJobs(results, { emptyText: "No jobs found." });

  // Searching is already scoped; hide "View All / Return" controls.
  const viewBtn = document.getElementById("recoViewAllBtn");
  const returnBtn = document.getElementById("recoReturnBtn");
  if (viewBtn) viewBtn.classList.add("is-hidden");
  if (returnBtn) returnBtn.classList.add("is-hidden");
}

async function getJobsSnapshot() {
  const freshEnough = cachedJobs && Date.now() - cachedJobsFetchedAt < 15000;
  if (freshEnough) return cachedJobs;
  if (jobsSnapshotPromise) return jobsSnapshotPromise;

  jobsSnapshotPromise = (async () => {
    const jobs = await fetchJobs();
    if (!jobs) return cachedJobs;
    cachedJobs = jobs;
    cachedJobsFetchedAt = Date.now();
    return jobs;
  })();

  try {
    return await jobsSnapshotPromise;
  } finally {
    jobsSnapshotPromise = null;
  }
}

function setupSeekerSearch() {
  const keywordsEl = document.getElementById("seekerSearchKeywords");
  const locationEl = document.getElementById("seekerSearchLocation");
  const btn = document.getElementById("seekerSearchBtn");
  if (!keywordsEl || !locationEl || !btn) return;

  const scrollRecommendedJobsIntoView = () => {
    const target =
      document.getElementById("recommendedJobsSection") ||
      document.getElementById("recommendedJobsBox") ||
      document.getElementById("recommendedJobsGrid");
    if (!target) return;

    const navbar = document.querySelector(".navbar");
    const navbarHeight = navbar ? navbar.getBoundingClientRect().height : 0;
    const top = window.pageYOffset + target.getBoundingClientRect().top - navbarHeight - 12;
    const safeTop = Math.max(0, top);

    try {
      window.scrollTo({ top: safeTop, behavior: "smooth" });
    } catch {
      window.scrollTo(0, safeTop);
    }
  };

  const run = async () => {
    const jobs = await withPageLoader(() => getJobsSnapshot(), {
      message: "Searching jobs...",
      minDuration: 250,
    });
    if (!Array.isArray(jobs)) {
      alert("Backend is not reachable yet. Start the server (node server.js) and try again.");
      return;
    }

    const keywords = String(keywordsEl.value || "");
    const location = String(locationEl.value || "");
    seekerSearchState = { keywords, location };
    renderSeekerJobsWithSearch(jobs);
    if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
      setTimeout(scrollRecommendedJobsIntoView, 60);
    }
  };

  btn.addEventListener("click", () => run());
  const onKey = (e) => {
    if (e && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  };
  keywordsEl.addEventListener("keydown", onKey);
  locationEl.addEventListener("keydown", onKey);
}

function clearEmployerPostedJobSamples() {
  document.querySelectorAll("#employeePage .posted-job-card, #employeePage .posted-applicants").forEach((el) => el.remove());
}

function ensureEmployerPostedContainer() {
  const section = document.querySelector("#employeePage .match-section");
  if (!section) return null;
  let container = document.getElementById("postedJobsList");
  if (container) return container;
  const search = section.querySelector(".posted-search");
  container = document.createElement("div");
  container.id = "postedJobsList";
  if (search && search.parentNode) {
    search.parentNode.insertBefore(container, search.nextSibling);
  } else {
    section.appendChild(container);
  }
  return container;
}

function captureEmployerPostedApplicantsUIState(container) {
  const state = { openJobIds: [], openAppIdsByJobId: {} };
  if (!container) return state;

  container.querySelectorAll('.posted-applicants.show[data-job-id]').forEach((panel) => {
    const jobId = String(panel.getAttribute("data-job-id") || "");
    if (!jobId) return;
    state.openJobIds.push(jobId);

    const openApps = [];
    panel.querySelectorAll('.posted-applicant-detail.show[data-application-id]').forEach((detail) => {
      const appId = String(detail.getAttribute("data-application-id") || "");
      if (appId) openApps.push(appId);
    });
    if (openApps.length) state.openAppIdsByJobId[jobId] = openApps;
  });

  return state;
}

function getEmployerPostedJobsPageSize() {
  try {
    const isMobile = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
    return isMobile ? 3 : 6;
  } catch {
    return 6;
  }
}

function renderEmployerPostedJobs(jobs) {
  const container = ensureEmployerPostedContainer();
  const uiState = captureEmployerPostedApplicantsUIState(container);
  clearEmployerPostedJobSamples();
  if (!container) return;
  container.replaceChildren();

  const list = Array.isArray(jobs) ? jobs.filter(isJobOpen) : [];
  const pageSize = getEmployerPostedJobsPageSize();
  const canToggle = list.length > pageSize;
  const visibleList = !canToggle || employerPostedJobsShowAll ? list : list.slice(0, pageSize);
  const fragment = document.createDocumentFragment();

  const kpiCards = document.querySelectorAll("#employeePage .kpi-card .kpi-value");
  if (kpiCards.length >= 2) {
    kpiCards[0].textContent = String(list.length);
    const totalApplicants = list.reduce((sum, j) => sum + (Number(j.applicantCount) || 0), 0);
    kpiCards[1].textContent = String(totalApplicants);
  }

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state-box";
    empty.style.marginTop = "12px";
    empty.textContent = "No job postings yet. Create one from Post Job.";
    container.appendChild(empty);
    return;
  }

  if (canToggle) {
    const toolbar = document.createElement("div");
    toolbar.className = "posted-jobs-toolbar";
    toolbar.innerHTML = `
      <div class="posted-jobs-toolbar__text"></div>
      <button class="employer-text-btn posted-jobs-toolbar__btn" type="button"></button>
    `;
    const text = toolbar.querySelector(".posted-jobs-toolbar__text");
    const btn = toolbar.querySelector("button");
    if (text) {
      const showing = employerPostedJobsShowAll ? list.length : visibleList.length;
      text.textContent = `Showing ${showing} of ${list.length} posted jobs`;
    }
    if (btn) {
      btn.textContent = employerPostedJobsShowAll ? "Show less" : "View all";
      btn.addEventListener("click", () => {
        employerPostedJobsShowAll = !employerPostedJobsShowAll;
        renderEmployerPostedJobs(jobs);
        window.scrollTo(0, 0);
      });
    }
    fragment.appendChild(toolbar);
  }

  visibleList.forEach((job) => {
    const block = document.createElement("div");
    block.className = "posted-job-block";

    const card = document.createElement("div");
    card.className = "match-card posted-job-card";
    card.setAttribute("data-job-id", job.id);
    const count = Number(job.applicantCount) || 0;
    card.innerHTML = `
      <div class="posted-job-info">
        <h3></h3>
        <p></p>
      </div>
      <button class="employer-text-btn" type="button">Applicants</button>
    `;
    const titleEl = card.querySelector("h3");
    const metaEl = card.querySelector("p");
    if (titleEl) titleEl.textContent = job.title || "Job";
    if (metaEl) metaEl.textContent = `Posted • ${count} applicant${count === 1 ? "" : "s"}`;

    const panel = document.createElement("div");
    panel.className = "posted-applicants";
    panel.setAttribute("data-job-id", job.id);

    const btn = card.querySelector("button");
    if (btn) {
      btn.addEventListener("click", async () => {
        const isOpen = panel.classList.toggle("show");
        btn.textContent = isOpen ? "Hide Applicants" : "Applicants";
        if (isOpen) {
          await loadApplicantsForJob(job.id, panel);
        }
      });
    }

    block.appendChild(card);
    block.appendChild(panel);
    fragment.appendChild(block);
  });
  container.appendChild(fragment);

  // Restore open applicants panels/details after refresh (prevents chat sending from collapsing Details).
  try {
    const openJobs = Array.isArray(uiState.openJobIds) ? uiState.openJobIds : [];
    openJobs.forEach((jobId) => {
      const panel = container.querySelector(`.posted-applicants[data-job-id="${jobId}"]`);
      const card = container.querySelector(`.posted-job-card[data-job-id="${jobId}"]`);
      const btn = card ? card.querySelector("button") : null;
      if (!panel) return;
      panel.classList.add("show");
      if (btn) btn.textContent = "Hide Applicants";
      loadApplicantsForJob(jobId, panel)
        .then(() => {
          const openApps = (uiState.openAppIdsByJobId && uiState.openAppIdsByJobId[jobId]) ? uiState.openAppIdsByJobId[jobId] : [];
          openApps.forEach((appId) => {
            const detailsBtn = panel.querySelector(
              `.posted-applicants-row[data-application-id="${appId}"] button[data-action="details"]`,
            );
            if (detailsBtn) detailsBtn.click();
          });
        })
        .catch(() => {});
    });
  } catch {
    // ignore
  }

  // If a notification requested opening a specific application, do it now.
  try {
    const pendingRaw = sessionStorage.getItem("pendingEmployerOpenApp");
    if (pendingRaw) {
      const pending = JSON.parse(pendingRaw);
      const pendingJobId = pending && pending.jobId ? String(pending.jobId) : "";
      const pendingAppId = pending && pending.applicationId ? String(pending.applicationId) : "";
      if (pendingJobId) {
        const panel = container.querySelector(`.posted-applicants[data-job-id="${pendingJobId}"]`);
        const card = container.querySelector(`.posted-job-card[data-job-id="${pendingJobId}"]`);
        const btn = card ? card.querySelector("button") : null;
        if (panel) panel.classList.add("show");
        if (btn) btn.textContent = "Hide Applicants";
        if (panel) {
          loadApplicantsForJob(pendingJobId, panel)
            .then(() => {
              if (!pendingAppId) return;
              const row = panel.querySelector(`.posted-applicants-row[data-application-id="${pendingAppId}"]`);
              if (row && typeof row.scrollIntoView === "function") {
                row.scrollIntoView({ behavior: "smooth", block: "center" });
              }
              const detailsBtn = panel.querySelector(
                `.posted-applicants-row[data-application-id="${pendingAppId}"] button[data-action="details"]`,
              );
              if (detailsBtn) detailsBtn.click();
              // After expanding details, keep the opened applicant in view (especially on mobile).
              window.setTimeout(() => {
                const detail = panel.querySelector(`.posted-applicant-detail[data-application-id="${pendingAppId}"]`);
                if (detail && typeof detail.scrollIntoView === "function") {
                  detail.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }, 90);
            })
            .finally(() => {
              sessionStorage.removeItem("pendingEmployerOpenApp");
            });
        } else {
          sessionStorage.removeItem("pendingEmployerOpenApp");
        }
      } else {
        sessionStorage.removeItem("pendingEmployerOpenApp");
      }
    }
  } catch {
    // ignore
  }
}

async function loadApplicantsForJob(jobId, panel) {
  if (!panel) return;

  const options = (arguments && arguments.length >= 3 && arguments[2] && typeof arguments[2] === "object") ? arguments[2] : {};
  const quiet = Boolean(options && options.quiet);
  const force = Boolean(options && options.force);
  const cacheKey = String(jobId || "").trim();

  // If we already rendered this same job recently, don't show a loading state again.
  if (!force && cacheKey) {
    const loadedFor = String(panel.getAttribute("data-loaded-job-id") || "");
    const loadedAt = Number(panel.getAttribute("data-loaded-at") || 0) || 0;
    const fresh = loadedFor === cacheKey && loadedAt && Date.now() - loadedAt < EMPLOYER_JOB_APPLICANTS_CACHE_TTL_MS;
    if (fresh && panel.children && panel.children.length) {
      return;
    }
  }

  if (!quiet) {
    panel.innerHTML = "<div style='padding:14px;color:#bbb;'>Loading applicants...</div>";
  }
  try {
    const data = await apiRequest(`/api/applications?jobId=${encodeURIComponent(jobId)}`, { method: "GET", auth: true });
    const apps = data && data.ok && Array.isArray(data.applications) ? data.applications : [];
    if (cacheKey) {
      employerJobApplicantsCache.set(cacheKey, { apps, fetchedAt: Date.now() });
      panel.setAttribute("data-loaded-job-id", cacheKey);
      panel.setAttribute("data-loaded-at", String(Date.now()));
    }
    if (!apps.length) {
      panel.innerHTML = "<div style='padding:14px;color:#bbb;'>No applicants yet.</div>";
      return;
    }
    panel.innerHTML = "";
    apps.forEach((a) => {
      const row = document.createElement("div");
      row.className = "posted-applicants-row";
      if (a && a.id) row.setAttribute("data-application-id", String(a.id));
      const name = a.seekerName || "Hunter";
      const email = a.seekerEmail || "";
      const status = String(a.status || "applied").toLowerCase();
      const statusClass = status === "rejected" ? "rejected" : status === "passed" ? "shortlist" : status === "pending" ? "interview" : "new";
      const statusLabel = status === "rejected" ? "Rejected" : status === "passed" ? "Passed" : status === "pending" ? "Pending" : "Applied";
      row.innerHTML = `
        <div class="posted-applicant-left">
          <div>
            <h4></h4>
            <p></p>
          </div>
        </div>
        <div class="posted-applicants-actions">
          <span class="status-tag ${statusClass}" data-role="statusTag">${statusLabel}</span>
          <button class="employer-text-btn" type="button" data-action="details">Details</button>
          <button class="employer-text-btn" type="button" data-status="pending">Pending</button>
        </div>
      `;
      const h4 = row.querySelector("h4");
      const p = row.querySelector("p");
      if (h4) h4.textContent = name;
      if (p) p.textContent = email ? `Applied • ${email}` : "Applied";

      const pendingBtn = row.querySelector('button[data-status="pending"]');
      if (pendingBtn && status === "pending") {
        pendingBtn.disabled = true;
        pendingBtn.style.opacity = "0.65";
        pendingBtn.style.cursor = "default";
        pendingBtn.title = "Already pending.";
      }

      const detail = document.createElement("div");
      detail.className = "posted-applicant-detail";
      if (a && a.id) detail.setAttribute("data-application-id", String(a.id));
      detail.innerHTML = `
        <div class="detail-grid">
          <div>
            <p class="detail-label">Role</p>
            <p class="detail-value">${a.jobTitle || "Applicant"}</p>
          </div>
          <div>
            <p class="detail-label">Email</p>
            <p class="detail-value">${email || "—"}</p>
          </div>
          <div>
            <p class="detail-label">Location</p>
            <p class="detail-value" data-location>—</p>
          </div>
          <div>
            <p class="detail-label">Facebook</p>
            <p class="detail-value" data-facebook>—</p>
          </div>
        </div>
        <div class="detail-actions">
          <button class="detail-btn primary" type="button" data-action="resume"><i class="fa-regular fa-file"></i> File</button>
          <button class="detail-btn ghost" type="button" data-action="profile"><i class="fa-regular fa-address-card"></i> Profile</button>
        </div>
        <p class="detail-note" data-note>Use the message box below to communicate with this applicant.</p>
        <div class="detail-message-box">
          <div class="detail-message-head">
            <p class="detail-label">Conversation</p>
            <button class="icon-btn small" type="button" data-action="expand-message" aria-label="Expand message" title="Expand">
              <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
            </button>
          </div>
          <div class="detail-message">
            <div class="chat-thread" data-thread></div>
          </div>
          <div class="detail-chat">
            <input type="text" data-input placeholder="Write a message...">
            <label class="chat-attach" aria-label="Attach file">
              <input type="file" data-file accept="image/*,.pdf,.doc,.docx">
              <i class="fa-solid fa-paperclip"></i>
            </label>
            <button class="employer-text-btn" type="button" data-action="send">Send</button>
          </div>
        </div>
      `;

      const detailsBtn = row.querySelector('button[data-action="details"]');
      const messageBox = detail.querySelector(".detail-message-box");
      if (messageBox) {
        setupEmployerMessageExpandUi(messageBox);
      }
      if (detailsBtn) {
        detailsBtn.addEventListener("click", async () => {
          const willShow = !detail.classList.contains("show");
          detail.classList.toggle("show", willShow);
          detailsBtn.textContent = willShow ? "Hide" : "Details";
          if (!willShow) return;

          // Load profile (best-effort) for location/facebook + resume
          let loadedProfile = null;
          try {
            if (a.seekerId) {
              const u = await apiRequest(`/api/users/${encodeURIComponent(a.seekerId)}`, { method: "GET", auth: true });
              loadedProfile = (u && u.ok && u.profile) ? u.profile : null;
              const profile = loadedProfile || {};
              const contact = profile.contact && typeof profile.contact === "object" ? profile.contact : {};
              const loc = detail.querySelector("[data-location]");
              const fb = detail.querySelector("[data-facebook]");
              if (loc) loc.textContent = contact.location || profile.location || "—";
              if (fb) fb.textContent = contact.facebook || "—";
              const note = detail.querySelector("[data-note]");
              const about = String(profile.aboutText || profile.about || "").trim();
              if (note && about) note.textContent = about;

            }
          } catch {
            loadedProfile = null;
          }

          const resumeBtn = detail.querySelector('button[data-action="resume"]');
          if (resumeBtn) {
            resumeBtn.onclick = () => {
              const profileBtnLocal = detail.querySelector('button[data-action="profile"]');
              resumeBtn.classList.add("is-active");
              if (profileBtnLocal) profileBtnLocal.classList.remove("is-active");
              const profile = loadedProfile || {};
              const files = extractUploadedFilesFromProfile(profile);
              openFilePicker(files, { title: "Choose a file", sub: "Select a seeker-uploaded file to open." });
            };
          }

          const profileBtn = detail.querySelector('button[data-action="profile"]');
          if (profileBtn) {
            profileBtn.onclick = () => {
              const resumeBtnLocal = detail.querySelector('button[data-action="resume"]');
              if (resumeBtnLocal) resumeBtnLocal.classList.remove("is-active");
              if (!a.seekerId) {
                alert("Missing seeker id for this application.");
                return;
              }
              goToSeekerProfileReview(a.seekerId);
            };
          }

          const thread = detail.querySelector("[data-thread]");

          try {
            const m = await apiRequest(`/api/messages?applicationId=${encodeURIComponent(a.id)}`, { method: "GET", auth: true });
            const msgs = (m && m.ok && Array.isArray(m.messages)) ? m.messages : [];
            renderConversationThread(thread, msgs, a.id);
          } catch (err) {
            if (thread) {
              thread.innerHTML = `<div style='color:#ffb4b4;font-size:12px;'>${err?.message || "Failed to load messages."}</div>`;
            }
          }

          const sendBtn = detail.querySelector('button[data-action="send"]');
          const input = detail.querySelector("input[data-input]");
          const fileInput = detail.querySelector("input[data-file]");
          const send = async () => {
            const text = (input?.value || "").trim();
            const file = fileInput?.files && fileInput.files[0] ? fileInput.files[0] : null;
            let attachment = null;
            if (!text && !file) return;
            let restoreSendBtn = null;
            if (sendBtn && !sendBtn.disabled) {
              const originalText = sendBtn.textContent;
              sendBtn.disabled = true;
              sendBtn.textContent = "Sending...";
              restoreSendBtn = () => {
                sendBtn.disabled = false;
                sendBtn.textContent = originalText || "Send";
              };
            }
            try {
              if (file) attachment = await buildConversationAttachment(file);
              await apiRequest("/api/messages", {
                method: "POST",
                auth: true,
                body: { applicationId: a.id, text, ...(attachment ? { attachment } : {}) },
              });
              if (input) input.value = "";
              if (fileInput) fileInput.value = "";
              const m2 = await apiRequest(`/api/messages?applicationId=${encodeURIComponent(a.id)}`, { method: "GET", auth: true });
              const msgs2 = (m2 && m2.ok && Array.isArray(m2.messages)) ? m2.messages : [];
              renderConversationThread(thread, msgs2, a.id);
              emitSyncEvent("messages_updated", { applicationId: a.id, jobId });
            } catch (err) {
              alert(err?.message || "Failed to send message.");
            } finally {
              if (restoreSendBtn) restoreSendBtn();
            }
          };
          if (sendBtn) sendBtn.onclick = send;
          if (input) {
            input.onkeydown = (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                send();
              }
            };
          }
        });
      }

      row.querySelectorAll("button[data-status]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (btn.disabled) return;
          const statusButtons = Array.from(row.querySelectorAll("button[data-status]"));
          const originalStates = statusButtons.map((node) => ({
            node,
            disabled: Boolean(node.disabled),
            text: String(node.textContent || ""),
          }));
          try {
            const next = String(btn.getAttribute("data-status") || "").trim().toLowerCase();
            statusButtons.forEach((node) => {
              node.disabled = true;
            });
            btn.textContent = "Saving...";
            await apiRequest(`/api/applications/${encodeURIComponent(a.id)}`, {
              method: "PATCH",
              auth: true,
              body: { status: next },
            });

            // Update UI in-place (avoid reloading/closing the whole list).
            a.status = next;
            const statusClass = next === "rejected" ? "rejected" : next === "passed" ? "shortlist" : next === "pending" ? "interview" : "new";
            const statusLabel = next === "rejected" ? "Rejected" : next === "passed" ? "Passed" : next === "pending" ? "Pending" : "Applied";
            const tag = row.querySelector('[data-role="statusTag"]');
            if (tag) {
              tag.className = `status-tag ${statusClass}`;
              tag.textContent = statusLabel;
            }
            if (pendingBtn) {
              const shouldDisable = next === "pending";
              pendingBtn.disabled = shouldDisable;
              pendingBtn.style.opacity = shouldDisable ? "0.65" : "";
              pendingBtn.style.cursor = shouldDisable ? "default" : "";
              pendingBtn.title = shouldDisable ? "Already pending." : "";
            }
            try {
              const key = String(jobId || "").trim();
              const cached = key ? employerJobApplicantsCache.get(key) : null;
              if (cached && Array.isArray(cached.apps)) {
                const found = cached.apps.find((x) => x && String(x.id || "") === String(a.id || ""));
                if (found) found.status = next;
                cached.fetchedAt = Date.now();
              }
              if (key) {
                panel.setAttribute("data-loaded-job-id", key);
                panel.setAttribute("data-loaded-at", String(Date.now()));
              }
            } catch {
              // ignore
            }

            employerApplicantsDirty = true;
            emitSyncEvent("applications_updated", { applicationId: a.id, jobId });
          } catch (err) {
            alert(err?.message || "Failed to update status.");
            originalStates.forEach(({ node, disabled, text }) => {
              node.disabled = disabled;
              node.textContent = text;
            });
          }
        });
      });
      panel.appendChild(row);
      panel.appendChild(detail);
    });
  } catch (err) {
    panel.innerHTML = `<div style='padding:14px;color:#ffb4b4;'>${err?.message || "Failed to load applicants."}</div>`;
  }
}

function formatRelative(createdAt) {
  if (!createdAt) return "recently";
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return "recently";
  const diffMs = Date.now() - t;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function getLastConversationMessage(application) {
  if (!application || typeof application !== "object") return null;
  const msgs = Array.isArray(application.messages) ? application.messages : [];
  if (msgs.length) {
    const sorted = msgs
      .filter((msg) => msg && typeof msg === "object")
      .slice()
      .sort((a, b) => isoToMs(b.createdAt || "") - isoToMs(a.createdAt || ""));
    return sorted[0] || null;
  }
  const legacyText = String(application.message || "").trim();
  if (!legacyText) return null;
  return {
    text: legacyText,
    createdAt: application.createdAt || "",
  };
}

function getLastInboundConversationMessage(application, role = getLoggedInRole()) {
  if (!application || typeof application !== "object") return null;
  const msgs = Array.isArray(application.messages) ? application.messages : [];
  const normalizedRole = String(role || "").toLowerCase();
  const inbound = msgs
    .filter((msg) => msg && typeof msg === "object" && String(msg.fromRole || "").toLowerCase() && String(msg.fromRole || "").toLowerCase() !== normalizedRole)
    .slice()
    .sort((a, b) => isoToMs(b.createdAt || "") - isoToMs(a.createdAt || ""));
  return inbound[0] || null;
}

function isConversationUnread(application, role = getLoggedInRole()) {
  const userId = localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "";
  const appId = String(application && application.id ? application.id : "").trim();
  if (!userId || !appId) return false;
  const lastInbound = getLastInboundConversationMessage(application, role);
  const inboundMs = isoToMs(lastInbound && lastInbound.createdAt ? lastInbound.createdAt : "");
  if (!inboundMs) return false;
  const seenMs = Number.parseInt(localStorage.getItem(getNotifSeenMsgKey(role, userId, appId)) || "0", 10) || 0;
  return inboundMs > seenMs;
}

function formatConversationTimestamp(createdAt) {
  const t = Date.parse(String(createdAt || ""));
  if (!Number.isFinite(t)) return "";
  const date = new Date(t);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function isoToMs(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? t : 0;
}

function getNotifLastSeenKey(role, userId) {
  return `${STORAGE_NOTIF_LAST_SEEN_PREFIX}${String(role || "")}:${String(userId || "")}`;
}

function getNotifSeenMsgKey(role, userId, applicationId) {
  return `${STORAGE_NOTIF_SEEN_MSG_PREFIX}${String(role || "")}:${String(userId || "")}:${String(applicationId || "")}`;
}

function statusLabel(status) {
  const v = String(status || "").toLowerCase();
  if (v === "passed") return "Passed";
  if (v === "rejected") return "Rejected";
  if (v === "pending") return "Pending";
  if (v === "applied") return "Applied";
  return v ? v[0].toUpperCase() + v.slice(1) : "Update";
}

function noticeIconClass(kind, status) {
  const k = String(kind || "").toLowerCase();
  if (k === "message") return "fa-regular fa-comments";
  if (k === "application") return "fa-solid fa-user-plus";
  if (k === "status") {
    const s = String(status || "").toLowerCase();
    if (s === "passed") return "fa-regular fa-circle-check";
    if (s === "rejected") return "fa-regular fa-circle-xmark";
    return "fa-regular fa-bell";
  }
  return "fa-regular fa-bell";
}

function noticeTagClass(kind, status) {
  const k = String(kind || "").toLowerCase();
  if (k === "status") {
    const s = String(status || "").toLowerCase();
    if (s === "passed") return "notice-tag success";
    if (s === "rejected") return "notice-tag alert";
  }
  return "notice-tag";
}

function getNoticeListEl(role) {
  if (role === "employer") return document.querySelector("#employerNotifications .notice-list");
  return document.querySelector("#seekerNotificationsPage .notice-list");
}

async function fetchNotifications() {
  const data = await tryApi("/api/notifications", { method: "GET", auth: true });
  const notes = data && data.ok && Array.isArray(data.notifications) ? data.notifications : [];
  return notes
    .filter((n) => n && typeof n === "object")
    .map((n) => ({
      id: String(n.id || ""),
      kind: String(n.kind || ""),
      title: String(n.title || ""),
      body: String(n.body || ""),
      createdAt: String(n.createdAt || ""),
      applicationId: String(n.applicationId || ""),
      jobId: String(n.jobId || ""),
      jobTitle: String(n.jobTitle || ""),
      company: String(n.company || ""),
      status: String(n.status || ""),
      fromRole: String(n.fromRole || ""),
    }));
}

function isNotificationUnread(role, userId, notice) {
  const createdMs = isoToMs(notice.createdAt);
  if (!createdMs) return false;

  if (String(notice.kind).toLowerCase() === "message" && notice.applicationId) {
    const key = getNotifSeenMsgKey(role, userId, notice.applicationId);
    const seenMs = Number.parseInt(localStorage.getItem(key) || "0", 10) || 0;
    return createdMs > seenMs;
  }

  const lastSeenKey = getNotifLastSeenKey(role, userId);
  const lastSeenMs = Number.parseInt(localStorage.getItem(lastSeenKey) || "0", 10) || 0;
  return createdMs > lastSeenMs;
}

function markNotificationSeen(role, userId, notice) {
  const createdMs = isoToMs(notice.createdAt);
  if (!createdMs) return;
  if (String(notice.kind).toLowerCase() === "message" && notice.applicationId) {
    const key = getNotifSeenMsgKey(role, userId, notice.applicationId);
    const existing = Number.parseInt(localStorage.getItem(key) || "0", 10) || 0;
    if (createdMs > existing) localStorage.setItem(key, String(createdMs));
  }
}

function setNotificationsLastSeen(role, userId) {
  localStorage.setItem(getNotifLastSeenKey(role, userId), String(Date.now()));
}

function renderNotificationsList(role, notices) {
  const list = getNoticeListEl(role);
  if (!list) return;
  list.innerHTML = "";

  if (!notices.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state-card";
    empty.textContent = "No notifications yet.";
    list.appendChild(empty);
    return;
  }

  const userId = localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "";
  notices.forEach((n) => {
    const card = document.createElement("div");
    card.className = "notice-card";
    const unread = userId ? isNotificationUnread(role, userId, n) : false;
    if (unread) card.classList.add("unread");

    const iconWrap = document.createElement("div");
    iconWrap.className = "notice-icon";
    const icon = document.createElement("i");
    icon.className = noticeIconClass(n.kind, n.status);
    iconWrap.appendChild(icon);

    const body = document.createElement("div");
    const h4 = document.createElement("h4");
    h4.textContent = n.title || "Notification";
    const p = document.createElement("p");
    p.textContent = n.body || "";

    const meta = document.createElement("div");
    meta.className = "notice-meta";

    const tag = document.createElement("span");
    tag.className = noticeTagClass(n.kind, n.status);
    tag.textContent =
      String(n.kind).toLowerCase() === "status"
        ? statusLabel(n.status)
        : String(n.kind).toLowerCase() === "application"
          ? "Applicant"
          : String(n.kind).toLowerCase() === "message"
            ? "Message"
            : "Update";

    const time = document.createElement("span");
    time.className = "notice-time";
    time.textContent = formatRelative(n.createdAt);

    meta.appendChild(tag);
    if (unread) {
      const newTag = document.createElement("span");
      newTag.className = "notice-tag";
      newTag.textContent = "New";
      meta.appendChild(newTag);
    }
    meta.appendChild(time);

    body.appendChild(h4);
    body.appendChild(p);
    body.appendChild(meta);

    const chevron = document.createElement("div");
    chevron.className = "notice-time";
    chevron.style.justifySelf = "end";
    chevron.textContent = "View";

    card.appendChild(iconWrap);
    card.appendChild(body);
    card.appendChild(chevron);

    card.addEventListener("click", async () => {
      const uid = localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "";
      if (uid) markNotificationSeen(role, uid, n);

      const kind = String(n.kind || "").toLowerCase();
      if (role === "seeker") {
        if (kind === "message" && n.applicationId) {
          await openSeekerChatForApplication({ id: n.applicationId, company: n.company, jobTitle: n.jobTitle });
          return;
        }
        if (kind === "status") {
          showSeekerHistory();
          return;
        }
        showHome();
        return;
      }

      if (n.jobId && n.applicationId) {
        try {
          sessionStorage.setItem("pendingEmployerOpenApp", JSON.stringify({ jobId: n.jobId, applicationId: n.applicationId }));
        } catch {
          // ignore
        }
        showEmployerOverview();
        return;
      }
      showEmployerApplicants();
    });

    list.appendChild(card);
  });
}

async function loadAndShowNotifications(role, options = {}) {
  const userId = localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "";
  const list = getNoticeListEl(role);
  const force = Boolean(options && options.force);
  const quiet = Boolean(options && options.quiet);

  const key = userId ? `${role}:${userId}` : "";
  const cached = key ? notificationsCache.get(key) : null;
  const now = Date.now();
  const cachedAge = cached ? now - (Number(cached.fetchedAt) || 0) : Number.POSITIVE_INFINITY;
  const cachedFresh = Boolean(cached && cachedAge < NOTIFICATIONS_REFRESH_MS && !notificationsDirty[role]);

  const hasExistingContent = Boolean(list && String(list.innerHTML || "").trim());
  if (list && !hasExistingContent && cached && Array.isArray(cached.notes)) {
    renderNotificationsList(role, cached.notes);
  }

  if (!force && cachedFresh && cached && Array.isArray(cached.notes)) {
    renderNotificationsList(role, cached.notes);
    if (userId) setNotificationsLastSeen(role, userId);
    return;
  }

  if (list && (!quiet || !hasExistingContent)) {
    list.innerHTML = "<div class='empty-state-card'>Loading notifications...</div>";
  }

  const notes = await fetchNotifications();
  if (key) {
    notificationsCache.set(key, { notes, fetchedAt: Date.now() });
  }
  notificationsDirty[role] = false;
  renderNotificationsList(role, notes);
  if (userId) setNotificationsLastSeen(role, userId);
}

async function loadSeekerHistoryFromBackend() {
  if (!getLoggedIn() || getLoggedInRole() !== "seeker") return;
  const currentUserId = String(localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "").trim();
  let data;
  try {
    data = await apiRequest("/api/applications?mine=1", { method: "GET", auth: true });
  } catch {
    return;
  }
  const rawApps = data && data.ok && Array.isArray(data.applications) ? data.applications : [];
  const apps = rawApps.filter((a) => {
    if (!a || typeof a !== "object") return false;
    const appId = String(a.id || "").trim();
    const jobId = String(a.jobId || "").trim();
    const seekerId = String(a.seekerId || "").trim();
    if (!appId || !jobId) return false;
    if (currentUserId && seekerId && seekerId !== currentUserId) return false;
    return true;
  });
  const byStatus = { pending: [], passed: [], rejected: [], applied: [] };
  apps.forEach((a) => {
    const status = String(a.status || "applied").toLowerCase();
    const bucket = byStatus[status] ? status : "applied";
    byStatus[bucket].push(a);
  });

  const root = document.getElementById("seekerHistoryPage");
  if (!root) return;
  root.querySelectorAll(".status-card").forEach((card) => {
    const label = (card.querySelector(".status-label")?.textContent || "").trim().toLowerCase();
    const value = card.querySelector(".status-value");
    if (!value) return;
    if (label === "pending") value.textContent = String(byStatus.pending.length);
    if (label === "passed") value.textContent = String(byStatus.passed.length);
    if (label === "rejected") value.textContent = String(byStatus.rejected.length);
    if (label === "applied") value.textContent = String(byStatus.applied.length);
  });

  // Track which jobs the seeker already applied to, so we can lock Apply buttons elsewhere.
  try {
    seekerAppliedJobIds = new Set(
      apps
        .map((a) => String(a && a.jobId ? a.jobId : "").trim())
        .filter(Boolean),
    );
  } catch {
    seekerAppliedJobIds = new Set();
  }
  syncSeekerApplyButtons(document);

  Object.keys(byStatus).forEach((status) => {
    const panel = root.querySelector(`.status-panel[data-history-section=\"${status}\"]`);
    const list = panel ? panel.querySelector(".status-list") : null;
    if (!list) return;
    list.innerHTML = "";
    const items = byStatus[status];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.style.padding = "10px 4px";
      empty.style.color = "#9aa4b2";
      empty.textContent = "No items yet.";
      list.appendChild(empty);
      return;
    }
    items.slice(0, 6).forEach((a) => {
      const item = document.createElement("div");
      item.className = "status-item status-item--history";
      item.innerHTML = `
        <span class="status-dot ${status}"></span>
        <div class="status-item-content">
          <div class="status-item-top">
            <div class="status-item-main">
              <div class="status-item-text">
                <h4></h4>
                <p></p>
              </div>
            </div>
            <div class="status-item-actions">
              <button class="ghost-btn small-btn" type="button" data-action="view-job">View</button>
            </div>
          </div>
        </div>
      `;
      const h4 = item.querySelector("h4");
      const p = item.querySelector("p");
      if (h4) h4.textContent = a.jobTitle || "Application";
      const company = a.company ? `${a.company} - ` : "";
      if (p) p.textContent = `${company}${formatRelative(a.createdAt)}`;

      const jobId = String(a.jobId || "").trim();
      const viewBtn = item.querySelector('button[data-action="view-job"]');
      if (viewBtn) {
        viewBtn.addEventListener("click", (ev) => {
          if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
          openQuickViewForJobId(jobId);
        });
      }
      item.addEventListener("click", () => openQuickViewForJobId(jobId));
      list.appendChild(item);
    });
  });
}

async function loadEmployerHistoryFromBackend() {
  if (!getLoggedIn() || getLoggedInRole() !== "employer") return;
  const myId = localStorage.getItem(STORAGE_CURRENT_USER_KEY);
  const jobs = await fetchJobs();
  if (!jobs) return;
  const mine = myId ? jobs.filter((j) => j.employerId === myId) : jobs;

  const root = document.getElementById("employerHistory");
  if (!root) return;
  const statValues = root.querySelectorAll(".history-stat .stat-value");
  if (statValues.length >= 2) {
    statValues[0].textContent = String(mine.length);
    statValues[1].textContent = "0";
  }

  const list = root.querySelector(".history-list");
  if (!list) return;
  list.innerHTML = "";
  if (!mine.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state-box";
    empty.style.marginTop = "18px";
    empty.textContent = "No job postings yet. Create one from Post Job.";
    list.appendChild(empty);
    return;
  }

  mine.forEach((job) => {
    const card = document.createElement("article");
    card.className = "history-card active";
    const count = Number(job.applicantCount) || 0;
    const date = job.createdAt ? new Date(job.createdAt).toLocaleDateString() : "Recently";
    card.innerHTML = `
      <div class="history-card-head">
        <h3></h3>
        <span class="history-tag">Active</span>
      </div>
      <p class="history-date"><i class="fa-regular fa-calendar"></i> Posted ${date}</p>
      <div class="history-meta">
        <div>
          <p class="meta-value">${count}</p>
          <p class="meta-label">Applicants</p>
        </div>
        <button class="history-cta-btn" data-state="open" type="button" disabled>
          <i class="fa-regular fa-circle-xmark"></i>
          <span>Close</span>
        </button>
      </div>
    `;
    const title = card.querySelector("h3");
    if (title) title.textContent = job.title || "Job";
    list.appendChild(card);
  });
}

function normalizeEmployerPipelineStatus(status) {
  const v = String(status || "").toLowerCase();
  if (v === "passed") return "passed";
  if (v === "rejected") return "rejected";
  if (v === "pending") return "pending";
  // Treat "applied" (and unknown/legacy) as pending for the employer pipeline.
  return "pending";
}

function renderEmployerApplicantsPipeline(apps, { searchRaw = "" } = {}) {
  const root = document.getElementById("employerApplicants");
  if (!root) return;

  const filtered = searchRaw
    ? apps.filter((a) => {
        const hay = `${a.seekerName || ""} ${a.seekerEmail || ""} ${a.jobTitle || ""} ${a.company || ""}`.toLowerCase();
        return hay.includes(searchRaw);
      })
    : apps;

  const byStatus = { pending: [], passed: [], rejected: [] };
  filtered.forEach((a) => {
    const status = normalizeEmployerPipelineStatus(a.status);
    byStatus[status].push(a);
  });

  const sortByNewest = (a, b) => {
    const aTs = isoToMs(a.updatedAt || a.createdAt);
    const bTs = isoToMs(b.updatedAt || b.createdAt);
    return bTs - aTs;
  };
  Object.keys(byStatus).forEach((k) => byStatus[k].sort(sortByNewest));

  const setCount = (status, n) => {
    const card = root.querySelector(`[data-status-card="${status}"] .status-value`);
    if (card) card.textContent = String(n);
  };
  setCount("pending", byStatus.pending.length);
  setCount("passed", byStatus.passed.length);
  setCount("rejected", byStatus.rejected.length);

  const renderList = (status) => {
    const panel = root.querySelector(`.status-panel[data-employer-status="${status}"]`);
    const list = panel ? panel.querySelector(".status-list") : null;
    if (!list) return;
    list.innerHTML = "";
    const items = byStatus[status] || [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.style.padding = "10px 4px";
      empty.style.color = "#9aa4b2";
      empty.textContent = searchRaw ? "No matches." : "No items yet.";
      list.appendChild(empty);
      return;
    }

    items.slice(0, 30).forEach((a) => {
      const current = normalizeEmployerPipelineStatus(a.status);
      const name = String(a.seekerName || "").trim() || String(a.seekerEmail || "").trim() || "Hunter";
      const email = String(a.seekerEmail || "").trim();
      const jobTitle = String(a.jobTitle || "Application").trim();
      const tagClass = current === "rejected" ? "rejected" : current === "passed" ? "shortlist" : "interview";
      const tagLabel = statusLabel(current);
      const when = formatRelative(a.updatedAt || a.createdAt);

      const item = document.createElement("div");
      item.className = "status-item";
      item.innerHTML = `
        <span class="status-dot ${status}"></span>
        <div class="status-item-content">
          <div class="status-item-top">
            <div class="status-item-main">
              <div class="status-item-text">
                <h4></h4>
              <div class="status-item-meta">
                <span class="status-tag ${tagClass}">${tagLabel}</span>
                <span class="meta-sep">•</span>
                <span data-meta="job"></span>
                ${email ? `<span class="meta-sep">•</span><span data-meta="email"></span>` : ""}
                <span class="meta-sep">•</span>
                <span data-meta="when"></span>
              </div>
              </div>
            </div>
            <div class="status-item-actions"></div>
          </div>
        </div>
      `;
      const h4 = item.querySelector("h4");
      const actions = item.querySelector(".status-item-actions");
      if (h4) h4.textContent = name;
      const jobEl = item.querySelector('[data-meta="job"]');
      const emailEl = item.querySelector('[data-meta="email"]');
      const whenEl = item.querySelector('[data-meta="when"]');
      if (jobEl) jobEl.textContent = jobTitle;
      if (emailEl) emailEl.textContent = email;
      if (whenEl) whenEl.textContent = when;

      const mkBtn = (label, attrs = {}) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ghost-btn small-btn";
        btn.textContent = label;
        Object.keys(attrs).forEach((k) => btn.setAttribute(k, attrs[k]));
        return btn;
      };

      const openBtn = mkBtn("Open", { "data-action": "open" });
      openBtn.addEventListener("click", () => {
        try {
          sessionStorage.setItem(
            "pendingEmployerOpenApp",
            JSON.stringify({ jobId: String(a.jobId || ""), applicationId: String(a.id || "") }),
          );
        } catch {
          // ignore
        }
        showEmployerOverview();
      });
      if (actions) actions.appendChild(openBtn);

      const targets = ["pending", "passed", "rejected"].filter((t) => t !== current);
      targets.forEach((t) => {
        const label = t === "passed" ? "Pass" : t === "rejected" ? "Reject" : "Pending";
        const btn = mkBtn(label, { "data-status": t });
        btn.addEventListener("click", async () => {
          if (btn.disabled) return;
          const allActionBtns = item.querySelectorAll("button[data-status]");
          allActionBtns.forEach((actionBtn) => {
            actionBtn.disabled = true;
            actionBtn.style.opacity = "0.65";
            actionBtn.style.cursor = "default";
          });
          try {
            await apiRequest(`/api/applications/${encodeURIComponent(a.id)}`, {
              method: "PATCH",
              auth: true,
              body: { status: t },
            });
            a.status = t;
            a.updatedAt = new Date().toISOString();
            try {
              const key = String(employerApplicantsSelectedJobId || a.jobId || "").trim();
              const cached = key ? employerJobApplicantsCache.get(key) : null;
              if (cached && Array.isArray(cached.apps)) {
                const found = cached.apps.find((x) => x && String(x.id || "") === String(a.id || ""));
                if (found) {
                  found.status = t;
                  found.updatedAt = a.updatedAt;
                }
                cached.fetchedAt = Date.now();
              }
            } catch {
              // ignore
            }
            employerApplicantsDirty = true;
            renderEmployerApplicantsPipeline(employerApplicantsSelectedJobApps, {
              searchRaw: String(document.getElementById("employerApplicantsSearch")?.value || "").trim().toLowerCase(),
            });
            emitSyncEvent("applications_updated", { applicationId: a.id, jobId: a.jobId });
          } catch (err) {
            allActionBtns.forEach((actionBtn) => {
              actionBtn.disabled = false;
              actionBtn.style.opacity = "";
              actionBtn.style.cursor = "";
            });
            alert(err?.message || "Failed to update status.");
          }
        });
        if (actions) actions.appendChild(btn);
      });

      list.appendChild(item);
    });
  };

  renderList("pending");
  renderList("passed");
  renderList("rejected");

  employerApplicantsLastLoadedAt = Date.now();
  employerApplicantsDirty = false;
}

function setEmployerApplicantsView(mode) {
  const jobsView = document.getElementById("employerApplicantsJobsView");
  const detailView = document.getElementById("employerApplicantsDetailView");
  if (jobsView) jobsView.style.display = mode === "jobs" ? "" : "none";
  if (detailView) detailView.style.display = mode === "detail" ? "" : "none";
}

async function maybeRefreshEmployerApplicants({ force = false, quiet = false } = {}) {
  const applicants = document.getElementById("employerApplicants");
  const visible = applicants && applicants.style.display !== "none";
  if (!visible) return;
  const now = Date.now();
  const due =
    force ||
    employerApplicantsDirty ||
    !employerApplicantsLastLoadedAt ||
    now - employerApplicantsLastLoadedAt > EMPLOYER_APPLICANTS_REFRESH_MS;
  if (!due) return;

  await loadEmployerApplicantsFromBackend({ quiet });
}

function formatPostedDate(iso) {
  if (!iso) return "Recently";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "Recently";
  }
}

function resetEmployerApplicantsPanelView() {
  const root = document.getElementById("employerApplicants");
  if (!root) return;
  root.querySelectorAll('.status-panel[data-employer-status]').forEach((panel) => {
    panel.style.display = "";
  });
  root.querySelectorAll('[data-employer-view]').forEach((btn) => {
    btn.textContent = "View all";
    btn.setAttribute("data-mode", "view");
  });
}

function openEmployerApplicantsJob(job) {
  if (!job || typeof job !== "object") return;
  employerApplicantsSelectedJobId = String(job.id || "");
  employerApplicantsSelectedJob = job;
  const input = document.getElementById("employerApplicantsSearch");
  if (input) input.value = "";
  resetEmployerApplicantsPanelView();
  setEmployerApplicantsView("detail");
  loadEmployerApplicantsFromBackend().catch(() => {});
}

function closeEmployerApplicantsJob() {
  employerApplicantsSelectedJobId = "";
  employerApplicantsSelectedJob = null;
  employerApplicantsSelectedJobApps = [];
  const input = document.getElementById("employerApplicantsSearch");
  if (input) input.value = "";
  resetEmployerApplicantsPanelView();
  setEmployerApplicantsView("jobs");
}

async function loadEmployerApplicantsFromBackend(options = {}) {
  const root = document.getElementById("employerApplicants");
  if (!root) return;
  const quiet = Boolean(options && options.quiet);
  updateEmployerApplicantsJobsControls();

  const jobsList = document.getElementById("employerApplicantsJobsList");
  const titleEl = document.getElementById("employerApplicantsSelectedJobTitle");
  const metaEl = document.getElementById("employerApplicantsSelectedJobMeta");
  const postingSearchRaw = (document.getElementById("employerApplicantsJobsSearch")?.value || "").trim().toLowerCase();
  const activeCountEl = document.getElementById("employerApplicantsJobsActiveCount");
  const archivedCountEl = document.getElementById("employerApplicantsJobsArchivedCount");

  if (!getLoggedIn() || getLoggedInRole() !== "employer") {
    closeEmployerApplicantsJob();
    if (jobsList) {
      jobsList.innerHTML = `<div class="empty-state-box" style="margin-top:18px;">Please log in as an employer to view applicants.</div>`;
    }
    if (activeCountEl) activeCountEl.textContent = "0";
    if (archivedCountEl) archivedCountEl.textContent = "0";
    return;
  }
  if (!hasBackendToken()) {
    closeEmployerApplicantsJob();
    if (jobsList) {
      jobsList.innerHTML = `<div class="empty-state-box" style="margin-top:18px;">Session expired. Please log in again to view applicants.</div>`;
    }
    if (activeCountEl) activeCountEl.textContent = "0";
    if (archivedCountEl) archivedCountEl.textContent = "0";
    return;
  }

  const myId = localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "";

  // No job selected: show job list first.
  if (!employerApplicantsSelectedJobId) {
    setEmployerApplicantsView("jobs");
    if (jobsList && !quiet) {
      jobsList.innerHTML = "<div style='padding:10px 4px;color:#9aa4b2;'>Loading...</div>";
    }

    try {
      const jobs = await getJobsSnapshot();
      if (!jobs) {
        if (jobsList) {
          jobsList.innerHTML = `<div class="empty-state-box" style="margin-top:18px;">Backend API not reachable. Start the server (node server.js) and refresh.</div>`;
        }
        return;
      }

      const mine = myId ? jobs.filter((j) => j && j.employerId === myId) : jobs.slice();
      const mineOpen = mine.filter(isJobOpen);
      const mineClosed = mine.filter((j) => !isJobOpen(j));

      if (activeCountEl) activeCountEl.textContent = String(mineOpen.length);
      if (archivedCountEl) archivedCountEl.textContent = String(mineClosed.length);

      if (!jobsList) return;
      jobsList.innerHTML = "";
      const fragment = document.createDocumentFragment();

      let mineVisible = mineOpen;
      if (employerApplicantsJobsFilterMode === "archived") mineVisible = mineClosed;
      if (employerApplicantsJobsFilterMode === "all") mineVisible = mineOpen.concat(mineClosed);

      mineVisible = sortEmployerApplicantsJobs(mineVisible);

      const mineFiltered = postingSearchRaw
        ? mineVisible.filter((j) => {
            const hay = `${j?.title || ""} ${j?.company || ""} ${j?.location || ""}`.toLowerCase();
            return hay.includes(postingSearchRaw);
          })
        : mineVisible;

      if (!mineFiltered.length) {
        if (postingSearchRaw) {
          jobsList.innerHTML = `<div class="empty-state-box" style="margin-top:18px;">No matches.</div>`;
          return;
        }
        jobsList.innerHTML = `<div class="empty-state-box" style="margin-top:18px;">No job postings yet. Create one from Post Job.</div>`;
        return;
      }

      mineFiltered.forEach((job) => {
        const card = document.createElement("article");
        const isOpen = isJobOpen(job);
        card.className = isOpen ? "history-card active" : "history-card";
        card.setAttribute("data-job-id", String(job.id || ""));

        const count = Number(job.applicantCount) || 0;
        const date = formatPostedDate(job.createdAt);
        const companyLine = formatJobCompany(job);
        const tagText = isOpen ? "Active" : "Archived";
        const tagClass = isOpen ? "" : "muted";
        const secondaryText = isOpen ? "Hide" : "Reopen";
        const secondaryAction = isOpen ? "hide" : "reopen";
        const secondaryClass = isOpen ? "history-cta-btn danger" : "history-cta-btn";
        const secondaryIcon = isOpen ? "fa-regular fa-eye-slash" : "fa-solid fa-arrow-rotate-left";
        card.innerHTML = `
          <div class="history-card-head">
            <h3></h3>
            <span class="history-tag ${tagClass}">${tagText}</span>
          </div>
          <p class="history-date"><i class="fa-regular fa-calendar"></i> Posted ${date}</p>
          <p class="history-date" style="margin-top:6px;color:#9aa4b2;">${companyLine}</p>
          <div class="history-meta">
            <div class="history-meta-count">
              <p class="meta-value">${count}</p>
              <p class="meta-label meta-label-inline">${count === 1 ? "applicant" : "applicants"}</p>
            </div>
            <div class="history-meta-actions">
              <button class="history-cta-btn" type="button" data-action="view">
                <i class="fa-regular fa-eye"></i>
                <span>View</span>
              </button>
              <button class="${secondaryClass}" type="button" data-action="${secondaryAction}">
                <i class="${secondaryIcon}"></i>
                <span>${secondaryText}</span>
              </button>
            </div>
          </div>
        `;
        const h3 = card.querySelector("h3");
        if (h3) h3.textContent = job.title || "Job";

        const open = () => openEmployerApplicantsJob(job);
        const hide = async () => {
          const id = String(job.id || "");
          if (!id) return;
          if (!confirm("Hide (close) this job posting? Hunter applications will be disabled.")) return;
          try {
            await setEmployerJobPostingStatus(id, "closed");
            await refreshDataViews();
            await loadEmployerApplicantsFromBackend();
          } catch (err) {
            alert(err?.message || "Failed to hide posting.");
          }
        };
        const reopen = async () => {
          const id = String(job.id || "");
          if (!id) return;
          if (!confirm("Reopen this job posting? New hunter applications will be enabled.")) return;
          try {
            await setEmployerJobPostingStatus(id, "open");
            await refreshDataViews();
            await loadEmployerApplicantsFromBackend();
          } catch (err) {
            alert(err?.message || "Failed to reopen posting.");
          }
        };
        card.addEventListener("click", (e) => {
          // Don't double-trigger if the button is clicked; either way, open the job.
          if (e && e.target && e.target.closest) {
            const btn = e.target.closest("button");
            if (btn) {
              const action = btn.getAttribute("data-action");
              if (action === "hide") {
                hide();
                return;
              }
              if (action === "reopen") {
                reopen();
                return;
              }
              open();
              return;
            }
          }
          open();
        });
        card.querySelectorAll("button[data-action]").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            if (e) {
              e.preventDefault();
              e.stopPropagation();
            }
            const action = btn.getAttribute("data-action");
            if (action === "hide") {
              hide();
              return;
            }
            if (action === "reopen") {
              reopen();
              return;
            }
            open();
          });
        });

        fragment.appendChild(card);
      });
      jobsList.appendChild(fragment);

      employerApplicantsLastLoadedAt = Date.now();
      employerApplicantsDirty = false;
    } catch (err) {
      if (jobsList) {
        jobsList.innerHTML = `<div class="empty-state-box" style="margin-top:18px;">${err?.message || "Failed to load jobs."}</div>`;
      }
    }
    return;
  }

  // Job selected: show job-specific pipeline.
  setEmployerApplicantsView("detail");
  const searchRaw = (document.getElementById("employerApplicantsSearch")?.value || "").trim().toLowerCase();

  // Loading state
  if (!quiet) {
    root.querySelectorAll(".status-panel .status-list").forEach((list) => {
      list.innerHTML = "<div style='padding:10px 4px;color:#9aa4b2;'>Loading...</div>";
    });
  }

  try {
    let job = employerApplicantsSelectedJob && String(employerApplicantsSelectedJob.id) === employerApplicantsSelectedJobId
      ? employerApplicantsSelectedJob
      : null;
    const cachedJob = job && typeof job === "object" ? job : null;
    const needsHydrate = Boolean(cachedJob && (!cachedJob.employerId || !cachedJob.title || !cachedJob.company || !cachedJob.createdAt));
    if (!job || needsHydrate) {
      const jobs = await fetchJobs();
      const found = jobs && Array.isArray(jobs) ? jobs.find((j) => j && String(j.id) === employerApplicantsSelectedJobId) : null;
      if (found) job = found;
    }
    if (!job && cachedJob) job = cachedJob;
    if (!job) {
      job = { id: employerApplicantsSelectedJobId, title: "Job", company: "Company", status: "open", employerId: myId || "", createdAt: "" };
    }
    if (job && typeof job === "object" && myId && !job.employerId) {
      job.employerId = myId;
    }

    // Ensure the job belongs to the logged-in employer.
    if (myId && String(job.employerId || "") !== String(myId)) {
      closeEmployerApplicantsJob();
      await loadEmployerApplicantsFromBackend();
      return;
    }

    employerApplicantsSelectedJob = job;
    if (titleEl) titleEl.textContent = job.title || "Job";

    const closeBtn = document.getElementById("employerApplicantsClosePostingBtn");
    const hasFullJob = Boolean(job && job.createdAt && job.company && job.title && job.employerId);
    if (closeBtn) {
      closeBtn.disabled = !hasFullJob;
      closeBtn.textContent = hasFullJob ? (isJobOpen(job) ? "Close Posting" : "Reopen Posting") : "Close Posting";
    }

    const posted = formatPostedDate(job.createdAt);
    const companyLine = formatJobCompany(job);
    if (metaEl) metaEl.textContent = `${companyLine} \u2022 Posted ${posted}`;

    const data = await apiRequest(`/api/applications?jobId=${encodeURIComponent(employerApplicantsSelectedJobId)}`, { method: "GET", auth: true });
    const appsRaw = data && data.ok && Array.isArray(data.applications) ? data.applications : [];
    const apps = appsRaw.map((a) => ({ ...a, jobTitle: job.title || "", company: job.company || "" }));

    const lastActivityIso = apps.reduce((best, a) => {
      const candidate = a && (a.updatedAt || a.createdAt) ? String(a.updatedAt || a.createdAt) : "";
      if (!candidate) return best;
      if (!best) return candidate;
      return candidate.localeCompare(best) > 0 ? candidate : best;
    }, "");
    if (metaEl) {
      const lastActivityLabel = lastActivityIso ? ` \u2022 Last activity ${formatRelative(lastActivityIso)}` : "";
      metaEl.textContent = `${companyLine} \u2022 Posted ${posted} \u2022 Applicants ${apps.length}${lastActivityLabel}`;
    }

    employerApplicantsSelectedJobApps = apps;
    renderEmployerApplicantsPipeline(employerApplicantsSelectedJobApps, { searchRaw });
    return;

    const filtered = searchRaw
      ? apps.filter((a) => {
          const hay = `${a.seekerName || ""} ${a.seekerEmail || ""} ${a.jobTitle || ""} ${a.company || ""}`.toLowerCase();
          return hay.includes(searchRaw);
        })
      : apps;

    const byStatus = { pending: [], passed: [], rejected: [] };
    filtered.forEach((a) => {
      const status = normalizeEmployerPipelineStatus(a.status);
      byStatus[status].push(a);
    });

    const sortByNewest = (a, b) => {
      const aTs = isoToMs(a.updatedAt || a.createdAt);
      const bTs = isoToMs(b.updatedAt || b.createdAt);
      return bTs - aTs;
    };
    Object.keys(byStatus).forEach((k) => byStatus[k].sort(sortByNewest));

    // Summary counts
    const setCount = (status, n) => {
      const card = root.querySelector(`[data-status-card="${status}"] .status-value`);
      if (card) card.textContent = String(n);
    };
    setCount("pending", byStatus.pending.length);
    setCount("passed", byStatus.passed.length);
    setCount("rejected", byStatus.rejected.length);

    const renderList = (status) => {
      const panel = root.querySelector(`.status-panel[data-employer-status="${status}"]`);
      const list = panel ? panel.querySelector(".status-list") : null;
      if (!list) return;
      list.innerHTML = "";
      const items = byStatus[status] || [];
      if (!items.length) {
        const empty = document.createElement("div");
        empty.style.padding = "10px 4px";
        empty.style.color = "#9aa4b2";
        empty.textContent = searchRaw ? "No matches." : "No items yet.";
        list.appendChild(empty);
        return;
      }

      items.slice(0, 30).forEach((a) => {
        const current = normalizeEmployerPipelineStatus(a.status);
        const name = String(a.seekerName || "").trim() || String(a.seekerEmail || "").trim() || "Hunter";
        const email = String(a.seekerEmail || "").trim();
        const jobTitle = String(a.jobTitle || "Application").trim();
        const tagClass = current === "rejected" ? "rejected" : current === "passed" ? "shortlist" : "interview";
        const tagLabel = statusLabel(current);
        const when = formatRelative(a.updatedAt || a.createdAt);

        const item = document.createElement("div");
        item.className = "status-item";
        item.innerHTML = `
          <span class="status-dot ${status}"></span>
          <div class="status-item-content">
            <div class="status-item-top">
              <div class="status-item-main">
                <div class="status-item-text">
                  <h4></h4>
                <div class="status-item-meta">
                  <span class="status-tag ${tagClass}">${tagLabel}</span>
                  <span class="meta-sep">•</span>
                  <span data-meta="job"></span>
                  ${email ? `<span class="meta-sep">•</span><span data-meta="email"></span>` : ""}
                  <span class="meta-sep">•</span>
                  <span data-meta="when"></span>
                </div>
                </div>
              </div>
              <div class="status-item-actions"></div>
            </div>
          </div>
        `;
        const h4 = item.querySelector("h4");
        const actions = item.querySelector(".status-item-actions");
        if (h4) h4.textContent = name;
        const jobEl = item.querySelector('[data-meta="job"]');
        const emailEl = item.querySelector('[data-meta="email"]');
        const whenEl = item.querySelector('[data-meta="when"]');
        if (jobEl) jobEl.textContent = jobTitle;
        if (emailEl) emailEl.textContent = email;
        if (whenEl) whenEl.textContent = when;

        const mkBtn = (label, attrs = {}) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ghost-btn small-btn";
          btn.textContent = label;
          Object.keys(attrs).forEach((k) => btn.setAttribute(k, attrs[k]));
          return btn;
        };

        const openBtn = mkBtn("Open", { "data-action": "open" });
        openBtn.addEventListener("click", () => {
          try {
            sessionStorage.setItem(
              "pendingEmployerOpenApp",
              JSON.stringify({ jobId: String(a.jobId || ""), applicationId: String(a.id || "") }),
            );
          } catch {
            // ignore
          }
          showEmployerOverview();
        });
        if (actions) actions.appendChild(openBtn);

        const targets = ["pending", "passed", "rejected"].filter((t) => t !== current);
        targets.forEach((t) => {
          const label = t === "passed" ? "Pass" : t === "rejected" ? "Reject" : "Pending";
          const btn = mkBtn(label, { "data-status": t });
          btn.addEventListener("click", async () => {
            try {
              await apiRequest(`/api/applications/${encodeURIComponent(a.id)}`, {
                method: "PATCH",
                auth: true,
                body: { status: t },
              });
              emitSyncEvent("applications_updated", { applicationId: a.id, jobId: a.jobId });
              await refreshDataViews();
              await loadEmployerApplicantsFromBackend();
              await loadSeekerHistoryFromBackend();
            } catch (err) {
              alert(err?.message || "Failed to update status.");
            }
          });
          if (actions) actions.appendChild(btn);
        });

        list.appendChild(item);
      });
    };

    renderList("pending");
    renderList("passed");
    renderList("rejected");

    employerApplicantsLastLoadedAt = Date.now();
    employerApplicantsDirty = false;
  } catch (err) {
    root.querySelectorAll(".status-panel .status-list").forEach((list) => {
      list.innerHTML = `<div class="empty-state-card">${err?.message || "Failed to load applicants."}</div>`;
    });
  }
}

function setupEmployerApplicantsSearch() {
  const input = document.getElementById("employerApplicantsSearch");
  const button = document.getElementById("employerApplicantsSearchBtn");
  if (!input) return;
  const run = () => {
    const root = document.getElementById("employerApplicants");
    const visible = root && root.style.display !== "none";
    if (!visible) return;
    if (!getLoggedIn() || getLoggedInRole() !== "employer") return;
    const detail = document.getElementById("employerApplicantsDetailView");
    const detailVisible = detail && detail.style.display !== "none";
    if (!detailVisible) return;
    if (!employerApplicantsSelectedJobId) return;
    if (employerApplicantsSearchTimer) clearTimeout(employerApplicantsSearchTimer);
    employerApplicantsSearchTimer = setTimeout(() => {
      loadEmployerApplicantsFromBackend().catch(() => {});
    }, 150);
  };
  input.addEventListener("keydown", (e) => {
    if (e && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });
  if (button) {
    button.addEventListener("click", () => run());
  }
}

function setupEmployerApplicantsJobsSearch() {
  const input = document.getElementById("employerApplicantsJobsSearch");
  const button = document.getElementById("employerApplicantsJobsSearchBtn");
  if (!input) return;
  const run = () => {
    const root = document.getElementById("employerApplicants");
    const visible = root && root.style.display !== "none";
    if (!visible) return;
    if (!getLoggedIn() || getLoggedInRole() !== "employer") return;

    const jobsView = document.getElementById("employerApplicantsJobsView");
    const jobsVisible = jobsView && jobsView.style.display !== "none";
    if (!jobsVisible) return;

    if (employerApplicantsJobsSearchTimer) clearTimeout(employerApplicantsJobsSearchTimer);
    employerApplicantsJobsSearchTimer = setTimeout(() => {
      loadEmployerApplicantsFromBackend().catch(() => {});
    }, 150);
  };
  input.addEventListener("keydown", (e) => {
    if (e && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });
  if (button) {
    button.addEventListener("click", () => run());
  }
}

function setupEmployerApplicantsBackButton() {
  const btn = document.getElementById("employerApplicantsBackBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    closeEmployerApplicantsJob();
    loadEmployerApplicantsFromBackend().catch(() => {});
    window.scrollTo(0, 0);
  });
}

function setupEmployerApplicantsClosePostingButton() {
  const btn = document.getElementById("employerApplicantsClosePostingBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!getLoggedIn() || getLoggedInRole() !== "employer") return;
    if (!hasBackendToken()) return;
    if (!employerApplicantsSelectedJobId) return;

    const job = employerApplicantsSelectedJob;
    const currentlyOpen = isJobOpen(job);
    const nextStatus = currentlyOpen ? "closed" : "open";
    const label = currentlyOpen ? "close" : "reopen";
    if (!confirm(`Are you sure you want to ${label} this job posting?`)) return;

    try {
      btn.disabled = true;
      await setEmployerJobPostingStatus(employerApplicantsSelectedJobId, nextStatus);
      await refreshDataViews();
      closeEmployerApplicantsJob();
      await loadEmployerApplicantsFromBackend();
      window.scrollTo(0, 0);
    } catch (err) {
      alert(err?.message || "Failed to update job status.");
    } finally {
      btn.disabled = false;
    }
  });
}

function setupEmployerApplicantsViewButtons() {
  const root = document.getElementById("employerApplicants");
  if (!root) return;
  const panels = root.querySelectorAll('.status-panel[data-employer-status]');
  const buttons = root.querySelectorAll('[data-employer-view]');
  if (!panels.length || !buttons.length) return;

  const showAll = () => {
    panels.forEach((panel) => {
      panel.style.display = "";
    });
    buttons.forEach((btn) => {
      btn.textContent = "View all";
      btn.setAttribute("data-mode", "view");
    });
  };

  buttons.forEach((btn) => {
    btn.setAttribute("data-mode", "view");
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode");
      if (mode === "back") {
        showAll();
        return;
      }
      const target = btn.getAttribute("data-employer-view");
      panels.forEach((panel) => {
        const section = panel.getAttribute("data-employer-status");
        panel.style.display = section === target ? "" : "none";
      });
      buttons.forEach((b) => {
        if (b === btn) {
          b.textContent = "Back";
          b.setAttribute("data-mode", "back");
        } else {
          b.textContent = "View all";
          b.setAttribute("data-mode", "view");
        }
      });
      window.scrollTo(0, 0);
    });
  });
}

async function publishJobFromForm() {
  const titleEl = document.getElementById("addJobTitle");
  const locationEl = document.getElementById("addJobLocation");
  const salaryCurrencyEl = document.getElementById("addJobSalaryCurrency");
  const salaryEl = document.getElementById("addJobSalary");
  const descEl = document.getElementById("addJobDescription");
  const reqEl = document.getElementById("addJobRequirements");

  const title = (titleEl?.value || "").trim();
  const location = (locationEl?.value || "").trim();
  const salaryCurrency = (salaryCurrencyEl?.value || "PHP").trim();
  const salaryAmount = (salaryEl?.value || "").trim();
  const salary = salaryAmount ? `${salaryCurrency} ${salaryAmount}` : "";
  const description = (descEl?.value || "").trim();
  const requirements = (reqEl?.value || "").trim();

  if (!getLoggedIn() || getLoggedInRole() !== "employer") {
    alert("Please log in as an employer to publish jobs.");
    return;
  }
  if (!hasBackendToken()) {
    alert("Please log in again to publish jobs.");
    handleNotAuthenticated("employer");
    return;
  }
  if (!title) {
    alert("Please enter a job title.");
    return;
  }

  const ok = await showConfirmModal(`Publish this job posting?\n\n"${title}"`, {
    title: "Publish Job",
    okText: "Publish",
    cancelText: "Cancel",
  });
  if (!ok) return;

  try {
    await withPageLoader(async () => {
      await apiRequest("/api/jobs", {
        method: "POST",
        auth: true,
        body: { title, location, salary, description, requirements },
      });
      if (titleEl) titleEl.value = "";
      if (locationEl) locationEl.value = "";
      if (salaryCurrencyEl) salaryCurrencyEl.value = "PHP";
      if (salaryEl) salaryEl.value = "";
      if (descEl) descEl.value = "";
      if (reqEl) reqEl.value = "";
      try {
        localStorage.removeItem("jobDraft");
      } catch {
        // ignore
      }
      closeAddJob();
      await refreshDataViews();
      emitSyncEvent("jobs_updated", { jobTitle: title });
    }, { message: "Publishing job..." });
    alert("Job published!");
  } catch (err) {
    if (err && err.status === 401) {
      alert("Session expired. Please log in again.");
      handleNotAuthenticated("employer");
      return;
    }
    alert(err?.message || "Failed to publish job.");
  }
}

function saveDraftFromForm() {
  // Simple client-side drafts (optional); keeps UI responsive even without backend.
  let notify = true;
  try {
    const maybeOpts = arguments && arguments.length ? arguments[0] : null;
    if (maybeOpts && typeof maybeOpts === "object" && Object.prototype.hasOwnProperty.call(maybeOpts, "notify")) {
      notify = Boolean(maybeOpts.notify);
    }
  } catch {
    // ignore
  }
  const draft = {
    title: (document.getElementById("addJobTitle")?.value || "").trim(),
    location: (document.getElementById("addJobLocation")?.value || "").trim(),
    salaryCurrency: (document.getElementById("addJobSalaryCurrency")?.value || "PHP").trim(),
    salary: (document.getElementById("addJobSalary")?.value || "").trim(),
    description: (document.getElementById("addJobDescription")?.value || "").trim(),
    requirements: (document.getElementById("addJobRequirements")?.value || "").trim(),
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem("jobDraft", JSON.stringify(draft));
  if (notify) alert("Draft saved on this device.");
  const status = document.getElementById("addJobDraftStatus");
  if (status) {
    const t = new Date();
    status.textContent = `Draft saved \u2022 ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
}

function loadDraftToForm() {
  const raw = localStorage.getItem("jobDraft");
  if (!raw) return;
  let draft;
  try {
    draft = JSON.parse(raw);
  } catch {
    return;
  }
  if (!draft || typeof draft !== "object") return;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && typeof val === "string") el.value = val;
  };
  setVal("addJobTitle", draft.title || "");
  setVal("addJobLocation", draft.location || "");
  setVal("addJobSalaryCurrency", draft.salaryCurrency || "PHP");
  setVal("addJobSalary", draft.salary || "");
  setVal("addJobDescription", draft.description || "");
  setVal("addJobRequirements", draft.requirements || "");
  const status = document.getElementById("addJobDraftStatus");
  if (status) {
    status.textContent = "Draft loaded";
  }
}

function clearAddJobFormAndDraft() {
  const ids = ["addJobTitle", "addJobLocation", "addJobSalaryCurrency", "addJobSalary", "addJobDescription", "addJobRequirements"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = id === "addJobSalaryCurrency" ? "PHP" : "";
    // Keep autogrow textareas and any listeners in sync with programmatic changes.
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      // ignore
    }
  });
  try {
    localStorage.removeItem("jobDraft");
  } catch {
    // ignore
  }
  const status = document.getElementById("addJobDraftStatus");
  if (status) status.textContent = "Draft cleared";
  const title = document.getElementById("addJobTitle");
  if (title) title.focus();
}

function setupAddJobDraftAutosave() {
  const fields = [
    document.getElementById("addJobTitle"),
    document.getElementById("addJobLocation"),
    document.getElementById("addJobSalaryCurrency"),
    document.getElementById("addJobSalary"),
    document.getElementById("addJobDescription"),
    document.getElementById("addJobRequirements"),
  ].filter(Boolean);

  if (!fields.length) return;

  const schedule = () => {
    if (addJobDraftAutosaveTimer) clearTimeout(addJobDraftAutosaveTimer);
    addJobDraftAutosaveTimer = setTimeout(() => {
      addJobDraftAutosaveTimer = null;
      saveDraftFromForm({ notify: false });
    }, 500);
  };

  fields.forEach((el) => {
    el.addEventListener("input", schedule);
  });

  const newBtn = document.getElementById("newListingBtn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      clearAddJobFormAndDraft();
    });
  }
}

function setupAddJobFormActions() {
  const publishBtn = document.getElementById("publishJobBtn");
  if (publishBtn && publishBtn.dataset && publishBtn.dataset.wired !== "1") {
    publishBtn.addEventListener("click", publishJobFromForm);
    publishBtn.dataset.wired = "1";
  }

  const draftBtn = document.getElementById("saveJobDraftBtn");
  if (draftBtn && draftBtn.dataset && draftBtn.dataset.wired !== "1") {
    draftBtn.addEventListener("click", saveDraftFromForm);
    draftBtn.dataset.wired = "1";
  }

  loadDraftToForm();
  setupAddJobTextareaAutogrow();
}

function setupAddJobTextareaAutogrow() {
  const textareas = Array.from(document.querySelectorAll("textarea.add-job-textarea.autogrow"));
  if (!textareas.length) return;

  const grow = (el) => {
    if (!el) return;
    const max = Math.round(Math.min((window.innerHeight || 900) * 0.55, 560));
    const min = 120;

    el.style.height = "auto";
    const next = Math.max(min, el.scrollHeight || 0);
    if (next > max) {
      el.style.height = `${max}px`;
      el.style.overflowY = "auto";
    } else {
      el.style.height = `${next}px`;
      el.style.overflowY = "hidden";
    }
  };

  textareas.forEach((el) => {
    if (el.dataset && el.dataset.autogrowWired === "1") {
      grow(el);
      return;
    }
    el.dataset.autogrowWired = "1";
    const handler = () => grow(el);
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
    el.addEventListener("focus", handler);
    el.addEventListener("click", handler);
    grow(el);
  });

  const key = "__addJobAutogrowResizeWired";
  if (document.body && document.body.dataset && document.body.dataset[key] !== "1") {
    document.body.dataset[key] = "1";
    window.addEventListener("resize", () => textareas.forEach(grow));
  }
}

function setupUniversalTextareaAutogrow() {
  const selector = [
    "textarea[data-autogrow=\"1\"]",
    "textarea.autogrow-textarea",
  ].join(",");
  const textareas = Array.from(document.querySelectorAll(selector)).filter((el) => !el.classList.contains("add-job-textarea"));
  if (!textareas.length) return;

  const grow = (el) => {
    if (!el) return;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    const lineHeight = style ? Number.parseFloat(style.lineHeight) : 0;
    const min = Math.max(44, Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round(lineHeight * 3) : 0);
    const max = Math.round(Math.min((window.innerHeight || 900) * 0.6, 520));

    el.style.height = "auto";
    const next = Math.max(min, el.scrollHeight || 0);
    if (next > max) {
      el.style.height = `${max}px`;
      el.style.overflowY = "auto";
    } else {
      el.style.height = `${next}px`;
      el.style.overflowY = "hidden";
    }
  };

  textareas.forEach((el) => {
    if (!el || !el.dataset) return;
    if (el.dataset.universalAutogrowWired === "1") {
      grow(el);
      return;
    }
    el.dataset.universalAutogrowWired = "1";
    const handler = () => grow(el);
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
    el.addEventListener("focus", handler);
    el.addEventListener("click", handler);
    grow(el);
  });

  const key = "__universalAutogrowResizeWired";
  if (document.body && document.body.dataset && document.body.dataset[key] !== "1") {
    document.body.dataset[key] = "1";
    window.addEventListener("resize", () => textareas.forEach(grow));
  }
}

async function refreshDataViews() {
  const jobs = await getJobsSnapshot();
  if (!jobs) return;

  cachedJobs = jobs;
  cachedJobsFetchedAt = Date.now();
  if (isElementVisibleForRender("homePage")) {
    renderSeekerJobsWithSearch(jobs);
  }

  const seekerHistoryVisible = isElementVisibleForRender("seekerHistoryPage");
  const employerHistoryVisible = isElementVisibleForRender("employerHistory");
  const employerOverviewVisible = isElementVisibleForRender("employeePage");

  if (getLoggedIn() && getLoggedInRole() === "employer" && employerOverviewVisible) {
    const myId = localStorage.getItem(STORAGE_CURRENT_USER_KEY);
    const mine = myId ? jobs.filter((j) => j.employerId === myId) : jobs;
    renderEmployerPostedJobs(mine);
  }

  if (getLoggedIn() && getLoggedInRole() === "seeker" && seekerHistoryVisible) {
    loadSeekerHistoryFromBackend().catch(() => {});
  }
  if (getLoggedIn() && getLoggedInRole() === "employer" && employerHistoryVisible) {
    loadEmployerHistoryFromBackend().catch(() => {});
  }
}

async function tryBackendLogin({ role, email, password }) {
  try {
    const data = await apiRequest("/api/login", { method: "POST", body: { role, email, password } });
    if (data && data.ok && data.token && data.user) {
      localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, data.token);
      return data;
    }
  } catch (err) {
    // Only fall back when the backend is unreachable (fetch/network error).
    if (err && typeof err.status === "number") {
      throw err;
    }
  }
  return null;
}

async function tryBackendSignup({ role, email, password, name, company }) {
  try {
    const data = await apiRequest("/api/signup", {
      method: "POST",
      body: { role, email, password, name, company },
    });
    if (data && data.ok && data.token && data.user) {
      localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, data.token);
      return data;
    }
  } catch (err) {
    // Only fall back when the backend is unreachable (fetch/network error).
    if (err && typeof err.status === "number") {
      throw err;
    }
  }
  return null;
}

function clearAuthToken() {
  localStorage.removeItem(STORAGE_AUTH_TOKEN_KEY);
}

function hasBackendToken() {
  return Boolean(localStorage.getItem(STORAGE_AUTH_TOKEN_KEY));
}

function handleNotAuthenticated(roleHint) {
  // Local UI can say logged-in while backend token expired (server restart / sessions cleared).
  clearAuth();
  isEmployer = roleHint === "employer";
  openLogin();
}

async function revalidateBackendSession() {
  if (!getLoggedIn()) return;
  const proto = window.location && window.location.protocol;
  // Only enforce backend sessions when running via the server (not file://).
  if (proto !== "http:" && proto !== "https:") return;

  const roleHint = getLoggedInRole();
  if (!hasBackendToken()) {
    handleNotAuthenticated(roleHint);
    return;
  }

  try {
    await apiRequest("/api/me", { method: "GET", auth: true });
  } catch (err) {
    if (err && err.status === 401) {
      handleNotAuthenticated(roleHint);
    }
  }
}

function getStoredUsers() {
  const raw = localStorage.getItem(STORAGE_USERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStoredUsers(users) {
  localStorage.setItem(STORAGE_USERS_KEY, JSON.stringify(users));
}

function setCurrentUser(user) {
  if (!user) return;
  localStorage.setItem(STORAGE_CURRENT_USER_KEY, user.id);
  localStorage.setItem("currentUserId", user.id || "");
  localStorage.setItem("currentUserEmail", user.email || "");
  localStorage.setItem("currentUserName", user.name || user.company || "");
  localStorage.setItem("currentUserCompany", user.company || "");
}

function clearCurrentUser() {
  localStorage.removeItem(STORAGE_CURRENT_USER_KEY);
  localStorage.removeItem("currentUserId");
  localStorage.removeItem("currentUserEmail");
  localStorage.removeItem("currentUserName");
  localStorage.removeItem("currentUserCompany");
}

function findUserByEmailRole(email, role) {
  const users = getStoredUsers();
  return users.find((u) => u.email === email && u.role === role);
}

function findUserByEmail(email) {
  const users = getStoredUsers();
  return users.find((u) => u.email === email);
}

function createMockUser({ role, email, password, name, company, provider }) {
  return {
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    email,
    password: password || "",
    name: name || "",
    company: company || "",
    provider: provider || "local",
    createdAt: new Date().toISOString(),
  };
}

function setActiveNav(linkId) {
  document.querySelectorAll(".nav-links a").forEach((link) => {
    link.classList.toggle("active", link.id === linkId);
  });
}

function setAuth(role) {
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userRole", role);
}

function clearAuth() {
  localStorage.removeItem("isLoggedIn");
  localStorage.removeItem("userRole");
  clearCurrentUser();
  clearAuthToken();
}

function updateAuthUI() {
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.style.display = loggedIn ? "inline-flex" : "none";
  }
  updateNotificationsBackButton();
}

function updateNotificationsBackButton() {
  const btn = document.getElementById("notifBackBtn");
  if (!btn) return;
  const isShown = (el) => {
    if (!el) return false;
    try {
      const s = window.getComputedStyle(el);
      return Boolean(s && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0");
    } catch {
      return String(el.style && el.style.display) !== "none";
    }
  };
  const seekerNotif = document.getElementById("seekerNotificationsPage");
  const employerNotif = document.getElementById("employerNotifications");
  const visible = isShown(seekerNotif) || isShown(employerNotif);
  btn.style.display = visible ? "inline-flex" : "none";
}

function schedulePostLoginUiRefresh() {
  window.setTimeout(() => {
    updateAuthUI();
    syncBookmarkButtons(document);
    renderSavedJobs();
  }, 0);
}

function scheduleEmployerOverviewRefresh() {
  if (employerOverviewRefreshTimer != null) {
    return;
  }
  // Let the dashboard paint first, then refresh its heavier job/KPI data in the background.
  employerOverviewRefreshTimer = window.setTimeout(() => {
    employerOverviewRefreshTimer = null;
    if (!getLoggedIn() || getLoggedInRole() !== "employer") {
      return;
    }
    if (!isElementVisibleForRender("employeePage")) {
      return;
    }
    refreshDataViews().catch(() => {});
  }, 32);
}

function scheduleRefreshDataViews(delay = 0) {
  if (dataViewsRefreshTimer != null) {
    return;
  }
  dataViewsRefreshTimer = window.setTimeout(() => {
    dataViewsRefreshTimer = null;
    refreshDataViews().catch(() => {});
  }, Math.max(0, Number(delay || 0)));
}

function openNotifications() {
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const role = localStorage.getItem("userRole");
  // Capture the current view so the Notifications page can offer an in-app "Back" button.
  try {
    const seekerVisible = (id) => {
      const el = document.getElementById(id);
      return el && el.style.display !== "none";
    };
    const employerVisible = (id) => {
      const el = document.getElementById(id);
      return el && el.style.display !== "none";
    };
    const seekerView =
      seekerVisible("seekerChatPage")
        ? "seeker-chat"
        : seekerVisible("seekerHistoryPage")
          ? "seeker-history"
          : seekerVisible("seekerNotificationsPage")
            ? "seeker-notifications"
            : "seeker-home";
    const employerView =
      employerVisible("employerAddJob")
        ? "employer-add-job"
        : employerVisible("employerApplicants")
          ? "employer-applicants"
          : employerVisible("employerNotifications")
            ? "employer-notifications"
            : "employer-overview";
    notificationsReturnState = {
      role: String(role || ""),
      seekerView,
      employerView,
      employerApplicantsJobId: String(employerApplicantsSelectedJobId || ""),
    };
    sessionStorage.setItem("notificationsReturnState", JSON.stringify(notificationsReturnState));
  } catch {
    // ignore
  }
  if (!loggedIn) {
    openLogin();
    updateNotificationsBackButton();
    return;
  }
  if (role === "employer") {
    showEmployerNotifications();
  } else {
    showSeekerNotifications();
  }
  updateNotificationsBackButton();
}

function goBackFromNotifications() {
  const finish = () => updateNotificationsBackButton();
  let state = notificationsReturnState;
  if (!state) {
    try {
      const raw = sessionStorage.getItem("notificationsReturnState");
      state = raw ? JSON.parse(raw) : null;
    } catch {
      state = null;
    }
  }
  const role = String((state && state.role) || localStorage.getItem("userRole") || "");
  if (role === "employer") {
    const view = String(state && state.employerView ? state.employerView : "employer-overview");
    if (view === "employer-add-job") {
      openAddJob();
      finish();
      return;
    }
    if (view === "employer-applicants") {
      showEmployerApplicants();
      const jobId = String(state && state.employerApplicantsJobId ? state.employerApplicantsJobId : "").trim();
      if (jobId) {
        try {
          openEmployerApplicantsJob({ id: jobId });
        } catch {
          // ignore
        }
      }
      finish();
      return;
    }
    showEmployerOverview();
    finish();
    return;
  }

  const view = String(state && state.seekerView ? state.seekerView : "seeker-home");
  if (view === "seeker-chat") {
    showSeekerChat();
    finish();
    return;
  }
  if (view === "seeker-history") {
    showSeekerHistory();
    finish();
    return;
  }
  showSeekerHome();
  finish();
}

function togglePostedApplicants(button) {
  const card = button.closest(".posted-job-card");
  if (!card) return;
  const panel = card.nextElementSibling;
  if (!panel || !panel.classList.contains("posted-applicants")) return;
  const isOpen = panel.classList.toggle("show");
  button.textContent = isOpen ? "Hide Applicants" : "Applicants";
}

function toggleApplicantDetail(button) {
  const row = button.closest(".posted-applicants-row");
  if (!row) return;
  const detail = row.nextElementSibling;
  if (!detail || !detail.classList.contains("posted-applicant-detail")) return;
  const isOpen = detail.classList.toggle("show");
  button.textContent = isOpen ? "Hide" : "Details";
}

function setDisplay(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = value;
  }
}

function isElementVisible(el) {
  if (!el) return false;
  try {
    const s = window.getComputedStyle(el);
    if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    return el.getClientRects && el.getClientRects().length > 0;
  } catch {
    // Fallback to inline style if computed style is unavailable.
    return String(el.style && el.style.display) !== "none";
  }
}

function goToSeekerProfileReview(userId) {
  const id = String(userId || "").trim();
  if (!id) return;

  const modal = document.getElementById("seekerProfileModal");
  if (!modal) {
    alert("Profile viewer is not available on this page.");
    return;
  }

  const setText = (el, value) => {
    if (!el) return;
    el.textContent = String(value || "").trim() || "—";
  };

  const normalizeExternalUrl = (value) => {
    const v = String(value || "").trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v)) return `https://${v}`;
    // If it doesn't look like a URL, keep it as plain text.
    return "";
  };

  const setLink = (el, value) => {
    if (!el) return;
    const raw = String(value || "").trim();
    const url = normalizeExternalUrl(raw);
    if (!raw) {
      el.textContent = "—";
      el.setAttribute("href", "#");
      el.classList.add("is-muted");
      return;
    }
    el.textContent = raw;
    if (url) {
      el.setAttribute("href", url);
      el.classList.remove("is-muted");
    } else {
      el.setAttribute("href", "#");
      el.classList.add("is-muted");
    }
  };

  const nameEl = document.getElementById("seekerProfileName");
  const titleEl = document.getElementById("seekerProfileTitle");
  const emailEl = document.getElementById("seekerProfileEmail");
  const phoneEl = document.getElementById("seekerProfilePhone");
  const locEl = document.getElementById("seekerProfileLocation");
  const fbEl = document.getElementById("seekerProfileFacebook");
  const ghEl = document.getElementById("seekerProfileGithub");
  const aboutEl = document.getElementById("seekerProfileAbout");
  const skillsEl = document.getElementById("seekerProfileSkills");
  const avatarEl = document.getElementById("seekerProfileAvatar");
  const avatarImgEl = document.getElementById("seekerProfileAvatarImg");
  const avatarInitialsEl = document.getElementById("seekerProfileAvatarInitials");
  const openTagEl = document.getElementById("seekerProfileOpenTag");
  const fileBtn = document.getElementById("seekerProfileFileBtn");

  const applyPayload = (u) => {
    const user = u && u.user && typeof u.user === "object" ? u.user : {};
    const profile = u && u.profile && typeof u.profile === "object" ? u.profile : {};
    const contact = profile.contact && typeof profile.contact === "object" ? profile.contact : {};

    const displayName = String(profile.name || user.name || "Applicant").trim() || "Applicant";
    setText(nameEl, displayName);
    setText(titleEl, profile.title || profile.headline || "—");
    setText(emailEl, contact.email || user.email || "—");
    setText(phoneEl, contact.phone || "—");
    setText(locEl, contact.location || profile.location || "—");
    setLink(fbEl, contact.facebook || "");
    setLink(ghEl, contact.github || "");

    const about = String(profile.aboutText || profile.about || "").trim();
    setText(aboutEl, about || "—");

    const parts = displayName.split(/\s+/).filter(Boolean);
    const initials = parts.slice(0, 2).map((p) => p[0]).join("").toUpperCase();
    if (avatarInitialsEl) {
      avatarInitialsEl.textContent = initials || "A";
    } else if (avatarEl) {
      avatarEl.textContent = initials || "A";
    }

    const rawAvatar = String(profile.avatarDataUrl || profile.avatar || profile.photo || "").trim();
    const hasAvatar = rawAvatar && (/^data:image\//i.test(rawAvatar) || /^https?:\/\//i.test(rawAvatar));
    if (avatarEl) avatarEl.classList.toggle("has-photo", Boolean(hasAvatar));
    if (avatarImgEl) {
      if (hasAvatar) {
        avatarImgEl.src = rawAvatar;
        avatarImgEl.style.display = "block";
      } else {
        avatarImgEl.removeAttribute("src");
        avatarImgEl.style.display = "none";
      }
    }

    if (openTagEl) {
      const openToWork = typeof profile.openToWork === "boolean" ? profile.openToWork : true;
      openTagEl.textContent = openToWork ? "Open to Work" : "Not Looking";
      openTagEl.classList.toggle("success", openToWork);
    }

    if (skillsEl) {
      skillsEl.innerHTML = "";
      const skills = Array.isArray(profile.skills) ? profile.skills : [];
      const clean = skills.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 12);
      const list = clean.length ? clean : ["No skills listed"];
      list.forEach((s) => {
        const pill = document.createElement("span");
        pill.textContent = s;
        skillsEl.appendChild(pill);
      });
    }

    const hasFile =
      (Array.isArray(profile.resumes) && profile.resumes.some((r) => r && typeof r.dataUrl === "string" && r.dataUrl)) ||
      (profile.resume && typeof profile.resume === "object" && typeof profile.resume.dataUrl === "string" && profile.resume.dataUrl);
    if (fileBtn) {
      fileBtn.style.display = hasFile ? "inline-flex" : "none";
      fileBtn.onclick = () => {
        const files = extractUploadedFilesFromProfile(profile);
        openFilePicker(files, { title: "Choose a file", sub: "Select a seeker-uploaded file to open." });
      };
    }
  };

  const cached = userProfileCache.get(id);
  const cachedPayload = cached && cached.payload ? cached.payload : null;
  const cachedFresh = Boolean(cached && (Date.now() - (Number(cached.fetchedAt) || 0) < USER_PROFILE_CACHE_TTL_MS));

  if (cachedPayload) {
    modal.style.display = "flex";
    applyPayload(cachedPayload);
    if (cachedFresh) return;
  } else {
    setText(nameEl, "Loading...");
    setText(titleEl, "");
    setText(emailEl, "");
    setText(phoneEl, "");
    setText(locEl, "");
    setLink(fbEl, "");
    setLink(ghEl, "");
    setText(aboutEl, "");
    if (avatarEl) avatarEl.classList.remove("has-photo");
    if (avatarImgEl) {
      avatarImgEl.removeAttribute("src");
      avatarImgEl.style.display = "none";
    }
    if (avatarInitialsEl) {
      avatarInitialsEl.textContent = "...";
    } else if (avatarEl) {
      avatarEl.textContent = "...";
    }
    if (openTagEl) {
      openTagEl.textContent = "—";
      openTagEl.classList.remove("success");
    }
    if (skillsEl) skillsEl.innerHTML = "";
    if (fileBtn) fileBtn.style.display = "none";
    modal.style.display = "flex";
  }

  apiRequest(`/api/users/${encodeURIComponent(id)}`, { method: "GET", auth: true })
    .then((u) => {
      if (!u || !u.ok) {
        throw new Error((u && u.error) || "Failed to load profile.");
      }
      userProfileCache.set(id, { payload: u, fetchedAt: Date.now() });
      applyPayload(u);
    })
    .catch((err) => {
      setText(nameEl, "Could not load profile");
      setText(titleEl, err?.message || "Please try again.");
      if (fileBtn) fileBtn.style.display = "none";
    });
}

function closeSeekerProfileReview() {
  const modal = document.getElementById("seekerProfileModal");
  if (modal) {
    modal.style.display = "none";
  }
}

function extractUploadedFilesFromProfile(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const resumes = Array.isArray(p.resumes) ? p.resumes.filter((r) => r && typeof r === "object") : [];
  const legacy = p.resume && typeof p.resume === "object" ? p.resume : null;
  const files = [];

  resumes.forEach((r) => {
    const dataUrl = typeof r.dataUrl === "string" ? r.dataUrl : "";
    if (!dataUrl) return;
    files.push({
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : "File",
      dataUrl,
      uploadedAt: typeof r.uploadedAt === "string" ? r.uploadedAt : "",
      size: typeof r.size === "number" ? r.size : 0,
      type: typeof r.type === "string" ? r.type : "",
    });
  });

  if (!files.length && legacy) {
    const dataUrl = typeof legacy.dataUrl === "string" ? legacy.dataUrl : "";
    if (dataUrl) {
      files.push({
        name: typeof legacy.name === "string" && legacy.name.trim() ? legacy.name.trim() : "File",
        dataUrl,
        uploadedAt: typeof legacy.uploadedAt === "string" ? legacy.uploadedAt : "",
        size: typeof legacy.size === "number" ? legacy.size : 0,
        type: typeof legacy.type === "string" ? legacy.type : "",
      });
    }
  }

  return files;
}

function dataUrlToBlob(dataUrl) {
  const raw = String(dataUrl || "");
  const comma = raw.indexOf(",");
  if (comma < 0) throw new Error("Invalid data URL");
  const header = raw.slice(0, comma);
  const body = raw.slice(comma + 1);

  const isBase64 = /;base64$/i.test(header);
  const mimeMatch = /^data:([^;]+)/i.exec(header);
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";

  if (!isBase64) {
    const text = decodeURIComponent(body);
    return new Blob([text], { type: mime });
  }

  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function openUploadedFile({ dataUrl, name }) {
  const rawUrl = String(dataUrl || "");
  if (!rawUrl) return;
  const fileName = String(name || "File").trim() || "File";

  // Large data URLs often open as blank pages in some browsers. Blob URLs are more reliable.
  let urlToOpen = rawUrl;
  try {
    const blob = dataUrlToBlob(rawUrl);
    urlToOpen = URL.createObjectURL(blob);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(urlToOpen);
      } catch {
        // ignore
      }
    }, 60_000);
  } catch {
    urlToOpen = rawUrl;
  }

  const w = window.open(urlToOpen, "_blank");
  if (w) {
    try {
      w.document.title = fileName;
    } catch {
      // ignore (cross-origin / navigation timing)
    }
    return;
  }

  // Popup blocked: fall back to a download.
  try {
    const a = document.createElement("a");
    a.href = urlToOpen;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    alert("Popup blocked. Allow popups to view the file.");
  }
}

function openFilePicker(files, { title = "Choose a file", sub = "Select one to open in a new tab." } = {}) {
  const modal = document.getElementById("filePickerModal");
  if (!modal) return;
  const titleEl = document.getElementById("filePickerTitle");
  const subEl = document.getElementById("filePickerSub");
  const listEl = document.getElementById("filePickerList");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;
  if (listEl) {
    listEl.innerHTML = "";
    const list = Array.isArray(files) ? files : [];
    if (!list.length) {
      listEl.innerHTML = `<div class="file-row"><div><div class="file-row-title">No files uploaded</div><div class="file-row-meta">This seeker has not uploaded any files yet.</div></div></div>`;
    } else {
      list.forEach((f) => {
        const row = document.createElement("div");
        row.className = "file-row";
        const name = String(f?.name || "File").trim() || "File";
        const metaBits = [];
        const uploadedAt = String(f?.uploadedAt || "").trim();
        if (uploadedAt) metaBits.push(`Uploaded ${formatRelative(uploadedAt)}`);
        const type = String(f?.type || "").trim();
        if (type) metaBits.push(type);
        const size = Number(f?.size) || 0;
        if (size) metaBits.push(`${Math.round(size / 1024)} KB`);
        const meta = metaBits.join(" \u2022 ");

        row.innerHTML = `
          <div>
            <div class="file-row-title"></div>
            <div class="file-row-meta"></div>
          </div>
          <div class="file-row-actions">
            <button class="file-open-btn" type="button">Open</button>
          </div>
        `;
        const titleNode = row.querySelector(".file-row-title");
        const metaNode = row.querySelector(".file-row-meta");
        const openBtn = row.querySelector("button.file-open-btn");
        if (titleNode) titleNode.textContent = name;
        if (metaNode) metaNode.textContent = meta || " ";
        if (openBtn) {
          openBtn.onclick = () => {
            openUploadedFile({ dataUrl: String(f?.dataUrl || ""), name });
          };
        }

        listEl.appendChild(row);
      });
    }
  }
  modal.style.display = "flex";
}

function closeFilePicker() {
  const modal = document.getElementById("filePickerModal");
  if (modal) modal.style.display = "none";
}

function handleNotificationClick(card) {
  const target = card.getAttribute("data-notice-target");
  if (!target) {
    return;
  }
  if (target === "seeker-chat") {
    showSeekerChat();
    const name = card.getAttribute("data-chat-name");
    const role = card.getAttribute("data-chat-role");
    if (name) {
      const temp = document.createElement("button");
      temp.setAttribute("data-chat-name", name);
      if (role) {
        temp.setAttribute("data-chat-role", role);
      }
      openSeekerChat(temp);
    }
    return;
  }
  if (target === "seeker-history") {
    showSeekerHistory();
    return;
  }
  if (target === "employer-applicants") {
    showEmployerApplicants();
    return;
  }
  if (target === "employer-history") {
    showEmployerHistory();
    return;
  }
  if (target === "employer-notifications") {
    showEmployerNotifications();
  }
}

function toggleUserMenu() {
  const menu = document.getElementById("userMenu");
  if (!menu) {
    return;
  }
  const isOpen = menu.style.display === "flex";
  menu.style.display = isOpen ? "none" : "flex";
}

function closeUserMenu() {
  const menu = document.getElementById("userMenu");
  if (menu) {
    menu.style.display = "none";
  }
}

document.addEventListener("click", (e) => {
  const menu = document.getElementById("userMenu");
  const toggle = document.querySelector(".hamburger-btn");
  if (!menu || !toggle) {
    return;
  }
  if (menu.contains(e.target) || toggle.contains(e.target)) {
    return;
  }
  menu.style.display = "none";
});

// When returning to this page via browser back/forward (bfcache), clear any
// temporary restore params from the address bar without forcing a reload.
// Also restore the correct Employer Applicants view when the page is resumed from bfcache,
// since DOMContentLoaded won't run in that case.
window.addEventListener("pageshow", () => {
  try {
    const params = new URLSearchParams(String(window.location.search || ""));
    const returnTo = String(params.get("returnTo") || "");
    const openAddJobParam = String(params.get("openAddJob") || "").trim();
    const shouldOpenAddJob = openAddJobParam === "1" || openAddJobParam.toLowerCase() === "true";
    if (returnTo === "employerApplicants" || returnTo === "employerOverview") {
      const jobId = String(params.get("jobId") || "").trim();
      // Restore the employer surface on bfcache resume (DOMContentLoaded won't fire).
      try {
        isEmployer = true;
        document.getElementById("homePage").style.display = "none";
        document.getElementById("seekerLandingPage").style.display = "none";
        document.getElementById("howItWorksPage").style.display = "none";
        setRoleToggleLabel("Employer Site");
        updateAuthUI();
      } catch {
        // ignore
      }
      if (returnTo === "employerApplicants") {
        try {
          document.getElementById("employeePage").style.display = "none";
          document.getElementById("employerLoginPage").style.display = "none";
        } catch {
          // ignore
        }
        showEmployerApplicants();
        if (jobId) {
          try {
            openEmployerApplicantsJob({ id: jobId });
          } catch {
            // ignore
          }
        }
      } else {
        // employerOverview
        if (getLoggedIn() && getLoggedInRole() === "employer") {
          showEmployerDashboard();
          if (shouldOpenAddJob) {
            try {
              openAddJob();
            } catch {
              // ignore
            }
          }
        } else {
          try {
            document.getElementById("employeePage").style.display = "none";
            document.getElementById("employerLoginPage").style.display = "flex";
            document.querySelector(".employer-shell").style.display = "flex";
          } catch {
            // ignore
          }
        }
      }
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
});

// Show Seeker Home Page
function showHome() {
  isEmployer = false;
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const role = localStorage.getItem("userRole");

  if (!loggedIn || role !== "seeker") {
    document.getElementById("homePage").style.display = "none";
    document.getElementById("seekerLandingPage").style.display = "flex";
    document.getElementById("employerLoginPage").style.display = "none";
    document.getElementById("employeePage").style.display = "none";
    document.getElementById("howItWorksPage").style.display = "none";
    setRoleToggleLabel("Hunter Site");
    setActiveNav("homeLink");
    window.scrollTo(0, 0);
    updateAuthUI();
    return;
  }

  document.getElementById("homePage").style.display = "block";
  document.getElementById("seekerLandingPage").style.display = "none";
  document.getElementById("employerLoginPage").style.display = "none";
  document.getElementById("employeePage").style.display = "none";
  document.getElementById("howItWorksPage").style.display = "none";
  setRoleToggleLabel("Hunter Site");
  setActiveNav("homeLink");
  showSeekerHome();
  if (Array.isArray(cachedJobs)) {
    renderSeekerJobsWithSearch(cachedJobs);
  } else {
    scheduleRefreshDataViews();
  }
  window.scrollTo(0, 0);
  updateAuthUI();
}

function setRoleToggleLabel(label) {
  const text = document.getElementById("roleToggleText");
  if (text) {
    text.textContent = label;
    return;
  }
  const link = document.getElementById("roleToggle");
  if (link) link.textContent = label;
}

function setDisplaySafe(id, display) {
  const el = document.getElementById(id);
  if (el) el.style.display = display;
}

function closeAllAuthModals() {
  setDisplaySafe("loginModal", "none");
  setDisplaySafe("employerLoginModal", "none");
  setDisplaySafe("seekerSignupModal", "none");
  setDisplaySafe("employerSignupModal", "none");
}

function showEmployerEntry() {
  isEmployer = true;
  document.getElementById("homePage").style.display = "none";
  document.getElementById("seekerLandingPage").style.display = "none";
  document.getElementById("employerLoginPage").style.display = "flex";
  document.getElementById("employeePage").style.display = "none";
  document.getElementById("howItWorksPage").style.display = "none";
  setDisplaySafe("employerAddJob", "none");
  const shell = document.querySelector(".employer-shell");
  if (shell) shell.style.display = "flex";
  setRoleToggleLabel("Employer Site");
  setActiveNav("homeLink");
  window.scrollTo(0, 0);
  updateAuthUI();
}

function goHome() {
  closeAllAuthModals();
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const role = localStorage.getItem("userRole");

  if (isEmployer || (loggedIn && role === "employer")) {
    if (loggedIn && role === "employer") {
      showEmployerDashboard();
      return;
    }
    showEmployerEntry();
    return;
  }

  showHome();
}

function setupPasswordToggles() {
  document.querySelectorAll(".toggle-password").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const input = document.getElementById(targetId);
      if (!input) {
        return;
      }
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      const icon = btn.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-eye", !isHidden);
        icon.classList.toggle("fa-eye-slash", isHidden);
      }
      btn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    });
  });
}

function getPasswordStrengthMeta(value) {
  const password = String(value || "");
  if (!password) return { tone: "", label: "", hint: "" };

  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  if (password.length < 8 || score <= 2) {
    return {
      tone: "is-weak",
      label: "Weak password",
      hint: "Use 8+ chars with uppercase, lowercase, number, and symbol.",
    };
  }
  if (score <= 4) {
    return {
      tone: "is-medium",
      label: "Medium password",
      hint: "Add more length or character variety.",
    };
  }
  return {
    tone: "is-strong",
    label: "Strong password",
    hint: "Good password strength.",
  };
}

function updatePasswordStrength(inputId, outputId) {
  const input = document.getElementById(inputId);
  const output = document.getElementById(outputId);
  if (!input || !output) return;
  const meta = getPasswordStrengthMeta(input.value);
  output.classList.remove("is-weak", "is-medium", "is-strong");
  if (!meta.label) {
    output.textContent = "";
    return;
  }
  output.classList.add(meta.tone);
  output.textContent = `${meta.label} - ${meta.hint}`;
}

function setupPasswordStrengthMeters() {
  [
    ["seekerSignupPassword", "seekerSignupPasswordStrength"],
    ["employerSignupPassword", "employerSignupPasswordStrength"],
  ].forEach(([inputId, outputId]) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.dataset.strengthBound !== "true") {
      input.dataset.strengthBound = "true";
      input.addEventListener("input", () => updatePasswordStrength(inputId, outputId));
      input.addEventListener("blur", () => updatePasswordStrength(inputId, outputId));
    }
    updatePasswordStrength(inputId, outputId);
  });
}

function setupHistoryStatusButtons() {
  document.querySelectorAll(".history-cta-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".history-card");
      if (!card) {
        return;
      }
      const tag = card.querySelector(".history-tag");
      const icon = btn.querySelector("i");
      const label = btn.querySelector("span");
      const state = btn.getAttribute("data-state");

      if (state === "open") {
        btn.setAttribute("data-state", "closed");
        if (label) label.textContent = "Open";
        if (icon) {
          icon.classList.remove("fa-circle-xmark");
          icon.classList.add("fa-circle-check");
        }
        if (tag) {
          tag.textContent = "Closed";
          tag.classList.add("muted");
        }
        card.classList.remove("active");
        return;
      }

      btn.setAttribute("data-state", "open");
      if (label) label.textContent = "Close";
      if (icon) {
        icon.classList.remove("fa-circle-check");
        icon.classList.add("fa-circle-xmark");
      }
      if (tag) {
        tag.textContent = "Active";
        tag.classList.remove("muted");
      }
      card.classList.add("active");
    });
  });
}

// Show home page on load
document.addEventListener("DOMContentLoaded", async () => {
  setupSyncBus();
  setupServerEvents();
  setupConfirmModal();
  setupInfoModal();
  setupAddJobDraftAutosave();
  setupAddJobFormActions();
  setupSeekerSearch();
  setupSeekerChatControls();
  setupSeekerChatAttachmentUi();
  setupSeekerChatExpandUi();
  setupUniversalTextareaAutogrow();
  setupEmployerApplicantsSearch();
  setupEmployerApplicantsJobsSearch();
  setupEmployerApplicantsJobsFilterSort();
  setupEmployerApplicantsBackButton();
  setupEmployerApplicantsClosePostingButton();
  setupEmployerApplicantsViewButtons();
  // Seeker "Save" (bookmark) buttons
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-save-job=\"1\"]") : null;
    if (!btn) return;
    const card = btn.closest(".job-card");
    const jobId = getOrCreateJobIdFromCard(card);
    if (!jobId) return;

    // Only seekers can save jobs; prompt login if needed.
    if (!getLoggedIn() || getLoggedInRole() !== "seeker") {
      isEmployer = false;
      openLogin();
      return;
    }

    const saved = getSavedJobs();
    const idx = saved.findIndex((j) => String(j.id) === String(jobId));
    if (idx >= 0) {
      saved.splice(idx, 1);
      setSavedJobs(saved);
      setBookmarkButtonState(btn, false);
    } else {
      saved.push(snapshotJobFromCard(card, jobId));
      setSavedJobs(saved);
      setBookmarkButtonState(btn, true);
    }

    renderSavedJobs();
    // If the same job appears in multiple places, keep icons consistent.
    syncBookmarkButtons(document);
  });

  window.setTimeout(() => {
    revalidateBackendSession().catch(() => {});
  }, 0);

  const handleReturnToViewOnLoad = async () => {
    let params;
    try {
      params = new URLSearchParams(String(window.location.search || ""));
    } catch {
      return false;
    }
    const returnTo = String(params.get("returnTo") || "");
    const openAddJobParam = String(params.get("openAddJob") || "").trim();
    const shouldOpenAddJob = openAddJobParam === "1" || openAddJobParam.toLowerCase() === "true";
    if (returnTo !== "employerApplicants" && returnTo !== "employerOverview") return false;

    const jobId = String(params.get("jobId") || "").trim();
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      // ignore
    }

    // Keep the user on the Employer surface (never dump back to Seeker).
    isEmployer = true;
    try {
      document.getElementById("homePage").style.display = "none";
      document.getElementById("seekerLandingPage").style.display = "none";
      document.getElementById("howItWorksPage").style.display = "none";
      setRoleToggleLabel("Employer Site");
      updateAuthUI();
    } catch {
      // ignore
    }

    const loggedIn = localStorage.getItem("isLoggedIn") === "true";
    const role = localStorage.getItem("userRole");
    if (returnTo === "employerOverview") {
      if (loggedIn && role === "employer") {
        showEmployerDashboard();
        if (shouldOpenAddJob) {
          try {
            openAddJob();
          } catch {
            // ignore
          }
        }
      } else {
        document.getElementById("employeePage").style.display = "none";
        document.getElementById("seekerLandingPage").style.display = "none";
        document.getElementById("employerLoginPage").style.display = "flex";
        document.querySelector(".employer-shell").style.display = "flex";
        updateAuthUI();
      }
      return true;
    }

    // employerApplicants
    try {
      document.getElementById("employeePage").style.display = "none";
      document.getElementById("employerLoginPage").style.display = "none";
    } catch {
      // ignore
    }
    showEmployerApplicants();
    if (jobId) {
      try {
        if (loggedIn && role === "employer") {
          openEmployerApplicantsJob({ id: jobId });
        }
      } catch {
        // ignore
      }
    }
    return true;
  };

  if (await handleReturnToViewOnLoad()) {
    setupPasswordToggles();
    setupHistoryViewButtons();
    setupHistoryStatusButtons();
    scheduleRefreshDataViews();
    renderSavedJobs();
    syncBookmarkButtons(document);
    finishInitialRender();
    return;
  }
  const postSignup = localStorage.getItem("postSignupWelcome");
  const target = localStorage.getItem("postLoginTarget");
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const role = localStorage.getItem("userRole");
  if (postSignup && loggedIn && role === postSignup) {
    localStorage.removeItem("postSignupWelcome");
    if (role === "employer") {
      showEmployerDashboard();
      openEmployerWelcome();
    } else {
      showHome();
      openWelcome();
    }
    setupPasswordToggles();
    setupPasswordStrengthMeters();
    setupHistoryViewButtons();
    setupHistoryStatusButtons();
    finishInitialRender();
    return;
  }
  if (target === "employer" && loggedIn && role === "employer") {
    localStorage.removeItem("postLoginTarget");
    showEmployerDashboard();
    setupPasswordToggles();
    setupPasswordStrengthMeters();
    setupHistoryViewButtons();
    setupHistoryStatusButtons();
    finishInitialRender();
    return;
  }
  showHome();
  setupPasswordToggles();
  setupPasswordStrengthMeters();
  setupHistoryViewButtons();
  setupHistoryStatusButtons();
  // Render jobs from backend (if running) and wire add-job buttons.
  scheduleRefreshDataViews();
  renderSavedJobs();
  syncBookmarkButtons(document);
  const homePage = document.getElementById("homePage");
  if (homePage && homePage.style.display !== "none") {
    const anyVisible = Array.from(document.querySelectorAll(".seeker-view"))
      .some((view) => view.style.display === "block" || view.style.display === "flex");
    if (!anyVisible) {
      showSeekerHome();
    }
  }
  finishInitialRender();

  window.setTimeout(() => {
    bootstrapGoogleClientIdFromServer().catch(() => {});
    waitForGoogleIdentityServices(12000).catch(() => {});
  }, 0);
});

// Toggle Employer/Seeker view
function toggleRole() {
  isEmployer = !isEmployer;
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const role = localStorage.getItem("userRole");
  if (isEmployer) {
    if (loggedIn && role === "employer") {
      showEmployerDashboard();
      return;
    }
    document.getElementById("homePage").style.display = "none";
    document.getElementById("seekerLandingPage").style.display = "none";
    document.getElementById("employerLoginPage").style.display = "flex";
    document.getElementById("employeePage").style.display = "none";
    document.getElementById("employerAddJob").style.display = "none";
    document.querySelector(".employer-shell").style.display = "flex";
    setRoleToggleLabel("Employer Site");
    setActiveNav("homeLink");
    updateAuthUI();
  } else {
    showHome();
  }
}

// Go to role-specific page from "How It Works"
function goToRole(role) {
  isEmployer = (role === 'employer');
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const currentRole = localStorage.getItem("userRole");
  if (isEmployer) {
    if (loggedIn && currentRole === "employer") {
      showEmployerDashboard();
      return;
    }
    document.getElementById("homePage").style.display = "none";
    document.getElementById("seekerLandingPage").style.display = "none";
    document.getElementById("employerLoginPage").style.display = "flex";
    document.getElementById("employeePage").style.display = "none";
    document.getElementById("employerAddJob").style.display = "none";
    document.querySelector(".employer-shell").style.display = "flex";
    document.getElementById("howItWorksPage").style.display = "none";
    setRoleToggleLabel("Employer Site");
    setActiveNav("homeLink");
    updateAuthUI();
  } else {
    showHome();
  }
}

// Show How It Works page
function showHowItWorks() {
  showHowItWorksRole("seeker");
}

function showHowItWorksRole(role) {
  document.getElementById("homePage").style.display = "none";
  document.getElementById("seekerLandingPage").style.display = "none";
  document.getElementById("employerLoginPage").style.display = "none";
  document.getElementById("employeePage").style.display = "none";
  document.getElementById("howItWorksPage").style.display = "flex";
  const isEmployerView = role === "employer";
  const seekerBlock = document.getElementById("howItWorksSeeker");
  const employerBlock = document.getElementById("howItWorksEmployer");
  const roleCta = document.getElementById("howRoleCta");
  if (seekerBlock && employerBlock) {
    seekerBlock.style.display = isEmployerView ? "none" : "block";
    employerBlock.style.display = isEmployerView ? "block" : "none";
  }
  if (roleCta) {
    roleCta.style.display = "flex";
  }
  const seekerBtn = document.getElementById("howSeekerBtn");
  const employerBtn = document.getElementById("howEmployerBtn");
  if (seekerBtn && employerBtn) {
    seekerBtn.classList.toggle("cta-active", !isEmployerView);
    employerBtn.classList.toggle("cta-active", isEmployerView);
  }
  setActiveNav("howLink");
  window.scrollTo(0, 0);
  updateAuthUI();
}

function setActiveSeekerNav(index) {
  const items = document.querySelectorAll(".seeker-bottom-item");
  items.forEach((btn, i) => btn.classList.toggle("active", i === index));
}

function setSeekerView(viewId, navIndex) {
  const views = document.querySelectorAll(".seeker-view");
  views.forEach((view) => {
    view.style.display = view.id === viewId ? "block" : "none";
  });
  if (typeof navIndex === "number") {
    setActiveSeekerNav(navIndex);
  }
}

function showSeekerHome() {
  setSeekerView("seekerHomePage", 0);
  window.scrollTo(0, 0);
}

function showSeekerHistory() {
  setSeekerView("seekerHistoryPage", 1);
  window.scrollTo(0, 0);
  loadSeekerHistoryFromBackend();
}

function showSeekerChat() {
  setSeekerView("seekerChatPage", 2);
  setActiveNav("chatLink");
  window.scrollTo(0, 0);
  loadSeekerConversationsFromBackend();
}

function setupSeekerChatControls() {
  const searchInput = document.getElementById("seekerChatSearchInput");
  const allBtn = document.getElementById("seekerChatFilterAll");
  const unreadBtn = document.getElementById("seekerChatFilterUnread");
  if (!searchInput || !allBtn || !unreadBtn) return;
  if (searchInput.dataset.bound === "1") return;

  searchInput.dataset.bound = "1";

  searchInput.addEventListener("input", () => {
    seekerChatSearchTerm = String(searchInput.value || "").trim().toLowerCase();
    loadSeekerConversationsFromBackend().catch(() => {});
  });

  allBtn.addEventListener("click", () => {
    seekerChatFilterMode = "all";
    allBtn.classList.add("active");
    unreadBtn.classList.remove("active");
    loadSeekerConversationsFromBackend().catch(() => {});
  });

  unreadBtn.addEventListener("click", () => {
    seekerChatFilterMode = "unread";
    unreadBtn.classList.add("active");
    allBtn.classList.remove("active");
    loadSeekerConversationsFromBackend().catch(() => {});
  });
}

async function loadSeekerConversationsFromBackend() {
  const list = document.getElementById("seekerChatList");
  if (!list) return;

  if (!getLoggedIn() || getLoggedInRole() !== "seeker") {
    list.innerHTML = `<div class="empty-state-card">Please log in as a seeker to view conversations.</div>`;
    return;
  }
  if (!hasBackendToken()) {
    list.innerHTML = `<div class="empty-state-card">Session expired. Please log in again to view conversations.</div>`;
    return;
  }

  try {
    const data = await apiRequest("/api/applications?mine=1", { method: "GET", auth: true });
    const apps = data && data.ok && Array.isArray(data.applications) ? data.applications : [];
    if (!apps.length) {
      list.innerHTML = `<div class="empty-state-card">No conversations yet.</div>`;
      return;
    }

    const filteredApps = apps.filter((a) => {
      const company = String(a.company || "Employer").trim();
      const jobTitle = String(a.jobTitle || "").trim();
      const lastMessage = getLastConversationMessage(a);
      const preview = String(lastMessage && lastMessage.text ? lastMessage.text : "").trim();
      const haystack = `${company} ${jobTitle} ${preview}`.toLowerCase();
      const matchesSearch = !seekerChatSearchTerm || haystack.includes(seekerChatSearchTerm);
      const matchesUnread = seekerChatFilterMode !== "unread" || isConversationUnread(a, "seeker");
      return matchesSearch && matchesUnread;
    });

    if (!filteredApps.length) {
      list.innerHTML = `<div class="empty-state-card">No conversations match your current search or filter.</div>`;
      return;
    }

    list.innerHTML = "";
    filteredApps.forEach((a) => {
      const company = String(a.company || "Employer").trim() || "Employer";
      const initials = company.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
      const status = String(a.status || "applied").toLowerCase();
      const statusClass = status === "rejected" ? "rejected" : status === "passed" ? "shortlist" : status === "pending" ? "interview" : "new";
      const statusLabel = status === "rejected" ? "Closed" : status === "passed" ? "Passed" : status === "pending" ? "Pending" : "Applied";
      const lastMessage = getLastConversationMessage(a);
      const unread = isConversationUnread(a, "seeker");
      const preview = lastMessage
        ? (String(lastMessage.text || "").trim() || (lastMessage.attachment ? "Attachment sent." : ""))
        : "";
      const noteTime = lastMessage ? formatConversationTimestamp(lastMessage.createdAt || "") : "";
      const noteMarkup = preview
        ? `
        <div class="conversation-card__note-row">
          <p class="conversation-card__note">${preview}</p>
          ${noteTime ? `<span class="conversation-card__time">${noteTime}</span>` : ""}
        </div>`
        : "";

      const card = document.createElement("div");
      card.className = "conversation-card";
      if (unread) card.classList.add("unread");
      card.innerHTML = `
        <div class="conversation-card__header">
          <div class="conversation-card__identity">
            <div class="applicant-avatar">${initials || "E"}</div>
            <div class="conversation-card__copy">
              <h3>${company}</h3>
              <p>Applied for <span>${String(a.jobTitle || "a role")}</span></p>
            </div>
          </div>
          <button class="applicant-btn primary conversation-card__action" type="button">Open Chat</button>
        </div>
        <div class="conversation-card__meta">
          <div class="applicant-meta">
              <span class="status-tag ${statusClass}">${statusLabel}</span>
              ${unread ? '<span class="notice-tag">Unread</span>' : ""}
          </div>
        </div>
        ${noteMarkup}
      `;
      const btn = card.querySelector("button");
      if (btn) {
        btn.addEventListener("click", () => openSeekerChatForApplication(a));
      }
      list.appendChild(card);
    });
  } catch (err) {
    list.innerHTML = `<div class="empty-state-card">${err?.message || "Failed to load conversations."}</div>`;
  }
}

function showSeekerNotifications() {
  setSeekerView("seekerNotificationsPage");
  window.scrollTo(0, 0);
  if (getLoggedIn() && getLoggedInRole() === "seeker") {
    loadAndShowNotifications("seeker", { quiet: true }).catch(() => renderNotificationsList("seeker", []));
  } else {
    renderNotificationsList("seeker", []);
  }
}

function setupHistoryViewButtons() {
  const panels = document.querySelectorAll("#seekerHistoryPage .status-panel");
  const buttons = document.querySelectorAll("#seekerHistoryPage [data-history-view]");
  if (!panels.length || !buttons.length) {
    return;
  }
  const showAll = () => {
    panels.forEach((panel) => {
      panel.style.display = "block";
    });
    buttons.forEach((btn) => {
      btn.textContent = "View";
      btn.setAttribute("data-mode", "view");
    });
  };
  buttons.forEach((btn) => {
    btn.setAttribute("data-mode", "view");
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode");
      if (mode === "back") {
        showAll();
        return;
      }
      const target = btn.getAttribute("data-history-view");
      panels.forEach((panel) => {
        const section = panel.getAttribute("data-history-section");
        panel.style.display = section === target ? "block" : "none";
      });
      buttons.forEach((b) => {
        if (b === btn) {
          b.textContent = "Back";
          b.setAttribute("data-mode", "back");
        } else {
          b.textContent = "View";
          b.setAttribute("data-mode", "view");
        }
      });
    });
  });
}

function showEmployerDashboard() {
  isEmployer = true;
  document.getElementById("homePage").style.display = "none";
  document.getElementById("seekerLandingPage").style.display = "none";
  document.getElementById("employerLoginPage").style.display = "none";
  document.getElementById("employeePage").style.display = "block";
  document.getElementById("employerAddJob").style.display = "none";
  document.getElementById("employerHistory").style.display = "none";
  setDisplay("employerApplicants", "none");
  document.getElementById("employerNotifications").style.display = "none";
  document.querySelector(".employer-shell").style.display = "flex";
  document.getElementById("howItWorksPage").style.display = "none";
  setRoleToggleLabel("Employer Site");
  setActiveNav("homeLink");
  window.scrollTo(0, 0);
  updateAuthUI();
  scheduleEmployerOverviewRefresh();
}

function openAddJob() {
  document.querySelector(".employer-shell").style.display = "none";
  document.getElementById("employerHistory").style.display = "none";
  setDisplay("employerApplicants", "none");
  document.getElementById("employerNotifications").style.display = "none";
  document.getElementById("employerAddJob").style.display = "flex";
  window.scrollTo(0, 0);
}

function closeAddJob() {
  document.getElementById("employerAddJob").style.display = "none";
  document.querySelector(".employer-shell").style.display = "flex";
  document.getElementById("employerHistory").style.display = "none";
  setDisplay("employerApplicants", "none");
  document.getElementById("employerNotifications").style.display = "none";
  window.scrollTo(0, 0);
}

function setEmployerNavActive(index) {
  document.querySelectorAll(".bottom-nav-item").forEach((btn, i) => {
    btn.classList.toggle("active", i === index);
  });
}

function showEmployerOverview() {
  document.querySelector(".employer-shell").style.display = "flex";
  document.getElementById("employerHistory").style.display = "none";
  document.getElementById("employerAddJob").style.display = "none";
  setDisplay("employerApplicants", "none");
  document.getElementById("employerNotifications").style.display = "none";
  setEmployerNavActive(0);
  window.scrollTo(0, 0);
  scheduleEmployerOverviewRefresh();
}

function showEmployerHistory() {
  // History is combined into the Applicants view (job postings list + applicant pipeline).
  document.querySelector(".employer-shell").style.display = "none";
  document.getElementById("employerHistory").style.display = "none";
  document.getElementById("employerAddJob").style.display = "none";
  setDisplay("employerApplicants", "flex");
  document.getElementById("employerNotifications").style.display = "none";
  setEmployerNavActive(1);
  window.scrollTo(0, 0);
  maybeRefreshEmployerApplicants({ quiet: true }).catch(() => {});
}

function showEmployerApplicants() {
  document.querySelector(".employer-shell").style.display = "none";
  document.getElementById("employerHistory").style.display = "none";
  document.getElementById("employerAddJob").style.display = "none";
  setDisplay("employerApplicants", "flex");
  document.getElementById("employerNotifications").style.display = "none";
  setEmployerNavActive(1);
  window.scrollTo(0, 0);
  maybeRefreshEmployerApplicants({ quiet: true }).catch(() => {});
}

function showEmployerNotifications() {
  document.querySelector(".employer-shell").style.display = "none";
  document.getElementById("employerHistory").style.display = "none";
  document.getElementById("employerAddJob").style.display = "none";
  setDisplay("employerApplicants", "none");
  document.getElementById("employerNotifications").style.display = "flex";
  window.scrollTo(0, 0);
  if (getLoggedIn() && getLoggedInRole() === "employer") {
    loadAndShowNotifications("employer", { quiet: true }).catch(() => renderNotificationsList("employer", []));
  } else {
    renderNotificationsList("employer", []);
  }
}

// Modals
function openSignup(type) {
  isEmployer = (type === "employer");
  setRoleToggleLabel(isEmployer ? "Employer Site" : "Hunter Site");
  document.getElementById(type + 'SignupModal').style.display = "flex";
  updateAuthUI();
}

function closeSignup(type) {
  document.getElementById(type + 'SignupModal').style.display = "none";
}

function openLogin() {
  if (isEmployer) {
    document.getElementById("employerLoginModal").style.display = "flex";
  } else {
    let title = "Job Hunter Login";
    document.getElementById("loginTitle").innerText = title;
    document.getElementById("loginModal").style.display = "flex";
  }
  updateAuthUI();
}

function closeLogin() {
  document.getElementById("loginModal").style.display = "none";
  document.getElementById("employerLoginModal").style.display = "none";
}

async function handleLogin() {
  const role = isEmployer ? "employer" : "seeker";
  const emailInput = document.getElementById(isEmployer ? "employerLoginEmail" : "loginEmail");
  const passwordInput = document.getElementById(isEmployer ? "employerLoginPassword" : "loginPassword");
  const email = (emailInput?.value || "").trim().toLowerCase();
  const password = passwordInput?.value || "";

  try {
    await withPageLoader(async () => {
      const backend = await tryBackendLogin({ role, email, password });
      if (backend) {
        setAuth(role);
        setCurrentUser(backend.user);
        closeLogin();
        if (role === "seeker") {
          showHome();
          openWelcome();
        } else {
          showEmployerDashboard();
          openEmployerWelcome();
        }
        updateAuthUI();
        syncBookmarkButtons(document);
        renderSavedJobs();
        return;
      }

      const storedUser = findUserByEmailRole(email, role);
      if (storedUser && storedUser.password === password) {
        setAuth(role);
        setCurrentUser(storedUser);
        closeLogin();
        if (role === "seeker") {
          showHome();
          openWelcome();
        } else {
          showEmployerDashboard();
          openEmployerWelcome();
        }
        updateAuthUI();
        syncBookmarkButtons(document);
        renderSavedJobs();
        return;
      }

      const tempUsers = {
        seeker: { email: "seeker@test.com", password: "seeker123" },
        employer: { email: "employer@test.com", password: "employer123" },
      };
      const valid = email === tempUsers[role].email && password === tempUsers[role].password;

      if (!valid) {
        throw new Error("Invalid credentials. Try seeker@test.com / seeker123 or employer@test.com / employer123.");
      }

      setAuth(role);
      setCurrentUser({ id: `temp_${role}`, email: tempUsers[role].email, name: role });
      closeLogin();
      if (role === "seeker") {
        showHome();
        openWelcome();
      } else {
        showEmployerDashboard();
        openEmployerWelcome();
      }
      updateAuthUI();
      syncBookmarkButtons(document);
      renderSavedJobs();
    }, { message: "Logging in...", minDuration: 120 });
  } catch (err) {
    alert(err?.message || "Login failed.");
    return;
  }
}

function switchToSignup(type) {
  closeLogin();
  openSignup(type);
}

function switchToLogin(type) {
  closeSignup(type);
  isEmployer = (type === "employer");
  openLogin();
}

async function handleSignup(type) {
  const role = type;
  const nameInput = document.getElementById("seekerSignupName");
  const emailInput = document.getElementById(
    role === "employer" ? "employerSignupEmail" : "seekerSignupEmail"
  );
  const passwordInput = document.getElementById(
    role === "employer" ? "employerSignupPassword" : "seekerSignupPassword"
  );
  const companyInput = document.getElementById("employerSignupCompany");

  const name = (nameInput?.value || "").trim();
  const email = (emailInput?.value || "").trim().toLowerCase();
  const password = passwordInput?.value || "";
  const company = (companyInput?.value || "").trim();

  if (!email || !password || (role === "seeker" && !name) || (role === "employer" && !company)) {
    alert("Please complete all fields to sign up.");
    return;
  }
  const passwordStrength = getPasswordStrengthMeta(password);
  if (passwordStrength.tone === "is-weak") {
    alert("Password is too weak. Use 8+ characters with uppercase, lowercase, number, and symbol.");
    return;
  }

  try {
    const backend = await withPageLoader(
      () => tryBackendSignup({ role, email, password, name, company }),
      { message: "Signing up..." },
    );
    if (backend) {
      setAuth(role);
      setCurrentUser(backend.user);
      closeSignup(type);
      if (role === "seeker") {
        navigateWithLoader("Seeker_profile.html", { message: "Signing up..." });
      } else {
        navigateWithLoader("employer_profile.html", { message: "Signing up..." });
      }
      updateAuthUI();
      syncBookmarkButtons(document);
      return;
    }
  } catch (err) {
    alert(err?.message || "Sign up failed.");
    return;
  }

  // Allow the same email to be used once per role (seeker + employer can share an email).
  const existing = findUserByEmailRole(email, role);
  if (existing) {
    alert("Email already registered for this role. Please log in.");
    return;
  }

  const users = getStoredUsers();
  const newUser = createMockUser({
    role,
    email,
    password,
    name: role === "seeker" ? name : "",
    company: role === "employer" ? company : "",
  });
  users.push(newUser);
  saveStoredUsers(users);

  setAuth(role);
  setCurrentUser(newUser);
  closeSignup(type);
  if (role === "seeker") {
    navigateWithLoader("Seeker_profile.html", { message: "Signing up..." });
  } else {
    navigateWithLoader("employer_profile.html", { message: "Signing up..." });
  }
  updateAuthUI();
  syncBookmarkButtons(document);
}

function getGoogleClientId() {
  const meta = document.querySelector('meta[name="google-client-id"]');
  const metaValue = meta && typeof meta.content === "string" ? meta.content.trim() : "";
  const globalValue =
    typeof window.GOOGLE_CLIENT_ID === "string" ? window.GOOGLE_CLIENT_ID.trim() : "";
  return globalValue || metaValue || "";
}

async function waitForGoogleIdentityServices(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (window.google && google.accounts && (google.accounts.oauth2 || google.accounts.id)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function bootstrapGoogleClientIdFromServer() {
  const proto = window.location && window.location.protocol;
  const runningServer = proto === "http:" || proto === "https:";
  if (!runningServer) return;
  if (googleClientIdBootstrapPromise) {
    return await googleClientIdBootstrapPromise;
  }

  googleClientIdBootstrapPromise = (async () => {
    try {
      const data = await apiRequest("/api/config", { method: "GET" });
      const clientId = data && data.ok ? String(data.googleClientId || "").trim() : "";
      if (clientId) {
        window.GOOGLE_CLIENT_ID = clientId;
      }
      const meta = document.querySelector('meta[name="google-client-id"]');
      if (meta && clientId) meta.content = clientId;
    } catch {
      // ignore
    }
  })();

  try {
    await googleClientIdBootstrapPromise;
  } finally {
    googleClientIdBootstrapPromise = null;
  }
}

async function fetchGoogleUserInfo(accessToken) {
  const resp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) {
    throw new Error((data && (data.error_description || data.error)) || "Failed to fetch Google profile.");
  }
  return data;
}

async function getGoogleAccessToken() {
  await bootstrapGoogleClientIdFromServer();
  const clientId = getGoogleClientId();
  if (!clientId) {
    throw new Error(
      "Google sign-in is not configured. Add your OAuth Client ID to index.html (<meta name=\"google-client-id\" content=\"...\">) or set GOOGLE_CLIENT_ID when starting the server.",
    );
  }

  const ok = await waitForGoogleIdentityServices();
  if (!ok || !(window.google && google.accounts && google.accounts.oauth2)) {
    throw new Error(
      "Google sign-in library not loaded. Make sure index.html includes https://accounts.google.com/gsi/client before script.js.",
    );
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const timeout = setTimeout(() => {
      done(reject, new Error("Google sign-in timed out. Please try again."));
    }, 60000);

    try {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "openid email profile",
        callback: (tokenResponse) => {
          clearTimeout(timeout);
          const token = tokenResponse && tokenResponse.access_token;
          if (!token) {
            done(reject, new Error("Google sign-in failed (missing access token)."));
            return;
          }
          done(resolve, token);
        },
        error_callback: (errorResponse) => {
          clearTimeout(timeout);
          const code = String(errorResponse && errorResponse.type ? errorResponse.type : "").trim().toLowerCase();
          if (code === "popup_closed" || code === "popup_closed_by_user") {
            done(reject, new Error("Google sign-in was canceled."));
            return;
          }
          done(reject, new Error("Google sign-in failed. Please try again."));
        },
      });

      // Force the account picker every time.
      tokenClient.requestAccessToken({ prompt: "select_account" });
    } catch (err) {
      clearTimeout(timeout);
      done(reject, err);
    }
  });
}

async function handleGoogleAuth(role, mode) {
  const normalizedRole = role === "employer" ? "employer" : "seeker";
  const proto = window.location && window.location.protocol;
  const runningServer = proto === "http:" || proto === "https:";

  const demoFallback = (reason) => {
    if (runningServer) return;
    const promptReason = reason ? `\n\n(${reason})` : "";
    const email = String(prompt(`Enter your Google email (demo):${promptReason}`, "") || "")
      .trim()
      .toLowerCase();
    if (!email) return;

    const users = getStoredUsers();
    let user = users.find((u) => String(u.email || "").toLowerCase() === email && u.role === normalizedRole);
    if (!user) {
      if (mode !== "signup") {
        alert("No account found. Please sign up first before you log in.");
        return;
      }
      user = createMockUser({
        role: normalizedRole,
        email,
        name: normalizedRole === "seeker" ? "Google User" : "",
        company: normalizedRole === "employer" ? "" : "",
        provider: "google",
      });
      users.push(user);
      saveStoredUsers(users);
    } else if (mode === "signup") {
      alert("You already have an account.");
      return;
    }
    finalizeLogin(user, "");
  };

  const finalizeLogin = (user, token) => {
    if (token) localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, token);
    isEmployer = normalizedRole === "employer";
    setAuth(normalizedRole);
    setCurrentUser(user);
    closeLogin();
    closeSignup(normalizedRole);

    if (mode === "signup") {
      if (normalizedRole === "seeker") {
        navigateWithLoader("Seeker_profile.html", { message: "Opening profile..." });
      } else {
        navigateWithLoader("employer_profile.html", { message: "Opening profile..." });
      }
      updateAuthUI();
      syncBookmarkButtons(document);
      return;
    }

    if (normalizedRole === "seeker") {
      showHome();
      openWelcome();
    } else {
      showEmployerDashboard();
      openEmployerWelcome();
    }
    schedulePostLoginUiRefresh();
  };

  const runAuthFlow = async () => {
    let accessToken;
    try {
      accessToken = await getGoogleAccessToken();
    } catch (err) {
      const msg = String(err?.message || "Google sign-in could not start.");
      // Only fall back to demo mode when running as file:// (no backend).
      if (!runningServer) {
        demoFallback(msg);
        return;
      }
      alert(msg);
      return;
    }

    if (runningServer) {
      try {
        const data = await apiRequest("/api/auth/google", {
          method: "POST",
          body: { role: normalizedRole, mode: mode === "signup" ? "signup" : "login", accessToken },
        });
        if (data && data.ok && data.token && data.user) {
          finalizeLogin(data.user, data.token);
          return;
        }
        alert("Google sign-in failed.");
        return;
      } catch (err) {
        const message =
          err?.message ||
          "Google sign-in failed. Make sure your Google OAuth client allows this origin (e.g. http://localhost:3000) and your browser allows popups/sign-in.";
        alert(message);
        return;
      }
    }

    // Fallback when not running the backend (file://): use userinfo and store a local mock user.
    let profile;
    try {
      profile = await fetchGoogleUserInfo(accessToken);
    } catch (err) {
      if (!runningServer) {
        demoFallback(String(err?.message || "Google sign-in failed."));
        return;
      }
      alert(String(err?.message || "Google sign-in failed."));
      return;
    }

    const email = String(profile?.email || "").trim().toLowerCase();
    if (!email) {
      alert("Google sign-in failed (missing email).");
      return;
    }

    const users = getStoredUsers();
    let user = users.find((u) => String(u.email || "").toLowerCase() === email && u.role === normalizedRole);
    if (!user) {
      if (mode !== "signup") {
        alert("No account found. Please sign up first before you log in.");
        return;
      }
      user = createMockUser({
        role: normalizedRole,
        email,
        name: normalizedRole === "seeker" ? String(profile?.name || "").trim() : "",
        company: normalizedRole === "employer" ? "" : "",
        provider: "google",
      });
      users.push(user);
      saveStoredUsers(users);
    } else if (mode === "signup") {
      alert("You already have an account.");
      return;
    }

    finalizeLogin(user, "");
  };

  if (runningServer) {
    await withPageLoader(runAuthFlow, { message: "Logging in...", minDuration: 80 });
    return;
  }

  await runAuthFlow();
}

function handleFacebookAuth(role, mode) {
  const normalizedRole = role === "employer" ? "employer" : "seeker";
  const proto = window.location && window.location.protocol;
  const runningServer = proto === "http:" || proto === "https:";

  const finalizeLogin = (user, token) => {
    if (token) localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, token);
    isEmployer = normalizedRole === "employer";
    setAuth(normalizedRole);
    setCurrentUser(user);
    closeLogin();
    closeSignup(normalizedRole);

    if (mode === "signup") {
      if (normalizedRole === "seeker") {
        navigateWithLoader("Seeker_profile.html", { message: "Opening profile..." });
      } else {
        navigateWithLoader("employer_profile.html", { message: "Opening profile..." });
      }
      updateAuthUI();
      syncBookmarkButtons(document);
      return;
    }

    if (normalizedRole === "seeker") {
      showHome();
      openWelcome();
    } else {
      showEmployerDashboard();
      openEmployerWelcome();
    }
    updateAuthUI();
    syncBookmarkButtons(document);
  };

  const demoFallback = () => {
    if (runningServer) return;
    const email = String(prompt("Enter your Facebook email (demo):", "") || "").trim().toLowerCase();
    if (!email) return;

    const users = getStoredUsers();
    let user = users.find((u) => String(u.email || "").toLowerCase() === email && u.role === normalizedRole);
    if (!user) {
      if (mode !== "signup") {
        alert("No account found. Please sign up first.");
        return;
      }
      user = createMockUser({
        role: normalizedRole,
        email,
        name: normalizedRole === "seeker" ? "Facebook User" : "",
        company: normalizedRole === "employer" ? "Facebook Employer" : "",
        provider: "facebook",
      });
      users.push(user);
      saveStoredUsers(users);
    }
    finalizeLogin(user, "");
  };

  if (!runningServer) {
    demoFallback();
    return;
  }

  const rid = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const w = 520;
  const h = 720;
  const left = Math.max(0, Math.round((window.screenX || 0) + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round((window.screenY || 0) + (window.outerHeight - h) / 2));
  const features = `popup=yes,width=${w},height=${h},left=${left},top=${top}`;
  const popup = window.open(
    `/auth/facebook/start?role=${encodeURIComponent(normalizedRole)}&mode=${encodeURIComponent(mode || "login")}&rid=${encodeURIComponent(rid)}`,
    "hireup_facebook_oauth",
    features,
  );

  if (!popup) {
    alert("Popup blocked. Please allow popups and try again.");
    return;
  }

  let settled = false;
  const cleanup = () => {
    window.removeEventListener("message", onMessage);
    if (timer) clearInterval(timer);
    try {
      if (!popup.closed) popup.close();
    } catch {
      // ignore
    }
  };

  const onMessage = (event) => {
    if (settled) return;
    if (!event || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== "facebook_auth") return;
    if (String(data.rid || "") !== rid) return;

    settled = true;
    cleanup();

    if (!data.ok) {
      const error = String(data.error || "Facebook sign-in failed.");
      alert(error);
      return;
    }
    if (!data.user) {
      alert("Facebook sign-in failed (missing user).");
      return;
    }
    finalizeLogin(data.user, String(data.token || ""));
  };

  window.addEventListener("message", onMessage);

  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (settled) return;
    const elapsed = Date.now() - startedAt;
    if (elapsed > 2 * 60 * 1000) {
      settled = true;
      cleanup();
      alert("Facebook sign-in timed out. Please try again.");
      return;
    }
    try {
      if (popup.closed) {
        settled = true;
        cleanup();
        demoFallback();
      }
    } catch {
      // ignore
    }
  }, 250);
}

function openProfile() {
  closeUserMenu();
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const role = localStorage.getItem("userRole");
  if (!loggedIn) {
    // Route to the correct login modal based on current view
    openLogin();
    return;
  }
  if (role === "employer") {
    navigateWithLoader("employer_profile.html", { message: "Opening profile..." });
    return;
  }
  if (role === "seeker") {
    navigateWithLoader("Seeker_profile.html", { message: "Opening profile..." });
    return;
  }
  openLogin();
}

function openEmployerProfile() {
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const role = localStorage.getItem("userRole");
  if (!loggedIn || role !== "employer") {
    isEmployer = true;
    openLogin();
    return;
  }
  navigateWithLoader("employer_profile.html", { message: "Opening profile..." });
}

let confirmModalResolve = null;

function closeConfirmModal(result) {
  const modal = document.getElementById("confirmModal");
  if (modal) modal.style.display = "none";
  if (typeof confirmModalResolve === "function") {
    const resolve = confirmModalResolve;
    confirmModalResolve = null;
    resolve(Boolean(result));
  }
}

function showConfirmModal(message, { title = "Confirm", okText = "Yes", cancelText = "Cancel" } = {}) {
  const modal = document.getElementById("confirmModal");
  const msgEl = document.getElementById("confirmMessage");
  const titleEl = document.getElementById("confirmTitle");
  const okBtn = document.getElementById("confirmOkBtn");
  const cancelBtn = document.getElementById("confirmCancelBtn");
  if (!modal || !msgEl || !titleEl || !okBtn || !cancelBtn) {
    try {
      return Promise.resolve(confirm(String(message || "Are you sure?")));
    } catch {
      return Promise.resolve(false);
    }
  }

  // If a previous confirm is still open, resolve it as "cancel" first.
  closeConfirmModal(false);

  titleEl.textContent = String(title || "Confirm");
  msgEl.textContent = String(message || "Are you sure?");
  okBtn.textContent = String(okText || "Yes");
  cancelBtn.textContent = String(cancelText || "Cancel");

  modal.style.display = "flex";

  return new Promise((resolve) => {
    confirmModalResolve = resolve;
  });
}

function setupConfirmModal() {
  const modal = document.getElementById("confirmModal");
  const okBtn = document.getElementById("confirmOkBtn");
  const cancelBtn = document.getElementById("confirmCancelBtn");
  if (okBtn) okBtn.addEventListener("click", () => closeConfirmModal(true));
  if (cancelBtn) cancelBtn.addEventListener("click", () => closeConfirmModal(false));

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e && e.target === modal) closeConfirmModal(false);
    });
  }

  document.addEventListener("keydown", (e) => {
    const isOpen = modal && modal.style.display === "flex";
    if (!isOpen) return;
    if (e && e.key === "Escape") closeConfirmModal(false);
  });
}

function setupInfoModal() {
  const modal = document.getElementById("infoModal");
  const okBtn = document.getElementById("infoOkBtn");
  if (okBtn) okBtn.addEventListener("click", () => closeInfoModal());
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e && e.target === modal) closeInfoModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    const isOpen = modal && modal.style.display === "flex";
    if (!isOpen) return;
    if (e && e.key === "Escape") closeInfoModal();
  });
}

async function logoutAndReturn() {
  closeUserMenu();
  const ok = await showConfirmModal("Do you want to log out?", { title: "Log Out", okText: "Log out", cancelText: "Cancel" });
  if (!ok) {
    return;
  }
  const token = localStorage.getItem(STORAGE_AUTH_TOKEN_KEY);
  if (token) {
    // Best-effort: invalidate server session, then clear client state.
    fetch("/api/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  const lastRole = localStorage.getItem("userRole");
  clearAuth();
  const loginEmail = document.getElementById("loginEmail");
  const loginPassword = document.getElementById("loginPassword");
  const employerLoginEmail = document.getElementById("employerLoginEmail");
  const employerLoginPassword = document.getElementById("employerLoginPassword");
  if (loginEmail) loginEmail.value = "";
  if (loginPassword) loginPassword.value = "";
  if (employerLoginEmail) employerLoginEmail.value = "";
  if (employerLoginPassword) employerLoginPassword.value = "";
  closeLogin();
  closeSignup("seeker");
  closeSignup("employer");
  if (lastRole === "employer" || isEmployer) {
    isEmployer = true;
    document.getElementById("homePage").style.display = "none";
    document.getElementById("seekerLandingPage").style.display = "none";
    document.getElementById("employerLoginPage").style.display = "flex";
    document.getElementById("employeePage").style.display = "none";
    document.getElementById("employerAddJob").style.display = "none";
    document.querySelector(".employer-shell").style.display = "flex";
    document.getElementById("howItWorksPage").style.display = "none";
    setRoleToggleLabel("Employer Site");
    setActiveNav("homeLink");
    updateAuthUI();
    return;
  }
  showHome();
}

// Contact dropdown toggle
function toggleDropdown() {
  const dropdown = document.getElementById("contactDropdown");
  if (!dropdown) return;
  const isOpen = dropdown.classList.toggle("active");
  const menu = dropdown.querySelector(".dropdown-menu");
  if (!menu) return;

  const isMobile = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
  if (!isOpen || !isMobile) {
    // Reset any mobile positioning overrides.
    menu.style.position = "";
    menu.style.left = "";
    menu.style.right = "";
    menu.style.top = "";
    menu.style.bottom = "";
    menu.style.width = "";
    return;
  }

  // On mobile, the nav is horizontally scrollable which can clip absolute dropdowns
  // in some browsers. Use fixed positioning and anchor it under the Contact pill.
  const link = document.getElementById("contactLink");
  const place = () => {
    try {
      const rect = link ? link.getBoundingClientRect() : null;
      const top = rect ? Math.round(rect.bottom + 8) : 112;
      menu.style.position = "fixed";
      menu.style.left = "16px";
      menu.style.right = "16px";
      menu.style.top = `${top}px`;
      menu.style.bottom = "";
      menu.style.width = "auto";
    } catch {
      // ignore
    }
  };

  // Defer so display:block has applied and the layout is stable.
  setTimeout(place, 0);
}

// Close dropdown if click outside
window.addEventListener("click", function (e) {
  const dropdown = document.getElementById("contactDropdown");
  if (!dropdown.contains(e.target)) {
    dropdown.classList.remove("active");
  }
});

// Feedback & Chat
function openFeedback() {
  document.getElementById("feedbackModal").style.display = "flex";
  document.getElementById("contactDropdown").classList.remove("active");
  setActiveNav("contactLink");
  try {
    setFeedbackRating(5, { animate: false });
    const nameEl = document.getElementById("feedbackName");
    const emailEl = document.getElementById("feedbackEmail");
    const textEl = document.getElementById("feedbackText");
    const loggedIn = localStorage.getItem("isLoggedIn") === "true";
    const storedName = String(localStorage.getItem("currentUserName") || "").trim();
    const storedEmail = String(localStorage.getItem("currentUserEmail") || "").trim();
    if (nameEl) nameEl.value = loggedIn ? storedName : "";
    if (emailEl) emailEl.value = loggedIn ? storedEmail : "";
    if (textEl) textEl.value = "";
    setupUniversalTextareaAutogrow();
    if (textEl) {
      try {
        textEl.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function closeFeedback() {
  document.getElementById("feedbackModal").style.display = "none";
}

function setFeedbackRating(rating, { animate = true } = {}) {
  const n = Number(rating);
  const value = Number.isFinite(n) ? Math.max(1, Math.min(5, Math.trunc(n))) : 5;
  const input = document.getElementById("feedbackRating");
  if (input) input.value = String(value);
  const stars = Array.from(document.querySelectorAll("#feedbackModal .rating-star"));
  stars.forEach((btn, idx) => {
    btn.classList.toggle("active", idx < value);
  });
  if (animate) {
    const target = stars[value - 1];
    if (target) {
      target.classList.remove("pulse");
      // Force reflow to restart the animation.
      // eslint-disable-next-line no-unused-expressions
      target.offsetWidth;
      target.classList.add("pulse");
    }
  }
}

async function submitFeedback(event) {
  if (event && event.preventDefault) event.preventDefault();
  const name = String(document.getElementById("feedbackName")?.value || "").trim();
  const email = String(document.getElementById("feedbackEmail")?.value || "").trim();
  const message = String(document.getElementById("feedbackText")?.value || "").trim();
  const ratingRaw = String(document.getElementById("feedbackRating")?.value || "").trim();
  const rating = Math.max(1, Math.min(5, Number.parseInt(ratingRaw || "5", 10) || 5));
  const submitBtn = event && event.currentTarget ? event.currentTarget : null;

  if (!message) {
    alert("Please write your feedback first.");
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending...";
    }
    const res = await apiRequest("/api/feedback", {
      method: "POST",
      body: { kind: "feedback", name, email, message, rating },
      auth: false,
    });
    if (res && res.ok) {
      closeFeedback();
      if (res.emailSent) {
        showInfoModal("Thank you!", "Thanks for your feedback.");
      } else {
        showInfoModal("Saved", res.message || "Your feedback was saved on the server, but email delivery did not complete.");
      }
      return;
    }
    alert((res && res.error) || "Failed to send feedback.");
  } catch (err) {
    alert(err?.message || "Failed to send feedback.");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Feedback";
    }
  }
}

function showInfoModal(title, message, { okText = "OK" } = {}) {
  const modal = document.getElementById("infoModal");
  const titleEl = document.getElementById("infoTitle");
  const msgEl = document.getElementById("infoMessage");
  const okBtn = document.getElementById("infoOkBtn");
  if (!modal || !titleEl || !msgEl || !okBtn) {
    alert(String(message || title || "Done."));
    return;
  }
  titleEl.textContent = String(title || "Info");
  msgEl.textContent = String(message || "");
  okBtn.textContent = String(okText || "OK");
  modal.style.display = "flex";
}

function closeInfoModal() {
  const modal = document.getElementById("infoModal");
  if (modal) modal.style.display = "none";
}

function openChat() {
  document.getElementById("chatModal").style.display = "flex";
  document.getElementById("contactDropdown").classList.remove("active");
  setActiveNav("contactLink");
  try {
    const nameEl = document.getElementById("supportName");
    const emailEl = document.getElementById("supportEmail");
    const topicEl = document.getElementById("supportTopic");
    const textEl = document.getElementById("supportText");
    const loggedIn = localStorage.getItem("isLoggedIn") === "true";
    const storedName = String(localStorage.getItem("currentUserName") || "").trim();
    const storedEmail = String(localStorage.getItem("currentUserEmail") || "").trim();
    if (nameEl) nameEl.value = loggedIn ? storedName : "";
    if (emailEl) emailEl.value = loggedIn ? storedEmail : "";
    if (topicEl) topicEl.value = "Other";
    if (textEl) textEl.value = "";
    setupUniversalTextareaAutogrow();
    if (textEl) {
      try {
        textEl.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function closeChat() {
  document.getElementById("chatModal").style.display = "none";
}

function setSupportTemplate(text) {
  try {
    const modal = document.getElementById("chatModal");
    if (modal && modal.style.display === "none") modal.style.display = "flex";
    const textEl = document.getElementById("supportText");
    if (textEl) {
      textEl.value = String(text || "");
      try {
        setupUniversalTextareaAutogrow();
        textEl.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        // ignore
      }
      textEl.focus();
      textEl.selectionStart = textEl.value.length;
      textEl.selectionEnd = textEl.value.length;
    }
  } catch {
    // ignore
  }
}

async function submitSupportTicket(event) {
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  const name = String(document.getElementById("supportName")?.value || "").trim();
  const email = String(document.getElementById("supportEmail")?.value || "").trim();
  const topic = String(document.getElementById("supportTopic")?.value || "Other").trim();
  const text = String(document.getElementById("supportText")?.value || "").trim();
  const submitBtn = event && event.currentTarget ? event.currentTarget : null;
  if (!email) return alert("Email is required so we can reply.");
  if (!text) return alert("Please describe your issue first.");

  const role = (localStorage.getItem("userRole") || "").trim();
  const isLoggedIn = localStorage.getItem("isLoggedIn") === "true";
  const msg =
    `[Support Request]\n` +
    `Topic: ${topic || "Other"}\n` +
    `Logged in: ${isLoggedIn ? "yes" : "no"}\n` +
    `Role: ${role || "-"}\n\n` +
    `${text}`;

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending...";
    }
    const res = await apiRequest("/api/feedback", {
      method: "POST",
      body: { kind: "support", topic, name, email, message: msg, rating: 5 },
      auth: false,
    });
    if (res && res.ok) {
      closeChat();
      if (res.emailSent) {
        showInfoModal("Sent!", "Your support request was sent. We’ll reply to your email soon.");
      } else {
        showInfoModal("Saved", res.message || "Your support request was saved on the server, but email delivery did not complete.");
      }
      return;
    }
    alert((res && res.error) || "Failed to send support request.");
  } catch (err) {
    alert(err?.message || "Failed to send support request.");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send to Support";
    }
  }
}

let seekerChatIsExpanded = false;

function setSeekerChatExpanded(next) {
  seekerChatIsExpanded = Boolean(next);
  const modalContent = document.querySelector("#seekerChatModal .modal-content.chat-modal");
  const btn = document.getElementById("seekerChatExpandBtn");
  if (modalContent) modalContent.classList.toggle("is-expanded", seekerChatIsExpanded);
  if (btn) {
    btn.setAttribute("aria-label", seekerChatIsExpanded ? "Collapse chat" : "Expand chat");
    btn.setAttribute("title", seekerChatIsExpanded ? "Collapse" : "Expand");
    const icon = btn.querySelector("i");
    if (icon) {
      icon.className = seekerChatIsExpanded
        ? "fa-solid fa-down-left-and-up-right-to-center"
        : "fa-solid fa-up-right-and-down-left-from-center";
    }
  }
}

function setupSeekerChatExpandUi() {
  const btn = document.getElementById("seekerChatExpandBtn");
  if (!btn) return;
  if (btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", () => setSeekerChatExpanded(!seekerChatIsExpanded));
  setSeekerChatExpanded(seekerChatIsExpanded);
}

function setEmployerMessageExpanded(container, next) {
  if (!container) return;
  const expanded = Boolean(next);
  container.classList.toggle("is-expanded", expanded);
  const btn = container.querySelector("[data-action='expand-message']");
  if (btn) {
    btn.setAttribute("aria-label", expanded ? "Collapse message" : "Expand message");
    btn.setAttribute("title", expanded ? "Collapse" : "Expand");
    const icon = btn.querySelector("i");
    if (icon) {
      icon.className = expanded
        ? "fa-solid fa-down-left-and-up-right-to-center"
        : "fa-solid fa-up-right-and-down-left-from-center";
    }
  }
}

function setupEmployerMessageExpandUi(container) {
  if (!container) return;
  const btn = container.querySelector("[data-action='expand-message']");
  if (!btn) return;
  if (btn.dataset.bound === "1") {
    setEmployerMessageExpanded(container, container.classList.contains("is-expanded"));
    return;
  }
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => {
    setEmployerMessageExpanded(container, !container.classList.contains("is-expanded"));
  });
  setEmployerMessageExpanded(container, false);
}

let seekerAppliedJobIds = new Set();

function isSeekerAppliedToJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return false;
  return seekerAppliedJobIds.has(id);
}

function setApplyButtonUi(btn, applied) {
  if (!btn) return;
  const next = Boolean(applied);
  if (next) {
    if (!btn.dataset) return;
    if (btn.dataset.originalText == null) btn.dataset.originalText = String(btn.textContent || "").trim() || "Apply";
    btn.disabled = true;
    btn.textContent = "Applied";
    btn.setAttribute("aria-disabled", "true");
    return;
  }
  if (btn.dataset && btn.dataset.originalText) {
    btn.textContent = btn.dataset.originalText;
  } else {
    btn.textContent = "Apply";
  }
  btn.disabled = false;
  btn.removeAttribute("aria-disabled");
}

function syncSeekerApplyButtons(root = document) {
  const scope = root || document;
  try {
    scope.querySelectorAll(".job-card[data-job-id]").forEach((card) => {
      const jobId = card.getAttribute("data-job-id") || "";
      const applyBtn = card.querySelector('.job-actions button.pill-btn:not(.secondary)');
      setApplyButtonUi(applyBtn, isSeekerAppliedToJob(jobId));
    });
  } catch {
    // ignore
  }

  const quickViewModal = document.getElementById("quickViewModal");
  const quickApplyBtn = document.getElementById("quickViewApplyBtn");
  if (quickViewModal && quickApplyBtn) {
    const jobId = String(quickViewModal.getAttribute("data-job-id") || "").trim();
    setApplyButtonUi(quickApplyBtn, isSeekerAppliedToJob(jobId));
  }
}

function openSeekerChat(button) {
  const modal = document.getElementById("seekerChatModal");
  if (!modal) {
    return;
  }
  const name = button.getAttribute("data-chat-name") || "Employer";
  const role = button.getAttribute("data-chat-role") || "Role conversation";
  const title = document.getElementById("seekerChatTitle");
  const subtitle = document.getElementById("seekerChatSubtitle");
  if (title) title.textContent = name;
  if (subtitle) subtitle.textContent = role;
  setSeekerChatExpanded(seekerChatIsExpanded);
  modal.style.display = "flex";
}

async function openSeekerChatForApplication(app) {
  const modal = document.getElementById("seekerChatModal");
  if (!modal) return;
  const title = document.getElementById("seekerChatTitle");
  const subtitle = document.getElementById("seekerChatSubtitle");
  if (title) title.textContent = String(app.company || "Employer");
  if (subtitle) subtitle.textContent = String(app.jobTitle || "Role conversation");
  modal.setAttribute("data-application-id", String(app.id || ""));
  await loadSeekerChatThread(String(app.id || ""));
  setSeekerChatExpanded(seekerChatIsExpanded);
  modal.style.display = "flex";
}

async function loadSeekerChatThread(applicationId) {
  const thread = document.getElementById("seekerChatThread");
  if (!thread) return;
  thread.innerHTML = "";
  if (!applicationId) {
    thread.innerHTML = "<div style='color:#9aa4b2;font-size:12px;'>Missing conversation.</div>";
    return;
  }
  try {
    const data = await apiRequest(`/api/messages?applicationId=${encodeURIComponent(applicationId)}`, { method: "GET", auth: true });
    const msgs = data && data.ok && Array.isArray(data.messages) ? data.messages : [];
    renderConversationThread(thread, msgs, applicationId);
    if (!msgs.length) {
      thread.innerHTML = "<div style='color:#9aa4b2;font-size:12px;'>No messages yet. Send the first message below.</div>";
    }
  } catch (err) {
    thread.innerHTML = `<div style='color:#ffb4b4;font-size:12px;'>${err?.message || "Failed to load messages."}</div>`;
  }
}

function closeSeekerChat() {
  const modal = document.getElementById("seekerChatModal");
  if (modal) {
    modal.style.display = "none";
    modal.removeAttribute("data-application-id");
  }
  const input = document.getElementById("seekerChatMessage");
  if (input) input.value = "";
  const fileInput = document.getElementById("seekerChatFile");
  if (fileInput) {
    fileInput.value = "";
    try {
      fileInput.dispatchEvent(new Event("change"));
    } catch {
      // ignore
    }
  }
}

function openApplyForm(button) {
  const modal = document.getElementById("applyModal");
  if (!modal) {
    return;
  }
  const quickViewModal = document.getElementById("quickViewModal");
  if (quickViewModal) {
    quickViewModal.style.display = "none";
  }
  const card = button && button.closest ? button.closest(".featured-card, .job-card") : null;
  let jobId = card ? card.getAttribute("data-job-id") : "";
  if (!jobId) {
    const quickViewModal = document.getElementById("quickViewModal");
    const qid = quickViewModal ? String(quickViewModal.getAttribute("data-job-id") || "").trim() : "";
    if (qid) jobId = qid;
  }
  const title = card ? card.querySelector("h3, h4") : null;
  const company = card ? card.querySelector("p") : null;
  const titleEl = document.getElementById("applyJobTitle");
  const companyEl = document.getElementById("applyCompany");
  if (titleEl) {
    titleEl.textContent = title ? `Apply • ${title.textContent}` : "Apply";
  }
  if (companyEl) {
    companyEl.textContent = company ? company.textContent : "Complete the requirements below.";
  }
  if (jobId && isSeekerAppliedToJob(jobId)) {
    showInfoModal("Applied", "You already applied to this job.");
    return;
  }
  if (jobId) {
    modal.setAttribute("data-job-id", jobId);
  } else {
    modal.removeAttribute("data-job-id");
  }
  try {
    setupUniversalTextareaAutogrow();
    const msg = document.getElementById("applyMessage");
    if (msg) msg.dispatchEvent(new Event("input", { bubbles: true }));
  } catch {
    // ignore
  }
  modal.style.display = "flex";
}

function closeApplyForm() {
  const modal = document.getElementById("applyModal");
  if (modal) {
    modal.style.display = "none";
  }
}

async function submitApplication(event) {
  if (event && event.preventDefault) {
    event.preventDefault();
  }
  const modal = document.getElementById("applyModal");
  const submitBtn = event && event.currentTarget ? event.currentTarget : null;
  const originalSubmitText = submitBtn ? String(submitBtn.textContent || "").trim() || "Submit" : "Submit";
  const ok = await showConfirmModal("Do you want to submit this application?", {
    title: "Submit Application",
    okText: "Yes",
    cancelText: "Cancel",
  });
  if (!ok) {
    return;
  }
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";
  }
  if (modal) modal.style.display = "none";
  if (!getLoggedIn() || getLoggedInRole() !== "seeker") {
    alert("Please log in as a seeker to apply.");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalSubmitText;
    }
    return;
  }
  if (!hasBackendToken()) {
    alert("Please log in again to apply.");
    handleNotAuthenticated("seeker");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalSubmitText;
    }
    return;
  }
  const jobId = modal ? modal.getAttribute("data-job-id") : "";
  if (!jobId) {
    alert("Missing job reference. Please try again from a job card.");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalSubmitText;
    }
    return;
  }
  if (isSeekerAppliedToJob(jobId)) {
    showInfoModal("Applied", "You already applied to this job.");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalSubmitText;
    }
    return;
  }
  const message = (document.getElementById("applyMessage")?.value || "").trim();
  try {
    await apiRequest("/api/applications", { method: "POST", auth: true, body: { jobId, message } });
    const msgEl = document.getElementById("applyMessage");
    if (msgEl) msgEl.value = "";
    try {
      seekerAppliedJobIds.add(String(jobId || "").trim());
    } catch {
      // ignore
    }
    syncSeekerApplyButtons(document);
    emitSyncEvent("applications_updated", { jobId });
    alert("Application submitted!");
    refreshDataViews().catch(() => {});
  } catch (err) {
    if (err && err.status === 409) {
      try {
        seekerAppliedJobIds.add(String(jobId || "").trim());
      } catch {
        // ignore
      }
      syncSeekerApplyButtons(document);
      showInfoModal("Applied", "You already applied to this job.");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalSubmitText;
      }
      return;
    }
    if (err && err.status === 401) {
      alert("Session expired. Please log in again.");
      handleNotAuthenticated("seeker");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalSubmitText;
      }
      return;
    }
    alert(err?.message || "Failed to submit application.");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalSubmitText;
    }
    return;
  }
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = originalSubmitText;
  }
}

function sendSeekerMessage() {
  const thread = document.getElementById("seekerChatThread");
  const input = document.getElementById("seekerChatMessage");
  const fileInput = document.getElementById("seekerChatFile");
  if (!thread || !input || !fileInput) {
    return;
  }
  const modal = document.getElementById("seekerChatModal");
  const sendBtn = modal ? modal.querySelector(".chat-input .pill-btn") : null;
  const text = input.value.trim();
  const file = fileInput.files && fileInput.files[0];
  if (!text && !file) {
    return;
  }
  const applicationId = modal ? (modal.getAttribute("data-application-id") || "") : "";

  const sendText = async () => {
    let restoreBtn = null;
    if (sendBtn && !sendBtn.disabled) {
      const originalText = sendBtn.textContent;
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending...";
      restoreBtn = () => {
        sendBtn.disabled = false;
        sendBtn.textContent = originalText || "Send";
      };
    }
    let attachment = null;
    try {
      if (file) attachment = await buildConversationAttachment(file);

      // If connected to backend, persist the message so employer can see it.
      if (applicationId && hasBackendToken()) {
        const optimisticBubble = appendConversationBubble(thread, { text, attachment }, "seeker");
        seekerChatSuppressRefreshUntil = Date.now() + 1200;
        try {
          await apiRequest("/api/messages", {
            method: "POST",
            auth: true,
            body: { applicationId, text, ...(attachment ? { attachment } : {}) },
          });
        } catch (err) {
          if (optimisticBubble && optimisticBubble.parentNode) {
            optimisticBubble.parentNode.removeChild(optimisticBubble);
          }
          throw err;
        }

        input.value = "";
        fileInput.value = "";
        try {
          fileInput.dispatchEvent(new Event("change"));
        } catch {
          // ignore
        }
        loadSeekerConversationsFromBackend();
        emitSyncEvent("messages_updated", { applicationId });
        return;
      }

      // Fallback (file:// demo)
      appendConversationBubble(thread, { text, attachment }, "seeker");
      input.value = "";
      fileInput.value = "";
      try {
        fileInput.dispatchEvent(new Event("change"));
      } catch {
        // ignore
      }
      thread.scrollTop = thread.scrollHeight;
    } finally {
      if (restoreBtn) restoreBtn();
    }
  };

  sendText().catch((err) => {
    if (sendBtn) {
      try {
        sendBtn.disabled = false;
        if (String(sendBtn.textContent || "").trim().toLowerCase() === "sending...") sendBtn.textContent = "Send";
      } catch {
        // ignore
      }
    }
    alert(err?.message || "Failed to send message.");
  });
}

function setupSeekerChatAttachmentUi() {
  const fileInput = document.getElementById("seekerChatFile");
  const chip = document.getElementById("seekerChatAttachChip");
  const nameEl = document.getElementById("seekerChatAttachName");
  const removeBtn = document.getElementById("seekerChatAttachRemove");
  const messageInput = document.getElementById("seekerChatMessage");
  if (!fileInput || !chip || !nameEl || !removeBtn) return;
  if (fileInput.dataset.bound === "1") return;
  fileInput.dataset.bound = "1";

  const refresh = () => {
    const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    if (!file) {
      chip.style.display = "none";
      nameEl.textContent = "Attachment";
      return;
    }
    chip.style.display = "inline-flex";
    nameEl.textContent = String(file.name || "Attachment");
  };

  fileInput.addEventListener("change", refresh);
  removeBtn.addEventListener("click", () => {
    fileInput.value = "";
    refresh();
    if (messageInput) messageInput.focus();
  });
  refresh();
}

async function openQuickView(button) {
  const card = button.closest(".job-card");
  const modal = document.getElementById("quickViewModal");
  if (!card || !modal) {
    return;
  }

  const jobId = String(card.getAttribute("data-job-id") || "").trim();
  let job = findRenderedJobById(jobId);
  if (!job && jobId) {
    try {
      const jobs = await getJobsSnapshot();
      if (Array.isArray(jobs)) {
        job = jobs.find((j) => String(j && j.id ? j.id : "") === jobId) || null;
      }
    } catch {
      job = null;
    }
  }

  const fallback = {
    id: card.getAttribute("data-job-id") || "",
    title: card.querySelector("h3")?.textContent || "",
    company: card.querySelector("p")?.textContent || "",
    location: "",
    salary: card.querySelector(".job-footer strong")?.textContent || "",
    requirements: Array.from(card.querySelectorAll(".tag-row span")).map((tag) => tag.textContent || "").join("\n"),
    description: card.querySelector(".job-summary")?.textContent || "",
    createdAt: "",
  };

  if (!job) job = fallback;
  renderQuickViewDetails(job);
  try {
    modal.setAttribute("data-job-id", String(job.id || ""));
  } catch {
    // ignore
  }
  syncSeekerApplyButtons(document);
  modal.style.display = "flex";
}

function closeQuickView() {
  const modal = document.getElementById("quickViewModal");
  if (modal) {
    modal.style.display = "none";
    try {
      modal.removeAttribute("data-job-id");
    } catch {
      // ignore
    }
  }
}

function openSavedJobsManage() {
  const modal = document.getElementById("savedJobsModal");
  if (modal) {
    modal.style.display = "flex";
  }
  renderSavedJobs();
}

function closeSavedJobsManage() {
  const modal = document.getElementById("savedJobsModal");
  if (modal) {
    modal.style.display = "none";
  }
}

function unsaveSearch(button) {
  // Backwards-compatible helper (some older markup used inline onclicks).
  const card = button && button.closest ? button.closest(".saved-search") : null;
  if (!card) return;
  const jobId = card.getAttribute("data-saved-job-id");
  if (jobId) {
    unsaveJobById(jobId);
    return;
  }
}


// Welcome modal
function openWelcome() {
  document.getElementById("welcomeModal").style.display = "flex";
}

function closeWelcome() {
  document.getElementById("welcomeModal").style.display = "none";
}


function openEmployerWelcome() {
  document.getElementById("employerWelcomeModal").style.display = "flex";
}

function closeEmployerWelcome() {
  document.getElementById("employerWelcomeModal").style.display = "none";
}

function showAllRecommendedJobs() {
  if (getActiveSearch().hasQuery) return;
  const grid = document.getElementById("recommendedJobsGrid");
  if (!grid) {
    return;
  }
  grid.querySelectorAll(".job-card.hidden-reco").forEach((card) => {
    card.classList.remove("hidden-reco");
  });
  const viewBtn = document.getElementById("recoViewAllBtn");
  const returnBtn = document.getElementById("recoReturnBtn");
  if (viewBtn) viewBtn.classList.add("is-hidden");
  if (returnBtn) returnBtn.classList.remove("is-hidden");
}

function showLessRecommendedJobs() {
  if (getActiveSearch().hasQuery) return;
  const grid = document.getElementById("recommendedJobsGrid");
  if (!grid) {
    return;
  }
  grid.querySelectorAll(".job-card").forEach((card, index) => {
    if (index >= 3) {
      card.classList.add("hidden-reco");
    }
  });
  const viewBtn = document.getElementById("recoViewAllBtn");
  const returnBtn = document.getElementById("recoReturnBtn");
  const hasMore = grid.querySelectorAll(".job-card").length > 3;
  if (viewBtn) viewBtn.classList.toggle("is-hidden", !hasMore);
  if (returnBtn) returnBtn.classList.add("is-hidden");
}
