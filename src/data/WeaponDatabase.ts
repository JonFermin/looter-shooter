// WeaponDatabase — flat catalogue mapping the 22 weapon meshes shipped under
// public/assets/weapons/ to the five gameplay archetypes. Phase 4 #10 (loot
// drops -> weapon instances) and the WeaponDemo both pull from this table so
// the same mesh paths drive both visual world drops and equipped weapons.
//
// We expose two views over the same data:
//   1. WEAPON_DATABASE — flat array of WeaponEntry, easy to iterate or
//      randomly pick from.
//   2. WEAPONS_BY_ARCHETYPE — derived Record<Archetype, WeaponEntry[]>, easy
//      to look up by archetype when picking a mesh for a rolled weapon.
//
// Display names come from the file basename (e.g. "blaster-a.glb" -> "Blaster
// A"). Quaternius firearms (Pistol/SMG/Rifle/Shotgun) keep their nice
// titlecase name as-is.

import { Archetype } from "./WeaponArchetype.js";

export interface WeaponEntry {
  archetype: Archetype;
  meshPath: string;
  displayName: string;
}

// Authoring-time list. 22 entries total: 4 PISTOL + 5 SMG + 5 RIFLE +
// 3 SHOTGUN + 5 BLASTER. Order within an archetype doesn't matter — pickers
// random-pick or iterate.
export const WEAPON_DATABASE: WeaponEntry[] = [
  // PISTOL — small, low damage, fast reload, low magazine.
  entry(Archetype.PISTOL, "/assets/weapons/Pistol.gltf"),
  entry(Archetype.PISTOL, "/assets/weapons/blaster-a.glb"),
  entry(Archetype.PISTOL, "/assets/weapons/blaster-d.glb"),
  entry(Archetype.PISTOL, "/assets/weapons/blaster-g.glb"),

  // SMG — high fire rate, big magazine, low per-shot damage.
  entry(Archetype.SMG, "/assets/weapons/SMG.gltf"),
  entry(Archetype.SMG, "/assets/weapons/blaster-b.glb"),
  entry(Archetype.SMG, "/assets/weapons/blaster-e.glb"),
  entry(Archetype.SMG, "/assets/weapons/blaster-h.glb"),
  entry(Archetype.SMG, "/assets/weapons/blaster-k.glb"),

  // RIFLE — high accuracy + damage, medium fire rate.
  entry(Archetype.RIFLE, "/assets/weapons/Rifle.gltf"),
  entry(Archetype.RIFLE, "/assets/weapons/blaster-c.glb"),
  entry(Archetype.RIFLE, "/assets/weapons/blaster-f.glb"),
  entry(Archetype.RIFLE, "/assets/weapons/blaster-i.glb"),
  entry(Archetype.RIFLE, "/assets/weapons/blaster-l.glb"),

  // SHOTGUN — single-hit power, low fire rate, small magazine.
  entry(Archetype.SHOTGUN, "/assets/weapons/Shotgun.gltf"),
  entry(Archetype.SHOTGUN, "/assets/weapons/blaster-j.glb"),
  entry(Archetype.SHOTGUN, "/assets/weapons/blaster-m.glb"),

  // BLASTER — alien-tech variants. Catch-all for the leftover Kenney pieces.
  entry(Archetype.BLASTER, "/assets/weapons/blaster-n.glb"),
  entry(Archetype.BLASTER, "/assets/weapons/blaster-o.glb"),
  entry(Archetype.BLASTER, "/assets/weapons/blaster-p.glb"),
  entry(Archetype.BLASTER, "/assets/weapons/blaster-q.glb"),
  entry(Archetype.BLASTER, "/assets/weapons/blaster-r.glb"),
];

// Derived bucket-by-archetype view. We rebuild it once at module load so
// callers don't pay an O(N) filter on every spawn.
export const WEAPONS_BY_ARCHETYPE: Record<Archetype, WeaponEntry[]> =
  buildArchetypeIndex(WEAPON_DATABASE);

/**
 * Pick a single weapon entry for the given archetype. Throws if the
 * archetype has zero registered meshes (which would indicate a bad table —
 * we keep at least 3 entries per archetype above).
 */
export function pickWeaponEntry(
  archetype: Archetype,
  rng: () => number = Math.random,
): WeaponEntry {
  const bucket = WEAPONS_BY_ARCHETYPE[archetype];
  if (!bucket || bucket.length === 0) {
    throw new Error(
      `WeaponDatabase: no entries for archetype ${Archetype[archetype]}`,
    );
  }
  const idx = Math.floor(rng() * bucket.length);
  // noUncheckedIndexedAccess narrowing: explicit guard.
  const value = bucket[idx];
  if (!value) {
    throw new Error(
      `WeaponDatabase: out-of-range pick for archetype ${Archetype[archetype]}`,
    );
  }
  return value;
}

// -- internals --

function entry(archetype: Archetype, meshPath: string): WeaponEntry {
  return { archetype, meshPath, displayName: deriveDisplayName(meshPath) };
}

// "/assets/weapons/blaster-a.glb" -> "Blaster A".
// "/assets/weapons/Pistol.gltf"   -> "Pistol".
function deriveDisplayName(meshPath: string): string {
  const slash = meshPath.lastIndexOf("/");
  const dot = meshPath.lastIndexOf(".");
  const base = meshPath.slice(slash + 1, dot === -1 ? undefined : dot);
  // Replace dashes/underscores with spaces and titlecase each word.
  return base
    .replace(/[-_]+/g, " ")
    .split(" ")
    .map((word) =>
      word.length === 0
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function buildArchetypeIndex(
  list: readonly WeaponEntry[],
): Record<Archetype, WeaponEntry[]> {
  const out: Record<Archetype, WeaponEntry[]> = {
    [Archetype.PISTOL]: [],
    [Archetype.SMG]: [],
    [Archetype.RIFLE]: [],
    [Archetype.SHOTGUN]: [],
    [Archetype.BLASTER]: [],
  };
  for (const e of list) {
    out[e.archetype].push(e);
  }
  return out;
}
