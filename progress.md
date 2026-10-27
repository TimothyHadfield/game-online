# progress — game-online

## START HERE
Read this, then README.md (API + Changelog) and CLAUDE.md (commands). Last updated 2026-10-27.

## Goal right now
Shared online layer for ~25 game sites: "regular play online with a computer or other online players" (Tim). $0, Firebase Spark only.

## Status
| Part | State |
|---|---|
| Firebase project `th-board-games` | Created 2026-10-19 via CLI. Web app, Firestore (default), **anonymous auth on**. No billing. |
| Rules + sweep indexes | **Deployed 2026-10-27** (host stale 75 → 40 s). 80/80 emulator tests. |
| online.js | createLocal / createOnline. local 7, e2e 3+1+3+21 (npm test runs the e2e parts as separate processes). |
| 2026-10-27 release | Away player → computer plays FOR them after 60 s (`turnTimeoutSec`); seat handed back on return / tap / `reclaim()`; host takeover 43 s measured (was ≥75 s); "Online play couldn't load. Check your internet and try again."; new host's first move waits for the table. Games must re-copy online.js (README Changelog). |
| Earlier fixes | 10-20: seats belong to a login (uid); stale tap `{ok:false, stale:true}`; empty seats offline; sign-in retry; createRoom one write. |
| Demo | Live on Pages. Two-browser test passes on the LIVE site (WebKit iPhone size + Chromium). |

## Online-guard numbers (Tim 10-27: busy day must stay under 10% of the free quota for a new feature)
Heartbeat cost per room-hour (writes / reads): 2 players 300 / 600 (was 288 / 576), 3 players 360 / 1,080 (was 432 / 1,296), 4 players 420 / 1,680 (was 576 / 2,304). Normal day 30 players × 45 min; busy 10×. Worst case (all 2-player rooms, busy) = +12 writes/h × 112 room-hours ≈ +1,350 writes (6.7% of 20k) and +2,700 reads (5.4% of 50k). Rooms of 3+ cost less than before. AFK takeover/reclaim ≈ 1–3 writes each, rare. Reasoned from the beat intervals, not measured on the real project.

## Standing instructions
- Tim: "build regular play online with a computer or other online players for all the games … that match exactly the play of the in-person game." Money $0.
- Tim 2026-10-27: "For Online play, talk to me before you're going to set something up that requires anything more than the firebase system we already have set up or takes up a large portion of our free plan that we have."

## Traps
- **Firestore TTL policies need billing.** The deploy fails with "billing disabled" and leaves the old rules unreleased. Never add `ttl: true`. Cleanup = rules let anyone list/delete only expired docs + `sweep()` on createRoom.
- Sweep queries must use a cutoff about 10 min in the past: client clocks run ahead of `request.time`, and rules then deny the list.
- `withSecurityRulesDisabled` doesn't return the callback's value (use an outer variable).
- WebKit logs aborted Firestore channels as "access control checks" page errors on reload. That's noise; two-browsers.mjs separates it.
- Headless runs make stray anonymous users in th-board-games (harmless).
- Port 8765 may be used by another agent's server; the tests used 8931.
- **Emulator Listen-stream bug** (cloud-firestore-emulator v1.21.0): firestore-debug.log shows "Failed to frame message … knownLengthPendingAllocation reached 0" (a race in the emulator's ListenStream.notifyReset); the client sees RESOURCE_EXHAUSTED "Received message larger than max" or "Call cancelled", and e2e steps time out at random (often "gus playing" / joins). Same on the old code. Rerun; about 1 run in 3 was fully green on 10-27. `node online.test.mjs 10` / `11` / `12` / `old` runs one part; `ONLINE_JS=<path>` / `RULES_FILE=<path>` point the suites at another copy (fail-first checks).
- `test/seat-takeover-browsers.mjs` needs ~3 min: a player only counts as away after 130 s, and by then a computer may already be playing his seat (the test accepts either).
- Old clients (pre-10-27 online.js) as host beat every 25 s; with the 40 s rule a new-client guest may take over after one missed beat. Harmless (takeover is lossless) and gone once every game re-copies.

## Decisions
- Host-authoritative (the host's browser holds the full state); per-seat `hands/{uid}` readable only by that uid.
- Host takeover after 40 s without a host heartbeat (host beats every 15 s), enforced by the rules. Players beat every 60 s, away after 130 s.
- Away-player computer: only for OFFLINE players, after `turnTimeoutSec` (default 60) of waiting on them; seat keeps the owner's uid (`auto`) so their own login takes it back. Online-but-slow players are never replaced.
- Host `setSeat(i, "computer")` mid-game keeps the owner (reclaimable); `leave()` and host Allow are the ways a seat changes owner.
- Join via notes that the host processes, so only the host ever writes the room doc (reclaim is a join note too).
- Mid-game rejoin = same uid walks straight back in. A different uid with a seated name (human or computer-for-owner): host Allow / Deny (default deny; joiner waits up to 2 min), or the host marks the seat open.
- Built-in Allow/Deny card only shows when the game has no `seatRequest` listener (plain #1a1e2b / #e8eaf0 / #6ea8fe, bottom of screen, text via textContent).

## NOT verified
- A real iPhone (Safari backgrounding → host takeover timing, tap-to-reclaim, sleep detection).
- Quota use at scale (estimates above are reasoned from beat intervals and emulator call counts).
- Coup's "server said no once after a reload" was NOT reproduced (10-20).
- createRoom speed under load: not timed under real load.
- The silenced auth/network-request-failed rejection: not reproduced.
- 60 s default turn timeout and the "any tap takes the seat back" behaviour are builder choices (Tim's call if he wants different).
