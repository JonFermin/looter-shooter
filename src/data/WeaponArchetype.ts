// Weapon archetypes and their base stat ranges. Each archetype defines a
// min/max envelope per stat — actual weapon instances roll inside that
// envelope and then get scaled by rarity (see systems/StatRoll.ts).

export enum Archetype {
  PISTOL = 0,
  SMG = 1,
  RIFLE = 2,
  SHOTGUN = 3,
  BLASTER = 4,
}

export interface WeaponStats {
  damage: number;
  fireRate: number; // shots per second
  magazine: number;
  reloadTime: number; // seconds
  accuracy: number; // 0-1, 1 = perfect
}

export interface StatRange {
  min: number;
  max: number;
}

export type ArchetypeStatRanges = Record<keyof WeaponStats, StatRange>;

// Per-archetype stat envelopes. Values are pre-rarity; rarity scaling is
// applied on top. Identity notes:
//   PISTOL  — small mag, medium fireRate, fast reload, decent accuracy
//   SMG     — high fireRate, big mag, low per-shot damage, lower accuracy
//   RIFLE   — high accuracy, medium fireRate, medium damage
//   SHOTGUN — high damage, low fireRate, small mag, low accuracy
//   BLASTER — moderate everything (catch-all for the 18 Kenney blasters)
export const ARCHETYPE_BASE_STATS: Record<Archetype, ArchetypeStatRanges> = {
  [Archetype.PISTOL]: {
    damage: { min: 12, max: 20 },
    fireRate: { min: 3, max: 5 },
    magazine: { min: 8, max: 14 },
    reloadTime: { min: 1.0, max: 1.5 },
    accuracy: { min: 0.75, max: 0.88 },
  },
  [Archetype.SMG]: {
    damage: { min: 6, max: 10 },
    fireRate: { min: 9, max: 14 },
    magazine: { min: 28, max: 45 },
    reloadTime: { min: 1.8, max: 2.4 },
    accuracy: { min: 0.55, max: 0.72 },
  },
  [Archetype.RIFLE]: {
    damage: { min: 18, max: 28 },
    fireRate: { min: 4, max: 7 },
    magazine: { min: 20, max: 32 },
    reloadTime: { min: 2.0, max: 2.8 },
    accuracy: { min: 0.85, max: 0.96 },
  },
  [Archetype.SHOTGUN]: {
    damage: { min: 38, max: 60 },
    fireRate: { min: 1, max: 2 },
    magazine: { min: 4, max: 8 },
    reloadTime: { min: 2.5, max: 3.5 },
    accuracy: { min: 0.45, max: 0.6 },
  },
  [Archetype.BLASTER]: {
    damage: { min: 14, max: 22 },
    fireRate: { min: 4, max: 8 },
    magazine: { min: 14, max: 24 },
    reloadTime: { min: 1.5, max: 2.2 },
    accuracy: { min: 0.7, max: 0.85 },
  },
};
