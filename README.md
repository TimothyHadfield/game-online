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
| Computers | Run in the host's browser, one step every `botDelayMs`. |
| Hidden info | `hands/{uid}` — only that uid can read it (rules-tested). The host's browser holds the full state (no free server can avoid that; accepted, same as Cribbage). |
| Presence | Heartbeat while the tab is visible: the host every 15 s, players every 60 s. A player is "offline" after 130 s, the host after 40 s. |
| Away on your turn | If the table waits on a player who is **offline** for the turn timeout (default **60 s**, room option `turnTimeoutSec`, `0` = never), the host's browser lets a computer play that seat (`seats[i].auto`). The seat stays theirs: when their phone comes back (reload, rejoin, screen on, or any tap) it's handed back. Players who are online are never hurried. |
| Host leaves | `leave()` hands hosting to another online player. If the host just vanishes, after 40 s without a host heartbeat the lowest online seat takes over (rules check the old heartbeat really is stale); measured 43 s on the emulator (was ~75–85 s). One missed beat (a 25 s blip) does not trigger it. The new host reloads the full state and carries on. |
| Reload | `resume()` reattaches (anonymous login persists in the browser). |
| Cleanup | `close()` deletes everything. Abandoned rooms: every doc has `expireAt` (2 days ahead, refreshed on each write; rules refuse more than 3). Firestore TTL needs billing, so instead **the rules let anyone list and delete only expired docs**, and `createRoom` sweeps up to 25 expired docs per collection (at most once per 6 h per browser). |

## 5. Free-tier budget (whole project, all 13 games share it)

Spark plan per day: **50,000 reads, 20,000 writes, 20,000 deletes**, 1 GiB stored. If it runs out,
online play stops until midnight Pacific (the error says so) — **it never costs money** (no billing account).

Measured costs (`test/online.test.mjs` counts every SDK call; it's an estimate because rule `get()`s add
about 1 read per write): starting a 3-seat game = 6 writes; one full 3-seat round (host pick, guest pick, computer
pick, reveal) = 6 writes + 6 reads across all clients. As a rule of thumb, a host or computer move ≈ 2–3 writes
(room, full state, changed hands) and a guest move ≈ +1 write and +1 delete (the move doc).
Heartbeats: host 1 write per 15 s visible (240/hour), each other player 1 write per 60 s (60/hour), and each beat is 1 read for every member. A 2-player room: 300 writes + 600 reads an hour (was 288 + 576); 3 players: 360 + 1,080 (was 432 + 1,296); 4 players: 420 + 1,680 (was 576 + 2,304).

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
| `demo/` | High Card: hidden hands, simultaneous picks, computers, two-browser proof |
| `test/rules.test.js` | emulator tests of the rules |
| `test/online.test.mjs` | online.js end-to-end on the emulator (create, join, play, secrecy, host takeover) |
| `test/local.test.mjs` | local rooms in node |
