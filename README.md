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
await online.setSeat(2, "empty" | "computer");      // host, lobby. During play: "computer" (plays the seat; the owner's phone can take it back) or "open" (offer it up)
online.on("seatRequest", (rq) => ask(rq));          // OPTIONAL. host: rq = { uid, name, seat, seatName, allow(), deny() }
await online.allowSeat(uid); await online.denySeat(uid);   // host: same as rq.allow() / rq.deny()
await online.setOptions({ ... });                   // host, lobby
await online.start();                               // host; empty seats become computers
await online.act(action);                           // your move (checked again by the host's apply)
await online.reclaim();                             // take your seat back from the computer playing it for you (automatic on return / any tap)
await online.leave();                               // player: seat becomes a computer. Host: hands over, or closes
await online.close();                               // host: end the room for everyone, delete it now
```

Every call returns `{ ok: true, ... }` or `{ ok: false, message }` — it never throws.
`act` may return `{ ok: false, stale: true, message }` when your screen was one update behind:
show the message gently (or nothing) and let the player look again; no `error` event fires.

### The snapshot your UI renders (same shape local and online)

```js
{
  mode: "local" | "online",
  status: "lobby" | "playing" | "finished" | "joining" | "closed" | "left" | "none",
  code: "K7M2Q",                 // online only; show it big so friends can type it
  seats: [{ kind: "human"|"computer"|"empty", name, online, isHost, open, auto }],  // online: computer, or a present human (never an empty seat); open: host offered it up; auto: a computer playing it for its away owner
  mySeat: 1,                     // -1 if not seated
  isHost: false,
  hostAway: false,               // host's heartbeat lost; another player takes over within ~45 s
  options: {...},
  pub:  publicView(state),       // null in the lobby
  mine: privateView(state, mySeat),
  toAct: [2], myTurn: false,     // myTurn is false while a computer plays your seat
  autoPlay: false,               // true = a computer is playing your seat (you were away); any tap takes it back
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
| Batching (v2) | The host does **not** write the room after every move. Each move becomes a frame `{v, p, t}`; the room (with `frames`, up to 200) is written only when the game ends, seats change, a person other than the host newly has to act (the rules check `toAct` on the room), 2+ friends need news, or 20 s pass. If exactly one friend is waiting on news, the host writes only that friend's `hands/{uid}` doc, with `pub` + `toAct` added. Friends replay the frames one by one (computer moves still look step by step). Watchers may see other players' moves up to 20 s late. |
| Computers | Run in the host's browser, one step every `botDelayMs`. |
| Hidden info | `hands/{uid}` — only that uid can read it (rules-tested). The host's browser holds the full state (no free server can avoid that; accepted, same as Cribbage). |
| Presence | Heartbeat while the tab is visible: the host every 15 s **only while the table waits on the host** (lobby, its own turn, a computer's turn), otherwise every 60 s; players every 60 s. A room write counts as a host beat, a sent move as a player's beat. Friends listen only to the host's presence doc (not the whole collection). A player is "offline" after 130 s, the host after 40 s. |
| Away on your turn | If the table waits on a player who is **offline** for the turn timeout (default **60 s**, room option `turnTimeoutSec`, `0` = never), the host's browser lets a computer play that seat (`seats[i].auto`). The seat stays theirs: when their phone comes back (reload, rejoin, screen on, or any tap) it's handed back. Players who are online are never hurried. |
| Host leaves | `leave()` hands hosting to another online player. If the host just vanishes, the lowest online seat takes over once the table waits on the host (≥10 s) and the host has shown no sign for 40 s (beat, room write or answer); the rules check both the presence doc and the room's `updatedAt` are over 40 s old. Measured 43 s on the emulator. One missed beat does not trigger it. The new host reloads the full state (3 tries) and carries on; moves batched but not yet saved by the old host are lost (at most ~20 s of play). |
| Reload | `resume()` reattaches (anonymous login persists in the browser). |
| Cleanup | `close()` deletes everything. Abandoned rooms: every doc has `expireAt` (2 days ahead, refreshed on each write; rules refuse more than 3). Firestore TTL needs billing, so instead **the rules let anyone list and delete only expired docs**, and `createRoom` sweeps up to 25 expired docs per collection (at most once per 6 h per browser). |

## 5. Free-tier budget (whole project, all 13 games share it)

Spark plan per day: **50,000 reads, 20,000 writes, 20,000 deletes**, 1 GiB stored. If it runs out,
online play stops until midnight Pacific (the error says so) — **it never costs money** (no billing account).

**Measured per game (v2, 2026-10-27)** with `test/cost.mjs`: every game's real engine, a host plus 1–2
friends thinking 2–10 s per move, the other seats computers, on a billing fake (`test/fakefs.mjs`) that
counts like Firestore (listener reads per changed doc, rule `get()`s, deletes). Checked against the real
emulator with `test/emu-cost.mjs` (High Card: fake 51 writes, emulator 48–51).

| Game (one full game) | Writes before → v2 | Reads before → v2 |
|---|---|---|
| Catan | 948 → 507 | 2,084 → 1,120 |
| Hearts | 2,775 → 1,704 | 6,038 → 3,544 |
| Risk | 2,014 → 982 | 4,861 → 2,356 |
| Monopoly | 1,293 → 790 | 3,274 → 1,915 |
| Hold'em | 1,206 → 532 | 2,698 → 1,220 |
| Coup | 385 → 184 | 788 → 409 |
| Ticket to Ride | 844 → 470 | 1,869 → 1,054 |
| Codenames | 124 → 70 | 320 → 189 |
| Bank (4 seats, 3 people) | 552 → 440 | 1,349 → 1,007 |

All 26 games: about **−38% writes and reads** (Bank only −20%: everyone may bank at any moment, so nearly every roll must reach every phone). What's left: a friend's move = 2 writes (the move + the
host's answer) + 1 delete; a room write ≈ 2–3 writes (room + full state + changed hands).
A busy day (300 players, 50 at once, spread over all games) ≈ **47K writes / 105K reads** (was 75K / 169K):
still over the free quota, so a busy day can stop online play until midnight Pacific (never costs money).

Keep games under it:
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

- **2026-10-27 (v2) — about one room write per turn. Re-copy `online.js`.** The host batches moves
  into frames and writes the room only when someone else must act, seats change, the game ends or
  20 s pass; a single waiting friend gets news in their own hand doc instead. Heartbeats: the host
  slows to 60 s while only friends are thinking; friends listen to the host's presence doc only.
  Takeover waits until the table waits on the host and the host has been silent 40 s. `close()`
  can no longer leave the host's own presence doc behind. Rules (deployed): room `frames` (≤200),
  hand `pub`/`toAct`, takeover also needs the room's `updatedAt` over 40 s old. The API and snapshot
  shape are unchanged; old and new copies can share the project (an old host simply writes more).
  **Every game: copy the new `online.js` over your `js/online.js` unchanged.**

- **2026-10-27 — away players, seat reclaim, faster host takeover, no-internet message. Re-copy `online.js`.**
  (1) A player who is offline when the table waits on them gets a computer in their seat after the
  turn timeout (default 60 s; room option `turnTimeoutSec`, 0 = never). (2) The seat stays theirs
  (`seats[i].auto`, `snap.autoPlay`): their phone takes it back on reload, rejoin, screen-on or any tap,
  or via `reclaim()`. The host's `setSeat(i, "computer")` during play now works the same way (it used
  to throw the player out for good); `leave()` still gives the seat up for good. A different login
  typing that player's name still needs the host's Allow. (3) Host takeover after 40 s of host
  silence instead of 75 s (rules changed to match; deployed): the host beats every 15 s, other
  players every 60 s, so a room costs about the same quota. A new host's first move waits for the
  table to load instead of failing. (4) No internet / blocked download → "Online play couldn't load.
  Check your internet and try again." instead of the browser's "Importing a module script failed."
  (5) The 5-second presence check only fires `change` when an online dot actually flips.
  No game code has to change. **Every game: copy the new `online.js` over your `js/online.js` unchanged.**

- **2026-10-20 — security fix, re-copy `online.js`.** Before this, anyone who joined a game in
  progress with an away player's NAME got that player's seat and hand. Now a seat belongs to the
  login (uid); a different login needs the host's Allow or an open seat (see "Seats belong to a
  login"). The API only grew (`"seatRequest"` event, `allowSeat`/`denySeat`, `setSeat(i, "open")`,
  `seats[].open`, `seatRequests`, `askingHost`); no game code has to change.
  Same release, also fixed: (1) a guest whose screen was one update behind (or still catching up
  after a reload) who tapped a move got "The server said no — you may not be in this room any
  more."; now `act` returns `{ ok:false, stale:true, message:"The table just changed. Check it and
  try again." }` with no `error` event (the rules still refuse the move); a refused room listener
  quietly re-listens if the server still lists you. (2) Empty seats showed `online: true`; now
  `online` is true only for computer seats and present humans. (3) Sign-in retries twice on
  auth/network-request-failed, and the SDK's background token-refresh rejection of that code no
  longer shows as an uncaught error. (4) `createRoom` writes the room in one plain write (no
  transaction) and sweeps old rooms 15 s later, so it's faster under load.
  **Every game: copy the new `online.js` over your `js/online.js` unchanged.**

## 7. This repo

| File | What |
|---|---|
| `online.js` | the module (copy this) |
| `firestore.rules`, `firestore.indexes.json` (sweep indexes), `firebase.json` | deployed to `th-board-games` (anonymous auth on) |
| `test/real-smoke.mjs` | 2 clients play a full game on the REAL project (node) |
| `test/v2.test.mjs`, `test/fakefs.mjs` | cost/batching checks on a billing fake with a virtual clock (no emulator) |
| `test/cost.mjs`, `test/emu-cost.mjs` | per-game write/read counts for every game (`node cost.mjs`), and the fake-vs-emulator cross-check |
| `demo/` | High Card: hidden hands, simultaneous picks, computers, two-browser proof |
| `test/rules.test.js` | emulator tests of the rules |
| `test/online.test.mjs` | online.js end-to-end on the emulator (create, join, play, secrecy, host takeover) |
| `test/local.test.mjs` | local rooms in node |
