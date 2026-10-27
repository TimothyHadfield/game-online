// online.js end-to-end on the emulator: three clients in one process.
// Run inside `firebase emulators:exec --only firestore,auth` (see package.json).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
// ONLINE_JS=<path> runs the suite against another copy (to prove a new test fails on old code).
const { createOnline } = await import(process.env.ONLINE_JS ? pathToFileURL(process.env.ONLINE_JS).href : "../online.js");
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

// ONLY=10,12 runs just those sections and stops (the 2026-10-27 AFK / reclaim / host-drop checks run first).
// `node online.test.mjs 10` / `11,12` / `new` / `old` runs a part. npm test runs the parts as separate processes:
// with many clients in one process the emulator's Listen streams get corrupted (see progress.md Traps).
const PART = process.argv[2] || "all";
const only = /^[\d,]+$/.test(PART) ? PART.split(",") : process.env.ONLY ? process.env.ONLY.split(",") : null;
const want = (n) => PART !== "old" && (!only || only.includes(String(n)));
const backdate = (R, uid, ageMs) => env.withSecurityRulesDisabled(async (ctx) => {
  await fsMod.setDoc(fsMod.doc(ctx.firestore(), R + "/presence/" + uid), { at: fsMod.Timestamp.fromMillis(Date.now() - ageMs), expireAt: fsMod.Timestamp.fromMillis(Date.now() + 864e5) });
});
async function twoSeats(tag, options = {}) {
  const H = client(tag + "-host"), G = client(tag + "-guest");
  const m = await H.o.createRoom({ name: "Hana", seats: ["human", "empty"], options: Object.assign({ handSize: 3 }, options) });
  const jr = await G.o.joinRoom(m.code, "Gus");
  assert.equal(jr.ok, true, tag + ": join: " + jr.message);
  await until(() => H.snap.seats[1].kind === "human", tag + ": gus seated");
  await H.o.start();
  await until(() => G.snap && G.snap.status === "playing" && G.snap.mine, tag + ": gus playing");
  return { H, G, code: m.code, R: "games/high-card/rooms/" + m.code };
}

// 10. AFK (Clocktower, Clue): an away player's turn waits the room's timeout,
// then a computer plays the seat; the same phone gets it back when it returns.
if (want(10)) {
  const { H, G, code, R } = await twoSeats("afk", { turnTimeoutSec: 2, handSize: 6 });
  await H.o.act({ card: H.snap.mine.hand[0] });          // only gus is waited on now
  const gUid = G.o.uid;
  await G.o._detach();                                     // phone locked / tab closed
  const t0 = Date.now();
  await backdate(R, gUid, 200e3);                          // …long enough ago to count as away
  await until(() => H.snap.seats[1].kind === "computer", "a computer takes away gus's seat", 20000);
  assert.equal(H.snap.seats[1].auto, true, "seat is marked as played FOR gus");
  await until(() => H.snap.pub.round === 1, "the computer plays gus's card");
  ok(`away player: computer took the seat after ${((Date.now() - t0) / 1000).toFixed(1)} s (room timeout 2 s) and played`);
  const back = await G.o.joinRoom(code, "Gus");             // same phone opens the game again
  assert.equal(back.ok, true, back.message);
  assert.equal(back.seat, 1);
  await until(() => H.snap.seats[1].kind === "human" && H.snap.seats[1].name === "Gus" && !H.snap.seats[1].auto, "gus has his seat back", 15000);
  // (the computer may have played one more card for him in the meantime)
  await until(() => G.snap && G.snap.mine && G.snap.mine.hand.length > 0 && G.snap.mine.hand.length === G.snap.pub.handCounts[1] && !G.snap.autoPlay, "gus sees his hand again");
  ok("gus's phone comes back → seat 1 is his again, with his hand");
  // a player who is HERE is never hurried
  await until(() => H.snap.myTurn || G.snap.myTurn, "someone to move");
  if (H.snap.myTurn) await H.o.act({ card: H.snap.mine.hand[0] });
  await until(() => G.snap.myTurn, "gus to move");
  await wait(4000);
  assert.equal(H.snap.seats[1].kind, "human", "an online player was replaced");
  ok("an online player who takes his time keeps his seat");
  await H.o.close(); await G.o._detach();   // free the emulator streams
}

