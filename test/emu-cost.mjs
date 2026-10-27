// Cross-check fakefs.mjs against the real Firestore emulator: the same quick
// High Card game (host + friend + computer, 13 rounds) counted both ways.
//   firebase emulators:exec --only firestore,auth --project demo-boardgames "node emu-cost.mjs emu"
//   node emu-cost.mjs fake
//   ONLINE_JS=<path> to count another copy.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { highCard } from "../demo/high-card.js";
import { makeSdk } from "./fakefs.mjs";

const require = createRequire(import.meta.url);
const ALT = process.argv[3] || process.env.ONLINE_JS;   // node emu-cost.mjs emu <path to another online.js>
const ONLINE = ALT ? path.resolve(ALT) : new URL("../online.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const { createOnline } = await import(pathToFileURL(ONLINE).href);
const MODE = process.argv[2] || "fake";
const counts = { writes: 0, deletes: 0, reads: 0 };
let sdk, extra = {};
if (MODE === "emu") {
  const fsMod = require("firebase/firestore");
  const counted = Object.assign({}, fsMod, {
    setDoc: (...a) => { counts.writes++; return fsMod.setDoc(...a); },
    updateDoc: (...a) => { counts.writes++; return fsMod.updateDoc(...a); },
    addDoc: (...a) => { counts.writes++; return fsMod.addDoc(...a); },
    deleteDoc: (...a) => { counts.deletes++; return fsMod.deleteDoc(...a); },
    getDoc: (...a) => { counts.reads++; return fsMod.getDoc(...a); },
    getDocs: (...a) => fsMod.getDocs(...a).then((s) => { counts.reads += Math.max(1, s.size); return s; }),
    writeBatch: (db) => { const b = fsMod.writeBatch(db); const w = { set: (...a) => { counts.writes++; b.set(...a); return w; }, update: (...a) => { counts.writes++; b.update(...a); return w; }, delete: (...a) => { counts.deletes++; b.delete(...a); return w; }, commit: () => b.commit() }; return w; },
    runTransaction: (db, fn) => fsMod.runTransaction(db, (tx) => fn({ get: (r) => { counts.reads++; return tx.get(r); }, update: (...a) => { counts.writes++; return tx.update(...a); }, set: (...a) => { counts.writes++; return tx.set(...a); } })),
    onSnapshot: (ref, next, err) => fsMod.onSnapshot(ref, (s) => { counts.reads += s.docChanges ? s.docChanges().filter((c) => c.type !== "removed").length || (s.size ? 0 : 1) : (s.exists() ? 1 : 0); next(s); }, err),
  });
  sdk = { app: require("firebase/app"), auth: require("firebase/auth"), firestore: counted };
  extra = { config: { apiKey: "demo-key", authDomain: "demo-boardgames.firebaseapp.com", projectId: "demo-boardgames", appId: "1:1:web:1" }, emulator: { host: "127.0.0.1", firestorePort: 8090, authPort: 9190 } };
  const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");
  const env = await initializeTestEnvironment({ projectId: "demo-boardgames", firestore: { rules: require("fs").readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8090 } });
  await env.clearFirestore();
} else {
  sdk = makeSdk({ get now() { return Date.now(); } }, { LAT: 15 });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 1; const rng = () => { seq = (seq * 16807) % 2147483647; return seq / 2147483647; };
const mk = (name) => { const o = createOnline(Object.assign({ game: highCard, gameId: "high-card", sdk, appName: name + MODE, botDelayMs: 30, rng }, extra)); const c = { o, snap: null }; o.on("change", (s) => { c.snap = s; }); return c; };
const H = mk("h"), G = mk("g");
const m = await H.o.createRoom({ name: "Hana", seats: ["human", "empty", "computer"], options: { handSize: 13 } });
await G.o.joinRoom(m.code, "Gus");
while (!(H.snap && H.snap.seats[1].kind === "human")) await wait(20);
await H.o.start();
const t0 = Date.now();
while (Date.now() - t0 < 60000 && !(H.snap.status === "finished" && G.snap && G.snap.status === "finished")) {
  for (const c of [H, G]) if (c.snap && c.snap.myTurn && c.snap.mine && c.snap.mine.picked === null) { await c.o.act({ card: c.snap.mine.hand[0] }); }
  await wait(40);
}
const t = MODE === "emu" ? counts : sdk.totals();
console.log(`${MODE}: finished ${H.snap.status === "finished"} round ${H.snap.pub.round}  writes ${t.writes}  deletes ${t.deletes}  reads ${t.reads}${MODE === "fake" ? " (incl. ~rules reads)" : " (listener + get reads, no rules reads)"}`);
process.exit(0);
