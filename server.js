const http = require("http");
const https = require("https");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const ROOT_DIR = __dirname;

function resolveDataDir() {
  const raw = String(process.env.SMART_HUNT_DATA_DIR || process.env.DATA_DIR || "").trim();
  if (!raw) return path.join(ROOT_DIR, "server-data");
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

const DATA_DIR = resolveDataDir();
// Previous versions stored the whole DB in a JSON file. This version stores it in SQLite.
// To keep the rest of the server code simple, we store the whole JSON blob in a single SQLite row.
const LEGACY_DB_JSON_PATH = path.join(DATA_DIR, "db.json");
const SQLITE_PATH = path.join(DATA_DIR, "db.sqlite");
const SQLITE_KV_KEY = "smart_hunt_db_v1";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Very small "realtime" layer for live UI updates (no polling).
// Clients connect to GET /api/events using Server-Sent Events (SSE).
const sseClients = new Set();

function writeSse(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch {
    // ignore (client may have disconnected)
  }
}

function broadcastSse(type, payload = {}) {
  const msg = { type: String(type || "event"), ts: Date.now(), payload };
  for (const res of sseClients) {
    writeSse(res, msg);
  }
}

setInterval(() => {
  // Keep-alive pings so proxies don't close idle connections.
  for (const res of sseClients) {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // ignore
    }
  }
}, 25000).unref();

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function ensureDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  const db = new DatabaseSync(SQLITE_PATH);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  } catch {
    // ignore (best-effort tuning)
  }

  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(SQLITE_KV_KEY);
  if (!row || typeof row.value !== "string") {
    let seed = null;
    try {
      const rawLegacy = await fsp.readFile(LEGACY_DB_JSON_PATH, "utf8");
      seed = safeJsonParse(rawLegacy);
    } catch {
      // ignore (no legacy DB)
    }

    if (!seed || typeof seed !== "object") {
      seed = { users: [], sessions: [], jobs: [], applications: [] };
    }

    const seedJson = JSON.stringify(seed, null, 2);
    db.prepare("INSERT OR IGNORE INTO kv(key, value) VALUES(?, ?)").run(SQLITE_KV_KEY, seedJson);
  }
  db.close();
}

async function readDb() {
  await ensureDb();
  const db = new DatabaseSync(SQLITE_PATH);
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(SQLITE_KV_KEY);
  db.close();

  const parsed = safeJsonParse(row && typeof row.value === "string" ? row.value : "");
  if (!parsed || typeof parsed !== "object") {
    return { users: [], sessions: [], jobs: [], applications: [] };
  }
  parsed.users = Array.isArray(parsed.users) ? parsed.users : [];
  parsed.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  parsed.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  parsed.applications = Array.isArray(parsed.applications) ? parsed.applications : [];
  return parsed;
}

