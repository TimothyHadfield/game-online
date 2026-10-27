// An in-memory stand-in for the Firebase SDK that BILLS like Firestore, on a
// virtual clock. Used by cost.mjs to measure writes / reads per game for every
// game with the REAL online.js (old or new) and no network.
//
// Billing model (Firestore docs, "Understand Cloud Firestore billing"):
//  - every document set / update / add (also inside a batch or transaction) = 1 write
//  - every delete = 1 delete (a separate 20K/day quota)
//  - getDoc = 1 read, getDocs = max(1, docs) reads
//  - a listener: max(1, docs) reads when it starts, then 1 read per document
//    added or changed (removed docs are free). The writer's own listener pays too.
//  - security rules that get()/exists() another document = 1 read per request
//    (a batch is one request). Modelled on firestore.rules: writes to
//    hands/host/actions/presence and the start of a hands/host/actions/presence
//    listener read the room doc; a takeover reads the host's presence doc.
// Latency: a write lands LAT ms after it is sent; listeners hear it LAT ms later.

export function makeClock() {
  let now = 1_800_000_000_000, seq = 0;
  const timers = new Map();
  const real = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now, setImmediate };
  function add(fn, ms, every, args) {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, ms | 0), fn, every, args, id });
    return { id, unref() { return this; }, ref() { return this; }, hasRef() { return true; }, [Symbol.toPrimitive]() { return id; } };
  }
  const idOf = (t) => (t && typeof t === "object" ? t.id : t);
  const api = {
    get now() { return now; },
    install() {
      globalThis.setTimeout = (fn, ms, ...a) => add(fn, ms, 0, a);
      globalThis.setInterval = (fn, ms, ...a) => add(fn, ms, Math.max(1, ms | 0), a);
      globalThis.clearTimeout = globalThis.clearInterval = (t) => { timers.delete(idOf(t)); };
      Date.now = () => now;
    },
    uninstall() { Object.assign(globalThis, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setInterval: real.setInterval, clearInterval: real.clearInterval }); Date.now = real.now; },
    async settle() { for (let i = 0; i < 4; i++) await new Promise((r) => real.setImmediate(r)); },
    /** Run timers until `until()` is true or virtual `maxMs` has passed. */
    async run(until, maxMs) {
      const end = now + maxMs;
      await api.settle();
      while (!until() && now < end) {
        let next = null;
        for (const t of timers.values()) if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
        if (!next) break;
        now = Math.max(now, next.at);
        if (next.every) next.at = now + next.every; else timers.delete(next.id);
        try { next.fn(...(next.args || [])); } catch (e) { console.error("timer error", e); }
        await api.settle();
      }
    },
  };
  return api;
}

