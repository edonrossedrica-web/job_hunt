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
  console.error("Usage: node tools/reset-db.js --role all|employer|seeker");
  process.exit(code);
}

function parseArgs(argv) {
  const args = { role: "all" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--role" || a === "-r") {
      const v = argv[i + 1];
      if (!v) usageAndExit(2);
      args.role = v;
      i += 1;
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
  const { role } = parseArgs(process.argv);

  const db = readDb();
  const { backupJsonPath, backupSqlitePath } = backupCurrent(db);

  if (role === "all") {
    writeDb({ users: [], sessions: [], jobs: [], applications: [] });
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

    writeDb(db);
  }

  // eslint-disable-next-line no-console
  console.log("Reset complete:");
  // eslint-disable-next-line no-console
  console.log(` - Updated DB: ${SQLITE_PATH}`);
  // eslint-disable-next-line no-console
  console.log(` - Cleared scope: ${role}`);
  // eslint-disable-next-line no-console
  console.log(` - Backup JSON: ${backupJsonPath}`);
  if (backupSqlitePath) {
    // eslint-disable-next-line no-console
    console.log(` - Backup SQLite: ${backupSqlitePath}`);
  }
}

main();
