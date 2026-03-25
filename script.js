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
let cachedJobs = null;
let cachedJobsFetchedAt = 0;
let seekerSearchState = { keywords: "", location: "" };
let employerApplicantsSearchTimer = null;

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
      if (visible) loadAndShowNotifications("seeker").catch(() => {});
      const chat = document.getElementById("seekerChatModal");
      const appId = chat ? String(chat.getAttribute("data-application-id") || "") : "";
      if (appId && chat && chat.style.display === "flex") {
        loadSeekerChatThread(appId).catch(() => {});
        loadSeekerConversationsFromBackend().catch(() => {});
      }
    } else if (role === "employer") {
      const page = document.getElementById("employerNotifications");
      const visible = page && page.style.display !== "none";
      if (visible) loadAndShowNotifications("employer").catch(() => {});
      const applicants = document.getElementById("employerApplicants");
      const appsVisible = applicants && applicants.style.display !== "none";
      if (appsVisible) loadEmployerApplicantsFromBackend().catch(() => {});
    }
  }, 250);
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
    if (type === "jobs_updated") {
      scheduleLiveRefresh();
    }
    if (type === "jobs_updated" || type === "messages_updated" || type === "applications_updated" || type === "profile_updated") {
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
  const badgeEl = document.getElementById("quickViewBadge");
  const titleEl = document.getElementById("quickViewTitle");
  const companyEl = document.getElementById("quickViewCompany");
  const salaryEl = document.getElementById("quickViewSalary");
  const tagsEl = document.getElementById("quickViewTags");

  if (badgeEl) badgeEl.textContent = job.badge || "Saved";
  if (titleEl) titleEl.textContent = job.title || "Saved Job";
  if (companyEl) companyEl.textContent = job.companyLine || "Company • Location";
  if (salaryEl) salaryEl.textContent = job.salary || "Salary negotiable";
  if (tagsEl) {
    tagsEl.innerHTML = "";
    (job.tags || []).slice(0, 6).forEach((t) => {
      const pill = document.createElement("span");
      pill.textContent = t;
      tagsEl.appendChild(pill);
    });
  }

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

function formatJobCompany(job) {
  const company = job.company || "Company";
  const location = job.location ? ` - ${job.location}` : "";
  return `${company}${location}`;
}

function renderSeekerJobs(jobs, { emptyText = "" } = {}) {
  const grid = document.getElementById("recommendedJobsGrid");
  if (!grid) return;
  const empty = document.getElementById("recommendedJobsEmpty");
  grid.innerHTML = "";
  const list = Array.isArray(jobs) ? jobs : [];
  if (empty) {
    empty.style.display = list.length ? "none" : "block";
    if (!list.length) {
      empty.textContent = emptyText || "No jobs posted yet.";
    }
  }
  list.forEach((job, index) => {
    const card = document.createElement("article");
    card.className = "job-card" + (index >= 3 ? " hidden-reco" : "");
    card.setAttribute("data-job-id", job.id);

    const requirements = (job.requirements || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^[\-\*\u2022]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 2);

    const tags = requirements.length ? requirements : ["Opportunity", "New"];
    const salary = job.salary || "Salary negotiable";

    card.innerHTML = `
      <div class="job-header">
        <span class="job-badge">New</span>
        <button class="icon-btn small" type="button" data-save-job="1" aria-label="Save job"><i class="fa-regular fa-bookmark"></i></button>
      </div>
      <h3></h3>
      <p></p>
      <div class="tag-row"></div>
      <div class="job-footer">
        <strong></strong>
        <button class="pill-btn" type="button" onclick="openApplyForm(this)">Apply</button>
      </div>
    `;

    const titleEl = card.querySelector("h3");
    const companyEl = card.querySelector("p");
    const tagRow = card.querySelector(".tag-row");
    const salaryEl = card.querySelector(".job-footer strong");
    if (titleEl) titleEl.textContent = job.title || "Job";
    if (companyEl) companyEl.textContent = formatJobCompany(job);
    if (salaryEl) salaryEl.textContent = salary;
    if (tagRow) {
      tagRow.innerHTML = "";
      tags.forEach((t) => {
        const span = document.createElement("span");
        span.textContent = t;
        tagRow.appendChild(span);
      });
    }

    grid.appendChild(card);
  });

  // Update bookmark state after rendering.
  syncBookmarkButtons(grid);

  const viewBtn = document.getElementById("recoViewAllBtn");
  const returnBtn = document.getElementById("recoReturnBtn");
  const hasMore = list.length > 3;
  if (viewBtn) viewBtn.classList.toggle("is-hidden", !hasMore);
  if (returnBtn) returnBtn.classList.add("is-hidden");
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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
  const { keywords, location, hasQuery } = getActiveSearch();
  if (!hasQuery) {
    renderSeekerJobs(jobs);
    return;
  }

  const results = filterJobs(jobs, { keywords, location });
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
  const jobs = await fetchJobs();
  if (!jobs) return cachedJobs;
  cachedJobs = jobs;
  cachedJobsFetchedAt = Date.now();
  return jobs;
}

function setupSeekerSearch() {
  const keywordsEl = document.getElementById("seekerSearchKeywords");
  const locationEl = document.getElementById("seekerSearchLocation");
  const btn = document.getElementById("seekerSearchBtn");
  if (!keywordsEl || !locationEl || !btn) return;

  const run = async () => {
    const jobs = await getJobsSnapshot();
    if (!Array.isArray(jobs)) {
      alert("Backend is not reachable yet. Start the server (node server.js) and try again.");
      return;
    }

    const keywords = String(keywordsEl.value || "");
    const location = String(locationEl.value || "");
    seekerSearchState = { keywords, location };
    renderSeekerJobsWithSearch(jobs);
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

function renderEmployerPostedJobs(jobs) {
  clearEmployerPostedJobSamples();
  const container = ensureEmployerPostedContainer();
  if (!container) return;
  container.innerHTML = "";

  const kpiCards = document.querySelectorAll("#employeePage .kpi-card .kpi-value");
  if (kpiCards.length >= 2) {
    kpiCards[0].textContent = String(jobs.length);
    const totalApplicants = jobs.reduce((sum, j) => sum + (Number(j.applicantCount) || 0), 0);
    kpiCards[1].textContent = String(totalApplicants);
  }

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state-box";
    empty.style.marginTop = "12px";
    empty.textContent = "No job postings yet. Create one from Post Job.";
    container.appendChild(empty);
    return;
  }

  jobs.forEach((job) => {
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

    container.appendChild(card);
    container.appendChild(panel);
  });

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
              const detailsBtn = panel.querySelector(
                `.posted-applicants-row[data-application-id="${pendingAppId}"] button[data-action="details"]`,
              );
              if (detailsBtn) detailsBtn.click();
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
  panel.innerHTML = "<div style='padding:14px;color:#bbb;'>Loading applicants...</div>";
  try {
    const data = await apiRequest(`/api/applications?jobId=${encodeURIComponent(jobId)}`, { method: "GET", auth: true });
    const apps = data && data.ok && Array.isArray(data.applications) ? data.applications : [];
    if (!apps.length) {
      panel.innerHTML = "<div style='padding:14px;color:#bbb;'>No applicants yet.</div>";
      return;
    }
    panel.innerHTML = "";
    apps.forEach((a) => {
      const row = document.createElement("div");
      row.className = "posted-applicants-row";
      if (a && a.id) row.setAttribute("data-application-id", String(a.id));
      const name = a.seekerName || "Seeker";
      const email = a.seekerEmail || "";
      const status = String(a.status || "applied").toLowerCase();
      const statusClass = status === "rejected" ? "rejected" : status === "passed" ? "shortlist" : status === "pending" ? "interview" : "new";
      const statusLabel = status === "rejected" ? "Rejected" : status === "passed" ? "Passed" : status === "pending" ? "Pending" : "Applied";
      row.innerHTML = `
        <div>
          <h4></h4>
          <p></p>
        </div>
        <div class="posted-applicants-actions">
          <span class="status-tag ${statusClass}">${statusLabel}</span>
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
            <p class="detail-label">LinkedIn</p>
            <p class="detail-value" data-linkedin>—</p>
          </div>
        </div>
        <div class="detail-actions">
          <button class="detail-btn primary" type="button" data-action="resume"><i class="fa-regular fa-file-lines"></i> Resume</button>
          <button class="detail-btn ghost" type="button" data-action="profile"><i class="fa-regular fa-address-card"></i> Profile</button>
        </div>
        <p class="detail-note" data-note>Use the message box below to communicate with this applicant.</p>
        <div class="detail-message-box">
          <div class="detail-message">
            <p class="detail-label">Conversation</p>
            <div class="chat-thread" data-thread></div>
          </div>
          <div class="detail-chat">
            <input type="text" data-input placeholder="Write a message...">
            <button class="employer-text-btn" type="button" data-action="send">Send</button>
          </div>
        </div>
      `;

      const detailsBtn = row.querySelector('button[data-action="details"]');
      if (detailsBtn) {
        detailsBtn.addEventListener("click", async () => {
          const willShow = !detail.classList.contains("show");
          detail.classList.toggle("show", willShow);
          detailsBtn.textContent = willShow ? "Hide" : "Details";
          if (!willShow) return;

          // Load profile (best-effort) for location/linkedin + resume
          let loadedProfile = null;
          try {
            if (a.seekerId) {
              const u = await apiRequest(`/api/users/${encodeURIComponent(a.seekerId)}`, { method: "GET", auth: true });
              loadedProfile = (u && u.ok && u.profile) ? u.profile : null;
              const profile = loadedProfile || {};
              const contact = profile.contact && typeof profile.contact === "object" ? profile.contact : {};
              const loc = detail.querySelector("[data-location]");
              const ln = detail.querySelector("[data-linkedin]");
              if (loc) loc.textContent = contact.location || profile.location || "—";
              if (ln) ln.textContent = contact.linkedin || "—";
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
              const profile = loadedProfile || {};
              const resume = profile.resume && typeof profile.resume === "object" ? profile.resume : null;
              const dataUrl = resume && typeof resume.dataUrl === "string" ? resume.dataUrl : "";
              const fileName = resume && typeof resume.name === "string" ? resume.name : "";
              if (!dataUrl) {
                alert("No resume uploaded yet for this seeker.");
                return;
              }
              const w = window.open();
              if (!w) {
                alert("Popup blocked. Allow popups to view the resume.");
                return;
              }
              w.document.title = fileName || "Resume";
              w.location.href = dataUrl;
            };
          }

          const profileBtn = detail.querySelector('button[data-action="profile"]');
          if (profileBtn) {
            profileBtn.onclick = () => {
              if (!a.seekerId) {
                alert("Missing seeker id for this application.");
                return;
              }
              const url = `Seeker_profile.html?mode=review&readonly=1&userId=${encodeURIComponent(a.seekerId)}`;
              const w = window.open(url, "_blank");
              if (!w) alert("Popup blocked. Allow popups to review the profile.");
            };
          }

          const thread = detail.querySelector("[data-thread]");
          const renderThread = (msgs) => {
            if (!thread) return;
            thread.innerHTML = "";
            if (!msgs.length) {
              const empty = document.createElement("div");
              empty.style.color = "#9aa4b2";
              empty.style.fontSize = "12px";
              empty.textContent = "No messages yet.";
              thread.appendChild(empty);
              return;
            }
            msgs.forEach((msg) => {
              const bubble = document.createElement("div");
              const fromRole = String(msg.fromRole || "").toLowerCase();
              bubble.className = "chat-bubble " + (fromRole === "seeker" ? "seeker" : "employer");
              bubble.textContent = String(msg.text || "");
              thread.appendChild(bubble);
            });
            thread.scrollTop = thread.scrollHeight;
          };

          try {
            const m = await apiRequest(`/api/messages?applicationId=${encodeURIComponent(a.id)}`, { method: "GET", auth: true });
            const msgs = (m && m.ok && Array.isArray(m.messages)) ? m.messages : [];
            renderThread(msgs);
          } catch (err) {
            if (thread) {
              thread.innerHTML = `<div style='color:#ffb4b4;font-size:12px;'>${err?.message || "Failed to load messages."}</div>`;
            }
          }

          const sendBtn = detail.querySelector('button[data-action="send"]');
          const input = detail.querySelector("input[data-input]");
          const send = async () => {
            const text = (input?.value || "").trim();
            if (!text) return;
            try {
              await apiRequest("/api/messages", { method: "POST", auth: true, body: { applicationId: a.id, text } });
              if (input) input.value = "";
              const m2 = await apiRequest(`/api/messages?applicationId=${encodeURIComponent(a.id)}`, { method: "GET", auth: true });
              const msgs2 = (m2 && m2.ok && Array.isArray(m2.messages)) ? m2.messages : [];
              renderThread(msgs2);
              emitSyncEvent("messages_updated", { applicationId: a.id, jobId });
            } catch (err) {
              alert(err?.message || "Failed to send message.");
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
          try {
            await apiRequest(`/api/applications/${encodeURIComponent(a.id)}`, {
              method: "PATCH",
              auth: true,
              body: { status: btn.getAttribute("data-status") },
            });
            await loadApplicantsForJob(jobId, panel);
            await loadSeekerHistoryFromBackend();
            emitSyncEvent("applications_updated", { applicationId: a.id, jobId });
          } catch (err) {
            alert(err?.message || "Failed to update status.");
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

async function loadAndShowNotifications(role) {
  const userId = localStorage.getItem(STORAGE_CURRENT_USER_KEY) || "";
  const list = getNoticeListEl(role);
  if (list) list.innerHTML = "<div class='empty-state-card'>Loading notifications...</div>";
  const notes = await fetchNotifications();
  renderNotificationsList(role, notes);
  if (userId) setNotificationsLastSeen(role, userId);
}

async function loadSeekerHistoryFromBackend() {
  if (!getLoggedIn() || getLoggedInRole() !== "seeker") return;
  let data;
  try {
    data = await apiRequest("/api/applications?mine=1", { method: "GET", auth: true });
  } catch {
    return;
  }
  const apps = data && data.ok && Array.isArray(data.applications) ? data.applications : [];
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
      item.className = "status-item";
      item.innerHTML = `
        <span class="status-dot ${status}"></span>
        <div>
          <h4></h4>
          <p></p>
        </div>
      `;
      const h4 = item.querySelector("h4");
      const p = item.querySelector("p");
      if (h4) h4.textContent = a.jobTitle || "Application";
      const company = a.company ? `${a.company} - ` : "";
      if (p) p.textContent = `${company}${formatRelative(a.createdAt)}`;
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

async function loadEmployerApplicantsFromBackend() {
  const root = document.getElementById("employerApplicants");
  if (!root) return;

  if (!getLoggedIn() || getLoggedInRole() !== "employer") {
    root.querySelectorAll(".status-value").forEach((el) => (el.textContent = "0"));
    root.querySelectorAll(".status-panel .status-list").forEach((list) => {
      list.innerHTML = `<div class="empty-state-card">Please log in as an employer to view applicants.</div>`;
    });
    return;
  }
  if (!hasBackendToken()) {
    root.querySelectorAll(".status-panel .status-list").forEach((list) => {
      list.innerHTML = `<div class="empty-state-card">Session expired. Please log in again to view applicants.</div>`;
    });
    return;
  }

  const searchRaw = (document.getElementById("employerApplicantsSearch")?.value || "").trim().toLowerCase();

  // Loading state
  root.querySelectorAll(".status-panel .status-list").forEach((list) => {
    list.innerHTML = "<div style='padding:10px 4px;color:#9aa4b2;'>Loading...</div>";
  });

  try {
    const data = await apiRequest("/api/applications?mine=1", { method: "GET", auth: true });
    const apps = data && data.ok && Array.isArray(data.applications) ? data.applications : [];

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
        const name = String(a.seekerName || "").trim() || String(a.seekerEmail || "").trim() || "Seeker";
        const email = String(a.seekerEmail || "").trim();
        const jobTitle = String(a.jobTitle || "Application").trim();
        const tagClass = current === "rejected" ? "rejected" : current === "passed" ? "shortlist" : "interview";
        const tagLabel = statusLabel(current);
        const when = formatRelative(a.createdAt);

        const item = document.createElement("div");
        item.className = "status-item";
        item.innerHTML = `
          <span class="status-dot ${status}"></span>
          <div class="status-item-content">
            <div class="status-item-top">
              <div class="status-item-main">
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
  } catch (err) {
    root.querySelectorAll(".status-panel .status-list").forEach((list) => {
      list.innerHTML = `<div class="empty-state-card">${err?.message || "Failed to load applicants."}</div>`;
    });
  }
}

function setupEmployerApplicantsSearch() {
  const input = document.getElementById("employerApplicantsSearch");
  if (!input) return;
  const run = () => {
    const root = document.getElementById("employerApplicants");
    const visible = root && root.style.display !== "none";
    if (!visible) return;
    if (!getLoggedIn() || getLoggedInRole() !== "employer") return;
    if (employerApplicantsSearchTimer) clearTimeout(employerApplicantsSearchTimer);
    employerApplicantsSearchTimer = setTimeout(() => {
      loadEmployerApplicantsFromBackend().catch(() => {});
    }, 150);
  };
  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e && e.key === "Enter") {
      e.preventDefault();
      run();
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
  const salaryEl = document.getElementById("addJobSalary");
  const descEl = document.getElementById("addJobDescription");
  const reqEl = document.getElementById("addJobRequirements");

  const title = (titleEl?.value || "").trim();
  const location = (locationEl?.value || "").trim();
  const salary = (salaryEl?.value || "").trim();
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

  try {
    await apiRequest("/api/jobs", {
      method: "POST",
      auth: true,
      body: { title, location, salary, description, requirements },
    });
    if (titleEl) titleEl.value = "";
    if (locationEl) locationEl.value = "";
    if (salaryEl) salaryEl.value = "";
    if (descEl) descEl.value = "";
    if (reqEl) reqEl.value = "";
    closeAddJob();
    await refreshDataViews();
    emitSyncEvent("jobs_updated", { jobTitle: title });
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
  const draft = {
    title: (document.getElementById("addJobTitle")?.value || "").trim(),
    location: (document.getElementById("addJobLocation")?.value || "").trim(),
    salary: (document.getElementById("addJobSalary")?.value || "").trim(),
    description: (document.getElementById("addJobDescription")?.value || "").trim(),
    requirements: (document.getElementById("addJobRequirements")?.value || "").trim(),
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem("jobDraft", JSON.stringify(draft));
  alert("Draft saved on this device.");
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
  setVal("addJobSalary", draft.salary || "");
  setVal("addJobDescription", draft.description || "");
  setVal("addJobRequirements", draft.requirements || "");
}

async function refreshDataViews() {
  const jobs = await fetchJobs();
  if (!jobs) return;

  cachedJobs = jobs;
  cachedJobsFetchedAt = Date.now();
  renderSeekerJobsWithSearch(jobs);

  if (getLoggedIn() && getLoggedInRole() === "employer") {
    const myId = localStorage.getItem(STORAGE_CURRENT_USER_KEY);
    const mine = myId ? jobs.filter((j) => j.employerId === myId) : jobs;
    renderEmployerPostedJobs(mine);
  }

  if (getLoggedIn() && getLoggedInRole() === "seeker") {
    loadSeekerHistoryFromBackend();
  }
  if (getLoggedIn() && getLoggedInRole() === "employer") {
    loadEmployerHistoryFromBackend();
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
  localStorage.setItem("currentUserEmail", user.email || "");
  localStorage.setItem("currentUserName", user.name || user.company || "");
}

function clearCurrentUser() {
  localStorage.removeItem(STORAGE_CURRENT_USER_KEY);
  localStorage.removeItem("currentUserEmail");
  localStorage.removeItem("currentUserName");
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
}

function openNotifications() {
  const loggedIn = localStorage.getItem("isLoggedIn") === "true";
  const role = localStorage.getItem("userRole");
  if (!loggedIn) {
    openLogin();
    return;
  }
  if (role === "employer") {
    showEmployerNotifications();
  } else {
    showSeekerNotifications();
  }
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
    document.getElementById("roleToggle").innerText = "Seeker Site";
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
  document.getElementById("roleToggle").innerText = "Seeker Site";
  setActiveNav("homeLink");
  showSeekerHome();
  window.scrollTo(0, 0);
  updateAuthUI();
}

function setupPasswordToggles() {
  document.querySelectorAll(".toggle-password").forEach((btn) => {
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
document.addEventListener("DOMContentLoaded", () => {
  setupSyncBus();
  setupServerEvents();
  setupSeekerSearch();
  setupEmployerApplicantsSearch();
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

  revalidateBackendSession();
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
    setupHistoryViewButtons();
    setupHistoryStatusButtons();
    return;
  }
  if (target === "employer" && loggedIn && role === "employer") {
    localStorage.removeItem("postLoginTarget");
    showEmployerDashboard();
    setupPasswordToggles();
    setupHistoryViewButtons();
    setupHistoryStatusButtons();
    return;
  }
  showHome();
  setupPasswordToggles();
  setupHistoryViewButtons();
  setupHistoryStatusButtons();
  // Render jobs from backend (if running) and wire add-job buttons.
  refreshDataViews();
  renderSavedJobs();
  syncBookmarkButtons(document);
  const publishBtn = document.getElementById("publishJobBtn");
  if (publishBtn) {
    publishBtn.addEventListener("click", publishJobFromForm);
  }
  const draftBtn = document.getElementById("saveJobDraftBtn");
  if (draftBtn) {
    draftBtn.addEventListener("click", saveDraftFromForm);
  }
  loadDraftToForm();
  const homePage = document.getElementById("homePage");
  if (homePage && homePage.style.display !== "none") {
    const anyVisible = Array.from(document.querySelectorAll(".seeker-view"))
      .some((view) => view.style.display === "block" || view.style.display === "flex");
    if (!anyVisible) {
      showSeekerHome();
    }
  }
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
    document.getElementById("roleToggle").innerText = "Employer Site";
    setActiveNav("roleToggle");
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
    document.getElementById("roleToggle").innerText = "Employer Site";
    setActiveNav("roleToggle");
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

    list.innerHTML = "";
    apps.forEach((a) => {
      const company = String(a.company || "Employer").trim() || "Employer";
      const initials = company.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
      const status = String(a.status || "applied").toLowerCase();
      const statusClass = status === "rejected" ? "rejected" : status === "passed" ? "shortlist" : status === "pending" ? "interview" : "new";
      const statusLabel = status === "rejected" ? "Closed" : status === "passed" ? "Passed" : status === "pending" ? "Pending" : "Applied";
      const preview = String(a.message || "").trim() || "No messages yet. Say hi to start the conversation.";

      const card = document.createElement("div");
      card.className = "applicant-card wide";
      card.innerHTML = `
        <div class="applicant-head">
          <div class="applicant-avatar">${initials || "E"}</div>
          <div>
            <h3>${company}</h3>
            <p>Applied for <span>${String(a.jobTitle || "a role")}</span></p>
            <div class="applicant-meta">
              <span class="status-tag ${statusClass}">${statusLabel}</span>
              <span>${formatRelative(a.createdAt)}</span>
            </div>
          </div>
        </div>
        <div class="applicant-tags">
          <span class="tag-pill">${String(a.jobTitle || "Role")}</span>
        </div>
        <p class="applicant-note">${preview}</p>
        <div class="applicant-actions">
          <button class="applicant-btn primary" type="button">Open Chat</button>
        </div>
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
    loadAndShowNotifications("seeker").catch(() => renderNotificationsList("seeker", []));
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
  document.getElementById("roleToggle").innerText = "Employer Site";
  setActiveNav("homeLink");
  window.scrollTo(0, 0);
  updateAuthUI();
  // Ensure the overview always reflects the latest backend data (posted jobs, KPIs, etc.).
  refreshDataViews();
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
  refreshDataViews();
}

function showEmployerHistory() {
  document.querySelector(".employer-shell").style.display = "none";
  document.getElementById("employerHistory").style.display = "flex";
  document.getElementById("employerAddJob").style.display = "none";
  setDisplay("employerApplicants", "none");
  document.getElementById("employerNotifications").style.display = "none";
  setEmployerNavActive(2);
  window.scrollTo(0, 0);
  loadEmployerHistoryFromBackend();
}

function showEmployerApplicants() {
  document.querySelector(".employer-shell").style.display = "none";
  document.getElementById("employerHistory").style.display = "none";
  document.getElementById("employerAddJob").style.display = "none";
  setDisplay("employerApplicants", "flex");
  document.getElementById("employerNotifications").style.display = "none";
  setEmployerNavActive(1);
  window.scrollTo(0, 0);
  loadEmployerApplicantsFromBackend().catch(() => {});
}

function showEmployerNotifications() {
  document.querySelector(".employer-shell").style.display = "none";
  document.getElementById("employerHistory").style.display = "none";
  document.getElementById("employerAddJob").style.display = "none";
  setDisplay("employerApplicants", "none");
  document.getElementById("employerNotifications").style.display = "flex";
  window.scrollTo(0, 0);
  if (getLoggedIn() && getLoggedInRole() === "employer") {
    loadAndShowNotifications("employer").catch(() => renderNotificationsList("employer", []));
  } else {
    renderNotificationsList("employer", []);
  }
}

// Modals
function openSignup(type) {
  isEmployer = (type === "employer");
  document.getElementById("roleToggle").innerText = isEmployer ? "Employer Site" : "Seeker Site";
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
    let title = "Job Seeker Login";
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
  } catch (err) {
    alert(err?.message || "Login failed.");
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
    alert("Invalid credentials. Try seeker@test.com / seeker123 or employer@test.com / employer123.");
    return;
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

  try {
    const backend = await tryBackendSignup({ role, email, password, name, company });
    if (backend) {
      setAuth(role);
      setCurrentUser(backend.user);
      closeSignup(type);
      if (role === "seeker") {
        window.location.href = "Seeker_profile.html";
      } else {
        window.location.href = "employer_profile.html";
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
    window.location.href = "Seeker_profile.html";
  } else {
    window.location.href = "employer_profile.html";
  }
  updateAuthUI();
  syncBookmarkButtons(document);
}

function getGoogleClientId() {
  const meta = document.querySelector('meta[name="google-client-id"]');
  const metaValue = meta && typeof meta.content === "string" ? meta.content.trim() : "";
  const globalValue =
    typeof window.GOOGLE_CLIENT_ID === "string" ? window.GOOGLE_CLIENT_ID.trim() : "";
  return metaValue || globalValue || "";
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
  if (getGoogleClientId()) return;
  const proto = window.location && window.location.protocol;
  const runningServer = proto === "http:" || proto === "https:";
  if (!runningServer) return;

  try {
    const data = await apiRequest("/api/config", { method: "GET" });
    const clientId = data && data.ok ? String(data.googleClientId || "").trim() : "";
    if (!clientId) return;
    window.GOOGLE_CLIENT_ID = clientId;
    const meta = document.querySelector('meta[name="google-client-id"]');
    if (meta) meta.content = clientId;
  } catch {
    // ignore
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

  const finalizeLogin = (user, token) => {
    if (token) localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, token);
    isEmployer = normalizedRole === "employer";
    setAuth(normalizedRole);
    setCurrentUser(user);
    closeLogin();
    closeSignup(normalizedRole);

    if (mode === "signup") {
      window.location.href =
        normalizedRole === "seeker" ? "Seeker_profile.html" : "employer_profile.html";
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

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken();
  } catch (err) {
    alert(err?.message || "Google sign-in could not start.");
    return;
  }

  if (runningServer) {
    try {
      const data = await apiRequest("/api/auth/google", {
        method: "POST",
        body: { role: normalizedRole, accessToken },
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
    alert(err?.message || "Google sign-in failed.");
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
    user = createMockUser({
      role: normalizedRole,
      email,
      name: normalizedRole === "seeker" ? String(profile?.name || "").trim() : "",
      company: normalizedRole === "employer" ? "Google Employer" : "",
      provider: "google",
    });
    users.push(user);
    saveStoredUsers(users);
  }

  finalizeLogin(user, "");
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
    window.location.href = "employer_profile.html";
    return;
  }
  if (role === "seeker") {
    window.location.href = "Seeker_profile.html";
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
  window.location.href = "employer_profile.html";
}

function logoutAndReturn() {
  closeUserMenu();
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
    document.getElementById("roleToggle").innerText = "Employer Site";
    setActiveNav("roleToggle");
    updateAuthUI();
    return;
  }
  showHome();
}

// Contact dropdown toggle
function toggleDropdown() {
  const dropdown = document.getElementById("contactDropdown");
  dropdown.classList.toggle("active");
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
}

function closeFeedback() {
  document.getElementById("feedbackModal").style.display = "none";
}

function openChat() {
  document.getElementById("chatModal").style.display = "flex";
  document.getElementById("contactDropdown").classList.remove("active");
  setActiveNav("contactLink");
}

function closeChat() {
  document.getElementById("chatModal").style.display = "none";
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
    if (!msgs.length) {
      thread.innerHTML = "<div style='color:#9aa4b2;font-size:12px;'>No messages yet. Send the first message below.</div>";
      return;
    }
    msgs.forEach((m) => {
      const bubble = document.createElement("div");
      const fromRole = String(m.fromRole || "").toLowerCase();
      bubble.className = "chat-bubble " + (fromRole === "seeker" ? "seeker" : "employer");
      bubble.textContent = String(m.text || "");
      thread.appendChild(bubble);
    });
    thread.scrollTop = thread.scrollHeight;
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
  const card = button.closest(".featured-card, .job-card");
  const jobId = card ? card.getAttribute("data-job-id") : "";
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
  if (jobId) {
    modal.setAttribute("data-job-id", jobId);
  } else {
    modal.removeAttribute("data-job-id");
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
  if (modal) {
    modal.style.display = "none";
  }
  if (!getLoggedIn() || getLoggedInRole() !== "seeker") {
    alert("Please log in as a seeker to apply.");
    return;
  }
  if (!hasBackendToken()) {
    alert("Please log in again to apply.");
    handleNotAuthenticated("seeker");
    return;
  }
  const jobId = modal ? modal.getAttribute("data-job-id") : "";
  if (!jobId) {
    alert("Missing job reference. Please try again from a job card.");
    return;
  }
  const message = (document.getElementById("applyMessage")?.value || "").trim();
  try {
    await apiRequest("/api/applications", { method: "POST", auth: true, body: { jobId, message } });
    const msgEl = document.getElementById("applyMessage");
    if (msgEl) msgEl.value = "";
    await refreshDataViews();
    emitSyncEvent("applications_updated", { jobId });
    alert("Application submitted!");
  } catch (err) {
    if (err && err.status === 401) {
      alert("Session expired. Please log in again.");
      handleNotAuthenticated("seeker");
      return;
    }
    alert(err?.message || "Failed to submit application.");
  }
}

function sendSeekerMessage() {
  const thread = document.getElementById("seekerChatThread");
  const input = document.getElementById("seekerChatMessage");
  const fileInput = document.getElementById("seekerChatFile");
  if (!thread || !input || !fileInput) {
    return;
  }
  const text = input.value.trim();
  const file = fileInput.files && fileInput.files[0];
  if (!text && !file) {
    return;
  }
  const modal = document.getElementById("seekerChatModal");
  const applicationId = modal ? (modal.getAttribute("data-application-id") || "") : "";

  const sendText = async () => {
    if (!text) return;
    // If connected to backend, persist the message so employer can see it.
    if (applicationId && hasBackendToken()) {
      try {
        await apiRequest("/api/messages", { method: "POST", auth: true, body: { applicationId, text } });
        input.value = "";
        await loadSeekerChatThread(applicationId);
        loadSeekerConversationsFromBackend();
        emitSyncEvent("messages_updated", { applicationId });
        return;
      } catch (err) {
        alert(err?.message || "Failed to send message.");
        return;
      }
    }

    // Fallback (file:// demo)
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble seeker";
    bubble.textContent = text;
    thread.appendChild(bubble);
    input.value = "";
    thread.scrollTop = thread.scrollHeight;
  };

  sendText();
  if (file) {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble seeker";
    bubble.textContent = `Sent file: ${file.name}`;
    thread.appendChild(bubble);
    fileInput.value = "";
  }
  thread.scrollTop = thread.scrollHeight;
}

function openQuickView(button) {
  const card = button.closest(".job-card");
  const modal = document.getElementById("quickViewModal");
  if (!card || !modal) {
    return;
  }
  const badge = card.querySelector(".job-badge");
  const title = card.querySelector("h3");
  const company = card.querySelector("p");
  const salary = card.querySelector(".job-footer strong");
  const tags = card.querySelectorAll(".tag-row span");

  const badgeEl = document.getElementById("quickViewBadge");
  const titleEl = document.getElementById("quickViewTitle");
  const companyEl = document.getElementById("quickViewCompany");
  const salaryEl = document.getElementById("quickViewSalary");
  const tagsEl = document.getElementById("quickViewTags");

  if (badgeEl) badgeEl.textContent = badge ? badge.textContent : "Role";
  if (titleEl) titleEl.textContent = title ? title.textContent : "Role Overview";
  if (companyEl) companyEl.textContent = company ? company.textContent : "Company • Location";
  if (salaryEl) salaryEl.textContent = salary ? salary.textContent : "Compensation unavailable";
  if (tagsEl) {
    tagsEl.innerHTML = "";
    tags.forEach((tag) => {
      const pill = document.createElement("span");
      pill.textContent = tag.textContent;
      tagsEl.appendChild(pill);
    });
  }

  modal.style.display = "flex";
}

function closeQuickView() {
  const modal = document.getElementById("quickViewModal");
  if (modal) {
    modal.style.display = "none";
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
