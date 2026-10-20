// online.js end-to-end on the emulator: three clients in one process.
// Run inside `firebase emulators:exec --only firestore,auth` (see package.json).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createOnline } from "../online.js";
import { highCard } from "../demo/high-card.js";
const require = createRequire(import.meta.url);
const appMod = require("firebase/app");
const authMod = require("firebase/auth");
const fsMod = require("firebase/firestore");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const fsRead = require("fs"), path = require("path");

const CONFIG = { apiKey: "demo-key", authDomain: "demo-boardgames.firebaseapp.com", projectId: "demo-boardgames", appId: "1:1:web:1" };
const EMU = { host: "127.0.0.1", firestorePort: 8090, authPort: 9190 };

// Count document writes / reads per client (quota estimate).
const counts = { writes: 0, deletes: 0, reads: 0 };
const counted = Object.assign({}, fsMod, {
  setDoc: (...a) => { counts.writes++; return fsMod.setDoc(...a); },
  updateDoc: (...a) => { counts.writes++; return fsMod.updateDoc(...a); },
  addDoc: (...a) => { counts.writes++; return fsMod.addDoc(...a); },
  deleteDoc: (...a) => { counts.deletes++; return fsMod.deleteDoc(...a); },
  getDoc: (...a) => { counts.reads++; return fsMod.getDoc(...a); },
  getDocs: (...a) => fsMod.getDocs(...a).then((s) => { counts.reads += Math.max(1, s.size); return s; }),
  writeBatch: (db) => {
    const b = fsMod.writeBatch(db);
    return { set: (...a) => { counts.writes++; b.set(...a); return this; }, update: (...a) => { counts.writes++; b.update(...a); return this; }, delete: (...a) => { counts.deletes++; b.delete(...a); }, commit: () => b.commit() };
  },
  onSnapshot: (ref, next, err) => fsMod.onSnapshot(ref, (s) => { counts.reads += s.docChanges ? Math.max(1, s.docChanges().length) : 1; next(s); }, err),
});
const sdk = { app: appMod, auth: authMod, firestore: counted };

let pass = 0;
const ok = (l) => { pass++; console.log("  PASS  " + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(50); }
  throw new Error("timed out waiting for: " + label);
}
function client(name) {
  const o = createOnline({ game: highCard, gameId: "high-card", config: CONFIG, sdk, emulator: EMU, appName: name, botDelayMs: 20 });
  const c = { o, snap: null, errors: [] };
  o.on("change", (s) => { c.snap = s; });
  o.on("error", (m) => c.errors.push(m));
  return c;
}

const env = await initializeTestEnvironment({
  projectId: "demo-boardgames",
  firestore: { rules: fsRead.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: EMU.host, port: EMU.firestorePort },
});
await env.clearFirestore();

const A = client("alice"), B = client("bob"), C = client("carol");

// 1. create + join
const made = await A.o.createRoom({ name: "Alice", seats: ["human", "empty", "computer"], options: { handSize: 4 } });
assert.equal(made.ok, true, made.message);
assert.match(made.code, /^[A-HJ-NP-Z2-9]{5}$/);
await until(() => A.snap && A.snap.status === "lobby", "alice lobby");
ok("alice creates room " + made.code);

const j = await B.o.joinRoom(made.code.toLowerCase(), "Bob");
assert.equal(j.ok, true, j.message);
assert.equal(j.seat, 1);
await until(() => A.snap.seats[1].name === "Bob", "alice sees bob");
ok("bob joins by code (typed lower-case) into seat 1");

const jc = await C.o.joinRoom(made.code, "Carol");
assert.equal(jc.ok, false);
ok("carol is refused: room full (" + jc.message + ")");

const bad = await C.o.joinRoom("ZZZZZ", "Carol");
assert.equal(bad.ok, false);
ok("unknown code refused");

