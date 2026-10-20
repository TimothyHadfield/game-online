/* High Card — the demo game for online.js. Every player is dealt 3 hidden
 * cards; each round everyone secretly picks one at the same time, then they
 * are revealed and the highest card scores a point. Pure functions only.
 * Cards are 0..51: rank = c >> 2 (0 = "2" … 12 = "A"), suit = c & 3. */

export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const SUITS = ["♣", "♦", "♥", "♠"];
export const cardName = (c) => RANKS[c >> 2] + SUITS[c & 3];

export const highCard = {
  id: "high-card",
  minSeats: 2,
  maxSeats: 6,

  setup(n, options = {}, rng = Math.random, seats = []) {
    const handSize = Math.max(1, Math.min(8, options.handSize || 3));
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return {
      n, rounds: handSize, round: 0,
      names: seats.map((s, i) => s.name || "Seat " + (i + 1)),
      hands: Array.from({ length: n }, (_, s) => deck.slice(s * handSize, (s + 1) * handSize).sort((a, b) => a - b)),
      played: Array(n).fill(null),
      scores: Array(n).fill(0),
      last: null,
    };
  },

  toAct(s) { return s.round >= s.rounds ? [] : s.played.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0); },

  apply(s, seat, action) {
    const card = action && action.card;
    if (!s.hands[seat].includes(card)) throw new Error("You don't have that card.");
    s.hands[seat] = s.hands[seat].filter((c) => c !== card);
    s.played[seat] = card;
    if (s.played.every((p) => p !== null)) {
      const winner = s.played.reduce((w, c, i) => (c > s.played[w] ? i : w), 0);
      s.scores[winner]++;
      s.last = { cards: s.played.slice(), winner, round: s.round };
      s.played = Array(s.n).fill(null);
      s.round++;
    }
    return s;
  },

  // Everyone sees: scores, who has chosen (not what), the last reveal.
  publicView(s) {
    return {
      round: s.round, rounds: s.rounds, scores: s.scores, names: s.names,
      chosen: s.played.map((p) => p !== null), handCounts: s.hands.map((h) => h.length), last: s.last,
    };
  },
  // Only this seat sees: their hand and the card they've picked this round.
  privateView(s, seat) { return { hand: s.hands[seat], picked: s.played[seat] }; },

  bot(ctx, seat, rng = Math.random) {
    const h = ctx.mine.hand;
    return { card: h[Math.floor(rng() * h.length)] };
  },

  isOver(s) { return s.round >= s.rounds; },
};
