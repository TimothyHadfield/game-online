/* ============================================================================
 * online.js — shared play layer for Tim's board and card game sites.
 * Copy this ONE file into a game's js/ folder. See README.md for the API.
 *
 * Two kinds of room, same shape:
 *   createLocal(...)   everything on this device: you + computers (+ pass-the-phone)
 *   createOnline(...)  a room on Firebase with a short code: people + computers
 *
 * The game supplies pure functions (setup / toAct / apply / publicView /
 * privateView / bot / isOver). This file never knows the rules of any game.
 *
 * SERVERLESS AND HOST-AUTHORITATIVE (same approach as Cribbage's online.js).
 * The free Firebase plan has no server code, so the room creator's browser is
 * the referee: it holds the full state, applies every move, runs the computer
 * seats, and publishes (a) the public view everyone reads and (b) one private
 * document per human seat that ONLY that player can read (firestore.rules).
 * Limitation, accepted: the host's own browser holds the whole state.
 *
 * FIRESTORE LAYOUT (all under games/{gameId}/rooms/{CODE}):
 *   room doc            public: seats, status, toAct, pubJson, version
 *   hands/{uid}         that player's secrets — only that uid can read
 *   host/state          the full state — only the current host
 *   actions/{id}        moves from non-host players — host reads + deletes
 *   presence/{uid}      heartbeat, so a closed tab / lost host is noticed
 *   joins/{uid}         "let me in" / "I'm leaving" notes for the host
 * Every doc carries expireAt; a TTL policy deletes abandoned rooms for free.
 * ==========================================================================*/

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBUqX7BtfcOQjp8VeFa0D8YKnjuh-cgn2A",
  authDomain: "th-board-games.firebaseapp.com",
  projectId: "th-board-games",
  storageBucket: "th-board-games.firebasestorage.app",
  messagingSenderId: "595827640712",
  appId: "1:595827640712:web:f992e21a46f453ee0ad23d",
};
// These values are public by design: they name the project, they grant
// nothing. The security boundary is firestore.rules.

const CDN = "https://www.gstatic.com/firebasejs/12.16.0/";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1
const CODE_LEN = 5;
export const HEARTBEAT_MS = 25000;
export const STALE_MS = 75000;          // must match hostStale() in firestore.rules
const TTL_MS = 2 * 24 * 3600 * 1000;    // rules allow at most 3 days ahead
const MAX_SEATS = 12;
const NAME_MAX = 20;

