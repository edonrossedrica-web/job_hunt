console.log("🔥 SERVER STARTED");

const http = require("http");
const https = require("https");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
let nodemailer = null;
try {
  // Optional dependency. If not installed/configured, feedback is stored locally instead.
  nodemailer = require("nodemailer");
} catch {
  nodemailer = null;
}

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const ROOT_DIR = __dirname;

function cleanPublicOrigin(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.replace(/\/+$/, "");
}

function firstForwardedValue(raw) {
  return String(raw || "")
    .split(",")[0]
    .trim();
}

function getPublicOrigin(req, url) {
  const forced =
    cleanPublicOrigin(process.env.PUBLIC_ORIGIN) ||
    cleanPublicOrigin(process.env.PUBLIC_URL) ||
    cleanPublicOrigin(process.env.BASE_URL) ||
    "";
  if (forced) return forced;

  const xfProto = firstForwardedValue(req.headers["x-forwarded-proto"]);
  const xfHost = firstForwardedValue(req.headers["x-forwarded-host"]);
  const host = xfHost || String(req.headers.host || url.host || "").trim();
  const proto = xfProto || (req.socket && req.socket.encrypted ? "https" : "http");
  if (!host) return String(url.origin || "").replace(/\/+$/, "");
  return `${proto}://${host}`;
}

function loadDotEnvIfPresent() {
  // Lightweight .env loader (no dependency). Intended for local development only.
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  let raw = "";
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvIfPresent();

function cleanSupabaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.replace(/\/+$/, "");
}

function getSupabaseConfig() {
  return {
    url: cleanSupabaseUrl(process.env.SUPABASE_URL),
    serviceRoleKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
    table: String(process.env.SUPABASE_DB_TABLE || "app_state").trim() || "app_state",
    rowId: String(process.env.SUPABASE_DB_ROW_ID || "smart_hunt_db_v1").trim() || "smart_hunt_db_v1",
  };
}

function hasSupabaseConfig() {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.serviceRoleKey);
}

function getStorageProvider() {
  return hasSupabaseConfig() ? "supabase" : "sqlite";
}

function resolveDataDir() {
  const raw = String(process.env.SMART_HUNT_DATA_DIR || process.env.DATA_DIR || "").trim();
  if (!raw) return path.join(ROOT_DIR, "server-data");
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

function getDefaultLocalDataDir() {
  return path.join(ROOT_DIR, "server-data");
}

function isManagedHost() {
  return Boolean(
    String(process.env.RENDER || "").trim() ||
      String(process.env.RENDER_SERVICE_ID || "").trim() ||
      String(process.env.RENDER_EXTERNAL_URL || "").trim() ||
      String(process.env.RAILWAY_ENVIRONMENT || "").trim() ||
      String(process.env.RAILWAY_PROJECT_ID || "").trim(),
  );
}

let DATA_DIR = resolveDataDir();
// Previous versions stored the whole DB in a JSON file. This version stores it in SQLite.
// To keep the rest of the server code simple, we store the whole JSON blob in a single SQLite row.
let LEGACY_DB_JSON_PATH = path.join(DATA_DIR, "db.json");
let SQLITE_PATH = path.join(DATA_DIR, "db.sqlite");
const SQLITE_KV_KEY = "smart_hunt_db_v1";
let USED_DATA_DIR_FALLBACK = false;
let hasEnsuredStorage = false;

function setDataDir(nextDir) {
  DATA_DIR = nextDir;
  LEGACY_DB_JSON_PATH = path.join(DATA_DIR, "db.json");
  SQLITE_PATH = path.join(DATA_DIR, "db.sqlite");
}

async function ensureDataDirWritable() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    return;
  } catch (err) {
    const code = String(err && err.code ? err.code : "").trim().toUpperCase();
    const configured = resolveDataDir();
    const fallbackDir = getDefaultLocalDataDir();
    const configuredExplicitly = Boolean(String(process.env.SMART_HUNT_DATA_DIR || process.env.DATA_DIR || "").trim());
    const shouldFallback =
      (code === "EACCES" || code === "EPERM" || code === "EROFS") &&
      path.resolve(DATA_DIR) === path.resolve(configured) &&
      path.resolve(DATA_DIR) !== path.resolve(fallbackDir);

    if (configuredExplicitly && isManagedHost()) {
      const fail = new Error(
        `Configured data dir is not writable on this hosted deploy: ${DATA_DIR}. Attach and mount a persistent disk, then keep SMART_HUNT_DATA_DIR pointing to that mount path.`,
      );
      fail.code = code || "DATA_DIR_UNWRITABLE";
      throw fail;
    }

    if (!shouldFallback) {
      throw err;
    }

    setDataDir(fallbackDir);
    USED_DATA_DIR_FALLBACK = true;
    await fsp.mkdir(DATA_DIR, { recursive: true });
    // eslint-disable-next-line no-console
    console.warn(`Primary data dir not writable; falling back to ${DATA_DIR}`);
  }
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The app stores its "real" database as a single JSON blob (kv.value) for simplicity.
// For easier inspection in tools like DB Browser for SQLite, we maintain a few readable tables
// as a best-effort mirror of that JSON. The server continues to use the JSON blob as source of truth.
let hasSyncedReadableTables = false;

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

// Dev-only live reload for local HTML/CSS/JS edits (so you don't need to manually refresh).
// Enable/disable with SMART_HUNT_LIVE_RELOAD=1/0. Defaults to on when NODE_ENV !== "production".
const DEV_LIVE_RELOAD =
  String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production" &&
  String(process.env.SMART_HUNT_LIVE_RELOAD || "1").trim() !== "0";

