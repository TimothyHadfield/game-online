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
 * Every doc carries expireAt; clients sweep expired docs (TTL needs billing).
 *
 * SEATS BELONG TO A LOGIN, NOT A NAME. Mid-game, the same browser (same
 * anonymous uid) gets its own seat back at once. A different login that types
 * a seated player's name only gets that seat if the host says Allow (event
 * "seatRequest", or a small built-in prompt if the game doesn't listen), or
 * if the host has marked the seat open (setSeat(i, "open")).
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
// Heartbeats are the biggest steady cost on the free quota (1 write + 1 read
// per member each). The host beats often so a lost host is noticed fast; the
// other players beat slowly, so a 3-4 player room costs no more than before.
export const HEARTBEAT_MS = 60000;      // players
export const HOST_HEARTBEAT_MS = 15000; // the host
export const STALE_MS = 130000;         // a player counts as away after this (a missed beat + 10 s slack)
export const HOST_STALE_MS = 40000;     // must match hostStale() in firestore.rules (a missed host beat + 10 s slack)
export const TURN_TIMEOUT_MS = 60000;   // an AWAY player's turn waits this long, then a computer takes the seat
const TICK_MS = 5000;
const NO_NET_MSG = "Online play couldn't load. Check your internet and try again.";
const TTL_MS = 2 * 24 * 3600 * 1000;    // rules allow at most 3 days ahead
const MAX_SEATS = 12;
const NAME_MAX = 20;
const STALE_MSG = "The table just changed. Check it and try again.";

