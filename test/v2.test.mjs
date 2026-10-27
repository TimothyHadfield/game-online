// online.js v2 (2026-10-27): about one room write per turn. Fast checks on the
// billing fake (fakefs.mjs) with a virtual clock — no emulator needed.
//   node v2.test.mjs                      this online.js
//   ONLINE_JS=<old copy> node v2.test.mjs (fail-first: the old version fails the cost checks)
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { makeClock, makeSdk } from "./fakefs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ONLINE = process.env.ONLINE_JS ? path.resolve(process.env.ONLINE_JS) : path.join(here, "../online.js");

// "Count": on your turn add 1 or 2 (up to 3 times), then end. First to 30 wins.
// Secret: how many adds each seat has made in total.
const count = {
  id: "count", minSeats: 2, maxSeats: 6,
  setup(n) { return { n, total: 0, turn: 0, adds: 0, secret: Array(n).fill(0) }; },
  toAct(s) { return s.total >= 30 ? [] : [s.turn]; },
  apply(s, seat, a) {
    if (a.end) { if (!s.adds) throw new Error("add first"); s.turn = (s.turn + 1) % s.n; s.adds = 0; return s; }
    if (s.adds >= 3 || ![1, 2].includes(a.add)) throw new Error("bad add");
    s.total += a.add; s.adds++; s.secret[seat]++;
    return s;
  },
  publicView(s) { return { total: s.total, turn: s.turn, adds: s.adds }; },
  privateView(s, seat) { return { mine: s.secret[seat] }; },
  bot(ctx) { return ctx.pub.adds >= 2 ? { end: true } : { add: 1 }; },
  isOver(s) { return s.total >= 30; },
};

let pass = 0;
const ok = (l) => { pass++; console.log("  PASS  " + l); };
const fails = [];
async function check(label, fn) {
  try { await fn(); ok(label); } catch (e) { fails.push(label); console.log("  FAIL  " + label + "\n          -> " + e.message.split("\n")[0]); }
}

async function table({ seats = ["human", "empty", "computer", "computer"] } = {}) {
  const clock = makeClock(); clock.install();
  const sdk = makeSdk(clock); sdk.rulesCheckUpdatedAt = true;
  const { createOnline } = await import(pathToFileURL(ONLINE).href + "?" + Math.random());
  const mk = (name) => {
    const o = createOnline({ game: count, gameId: "count", sdk, appName: name, botDelayMs: 500 });
    const c = { o, snap: null, seen: [], errors: [] };
    o.on("change", (s) => { c.snap = s; if (s.pub) c.seen.push(s.pub.total + "@" + (s.toAct || []).join(",")); });
    o.on("error", (m) => c.errors.push(m));
    return c;
  };
  const H = mk("host"), G = mk("guest");
  const drive = async (p, ms = 60000) => { let d = false, v; p.then((x) => { d = true; v = x; }); await clock.run(() => d, ms); return v; };
  const made = await drive(H.o.createRoom({ name: "Hana", seats }));
  await drive(G.o.joinRoom(made.code, "Gus"));
  await clock.run(() => H.snap && H.snap.seats[1].kind === "human", 30000);
  await drive(H.o.start());
  await clock.run(() => G.snap && G.snap.status === "playing" && G.snap.pub, 30000);
  const roomWrites = () => sdk.tag.room ? sdk.tag.room.writes : 0;
  const presWrites = () => sdk.tag.presence ? sdk.tag.presence.writes : 0;
  const act = (c, a) => drive(c.o.act(a));
  const done = async () => { for (const c of [H, G]) await drive(c.o._detach()); clock.uninstall(); };
  return { clock, sdk, H, G, act, drive, roomWrites, presWrites, done, code: made.code };
}

console.log("v2: about one room write per turn");

await check("a full round (host turn, friend's 3-move turn, 2 computers) writes the room at most twice", async () => {
  const T = await table();
  const { H, G, act, clock } = T;
  const w0 = T.roomWrites();
  await act(H, { add: 1 }); await clock.run(() => false, 3000);
  await act(H, { add: 2 }); await clock.run(() => false, 3000);
  await act(H, { end: true });
  await T.clock.run(() => G.snap.myTurn, 10000);
  await act(G, { add: 2 }); await clock.run(() => false, 4000);
  await act(G, { add: 1 }); await clock.run(() => false, 4000);
  await act(G, { end: true });
  await T.clock.run(() => H.snap.myTurn, 30000);
  const n = T.roomWrites() - w0;
  await T.done();
  assert.ok(n <= 2, `room written ${n} times for one round`);
});

