// LootSystem — module-singleton registry of active LootDrops in the world.
// Owns spawn/dispose lifecycle and proximity queries used by pickup
// interaction. Stateless aside from the active-drops Set so HMR reloads
// don't strand orphan beams in the scene (callers dispose individually).
//
// Distance is measured on the XZ plane so a drop on the ground and a
// player whose root sits at y=0 still register as "within pickup range"
// regardless of any future Y-axis variation (e.g. drops on platforms).

import type { Scene } from "@babylonjs/core/scene.js";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector.js";

import { LootDrop } from "../entities/LootDrop.js";
import type { WeaponStats } from "../data/WeaponArchetype.js";
import type { RarityTier } from "../data/Rarity.js";
import type { Player } from "../entities/Player.js";

// Pickup radius in world units. Matches the AC ("within 2 units").
const PICKUP_RADIUS = 2;

const activeDrops = new Set<LootDrop>();

export function spawnLoot(
  scene: Scene,
  position: Vector3,
  weapon: WeaponStats,
  rarity: RarityTier,
  weaponMeshPath: string,
): LootDrop {
  const drop = new LootDrop(scene, position, weapon, rarity, weaponMeshPath);
  activeDrops.add(drop);
  return drop;
}

/**
 * Returns the closest LootDrop within PICKUP_RADIUS of the player on the
 * XZ plane, or null if none are in range. Reads `player.position` directly
 * — the Phase-3 shim that looked up "playerRoot" by mesh name is gone now
 * that Player exposes a public position getter.
 */
export function nearestPickup(player: Player): LootDrop | null {
  const playerPos = player.position;
  let best: LootDrop | null = null;
  let bestDist = PICKUP_RADIUS;
  for (const drop of activeDrops) {
    const p = drop.position;
    const dx = p.x - playerPos.x;
    const dz = p.z - playerPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= bestDist) {
      best = drop;
      bestDist = dist;
    }
  }
  return best;
}

/** Remove a drop from the registry and dispose its scene resources. */
export function dispose(drop: LootDrop): void {
  activeDrops.delete(drop);
  drop.dispose();
}

/** Snapshot of currently active drops (mutating the result is safe). */
export function getActiveDrops(): LootDrop[] {
  return Array.from(activeDrops);
}

/** Total active drop count — useful for HUD/debug overlays. */
export function activeCount(): number {
  return activeDrops.size;
}
