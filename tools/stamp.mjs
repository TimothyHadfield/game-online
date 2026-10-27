// The cache stamp every game puts on its copy of online.js: the first 8 hex digits of online.js's git
// blob id (line endings normalised), so it changes exactly when online.js changes.
//
//   node tools/stamp.mjs                      prints the stamp, e.g. a3d0418b
//   node tools/stamp.mjs --check <game>...    lists every reference to the game's copy (js/online.js, or
//                                             js/game-online.js in Cribbage) and says OK or STALE; exit 1
//                                             if any is stale or missing
//
// After re-copying online.js into a game: set every import of it to "online.js?v=<stamp>", bump the
// ?v= of the file that holds that import (and its pwa.js data-version), then run --check.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const blob = buf => {
  const t = Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha1").update(`blob ${t.length}\0`).update(t).digest("hex");
};
const KIT = join(dirname(fileURLToPath(import.meta.url)), "..", "online.js");
const REF = blob(readFileSync(KIT));
const STAMP = REF.slice(0, 8);
const args = process.argv.slice(2);
if (args[0] !== "--check") { console.log(STAMP); process.exit(0); }

let bad = 0;
for (const dir of args.slice(1)) {
  const name = ["online.js", "game-online.js"].find(n => existsSync(join(dir, "js", n)) && blob(readFileSync(join(dir, "js", n))) === REF);
  if (!name) { console.log(`${basename(dir)}: js/online.js is not a copy of this online.js (re-copy it)`); bad++; continue; }
  const kit = join(dir, "js", name);
  const files = [join(dir, "index.html")];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(m?js|html)$/.test(f) && p !== kit) files.push(p); } };
  walk(join(dir, "js"));
  const re = new RegExp(`(['"\`])((?:[^'"\`\\s]*/)?${name.replace(".", "\\.")})(\\?v=[^'"\`]*)?(['"\`])(\\s*\\+\\s*\\w+)?`, "g");
  const hits = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) {
      const stamp = (m[3] || "") + (m[5] ? m[5].trim() : "");
      const ok = stamp === "?v=" + STAMP;
      if (!ok) bad++;
      hits.push(`  ${ok ? "OK   " : "STALE"} ${f.slice(dir.length + 1)}:${src.slice(0, m.index).split("\n").length} ${m[2]}${stamp}`);
    }
  }
  if (!hits.length) { bad++; hits.push("  MISSING no reference to " + name + " found"); }
  console.log(`${basename(dir)} (want ?v=${STAMP})\n${hits.join("\n")}`);
}
process.exit(bad ? 1 : 0);