function startDevLiveReloadWatcher() {
  if (!DEV_LIVE_RELOAD) return;

  let timer = null;
  let lastRel = "";
  const changedExts = new Set();

  const shouldIgnoreRel = (rel) => {
    const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean) return true;
    // Avoid watching noisy/heavy folders.
    if (
      clean.startsWith("node_modules/") ||
      clean.startsWith(".git/") ||
      clean.startsWith("server-data/") ||
      clean.startsWith(".npm-cache/") ||
      clean.startsWith("tools/")
    ) {
      return true;
    }
    return false;
  };

  try {
    fs.watch(ROOT_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const rel = String(filename || "");
      if (shouldIgnoreRel(rel)) return;

      const ext = path.extname(rel).toLowerCase();
      const reloadable =
        ext === ".html" ||
        ext === ".css" ||
        ext === ".js" ||
        ext === ".png" ||
        ext === ".jpg" ||
        ext === ".jpeg" ||
        ext === ".gif" ||
        ext === ".svg" ||
        ext === ".webp" ||
        ext === ".ico" ||
        ext === ".woff" ||
        ext === ".woff2" ||
        ext === ".ttf";
      if (!reloadable) return;

      lastRel = rel.replace(/\\/g, "/");
      changedExts.add(ext);

      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const exts = Array.from(changedExts);
        changedExts.clear();

        // CSS can be hot-reloaded without a full page refresh; everything else needs a reload.
        const type = exts.length === 1 && exts[0] === ".css" ? "dev_css" : "dev_reload";
        broadcastSse(type, { path: lastRel, exts });
      }, 150);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
  } catch {
    // If watch isn't supported, just skip dev live reload.
  }
}

startDevLiveReloadWatcher();

function nowIso() {
  return new Date().toISOString();
}

function emptyDbShape() {
  return { users: [], sessions: [], jobs: [], applications: [] };
}

function normalizeJobStatus(status) {
  const v = String(status || "").trim().toLowerCase();
  return v === "closed" ? "closed" : "open";
}

function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toNullableText(value) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.length ? s : null;
}