await check("the friend sees each of their own moves at once (answered in their private doc)", async () => {
  const T = await table();
  const { H, G, act, clock } = T;
  await act(H, { add: 1 }); await act(H, { end: true });
  await clock.run(() => G.snap.myTurn, 10000);
  const t = G.snap.pub.total;
  await act(G, { add: 2 });
  await clock.run(() => G.snap.pub.total === t + 2, 1000);
  assert.equal(G.snap.pub.total, t + 2, "friend's add not shown within 1 s");
  assert.equal(G.snap.myTurn, true, "still the friend's turn");
  await T.done();
});

await check("the friend watches the computers' moves one by one (replayed frames), then gets the turn", async () => {
  const T = await table({ seats: ["human", "computer", "computer", "empty"] });
  const { H, G, act, clock } = T;
  await act(H, { add: 1 }); await act(H, { end: true });
  await clock.run(() => G.snap.myTurn, 30000);
  const seenBots = new Set(G.seen.filter((x) => /@[12]$/.test(x)));
  await T.done();
  assert.ok(seenBots.size >= 4, "friend saw only " + seenBots.size + " computer steps: " + [...seenBots].join(" "));
});

await check("while only the friend is thinking (3 min), the host beats at most 4 times", async () => {
  const T = await table({ seats: ["human", "empty"] });
  const { H, G, act, clock } = T;
  await act(H, { add: 1 }); await act(H, { end: true });
  await clock.run(() => G.snap.myTurn, 10000);
  const p0 = T.presWrites();
  await clock.run(() => false, 180000);
  const n = T.presWrites() - p0;   // host + friend beats
  await T.done();
  assert.ok(n <= 7, `${n} heartbeat writes in 3 min (host + friend)`);
});

await check("host vanishes during the friend's turn → no takeover while he thinks; his move then goes through after a takeover", async () => {
  const T = await table({ seats: ["human", "empty"] });
  const { H, G, act, clock } = T;
  await act(H, { add: 1 }); await act(H, { end: true });
  await clock.run(() => G.snap.myTurn, 10000);
  await T.drive(H.o._detach());          // host's phone dies
  await clock.run(() => G.snap.isHost, 90000);
  const t = G.snap.pub.total;
  await act(G, { add: 2 });
  await clock.run(() => G.snap.isHost && G.snap.pub.total === t + 2, 120000);
  const ok2 = G.snap.isHost && G.snap.pub.total === t + 2;
  await T.done();
  assert.ok(ok2, "friend's move after the host vanished never went through (isHost " + G.snap.isHost + ", total " + G.snap.pub.total + ")");
});

await check("a screen that edits snap.pub cannot change the host's real game", async () => {
  const T = await table({ seats: ["human", "empty"] });
  const { H, act } = T;
  await act(H, { add: 1 });
  H.snap.pub.total = 999;
  const v = H.o.view();
  await T.done();
  assert.equal(v.pub.total, 1);
});

// A friend's move costs 2 writes (the move + the answer); a host turn about 2 (room + full state).
await check("a 2-player game of 3-move turns costs under 6.5 writes per turn (was ~10.6)", async () => {
  const T = await table({ seats: ["human", "empty"] });
  const { H, G, act, clock, sdk } = T;
  const w0 = sdk.totals().writes;
  let turns = 0;
  for (let i = 0; i < 200 && !(H.snap.status === "finished" && G.snap.status === "finished"); i++) {
    for (const c of [H, G]) {
      if (c.snap.myTurn) { await act(c, c.snap.pub.adds >= 2 ? { end: true } : { add: 2 }); if (c.snap.pub.adds === 0) turns++; await clock.run(() => false, 3000); }
    }
    await clock.run(() => false, 1000);
  }
  const w = sdk.totals().writes - w0;
  await T.done();
  assert.ok(turns > 3, "game didn't run");
  assert.ok(w / turns < 6.5, `${w} writes for ${turns} turns`);
});

console.log(`\nv2: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