// 2. start, hidden hands
assert.equal((await B.o.start()).ok, false, "non-host can't start");
const w0 = counts.writes;
assert.equal((await A.o.start()).ok, true);
await until(() => A.snap.status === "playing" && B.snap && B.snap.status === "playing" && B.snap.mine, "both playing");
assert.equal(A.snap.mine.hand.length, 4);
assert.equal(B.snap.mine.hand.length, 4);
assert.ok(!A.snap.mine.hand.some((c) => B.snap.mine.hand.includes(c)), "different hands");
assert.ok(!("hands" in B.snap.pub));
ok("start: each player sees only their own 4 cards (start cost " + (counts.writes - w0) + " writes)");

// bob tries to read alice's hand directly with his own login → denied
const bobDb = fsMod.getFirestore(appMod.getApp("bob"));
const bobAuth = authMod.getAuth(appMod.getApp("bob"));
const aliceUid = authMod.getAuth(appMod.getApp("alice")).currentUser.uid;
await assert.rejects(fsMod.getDoc(fsMod.doc(bobDb, "games/high-card/rooms/" + made.code + "/hands/" + aliceUid)), /permission/i);
await assert.rejects(fsMod.getDoc(fsMod.doc(bobDb, "games/high-card/rooms/" + made.code + "/host/state")), /permission/i);
ok("bob's own login CANNOT read alice's hand or the full state");

// out of turn: after bob picks, a second pick in the same round is refused by the rules
const r1 = await B.o.act({ card: B.snap.mine.hand[0] });
assert.equal(r1.ok, true);
await until(() => A.snap.pub.chosen[1] === true || A.snap.pub.round === 1, "bob's pick lands");
const sneak = await fsMod.addDoc(fsMod.collection(bobDb, "games/high-card/rooms/" + made.code + "/actions"), { by: bobAuth.currentUser.uid, seat: 1, a: { card: B.snap.mine.hand[0] }, at: fsMod.serverTimestamp(), expireAt: fsMod.Timestamp.fromMillis(Date.now() + 864e5) }).then(() => "ok", (e) => e.code);
assert.match(String(sneak), /permission/);
ok("bob's second move in the same round is refused by the rules (out of turn)");

// play round 1 to the end (computer seat 2 is played by alice's browser)
const before = { ...counts };
await A.o.act({ card: A.snap.mine.hand[0] });
await until(() => A.snap.pub.round === 1 && B.snap.pub.round === 1, "round 1 done");
assert.equal(A.snap.pub.last.cards.length, 3);
ok("round 1 resolves with the computer's card; bob sees the reveal");
console.log(`        cost of one 3-seat round: ${counts.writes - before.writes} writes, ${counts.deletes - before.deletes} deletes, ${counts.reads - before.reads} reads (all clients)`);

// 3. host vanishes → bob takes over
await A.o._detach();
await env.withSecurityRulesDisabled(async (ctx) => {
  await fsMod.setDoc(fsMod.doc(ctx.firestore(), "games/high-card/rooms/" + made.code + "/presence/" + aliceUid), { at: fsMod.Timestamp.fromMillis(Date.now() - 120e3), expireAt: fsMod.Timestamp.fromMillis(Date.now() + 864e5) });
});
await until(() => B.snap.isHost, "bob becomes host", 20000);
ok("alice's heartbeat goes stale → bob takes over as host");

assert.equal((await B.o.setSeat(0, "computer")).ok, true);
await until(() => B.snap.seats[0].kind === "computer", "seat 0 computer");
for (let i = 0; i < 200 && B.snap.status !== "finished"; i++) {
  if (B.snap.myTurn && B.snap.mine && B.snap.mine.picked === null) await B.o.act({ card: B.snap.mine.hand[0] });
  await wait(50);
}
assert.equal(B.snap.status, "finished");
assert.equal(B.snap.pub.scores.reduce((a, b) => a + b, 0), 4);
ok("bob hands alice's seat to a computer and the game finishes (4 rounds, 4 points)");

