# game-online — shared online play for the board/card game sites

One small ES module, `online.js`, gives every game site the same three ways to play:
**you vs computers on this device**, **pass-the-phone**, and **an online room with a short code**
where any seat can be a person or a computer. One free Firebase project (`th-board-games`, Spark
plan, no billing) serves all the games. Demo: <https://timothyhadfield.github.io/game-online/demo/>

## 1. Copy it in

1. Copy `online.js` into your site's `js/` folder **unchanged** (it already holds the project config;
   the config values are public by design, the security is in the rules).
2. Pick a `gameId`: lower-case letters, digits, dashes, unique across Tim's games. Use these:
   `ticket-to-ride`, `monopoly`, `coup`, `werewolf`, `clocktower`, `holdem`, `hearts`, `spades`,
   `skull-king`, `codenames`, `dominion`, `carcassonne`, `cover-your-assets`, `exploding-kittens`,
   `clue`, `battleship`, `connect-four`, `stratego`, `checkers`, `risk`, `pandemic`, `splendor`,
   `king-of-tokyo`, `seven-wonders`, `evolution`. (The demo uses `high-card`.)
3. **No rules file, no Firebase CLI, no deploy in your repo.** The rules here are game-agnostic and
   already deployed. Do not create your own Firebase project or `firebase.json`.
4. The Firebase SDK (~250 KB) loads only when the player first opens online play
   (`createOnline` does a lazy `import()` from gstatic). Local play never touches the network.

## 2. Your game supplies pure functions

```js
export const game = {
  id: "hearts",                 // default gameId
  minSeats: 4, maxSeats: 4,
  setup(nSeats, options, rng, seats) { return state },   // seats = [{kind, name}]; state must be JSON-safe
  toAct(state) { return [seat, ...] },                   // seats allowed to move NOW (several = simultaneous)
  apply(state, seat, action, rng) { return newState },   // THROW on an illegal move. May mutate (gets a copy).
  publicView(state) { return {...} },                    // what everyone may see
  privateView(state, seat) { return {...} },             // ONLY this seat's secrets (hand, role, …)
  bot(ctx, seat, rng) { return action },                 // ctx = { pub, mine, state } — use pub+mine to play fair
  isOver(state) { return bool },
};
```

Rules of thumb:
- **`state` must survive `JSON.stringify`** (no Maps, Sets, class instances, functions, `undefined` in arrays).
- **`rng` is the only randomness** — never `Math.random()` inside `apply`/`setup`.
- **`privateView` holds secrets only.** Anything everyone can see goes in `publicView`. Only changed
  private docs are written, so keeping them small and stable saves the free quota.
- `publicView` must never include another player's hidden cards/roles. Write a node test that
  checks `JSON.stringify(publicView(s))` and `privateView(s, 1)` don't contain seat 0's secrets.
- Turn order, legality and scoring all live in `apply`; online.js only checks "is this seat in `toAct`".

## 3. API

```js
import { createLocal, createOnline } from "./online.js";

// --- on this device (you + computers, or pass-the-phone with several 'human' seats)
const room = createLocal({ game, seats: ["human", "computer", "computer", "computer"],
                           options: {}, names: ["You"], botDelayMs: 600 });
room.on("change", (snap) => render(snap));
room.start();                 // first "change"
room.act({ card: 12 });       // moves for the human whose turn it is (or room.act(a, seat))
room.view(seat);              // snapshot from a given seat (pass-the-phone)

// --- online
const online = createOnline({ game, gameId: "hearts", botDelayMs: 700 });
online.on("change", (snap) => render(snap));
online.on("error", (msg) => toast(msg));           // plain-English message

await online.resume();                              // true if a reload put us back in our room
const { ok, code, message } = await online.createRoom({ name: "Tim",
      seats: ["human", "empty", "computer", "empty"], options: { jackOfDiamonds: true } });
await online.joinRoom("K7M2Q", "Sam");              // { ok, seat } or { ok:false, message }
await online.setSeat(2, "empty" | "computer");      // host, lobby. During play: "computer" (takes over a seat) or "open" (offer it up)
online.on("seatRequest", (rq) => ask(rq));          // OPTIONAL. host: rq = { uid, name, seat, seatName, allow(), deny() }
await online.allowSeat(uid); await online.denySeat(uid);   // host: same as rq.allow() / rq.deny()
await online.setOptions({ ... });                   // host, lobby
await online.start();                               // host; empty seats become computers
await online.act(action);                           // your move (checked again by the host's apply)
await online.leave();                               // player: seat becomes a computer. Host: hands over, or closes
await online.close();                               // host: end the room for everyone, delete it now
```

Every call returns `{ ok: true, ... }` or `{ ok: false, message }` — it never throws.

### The snapshot your UI renders (same shape local and online)

```js
{
  mode: "local" | "online",
  status: "lobby" | "playing" | "finished" | "joining" | "closed" | "left" | "none",
  code: "K7M2Q",                 // online only; show it big so friends can type it
  seats: [{ kind: "human"|"computer"|"empty", name, online, isHost, open }],  // open: host offered it up
  mySeat: 1,                     // -1 if not seated
  isHost: false,
  hostAway: false,               // host's heartbeat lost; another player takes over within ~80 s
  options: {...},
  pub:  publicView(state),       // null in the lobby
  mine: privateView(state, mySeat),
  toAct: [2], myTurn: false,
  seatRequests: [{ uid, name, seat, seatName }],  // host only: people asking for someone's seat
  askingHost: false,             // while status is "joining": true = waiting for the host to Allow
  error: null | "plain message",
}
```