function toNullableInt(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toJsonText(value) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function getUserCompanyName(user) {
  if (!user || typeof user !== "object") return "";
  const profile = user.profile && typeof user.profile === "object" ? user.profile : {};
  const profileCompany = String(profile.companyName || "").trim();
  const rawCompany = String(user.company || "").trim();
  const rawName = String(user.name || "").trim();
  return profileCompany || rawCompany || rawName || "";
}

function syncReadableTables(sqlDb, jsonDb) {
  const users = Array.isArray(jsonDb?.users) ? jsonDb.users : [];
  const sessions = Array.isArray(jsonDb?.sessions) ? jsonDb.sessions : [];
  const jobs = Array.isArray(jsonDb?.jobs) ? jsonDb.jobs : [];
  const applications = Array.isArray(jsonDb?.applications) ? jsonDb.applications : [];

  sqlDb.exec("BEGIN IMMEDIATE;");
  try {
    sqlDb.exec("DELETE FROM users;");
    sqlDb.exec("DELETE FROM sessions;");
    sqlDb.exec("DELETE FROM jobs;");
    sqlDb.exec("DELETE FROM applications;");

    const insertUser = sqlDb.prepare(
      "INSERT INTO users(id, role, email, passwordSalt, passwordHash, name, company, authProvider, googleSub, linkedinSub, facebookSub, createdAt, profileJson, rawJson) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    );
    for (const u of users) {
      if (!u || typeof u !== "object") continue;
      const id = toNullableText(u.id);
      if (!id) continue;
      insertUser.run(
        id,
        toNullableText(u.role),
        toNullableText(u.email),
        toNullableText(u.passwordSalt),
        toNullableText(u.passwordHash),
        toNullableText(u.name),
        toNullableText(u.company),
        toNullableText(u.authProvider),
        toNullableText(u.googleSub),
        toNullableText(u.linkedinSub),
        toNullableText(u.facebookSub),
        toNullableText(u.createdAt),
        toJsonText(u.profile ?? null),
        toJsonText(u),
      );
    }

    const insertSession = sqlDb.prepare(
      "INSERT INTO sessions(token, userId, createdAt, expiresAt, rawJson) VALUES(?, ?, ?, ?, ?);",
    );
    for (const s of sessions) {
      if (!s || typeof s !== "object") continue;
      const token = toNullableText(s.token);
      if (!token) continue;
      insertSession.run(
        token,
        toNullableText(s.userId),
        toNullableInt(s.createdAt),
        toNullableInt(s.expiresAt),
        toJsonText(s),
      );
    }

    const insertJob = sqlDb.prepare(
      "INSERT INTO jobs(id, employerId, company, title, location, salary, description, requirements, status, closedAt, createdAt, rawJson) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    );
    for (const j of jobs) {
      if (!j || typeof j !== "object") continue;
      const id = toNullableText(j.id);
      if (!id) continue;
      insertJob.run(
        id,
        toNullableText(j.employerId),
        toNullableText(j.company),
        toNullableText(j.title),
        toNullableText(j.location),
        toNullableText(j.salary),
        toNullableText(j.description),
        toNullableText(j.requirements),
        toNullableText(normalizeJobStatus(j.status)),
        toNullableText(j.closedAt),
        toNullableText(j.createdAt),
        toJsonText(j),
      );
    }

    const insertApplication = sqlDb.prepare(
      "INSERT INTO applications(id, jobId, employerId, seekerId, seekerName, seekerEmail, status, message, createdAt, updatedAt, messagesJson, rawJson) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    );
    for (const a of applications) {
      if (!a || typeof a !== "object") continue;
      const id = toNullableText(a.id);
      if (!id) continue;
      insertApplication.run(
        id,
        toNullableText(a.jobId),
        toNullableText(a.employerId),
        toNullableText(a.seekerId),
        toNullableText(a.seekerName),
        toNullableText(a.seekerEmail),
        toNullableText(a.status),
        toNullableText(a.message),
        toNullableText(a.createdAt),
        toNullableText(a.updatedAt),
        toJsonText(Array.isArray(a.messages) ? a.messages : []),
        toJsonText(a),
      );
    }

    sqlDb.exec("COMMIT;");
  } catch (err) {
    try {
      sqlDb.exec("ROLLBACK;");
    } catch {
      // ignore
    }
    throw err;
  }
}

async function readLegacyJsonSeed() {
  try {
    const rawLegacy = await fsp.readFile(LEGACY_DB_JSON_PATH, "utf8");
    const parsed = safeJsonParse(rawLegacy);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore (no legacy JSON DB)
  }
  return null;
}

async function readLocalSqliteSeed() {
  try {
    await ensureDataDirWritable();
    if (!fs.existsSync(SQLITE_PATH)) return null;
    const sqlDb = new DatabaseSync(SQLITE_PATH);
    try {
      const row = sqlDb.prepare("SELECT value FROM kv WHERE key = ?").get(SQLITE_KV_KEY);
      const parsed = safeJsonParse(row && typeof row.value === "string" ? row.value : "");
      return parsed && typeof parsed === "object" ? parsed : null;
    } finally {
      sqlDb.close();
    }
  } catch {
    return null;
  }
}

async function getSeedDb() {
  const legacy = await readLegacyJsonSeed();
  if (legacy && typeof legacy === "object") return legacy;
  const sqlite = await readLocalSqliteSeed();
  if (sqlite && typeof sqlite === "object") return sqlite;
  return emptyDbShape();
}

async function supabaseRequest(method, requestPath, body) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.serviceRoleKey) {
    throw new Error("Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const headers = {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${cfg.url}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const raw = await res.text();
  const parsed = safeJsonParse(raw);
  if (!res.ok) {
    const detail =
      (parsed && (parsed.message || parsed.error_description || parsed.hint || parsed.details || parsed.error)) ||
      raw ||
      `HTTP ${res.status}`;
    throw new Error(`Supabase request failed (${res.status}): ${detail}`);
  }
  return parsed;
}

async function ensureSupabaseDb() {
  const cfg = getSupabaseConfig();
  const encodedRowId = encodeURIComponent(cfg.rowId);
  const query = `/rest/v1/${encodeURIComponent(cfg.table)}?select=value&id=eq.${encodedRowId}&limit=1`;
  let rows = null;
  try {
    rows = await supabaseRequest("GET", query);
  } catch (err) {
    const message = err && err.message ? String(err.message) : "";
    if (message.includes("relation") || message.includes("does not exist") || message.includes("PGRST")) {
      throw new Error(
        `Supabase table "${cfg.table}" is not ready. Create it first, then add a row id column named "id" and a jsonb column named "value".`,
      );
    }
    throw err;
  }

  if (Array.isArray(rows) && rows.length) return;

  const seed = await getSeedDb();
  await supabaseRequest("POST", `/rest/v1/${encodeURIComponent(cfg.table)}`, {
    id: cfg.rowId,
    value: seed,
  });
}

async function ensureLocalDb() {
  await ensureDataDirWritable();

  const db = new DatabaseSync(SQLITE_PATH);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  } catch {
    // ignore (best-effort tuning)
  }

  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);");

  // Readable mirror tables (for inspection only; source of truth remains kv.value JSON).
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    role TEXT,
    email TEXT,
    passwordSalt TEXT,
    passwordHash TEXT,
    name TEXT,
    company TEXT,
    authProvider TEXT,
    googleSub TEXT,
    linkedinSub TEXT,
    facebookSub TEXT,
    createdAt TEXT,
    profileJson TEXT,
    rawJson TEXT
  );`);
  try {
    db.exec("ALTER TABLE users ADD COLUMN passwordSalt TEXT;");
  } catch {
    // ignore (already exists)
  }
  try {
    db.exec("ALTER TABLE users ADD COLUMN passwordHash TEXT;");
  } catch {
    // ignore (already exists)
  }
  try {
    db.exec("ALTER TABLE users ADD COLUMN linkedinSub TEXT;");
  } catch {
    // ignore (already exists)
  }
  try {
    db.exec("ALTER TABLE users ADD COLUMN facebookSub TEXT;");
  } catch {
    // ignore (already exists)
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT,
    createdAt INTEGER,
    expiresAt INTEGER,
    rawJson TEXT
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    employerId TEXT,
    company TEXT,
    title TEXT,
    location TEXT,
    salary TEXT,
    description TEXT,
    requirements TEXT,
    status TEXT,
    closedAt TEXT,
    createdAt TEXT,
    rawJson TEXT
  );`);
  try {
    db.exec("ALTER TABLE jobs ADD COLUMN status TEXT;");
  } catch {
    // ignore (already exists)
  }
  try {
    db.exec("ALTER TABLE jobs ADD COLUMN closedAt TEXT;");
  } catch {
    // ignore (already exists)
  }
  db.exec(`CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    jobId TEXT,
    employerId TEXT,
    seekerId TEXT,
    seekerName TEXT,
    seekerEmail TEXT,
    status TEXT,
    message TEXT,
    createdAt TEXT,
    updatedAt TEXT,
    messagesJson TEXT,
    rawJson TEXT
  );`);

  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(SQLITE_KV_KEY);
  if (!row || typeof row.value !== "string") {
    const seed = await getSeedDb();
    const seedJson = JSON.stringify(seed, null, 2);
    db.prepare("INSERT OR IGNORE INTO kv(key, value) VALUES(?, ?)").run(SQLITE_KV_KEY, seedJson);
  }
  db.close();
}

