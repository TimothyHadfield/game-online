// Local rooms (no network): createLocal + the High Card demo game.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { highCard } from "../demo/high-card.js";
// ONLINE_JS=<path> runs the suite against another copy (to prove a new test fails on old code).
const { createLocal, createOnline } = await import(process.env.ONLINE_JS ? pathToFileURL(process.env.ONLINE_JS).href : "../online.js");

let pass = 0;
const ok = (label) => { pass++; console.log("  PASS  " + label); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// seeded rng so runs repeat
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 1. Engine: 2,000 random games, bots only, every invariant.
for (let g = 0; g < 2000; g++) {
  const rng = mulberry(g + 1);
  const n = 2 + (g % 5);
  let s = highCard.setup(n, { handSize: 1 + (g % 8) }, rng, []);
  const all = s.hands.flat();
  assert.equal(new Set(all).size, all.length, "no duplicate cards dealt");
  while (!highCard.isOver(s)) {
    const toAct = highCard.toAct(s);
    assert.ok(toAct.length > 0);
    for (const seat of toAct) {
      const ctx = { pub: highCard.publicView(s), mine: highCard.privateView(s, seat), state: s };
      s = highCard.apply(JSON.parse(JSON.stringify(s)), seat, highCard.bot(ctx, seat, rng));
    }
  }
  assert.equal(s.scores.reduce((a, b) => a + b, 0), s.rounds, "one point per round");
}
ok("2,000 bot-only games end with one point per round, no duplicate cards");

// 2. Secrecy: the public view never shows a card that is still in someone's hand.
{
  const s = highCard.setup(4, {}, mulberry(7), []);
  const pub = JSON.stringify(highCard.publicView(s));
  for (const h of s.hands) for (const c of h) assert.ok(!new RegExp("\\b" + c + "\\b").test(JSON.stringify(highCard.publicView(s).chosen)), "chosen is booleans only");
  assert.ok(!pub.includes("hands"), "public view has no hands field");
  assert.deepEqual(highCard.privateView(s, 1).hand, s.hands[1]);
  ok("public view hides hands; private view is that seat's hand only");
}

// 3. Illegal moves throw (apply must reject cards you don't hold).
{
  const s = highCard.setup(2, {}, mulberry(3), []);
  const notMine = s.hands[1][0];
  assert.throws(() => highCard.apply(JSON.parse(JSON.stringify(s)), 0, { card: notMine }));
  ok("apply rejects a card from another hand");
}

// 4. createLocal: one human + three computers plays to the end.
{
  const room = createLocal({ game: highCard, seats: ["human", "computer", "computer", "computer"], names: ["You"], botDelayMs: 1, rng: mulberry(11) });
  let last = null, errors = 0;
  room.on("change", (snap) => { last = snap; });
  room.on("error", () => errors++);
  room.start();
  assert.equal(last.mode, "local");
  assert.equal(last.seats[0].name, "You");
  for (let i = 0; i < 50 && last.status !== "finished"; i++) {
    if (last.myTurn) room.act({ card: last.mine.hand[0] });
    await wait(5);
  }
  assert.equal(last.status, "finished");
  assert.equal(errors, 0);
  // wrong-turn and illegal moves are refused, not applied
  const r = room.act({ card: 999 }, 0);
  assert.equal(r.ok, false);
  ok("createLocal: human + 3 computers finishes; moves after the end are refused");
}

// 5. createLocal pass-the-phone: two humans, act for a named seat.
{
  const room = createLocal({ game: highCard, seats: ["human", "human"], botDelayMs: 1, rng: mulberry(5) });
  room.start();
  const v1 = room.view(1);
  assert.equal(v1.mySeat, 1);
  assert.ok(Array.isArray(v1.mine.hand));
  assert.equal(room.act({ card: room.view(0).mine.hand[0] }, 0).ok, true);
  assert.equal(room.act({ card: room.view(0).mine.hand[0] }, 0).ok, false, "seat 0 already chose this round");
  assert.equal(room.act({ card: room.view(1).mine.hand[0] }, 1).ok, true);
  assert.equal(room.view(0).pub.round, 1);
  ok("pass-the-phone: per-seat views, no double moves");
}

// 6. An empty seat never shows as online.
{
  const room = createLocal({ game: highCard, seats: ["human", "empty", "computer"], botDelayMs: 1, rng: mulberry(9) });
  assert.deepEqual(room.view(0).seats.map((s) => s.online), [true, false, true]);
  room.close();
  ok("local snapshot: empty seat offline, human and computer online");
}

// 7. Online can't load (no internet: the Firebase SDK download fails) → a plain
// message, not the browser's "Importing a module script failed." (Coup, Evolution).
// In node the CDN import fails the same way a phone with no signal does.
{
  const o = createOnline({ game: highCard });
  const errs = [];
  o.on("error", (m) => errs.push(m));
  const r = await o.createRoom({ name: "Tim" });
  assert.equal(r.ok, false);
  assert.equal(r.message, "Online play couldn't load. Check your internet and try again.");
  assert.deepEqual(errs, [r.message]);
  const j = await o.joinRoom("ABCDE", "Tim");
  assert.equal(j.message, r.message, "join says the same");
  ok("no internet: \"" + r.message + "\"");
}

console.log(`\nlocal: ${pass} passed`);
