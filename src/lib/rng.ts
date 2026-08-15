// Deterministic seeded RNG so the same CA / wallet always produces the same numbers.
export function hashStringToSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seedInput: string): () => number {
  return mulberry32(hashStringToSeed(seedInput));
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function randomBase58Address(rng: () => number, length = 44): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE58_ALPHABET[Math.floor(rng() * BASE58_ALPHABET.length)];
  }
  return out;
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}
