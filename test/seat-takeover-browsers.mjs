// Three separate headless browsers against the REAL project: someone typing an away
// player's name must NOT get their seat unless the host taps Allow on the built-in card.
//   node test/seat-takeover-browsers.mjs [url] [--engine chromium|webkit] [--shots dir]
// Takes ~2 minutes (a player only counts as away after 75 s without a heartbeat).
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
const opts = engine === "webkit" ? iphone : { viewport: { width: 1280, height: 800 } };
const bA = await pw[engine].launch(), bB = await pw[engine].launch(), bC = await pw[engine].launch();
const A = await (await bA.newContext(opts)).newPage();
const B = await (await bB.newContext(opts)).newPage();
const C = await (await bC.newContext(opts)).newPage();
const errs = [];
for (const [n, p] of [["A", A], ["C", C]]) {
  p.on("console", (m) => { if (m.type() === "error" && !/BloomFilter/.test(m.text())) errs.push(n + ": " + m.text()); });
  p.on("pageerror", (e) => errs.push(n + " pageerror: " + e.message));
}

await A.goto(url); await B.goto(url); await C.goto(url);
await A.fill("#name", "Alice"); await A.click("#create");
await A.waitForSelector("#lobby:not(.hidden)", { timeout: 20000 });
const code = (await A.textContent("#code")).trim();
console.log("room code", code);
await B.fill("#name", "Bob"); await B.fill("#codeIn", code); await B.click("#join");
await A.waitForFunction(() => /Bob/.test(document.querySelector("#seats").textContent), null, { timeout: 25000 });
await A.click("#start");
await B.waitForFunction(() => document.querySelectorAll("#hand .card").length === 3, null, { timeout: 20000 });
const bobHand = (await B.$$eval("#hand .card", (els) => els.map((e) => e.textContent.trim()))).join(" ");
console.log("game on; Bob holds", bobHand, "— Bob's browser now closes");
await bB.close();

const bobAway = () => A.waitForFunction(() => {
  const row = [...document.querySelectorAll("#table .seat")].find((r) => /Bob/.test(r.textContent));
  return row && !row.querySelector(".dot.on");
}, null, { timeout: 120000, polling: 1000 });
await bobAway();
console.log("PASS host sees Bob offline");

// Carl types "Bob" → host gets the card → Deny
const joinAsBob = async () => { await C.fill("#name", "Bob"); await C.fill("#codeIn", code); await C.click("#join"); };
await joinAsBob();
await A.waitForSelector("#online-seat-requests button[data-answer=deny]", { timeout: 25000 });
const card = await A.$eval("#online-seat-requests", (b) => {
  const r = b.getBoundingClientRect();
  return { text: b.textContent, top: r.top, bottom: r.bottom, vh: innerHeight, left: r.left, right: r.right, vw: innerWidth, sw: document.documentElement.scrollWidth };
});
console.log("host card:", JSON.stringify(card));
if (card.bottom > card.vh || card.top < 0 || card.left < 0 || card.right > card.vw) fail("prompt card not fully on screen");
if (card.sw > card.vw) fail("horizontal overflow on the host page");
if (shots) await A.screenshot({ path: shots + "/host-prompt-" + engine + ".png" });
if (/[0-9]/.test(bobHand) && (await C.textContent("body")).includes(bobHand)) fail("Carl sees Bob's hand while waiting");
await A.click("#online-seat-requests button[data-answer=deny]");
await C.waitForFunction(() => /belongs to someone else/.test(document.querySelector("#err").textContent), null, { timeout: 15000 });
if (shots) await C.screenshot({ path: shots + "/joiner-denied-" + engine + ".png" });
if (await C.$("#game:not(.hidden)")) fail("Carl is in the game after Deny");
console.log("PASS Deny → Carl told:", (await C.textContent("#err")).trim());
if (await A.$("#online-seat-requests")) fail("prompt still showing after Deny");

// Carl asks again → Allow → he gets Bob's seat
await joinAsBob();
await A.waitForSelector("#online-seat-requests button[data-answer=allow]", { timeout: 25000 });
await A.click("#online-seat-requests button[data-answer=allow]");
await C.waitForSelector("#game:not(.hidden)", { timeout: 20000 });
await C.waitForFunction(() => document.querySelectorAll("#hand .card").length >= 1, null, { timeout: 20000 });
console.log("PASS Allow → Carl sits in Bob's seat with", (await C.$$eval("#hand .card", (e) => e.length)), "cards");
if (shots) await C.screenshot({ path: shots + "/joiner-allowed-" + engine + ".png" });

await A.click("#leave2");
await A.waitForTimeout(1500);
const real = errs.filter((e) => !/access control checks/.test(e));
if (real.length) fail("console errors:\n" + real.join("\n"));
console.log("PASS no console errors (" + engine + ")");
await bA.close(); await bC.close();
