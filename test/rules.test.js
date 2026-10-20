/* rules.test.js — emulator tests for firestore.rules (run via `npm test`).
 * alice hosts room ABCDE of game "hearts"; bob is seated; carol is a stranger. */
const fs = require("fs");
const path = require("path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, addDoc, serverTimestamp, Timestamp, writeBatch, collectionGroup, query, where, limit } = require("firebase/firestore");

let pass = 0, fail = 0;
async function check(label, p) {
  try { await p; console.log("  PASS  " + label); pass++; }
  catch (e) { console.log("  FAIL  " + label + "\n          -> " + String(e.message || e).split("\n")[0]); fail++; }
}
const R = "games/hearts/rooms/ABCDE";
const soon = () => Timestamp.fromMillis(Date.now() + 24 * 3600e3);
const ROOM = () => ({
  gameId: "hearts", hostUid: "alice", uids: ["alice", "bob"],
  seats: [{ kind: "human", name: "Alice", uid: "alice" }, { kind: "human", name: "Bob", uid: "bob" }, { kind: "computer", name: "C", uid: "" }],
  seatUids: ["alice", "bob", ""], status: "playing", options: {}, pubJson: "{}", toAct: [1], v: 3, hv: {},
  createdAt: Timestamp.now(), updatedAt: Timestamp.now(), expireAt: soon(),
});
const move = (by, seat, extra = {}) => Object.assign({ by, seat, a: { card: 5 }, at: serverTimestamp(), expireAt: soon() }, extra);

(async () => {
  const env = await initializeTestEnvironment({
    projectId: "demo-boardgames",
    // RULES_FILE lets you point the suite at broken rules to prove it catches them.
    firestore: { rules: fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, "..", "firestore.rules"), "utf8"), host: "127.0.0.1", port: 8090 },
  });
  async function seed(roomPatch = {}, hostAt = Timestamp.now()) {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, R), Object.assign(ROOM(), roomPatch));
      await setDoc(doc(db, R + "/hands/alice"), { json: "[1,2]", v: 1, expireAt: soon() });
      await setDoc(doc(db, R + "/hands/bob"), { json: "[40,41]", v: 1, expireAt: soon() });
      await setDoc(doc(db, R + "/host/state"), { s: "{secret}", v: 1, expireAt: soon() });
      await setDoc(doc(db, R + "/actions/a1"), { by: "bob", seat: 1, a: {}, at: Timestamp.now(), expireAt: soon() });
      await setDoc(doc(db, R + "/presence/alice"), { at: hostAt, expireAt: soon() });
      await setDoc(doc(db, R + "/joins/carol"), { name: "Carol", leave: false, at: Timestamp.now(), expireAt: soon() });
    });
  }
  const as = (u) => env.authenticatedContext(u).firestore();
  const anon = () => env.unauthenticatedContext().firestore();

  console.log("Hidden hands");
  await seed();
  await check("bob reads his own hand", assertSucceeds(getDoc(doc(as("bob"), R + "/hands/bob"))));
  await check("bob CANNOT read alice's hand", assertFails(getDoc(doc(as("bob"), R + "/hands/alice"))));
  await check("host alice CANNOT read bob's hand doc", assertFails(getDoc(doc(as("alice"), R + "/hands/bob"))));
  await check("stranger carol CANNOT read any hand", assertFails(getDoc(doc(as("carol"), R + "/hands/bob"))));
  await check("nobody can LIST hands (bob)", assertFails(getDocs(collection(as("bob"), R + "/hands"))));
  await check("nobody can LIST hands (host)", assertFails(getDocs(collection(as("alice"), R + "/hands"))));
  await check("bob CANNOT read the host's full state", assertFails(getDoc(doc(as("bob"), R + "/host/state"))));
  await check("host reads the full state", assertSucceeds(getDoc(doc(as("alice"), R + "/host/state"))));
  await check("bob CANNOT write his own hand", assertFails(setDoc(doc(as("bob"), R + "/hands/bob"), { json: "[51]", v: 9, expireAt: soon() })));
  await check("host writes bob's hand", assertSucceeds(setDoc(doc(as("alice"), R + "/hands/bob"), { json: "[3]", v: 4, expireAt: soon() })));
  await check("host CANNOT write a hand that never expires", assertFails(setDoc(doc(as("alice"), R + "/hands/bob"), { json: "[3]", v: 4, expireAt: Timestamp.fromMillis(Date.now() + 30 * 864e5) })));
  await check("signed-out user reads nothing", assertFails(getDoc(doc(anon(), R))));

  console.log("Moves: own seat, own turn");
  await seed();
  await check("bob moves for seat 1 on his turn", assertSucceeds(addDoc(collection(as("bob"), R + "/actions"), move("bob", 1))));
  await check("alice CANNOT move out of turn (seat 0 not in toAct)", assertFails(addDoc(collection(as("alice"), R + "/actions"), move("alice", 0))));
  await check("bob CANNOT move for alice's seat", assertFails(addDoc(collection(as("bob"), R + "/actions"), move("bob", 0))));
  await check("bob CANNOT move for the computer seat", assertFails(addDoc(collection(as("bob"), R + "/actions"), move("bob", 2))));
  await check("bob CANNOT sign a move as alice", assertFails(addDoc(collection(as("bob"), R + "/actions"), move("alice", 1))));
  await check("bob CANNOT backdate a move", assertFails(addDoc(collection(as("bob"), R + "/actions"), move("bob", 1, { at: Timestamp.fromMillis(0) }))));
  await check("bob CANNOT add extra fields", assertFails(addDoc(collection(as("bob"), R + "/actions"), move("bob", 1, { x: 1 }))));
  await check("seat index out of range refused", assertFails(addDoc(collection(as("bob"), R + "/actions"), move("bob", 7))));
  await check("stranger carol CANNOT move", assertFails(addDoc(collection(as("carol"), R + "/actions"), move("carol", 1))));
  await check("bob CANNOT read the move queue", assertFails(getDocs(collection(as("bob"), R + "/actions"))));
  await check("host reads the move queue", assertSucceeds(getDocs(collection(as("alice"), R + "/actions"))));
  await check("bob CANNOT delete a move", assertFails(deleteDoc(doc(as("bob"), R + "/actions/a1"))));
  await check("host deletes a processed move", assertSucceeds(deleteDoc(doc(as("alice"), R + "/actions/a1"))));
  await seed({ status: "lobby" });
  await check("no moves while the room is in the lobby", assertFails(addDoc(collection(as("bob"), R + "/actions"), move("bob", 1))));

  console.log("The room");
  await seed();
  await check("anyone signed in can fetch a room by code", assertSucceeds(getDoc(doc(as("carol"), R))));
  await check("rooms can NOT be listed", assertFails(getDocs(collection(as("carol"), "games/hearts/rooms"))));
  await check("bob CANNOT change the room", assertFails(updateDoc(doc(as("bob"), R), { toAct: [0, 1, 2] })));
  await check("bob CANNOT take the host while alice is alive", assertFails(updateDoc(doc(as("bob"), R), { hostUid: "bob" })));
  await check("carol CANNOT seat herself", assertFails(updateDoc(doc(as("carol"), R), { uids: ["alice", "bob", "carol"] })));
  await check("host updates the room", assertSucceeds(updateDoc(doc(as("alice"), R), { toAct: [0], v: 4, expireAt: soon() })));
  await check("host CANNOT hand hosting to a non-member", assertFails(updateDoc(doc(as("alice"), R), { hostUid: "carol" })));
  await check("host CANNOT set a far-future expiry", assertFails(updateDoc(doc(as("alice"), R), { expireAt: Timestamp.fromMillis(Date.now() + 10 * 864e5) })));
  await check("host CANNOT add unknown fields", assertFails(updateDoc(doc(as("alice"), R), { junk: "x".repeat(10) })));
  await check("host hands hosting to member bob", assertSucceeds(updateDoc(doc(as("alice"), R), { hostUid: "bob" })));
  await seed({}, Timestamp.fromMillis(Date.now() - 120e3));
  await check("bob TAKES the host when alice's heartbeat is 2 min old", assertSucceeds(updateDoc(doc(as("bob"), R), { hostUid: "bob" })));
  await check("…and then can read the full state", assertSucceeds(getDoc(doc(as("bob"), R + "/host/state"))));
  await check("…and old host alice can no longer publish", assertFails(updateDoc(doc(as("alice"), R), { v: 9 })));
  await seed({}, Timestamp.fromMillis(Date.now() - 120e3));
  await check("stale host: carol (not a member) still CANNOT take it", assertFails(updateDoc(doc(as("carol"), R), { hostUid: "carol" })));
  await check("stale host: bob CANNOT take it AND change other fields", assertFails(updateDoc(doc(as("bob"), R), { hostUid: "bob", toAct: [0] })));
  await check("bob CANNOT delete the room", assertFails(deleteDoc(doc(as("bob"), R))));

  console.log("Creating rooms");
  await env.clearFirestore();
  const newRoom = (host, patch = {}) => Object.assign(ROOM(), { hostUid: host, uids: [host], seatUids: [host, "", ""], status: "lobby", v: 0, toAct: [] }, patch);
  await check("dave creates a room he hosts", assertSucceeds(setDoc(doc(as("dave"), "games/coup/rooms/QWERT"), Object.assign(newRoom("dave"), { gameId: "coup" }))));
  await check("dave CANNOT overwrite it as a stranger (erin)", assertFails(setDoc(doc(as("erin"), "games/coup/rooms/QWERT"), Object.assign(newRoom("erin"), { gameId: "coup" }))));
  await check("CANNOT create a room for someone else", assertFails(setDoc(doc(as("dave"), "games/coup/rooms/ZXCVB"), Object.assign(newRoom("erin"), { gameId: "coup" }))));
  await check("CANNOT create a room pre-filled with members", assertFails(setDoc(doc(as("dave"), "games/coup/rooms/ZXCVB"), Object.assign(newRoom("dave"), { gameId: "coup", uids: ["dave", "erin"] }))));
  await check("gameId must match the path", assertFails(setDoc(doc(as("dave"), "games/coup/rooms/ZXCVB"), newRoom("dave"))));
  await check("CANNOT create a room without expiry", assertFails(setDoc(doc(as("dave"), "games/coup/rooms/ZXCVB"), Object.assign(newRoom("dave"), { gameId: "coup", expireAt: null }))));
  await check("bad game id refused", assertFails(setDoc(doc(as("dave"), "games/Bad_Id/rooms/ZXCVB"), Object.assign(newRoom("dave"), { gameId: "Bad_Id" }))));
  await check("nothing outside games/ is writable", assertFails(setDoc(doc(as("dave"), "junk/x"), { a: 1 })));

  console.log("Presence and join notes");
  await seed();
  await check("bob writes his heartbeat", assertSucceeds(setDoc(doc(as("bob"), R + "/presence/bob"), { at: serverTimestamp(), expireAt: soon() })));
  await check("bob CANNOT fake a heartbeat time", assertFails(setDoc(doc(as("bob"), R + "/presence/bob"), { at: Timestamp.fromMillis(Date.now() + 864e5), expireAt: soon() })));
  await check("bob CANNOT refresh alice's heartbeat", assertFails(setDoc(doc(as("bob"), R + "/presence/alice"), { at: serverTimestamp(), expireAt: soon() })));
  await check("stranger carol CANNOT write presence", assertFails(setDoc(doc(as("carol"), R + "/presence/carol"), { at: serverTimestamp(), expireAt: soon() })));
  await check("bob reads presence", assertSucceeds(getDocs(collection(as("bob"), R + "/presence"))));
  await check("carol CANNOT read presence", assertFails(getDocs(collection(as("carol"), R + "/presence"))));
  await check("erin leaves a join note", assertSucceeds(setDoc(doc(as("erin"), R + "/joins/erin"), { name: "Erin", leave: false, at: serverTimestamp(), expireAt: soon() })));
  await check("erin CANNOT leave a note as someone else", assertFails(setDoc(doc(as("erin"), R + "/joins/frank"), { name: "F", leave: false, at: serverTimestamp(), expireAt: soon() })));
  await check("over-long name refused", assertFails(setDoc(doc(as("erin"), R + "/joins/erin"), { name: "x".repeat(21), leave: false, at: serverTimestamp(), expireAt: soon() })));
  await check("bob CANNOT list join notes", assertFails(getDocs(collection(as("bob"), R + "/joins"))));
  await check("host lists join notes", assertSucceeds(getDocs(collection(as("alice"), R + "/joins"))));
  await check("host deletes a join note", assertSucceeds(deleteDoc(doc(as("alice"), R + "/joins/carol"))));

  console.log("Host publish batch (as online.js does it)");
  await seed();
  {
    const db = as("alice"); const b = writeBatch(db);
    b.set(doc(db, R + "/hands/bob"), { json: "[7]", v: 4, expireAt: soon() });
    b.set(doc(db, R + "/host/state"), { s: "{}", v: 4, expireAt: soon() });
    b.update(doc(db, R), { pubJson: "{}", toAct: [0], v: 4, hv: { bob: 4 }, status: "playing", updatedAt: serverTimestamp(), expireAt: soon() });
    await check("host's publish batch commits", assertSucceeds(b.commit()));
  }

  console.log("Self-cleaning (expired docs only)");
  await seed();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore(); const old = Timestamp.fromMillis(Date.now() - 3600e3);
    await setDoc(doc(db, "games/coup/rooms/OLDRM"), Object.assign(ROOM(), { gameId: "coup", expireAt: old }));
    await setDoc(doc(db, "games/coup/rooms/OLDRM/hands/zed"), { json: "[9]", v: 1, expireAt: old });
  });
  const expQ = (g) => query(collectionGroup(as("carol"), g), where("expireAt", "<", Timestamp.now()), limit(25));
  await check("carol lists EXPIRED rooms", assertSucceeds(getDocs(expQ("rooms"))));
  await check("carol lists EXPIRED hands", assertSucceeds(getDocs(expQ("hands"))));
  await check("carol CANNOT list rooms without the expiry filter", assertFails(getDocs(query(collectionGroup(as("carol"), "rooms"), limit(25)))));
  await check("carol CANNOT list hands with a future cutoff", assertFails(getDocs(query(collectionGroup(as("carol"), "hands"), where("expireAt", "<", Timestamp.fromMillis(Date.now() + 864e5))))));
  await check("carol deletes an expired room", assertSucceeds(deleteDoc(doc(as("carol"), "games/coup/rooms/OLDRM"))));
  await check("carol deletes an expired hand", assertSucceeds(deleteDoc(doc(as("carol"), "games/coup/rooms/OLDRM/hands/zed"))));
  await check("carol CANNOT delete a live room", assertFails(deleteDoc(doc(as("carol"), R))));
  await check("carol CANNOT delete a live hand", assertFails(deleteDoc(doc(as("carol"), R + "/hands/bob"))));

  await env.cleanup();
  console.log(`\nrules: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