// 4. reload: a fresh client object for bob resumes (localStorage shim)
// (resume uses localStorage, absent in node — covered in the browser test)

// 5. close deletes the room
assert.equal((await B.o.close()).ok, true);
let gone = null, leftovers = -1;
await env.withSecurityRulesDisabled(async (ctx) => { gone = (await fsMod.getDoc(fsMod.doc(ctx.firestore(), "games/high-card/rooms/" + made.code))).exists(); });
assert.equal(gone, false);
await env.withSecurityRulesDisabled(async (ctx) => {
  let n = 0;
  for (const sub of ["hands", "host", "actions", "presence", "joins"]) n += (await fsMod.getDocs(fsMod.collection(ctx.firestore(), "games/high-card/rooms/" + made.code + "/" + sub))).size;
  leftovers = n;
});
assert.equal(leftovers, 0, "sub-docs left: " + leftovers);
ok("host close() deletes the room and every sub-document");

// 6. a player leaves mid-game → their seat becomes a computer and play goes on
{
  const H = client("hana"), G = client("gus");
  const m = await H.o.createRoom({ name: "Hana", seats: ["human", "empty"], options: { handSize: 3 } });
  assert.equal((await G.o.joinRoom(m.code, "Gus")).ok, true);
  await until(() => H.snap.seats[1].kind === "human", "gus seated");
  await H.o.start();
  await until(() => G.snap && G.snap.status === "playing" && G.snap.mine, "gus playing");
  await G.o.leave();
  await until(() => H.snap.seats[1].kind === "computer", "gus's seat → computer");
  for (let i = 0; i < 200 && H.snap.status !== "finished"; i++) {
    if (H.snap.myTurn && H.snap.mine && H.snap.mine.picked === null) await H.o.act({ card: H.snap.mine.hand[0] });
    await wait(50);
  }
  assert.equal(H.snap.status, "finished");
  ok("gus leaves mid-game → his seat becomes a computer → game finishes");
  // gus can't act any more
  assert.equal((await G.o.act({ card: 1 })).ok, false);
  await H.o.close();
}

// 7. sweep(): expired room goes, live room stays
{
  const H = client("sweeper");
  const live = await H.o.createRoom({ name: "Live", seats: ["human", "empty"] });
  await wait(1500); // let createRoom's own background sweep finish first
  await env.withSecurityRulesDisabled(async (ctx) => {
    const old = fsMod.Timestamp.fromMillis(Date.now() - 3600e3); // an hour past the 10-min skew margin
    await fsMod.setDoc(fsMod.doc(ctx.firestore(), "games/coup/rooms/DEADR"), { gameId: "coup", expireAt: old });
    await fsMod.setDoc(fsMod.doc(ctx.firestore(), "games/coup/rooms/DEADR/presence/x"), { at: old, expireAt: old });
  });
  const n = await H.o.sweep({ force: true });
  let deadGone = null, liveThere = null;
  await env.withSecurityRulesDisabled(async (ctx) => {
    deadGone = !(await fsMod.getDoc(fsMod.doc(ctx.firestore(), "games/coup/rooms/DEADR"))).exists();
    liveThere = (await fsMod.getDoc(fsMod.doc(ctx.firestore(), "games/high-card/rooms/" + live.code))).exists();
  });
  assert.ok(n >= 2 && deadGone && liveThere, `swept ${n}, deadGone ${deadGone}, liveThere ${liveThere}`);
  ok(`sweep() deleted ${n} expired docs and left the live room alone`);
  await H.o.close();
}

console.log(`\nonline: ${pass} passed. Totals: ${counts.writes} writes, ${counts.deletes} deletes, ${counts.reads} reads.`);
assert.deepEqual(A.errors.filter((e) => !/permission/i.test(e)), [], "alice errors");
await env.cleanup();
process.exit(0);
