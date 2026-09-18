/**
 * Culture ship names (Iain M. Banks) used as default player names.
 * Deliberately absurd, because that is the point.
 */
export const SHIP_NAMES: readonly string[] = [
  "Of Course I Still Love You",
  "Just Read the Instructions",
  "So Much For Subtlety",
  "What Are the Civilian Applications?",
  "Ultimate Ship The Second",
  "Frank Exchange of Views",
  "Nervous Energy",
  "Falling Outside the Normal Moral Constraints",
  "Mistake Not My Current State Of Joshing Gentle Peevishness",
  "Sleeper Service",
  "Grey Area",
  "Meatfucker",
  "Sense Amid Madness, Wit Amidst Folly",
  "Prosthetic Conscience",
  "No More Mr Nice Guy",
  "Ablation",
  "Xenophobe",
  "Congenital Optimist",
  "Prime Mover",
  "Anticipation Of A New Lover's Arrival, The",
  "Fixed Grin",
  "Unfortunate Conflict Of Evidence",
  "Big Sexy Beast",
  "Charitable View",
  "No Fixed Abode",
  "Zero Gravitas",
  "Experiencing A Significant Gravitas Shortfall",
  "Sweet and Full of Grace",
  "Contents May Differ",
  "Signal to Noise",
  "Resistance Is Character-Forming",
  "Problem Child",
  "Heavy Messing",
  "Limiting Factor",
  "Shoot Them Later",
  "Now Look What You Made Me Do",
  "Warm, Considering",
  "Better Days",
  "Wearily Sarcastic",
  "Synchronised Array Of Delights",
  "Unacceptable Behaviour",
  "Caconym",
  "Not Invented Here",
  "Poke It With A Stick",
  "Someone Else's Problem",
  "The Precise Nature Of The Catastrophe",
  "Don't Try This At Home",
  "Well I Was In The Neighbourhood",
  "Little Rascal",
  "I Blame My Mother",
  "Profit Margin",
  "It's Character Forming",
  "Keep It Clean",
  "You'll Thank Me Later",
  "Out of Control",
  "A Fine Disregard For Awkward Facts",
  "Ravished By The Sheer Implausibility Of That Last Statement",
  "Irregular Apocalypse",
  "Ethics Gradient",
  "Slightly Wet",
  "Refreshingly Unconcerned",
];

export interface PickShipNameOptions {
  /**
   * Names that must not be returned while any other ship exists. Soft `taken`
   * names may be reused once the free pool is empty; reserved names survive
   * that fallback. A table's other seats go here so a reroll cannot seat two
   * identical names.
   */
  reserved?: Iterable<string>;
}

/**
 * Pick a random ship name, avoiding names already taken. `taken` is the recent
 * pool — once it covers every ship we may reuse one. `reserved` is the hard
 * set: another seat at this table, or the name you already have.
 */
export function pickShipName(taken: Iterable<string> = [], options: PickShipNameOptions = {}): string {
  const reserved = new Set(options.reserved ?? []);
  const used = new Set<string>([...taken, ...reserved]);
  const free = SHIP_NAMES.filter((name) => !used.has(name));
  if (free.length > 0) return free[randomIndex(free.length)] ?? "Nameless Drone";
  const notReserved = SHIP_NAMES.filter((name) => !reserved.has(name));
  const pool = notReserved.length > 0 ? notReserved : SHIP_NAMES;
  return pool[randomIndex(pool.length)] ?? "Nameless Drone";
}

/** Unbiased random integer in [0, max). */
function randomIndex(max: number): number {
  if (max <= 1) return 0;
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const value = buf[0]!;
    if (value < limit) return value % max;
  }
}