// ------------------------------------------------------------ tiny helpers
function emitter() {
  const fns = {};
  return {
    on(ev, fn) { (fns[ev] = fns[ev] || []).push(fn); return () => { fns[ev] = fns[ev].filter((f) => f !== fn); }; },
    emit(ev, x) { for (const f of fns[ev] || []) { try { f(x); } catch (e) { console.error(e); } } },
    count(ev) { return (fns[ev] || []).length; },
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
      seats: S.map((s) => ({ kind: s.kind, name: s.name, online: s.kind !== "empty" })),
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
export function createOnline({ game, gameId = game && game.id, config = FIREBASE_CONFIG, botDelayMs = 700, turnTimeoutMs = TURN_TIMEOUT_MS, rng = Math.random, sdk = null, emulator = null, appName } = {}) {
  if (!/^[a-z0-9-]{1,32}$/.test(String(gameId))) throw new Error("gameId must be lower-case letters, digits or dashes");
  const ev = emitter();
  const RESUME_KEY = "online." + gameId;

  let F = null;            // firestore functions
  let db = null, auth = null;
  let me = null;           // my uid
  let code = null, room = null, mine = null, myHandV = -1;
  let joinPending = false, askingHost = false;
  let requests = [];       // host: [{uid, name, seat, seatName}] waiting for Allow / Deny
  let subs = [];
  let hostSubs = [];
  let actingHost = false, hostState = null, lastHand = {};
  let processing = false, rerun = false, botTimer = null;
  let presence = {};       // uid -> millis
  let heartbeat = null, staleTimer = null, claimTimer = null;
  let lastError = null;
  let skew = 0;            // server clock minus ours (ms), learned from our own heartbeat
  let beatSentAt = 0, lastBeat = 0, lastTick = 0;
  let backAt = 0;          // when this page last came back (visible again, or woke from sleep)
  const waitSince = {};    // host: seat -> when we started waiting on it
  let hostLoad = Promise.resolve();   // a new host's read of the full state
  const now = () => Date.now() + skew;

  // ------------------------------------------------------------ setup
  async function ready() {
    if (me) return me;
    if (!F) {
      let mods = sdk;
      if (!mods) {
        // No internet (or a blocker) = the SDK can't load. The browser's own
        // words ("Importing a module script failed.") mean nothing to a player.
        try {
          mods = await Promise.all([
            import(CDN + "firebase-app.js"), import(CDN + "firebase-auth.js"), import(CDN + "firebase-firestore.js"),
          ]).then(([app, a, fs]) => ({ app, auth: a, firestore: fs }));
        } catch (e) { throw Object.assign(new Error(NO_NET_MSG), { code: "online/unavailable" }); }
      }
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
    // Sign-in can fail on a flaky connection (auth/network-request-failed): retry twice.
    for (let i = 0; !auth.currentUser; i++) {
      try { await F.signInAnonymously(auth); }
      catch (e) { if (i >= 2 || !/network|timeout|unavailable/.test(String(e && e.code))) throw e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
    }
    me = auth.currentUser.uid;
    return me;
  }

  // The auth SDK refreshes its token in the background; on a dropped
  // connection that promise rejects with auth/network-request-failed and
  // nobody can catch it. It is harmless (Firestore retries), so keep it out
  // of the page's error log.
  if (globalThis.addEventListener && !globalThis.__onlineAuthNetGuard) {
    globalThis.__onlineAuthNetGuard = true;
    globalThis.addEventListener("unhandledrejection", (e) => {
      if (e && e.reason && e.reason.code === "auth/network-request-failed") e.preventDefault();
    });
  }

  /** Is this login still a member of the room, per the server (not our maybe-stale copy)? */
  async function stillMember() {
    if (!code || !me) return false;
    try { const s = await F.getDoc(P.room(code)); return s.exists() && (s.data().uids || []).includes(me); }
    catch (e) { return false; }
  }
  const denied = (e) => String((e && e.code) || "").includes("permission-denied");

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
  const isOnline = (uid) => !!uid && presence[uid] != null && now() - presence[uid] < STALE_MS;
  const hostHere = () => !!room && presence[room.hostUid] != null && now() - presence[room.hostUid] < HOST_STALE_MS;
  const mySeat = () => (room ? room.seatUids.indexOf(me) : -1);
  // A seat a computer is playing for its owner (who can take it back: reclaim()).
  const isAuto = (s) => !!(s && s.kind === "computer" && s.uid);
  const myAuto = () => { const i = mySeat(); return i >= 0 && isAuto(room.seats[i]); };
  const ownName = (s) => (s && (s.was || s.name)) || "";
  // A player's seat with this name: theirs, or a computer playing it for them.
  const ownsName = (s, nm) => !!s && (s.kind === "human" || isAuto(s)) && ownName(s) === nm;
  const timeoutMs = () => {
    const o = room && room.options && room.options.turnTimeoutSec;
    return typeof o === "number" && o >= 0 ? o * 1000 : turnTimeoutMs;
  };

  // ------------------------------------------------------------ snapshot
  function snapshot() {
    const seat = mySeat();
    if (!room || (joinPending && seat < 0)) return { mode: "online", status: joinPending ? "joining" : "none", code, askingHost, error: lastError };
    let pub = null;
    try { pub = JSON.parse(room.pubJson || "null"); } catch (e) {}
    const toAct = room.toAct || [];
    const isHost = room.hostUid === me;
    return {
      mode: "online", code, status: room.status,
      seats: room.seats.map((s) => ({ kind: s.kind, name: s.name, online: s.kind === "computer" || (s.kind === "human" && isOnline(s.uid)), isHost: s.uid === room.hostUid && !!s.uid, open: !!s.open, auto: isAuto(s) })),
      mySeat: seat, isHost,
      hostAway: room.hostUid !== me && !hostHere(),
      options: room.options || {},
      pub, mine: seat >= 0 ? mine : null, toAct, myTurn: seat >= 0 && toAct.includes(seat) && !myAuto(),
      autoPlay: myAuto(),
      seatRequests: isHost ? requests.map(({ uid, name, seat: s, seatName }) => ({ uid, name, seat: s, seatName })) : [],
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
        // One plain write (no transaction: that was a read + a commit, slow under
        // load). If the code is already someone's room the rules refuse it as an
        // update by a non-host, and we try another code.
        await F.setDoc(P.room(c), {
          gameId, hostUid: me, uids: [me], seats: S, seatUids: S.map((s) => s.uid),
          status: "lobby", options: clone(options), pubJson: "null", toAct: [], v: 0, hv: {},
          createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp(), expireAt: expireAt(),
        });
        await attach(c);
        // Sweep later, so it doesn't compete with the new room's first updates.
        setTimeout(() => sweep().catch(() => {}), 15000);
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
    // Our own login: straight back in (and back into our seat if a computer took it).
    if (r.uids.includes(me)) { backAt = Date.now(); await attach(c); return { ok: true, code: c, seat: r.seatUids.indexOf(me) }; }
    const nm = cleanName(name);
    // Mid-game a new login can only take a seat the host has marked open, or a
    // named seat the host approves. A returning login was let in above.
    const named = r.status === "lobby" ? null : r.seats.find((s) => ownsName(s, nm));
    const hasRoom = r.status === "lobby"
      ? r.seats.some((s) => s.kind === "empty")
      : !!named || r.seats.some((s) => s.kind === "computer" && s.open);
    if (!hasRoom) { code = null; return fail(new Error(r.status === "lobby" ? "That room is full." : "That game has already started.")); }
    const needsOk = !!(named && named.uid && !named.open);
    const TAKEN = "That seat belongs to someone else, ask the host.";
    try {
      await F.setDoc(P.join(me), { name: nm, leave: false, at: F.serverTimestamp(), expireAt: expireAt() });
    } catch (e) { code = null; return fail(e); }
    joinPending = true;
    askingHost = needsOk;
    await attach(c);
    // Wait for the host to seat us (or turn us away by deleting the note).
    return await new Promise((resolve) => {
      let seenNote = false;
      let over = false;
      const stop = () => { over = true; clearTimeout(t); clearInterval(poll); off(); unsubNote(); joinPending = false; askingHost = false; };
      // Belt and braces while the host decides: if the note-deleted event is
      // ever missed, notice the answer anyway (1 read per 5 s, only while asking).
      const NO = needsOk ? TAKEN : "No free seat in that room.";
      const poll = needsOk ? setInterval(() => {
        F.getDoc(P.join(me)).then((d) => { if (!d.exists() && seenNote) noteGone(); }).catch(() => {});
      }, 5000) : null;
      const refuse = async (msg) => { if (over) return; stop(); await detach(); resolve(fail(new Error(msg))); };
      // The host deletes the note once it has decided. Ask the server whether
      // we were seated (the room listener can lag on a slow device), then say no.
      let checking = false;
      const noteGone = () => {
        if (over || checking || mySeat() >= 0) return;
        checking = true;
        setTimeout(() => {
          F.getDoc(P.room(c)).then((r) => {
            checking = false;
            if (over || mySeat() >= 0) return;
            if (r.exists() && (r.data().seatUids || []).includes(me)) return;   // seated; the listener will catch up
            refuse(NO);
          }).catch(() => { checking = false; if (mySeat() < 0) refuse(NO); });
        }, 1000);
      };
      const t = setTimeout(() => {
        F.deleteDoc(P.join(me)).catch(() => {});
        refuse(needsOk ? "The host didn't answer. " + TAKEN : "The host didn't answer. Are they still there?");
      }, needsOk ? 120000 : 20000);
      const off = ev.on("change", (s) => {
        if (!over && s.mySeat >= 0) { stop(); resolve({ ok: true, code: c, seat: s.mySeat }); }
      });
      const unsubNote = F.onSnapshot(P.join(me), (d) => {
        if (d.exists()) { seenNote = true; return; }
        if (seenNote) noteGone();
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
      backAt = Date.now();
      await attach(saved.code);
      return true;
    } catch (e) { store.del(RESUME_KEY); return false; }
  }

  // ------------------------------------------------------------ listeners
  async function attach(c) {
    code = c;
    lastError = null;
    const unsubRoom = F.onSnapshot(P.room(c), (snap) => {
      relistens = 0;
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
      autoChanged();
      changed();
    }, (e) => roomListenError(c, e));
    unsubRoom.__room = true;
    subs.push(unsubRoom);
  }

  // A listener can be refused for a moment around a reload (stale login token,
  // a dropped channel). If the server still lists us, quietly listen again.
  let relistens = 0;
  async function roomListenError(c, e) {
    if (denied(e) && code === c && relistens < 3 && await stillMember()) {
      relistens++;
      setTimeout(() => {
        if (code !== c) return;
        subs = subs.filter((u) => { if (u.__room) { try { u(); } catch (x) {} return false; } return true; });
        attach(c);
      }, 1000 * relistens);
      return;
    }
    fail(e);
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
      snap.forEach((d) => {
        const at = d.data().at;
        if (!at || !at.toMillis) return;
        presence[d.id] = at.toMillis();
        // Our own beat came back with the server's time: learn how far our clock is off.
        if (d.id === me && beatSentAt && !(d.metadata && d.metadata.hasPendingWrites)) { skew = at.toMillis() - beatSentAt; beatSentAt = 0; }
      });
      checkHost();
      if (actingHost) idleCheck();
      changed();
    }, () => {}));
    lastTick = Date.now();
    staleTimer = setInterval(() => {
      // A long gap between ticks = this device slept (laptop lid, locked phone).
      if (Date.now() - lastTick > TICK_MS * 4) cameBack();
      lastTick = Date.now();
      checkHost();
      if (actingHost) idleCheck();
      // Redraw only when someone's online dot (or the host-away flag) flipped.
      const s = snapshot();
      const sig = JSON.stringify([s.seats && s.seats.map((x) => x.online), s.hostAway]);
      if (sig !== tickSig) { tickSig = sig; changed(); }
    }, TICK_MS);
  }
  let tickSig = "";

  // ------------------------------------------------------------ presence
  function beat() {
    if (!code || !me || (globalThis.document && document.visibilityState === "hidden")) return;
    lastBeat = Date.now();
    beatSentAt = lastBeat;
    F.setDoc(P.pres(me), { at: F.serverTimestamp(), expireAt: expireAt() }).catch(() => {});
  }
  function startHeartbeat() {
    if (heartbeat) return;
    beat();
    // The host beats every 10 s, everyone else every 25 s (free-quota writes).
    heartbeat = setInterval(() => { if (Date.now() - lastBeat >= (actingHost ? HOST_HEARTBEAT_MS : HEARTBEAT_MS) - 500) beat(); }, TICK_MS);
    if (globalThis.document) document.addEventListener("visibilitychange", onVisible);
  }
  function onVisible() {
    if (document.visibilityState === "visible" && code && me && room) { beat(); cameBack(); }
  }

  /** This page is back (visible again, reloaded, or woke up): if a computer took our seat, take it back. */
  function cameBack() {
    backAt = Date.now();
    if (room && myAuto()) reclaim();
  }

  /**
   * Take my seat back from the computer playing it for me. Automatic when this
   * page comes back (reload, rejoin, visible again, woke up) or on any tap
   * while a computer has the seat; games may also call it from a button.
   */
  let reclaimAt = 0;
  async function reclaim() {
    if (!room || !myAuto()) return { ok: true };
    if (Date.now() - reclaimAt < 4000) return { ok: true };   // one ask at a time
    reclaimAt = Date.now();
    try {
      const i = mySeat();
      if (actingHost) {
        const seats = clone(room.seats);
        seats[i] = { kind: "human", name: ownName(seats[i]), uid: me };
        delete waitSince[i];
        await saveSeats(seats, room.uids);
        scheduleBots();
      } else {
        // Only the host writes who sits where: leave it a note.
        await F.setDoc(P.join(me), { name: cleanName(ownName(room.seats[i])), leave: false, at: F.serverTimestamp(), expireAt: expireAt() });
      }
      return { ok: true };
    } catch (e) { return fail(e); }
  }
  /** After each room update: just came back and a computer has my seat → ask for it; watch taps while it does. */
  function autoChanged() {
    const auto = !!room && myAuto();
    if (auto && Date.now() - backAt < 15000) reclaim();
    watchTaps(auto);
  }
  let tapWatch = false;
  const onTap = () => { if (room && myAuto()) reclaim(); };
  function watchTaps(on) {
    const doc = globalThis.document;
    if (!doc || on === tapWatch) return;
    tapWatch = on;
    for (const t of ["pointerdown", "keydown"]) (on ? doc.addEventListener : doc.removeEventListener).call(doc, t, onTap, true);
  }

  /** If the host has gone quiet, the lowest online human seat takes over. */
  function checkHost() {
    if (!room || room.hostUid === me || room.status === "closed" || !room.uids.includes(me)) return;
    if (hostHere() || presence[room.hostUid] == null && now() - tsMillis(room.updatedAt) < HOST_STALE_MS) { clearTimeout(claimTimer); claimTimer = null; return; }
    if (claimTimer) return;
    const order = room.seatUids.filter((u) => u && u !== room.hostUid && (u === me || isOnline(u)));
    const rank = Math.max(0, order.indexOf(me));
    claimTimer = setTimeout(async () => {
      claimTimer = null;
      if (!room || room.hostUid === me || hostHere()) return;
      const old = room.hostUid;
      try {
        await F.runTransaction(db, async (tx) => {
          const r = await tx.get(P.room(code));
          if (!r.exists() || r.data().hostUid !== old) throw new Error("already moved");
          tx.update(P.room(code), { hostUid: me });
        });
      } catch (e) { /* someone else got there, or the host came back */ }
    }, 1500 + rank * 3000);
  }

  // ------------------------------------------------------------ host side
  async function becomeHost() {
    actingHost = true;
    lastHand = {};
    for (const k of Object.keys(waitSince)) delete waitSince[k];
    if (heartbeat && Date.now() - lastBeat > 5000) beat();   // a new host's last beat may be 60 s old: refresh it now
    if (room.status !== "lobby" && !hostState) {
      // A move tapped while the table loads waits for it (act awaits hostLoad).
      hostLoad = F.getDoc(P.hostDoc()).then((s) => { if (s.exists() && actingHost) hostState = JSON.parse(s.data().s); }, (e) => { fail(e); });
      await hostLoad;
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
    handled.clear();          // a later spell as host re-reads any notes still waiting
    if (requests.length) { requests = []; renderPrompt(); }
  }

  let joinsSnap = null, joinsBusy = false, joinsRerun = false;
  const handled = new Set();
  async function processJoins() {
    if (!actingHost || !joinsSnap || !room) return;
    if (joinsBusy) { joinsRerun = true; return; }
    joinsBusy = true;
    try {
      // A joiner who gave up (deleted their note) is no longer asking.
      const live = new Set(joinsSnap.docs.map((d) => d.id));
      if (requests.some((q) => !live.has(q.uid))) { requests = requests.filter((q) => live.has(q.uid)); requestsChanged(); }
      for (const d of joinsSnap.docs) {
        const j = d.data(), uid = d.id;
        const key = uid + ":" + tsMillis(j.at) + ":" + !!j.leave;
        if (handled.has(key)) continue;
        handled.add(key);
        requests = requests.filter((q) => q.uid !== uid);
        const seats = clone(room.seats);
        let uids = room.uids.slice();
        if (j.leave) {
          const i = room.seatUids.indexOf(uid);
          if (i >= 0) seats[i] = room.status === "lobby" ? { kind: "empty", name: "", uid: "" } : { kind: "computer", name: ownName(seats[i]) + " (computer)", uid: "" };
          uids = uids.filter((u) => u !== uid);
        } else if (uids.includes(uid)) {
          // A member whose seat a computer is playing asks for it back.
          const i = room.seatUids.indexOf(uid);
          if (i >= 0 && isAuto(seats[i])) { seats[i] = { kind: "human", name: ownName(seats[i]), uid }; delete waitSince[i]; }
        } else {
          let i = -1;
          if (room.status === "lobby") i = seats.findIndex((s) => s.kind === "empty");
          else {
            // Seats belong to a login (uid), not a name. A new login gets a
            // named seat only if the host marked it open or says Allow.
            const n = seats.findIndex((s) => ownsName(s, j.name) && !isOnline(s.uid));
            if (n >= 0 && (seats[n].open || !seats[n].uid)) i = n;
            else if (n >= 0) {
              requests.push({ uid, name: cleanName(j.name), seat: n, seatName: seats[n].name, ref: d.ref });
              requestsChanged(requests[requests.length - 1]);
              continue;   // the note stays until the host answers
            } else i = seats.findIndex((s) => s.kind === "computer" && s.open);
          }
          if (i >= 0) uids = giveSeat(seats, uids, i, uid, j.name);
        }
        await saveSeats(seats, uids);
        await F.deleteDoc(d.ref).catch(() => {});
      }
    } catch (e) { fail(e); }
    finally {
      joinsBusy = false;
      if (joinsRerun) { joinsRerun = false; processJoins(); }
      scheduleBots();
    }
  }

  /** Put login `uid` into seat i (mutates seats). Returns the new member list. */
  function giveSeat(seats, uids, i, uid, name) {
    let u = uids.slice();
    if (seats[i].uid) u = u.filter((x) => x !== seats[i].uid);
    seats[i] = { kind: "human", name: cleanName(seats[i].kind === "human" || seats[i].was ? ownName(seats[i]) : name), uid };
    u.push(uid);
    delete lastHand[uid];
    return u;
  }

  async function saveSeats(seats, uids) {
    if (JSON.stringify(seats) === JSON.stringify(room.seats) && JSON.stringify(uids) === JSON.stringify(room.uids)) return;
    const upd = { seats, seatUids: seats.map((s) => s.uid), uids };
    if (room.status === "playing" && hostState) {
      room = Object.assign({}, room, upd);
      await publish(upd);
    } else {
      await F.updateDoc(P.room(code), Object.assign({ updatedAt: F.serverTimestamp(), expireAt: expireAt() }, upd));
      room = Object.assign({}, room, upd);
    }
  }

  // ------------------------------------------------------------ seat requests (host)
  function requestsChanged(added) {
    if (added) ev.emit("seatRequest", {
      uid: added.uid, name: added.name, seat: added.seat, seatName: added.seatName,
      allow: () => answerSeat(added.uid, true), deny: () => answerSeat(added.uid, false),
    });
    renderPrompt();
    changed();
  }

  /** Host: Allow (true) or Deny (false) a request for someone else's seat. */
  async function answerSeat(uid, yes) {
    try {
      needHost();
      const q = requests.find((x) => x.uid === uid);
      if (!q) throw new Error("That request is gone.");
      requests = requests.filter((x) => x !== q);
      requestsChanged();
      if (yes) {
        const s = room.seats[q.seat];
        if (!ownsName(s, q.seatName)) throw new Error("That seat has changed.");
        if (isOnline(s.uid)) throw new Error(s.name + " is back online.");
        if (!room.uids.includes(uid)) {
          const seats = clone(room.seats);
          await saveSeats(seats, giveSeat(seats, room.uids, q.seat, uid, q.name));
        }
      }
      await F.deleteDoc(q.ref).catch(() => {});
      scheduleBots();
      return { ok: true };
    } catch (e) {
      const q = requests.find((x) => x.uid === uid);
      if (!q && code) F.deleteDoc(P.join(uid)).catch(() => {});
      return fail(e);
    }
  }

  /** Minimal built-in Allow / Deny card, shown only if the game has no "seatRequest" listener. */
  function renderPrompt() {
    const doc = globalThis.document;
    if (!doc || !doc.body) return;
    let box = doc.getElementById("online-seat-requests");
    if (!actingHost || !requests.length || ev.count("seatRequest")) { if (box) box.remove(); return; }
    if (!box) {
      box = doc.createElement("div");
      box.id = "online-seat-requests";
      box.style.cssText = "position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 32px));font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      doc.body.appendChild(box);
    }
    box.textContent = "";
    for (const q of requests) {
      const card = doc.createElement("div");
      card.setAttribute("role", "alertdialog");
      card.style.cssText = "background:#1a1e2b;color:#e8eaf0;border:1px solid #2a3042;border-radius:14px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.45)";
      const msg = doc.createElement("div");
      msg.textContent = "Someone on another device typed “" + q.seatName + "” and wants " + q.seatName + "’s seat.";
      const row = doc.createElement("div");
      row.style.cssText = "display:flex;gap:8px;margin-top:10px";
      const btn = (label, filled, yes) => {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.dataset.answer = yes ? "allow" : "deny";
        b.style.cssText = "flex:1;font:inherit;font-weight:600;border-radius:10px;padding:10px 14px;cursor:pointer;" +
          (filled ? "background:#6ea8fe;color:#0f1117;border:0" : "background:transparent;color:#e8eaf0;border:1px solid #6ea8fe");
        b.onclick = () => answerSeat(q.uid, yes);
        return b;
      };
      row.append(btn("Allow", true, true), btn("Deny", false, false));
      card.append(msg, row);
      box.appendChild(card);
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
      let extra = null;
      for (const d of docs) {
        const x = d.data();
        if (room.seatUids[x.seat] === x.by) {
          try {
            hostState = step(game, hostState, x.seat, x.a, rng); moved = true;
            delete waitSince[x.seat];
            // A move from the owner of a computer-played seat = they're back.
            if (isAuto(room.seats[x.seat])) {
              const seats = clone(room.seats);
              seats[x.seat] = { kind: "human", name: ownName(seats[x.seat]), uid: x.by };
              extra = { seats, seatUids: seats.map((s) => s.uid) };
              room = Object.assign({}, room, extra);
            }
          } catch (e) { /* illegal move: dropped, the game carries on */ }
        }
        await F.deleteDoc(d.ref).catch(() => {});
      }
      if (moved) await publish(extra || {});
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
      if (!s.uid) return;     // a human, or a computer playing for its owner (who still sees the hand)
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

  /**
   * Host: a player who is AWAY (no heartbeat: tab closed, phone locked, no
   * signal) and whose move the table has waited on for the turn timeout gets a
   * computer in their seat, so the game doesn't stall. The seat stays theirs:
   * when they come back it's handed back (reclaim). Players who are here are
   * never hurried. Room setting: options.turnTimeoutSec (0 = never).
   */
  let idleBusy = false;
  function idleCheck() {
    if (!actingHost || !hostState || !room || room.status !== "playing" || idleBusy) return;
    const waiting = new Set(game.isOver(hostState) ? [] : game.toAct(hostState));
    for (const k of Object.keys(waitSince)) if (!waiting.has(+k) || !room.seats[k] || room.seats[k].kind !== "human") delete waitSince[k];
    const t = now(), limit = timeoutMs();
    const late = [];
    for (const i of waiting) {
      const s = room.seats[i];
      if (!s || s.kind !== "human" || !s.uid) continue;
      if (waitSince[i] == null) waitSince[i] = t;
      if (limit > 0 && s.uid !== me && t - waitSince[i] >= limit && !isOnline(s.uid)) late.push(i);
    }
    if (!late.length) return;
    const seats = clone(room.seats);
    for (const i of late) { seats[i] = { kind: "computer", name: seats[i].name + " (computer)", uid: seats[i].uid, was: seats[i].name }; delete waitSince[i]; }
    idleBusy = true;
    saveSeats(seats, room.uids).catch((e) => fail(e)).finally(() => { idleBusy = false; scheduleBots(); });
  }

  function scheduleBots() {
    if (actingHost) idleCheck();
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
      if (kind === "open" && room.status !== "lobby") {
        // Offer the seat up: the next person who joins takes it without asking
        // (a computer seat: under any name; a player's seat: under that name).
        if (seats[i].kind === "empty") throw new Error("No such seat.");
        seats[i] = Object.assign({}, seats[i], { open: true });
      } else if (room.status === "lobby") {
        if (kind === "open") kind = "empty";
        if (!["computer", "empty"].includes(kind)) throw new Error("A seat can be a computer or empty.");
        if (seats[i].uid) uids = uids.filter((u) => u !== seats[i].uid);
        seats[i] = kind === "computer" ? { kind, name: name || "Computer " + (i + 1), uid: "" } : { kind, name: "", uid: "" };
      } else {
        if (kind !== "computer") throw new Error("During a game a seat can only be handed to a computer.");
        if (isAuto(seats[i])) return { ok: true };
        // A player's seat: the computer plays it, but it stays theirs, so their
        // phone gets it back when it returns (reclaim). setSeat(i, "open") lets someone else have it.
        const owner = seats[i].kind === "human" ? seats[i].uid : "";
        const was = seats[i].kind === "human" ? seats[i].name : "";
        seats[i] = { kind, name: name || (seats[i].name ? seats[i].name + " (computer)" : "Computer " + (i + 1)), uid: owner };
        if (owner) seats[i].was = was;
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
    if (actingHost && !hostState) await hostLoad;   // just took over: the table is still loading
    if (actingHost) {
      if (!hostState) return { ok: false, stale: true, message: STALE_MSG };
      try { hostState = step(game, hostState, seat, action, rng); }
      catch (e) { return fail(e); }
      delete waitSince[seat];
      let extra = {};
      if (isAuto(room.seats[seat])) {
        const seats = clone(room.seats);
        seats[seat] = { kind: "human", name: ownName(seats[seat]), uid: me };
        extra = { seats, seatUids: seats.map((s) => s.uid) };
        room = Object.assign({}, room, extra);
      }
      await publish(extra);
      scheduleBots();
      return { ok: true };
    }
    try {
      await F.addDoc(P.actions(), { by: me, seat, a: clone(action), at: F.serverTimestamp(), expireAt: expireAt() });
      return { ok: true };
    } catch (e) {
      // Our copy of the table was one update behind (it was no longer this
      // seat's turn, or a reload was still catching up). The rules refused the
      // move, which is right, but we are still in the room: say so gently
      // and don't raise the scary "not in this room" error.
      if (denied(e) && await stillMember()) return { ok: false, stale: true, message: STALE_MSG };
      return fail(e);
    }
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
    stopHost(); stopTimers(); watchTaps(false);
    room = null; mine = null; code = null; presence = {}; joinPending = false; askingHost = false; myHandV = -1;
  }

  return {
    mode: "online",
    on: ev.on,
    ready, createRoom, joinRoom, resume, setSeat, setOptions, start, act, leave, close, sweep, reclaim,
    /** Host: answer a seat request (see the "seatRequest" event / snap.seatRequests). */
    allowSeat: (uid) => answerSeat(uid, true),
    denySeat: (uid) => answerSeat(uid, false),
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
  if (c === "online/unavailable") return NO_NET_MSG;
  // The browser's own words for "couldn't download" (Safari, Chrome, Firefox).
  if (/importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|^load failed$|^failed to fetch$|networkerror when attempting/i.test(String((e && e.message) || ""))) return NO_NET_MSG;
  if (c.includes("permission-denied")) return "The server said no — you may not be in this room any more.";
  if (c.includes("unavailable") || c.includes("network")) return "Connection problem — check your internet.";
  if (c.includes("resource-exhausted")) return "The free online quota is used up for today. Try again tomorrow, or play the computer.";
  if (c.includes("admin-restricted") || c.includes("operation-not-allowed")) return "Online sign-in isn't switched on for this site yet.";
  return (e && e.message) || "Something went wrong.";
}