// ------------------------------------------------------------ tiny helpers
function emitter() {
  const fns = {};
  return {
    on(ev, fn) { (fns[ev] = fns[ev] || []).push(fn); return () => { fns[ev] = fns[ev].filter((f) => f !== fn); }; },
    emit(ev, x) { for (const f of fns[ev] || []) { try { f(x); } catch (e) { console.error(e); } } },
  };
}
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const cleanName = (n) => String(n || "Player").trim().slice(0, NAME_MAX) || "Player";
const store = {
  get(k) { try { return JSON.parse(globalThis.localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { globalThis.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { globalThis.localStorage.removeItem(k); } catch (e) {} },
};

/** Normalise a seat list: 'human' | 'computer' | 'empty' strings or {kind,name}. */
function normSeats(seats) {
  return (seats || []).map((s, i) => {
    const o = typeof s === "string" ? { kind: s } : Object.assign({}, s);
    if (!["human", "computer", "empty"].includes(o.kind)) throw new Error("bad seat kind: " + o.kind);
    o.name = o.kind === "computer" ? (o.name || "Computer " + (i + 1)) : (o.name || "");
    o.uid = o.uid || "";
    return o;
  });
}

/** Apply one move with full checking. Throws on anything illegal. */
function step(game, state, seat, action, rng) {
  if (game.isOver(state)) throw new Error("game over");
  if (!game.toAct(state).includes(seat)) throw new Error("not your turn");
  const next = game.apply(clone(state), seat, clone(action), rng);
  if (next === undefined || next === null) throw new Error("apply() returned nothing");
  return next;
}
const botCtx = (game, state, seat) => ({
  pub: game.publicView(state), mine: game.privateView(state, seat), state,
});

// ======================================================================
// LOCAL ROOM — same events and shape as an online room, no network.
// ======================================================================
export function createLocal({ game, seats, options = {}, botDelayMs = 600, rng = Math.random, names = [] }) {
  const ev = emitter();
  const S = normSeats(seats).map((s, i) => Object.assign(s, { name: s.name || names[i] || (s.kind === "human" ? "Player " + (i + 1) : s.name) }));
  let state = game.setup(S.length, options, rng, S.map((s) => ({ kind: s.kind, name: s.name })));
  let timer = null, closed = false;

  const snapshot = (seat) => {
    const over = game.isOver(state);
    const toAct = over ? [] : game.toAct(state);
    return {
      mode: "local", status: over ? "finished" : "playing", code: null,
      seats: S.map((s) => ({ kind: s.kind, name: s.name, online: true })),
      toAct, pub: game.publicView(state),
      mySeat: seat, mine: seat == null ? null : game.privateView(state, seat),
      myTurn: seat != null && toAct.includes(seat), isHost: true, hostAway: false,
    };
  };
  const humanToAct = () => game.toAct(state).filter((s) => S[s].kind === "human");
  const changed = () => { ev.emit("change", snapshot(humanToAct()[0] ?? S.findIndex((s) => s.kind === "human"))); scheduleBots(); };

  function scheduleBots() {
    if (timer || closed || game.isOver(state)) return;
    const bots = game.toAct(state).filter((s) => S[s].kind === "computer");
    if (!bots.length) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        for (const b of bots) {
          if (game.isOver(state) || !game.toAct(state).includes(b)) continue;
          state = step(game, state, b, game.bot(botCtx(game, state, b), b, rng), rng);
        }
      } catch (e) { ev.emit("error", e); return; }
      changed();
    }, botDelayMs);
  }

  return {
    mode: "local",
    on: ev.on,
    /** Submit a move for a human seat (pass-the-phone: name which seat). */
    act(action, seat) {
      if (seat == null) seat = humanToAct()[0];
      try { state = step(game, state, seat, action, rng); }
      catch (e) { ev.emit("error", e); return { ok: false, message: e.message }; }
      changed();
      return { ok: true };
    },
    view: (seat) => snapshot(seat),
    get state() { return state; },
    start() { changed(); },
    close() { closed = true; clearTimeout(timer); },
  };
}

// ======================================================================
// ONLINE ROOM
// ======================================================================
/**
 * @param {object} o
 * @param {object} o.game     the game's pure functions (see README)
 * @param {string} [o.gameId] namespace, lower-case letters/digits/dashes (default game.id)
 * @param {number} [o.botDelayMs]  pause before each computer move
 * @param {object} [o.sdk]    tests only: {app, auth, firestore} modules (npm firebase)
 * @param {object} [o.emulator] tests only: {host, firestorePort, authPort}
 */
