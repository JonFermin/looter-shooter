// Procedural weapon-stat roller. Combines an archetype's base stat envelope
// with a rarity-driven multiplier table to produce a concrete WeaponStats.
//
// The PRNG is a self-contained Mulberry32 so rolls are deterministic when a
// seed is supplied (useful for tests and replayable loot). When no seed is
// given we fall back to Math.random() per call.

import {
  ARCHETYPE_BASE_STATS,
  Archetype,
  type StatRange,
  type WeaponStats,
} from "../data/WeaponArchetype.js";
import { RarityTier } from "../data/Rarity.js";

type RNG = () => number;

type StatKey = keyof WeaponStats;

// Per-stat rarity multipliers. Higher rarity → bigger numbers, EXCEPT for
// reloadTime which divides by the multiplier (lower reload is better).
// Damage scales most aggressively; fireRate and magazine scale modestly so
// LEGENDARY weapons aren't trivially dominant on every axis.
const RARITY_MULTIPLIER: Record<StatKey, Record<RarityTier, number>> = {
  damage: {
    [RarityTier.COMMON]: 1.0,
    [RarityTier.UNCOMMON]: 1.15,
    [RarityTier.RARE]: 1.3,
    [RarityTier.EPIC]: 1.5,
    [RarityTier.LEGENDARY]: 1.75,
  },
  fireRate: {
    [RarityTier.COMMON]: 1.0,
    [RarityTier.UNCOMMON]: 1.04,
    [RarityTier.RARE]: 1.08,
    [RarityTier.EPIC]: 1.12,
    [RarityTier.LEGENDARY]: 1.18,
  },
  magazine: {
    [RarityTier.COMMON]: 1.0,
    [RarityTier.UNCOMMON]: 1.05,
    [RarityTier.RARE]: 1.1,
    [RarityTier.EPIC]: 1.15,
    [RarityTier.LEGENDARY]: 1.25,
  },
  // reloadTime: divisor — bigger value at higher rarity = LOWER reload.
  reloadTime: {
    [RarityTier.COMMON]: 1.0,
    [RarityTier.UNCOMMON]: 1.05,
    [RarityTier.RARE]: 1.1,
    [RarityTier.EPIC]: 1.18,
    [RarityTier.LEGENDARY]: 1.3,
  },
  accuracy: {
    [RarityTier.COMMON]: 1.0,
    [RarityTier.UNCOMMON]: 1.03,
    [RarityTier.RARE]: 1.06,
    [RarityTier.EPIC]: 1.1,
    [RarityTier.LEGENDARY]: 1.15,
  },
};

function mulberry32(seed: number): RNG {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

function rollStat(range: StatRange, multiplier: number, rng: RNG): number {
  return lerp(range.min, range.max, rng()) * multiplier;
}

function rollReload(range: StatRange, multiplier: number, rng: RNG): number {
  // Roll the inverted lerp so higher rng() pulls toward min, then divide by
  // the rarity multiplier so higher rarity = lower reload time.
  return lerp(range.max, range.min, rng()) / multiplier;
}

export function rollWeapon(
  archetype: Archetype,
  rarity: RarityTier,
  seed?: number,
): WeaponStats {
  const ranges = ARCHETYPE_BASE_STATS[archetype];
  const rng: RNG = seed === undefined ? Math.random : mulberry32(seed);

  const damage = rollStat(
    ranges.damage,
    RARITY_MULTIPLIER.damage[rarity],
    rng,
  );
  const fireRate = rollStat(
    ranges.fireRate,
    RARITY_MULTIPLIER.fireRate[rarity],
    rng,
  );
  const magazine = rollStat(
    ranges.magazine,
    RARITY_MULTIPLIER.magazine[rarity],
    rng,
  );
  const reloadTime = rollReload(
    ranges.reloadTime,
    RARITY_MULTIPLIER.reloadTime[rarity],
    rng,
  );
  const accuracyRaw = rollStat(
    ranges.accuracy,
    RARITY_MULTIPLIER.accuracy[rarity],
    rng,
  );

  return {
    damage: Math.round(damage * 10) / 10,
    fireRate: Math.round(fireRate * 100) / 100,
    magazine: Math.max(1, Math.round(magazine)),
    reloadTime: Math.round(reloadTime * 100) / 100,
    accuracy: Math.min(1, Math.round(accuracyRaw * 1000) / 1000),
  };
}

// Self-test: roll 1000 COMMON and 1000 LEGENDARY weapons of the same
// archetype and compare mean damage. LEGENDARY must come out on top.
export function _selfTestRollWeapon(): { common: number; legendary: number } {
  const samples = 1000;
  let commonSum = 0;
  let legendarySum = 0;
  for (let i = 0; i < samples; i++) {
    commonSum += rollWeapon(Archetype.RIFLE, RarityTier.COMMON, i + 1).damage;
    legendarySum += rollWeapon(
      Archetype.RIFLE,
      RarityTier.LEGENDARY,
      i + 1,
    ).damage;
  }
  const common = commonSum / samples;
  const legendary = legendarySum / samples;
  if (legendary <= common) {
    throw new Error(
      `StatRoll self-test failed: legendary mean (${legendary}) <= common mean (${common})`,
    );
  }
  return { common, legendary };
}

// Main-guard: only run when this file is executed directly via `node` after
// being compiled. In the browser bundle (Vite) `process` is undefined and
// the whole block is dead-code-eliminated. The `typeof` check keeps tsc
// strict happy without pulling in @types/node.
declare const process: { argv: string[] } | undefined;
if (typeof process !== "undefined" && process.argv[1] !== undefined) {
  // Normalize Windows-style backslashes and strip the file:// prefix so
  // `node dist/.../StatRoll.js` from any cwd still matches.
  const argvPath = process.argv[1].replace(/\\/g, "/");
  const urlPath = import.meta.url.replace(/^file:\/\/\/?/, "");
  if (urlPath.endsWith(argvPath)) {
    const result = _selfTestRollWeapon();
    console.log(
      `StatRoll self-test: COMMON mean=${result.common.toFixed(2)}, LEGENDARY mean=${result.legendary.toFixed(2)}`,
    );
  }
}