async function ensureDb() {
  if (hasEnsuredStorage) return;
  if (getStorageProvider() === "supabase") {
    await ensureSupabaseDb();
  } else {
    await ensureLocalDb();
  }
  hasEnsuredStorage = true;
}

function normalizeDbShape(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyDbShape();
  parsed.users = Array.isArray(parsed.users) ? parsed.users : [];
  parsed.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  parsed.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  parsed.applications = Array.isArray(parsed.applications) ? parsed.applications : [];
  return parsed;
}

async function readDb() {
  await ensureDb();
  if (getStorageProvider() === "supabase") {
    const cfg = getSupabaseConfig();
    const rows = await supabaseRequest(
      "GET",
      `/rest/v1/${encodeURIComponent(cfg.table)}?select=value&id=eq.${encodeURIComponent(cfg.rowId)}&limit=1`,
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return normalizeDbShape(row && typeof row === "object" ? row.value : null);
  }

  const sqlDb = new DatabaseSync(SQLITE_PATH);
  const row = sqlDb.prepare("SELECT value FROM kv WHERE key = ?").get(SQLITE_KV_KEY);
  const parsed = normalizeDbShape(safeJsonParse(row && typeof row.value === "string" ? row.value : ""));

  if (!hasSyncedReadableTables) {
    try {
      syncReadableTables(sqlDb, parsed);
      hasSyncedReadableTables = true;
    } catch {
      // best-effort; readable tables are optional
    }
  }

  sqlDb.close();
  return parsed;
}

async function writeDb(db) {
  await ensureDb();
  const normalized = normalizeDbShape(db);
  if (getStorageProvider() === "supabase") {
    const cfg = getSupabaseConfig();
    await supabaseRequest(
      "PATCH",
      `/rest/v1/${encodeURIComponent(cfg.table)}?id=eq.${encodeURIComponent(cfg.rowId)}`,
      { value: normalized },
    );
    return;
  }

  const payload = JSON.stringify(normalized, null, 2);
  const sqlDb = new DatabaseSync(SQLITE_PATH);
  sqlDb
    .prepare(
      "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    )
    .run(SQLITE_KV_KEY, payload);

  // Keep the readable mirror tables in sync for easier DB inspection.
  try {
    syncReadableTables(sqlDb, normalized);
    hasSyncedReadableTables = true;
  } catch {
    // best-effort; readable tables are optional
  }
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token");
}

function sendNotFound(res) {
  text(res, 404, "Not found");
}

function normalizeRole(role) {
  return role === "employer" ? "employer" : "seeker";
}

function getAdminToken(req) {
  const headerToken = String(req.headers["x-admin-token"] || "").trim();
  if (headerToken) return headerToken;
  const auth = String(req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

function isAdminRequest(req) {
  const expected = String(process.env.ADMIN_TOKEN || "").trim();
  if (!expected) return false;
  const got = getAdminToken(req);
  if (!got) return false;
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
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

async function appendFeedbackLog(entry) {
  try {
    await ensureDataDirWritable();
  } catch {
    // ignore
  }
  const filePath = path.join(DATA_DIR, "feedback.jsonl");
  const line = JSON.stringify(entry) + "\n";
  await fsp.appendFile(filePath, line, "utf8");
}

function smtpConfigFromEnv() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number.parseInt(String(process.env.SMTP_PORT || "").trim() || "587", 10);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const secureRaw = String(process.env.SMTP_SECURE || "").trim().toLowerCase();
  const secure = secureRaw ? secureRaw === "1" || secureRaw === "true" || secureRaw === "yes" : port === 465;
  // Defaults:
  // - to: FEEDBACK_TO (preferred), else SMTP_USER (common when using Gmail app passwords)
  // - from: FEEDBACK_FROM (preferred), else SMTP_USER
  const to = String(process.env.FEEDBACK_TO || user || "").trim();
  const from = String(process.env.FEEDBACK_FROM || user || "").trim();
  const subjectPrefix = String(process.env.FEEDBACK_SUBJECT_PREFIX || "HireUp").trim();
  const brevoApiKey = String(process.env.BREVO_API_KEY || "").trim();
  return { host, port, user, pass, secure, to, from, subjectPrefix, brevoApiKey };
}

async function sendFeedbackEmail({ subject, text, replyTo }) {
  const cfg = smtpConfigFromEnv();
  if (cfg.brevoApiKey) {
    if (!cfg.to || !cfg.from) {
      throw new Error("Email not configured (missing FEEDBACK_TO / FEEDBACK_FROM env vars).");
    }
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": cfg.brevoApiKey,
      },
      body: JSON.stringify({
        sender: { email: cfg.from, name: "HireUp" },
        to: [{ email: cfg.to }],
        subject,
        textContent: text,
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const message =
        data?.message ||
        data?.code ||
        data?.error ||
        `Brevo API request failed (${resp.status}).`;
      throw new Error(String(message));
    }
    return;
  }

  if (!nodemailer) throw new Error("Email not configured (nodemailer not installed).");
  if (!cfg.host || !cfg.to || !cfg.from || !cfg.user || !cfg.pass) {
    throw new Error("Email not configured (missing SMTP_* or FEEDBACK_* env vars).");
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  const mail = {
    from: cfg.from,
    to: cfg.to,
    subject,
    text,
  };
  if (replyTo) {
    mail.replyTo = replyTo;
  }
  await Promise.race([
    transporter.sendMail(mail),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("SMTP send timed out.")), 15000);
    }),
  ]);
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
  if (!clientId) {
    const err = new Error("Google sign-in is not configured on the server.");
    err.status = 503;
    throw err;
  }

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
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) {
    const err = new Error("Google sign-in is not configured on the server.");
    err.status = 503;
    throw err;
  }

  const { statusCode: tokenStatusCode, body: tokenBody, raw: tokenRaw } = await fetchJson(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
  );

  if (tokenStatusCode !== 200 || !tokenBody || typeof tokenBody !== "object") {
    const message =
      (tokenBody && (tokenBody.error_description || tokenBody.error)) ||
      (tokenRaw ? String(tokenRaw).slice(0, 200) : "") ||
      "Invalid Google access token.";
    const err = new Error(message);
    err.status = 401;
    throw err;
  }

  const aud = String(tokenBody.aud || tokenBody.azp || tokenBody.issued_to || "").trim();
  if (!aud || aud !== clientId) {
    const err = new Error("Google access token audience mismatch.");
    err.status = 401;
    throw err;
  }

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
    name: String(body.name || body.given_name || body.family_name || "").trim(),
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
    });

    // Initial message so the client knows it's connected.
    writeSse(res, { type: "connected", ts: Date.now(), payload: { ok: true } });

    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  if (pathname === "/api/ping" && req.method === "GET") {
    return json(res, 200, { ok: true, time: nowIso() });
  }

  if (pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      status: "healthy",
      time: nowIso(),
      storageProvider: getStorageProvider(),
      supabaseConfigured: hasSupabaseConfig(),
      dataDir: DATA_DIR,
      usingDataDirFallback: USED_DATA_DIR_FALLBACK,
      dataDirConfigured: Boolean(String(process.env.SMART_HUNT_DATA_DIR || process.env.DATA_DIR || "").trim()),
      hasPublicOrigin:
        !!(
          cleanPublicOrigin(process.env.PUBLIC_ORIGIN) ||
          cleanPublicOrigin(process.env.PUBLIC_URL) ||
          cleanPublicOrigin(process.env.BASE_URL)
        ),
    });
  }

  if (pathname === "/api/config" && req.method === "GET") {
    console.log("🔥 CONFIG ROUTE HIT");
    return json(res, 200, {
      ok: true,
      googleClientId: String(process.env.GOOGLE_CLIENT_ID || "").trim(),
      storageProvider: getStorageProvider(),
      supabaseConfigured: hasSupabaseConfig(),
      dataDir: DATA_DIR,
      usingDataDirFallback: USED_DATA_DIR_FALLBACK,
    });
  }

  const db = await readDb();

  if (pathname === "/api/feedback" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });
    const kindRaw = String(body.kind || "").trim().toLowerCase();
    const kind = kindRaw === "support" ? "support" : kindRaw === "feedback" ? "feedback" : "";
    const topic = String(body.topic || "").trim();
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const message = String(body.message || "").trim();
    const rating = toNullableInt(body.rating);
    const clampedRating = rating ? Math.max(1, Math.min(5, rating)) : 5;
    if (!message) return json(res, 400, { ok: false, error: "message required" });

    const entry = {
      id: createId("feedback"),
      createdAt: nowIso(),
      name,
      email,
      rating: clampedRating,
      message,
      userAgent: String(req.headers["user-agent"] || ""),
      ip:
        String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : ""),
    };

    let stored = false;
    try {
      await appendFeedbackLog(entry);
      stored = true;
    } catch {
      stored = false;
    }

    const cfg = smtpConfigFromEnv();
    const inferredKind = kind || (message.startsWith("[Support Request]") ? "support" : "feedback");
    const subjectBase =
      inferredKind === "support"
        ? `${cfg.subjectPrefix} support request${topic ? `: ${topic}` : ""}`
        : `${cfg.subjectPrefix} feedback (${clampedRating}/5)`;
    const subject = subjectBase;
    const text =
      `Rating: ${clampedRating}/5\n` +
      `Type: ${inferredKind}\n` +
      (topic ? `Topic: ${topic}\n` : "") +
      `Name: ${name || "-"}\n` +
      `Email: ${email || "-"}\n` +
      `Time: ${entry.createdAt}\n` +
      `IP: ${entry.ip || "-"}\n` +
      `User-Agent: ${entry.userAgent || "-"}\n\n` +
      `${message}\n`;

    let emailSent = false;
    let emailError = "";
    try {
      await sendFeedbackEmail({ subject, text, replyTo: email || "" });
      emailSent = true;
    } catch (err) {
      emailSent = false;
      emailError = String(err?.message || "Email not configured");
      try {
        console.error("FEEDBACK EMAIL ERROR", {
          kind: inferredKind,
          topic,
          to: cfg.to || "",
          from: cfg.from || "",
          smtpUser: cfg.user || "",
          message: emailError,
        });
      } catch {
        // ignore logging failures
      }
    }

    const msg = emailSent
      ? "Feedback sent to email."
      : stored
        ? `Feedback saved on server (email not sent: ${emailError}).`
        : `Feedback received but could not be saved or emailed (${emailError}).`;

    return json(res, 200, { ok: true, emailSent, stored, message: msg });
  }

  // Admin endpoints: enabled only when ADMIN_TOKEN is set.
  // Use header: X-Admin-Token: <ADMIN_TOKEN> (or Authorization: Bearer <ADMIN_TOKEN>).
  if (pathname === "/api/admin/users" && req.method === "GET") {
    if (!isAdminRequest(req)) return json(res, 401, { ok: false, error: "Admin token required" });
    const users = db.users.map((u) => ({
      id: u.id,
      role: u.role,
      email: u.email,
      name: u.name,
      company: u.company,
      authProvider: u.authProvider || "local",
      createdAt: u.createdAt || "",
      passwordSalt: u.passwordSalt || "",
      passwordHash: u.passwordHash || "",
    }));
    return json(res, 200, { ok: true, users });
  }

  if (pathname === "/api/admin/set-password" && req.method === "POST") {
    if (!isAdminRequest(req)) return json(res, 401, { ok: false, error: "Admin token required" });
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });

    const userId = String(body.userId || "").trim();
    const role = body.role ? normalizeRole(body.role) : "";
    const email = String(body.email || "").trim().toLowerCase();
    const newPassword = String(body.newPassword || "");
    if (!newPassword) return json(res, 400, { ok: false, error: "newPassword required" });

    const user = userId
      ? db.users.find((u) => u.id === userId)
      : db.users.find((u) => u.email === email && (!role || u.role === role));

    if (!user) return json(res, 404, { ok: false, error: "User not found" });

    const passwordRecord = createPasswordRecord(newPassword);
    user.passwordSalt = passwordRecord.salt;
    user.passwordHash = passwordRecord.hash;
    if (!user.authProvider) user.authProvider = "local";

    // Invalidate sessions for that user.
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    await writeDb(db);
    return json(res, 200, { ok: true, userId: user.id });
  }

  if (pathname === "/api/admin/delete-user" && req.method === "POST") {
    if (!isAdminRequest(req)) return json(res, 401, { ok: false, error: "Admin token required" });
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });

    const userId = String(body.userId || "").trim();
    const role = body.role ? normalizeRole(body.role) : "";
    const email = String(body.email || "").trim().toLowerCase();

    let target = null;
    if (userId) {
      target = db.users.find((u) => u.id === userId) || null;
    } else if (email) {
      const matches = db.users.filter((u) => u.email === email && (!role || u.role === role));
      if (matches.length === 0) return json(res, 404, { ok: false, error: "User not found" });
      if (matches.length > 1 && !role) {
        return json(res, 400, { ok: false, error: "Multiple users match this email; provide role (seeker/employer) or userId" });
      }
      target = matches[0] || null;
    } else {
      return json(res, 400, { ok: false, error: "userId or email required" });
    }

    if (!target) return json(res, 404, { ok: false, error: "User not found" });

    const beforeUsers = db.users.length;
    const beforeSessions = db.sessions.length;
    const beforeJobs = db.jobs.length;
    const beforeApplications = db.applications.length;

    // Remove user + their sessions.
    db.users = db.users.filter((u) => u.id !== target.id);
    db.sessions = db.sessions.filter((s) => s.userId !== target.id);

    // Remove related jobs/applications.
    let removedJobIds = new Set();
    if (target.role === "employer") {
      removedJobIds = new Set(db.jobs.filter((j) => j.employerId === target.id).map((j) => j.id));
      db.jobs = db.jobs.filter((j) => j.employerId !== target.id);
      db.applications = db.applications.filter((a) => a.employerId !== target.id && !removedJobIds.has(a.jobId));
    } else {
      db.applications = db.applications.filter((a) => a.seekerId !== target.id);
    }

    await writeDb(db);
    broadcastSse("jobs_updated", { reason: "admin_delete_user", employerId: target.role === "employer" ? target.id : undefined });
    broadcastSse("applications_updated", { reason: "admin_delete_user", userId: target.id });

    return json(res, 200, {
      ok: true,
      deleted: {
        userId: target.id,
        role: target.role,
        email: target.email,
      },
      removedCounts: {
        users: beforeUsers - db.users.length,
        sessions: beforeSessions - db.sessions.length,
        jobs: beforeJobs - db.jobs.length,
        applications: beforeApplications - db.applications.length,
      },
    });
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
              __schema: 1,
              __updatedAt: Date.now(),
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
                __schema: 1,
                __updatedAt: Date.now(),
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
    const modeRaw = String(body.mode || "").trim().toLowerCase();
    const mode = modeRaw === "signup" ? "signup" : modeRaw === "login" ? "login" : "";
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
    let recoveredAccount = false;
    if (!user) {
      const employerCompany = role === "employer" ? String(body.company || "").trim() : "";
      recoveredAccount = mode === "login";
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
                __schema: 1,
                __updatedAt: Date.now(),
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
                  __schema: 1,
                  __updatedAt: Date.now(),
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
      if (role === "employer" && !user.company) user.company = "";
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
    return json(res, 200, { ok: true, token, user: sanitizeUser(user), recoveredAccount });
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
      const status = normalizeJobStatus(job.status);
      return {
        ...job,
        status,
        closedAt: status === "closed" ? String(job.closedAt || "") : "",
        company: job.company || getUserCompanyName(employer),
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
      company: getUserCompanyName(user),
      title,
      location,
      salary,
      description,
      requirements,
      status: "open",
      closedAt: "",
      createdAt: nowIso(),
    };
    db.jobs.push(job);
    await writeDb(db);
    broadcastSse("jobs_updated", { jobId: job.id, title: job.title, employerId: job.employerId });
    return json(res, 200, { ok: true, job });
  }

  if (pathname.startsWith("/api/jobs/") && req.method === "PATCH") {
    const user = await getAuthedUser(req, db);
    if (!user) return json(res, 401, { ok: false, error: "Not authenticated" });
    if (user.role !== "employer") return json(res, 403, { ok: false, error: "Employer only" });

    const jobId = pathname.split("/").slice(3).join("/").trim();
    if (!jobId) return json(res, 400, { ok: false, error: "Job id required" });

    const job = db.jobs.find((j) => j && j.id === jobId);
    if (!job) return json(res, 404, { ok: false, error: "Job not found" });
    if (String(job.employerId || "") !== String(user.id || "")) {
      return json(res, 403, { ok: false, error: "Forbidden" });
    }

    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "Invalid JSON" });

    let nextStatus = "";
    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      nextStatus = normalizeJobStatus(body.status);
    } else if (Object.prototype.hasOwnProperty.call(body, "closed")) {
      nextStatus = body.closed ? "closed" : "open";
    }
    if (!nextStatus) return json(res, 400, { ok: false, error: "status or closed required" });

    job.status = nextStatus;
    job.closedAt = nextStatus === "closed" ? nowIso() : "";
    await writeDb(db);
    broadcastSse("jobs_updated", { jobId: job.id, status: job.status, employerId: job.employerId });
    return json(res, 200, { ok: true, job: { ...job, status: normalizeJobStatus(job.status) } });
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
    if (normalizeJobStatus(job.status) === "closed") {
      return json(res, 400, { ok: false, error: "Job is closed" });
    }

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
    // Server-authoritative sync metadata so clients can resolve local draft vs backend.
    try {
      profile.__schema = 1;
      profile.__updatedAt = Date.now();
    } catch {
      // ignore (extremely defensive)
    }
    const u = db.users.find((u2) => u2.id === user.id);
    if (!u) return json(res, 404, { ok: false, error: "User not found" });
    u.profile = profile;
    await writeDb(db);
    return json(res, 200, { ok: true, profile: u.profile });
  }

  return sendNotFound(res);
}