// 11. The host hands an away player's seat to a computer (Clue): their phone can take it back.
if (want(11)) {
  const { H, G, code } = await twoSeats("give");
  await G.o._detach();
  assert.equal((await H.o.setSeat(1, "computer")).ok, true);
  await until(() => H.snap.seats[1].kind === "computer", "host gives gus's seat to a computer");
  const back = await G.o.joinRoom(code, "Gus");
  assert.equal(back.ok, true, "phone could not reclaim its seat: " + back.message);
  await until(() => H.snap.seats[1].kind === "human" && H.snap.seats[1].name === "Gus", "seat handed back", 15000);
  ok("seat given to a computer → gus's phone reclaims it");
  await H.o.close(); await G.o._detach();   // free the emulator streams
}

// 12. Host drops without warning (Stratego): how long until the guest takes over? Was ~75–85 s.
if (want(12)) {
  const { H, G, R } = await twoSeats("drop");
  // A brief blip (one missed host beat) must NOT hand hosting away.
  await H.o._detach();
  await backdate(R, H.o.uid, 20e3);
  await wait(8000);
  assert.equal(G.snap.isHost, false, "guest took over after a 28 s blip");
  ok("28 s without a host beat: no takeover (a blip)");
  // Real drop: fresh beat, then silence.
  await backdate(R, H.o.uid, 0);
  const t0 = Date.now();
  await until(() => G.snap.isHost, "guest takes over", 70000);
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs < 50, "took " + secs + " s");
  ok(`host silent → guest is host after ${secs.toFixed(1)} s`);
  await until(() => G.snap.myTurn, "guest can play on");
  // right away, while the new host may still be loading the table
  const mv = await G.o.act({ card: G.snap.mine.hand[0] });
  assert.equal(mv.ok, true, "new host's first move: " + mv.message);
  ok("the new host's first move goes through");
  await G.o.close();
}

if (only || PART === "new") { console.log(`\nonline (new checks): ${pass} passed`); await env.cleanup(); process.exit(0); }


const A = client("alice"), B = client("bob"), C = client("carol");

// 1. create + join
const made = await A.o.createRoom({ name: "Alice", seats: ["human", "empty", "computer"], options: { handSize: 4 } });
assert.equal(made.ok, true, made.message);
assert.match(made.code, /^[A-HJ-NP-Z2-9]{5}$/);
await until(() => A.snap && A.snap.status === "lobby", "alice lobby");
ok("alice creates room " + made.code);
await until(() => A.snap.seats[0].online, "alice shows online");
assert.equal(A.snap.seats[1].online, false, "an EMPTY seat must not show as online");
assert.equal(A.snap.seats[2].online, true, "a computer seat shows as online");
ok("lobby: empty seat offline, computer and host online");

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
// v2: the room's toAct may still list bob (the host batches until the next person must act),
// so the rules may let the doc in; the host's own turn check must then drop it.
await until(() => B.snap.mine && B.snap.mine.picked != null, "bob sees his pick");
const picked = B.snap.mine.picked, handLeft = B.snap.mine.hand.length;
const sneak = await fsMod.addDoc(fsMod.collection(bobDb, "games/high-card/rooms/" + made.code + "/actions"), { by: bobAuth.currentUser.uid, seat: 1, a: { card: B.snap.mine.hand[0] }, at: fsMod.serverTimestamp(), expireAt: fsMod.Timestamp.fromMillis(Date.now() + 864e5) }).then(() => "ok", (e) => e.code);
await wait(1500);
assert.ok(/permission/.test(String(sneak)) || (A.o.view().pub.round === 0 && B.o.view().mine.picked === picked && B.o.view().mine.hand.length === handLeft), "bob's second pick took effect");
ok("bob's second move in the same round has no effect (" + (/permission/.test(String(sneak)) ? "refused by the rules" : "dropped by the host") + ")");

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
  // v2: a room write counts as a host beat too, so her last room write is 2 min old as well
  await fsMod.updateDoc(fsMod.doc(ctx.firestore(), "games/high-card/rooms/" + made.code), { updatedAt: fsMod.Timestamp.fromMillis(Date.now() - 120e3) });
});
await until(() => B.snap.isHost, "bob becomes host", 60000);   // v2: 40 s after the host's last sign (beat, room write or an answer to bob's move)
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
  for (const sub of ["hands", "host", "actions", "presence", "joins"]) { const q = await fsMod.getDocs(fsMod.collection(ctx.firestore(), "games/high-card/rooms/" + made.code + "/" + sub)); n += q.size; q.forEach((d) => console.log("        left: " + sub + "/" + d.id + " (alice " + aliceUid + ", bob " + B.o.uid + ")")); }
  leftovers = n;
});
assert.equal(leftovers, 0, "sub-docs left: " + leftovers);
ok("host close() deletes the room and every sub-document");