### Seats belong to a login, not a name

Mid-game, **the same browser** (same anonymous login) gets its own seat back at once, after a reload
or a closed tab (`resume()` or `joinRoom` with the code). **A different device typing a seated
player's name does NOT get that seat** unless:
- the host says **Allow**: online.js fires `"seatRequest"` on the host. If your game has no
  `"seatRequest"` listener, online.js shows its own small Allow / Deny card at the bottom of the host's
  screen (no game code needed). Unanswered = no seat; the joiner gets
  "That seat belongs to someone else, ask the host." on Deny, or after 2 minutes.
- or the host marked the seat open with `setSeat(i, "open")` (a player's seat: whoever types that name
  next takes it; a computer seat: the next joiner takes it under their own name).

`change` is held back until your private doc matches the room version, so you never draw the new
table with the old hand.

## 4. What happens behind the scenes

| Thing | How |
|---|---|
| Room code | 5 characters, no O/0/I/1. Rooms can be fetched by code, never listed. |
| Join | Joiner leaves a note; the host's browser seats them in the first empty seat. Mid-game, the same login walks straight back into its seat; a **different** login typing an offline player's name needs the host's Allow (or an open seat). Only the host can write who sits where (rules-tested). |
| Moves | Host's own moves apply instantly. Others write a move doc; rules only accept it for **your seat, when your seat is in `toAct`**; the host applies it with your `apply` (illegal = dropped). |
| Computers | Run in the host's browser, one step every `botDelayMs`. |
| Hidden info | `hands/{uid}` — only that uid can read it (rules-tested). The host's browser holds the full state (no free server can avoid that; accepted, same as Cribbage). |
| Presence | Heartbeat every 25 s while the tab is visible; "offline" after 75 s. |
| Host leaves | `leave()` hands hosting to another online player. If the host just vanishes, after 75 s the lowest online seat takes over (rules check the old heartbeat really is stale). The new host reloads the full state and carries on. |
| Reload | `resume()` reattaches (anonymous login persists in the browser). |
| Cleanup | `close()` deletes everything. Abandoned rooms: every doc has `expireAt` (2 days ahead, refreshed on each write; rules refuse more than 3). Firestore TTL needs billing, so instead **the rules let anyone list and delete only expired docs**, and `createRoom` sweeps up to 25 expired docs per collection (at most once per 6 h per browser). |

## 5. Free-tier budget (whole project, all 13 games share it)

Spark plan per day: **50,000 reads, 20,000 writes, 20,000 deletes**, 1 GiB stored. If it runs out,
online play stops until midnight Pacific (the error says so) — **it never costs money** (no billing account).

Measured costs (`test/online.test.mjs` counts every SDK call; it's an estimate because rule `get()`s add
about 1 read per write): starting a 3-seat game = 6 writes; one full 3-seat round (host pick, guest pick, computer
pick, reveal) = 6 writes + 6 reads across all clients. As a rule of thumb, a host or computer move ≈ 2–3 writes
(room, full state, changed hands) and a guest move ≈ +1 write and +1 delete (the move doc).
Heartbeats: 1 write per player per 25 s visible (~144/hour) plus 1 read per other player.

Rough capacity: **a 4-player 45-minute game ≈ 1,000–1,500 writes**, so ~15 such games a day across all
sites. Keep games under it:
- Don't publish animation steps — publish **one state per move**; animate client-side from the diff.
- Keep `privateView` stable (sorted hands, no timestamps/counters that change every move).
- Prefer one action per decision (e.g. "pass these 3 cards" not 3 separate moves).
- Solo vs computers: always use `createLocal` (zero network).
- Don't poll; the snapshot listeners already push changes.

## 6. Testing your game

- **Engine tests (node):** `setup`→ random `bot` moves until `isOver`, thousands of times, asserting
  `apply` never throws for bot moves, `toAct` is never empty before the end, and the state round-trips
  through `JSON.parse(JSON.stringify(s))`.
- **Secrecy test:** for every seat `i ≠ j`, `JSON.stringify(publicView(s))` and `privateView(s, j)` contain no
  card/role that only seat `i` holds.
- **Local room test:** `createLocal` with all computer seats plays to `finished` (see `test/local.test.mjs`).
- **Two-browser check:** `test/two-browsers.mjs` here opens two headless pages against the real project;
  copy it and point it at your page.
- The security rules are tested once, here (`cd test && npm test`). Games don't redo it.

## Changelog

- **2026-10-20 — security fix, re-copy `online.js`.** Before this, anyone who joined a game in
  progress with an away player's NAME got that player's seat and hand. Now a seat belongs to the
  login (uid); a different login needs the host's Allow or an open seat (see "Seats belong to a
  login"). The API only grew (`"seatRequest"` event, `allowSeat`/`denySeat`, `setSeat(i, "open")`,
  `seats[].open`, `seatRequests`, `askingHost`); no game code has to change.
  **Every game: copy the new `online.js` over your `js/online.js` unchanged.**

## 7. This repo

| File | What |
|---|---|
| `online.js` | the module (copy this) |
| `firestore.rules`, `firestore.indexes.json` (sweep indexes), `firebase.json` | deployed to `th-board-games` (anonymous auth on) |
| `test/real-smoke.mjs` | 2 clients play a full game on the REAL project (node) |
| `demo/` | High Card: hidden hands, simultaneous picks, computers, two-browser proof |
| `test/rules.test.js` | emulator tests of the rules |
| `test/online.test.mjs` | online.js end-to-end on the emulator (create, join, play, secrecy, host takeover) |
| `test/local.test.mjs` | local rooms in node |