// Warm the database on startup so the SQLite file has readable tables even before the first request.
// This is best-effort; the server can still run even if it fails.
readDb().catch(() => {
  // ignore
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname || "/";

    if (pathname === "/auth/facebook/start" || pathname === "/auth/facebook/callback") {
      const isLinkedIn = false;
      const provider = "facebook";
      const providerLabel = "Facebook";
      const authType = `${provider}_auth`;
      const clientId = String(process.env.FACEBOOK_APP_ID || "").trim();
      const clientSecret = String(process.env.FACEBOOK_APP_SECRET || "").trim();
      const graphVersion = String(process.env.FACEBOOK_GRAPH_VERSION || "v22.0").trim() || "v22.0";

      const sendAuthResult = (payload) => {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        const safePayload = JSON.stringify(payload || {});
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>${providerLabel} Auth</title></head><body>` +
            `<script>(function(){` +
            `var payload=${safePayload};` +
            `try{` +
            `if(window.opener && !window.opener.closed){window.opener.postMessage(payload, window.location.origin);}` +
            `}catch(e){}` +
            `try{window.close();}catch(e){}` +
            `setTimeout(function(){window.location.href="/";}, 250);` +
            `})();</script>` +
            `</body></html>`,
        );
      };

      const roleRaw = String(url.searchParams.get("role") || "").trim().toLowerCase();
      const modeRaw = String(url.searchParams.get("mode") || "").trim().toLowerCase();
      const rid = String(url.searchParams.get("rid") || "").trim();
      const role = roleRaw === "employer" ? "employer" : "seeker";
      const mode = modeRaw === "signup" ? "signup" : "login";
      const redirectUri =
        String(process.env.FACEBOOK_REDIRECT_URI || "").trim() ||
        `${getPublicOrigin(req, url)}/auth/${provider}/callback`;
      const stateStoreKey = "__hireupFacebookStates";

      if (pathname.endsWith("/start")) {
        if (req.method !== "GET") return sendNotFound(res);

        if (!clientId || !clientSecret) {
          return sendAuthResult({
            type: authType,
            ok: false,
            rid,
            role,
            mode,
            error: "Facebook sign-in is not configured on the server (missing FACEBOOK_APP_ID / FACEBOOK_APP_SECRET).",
          });
        }

        if (!global[stateStoreKey]) global[stateStoreKey] = new Map();
        const states = global[stateStoreKey];
        const state = crypto.randomBytes(18).toString("hex");
        states.set(state, { createdAt: Date.now(), role, mode, rid });

        const authUrl = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("scope", "email,public_profile");

        res.writeHead(302, { Location: authUrl.toString(), "Cache-Control": "no-store" });
        res.end();
        return;
      }

      if (req.method !== "GET") return sendNotFound(res);
      if (!clientId || !clientSecret) {
        return sendAuthResult({
          type: authType,
          ok: false,
          error: "Facebook sign-in is not configured on the server (missing FACEBOOK_APP_ID / FACEBOOK_APP_SECRET).",
        });
      }

      const code = String(url.searchParams.get("code") || "").trim();
      const state = String(url.searchParams.get("state") || "").trim();
      const error = String(url.searchParams.get("error") || "").trim();
      const errorDesc = String(url.searchParams.get("error_description") || "").trim();
      if (!global[stateStoreKey]) global[stateStoreKey] = new Map();
      const states = global[stateStoreKey];
      const stored = state ? states.get(state) : null;
      const resultRid = stored && stored.rid ? String(stored.rid) : "";

      if (error) {
        if (state) states.delete(state);
        return sendAuthResult({
          type: authType,
          ok: false,
          rid: resultRid,
          error: errorDesc || error || `${providerLabel} sign-in failed.`,
        });
      }
      if (!code || !state) {
        return sendAuthResult({
          type: authType,
          ok: false,
          rid: resultRid,
          error: `Missing ${providerLabel} OAuth parameters.`,
        });
      }

      states.delete(state);
      if (!stored) {
        return sendAuthResult({
          type: authType,
          ok: false,
          rid: resultRid,
          error: `${providerLabel} sign-in expired. Please try again.`,
        });
      }
      if (stored && typeof stored.createdAt === "number" && Date.now() - stored.createdAt > 10 * 60 * 1000) {
        return sendAuthResult({
          type: authType,
          ok: false,
          rid: resultRid,
          error: `${providerLabel} sign-in expired. Please try again.`,
        });
      }

      let accessToken = "";
      try {
        const tokenResp = await fetch(
          `https://graph.facebook.com/${graphVersion}/oauth/access_token?` +
            new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: redirectUri,
              code,
            }).toString(),
        );
        const tokenData = await tokenResp.json().catch(() => null);
        if (!tokenResp.ok || !tokenData) {
          const providerError = tokenData?.error?.message || tokenData?.error_description || tokenData?.error;
          throw new Error(String(providerError || `Failed to exchange ${providerLabel} code.`));
        }
        accessToken = String(tokenData.access_token || "").trim();
        if (!accessToken) throw new Error(`${providerLabel} access token missing.`);
      } catch (err) {
        return sendAuthResult({
          type: authType,
          ok: false,
          error: err?.message || `${providerLabel} token exchange failed.`,
          rid: stored.rid || "",
        });
      }

      let info;
      try {
        const profileResp = await fetch(
          `https://graph.facebook.com/${graphVersion}/me?` +
            new URLSearchParams({
              fields: "id,name,email",
              access_token: accessToken,
            }).toString(),
        );
        const profileData = await profileResp.json().catch(() => null);
        if (!profileResp.ok || !profileData) {
          const providerError =
            profileData?.error?.message || profileData?.error_description || profileData?.error;
          throw new Error(String(providerError || `Failed to fetch ${providerLabel} profile.`));
        }
        info = profileData;
      } catch (err) {
        return sendAuthResult({
          type: authType,
          ok: false,
          error: err?.message || `${providerLabel} profile fetch failed.`,
          rid: stored.rid || "",
        });
      }

      const name = String(info.name || info.given_name || "").trim();
      const sub = String(info.sub || info.id || "").trim();
      const rawEmail = String(info.email || info.emailAddress || "").trim().toLowerCase();
      const email =
        rawEmail || (!isLinkedIn && sub ? `facebook-${sub}@users.hireup.local` : "");
      if (!email) {
        return sendAuthResult({
          type: authType,
          ok: false,
          error: `${providerLabel} account email is missing.`,
          rid: stored.rid || "",
        });
      }

      let db;
      try {
        db = await readDb();
      } catch {
        db = { users: [], sessions: [], jobs: [], applications: [], feedback: [] };
      }

      const authRole = stored.role === "employer" ? "employer" : "seeker";
      let user =
        (!isLinkedIn && sub
          ? db.users.find((u) => u.role === authRole && String(u.facebookSub || "") === sub)
          : null) ||
        db.users.find((u) => u.email === email && u.role === authRole);
      if (!user) {
        if (stored.mode === "login") {
          return sendAuthResult({
            type: authType,
            ok: false,
            rid: stored.rid || "",
            role: authRole,
            mode: stored.mode || "login",
            error: `No account found for this ${providerLabel} email. Please sign up first.`,
          });
        }
        const employerCompany = authRole === "employer" ? `${providerLabel} Employer` : "";
        user = {
          id: createId("user"),
          role: authRole,
          email,
          passwordSalt: "",
          passwordHash: "",
          name: authRole === "seeker" ? name : "",
          company: authRole === "employer" ? employerCompany : "",
          profile:
            authRole === "employer"
              ? {
                  __schema: 1,
                  __updatedAt: Date.now(),
                  companyName: employerCompany,
                  companyIndustry: "",
                  companyLocation: "",
                  aboutText: "",
                  info: { industry: "", size: "", founded: "", website: "" },
                  contact: { email: "", phone: "", location: "", linkedin: "" },
                  logoSrc: "",
                }
              : {
                  __schema: 1,
                  __updatedAt: Date.now(),
                  name,
                  title: "",
                  about: "",
                  skills: [],
                  contact: { email: "", phone: "", location: "", facebook: "", github: "" },
                  resume: null,
                },
          authProvider: provider,
          ...(isLinkedIn ? { linkedinSub: sub } : { facebookSub: sub }),
          createdAt: nowIso(),
        };
        db.users.push(user);
      } else {
        if (authRole === "seeker" && !user.name && name) user.name = name;
        if (authRole === "employer" && !user.company) user.company = `${providerLabel} Employer`;
        if (!user.authProvider) user.authProvider = provider;
        if (isLinkedIn && !user.linkedinSub && sub) user.linkedinSub = sub;
        if (!isLinkedIn && !user.facebookSub && sub) user.facebookSub = sub;
      }

      const token = crypto.randomBytes(24).toString("hex");
      db.sessions.push({
        token,
        userId: user.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      await writeDb(db);

      return sendAuthResult({
        type: authType,
        ok: true,
        rid: stored.rid || "",
        role: authRole,
        mode: stored.mode || "login",
        token,
        user: sanitizeUser(user),
      });
    }

    if (pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    return await serveStatic(req, res, pathname);
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.error("SERVER REQUEST ERROR", {
        method: req.method,
        url: req.url || "",
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack) : "",
      });
    } catch {
      // ignore logging failures
    }
    text(res, 500, "Server error");
  }
});

// Bind without an explicit hostname so Node can listen on both IPv4/IPv6 where supported.
server.listen(PORT, () => {
  const configuredOrigin =
    cleanPublicOrigin(process.env.PUBLIC_ORIGIN) ||
    cleanPublicOrigin(process.env.PUBLIC_URL) ||
    cleanPublicOrigin(process.env.BASE_URL) ||
    "";
  // eslint-disable-next-line no-console
  console.log(`HireUp server listening on port ${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`HireUp data dir: ${DATA_DIR}`);
  // eslint-disable-next-line no-console
  console.log(`HireUp storage provider: ${getStorageProvider()}`);
  // eslint-disable-next-line no-console
  console.log(`HireUp managed host: ${isManagedHost() ? "yes" : "no"}`);
  // eslint-disable-next-line no-console
  console.log(`HireUp supabase configured: ${hasSupabaseConfig() ? "yes" : "no"}`);
  // eslint-disable-next-line no-console
  console.log(`HireUp data dir fallback: ${USED_DATA_DIR_FALLBACK ? "yes" : "no"}`);
  if (configuredOrigin) {
    // eslint-disable-next-line no-console
    console.log(`HireUp public origin: ${configuredOrigin}`);
  }
});
