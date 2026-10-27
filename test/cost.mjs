// Firestore cost of one typical ONLINE game, for every game that uses online.js.
// Runs the REAL online.js (this repo's, or ONLINE_JS=<path>) against fakefs.mjs
// (bills like Firestore) on a virtual clock: the host + 1-2 friends play with
// a "think time" of 2-10 s per decision; the rest of the seats are computers.
//
//   node cost.mjs                 all games, this online.js
//   node cost.mjs catan coup      some games
//   ONLINE_JS=../old.js node cost.mjs --json out.json
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { makeClock, makeSdk } from "./fakefs.mjs";

const require = createRequire(import.meta.url);
const GAMES_DIR = process.env.GAMES_DIR || "C:/Users/timha/OneDrive/Desktop/my-website/Code Projects/Board and Card Games";
const g = (p) => path.join(GAMES_DIR, p);
const imp = (p) => import(pathToFileURL(g(p)).href);
const ONLINE = process.env.ONLINE_JS ? path.resolve(process.env.ONLINE_JS) : path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "../online.js");

// seats = typical table, humans = people on phones (host + friends), rest computers.
const GAMES = {
  "battleship": { seats: 2, humans: 2, bot: 0, load: async () => { const { makeGame } = await imp("Battleship/js/game.mjs"); return makeGame(require(g("Battleship/js/engine.js")), require(g("Battleship/js/density.js")), require(g("Battleship/js/ai.js"))); }, options: { levels: ["medium", "medium"] } },
  "carcassonne": { seats: 3, humans: 3, load: async () => require(g("Carcassonne/js/game.js")), options: { levels: ["medium", "medium", "medium"] } },
  "catan": { seats: 4, humans: 3, load: async () => require(g("Catan/js/adapter.js")).game, options: { levels: ["medium", "medium", "medium", "medium"] } },
  "checkers": { seats: 2, humans: 2, load: async () => require(g("Checkers/js/online-game.js")).game, options: { variant: "casual", level: 1 } },
  "clocktower": { seats: 7, humans: 3, load: async () => require(g("Clocktower/js/ctonline.js")).game, options: { level: "medium" } },
  "clue": { seats: 4, humans: 3, load: async () => (await imp("Clue/js/game.js")).game, options: {} },
  "codenames": { seats: 4, humans: 3, load: async () => { const m = await imp("Codenames/js/game.js"); const { loadAssoc } = await imp("Codenames/tools/load-node.mjs"); m.setAssoc(loadAssoc()); return m.game; }, options: {} },
  "connect-four": { seats: 2, humans: 2, load: async () => (await imp("Connect_Four/js/game.js")).game, options: {} },
  "coup": { seats: 4, humans: 3, load: async () => require(g("Coup/js/coupgame.js")).game, options: { level: "medium" } },
  "cover-your-assets": { seats: 4, humans: 3, load: async () => { const { makeGame } = await imp("Cover_Your_Assets/js/game.mjs"); return makeGame(require(g("Cover_Your_Assets/js/engine.js")), require(g("Cover_Your_Assets/js/ai.js"))); }, options: {} },
  "dominion": { seats: 3, humans: 3, load: async () => require(g("Dominion/js/online-game.js")).game, options: {} },
  "evolution": { seats: 4, humans: 3, load: async () => require(g("Evolution/js/online-game.js")).game, options: {} },
  "exploding-kittens": { seats: 4, humans: 3, load: async () => (await imp("Exploding_Kittens/js/netgame.js")).game, options: { edition: "original" } },
  "hearts": { seats: 4, humans: 3, load: async () => require(g("Hearts_Spades/js/net-games.js")).hearts, options: { level: "medium", target: 100 } },
  "spades": { seats: 4, humans: 3, load: async () => require(g("Hearts_Spades/js/net-games.js")).spades, options: { level: "medium", target: 300 } },
  "king-of-tokyo": { seats: 4, humans: 3, load: async () => require(g("King_of_Tokyo/js/game.js")).game, options: { level: "medium" } },
  "monopoly": { seats: 4, humans: 3, load: async () => require(g("Monopoly/js/mono-online.js")), options: { rules: { roundLimit: 30 } } },
  "pandemic": { seats: 4, humans: 3, load: async () => require(g("Pandemic/js/online-game.js")).game, options: { epidemics: 5 } },
  "risk": { seats: 4, humans: 3, load: async () => require(g("Risk/js/adapter.js")).game, options: { rules: { mode: "classic" } } },
  "seven-wonders": { seats: 4, humans: 3, load: async () => require(g("Seven_Wonders/js/online-game.js")).game, options: { ed: 1, level: "medium" } },
  "skull-king": { seats: 4, humans: 3, load: async () => require(g("Skull_King/js/skgame.js")).game, options: {} },
  "splendor": { seats: 3, humans: 3, load: async () => require(g("Splendor/js/online-game.js")).game, options: { level: "medium" } },
  "stratego": { seats: 2, humans: 2, load: async () => require(g("Stratego/js/online-game.js")).game, options: { variant: "barrage", level: "medium" } },
  "holdem": { seats: 6, humans: 3, load: async () => require(g("Texas_Holdem/js/online-game.js")).game, options: { format: "tourney", stack: 50, betting: "nl" } },
  "ticket-to-ride": { seats: 4, humans: 3, load: async () => { const T = require(g("Ticket_to_Ride/js/engine.js")); T.register(require(g("Ticket_to_Ride/maps/usa.json"))); return require(g("Ticket_to_Ride/js/online-game.js")).game; }, options: { mapId: "usa", deckId: "classic", level: "medium" } },
  "werewolf": { seats: 7, humans: 3, load: async () => require(g("Werewolf/js/game-online.js")).game, options: {} },
  // Bank: everyone in the round may bank at any time; only the roller rolls. A person who is not rolling acts only to bank.
  "bank": { seats: 4, humans: 3, load: async () => (await imp("Bank/js/engine.mjs")).game, options: {}, human: (a, s, seat) => (a.t === "roll" && s.roller !== seat ? null : a) },
  "high-card": { seats: 3, humans: 2, load: async () => (await import("../demo/high-card.js")).highCard, options: { handSize: 13 } },
};

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export async function runGame(id, { seed = 7, maxMin = 240, quiet = true } = {}) {
  const spec = GAMES[id];
  const base = await spec.load();
  const mr = mulberry(seed * 7 + 5); Math.random = mr;   // some computers think with Math.random: same game for both versions
  const clock = makeClock();
  clock.install();
  const sdk = makeSdk(clock);
  const { createOnline } = await import(pathToFileURL(ONLINE).href + "?v=" + Math.random());
  let latest = null, moves = 0;
  const game = Object.assign({}, base, {
    setup: (...a) => (latest = base.setup(...a)),
    apply: (...a) => { const s = base.apply(...a); latest = s; moves++; if (globalThis.__trace) globalThis.__trace.push([a[1], JSON.stringify(a[2]).slice(0, 40)]); return s; },
  });
  const rng = mulberry(seed), think = mulberry(seed * 31 + 1), hrng = mulberry(seed * 17 + 3);   // people decide with their own dice, so both versions play the same game
  const clients = [];
  for (let i = 0; i < spec.humans; i++) {
    const o = createOnline({ game, gameId: id, sdk, appName: id + "-" + i, botDelayMs: spec.botDelayMs || 700, rng: i === 0 ? rng : mulberry(seed + i) });
    const c = { o, snap: null, pending: false, decisions: 0, errors: [] };
    o.on("change", (s) => { c.snap = s; maybeAct(c); });
    o.on("error", (m) => c.errors.push(String(m)));
    clients.push(c);
  }
  function maybeAct(c) {
    if (c.pending || !c.snap || !c.snap.myTurn || c.snap.status !== "playing") return;
    c.pending = true;
    setTimeout(async () => {
      const s = c.o.view();
      try {
        if (!s.myTurn || !latest || base.isOver(latest) || !base.toAct(latest).includes(s.mySeat)) return;
        let a = base.bot({ pub: s.pub, mine: s.mine, state: latest }, s.mySeat, hrng);
        if (spec.human) { a = spec.human(a, latest, s.mySeat); if (!a) return; }
        c.decisions++;
        await c.o.act(a);
      } catch (e) { c.errors.push("bot: " + e.message); }
      finally { c.pending = false; }
    }, 2000 + Math.floor(think() * 8000));
  }
  const H = clients[0];
  const seats = [{ kind: "human" }];
  for (let i = 1; i < spec.seats; i++) seats.push(i < spec.humans ? "empty" : "computer");
  const t0 = clock.now;
  const drive = async (p) => { let done = false, v; p.then((x) => { done = true; v = x; }, (e) => { done = true; v = { ok: false, message: e.message }; }); await clock.run(() => done, 600000); return v; };
  const made = await drive(H.o.createRoom({ name: "Host", seats, options: spec.options }));
  if (!made.ok) throw new Error("createRoom: " + made.message);
  for (let i = 1; i < spec.humans; i++) {
    const p = clients[i].o.joinRoom(made.code, "P" + i);
    await clock.run(() => clients[i].snap && clients[i].snap.mySeat >= 0, 30000);
    await drive(p);
  }
  await clock.run(() => H.snap && H.snap.seats && H.snap.seats.filter((s) => s.kind === "human").length === spec.humans, 30000);
  const lobby = sdk.totals();
  const st = await drive(H.o.start());
  if (!st.ok) throw new Error("start: " + st.message);
  // keep nudging humans whose turn it is (a stale tap is retried like a person would)
  setInterval(() => { for (const c of clients) { c.snap = c.o.view(); maybeAct(c); } }, 3000);
  await clock.run(() => latest && base.isOver(latest) && clients.every((c) => c.snap && c.snap.status === "finished"), maxMin * 60000);
  const finished = !!(latest && base.isOver(latest));
  const out = { id, seats: spec.seats, humans: spec.humans, finished, minutes: +((clock.now - t0) / 60000).toFixed(1), moves,
    decisions: clients.reduce((n, c) => n + c.decisions, 0), lobby, total: sdk.totals(), byKind: sdk.tag,
    errors: [...new Set(clients.flatMap((c) => c.errors))].slice(0, 3) };
  for (const c of clients) await drive(c.o._detach());
  clock.uninstall();
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf("--json");
  const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
  const ids = args.length ? args : Object.keys(GAMES);
  const rows = [];
  for (const id of ids) {
    try {
      const r = await runGame(id);
      rows.push(r);
      const k = (n) => (r.byKind[n] ? r.byKind[n].writes : 0);
      console.log(`${id.padEnd(18)} ${r.finished ? "done" : "CAP "} ${String(r.minutes).padStart(5)} min  moves ${String(r.moves).padStart(4)}  human ${String(r.decisions).padStart(4)}  W ${String(r.total.writes).padStart(5)}  R ${String(r.total.reads).padStart(6)}  D ${String(r.total.deletes).padStart(4)}  [room ${k("room")} hands ${k("hands")} host ${k("host")} actions ${k("actions")} presence ${k("presence")}]${r.errors.length ? "  ! " + r.errors.join(" | ").slice(0, 160) : ""}`);
    } catch (e) { console.log(`${id.padEnd(18)} FAILED ${e.stack.split("\n").slice(0, 3).join(" / ")}`); rows.push({ id, failed: String(e.message) }); }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}