export function makeSdk(clock, { LAT = 60 } = {}) {
  const store = new Map();               // path -> data
  const listeners = new Set();
  const bill = {};                       // uid -> {writes, deletes, reads, ruleReads}
  const tag = {};                        // label -> {writes, reads} (what kind of doc)
  const B = (uid) => (bill[uid] = bill[uid] || { writes: 0, deletes: 0, reads: 0 });
  const T = (k) => (tag[k] = tag[k] || { writes: 0, reads: 0 });
  const kindOf = (path) => { const p = path.split("/"); return p.length <= 4 ? "room" : p[4]; };
  let autoId = 0;

  class Timestamp {
    constructor(ms) { this.ms = ms; this.seconds = Math.floor(ms / 1000); this.nanoseconds = (ms % 1000) * 1e6; }
    toMillis() { return this.ms; }
    static fromMillis(ms) { return new Timestamp(ms); }
    static now() { return new Timestamp(clock.now); }
  }
  const SERVER_TS = { __serverTs: true };
  const cloneData = (x) => {
    if (x === null || typeof x !== "object") return x;
    if (x instanceof Timestamp) return x;
    if (x.__serverTs) return new Timestamp(clock.now);
    if (Array.isArray(x)) return x.map(cloneData);
    const o = {}; for (const k of Object.keys(x)) if (x[k] !== undefined) o[k] = cloneData(x[k]); return o;
  };
  const valid = (x) => {
    // Firestore refuses nested arrays and undefined values (the real SDK throws).
    if (Array.isArray(x)) { for (const v of x) { if (Array.isArray(v)) throw Object.assign(new Error("Nested arrays are not supported"), { code: "invalid-argument" }); valid(v); } }
    else if (x && typeof x === "object" && !(x instanceof Timestamp) && !x.__serverTs) for (const k of Object.keys(x)) { if (x[k] === undefined) throw Object.assign(new Error("undefined field " + k), { code: "invalid-argument" }); valid(x[k]); }
  };
  const docSnap = (path, data, db) => ({
    id: path.split("/").pop(), ref: { path, id: path.split("/").pop(), type: "doc", db },
    exists: () => data !== undefined, data: () => (data === undefined ? undefined : cloneData(data)),
    metadata: { hasPendingWrites: false, fromCache: false },
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parent = (path) => path.split("/").slice(0, -1).join("/");
  const uidOf = (db) => db.auth.currentUser && db.auth.currentUser.uid;

  // ---- tiny model of firestore.rules (enough for online.js's own checks)
  const deny = () => Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
  const roomPath = (path) => path.split("/").slice(0, 4).join("/");
  function checkWrite(uid, op) {
    const { path, kind, data } = op;
    if (kind === "room") {
      const cur = store.get(path);
      if (op.type === "set" && cur && cur.hostUid !== uid) throw deny();          // someone else's room code
      if (op.type === "update" && cur && cur.hostUid !== uid) {
        // a takeover: only hostUid changes, host stale (presence + room update, if the rules check it)
        const pres = store.get(path + "/presence/" + cur.hostUid);
        const age = (t) => (t && t.toMillis ? clock.now - t.toMillis() : Infinity);
        const keys = Object.keys(data);
        if (!(cur.uids || []).includes(uid) || data.hostUid !== uid || keys.some((k) => k !== "hostUid")) throw deny();
        if (age(pres && pres.at) < 40000) throw deny();
        if (sdk.rulesCheckUpdatedAt && age(cur.updatedAt) < 40000) throw deny();
      }
      return;
    }
    const room = store.get(roomPath(path));
    if (kind === "actions" && op.type !== "delete") {
      if (!room || room.status !== "playing" || room.seatUids[data.seat] !== uid || !(room.toAct || []).includes(data.seat)) throw deny();
    }
    if ((kind === "hands" || kind === "host") && (!room || room.hostUid !== uid)) throw deny();
  }
  const ruleReadsFor = (ops) => (ops.some((o) => ["hands", "host", "actions", "presence"].includes(o.kind) && o.type !== "delete") ? 1 : 0)
    + (ops.some((o) => o.kind === "room" && o.type === "update" && store.get(o.path) && store.get(o.path).hostUid !== o.uid) ? 1 : 0);

  async function commit(db, ops) {
    const uid = uidOf(db);
    await sleep(LAT);
    for (const o of ops) { o.uid = uid; o.kind = kindOf(o.path); checkWrite(uid, o); }
    if (ops.some((o) => o.type === "update" && !store.has(o.path))) throw Object.assign(new Error("No document to update"), { code: "not-found" });
    const b = B(uid);
    b.reads += ruleReadsFor(ops);
    const changed = [];
    for (const o of ops) {
      if (o.type === "delete") { b.deletes++; if (store.has(o.path)) { store.delete(o.path); changed.push(o.path); } continue; }
      b.writes++; T(o.kind).writes++;
      const d = cloneData(o.data);
      store.set(o.path, o.type === "update" ? Object.assign({}, store.get(o.path), d) : d);
      changed.push(o.path);
    }
    setTimeout(() => notify(changed), LAT);
  }

  function notify(paths) {
    for (const L of [...listeners]) {
      if (!listeners.has(L)) continue;
      if (L.type === "doc") {
        if (!paths.includes(L.path)) continue;
        const data = store.get(L.path);
        if (data !== undefined) { B(L.uid).reads++; T(kindOf(L.path)).reads++; }
        L.next(docSnap(L.path, data, L.db));
      } else {
        const hits = paths.filter((p) => parent(p) === L.path);
        if (!hits.length) continue;
        const changes = hits.filter((p) => store.has(p));
        B(L.uid).reads += changes.length; T(kindOf(L.path + "/x")).reads += changes.length;
        L.next(querySnap(L.path, changes, L.db));
      }
    }
  }
  function querySnap(colPath, changedPaths, db) {
    const docs = [...store.keys()].filter((p) => parent(p) === colPath).sort().map((p) => docSnap(p, store.get(p), db));
    return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f), docChanges: () => (changedPaths || []).map((p) => ({ doc: docSnap(p, store.get(p), db) })) };
  }

  const firestore = {
    Timestamp,
    getFirestore: (app) => ({ app, auth: app.auth }),
    connectFirestoreEmulator() {},
    serverTimestamp: () => SERVER_TS,
    doc: (db, ...seg) => ({ db, path: seg.join("/"), id: seg[seg.length - 1], type: "doc" }),
    collection: (db, ...seg) => ({ db, path: seg.join("/"), type: "col" }),
    collectionGroup: (db, id) => ({ db, group: id, type: "group" }),
    where: (field, op, value) => ({ field, op, value }),
    limit: (n) => ({ limit: n }),
    query: (q, ...c) => Object.assign({}, q, { constraints: c }),
    async setDoc(ref, data) { valid(data); await commit(ref.db, [{ type: "set", path: ref.path, data }]); },
    async updateDoc(ref, data) { valid(data); await commit(ref.db, [{ type: "update", path: ref.path, data }]); },
    async addDoc(col, data) { valid(data); const path = col.path + "/a" + (++autoId); await commit(col.db, [{ type: "set", path, data }]); return { path, id: path.split("/").pop(), type: "doc", db: col.db }; },
    async deleteDoc(ref) { await commit(ref.db, [{ type: "delete", path: ref.path }]); },
    async getDoc(ref) { await sleep(LAT); B(uidOf(ref.db)).reads++; return docSnap(ref.path, store.get(ref.path), ref.db); },
    async getDocs(q) {
      await sleep(LAT);
      let docs;
      if (q.type === "group") {
        const f = (q.constraints || []).find((c) => c.field), lim = (q.constraints || []).find((c) => c.limit);
        docs = [...store.keys()].filter((p) => kindOf(p) === (q.group === "rooms" ? "room" : q.group) && (!f || (store.get(p)[f.field] && store.get(p)[f.field].toMillis() < f.value.toMillis()))).slice(0, lim ? lim.limit : 1e9);
        docs = docs.map((p) => docSnap(p, store.get(p), q.db));
      } else docs = [...store.keys()].filter((p) => parent(p) === q.path).map((p) => docSnap(p, store.get(p), q.db));
      B(uidOf(q.db)).reads += Math.max(1, docs.length);
      return { docs, size: docs.length, forEach: (fn) => docs.forEach(fn) };
    },
    onSnapshot(ref, next) {
      const uid = uidOf(ref.db);
      const L = { type: ref.type, path: ref.path, next, uid, db: ref.db };
      listeners.add(L);
      const k = kindOf(ref.type === "doc" ? ref.path : ref.path + "/x");
      if (["host", "actions", "presence"].includes(k)) B(uid).reads++;   // rules get() at listen time
      setTimeout(() => {
        if (!listeners.has(L)) return;
        if (L.type === "doc") { B(uid).reads++; T(k).reads++; next(docSnap(L.path, store.get(L.path), L.db)); }
        else { const s = querySnap(L.path, [...store.keys()].filter((p) => parent(p) === L.path), L.db); B(uid).reads += Math.max(1, s.size); T(k).reads += Math.max(1, s.size); next(s); }
      }, LAT);
      return () => listeners.delete(L);
    },
    writeBatch(db) {
      const ops = [];
      const b = {
        set(ref, data) { valid(data); ops.push({ type: "set", path: ref.path, data }); return b; },
        update(ref, data) { valid(data); ops.push({ type: "update", path: ref.path, data }); return b; },
        delete(ref) { ops.push({ type: "delete", path: ref.path }); return b; },
        commit: () => commit(db, ops),
      };
      return b;
    },
    async runTransaction(db, fn) {
      const ops = [];
      const tx = {
        async get(ref) { B(uidOf(db)).reads++; return docSnap(ref.path, store.get(ref.path), db); },
        update(ref, data) { ops.push({ type: "update", path: ref.path, data }); return tx; },
        set(ref, data) { ops.push({ type: "set", path: ref.path, data }); return tx; },
      };
      const r = await fn(tx);
      await commit(db, ops);
      return r;
    },
  };
  let uidSeq = 0;
  const app = { getApps: () => [], initializeApp: (config, name) => ({ name, auth: { currentUser: null } }) };
  const auth = {
    getAuth: (a) => a.auth, connectAuthEmulator() {},
    async signInAnonymously(au) { au.currentUser = { uid: "u" + (++uidSeq) }; return { user: au.currentUser }; },
  };
  const sdk = { app, auth, firestore, bill, tag, store, rulesCheckUpdatedAt: false,
    totals() { const t = { writes: 0, deletes: 0, reads: 0 }; for (const b of Object.values(bill)) for (const k in t) t[k] += b[k]; return t; } };
  return sdk;
}
