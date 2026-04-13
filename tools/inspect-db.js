const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = path.join(__dirname, "..");

function resolveDataDir() {
  const raw = String(process.env.SMART_HUNT_DATA_DIR || process.env.DATA_DIR || "").trim();
  if (!raw) return path.join(ROOT_DIR, "server-data");
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

const DATA_DIR = resolveDataDir();
const SQLITE_PATH = path.join(DATA_DIR, "db.sqlite");

function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`SQLite DB not found at: ${SQLITE_PATH}`);
    console.error("Start the server once to create it (or set SMART_HUNT_DATA_DIR / DATA_DIR).");
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(SQLITE_PATH);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all()
      .map((r) => r.name);

    const counts = {};
    for (const t of ["kv", "users", "sessions", "jobs", "applications"]) {
      if (!tables.includes(t)) continue;
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t};`).get().c;
    }

    const users = tables.includes("users")
      ? db
          .prepare(
            `SELECT id, role, email, name, company, createdAt,
                    length(profileJson) AS profileLen
             FROM users
             ORDER BY createdAt DESC
             LIMIT 10;`,
          )
          .all()
      : [];

    const sessions = tables.includes("sessions")
      ? db
          .prepare(
            `SELECT userId, createdAt, expiresAt, substr(token, 1, 8) AS tokenPrefix
             FROM sessions
             ORDER BY createdAt DESC
             LIMIT 10;`,
          )
          .all()
      : [];

    console.log(JSON.stringify({ sqlitePath: SQLITE_PATH, tables, counts, users, sessions }, null, 2));
  } finally {
    db.close();
  }
}

main();