async function writeDb(db) {
  await ensureDb();
  const payload = JSON.stringify(db, null, 2);
  const sqlDb = new DatabaseSync(SQLITE_PATH);
  sqlDb
    .prepare(
      "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    )
    .run(SQLITE_KV_KEY, payload);
  sqlDb.close();
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function text(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function addCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendNotFound(res) {
  text(res, 404, "Not found");
}

function normalizeRole(role) {
  return role === "employer" ? "employer" : "seeker";
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const derived = crypto.scryptSync(password, salt, 64);
  return derived.toString("hex");
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name || "",
    company: user.company || "",
    createdAt: user.createdAt,
  };
}

async function fetchJson(urlString) {
  const url = new URL(urlString);
  const lib = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const parsed = safeJsonParse(body);
          resolve({ statusCode: res.statusCode || 0, body: parsed, raw: body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchJsonWithHeaders(urlString, headers = {}) {
  const url = new URL(urlString);
  const lib = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const parsed = safeJsonParse(body);
          resolve({ statusCode: res.statusCode || 0, body: parsed, raw: body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function verifyGoogleIdToken(idToken) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();

  // We use Google's tokeninfo endpoint to validate the token server-side.
  const { statusCode, body, raw } = await fetchJson(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  );

  if (statusCode !== 200 || !body || typeof body !== "object") {
    const message =
      (body && (body.error_description || body.error)) ||
      (raw ? String(raw).slice(0, 200) : "") ||
      "Invalid Google token.";
    const err = new Error(message);
    err.status = 401;
    throw err;
  }

  const aud = String(body.aud || "");
  if (clientId && aud !== clientId) {
    const err = new Error("Google token audience mismatch.");
    err.status = 401;
    throw err;
  }

  const email = String(body.email || "").trim().toLowerCase();
  const emailVerified = String(body.email_verified || "").toLowerCase() === "true";
  if (!email || !emailVerified) {
    const err = new Error("Google account email is missing or not verified.");
    err.status = 401;
    throw err;
  }

  return {
    email,
    sub: String(body.sub || ""),
    name: String(body.name || body.given_name || "").trim(),
    picture: String(body.picture || "").trim(),
    hd: String(body.hd || "").trim(),
  };
}

async function verifyGoogleAccessToken(accessToken) {
  const { statusCode, body, raw } = await fetchJsonWithHeaders(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      Authorization: `Bearer ${accessToken}`,
    },
  );

  if (statusCode !== 200 || !body || typeof body !== "object") {
    const message =
      (body && (body.error_description || body.error)) ||
      (raw ? String(raw).slice(0, 200) : "") ||
      "Invalid Google access token.";
    const err = new Error(message);
    err.status = 401;
    throw err;
  }

  const email = String(body.email || "").trim().toLowerCase();
  const emailVerified = Boolean(body.email_verified);
  if (!email || !emailVerified) {
    const err = new Error("Google account email is missing or not verified.");
    err.status = 401;
    throw err;
  }

  return {
    email,
    sub: String(body.sub || body.id || "").trim(),
    name: String(body.name || "").trim(),
    picture: String(body.picture || "").trim(),
    hd: "",
  };
}

function canAccessApplication(user, application) {
  if (!user || !application) return false;
  if (user.role === "seeker") return application.seekerId === user.id;
  if (user.role === "employer") return application.employerId === user.id;
  return false;
}

async function getAuthedUser(req, db) {
  const token = getBearerToken(req);
  if (!token) return null;
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (typeof session.expiresAt === "number" && Date.now() > session.expiresAt) {
    db.sessions = db.sessions.filter((s) => s.token !== token);
    await writeDb(db);
    return null;
  }
  const user = db.users.find((u) => u.id === session.userId);
  return user || null;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === "/") rel = "/index.html";
  // Basic path traversal guard
  const decoded = decodeURIComponent(rel);
  if (decoded.includes("\0") || decoded.includes("..")) {
    return text(res, 400, "Bad request");
  }

  const filePath = path.join(ROOT_DIR, decoded);
  if (!filePath.startsWith(ROOT_DIR)) {
    return text(res, 400, "Bad request");
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return sendNotFound(res);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendNotFound(res);
  }
}

async function handleApi(req, res, url) {
  const pathname = url.pathname || "/";
  addCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Server-Sent Events stream for live updates.
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // CORS
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });

    // Initial message so the client knows it's connected.
    writeSse(res, { type: "connected", ts: Date.now(), payload: { ok: true } });

    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  const db = await readDb();

  if (pathname === "/api/ping" && req.method === "GET") {
    return json(res, 200, { ok: true, time: nowIso() });
  }

  if (pathname === "/api/config" && req.method === "GET") {
    return json(res, 200, { ok: true, googleClientId: String(process.env.GOOGLE_CLIENT_ID || "").trim() });
  }

  if (pathname === "/api/signup" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });
    const role = normalizeRole(body.role);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    const company = String(body.company || "").trim();

    if (!email || !password) {
      return json(res, 400, { ok: false, error: "Email and password required" });
    }
    if (role === "seeker" && !name) {
      return json(res, 400, { ok: false, error: "Name required for seekers" });
    }
    if (role === "employer" && !company) {
      return json(res, 400, { ok: false, error: "Company required for employers" });
    }

    // Allow the same email to be used once per role (seeker + employer can share an email).
    const exists = db.users.find((u) => u.email === email && u.role === role);
    if (exists) {
      return json(res, 409, { ok: false, error: "Email already registered for this role" });
    }

    const passwordRecord = createPasswordRecord(password);
    const user = {
      id: createId("user"),
      role,
      email,
      passwordSalt: passwordRecord.salt,
      passwordHash: passwordRecord.hash,
      name: role === "seeker" ? name : "",
      company: role === "employer" ? company : "",
      profile:
        role === "employer"
          ? {
              companyName: company,
              companyIndustry: "",
              companyLocation: "",
              aboutText: "",
              info: { industry: "", size: "", founded: "", website: "" },
              contact: { email: "", phone: "", location: "", linkedin: "" },
              logoSrc: "",
            }
          : role === "seeker"
            ? {
                name,
                title: "",
                about: "",
                skills: [],
                contact: { email: "", phone: "", location: "", linkedin: "", github: "" },
                resume: null,
              }
          : undefined,
      createdAt: nowIso(),
    };
    db.users.push(user);

    const token = crypto.randomBytes(24).toString("hex");
    db.sessions.push({
      token,
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    await writeDb(db);
    return json(res, 200, { ok: true, token, user: sanitizeUser(user) });
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });
    const role = normalizeRole(body.role);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!email || !password) {
      return json(res, 400, { ok: false, error: "Email and password required" });
    }

    const user = db.users.find((u) => u.email === email && u.role === role);
    if (!user) return json(res, 401, { ok: false, error: "Invalid credentials" });

    const computed = hashPassword(password, user.passwordSalt);
    if (!timingSafeEqualHex(computed, user.passwordHash)) {
      return json(res, 401, { ok: false, error: "Invalid credentials" });
    }

    const token = crypto.randomBytes(24).toString("hex");
    db.sessions.push({
      token,
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    await writeDb(db);
    return json(res, 200, { ok: true, token, user: sanitizeUser(user) });
  }

  if (pathname === "/api/auth/google" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });

    const role = normalizeRole(body.role);
    const idToken = String(body.credential || body.idToken || "").trim();
    const accessToken = String(body.accessToken || "").trim();
    if (!idToken && !accessToken) {
      return json(res, 400, { ok: false, error: "Google credential or access token required" });
    }

    let info;
    try {
      info = accessToken ? await verifyGoogleAccessToken(accessToken) : await verifyGoogleIdToken(idToken);
    } catch (err) {
      const status = typeof err?.status === "number" ? err.status : 401;
      return json(res, status, { ok: false, error: err?.message || "Google sign-in failed" });
    }

    let user = db.users.find((u) => u.email === info.email && u.role === role);
    if (!user) {
      const employerCompany = role === "employer" ? String(body.company || "").trim() || "Google Employer" : "";
      user = {
        id: createId("user"),
        role,
        email: info.email,
        // No password for Google users; login happens via Google id_token verification.
        passwordSalt: "",
        passwordHash: "",
        name: role === "seeker" ? info.name : "",
        company: employerCompany,
        profile:
          role === "employer"
            ? {
                companyName: employerCompany,
                companyIndustry: "",
                companyLocation: "",
                aboutText: "",
                info: { industry: "", size: "", founded: "", website: "" },
                contact: { email: "", phone: "", location: "", linkedin: "" },
                logoSrc: "",
              }
            : role === "seeker"
              ? {
                  name: info.name,
                  title: "",
                  about: "",
                  skills: [],
                  contact: { email: "", phone: "", location: "", linkedin: "", github: "" },
                  resume: null,
                }
            : undefined,
        authProvider: "google",
        googleSub: info.sub,
        createdAt: nowIso(),
      };
      db.users.push(user);
    } else {
      // Backfill missing profile basics for older accounts.
      if (role === "seeker" && !user.name && info.name) user.name = info.name;
      if (role === "employer" && !user.company) user.company = "Google Employer";
      if (!user.authProvider) user.authProvider = "google";
      if (!user.googleSub && info.sub) user.googleSub = info.sub;
    }

    const token = crypto.randomBytes(24).toString("hex");
    db.sessions.push({
      token,
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    await writeDb(db);
    return json(res, 200, { ok: true, token, user: sanitizeUser(user) });
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    const token = getBearerToken(req);
    if (!token) return json(res, 200, { ok: true });
    db.sessions = db.sessions.filter((s) => s.token !== token);
    await writeDb(db);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });
    return json(res, 200, { ok: true, user: sanitizeUser(user) });
  }

  if (pathname === "/api/notifications" && req.method === "GET") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });

    const toMs = (iso) => {
      const t = Date.parse(String(iso || ""));
      return Number.isFinite(t) ? t : 0;
    };

    const statusLabel = (s) => {
      const v = String(s || "").toLowerCase();
      if (v === "passed") return "Passed";
      if (v === "rejected") return "Rejected";
      if (v === "pending") return "Pending";
      if (v === "applied") return "Applied";
      return v ? v[0].toUpperCase() + v.slice(1) : "Update";
    };

    const mine = db.applications.filter((a) => (user.role === "seeker" ? a.seekerId === user.id : a.employerId === user.id));
    const notes = [];

    mine.forEach((app) => {
      const job = db.jobs.find((j) => j.id === app.jobId);
      const jobTitle = (job && job.title) || app.jobTitle || "";
      const company = (job && (job.company || "")) || app.company || "";

      if (user.role === "employer") {
        const applicant = String(app.seekerName || "A seeker");
        const email = String(app.seekerEmail || "");
        const createdAt = app.createdAt || nowIso();
        const id = `ntf_application_${app.id}_${createdAt}`;
        notes.push({
          id,
          kind: "application",
          title: `New application${jobTitle ? ` • ${jobTitle}` : ""}`,
          body: `${applicant}${email ? ` (${email})` : ""} applied${company ? ` to ${company}` : ""}.`,
          createdAt,
          applicationId: app.id,
          jobId: app.jobId,
          jobTitle,
          company,
          seekerId: app.seekerId,
          seekerName: app.seekerName || "",
          seekerEmail: app.seekerEmail || "",
          status: app.status || "applied",
        });
      }

      if (user.role === "seeker" && app.updatedAt && String(app.status || "").toLowerCase() !== "applied") {
        const createdAt = app.updatedAt;
        const id = `ntf_status_${app.id}_${createdAt}`;
        notes.push({
          id,
          kind: "status",
          title: `Status update • ${statusLabel(app.status)}`,
          body: `${company || "Employer"} updated your application${jobTitle ? ` for ${jobTitle}` : ""}.`,
          createdAt,
          applicationId: app.id,
          jobId: app.jobId,
          jobTitle,
          company,
          status: app.status || "",
        });
      }

      const msgs = Array.isArray(app.messages) ? app.messages : [];
      if (msgs.length) {
        const last = msgs[msgs.length - 1];
        const fromRole = String(last && last.fromRole ? last.fromRole : "").toLowerCase();
        if (fromRole && fromRole !== user.role) {
          const createdAt = (last && last.createdAt) || app.updatedAt || app.createdAt || nowIso();
          const id = `ntf_message_${app.id}_${createdAt}`;
          const textBody = String(last && last.text ? last.text : "").trim();
          notes.push({
            id,
            kind: "message",
            title: `New message${jobTitle ? ` • ${jobTitle}` : ""}`,
            body: textBody ? (textBody.length > 140 ? `${textBody.slice(0, 140)}…` : textBody) : "You received a new message.",
            createdAt,
            applicationId: app.id,
            jobId: app.jobId,
            jobTitle,
            company,
            fromRole,
            status: app.status || "",
          });
        }
      }
    });

    notes.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
    return json(res, 200, { ok: true, notifications: notes.slice(0, 60) });
  }

  // Public-ish user lookup (restricted). Used so employers can review applicant profiles.
  if (pathname.startsWith("/api/users/") && req.method === "GET") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });

    const targetId = pathname.split("/").slice(3).join("/").trim();
    if (!targetId) return json(res, 400, { ok: false, error: "User id required" });

    const target = db.users.find((u) => u.id === targetId);
    if (!target) return json(res, 404, { ok: false, error: "User not found" });

    // Self access always allowed.
    if (target.id !== user.id) {
      // Employers can only access seekers who applied to their jobs.
      if (!(user.role === "employer" && target.role === "seeker")) {
        return json(res, 403, { ok: false, error: "Forbidden" });
      }
      const related = db.applications.some((a) => a.employerId === user.id && a.seekerId === target.id);
      if (!related) return json(res, 403, { ok: false, error: "Forbidden" });
    }

    return json(res, 200, { ok: true, user: sanitizeUser(target), profile: target.profile || {} });
  }

  // Jobs
  if (pathname === "/api/jobs" && req.method === "GET") {
    const jobs = db.jobs
      .slice()
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const enriched = jobs.map((job) => {
      const employer = db.users.find((u) => u.id === job.employerId);
      const applicantCount = db.applications.filter((a) => a.jobId === job.id).length;
      return {
        ...job,
        company: job.company || (employer ? employer.company || employer.name || "" : ""),
        applicantCount,
      };
    });
    return json(res, 200, { ok: true, jobs: enriched });
  }

  if (pathname === "/api/jobs" && req.method === "POST") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });
    if (user.role !== "employer") return json(res, 403, { ok: false, error: "Employer only" });

    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });

    const title = String(body.title || "").trim();
    const location = String(body.location || "").trim();
    const salary = String(body.salary || "").trim();
    const description = String(body.description || "").trim();
    const requirements = String(body.requirements || "").trim();

    if (!title) return json(res, 400, { ok: false, error: "Job title required" });

    const job = {
      id: createId("job"),
      employerId: user.id,
      company: user.company || user.name || "",
      title,
      location,
      salary,
      description,
      requirements,
      createdAt: nowIso(),
    };
    db.jobs.push(job);
    await writeDb(db);
    broadcastSse("jobs_updated", { jobId: job.id, title: job.title, employerId: job.employerId });
    return json(res, 200, { ok: true, job });
  }

  // Applications
  if (pathname.startsWith("/api/applications/") && req.method === "PATCH") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });
    if (user.role !== "employer") return json(res, 403, { ok: false, error: "Employer only" });

    const appId = pathname.split("/").slice(3).join("/").trim();
    if (!appId) return json(res, 400, { ok: false, error: "Application id required" });

    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });
    const nextStatus = String(body.status || "").trim().toLowerCase();
    const allowed = new Set(["pending", "passed", "rejected", "applied", "new"]);
    if (!allowed.has(nextStatus)) return json(res, 400, { ok: false, error: "Invalid status" });

    const app = db.applications.find((a) => a.id === appId);
    if (!app) return json(res, 404, { ok: false, error: "Application not found" });
    if (app.employerId !== user.id) return json(res, 403, { ok: false, error: "Forbidden" });

    app.status = nextStatus === "new" ? "applied" : nextStatus;
    app.updatedAt = nowIso();
    await writeDb(db);
    broadcastSse("applications_updated", {
      applicationId: app.id,
      jobId: app.jobId,
      employerId: app.employerId,
      seekerId: app.seekerId,
    });
    return json(res, 200, { ok: true, application: app });
  }

  if (pathname === "/api/applications" && req.method === "POST") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });
    if (user.role !== "seeker") return json(res, 403, { ok: false, error: "Seeker only" });

    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });
    const jobId = String(body.jobId || "").trim();
    const message = String(body.message || "").trim();
    if (!jobId) return json(res, 400, { ok: false, error: "jobId required" });

    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) return json(res, 404, { ok: false, error: "Job not found" });

    const already = db.applications.find((a) => a.jobId === jobId && a.seekerId === user.id);
    if (already) return json(res, 409, { ok: false, error: "Already applied" });

    const messages = [];
    if (message) {
      messages.push({ id: createId("msg"), fromRole: "seeker", text: message, createdAt: nowIso() });
    }

    const application = {
      id: createId("app"),
      jobId,
      employerId: job.employerId,
      seekerId: user.id,
      seekerName: user.name || "",
      seekerEmail: user.email,
      message,
      messages,
      status: "applied",
      createdAt: nowIso(),
    };
    db.applications.push(application);
    await writeDb(db);
    broadcastSse("applications_updated", {
      applicationId: application.id,
      jobId: application.jobId,
      employerId: application.employerId,
      seekerId: application.seekerId,
    });
    return json(res, 200, { ok: true, application });
  }

  // Messages (simple application-scoped chat)
  if (pathname === "/api/messages" && req.method === "GET") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });

    const applicationId = String(url.searchParams.get("applicationId") || "").trim();
    if (!applicationId) return json(res, 400, { ok: false, error: "applicationId required" });

    const app = db.applications.find((a) => a.id === applicationId);
    if (!app) return json(res, 404, { ok: false, error: "Application not found" });
    if (!canAccessApplication(user, app)) return json(res, 403, { ok: false, error: "Forbidden" });

    // Backwards compatibility: migrate single 'message' to messages[] on read.
    if (!Array.isArray(app.messages)) app.messages = [];
    if (app.messages.length === 0 && app.message) {
      app.messages.push({ id: createId("msg"), fromRole: "seeker", text: String(app.message), createdAt: app.createdAt || nowIso() });
      await writeDb(db);
    }

    return json(res, 200, { ok: true, messages: app.messages });
  }

  if (pathname === "/api/messages" && req.method === "POST") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });

    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });
    const applicationId = String(body.applicationId || "").trim();
    const textBody = String(body.text || "").trim();
    if (!applicationId || !textBody) {
      return json(res, 400, { ok: false, error: "applicationId and text required" });
    }

    const app = db.applications.find((a) => a.id === applicationId);
    if (!app) return json(res, 404, { ok: false, error: "Application not found" });
    if (!canAccessApplication(user, app)) return json(res, 403, { ok: false, error: "Forbidden" });

    if (!Array.isArray(app.messages)) app.messages = [];
    const msg = { id: createId("msg"), fromRole: user.role, text: textBody, createdAt: nowIso() };
    app.messages.push(msg);
    app.updatedAt = nowIso();
    await writeDb(db);
    broadcastSse("messages_updated", {
      applicationId: app.id,
      jobId: app.jobId,
      employerId: app.employerId,
      seekerId: app.seekerId,
      fromRole: user.role,
    });
    return json(res, 200, { ok: true, message: msg });
  }

  if (pathname === "/api/applications" && req.method === "GET") {
    const jobId = String(url.searchParams.get("jobId") || "").trim();
    const mine = url.searchParams.get("mine") === "1";
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });

    if (mine && user.role === "seeker") {
      const apps = db.applications
        .filter((a) => a.seekerId === user.id)
        .slice()
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      const enriched = apps.map((a) => {
        const job = db.jobs.find((j) => j.id === a.jobId);
        return {
          ...a,
          jobTitle: job ? job.title : "",
          company: job ? job.company : "",
        };
      });
      return json(res, 200, { ok: true, applications: enriched });
    }

    if (mine && user.role === "employer") {
      const apps = db.applications
        .filter((a) => a.employerId === user.id)
        .slice()
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      const enriched = apps.map((a) => {
        const job = db.jobs.find((j) => j.id === a.jobId);
        return {
          ...a,
          jobTitle: job ? job.title : "",
          company: job ? job.company : "",
        };
      });
      return json(res, 200, { ok: true, applications: enriched });
    }

    if (user.role !== "employer") return json(res, 403, { ok: false, error: "Employer only" });
    if (!jobId) return json(res, 400, { ok: false, error: "jobId required" });

    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) return json(res, 404, { ok: false, error: "Job not found" });
    if (job.employerId !== user.id) return json(res, 403, { ok: false, error: "Forbidden" });

    const apps = db.applications
      .filter((a) => a.jobId === jobId)
      .slice()
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    return json(res, 200, { ok: true, applications: apps });
  }

  // Profile (minimal)
  if (pathname === "/api/profile" && req.method === "GET") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });
    return json(res, 200, { ok: true, profile: user.profile || {}, user: sanitizeUser(user) });
  }

  if (pathname === "/api/profile" && req.method === "PUT") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });

    // Keep this permissive for a school project; you can tighten later.
    const profile = body.profile && typeof body.profile === "object" ? body.profile : {};
    const u = db.users.find((u2) => u2.id === user.id);
    if (!u) return json(res, 404, { ok: false, error: "User not found" });
    u.profile = profile;
    await writeDb(db);
    return json(res, 200, { ok: true, profile: u.profile });
  }

  return sendNotFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname || "/";

    if (pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    return await serveStatic(req, res, pathname);
  } catch (err) {
    text(res, 500, "Server error");
  }
});

// Bind without an explicit hostname so Node can listen on both IPv4/IPv6 where supported.
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Smart Hunt Job server running on http://localhost:${PORT}`);
});
