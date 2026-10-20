// Two separate headless browsers play the High Card demo against the REAL project.
//   node test/two-browsers.mjs [url] [--engine chromium|webkit] [--shots dir]
// Proves: create room, join by code, hidden hands, reload mid-game resumes, play to the end.
// Needs playwright (e.g. NODE_PATH=~/.claude/tools/node_modules).
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(join(homedir(), ".claude/tools/") + "x.js");
const pw = require("playwright");

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http")) || "https://timothyhadfield.github.io/game-online/demo/";
const engine = args.includes("--engine") ? args[args.indexOf("--engine") + 1] : "webkit";
const shots = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };

const iphone = pw.devices["iPhone 13"] ? { ...pw.devices["iPhone 13"], viewport: { width: 393, height: 659 } } : {};
const opts = engine === "webkit" ? iphone : {};
const bA = await pw[engine].launch(), bB = await pw[engine].launch();   // two separate browsers = two logins
const A = await (await bA.newContext(opts)).newPage(), B = await (await bB.newContext(opts)).newPage();
const errs = [], reloadNoise = [];
let reloading = false;
for (const [n, p] of [["A", A], ["B", B]]) {
  p.on("console", (m) => { if (m.type() === "error" && !/BloomFilter/.test(m.text())) errs.push(n + ": " + m.text()); });
  p.on("pageerror", (e) => (reloading && n === "B" ? reloadNoise : errs).push(n + " pageerror: " + e.message));
}
const hand = (p) => p.$$eval("#hand .card", (els) => els.map((e) => e.textContent.trim()));

await A.goto(url); await B.goto(url);
await A.fill("#name", "Alice"); await A.click("#create");
await A.waitForSelector("#lobby:not(.hidden)", { timeout: 20000 });
const code = (await A.textContent("#code")).trim();
console.log("room code", code);
if (shots) await A.screenshot({ path: shots + "/lobby.png" });

await B.fill("#name", "Bob"); await B.fill("#codeIn", code); await B.click("#join");
await A.waitForFunction(() => /Bob/.test(document.querySelector("#seats").textContent), null, { timeout: 25000 });
console.log("Bob is seated");
await A.click("#start");
await A.waitForSelector("#game:not(.hidden)", { timeout: 20000 });
await B.waitForSelector("#game:not(.hidden)", { timeout: 20000 });
await B.waitForFunction(() => document.querySelectorAll("#hand .card").length === 3, null, { timeout: 20000 });

const hA = await hand(A), hB = await hand(B);
console.log("Alice sees", hA.join(" "), "| Bob sees", hB.join(" "));
if (hA.some((c) => hB.includes(c))) fail("hands overlap");
const bodyB = await B.textContent("body");
if (hA.some((c) => bodyB.includes(c))) fail("Bob's page shows one of Alice's cards before the reveal");
console.log("PASS hidden hands: Bob's page shows none of Alice's cards");
if (shots) { await A.screenshot({ path: shots + "/alice-game.png" }); await B.screenshot({ path: shots + "/bob-game.png" }); }

// round 1
await A.click("#hand button.card"); await B.click("#hand button.card");
await A.waitForFunction(() => /Round <b>2|Round 2/.test(document.querySelector("#status").innerHTML), null, { timeout: 20000 });
console.log("PASS round 1 resolved");

// Bob reloads mid-game → resume
reloading = true;
await B.reload();
await B.waitForSelector("#game:not(.hidden)", { timeout: 25000 });
await B.waitForFunction(() => document.querySelectorAll("#hand button.card").length === 2, null, { timeout: 20000 });
reloading = false;
console.log("PASS Bob reloaded and was put back in his seat with 2 cards");

for (let r = 0; r < 2; r++) {
  await A.click("#hand button.card"); await B.click("#hand button.card");
  await A.waitForTimeout(1500);
}
await A.waitForFunction(() => /Game over/.test(document.querySelector("#status").textContent), null, { timeout: 25000 });
await B.waitForFunction(() => /Game over/.test(document.querySelector("#status").textContent), null, { timeout: 25000 });
console.log("PASS both see:", (await B.textContent("#status")).trim());
if (shots) { await A.screenshot({ path: shots + "/alice-end.png" }); await B.screenshot({ path: shots + "/bob-end.png" }); }
await A.click("#leave2");   // host closes the room → deleted
await A.waitForTimeout(1500);

if (reloadNoise.length) console.log(`note: ${reloadNoise.length} aborted-request messages while Bob's page reloaded (WebKit reports cut-off Firestore channels this way)`);
if (errs.length) fail("console errors:\n" + errs.join("\n"));
console.log("PASS no console errors (" + engine + ")");
await bA.close(); await bB.close();
