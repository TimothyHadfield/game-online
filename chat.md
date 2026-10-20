# chat — game-online

## 2026-10-19 — first build
- **Asked:** a shared online layer for ~25 static game sites. Tim: "regular play online with a computer or other online players". $0.
- **Decided:** one Firebase project `th-board-games` (Spark). Host-authoritative like Cribbage. Private `hands/{uid}` per seat. Host takeover after 75 s of silence. No TTL (it needs billing), so clients sweep expired docs instead.
- **Built:** online.js (createLocal/createOnline), firestore.rules + sweep indexes (deployed), High Card demo, README for game builders, tests.
- **Verified:** `cd test && npm test`: local 5, rules 71, online.js end-to-end 13, all green. The rules suite fails on open rules (40) and on subtly broken rules (3). `node test/real-smoke.mjs` passes on the real project. `node test/two-browsers.mjs https://timothyhadfield.github.io/game-online/demo/ --engine webkit` passes on LIVE (join by code, hidden hands, reload resume, game over, no console errors). Chromium passes too. Live at 52277c0+.
- **Open:** real-iPhone host takeover timing; quota use at scale. See progress.md NOT verified.
