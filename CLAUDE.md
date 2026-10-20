# game-online — shared online play layer

`online.js` (copied into each game site), `firestore.rules` for the shared Firebase project **th-board-games** (Spark, $0, anonymous auth), and a High Card demo.
Live demo: https://timothyhadfield.github.io/game-online/demo/ · API and budget: README.md · state: progress.md

- Test: `cd test && npm ci && npm test` (Java 21+, firebase-tools; emulator ports 8090/9190). Real project: `node test/real-smoke.mjs`, `node test/two-browsers.mjs [url] --engine webkit`.
- Deploy rules only after the tests pass: `firebase deploy --only firestore --project th-board-games`.
- Never add billing or TTL policies (TTL needs billing; the clients sweep expired docs instead).
