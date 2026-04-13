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

function summarizeSeekerProfile(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const avatar = typeof p.avatarDataUrl === "string" ? p.avatarDataUrl : "";
  const semi = avatar.startsWith("data:") ? avatar.indexOf(";") : -1;
  const avatarMime = semi > -1 ? avatar.slice(5, semi) : "";
  const resumes = Array.isArray(p.resumes) ? p.resumes : [];
  const resumeNames = resumes
    .map((r) => (r && typeof r === "object" ? String(r.name || "").trim() : ""))
    .filter(Boolean)
    .slice(0, 5);
  const skills = Array.isArray(p.skills) ? p.skills.filter(Boolean) : [];
  const contact = p.contact && typeof p.contact === "object" ? p.contact : {};

  return {
    name: typeof p.name === "string" ? p.name : "",
    title: typeof p.title === "string" ? p.title : "",
    aboutLen: typeof p.about === "string" ? p.about.length : 0,
    skillsCount: skills.length,
    contact: {
      email: typeof contact.email === "string" ? contact.email : "",
      phone: typeof contact.phone === "string" ? contact.phone : "",
      location: typeof contact.location === "string" ? contact.location : "",
      linkedin: typeof contact.linkedin === "string" ? contact.linkedin : "",
      github: typeof contact.github === "string" ? contact.github : "",
    },
    avatar: {
      mime: avatarMime,
      len: avatar.length,
      isDataUrl: avatar.startsWith("data:"),
    },
    resumes: {
      count: resumes.length,
      firstNames: resumeNames,
    },
  };
}

function summarizeEmployerProfile(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const logo = typeof p.logoSrc === "string" ? p.logoSrc : "";
  const semi = logo.startsWith("data:") ? logo.indexOf(";") : -1;
  const logoMime = semi > -1 ? logo.slice(5, semi) : "";
  const contact = p.contact && typeof p.contact === "object" ? p.contact : {};
  const info = p.info && typeof p.info === "object" ? p.info : {};

  return {
    companyName: typeof p.companyName === "string" ? p.companyName : "",
    companyIndustry: typeof p.companyIndustry === "string" ? p.companyIndustry : "",
    companyLocation: typeof p.companyLocation === "string" ? p.companyLocation : "",
    aboutLen: typeof p.aboutText === "string" ? p.aboutText.length : 0,
    info: {
      industry: typeof info.industry === "string" ? info.industry : "",
      size: typeof info.size === "string" ? info.size : "",
      founded: typeof info.founded === "string" ? info.founded : "",
      website: typeof info.website === "string" ? info.website : "",
    },
    contact: {
      email: typeof contact.email === "string" ? contact.email : "",
      phone: typeof contact.phone === "string" ? contact.phone : "",
      location: typeof contact.location === "string" ? contact.location : "",
      linkedin: typeof contact.linkedin === "string" ? contact.linkedin : "",
    },
    logo: {
      mime: logoMime,
      len: logo.length,
      isDataUrl: logo.startsWith("data:"),
    },
  };
}

function summarizeProfileByRole(role, profile) {
  const r = String(role || "").trim().toLowerCase();
  if (r === "employer") return summarizeEmployerProfile(profile);
  if (r === "seeker") return summarizeSeekerProfile(profile);
  return { keys: profile && typeof profile === "object" ? Object.keys(profile).sort() : [] };
}

function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`SQLite DB not found at: ${SQLITE_PATH}`);
    console.error("Start the server once to create it (or set SMART_HUNT_DATA_DIR / DATA_DIR).");
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(SQLITE_PATH);
  try {
    const rows = db
      .prepare(
        `SELECT id, role, email, createdAt, profileJson
         FROM users
         ORDER BY createdAt DESC
         LIMIT 5;`,
      )
      .all();

    const out = rows.map((r) => {
      let profile = null;
      try {
        profile = r.profileJson ? JSON.parse(r.profileJson) : null;
      } catch {
        profile = null;
      }
      return {
        id: r.id,
        role: r.role,
        email: r.email,
        createdAt: r.createdAt,
        profileSummary: summarizeProfileByRole(r.role, profile),
      };
    });

    console.log(JSON.stringify(out, null, 2));
  } finally {
    db.close();
  }
}

main();