export function createOnline({ game, gameId = game && game.id, config = FIREBASE_CONFIG, botDelayMs = 700, rng = Math.random, sdk = null, emulator = null, appName } = {}) {
  if (!/^[a-z0-9-]{1,32}$/.test(String(gameId))) throw new Error("gameId must be lower-case letters, digits or dashes");
  const ev = emitter();
  const RESUME_KEY = "online." + gameId;

  let F = null;            // firestore functions
  let db = null, auth = null;
  let me = null;           // my uid
  let code = null, room = null, mine = null, myHandV = -1;
  let joinPending = false;
  let subs = [];
  let hostSubs = [];
  let actingHost = false, hostState = null, lastHand = {};
  let processing = false, rerun = false, botTimer = null;
  let presence = {};       // uid -> millis
  let heartbeat = null, staleTimer = null, claimTimer = null;
  let lastError = null;

  // ------------------------------------------------------------ setup
  async function ready() {
    if (me) return me;
    if (!F) {
      const mods = sdk || await Promise.all([
        import(CDN + "firebase-app.js"), import(CDN + "firebase-auth.js"), import(CDN + "firebase-firestore.js"),
      ]).then(([app, a, fs]) => ({ app, auth: a, firestore: fs }));
      const name = appName || "online-" + gameId;
      const existing = mods.app.getApps().find((a) => a.name === name);
      const app = existing || mods.app.initializeApp(config, name);
      auth = mods.auth.getAuth(app);
      db = mods.firestore.getFirestore(app);
      if (emulator && !existing) {
        mods.auth.connectAuthEmulator(auth, `http://${emulator.host}:${emulator.authPort}`, { disableWarnings: true });
        mods.firestore.connectFirestoreEmulator(db, emulator.host, emulator.firestorePort);
      }
      F = Object.assign({}, mods.firestore, { signInAnonymously: mods.auth.signInAnonymously });
    }
    if (!auth.currentUser) await F.signInAnonymously(auth);
    me = auth.currentUser.uid;
    return me;
  }

  const P = {
    room: (c) => F.doc(db, "games", gameId, "rooms", c),
    hand: (uid) => F.doc(db, "games", gameId, "rooms", code, "hands", uid),
    hostDoc: () => F.doc(db, "games", gameId, "rooms", code, "host", "state"),
    actions: () => F.collection(db, "games", gameId, "rooms", code, "actions"),
    presence: () => F.collection(db, "games", gameId, "rooms", code, "presence"),
    pres: (uid) => F.doc(db, "games", gameId, "rooms", code, "presence", uid),
    joins: () => F.collection(db, "games", gameId, "rooms", code, "joins"),
    join: (uid) => F.doc(db, "games", gameId, "rooms", code, "joins", uid),
  };
  const expireAt = () => F.Timestamp.fromMillis(Date.now() + TTL_MS);
  const isOnline = (uid) => !!uid && presence[uid] != null && Date.now() - presence[uid] < STALE_MS;
  const mySeat = () => (room ? room.seatUids.indexOf(me) : -1);

  // ------------------------------------------------------------ snapshot
  function snapshot() {
    if (!room) return { mode: "online", status: joinPending ? "joining" : "none", code, error: lastError };
    const seat = mySeat();
    let pub = null;
    try { pub = JSON.parse(room.pubJson || "null"); } catch (e) {}
    const toAct = room.toAct || [];
    return {
      mode: "online", code, status: room.status,
      seats: room.seats.map((s) => ({ kind: s.kind, name: s.name, online: s.kind !== "human" || isOnline(s.uid), isHost: s.uid === room.hostUid && !!s.uid })),
      mySeat: seat, isHost: room.hostUid === me,
      hostAway: room.hostUid !== me && !isOnline(room.hostUid),
      options: room.options || {},
      pub, mine, toAct, myTurn: seat >= 0 && toAct.includes(seat),
      v: room.v, error: lastError,
    };
  }
  // Hold the event until my private doc has caught up with the room version,
  // so a UI never shows the new table with the old hand.
  const changed = () => {
    if (room && room.hv && room.hv[me] > myHandV && room.uids.includes(me)) return;
    ev.emit("change", snapshot());
  };
  const fail = (e) => { lastError = humanError(e); ev.emit("error", lastError); changed(); return { ok: false, message: lastError }; };

  // ------------------------------------------------------------ cleanup
  /**
   * Delete up to `per` expired docs from each collection, across all games.
   * Firestore TTL needs billing, so the players' browsers do the sweeping.
   * Runs at most once per 6 h per browser (on createRoom), ~6 reads + deletes.
   */
  async function sweep({ per = 25, force = false } = {}) {
    const KEY = "online.sweptAt";
    if (!force && Date.now() - (store.get(KEY) || 0) < 6 * 3600e3) return 0;
    store.set(KEY, Date.now());
    let n = 0;
    for (const g of ["rooms", "hands", "host", "actions", "presence", "joins"]) {
      try {
        const snap = await F.getDocs(F.query(F.collectionGroup(db, g), F.where("expireAt", "<", F.Timestamp.fromMillis(Date.now() - 600e3)), F.limit(per)));
        for (const d of snap.docs) { try { await F.deleteDoc(d.ref); n++; } catch (e) {} }
      } catch (e) { /* index still building, offline, … — try another day */ }
    }
    return n;
  }

  // ------------------------------------------------------------ rooms
  async function createRoom({ name, seats = ["human", "empty"], options = {} } = {}) {
    try { await ready(); } catch (e) { return fail(e); }
    await detach();
    const S = normSeats(seats);
    if (S.length < 1 || S.length > MAX_SEATS) return fail(new Error("1–12 seats"));
    let hostSeat = S.findIndex((s) => s.kind === "human");
    if (hostSeat < 0) { hostSeat = 0; S[0].kind = "human"; }
    S[hostSeat] = { kind: "human", name: cleanName(name), uid: me };
    for (let i = 0; i < S.length; i++) if (i !== hostSeat && S[i].kind === "human") S[i] = { kind: "empty", name: "", uid: "" };
    for (let attempt = 0; attempt < 8; attempt++) {
      const c = newCode();
      try {
        await F.runTransaction(db, async (tx) => {
          const r = await tx.get(P.room(c));
          if (r.exists()) throw new Error("taken");
          tx.set(P.room(c), {
            gameId, hostUid: me, uids: [me], seats: S, seatUids: S.map((s) => s.uid),
            status: "lobby", options: clone(options), pubJson: "null", toAct: [], v: 0, hv: {},
            createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp(), expireAt: expireAt(),
          });
        });
        await attach(c);
        sweep().catch(() => {});
        return { ok: true, code: c };
      } catch (e) {
        if (String(e.message) !== "taken" && !String(e.code || "").includes("permission")) return fail(e);
      }
    }
    return fail(new Error("Couldn't make a room code. Try again."));
  }

  async function joinRoom(c, name) {
    try { await ready(); } catch (e) { return fail(e); }
    c = String(c || "").trim().toUpperCase();
    await detach();
    let snap;
    try { snap = await F.getDoc(P.room(c)); } catch (e) { return fail(e); }
    if (!snap.exists()) return fail(new Error("No room with that code."));
    const r = snap.data();
    code = c;
    if (r.uids.includes(me)) { await attach(c); return { ok: true, code: c, seat: r.seatUids.indexOf(me) }; }
    const hasRoom = r.status === "lobby"
      ? r.seats.some((s) => s.kind === "empty")
      : r.seats.some((s) => s.kind === "human" && s.name === cleanName(name));
    if (!hasRoom) { code = null; return fail(new Error(r.status === "lobby" ? "That room is full." : "That game has already started.")); }
    try {
      await F.setDoc(P.join(me), { name: cleanName(name), leave: false, at: F.serverTimestamp(), expireAt: expireAt() });
    } catch (e) { code = null; return fail(e); }
    joinPending = true;
    await attach(c);
    // Wait for the host to seat us (or turn us away by deleting the note).
    return await new Promise((resolve) => {
      let seenNote = false;
      const t = setTimeout(() => { off(); unsubNote(); resolve(fail(new Error("The host didn't answer. Are they still there?"))); }, 20000);
      const off = ev.on("change", (s) => {
        if (s.mySeat >= 0) { clearTimeout(t); off(); unsubNote(); joinPending = false; resolve({ ok: true, code: c, seat: s.mySeat }); }
      });
      const unsubNote = F.onSnapshot(P.join(me), (d) => {
        if (d.exists()) { seenNote = true; return; }
        if (seenNote && mySeat() < 0) {
          setTimeout(() => { if (mySeat() < 0) { clearTimeout(t); off(); unsubNote(); joinPending = false; detach(); resolve(fail(new Error("No free seat in that room."))); } }, 1500);
        }
      }, () => {});
    });
  }

  /** Re-enter the last room after a reload. Resolves true if back in. */
  async function resume() {
    const saved = store.get(RESUME_KEY);
    if (!saved || !saved.code) return false;
    try {
      await ready();
      const snap = await F.getDoc(P.room(saved.code));
      if (!snap.exists() || !snap.data().uids.includes(me) || snap.data().status === "closed") { store.del(RESUME_KEY); return false; }
      await attach(saved.code);
      return true;
    } catch (e) { store.del(RESUME_KEY); return false; }
  }

  // ------------------------------------------------------------ listeners
  async function attach(c) {
    code = c;
    lastError = null;
    subs.push(F.onSnapshot(P.room(c), (snap) => {
      if (!snap.exists()) { room = null; mine = null; store.del(RESUME_KEY); stopTimers(); stopHost(); ev.emit("change", { mode: "online", status: "closed", code }); return; }
      const wasMember = room && room.uids.includes(me);
      room = snap.data();
      const member = room.uids.includes(me);
      if (member) {
        store.set(RESUME_KEY, { code: c });
        if (!wasMember) { listenMember(); startHeartbeat(); }
      } else if (wasMember) {
        // removed from the room
        store.del(RESUME_KEY); stopTimers(); room = null; mine = null;
        ev.emit("change", { mode: "online", status: "left", code });
        detach();
        return;
      }
      if (room.hostUid === me && !actingHost) becomeHost();
      else if (room.hostUid !== me && actingHost) stopHost();
      if (actingHost) scheduleBots();
      changed();
    }, (e) => fail(e)));
  }

  let memberSubs = false;
  function listenMember() {
    if (memberSubs) return;
    memberSubs = true;
    subs.push(F.onSnapshot(P.hand(me), (d) => {
      if (!d.exists()) { mine = null; changed(); return; }
      const h = d.data();
      try { mine = JSON.parse(h.json); } catch (e) { mine = null; }
      myHandV = h.v;
      changed();
    }, () => {}));
    subs.push(F.onSnapshot(P.presence(), (snap) => {
      presence = {};
      snap.forEach((d) => { const at = d.data().at; if (at && at.toMillis) presence[d.id] = at.toMillis(); });
      checkHost();
      changed();
    }, () => {}));
    staleTimer = setInterval(() => { checkHost(); changed(); }, 10000);
  }

  // ------------------------------------------------------------ presence
  function startHeartbeat() {
    if (heartbeat) return;
    const beat = () => {
      if (!code || !me || (globalThis.document && document.visibilityState === "hidden")) return;
      F.setDoc(P.pres(me), { at: F.serverTimestamp(), expireAt: expireAt() }).catch(() => {});
    };
    beat();
    heartbeat = setInterval(beat, HEARTBEAT_MS);
    if (globalThis.document) document.addEventListener("visibilitychange", onVisible);
  }
  function onVisible() {
    if (document.visibilityState === "visible" && code && me && room) {
      F.setDoc(P.pres(me), { at: F.serverTimestamp(), expireAt: expireAt() }).catch(() => {});
    }
  }

  /** If the host has gone quiet, the lowest online human seat takes over. */
  function checkHost() {
    if (!room || room.hostUid === me || room.status === "closed" || !room.uids.includes(me)) return;
    if (isOnline(room.hostUid) || presence[room.hostUid] == null && Date.now() - tsMillis(room.updatedAt) < STALE_MS) { clearTimeout(claimTimer); claimTimer = null; return; }
    if (claimTimer) return;
    const order = room.seatUids.filter((u) => u && u !== room.hostUid && (u === me || isOnline(u)));
    const rank = Math.max(0, order.indexOf(me));
    claimTimer = setTimeout(async () => {
      claimTimer = null;
      if (!room || room.hostUid === me || isOnline(room.hostUid)) return;
      const old = room.hostUid;
      try {
        await F.runTransaction(db, async (tx) => {
          const r = await tx.get(P.room(code));
          if (!r.exists() || r.data().hostUid !== old) throw new Error("already moved");
          tx.update(P.room(code), { hostUid: me });
        });
      } catch (e) { /* someone else got there, or the host came back */ }
    }, 1500 + rank * 4000);
  }

  // ------------------------------------------------------------ host side
  async function becomeHost() {
    actingHost = true;
    lastHand = {};
    if (room.status !== "lobby" && !hostState) {
      try {
        const s = await F.getDoc(P.hostDoc());
        if (s.exists()) hostState = JSON.parse(s.data().s);
      } catch (e) { fail(e); }
    }
    hostSubs.push(F.onSnapshot(P.joins(), (snap) => { joinsSnap = snap; processJoins(); }, () => {}));
    hostSubs.push(F.onSnapshot(P.actions(), (snap) => { processActions(snap); }, () => {}));
    // A migrated host re-publishes so every hand doc is current again.
    if (hostState && room.status === "playing") publish().then(scheduleBots);
    else scheduleBots();
  }
  function stopHost() {
    for (const u of hostSubs) { try { u(); } catch (e) {} }
    hostSubs = []; actingHost = false; hostState = null; joinsSnap = null;
    clearTimeout(botTimer); botTimer = null;
  }

  let joinsSnap = null, joinsBusy = false, joinsRerun = false;
  const handled = new Set();
  async function processJoins() {
    if (!actingHost || !joinsSnap || !room) return;
    if (joinsBusy) { joinsRerun = true; return; }
    joinsBusy = true;
    try {
      for (const d of joinsSnap.docs) {
        const j = d.data(), uid = d.id;
        const key = uid + ":" + tsMillis(j.at) + ":" + !!j.leave;
        if (handled.has(key)) continue;
        handled.add(key);
        const seats = clone(room.seats);
        let uids = room.uids.slice();
        if (j.leave) {
          const i = room.seatUids.indexOf(uid);
          if (i >= 0) seats[i] = room.status === "lobby" ? { kind: "empty", name: "", uid: "" } : { kind: "computer", name: seats[i].name + " (computer)", uid: "" };
          uids = uids.filter((u) => u !== uid);
        } else if (!uids.includes(uid)) {
          let i = -1;
          if (room.status === "lobby") i = seats.findIndex((s) => s.kind === "empty");
          else i = seats.findIndex((s) => s.kind === "human" && s.name === j.name && !isOnline(s.uid));
          if (i >= 0) {
            if (seats[i].uid) uids = uids.filter((u) => u !== seats[i].uid);
            seats[i] = { kind: "human", name: cleanName(j.name), uid };
            uids.push(uid);
            delete lastHand[uid];
          }
        }
        if (JSON.stringify(seats) !== JSON.stringify(room.seats)) {
          if (room.status === "playing" && hostState) {
            room = Object.assign({}, room, { seats, seatUids: seats.map((s) => s.uid), uids });
            await publish({ seats, seatUids: room.seatUids, uids });
          } else {
            await F.updateDoc(P.room(code), { seats, seatUids: seats.map((s) => s.uid), uids, updatedAt: F.serverTimestamp(), expireAt: expireAt() });
            room = Object.assign({}, room, { seats, seatUids: seats.map((s) => s.uid), uids });
          }
        }
        await F.deleteDoc(d.ref).catch(() => {});
      }
    } catch (e) { fail(e); }
    finally {
      joinsBusy = false;
      if (joinsRerun) { joinsRerun = false; processJoins(); }
      scheduleBots();
    }
  }

  async function processActions(snap) {
    if (!actingHost) return;
    if (processing) { rerun = true; return; }
    processing = true;
    try {
      if (!hostState) return;
      const docs = snap.docs.slice().sort((a, b) => tsMillis(a.data().at) - tsMillis(b.data().at));
      let moved = false;
      for (const d of docs) {
        const x = d.data();
        if (room.seatUids[x.seat] === x.by) {
          try { hostState = step(game, hostState, x.seat, x.a, rng); moved = true; }
          catch (e) { /* illegal move: dropped, the game carries on */ }
        }
        await F.deleteDoc(d.ref).catch(() => {});
      }
      if (moved) await publish();
    } catch (e) { fail(e); }
    finally {
      processing = false;
      if (rerun) { rerun = false; try { processActions(await F.getDocs(P.actions())); } catch (e) {} }
      scheduleBots();
    }
  }

  /** Host: write the public view, changed private hands and the full state in one batch. */
  async function publish(extra = {}) {
    if (!actingHost || !hostState || !room) return;
    const over = !!game.isOver(hostState);
    const toAct = over ? [] : game.toAct(hostState);
    const v = (room.v || 0) + 1;
    const hv = Object.assign({}, room.hv || {});
    const b = F.writeBatch(db);
    room.seats.forEach((s, i) => {
      if (s.kind !== "human" || !s.uid) return;
      const json = JSON.stringify(game.privateView(hostState, i) ?? null);
      if (lastHand[s.uid] === json) return;
      lastHand[s.uid] = json;
      hv[s.uid] = v;
      b.set(P.hand(s.uid), { json, v, expireAt: expireAt() });
    });
    b.set(P.hostDoc(), { s: JSON.stringify(hostState), v, expireAt: expireAt() });
    const upd = Object.assign({}, extra, {
      pubJson: JSON.stringify(game.publicView(hostState) ?? null), toAct, v, hv,
      status: over ? "finished" : "playing", updatedAt: F.serverTimestamp(), expireAt: expireAt(),
    });
    b.update(P.room(code), upd);
    room = Object.assign({}, room, upd);
    try { await b.commit(); } catch (e) { lastHand = {}; fail(e); }
  }

  function scheduleBots() {
    if (!actingHost || botTimer || !hostState || !room || room.status !== "playing" || game.isOver(hostState)) return;
    const bots = game.toAct(hostState).filter((s) => room.seats[s] && room.seats[s].kind === "computer");
    if (!bots.length) return;
    botTimer = setTimeout(async () => {
      botTimer = null;
      if (!actingHost || !hostState) return;
      try {
        for (const s of bots) {
          if (game.isOver(hostState) || !game.toAct(hostState).includes(s)) continue;
          hostState = step(game, hostState, s, game.bot(botCtx(game, hostState, s), s, rng), rng);
        }
        await publish();
      } catch (e) { fail(e); }
      scheduleBots();
    }, botDelayMs);
  }

  // ------------------------------------------------------------ host controls
  const needHost = () => { if (!actingHost || !room) throw new Error("Only the host can do that."); };

  async function setSeat(i, kind, name) {
    try {
      needHost();
      const seats = clone(room.seats);
      if (!seats[i]) throw new Error("No such seat.");
      if (seats[i].uid === me) throw new Error("That's your seat.");
      let uids = room.uids;
      if (room.status === "lobby") {
        if (!["computer", "empty"].includes(kind)) throw new Error("A seat can be a computer or empty.");
        if (seats[i].uid) uids = uids.filter((u) => u !== seats[i].uid);
        seats[i] = kind === "computer" ? { kind, name: name || "Computer " + (i + 1), uid: "" } : { kind, name: "", uid: "" };
      } else {
        if (kind !== "computer") throw new Error("During a game a seat can only be handed to a computer.");
        if (seats[i].uid) uids = uids.filter((u) => u !== seats[i].uid);
        seats[i] = { kind, name: name || (seats[i].name ? seats[i].name + " (computer)" : "Computer " + (i + 1)), uid: "" };
      }
      await F.updateDoc(P.room(code), { seats, seatUids: seats.map((s) => s.uid), uids, updatedAt: F.serverTimestamp(), expireAt: expireAt() });
      return { ok: true };
    } catch (e) { return fail(e); }
  }

  async function setOptions(options) {
    try { needHost(); await F.updateDoc(P.room(code), { options: clone(options), updatedAt: F.serverTimestamp(), expireAt: expireAt() }); return { ok: true }; }
    catch (e) { return fail(e); }
  }

  async function start(options) {
    try {
      needHost();
      if (room.status !== "lobby") throw new Error("Already started.");
      const opts = options ? clone(options) : (room.options || {});
      const seats = room.seats.map((s, i) => (s.kind === "empty" ? { kind: "computer", name: "Computer " + (i + 1), uid: "" } : s));
      if (game.minSeats && seats.length < game.minSeats) throw new Error("Needs at least " + game.minSeats + " seats.");
      hostState = game.setup(seats.length, opts, rng, seats.map((s) => ({ kind: s.kind, name: s.name })));
      room = Object.assign({}, room, { seats, seatUids: seats.map((s) => s.uid), options: opts, status: "playing" });
      await publish({ seats, seatUids: room.seatUids, options: opts });
      scheduleBots();
      return { ok: true };
    } catch (e) { return fail(e); }
  }

  // ------------------------------------------------------------ moves
  async function act(action) {
    if (!room) return fail(new Error("Not in a game."));
    const seat = mySeat();
    if (seat < 0) return fail(new Error("You don't have a seat."));
    if (!(room.toAct || []).includes(seat)) return fail(new Error("Not your turn."));
    if (actingHost) {
      try { hostState = step(game, hostState, seat, action, rng); }
      catch (e) { return fail(e); }
      await publish();
      scheduleBots();
      return { ok: true };
    }
    try {
      await F.addDoc(P.actions(), { by: me, seat, a: clone(action), at: F.serverTimestamp(), expireAt: expireAt() });
      return { ok: true };
    } catch (e) { return fail(e); }
  }

  // ------------------------------------------------------------ leaving
  /** Leave the room. The host hands over to another online player, or closes it. */
  async function leave() {
    if (!room || !code) { await detach(); return { ok: true }; }
    try {
      if (actingHost) {
        const others = room.seats.filter((s) => s.kind === "human" && s.uid && s.uid !== me && isOnline(s.uid));
        if (!others.length || room.status !== "playing") return await close();
        const seats = clone(room.seats);
        const i = mySeat();
        seats[i] = { kind: "computer", name: seats[i].name + " (computer)", uid: "" };
        await F.updateDoc(P.room(code), {
          seats, seatUids: seats.map((s) => s.uid), uids: room.uids.filter((u) => u !== me),
          hostUid: others[0].uid, updatedAt: F.serverTimestamp(), expireAt: expireAt(),
        });
      } else {
        await F.setDoc(P.join(me), { name: cleanName((room.seats[mySeat()] || {}).name), leave: true, at: F.serverTimestamp(), expireAt: expireAt() });
      }
      await F.deleteDoc(P.pres(me)).catch(() => {});
    } catch (e) { fail(e); }
    store.del(RESUME_KEY);
    await detach();
    return { ok: true };
  }

  /** Host: end the room for everyone and delete its documents now. */
  async function close() {
    try {
      needHost();
      const c = code;
      // Everyone who ever got a hand (hv), not just who is seated now.
      const uids = [...new Set(room.seats.map((s) => s.uid).filter(Boolean).concat(Object.keys(room.hv || {})))];
      stopHost();
      stopTimers();
      for (const u of uids) await F.deleteDoc(F.doc(db, "games", gameId, "rooms", c, "hands", u)).catch(() => {});
      for (const sub of ["actions", "presence", "joins"]) {
        try { const s = await F.getDocs(F.collection(db, "games", gameId, "rooms", c, sub)); for (const d of s.docs) await F.deleteDoc(d.ref).catch(() => {}); } catch (e) {}
      }
      await F.deleteDoc(F.doc(db, "games", gameId, "rooms", c, "host", "state")).catch(() => {});
      await F.deleteDoc(P.room(c));
    } catch (e) { return fail(e); }
    store.del(RESUME_KEY);
    await detach();
    return { ok: true };
  }

  function stopTimers() {
    clearInterval(heartbeat); heartbeat = null;
    clearInterval(staleTimer); staleTimer = null;
    clearTimeout(claimTimer); claimTimer = null;
    if (globalThis.document) document.removeEventListener("visibilitychange", onVisible);
  }
  async function detach() {
    for (const u of subs) { try { u(); } catch (e) {} }
    subs = []; memberSubs = false;
    stopHost(); stopTimers();
    room = null; mine = null; code = null; presence = {}; joinPending = false; myHandV = -1;
  }

  return {
    mode: "online",
    on: ev.on,
    ready, createRoom, joinRoom, resume, setSeat, setOptions, start, act, leave, close, sweep,
    view: snapshot,
    get uid() { return me; },
    get code() { return code; },
    /** tests only */
    _detach: detach,
  };
}

function tsMillis(t) { return t && t.toMillis ? t.toMillis() : 0; }
function newCode() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
function humanError(e) {
  const c = String((e && e.code) || "");
  if (c.includes("permission-denied")) return "The server said no — you may not be in this room any more.";
  if (c.includes("unavailable") || c.includes("network")) return "Connection problem — check your internet.";
  if (c.includes("resource-exhausted")) return "The free online quota is used up for today. Try again tomorrow, or play the computer.";
  if (c.includes("admin-restricted") || c.includes("operation-not-allowed")) return "Online sign-in isn't switched on for this site yet.";
  return (e && e.message) || "Something went wrong.";
}
