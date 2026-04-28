// InventoryItem — bundles a rolled WeaponStats with the metadata needed to
// rebuild a Weapon (mesh path) and render an inventory card (display name,
// archetype label, rarity tier color). One of these is created per pickup
// from a LootDrop and per starter weapon at scene init.

import type { WeaponStats } from "./WeaponArchetype.js";
import type { Archetype } from "./WeaponArchetype.js";
import type { RarityTier } from "./Rarity.js";

export interface InventoryItem {
  stats: WeaponStats;
  archetype: Archetype;
  rarity: RarityTier;
  meshPath: string;
  displayName: string;
}
