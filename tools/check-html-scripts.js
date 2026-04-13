const fs = require("node:fs");
const vm = require("node:vm");

function extractScripts(html) {
  const scripts = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    scripts.push(match[1] || "");
  }
  return scripts;
}

function checkFile(filePath) {
  const html = fs.readFileSync(filePath, "utf8");
  const scripts = extractScripts(html);
  const results = [];
  scripts.forEach((code, idx) => {
    const trimmed = String(code || "").trim();
    if (!trimmed) return;
    try {
      // Syntax check only.
      new vm.Script(trimmed, { filename: `${filePath}:script[${idx}]` });
      results.push({ index: idx, ok: true });
    } catch (err) {
      results.push({ index: idx, ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
  return { filePath, scripts: scripts.length, results };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node tools/check-html-scripts.js <file1.html> [file2.html...]");
  process.exit(2);
}

const out = files.map(checkFile);
console.log(JSON.stringify(out, null, 2));
