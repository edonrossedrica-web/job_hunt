const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

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

function normalizeRole(role) {
  return role === "employer" ? "employer" : role === "seeker" ? "seeker" : "all";
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
}

function ensureShape(db) {
  const out = db && typeof db === "object" ? db : {};
  out.users = Array.isArray(out.users) ? out.users : [];
  out.sessions = Array.isArray(out.sessions) ? out.sessions : [];
  out.jobs = Array.isArray(out.jobs) ? out.jobs : [];
  out.applications = Array.isArray(out.applications) ? out.applications : [];
  return out;
}

function usageAndExit(code) {
  // eslint-disable-next-line no-console
  console.error("Usage: node tools/reset-db.js --role all|employer|seeker [--accounts-only]");
  process.exit(code);
}

function parseArgs(argv) {
  const args = { role: "all", accountsOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--role" || a === "-r") {
      const v = argv[i + 1];
      if (!v) usageAndExit(2);
      args.role = v;
      i += 1;
      continue;
    }
    if (a === "--accounts-only") {
      args.accountsOnly = true;
      continue;
    }
    if (a === "--help" || a === "-h") usageAndExit(0);
    usageAndExit(2);
  }
  args.role = normalizeRole(String(args.role || ""));
  return args;
}

const ROOT = path.join(__dirname, "..");

function resolveDataDir() {
  const raw = String(process.env.SMART_HUNT_DATA_DIR || process.env.DATA_DIR || "").trim();
  if (!raw) return path.join(ROOT, "server-data");
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

const DATA_DIR = resolveDataDir();
const SQLITE_PATH = path.join(DATA_DIR, "db.sqlite");
const LEGACY_DB_JSON_PATH = path.join(DATA_DIR, "db.json");
const SQLITE_KV_KEY = "smart_hunt_db_v1";

function ensureSqlite() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

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
      seed = safeJsonParse(fs.readFileSync(LEGACY_DB_JSON_PATH, "utf8"));
    } catch {
      // ignore
    }
    if (!seed || typeof seed !== "object") seed = { users: [], sessions: [], jobs: [], applications: [] };

    db.prepare("INSERT OR IGNORE INTO kv(key, value) VALUES(?, ?)").run(
      SQLITE_KV_KEY,
      JSON.stringify(seed, null, 2),
    );
  }

  db.close();
}

function ensureMirrorTables(db) {
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
  try {
    db.exec("ALTER TABLE applications ADD COLUMN messagesJson TEXT;");
  } catch {
    // ignore (already exists)
  }
}

function syncMirrorTables(db, jsonDb) {
  ensureMirrorTables(db);

  const users = Array.isArray(jsonDb?.users) ? jsonDb.users : [];
  const sessions = Array.isArray(jsonDb?.sessions) ? jsonDb.sessions : [];
  const jobs = Array.isArray(jsonDb?.jobs) ? jsonDb.jobs : [];
  const applications = Array.isArray(jsonDb?.applications) ? jsonDb.applications : [];

  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec("DELETE FROM users;");
    db.exec("DELETE FROM sessions;");
    db.exec("DELETE FROM jobs;");
    db.exec("DELETE FROM applications;");

    const insertUser = db.prepare(
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

    const insertSession = db.prepare(
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

    const insertJob = db.prepare(
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
        toNullableText(j.status),
        toNullableText(j.closedAt),
        toNullableText(j.createdAt),
        toJsonText(j),
      );
    }

    const insertApplication = db.prepare(
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

    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore
    }
    throw err;
  }
}

function readDb() {
  ensureSqlite();
  const db = new DatabaseSync(SQLITE_PATH);
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(SQLITE_KV_KEY);
  db.close();
  return ensureShape(safeJsonParse(row && typeof row.value === "string" ? row.value : ""));
}

function writeDb(nextDb) {
  ensureSqlite();
  const payload = JSON.stringify(ensureShape(nextDb), null, 2);
  const db = new DatabaseSync(SQLITE_PATH);
  db.prepare(
    "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
  ).run(SQLITE_KV_KEY, payload);
  db.close();
}

function syncMirrorTablesToMatch(nextDb) {
  ensureSqlite();
  const db = new DatabaseSync(SQLITE_PATH);
  try {
    syncMirrorTables(db, nextDb);
  } finally {
    db.close();
  }
}

function backupCurrent(dbObj) {
  const stamp = nowStamp();
  const backupJsonPath = path.join(DATA_DIR, `db.backup.${stamp}.json`);
  fs.writeFileSync(backupJsonPath, JSON.stringify(dbObj, null, 2), "utf8");

  let backupSqlitePath = null;
  try {
    if (fs.existsSync(SQLITE_PATH)) {
      backupSqlitePath = path.join(DATA_DIR, `db.backup.${stamp}.sqlite`);
      fs.copyFileSync(SQLITE_PATH, backupSqlitePath);
    }
  } catch {
    // ignore (JSON backup already created)
  }

  return { backupJsonPath, backupSqlitePath };
}

function main() {
  const { role, accountsOnly } = parseArgs(process.argv);

  const db = readDb();
  const { backupJsonPath, backupSqlitePath } = backupCurrent(db);

  let nextDb = null;

  if (accountsOnly) {
    nextDb = { ...db, users: [], sessions: [] };
  } else
  if (role === "all") {
    nextDb = { users: [], sessions: [], jobs: [], applications: [] };
  } else {
    const removedUserIds = db.users.filter((u) => u && u.role === role).map((u) => u.id);

    db.users = db.users.filter((u) => u && u.role !== role);
    db.sessions = db.sessions.filter((s) => s && !removedUserIds.includes(s.userId));

    if (role === "employer") {
      db.jobs = db.jobs.filter((j) => j && !removedUserIds.includes(j.employerId));
      db.applications = db.applications.filter((a) => a && !removedUserIds.includes(a.employerId));
    } else if (role === "seeker") {
      db.applications = db.applications.filter((a) => a && !removedUserIds.includes(a.seekerId));
    }

    nextDb = db;
  }

  writeDb(nextDb);
  // Also clear/sync the readable mirror tables so DB inspection shows an empty system.
  syncMirrorTablesToMatch(nextDb);

  // eslint-disable-next-line no-console
  console.log("Reset complete:");
  // eslint-disable-next-line no-console
  console.log(` - Updated DB: ${SQLITE_PATH}`);
  // eslint-disable-next-line no-console
  console.log(` - Cleared scope: ${accountsOnly ? "accounts-only" : role}`);
  // eslint-disable-next-line no-console
  console.log(` - Backup JSON: ${backupJsonPath}`);
  if (backupSqlitePath) {
    // eslint-disable-next-line no-console
    console.log(` - Backup SQLite: ${backupSqlitePath}`);
  }
}

main();