// 6. a player leaves mid-game → their seat becomes a computer and play goes on
{
  const H = client("hana"), G = client("gus");
  const m = await H.o.createRoom({ name: "Hana", seats: ["human", "empty"], options: { handSize: 3 } });
  { const jg = await G.o.joinRoom(m.code, "Gus"); assert.equal(jg.ok, true, "gus join: " + jg.message); }
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

// 8. seat takeover by name: rejoin is bound to the login (uid), not the typed name
{
  const H = client("tk-host"), A2 = client("tk-alice"), C2 = client("tk-carl"), E2 = client("tk-erin");
  const m = await H.o.createRoom({ name: "Hana", seats: ["human", "empty", "computer"], options: { handSize: 4 } });
  const R = "games/high-card/rooms/" + m.code;
  assert.equal((await A2.o.joinRoom(m.code, "Alice")).ok, true);
  await until(() => H.snap.seats[1].kind === "human", "alice seated");
  await H.o.start();
  await until(() => A2.snap && A2.snap.status === "playing" && A2.snap.mine, "alice playing");
  const aUid = A2.o.uid, cUid = (await C2.o.ready());
  const seatUid = async (i) => { let u; await env.withSecurityRulesDisabled(async (ctx) => { u = (await fsMod.getDoc(fsMod.doc(ctx.firestore(), R))).data().seatUids[i]; }); return u; };
  const goAway = async (c, uid) => {
    await c.o._detach();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await fsMod.setDoc(fsMod.doc(ctx.firestore(), R + "/presence/" + uid), { at: fsMod.Timestamp.fromMillis(Date.now() - 200e3), expireAt: fsMod.Timestamp.fromMillis(Date.now() + 864e5) });
    });
    await until(() => H.snap.seats[1].online === false, "host sees alice offline");
  };
  const asks = [];
  let answer = "deny";
  H.o.on("seatRequest", (rq) => { asks.push(rq); setTimeout(() => (answer === "allow" ? rq.allow() : rq.deny()), 200); });

  // alice goes away; carl types her name → must NOT get her seat
  await goAway(A2, aUid);
  const steal = await C2.o.joinRoom(m.code, "Alice");
  assert.equal(steal.ok, false, "carl took alice's seat by typing her name");
  assert.match(steal.message, /belongs to someone else/);
  assert.equal(await seatUid(1), aUid);
  assert.equal(asks.length, 1, "host was asked once");
  assert.equal(asks[0].seat, 1);
  ok("carl types away-alice's name → refused (host said no): " + steal.message);

  // alice's own browser (same uid) comes back → her seat, no question asked
  const back = await A2.o.joinRoom(m.code, "Alice");
  assert.equal(back.ok, true, back.message);
  assert.equal(back.seat, 1);
  await until(() => A2.snap && A2.snap.mine && A2.snap.mine.hand.length > 0, "alice has her hand back");
  assert.equal(asks.length, 1, "no request for a returning uid");
  ok("alice's same login rejoins → gets seat 1 and her hand back without asking");

  // alice away again; carl asks and the host ALLOWS → carl gets the seat
  await goAway(A2, aUid);
  answer = "allow";
  const granted = await C2.o.joinRoom(m.code, "Alice");
  assert.equal(granted.ok, true, granted.message);
  assert.equal(granted.seat, 1);
  assert.equal(await seatUid(1), cUid);
  await until(() => C2.snap && C2.snap.mine && C2.snap.mine.hand.length > 0, "carl has the hand");
  ok("host allows → carl gets alice's seat and its hand");
  // alice's old login is out now
  const late = await A2.o.joinRoom(m.code, "Alice");
  assert.equal(late.ok, false);
  ok("alice's old login can no longer walk back in while carl holds the seat (" + late.message + ")");

  // host offers the computer seat up → erin joins under any name, no question
  const before = asks.length;
  assert.equal((await H.o.setSeat(2, "open")).ok, true);
  await until(() => H.snap.seats[2].open === true, "seat 2 open");
  const ej = await E2.o.joinRoom(m.code, "Erin");
  assert.equal(ej.ok, true, ej.message);
  assert.equal(ej.seat, 2);
  assert.equal(asks.length, before, "open seat needs no approval");
  await until(() => H.snap.seats[2].kind === "human" && H.snap.seats[2].name === "Erin" && !H.snap.seats[2].open, "erin in seat 2");
  ok("host marks the computer seat open → erin takes it without a prompt");
  await H.o.close();
}

