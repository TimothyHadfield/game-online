// Smoke test against the REAL th-board-games project (two clients, full game).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createOnline } from "../online.js";
import { highCard } from "../demo/high-card.js";
const require = createRequire(import.meta.url);
const sdk = { app: require("firebase/app"), auth: require("firebase/auth"), firestore: require("firebase/firestore") };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, l, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return; await wait(100); } throw new Error("timeout: " + l); }
const mk = (n) => { const o = createOnline({ game: highCard, sdk, appName: n, botDelayMs: 100 }); const c = { o, s: null }; o.on("change", (s) => (c.s = s)); o.on("error", (e) => console.log(n, "error:", e)); return c; };
const A = mk("a"), B = mk("b");
for (const gid of ["skull-king", "clocktower", "hearts"]) {
  const o = createOnline({ game: highCard, gameId: gid, sdk, appName: "probe-" + gid });
  const r = await o.createRoom({ name: "Probe", seats: ["human", "empty"] });
  assert.equal(r.ok, true, gid + ": " + r.message); await o.close(); console.log("create+close ok for", gid);
}
const m = await A.o.createRoom({ name: "Alice", seats: ["human", "empty", "computer"] });
assert.equal(m.ok, true, m.message); console.log("room", m.code);
assert.equal((await B.o.joinRoom(m.code, "Bob")).ok, true);
await A.o.start();
await until(() => B.s && B.s.status === "playing" && B.s.mine, "playing");
const t0 = Date.now();
while (A.s.status !== "finished") {
  for (const c of [A, B]) if (c.s.myTurn && c.s.mine && c.s.mine.picked === null) await c.o.act({ card: c.s.mine.hand[0] });
  await wait(150); if (Date.now() - t0 > 60000) throw new Error("game stuck");
}
await until(() => B.s.status === "finished", "B finished");
console.log("finished in", Date.now() - t0, "ms; scores", A.s.pub.scores);
await A.o.close(); process.exit(0);
