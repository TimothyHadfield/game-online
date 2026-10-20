# progress — game-online

## START HERE
Read this, then README.md (API) and CLAUDE.md (commands). Last updated 2026-10-19.

## Goal right now
Shared online layer for ~25 game sites: "regular play online with a computer or other online players" (Tim). $0, Firebase Spark only.

## Status
| Part | State |
|---|---|
| Firebase project `th-board-games` | Created 2026-10-19 via CLI. Web app, Firestore (default), **anonymous auth on** (`firebase deploy --only auth`). No billing. |
| Rules + sweep indexes | **Deployed**. 71/71 emulator tests. |
| online.js | createLocal / createOnline. 13/13 end-to-end emulator tests, 5/5 local tests. |
| Demo | Live on Pages. Two-browser test passes on the LIVE site (WebKit iPhone size + Chromium). |

## Standing instructions
- Tim: "build regular play online with a computer or other online players for all the games … that match exactly the play of the in-person game." Money $0.

## Traps
- **Firestore TTL policies need billing.** The deploy fails with "billing disabled" and leaves the old rules unreleased. Never add `ttl: true`. Cleanup = rules let anyone list/delete only expired docs + `sweep()` on createRoom.
- Sweep queries must use a cutoff about 10 min in the past: client clocks run ahead of `request.time`, and rules then deny the list.
- `withSecurityRulesDisabled` doesn't return the callback's value (use an outer variable).
- WebKit logs aborted Firestore channels as "access control checks" page errors on reload. That's noise; two-browsers.mjs separates it.
- Headless runs make stray anonymous users in th-board-games (harmless).
- Port 8765 may be used by another agent's server; the tests used 8931.

## Decisions
- Host-authoritative (the host's browser holds the full state); per-seat `hands/{uid}` readable only by that uid.
- Host takeover after a 75 s stale heartbeat, enforced by the rules.
- Join via notes that the host processes, so only the host ever writes the room doc.
- Mid-game rejoin = same name into an offline seat.

## NOT verified
- A real iPhone (Safari backgrounding → host takeover timing).
- Quota use at scale (estimates in README are from emulator call counts).