// 9. a guest one update behind taps a move: refused (rules), but no scary "not in this room" error
{
  const H = client("st-host"), G = client("st-guest");
  const m = await H.o.createRoom({ name: "Hana", seats: ["human", "empty"], options: { handSize: 3 } });
  const R = "games/high-card/rooms/" + m.code;
  { const jg = await G.o.joinRoom(m.code, "Gus"); assert.equal(jg.ok, true, "gus join (9): " + jg.message); }
  await until(() => H.snap.seats[1].kind === "human", "gus seated");
  await H.o.start();
  await until(() => G.snap && G.snap.status === "playing" && G.snap.myTurn && G.snap.mine, "gus to act");
  let res = null, stale = false;
  for (let tries = 0; tries < 5 && !stale; tries++) {
    // the server moves on (toAct no longer has gus) …
    await env.withSecurityRulesDisabled(async (ctx) => { await fsMod.updateDoc(fsMod.doc(ctx.firestore(), R), { toAct: [0] }); });
    // … and gus taps before his copy has caught up
    stale = G.o.view().toAct.includes(1);
    if (stale) res = await G.o.act({ card: G.snap.mine.hand[0] });
    else await env.withSecurityRulesDisabled(async (ctx) => { await fsMod.updateDoc(fsMod.doc(ctx.firestore(), R), { toAct: [0, 1] }); }).then(() => until(() => G.o.view().toAct.includes(1), "toAct back"));
  }
  assert.ok(stale, "could not catch the guest one update behind");
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.message, /not be in this room|server said no/i, "stale tap shows the scary error");
  assert.deepEqual(G.errors.filter((e) => /server said no/i.test(e)), [], "error event fired for a stale tap");
  assert.equal(res.stale, true);
  ok("stale tap refused quietly: " + res.message);
  // a real non-member still gets the real error
  const X = client("st-stranger");
  await X.o.ready();
  const xDb = fsMod.getFirestore(appMod.getApp("st-stranger"));
  await assert.rejects(fsMod.addDoc(fsMod.collection(xDb, R + "/actions"), { by: X.o.uid, seat: 1, a: {}, at: fsMod.serverTimestamp(), expireAt: fsMod.Timestamp.fromMillis(Date.now() + 864e5) }), /permission/i);
  ok("a stranger's move is still refused by the rules");
  await H.o.close();
}

console.log(`\nonline: ${pass} passed. Totals: ${counts.writes} writes, ${counts.deletes} deletes, ${counts.reads} reads.`);
assert.deepEqual(A.errors.filter((e) => !/permission/i.test(e)), [], "alice errors");
await env.cleanup();
process.exit(0);
