// Settlement Arena scene — wasteland courtyard built from Kenney
// retro-urban-kit + survival-kit + city-kit-industrial GLBs. Loads each
// unique environment GLB into an AssetContainer once, then instantiates
// clones for each placement so we don't re-decode shared textures (which
// the Babylon WebGPU loader chokes on when the same GLB is fetched in
// parallel).
//
// Coord system: courtyard is centered at the origin, +X is east, +Z is
// north. Walls run along the four perimeter edges at z=±HALF / x=±HALF.
// Kenney retro-urban-kit walls are ~4 units long; we space at 4u on
// the perimeter so adjacent segments butt cleanly. Wall facings rotate
// to face into the courtyard center.

import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { BoundingBox } from "@babylonjs/core/Culling/boundingBox.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";

import { loadGLB } from "../utils/AssetLoader.js";
import { getDeltaSeconds } from "../utils/time.js";

import { Player } from "../entities/Player.js";
import { Input } from "../input/Input.js";
import { Weapon } from "../entities/Weapon.js";
import { Enemy } from "../entities/Enemy.js";
import {
  spawnLoot,
  nearestPickup,
  dispose as disposeLoot,
  getActiveDrops,
} from "../systems/LootSystem.js";
import { fire as combatFire, notifyHit } from "../systems/Combat.js";
import {
  WaveSpawner,
  type SpawnUnit,
} from "../systems/WaveSpawner.js";
import { Hud } from "../ui/Hud.js";
import { DamageNumbers } from "../ui/DamageNumbers.js";
import { Inventory } from "../ui/Inventory.js";
import { StartScreen } from "../ui/StartScreen.js";
import { DeathScreen } from "../ui/DeathScreen.js";
import { Minimap } from "../ui/Minimap.js";

import {
  Archetype,
  type WeaponStats,
} from "../data/WeaponArchetype.js";
import { RarityTier, RARITY_WEIGHT } from "../data/Rarity.js";
import {
  WEAPONS_BY_ARCHETYPE,
  pickWeaponEntry,
  lookupWeaponEntryByMeshPath,
  type WeaponEntry,
} from "../data/WeaponDatabase.js";
import type { InventoryItem } from "../data/InventoryItem.js";
import { rollWeapon } from "../systems/StatRoll.js";
import {
  SAVE_SCHEMA_VERSION,
  itemToSerialized,
  loadSavedState,
  saveState,
  serializedToItem,
} from "../persistence/SaveLoad.js";

const ASSET_BASE = "/assets/environment";

// Kenney retro-urban-kit walls and survival props ship at ~1u and ~0.25u
// respectively. We scale everything up so the courtyard reads at a
// human-walking scale (≈1.6u tall character would clear a wall etc.).
const PROP_SCALE = 4;
// Perimeter wall step in world units after PROP_SCALE. wall-a is 1u
// wide in the source GLB; scaled by 4 we get 4u segments that butt
// edge-to-edge.
const WALL_STEP = 4;
// Inner half-extent of the courtyard floor — perimeter walls sit at this
// distance from the origin on each cardinal axis. ~25u half-extent gives
// the ~50u courtyard the task calls for.
const HALF = 24;

export interface ArenaInfo {
  spawnPoint: Vector3;
  bounds: BoundingBox;
}

interface PlacementOpts {
  position: Vector3;
  rotationY?: number;
  scale?: number;
}

// Apply transform to a Node-like with position/rotation/scaling. The
// glTF root is a TransformNode in practice, but typing through Node is
// awkward — we narrow structurally to dodge a deep import.
type Transformable = {
  position: Vector3;
  rotation: Vector3;
  scaling: Vector3;
};

// Cache of AssetContainers keyed by filename. Each unique GLB is fetched
// at most once per scene; subsequent placements call
// `instantiateModelsToScene()` which clones the meshes without re-parsing
// the buffer or re-decoding textures.
async function fetchTemplate(
  scene: Scene,
  cache: Map<string, Promise<AssetContainer | null>>,
  filename: string,
): Promise<AssetContainer | null> {
  const existing = cache.get(filename);
  if (existing) return existing;
  const promise = loadGLB(scene, `${ASSET_BASE}/${filename}`).catch(
    (err: unknown) => {
      console.warn(`Arena: failed to load ${filename}:`, err);
      return null;
    },
  );
  cache.set(filename, promise);
  return promise;
}

// Instantiate one clone of the cached template at the given transform.
// Returns true on success, false if the template wasn't loadable.
function placeFromTemplate(
  template: AssetContainer | null,
  filename: string,
  opts: PlacementOpts,
): boolean {
  if (!template) return false;
  const entries = template.instantiateModelsToScene(
    (name) => `${filename}:${name}`,
    false,
    { doNotInstantiate: true },
  );
  const root = entries.rootNodes[0];
  if (!root) {
    console.warn(`Arena: ${filename} instantiated but has no root node`);
    return false;
  }
  const transform = root as unknown as Transformable;
  transform.position = opts.position.clone();
  if (opts.rotationY !== undefined) {
    transform.rotation = new Vector3(0, opts.rotationY, 0);
  }
  // Always apply PROP_SCALE so the source 1u Kenney models read at the
  // courtyard's human scale. Caller can override with opts.scale for
  // outliers (large buildings, etc.).
  const scale = opts.scale ?? PROP_SCALE;
  transform.scaling = new Vector3(scale, scale, scale);
  return true;
}

// Generate placements for one straight perimeter edge. The edge runs
// along `axis` ("x" = east-west, "z" = north-south) at the fixed value
// of the other coordinate. Walls face into the courtyard via rotationY.
// `doorIndex` substitutes a door segment for a courtyard entrance, and
// `brokenIndices` substitute broken-wall variants for ramshackle flavor.
interface EdgeSpec {
  axis: "x" | "z";
  fixed: number;
  facingY: number;
  doorIndex?: number;
  brokenIndices?: number[];
}

function buildEdgePlacements(
  edge: EdgeSpec,
): Array<{ filename: string; opts: PlacementOpts }> {
  const placements: Array<{ filename: string; opts: PlacementOpts }> = [];
  const start = -HALF + WALL_STEP / 2;
  const segments = Math.floor((HALF * 2) / WALL_STEP);
  for (let i = 0; i < segments; i++) {
    const along = start + i * WALL_STEP;
    const pos =
      edge.axis === "x"
        ? new Vector3(along, 0, edge.fixed)
        : new Vector3(edge.fixed, 0, along);
    let filename = "wall-a.glb";
    if (edge.doorIndex !== undefined && i === edge.doorIndex) {
      filename = "wall-a-door.glb";
    } else if (edge.brokenIndices?.includes(i)) {
      filename =
        i % 2 === 0 ? "wall-broken-type-a.glb" : "wall-broken-type-b.glb";
    } else if (i === 2 || i === segments - 3) {
      filename = "wall-a-window.glb";
    }
    placements.push({ filename, opts: { position: pos, rotationY: edge.facingY } });
  }
  return placements;
}

/**
 * Build the settlement arena into `scene`. Loads >=15 distinct
 * environment GLBs (each fetched once, then instantiated for repeats)
 * forming an enclosed ~50x50 wasteland courtyard with cover props and
 * 2-3 building shells.
 *
 * @param scene - target Babylon scene
 * @returns spawn point at the courtyard center and the playable bounds
 */
export async function buildArena(scene: Scene): Promise<ArenaInfo> {
  // ---------------------------------------------------------------------
  // Build the full placement list first, then de-dupe filenames so we
  // fetch each GLB exactly once. This is the difference between "loads
  // cleanly" and "8 textures fail to decode" on the WebGPU loader path.
  // ---------------------------------------------------------------------
  const placements: Array<{ filename: string; opts: PlacementOpts }> = [];

  // Perimeter walls — four edges, with one door on each side and a few
  // broken segments for wasteland flavor.
  const edges: EdgeSpec[] = [
    {
      axis: "x",
      fixed: HALF,
      facingY: Math.PI,
      doorIndex: 5,
      brokenIndices: [2, 9],
    },
    {
      axis: "x",
      fixed: -HALF,
      facingY: 0,
      doorIndex: 6,
      brokenIndices: [3],
    },
    {
      axis: "z",
      fixed: HALF,
      facingY: -Math.PI / 2,
      doorIndex: 4,
      brokenIndices: [8],
    },
    {
      axis: "z",
      fixed: -HALF,
      facingY: Math.PI / 2,
      doorIndex: 7,
      brokenIndices: [1, 10],
    },
  ];
  for (const edge of edges) {
    for (const placement of buildEdgePlacements(edge)) {
      placements.push(placement);
    }
  }

  // Corner pieces — one wall-a-corner.glb at each of the four corners.
  const corners: Array<{ pos: Vector3; rotY: number }> = [
    { pos: new Vector3(-HALF, 0, -HALF), rotY: 0 },
    { pos: new Vector3(HALF, 0, -HALF), rotY: -Math.PI / 2 },
    { pos: new Vector3(HALF, 0, HALF), rotY: Math.PI },
    { pos: new Vector3(-HALF, 0, HALF), rotY: Math.PI / 2 },
  ];
  for (const corner of corners) {
    placements.push({
      filename: "wall-a-corner.glb",
      opts: { position: corner.pos, rotationY: corner.rotY },
    });
  }

  // Building shells — sit just outside the courtyard so their facades
  // form the visible skyline through the wall gaps.
  placements.push(
    {
      filename: "building-a.glb",
      opts: {
        position: new Vector3(-HALF - 8, 0, -HALF - 8),
        rotationY: Math.PI / 4,
      },
    },
    {
      filename: "building-c.glb",
      opts: {
        position: new Vector3(HALF + 9, 0, HALF + 6),
        rotationY: -Math.PI * 0.6,
      },
    },
    {
      filename: "building-f.glb",
      opts: {
        position: new Vector3(HALF + 8, 0, -HALF - 9),
        rotationY: Math.PI * 0.75,
      },
    },
    {
      filename: "chimney-medium.glb",
      opts: { position: new Vector3(-HALF - 10, 0, HALF + 5) },
    },
    {
      filename: "detail-tank.glb",
      opts: {
        position: new Vector3(HALF - 4, 0, HALF - 4),
        rotationY: Math.PI / 6,
      },
    },
  );

  // Cover props inside the courtyard — staggered clusters of barrels,
  // crates, dumpsters, fences, rocks. Positions hand-tuned so the layout
  // reads as "salvaged settlement" rather than a regular grid.
  placements.push(
    // Central crate cluster + barrels
    { filename: "box-large.glb", opts: { position: new Vector3(-3, 0, 4) } },
    {
      filename: "box-large-open.glb",
      opts: { position: new Vector3(-1, 0, 6.5), rotationY: Math.PI / 5 },
    },
    { filename: "box.glb", opts: { position: new Vector3(-4.2, 0, 6.2) } },
    {
      filename: "box-open.glb",
      opts: { position: new Vector3(2.5, 0, 5), rotationY: -Math.PI / 3 },
    },
    { filename: "barrel.glb", opts: { position: new Vector3(4.5, 0, 7) } },
    { filename: "barrel-open.glb", opts: { position: new Vector3(5.5, 0, 8.5) } },
    // Northeast nook — dumpster + fence cover
    {
      filename: "detail-dumpster-closed.glb",
      opts: { position: new Vector3(12, 0, 14), rotationY: Math.PI / 2 },
    },
    {
      filename: "detail-dumpster-open.glb",
      opts: { position: new Vector3(15, 0, 11) },
    },
    { filename: "fence.glb", opts: { position: new Vector3(10, 0, 17) } },
    {
      filename: "fence-fortified.glb",
      opts: { position: new Vector3(14, 0, 18) },
    },
    // Southwest barricade line
    {
      filename: "detail-barrier-strong-type-a.glb",
      opts: { position: new Vector3(-10, 0, -10), rotationY: Math.PI / 8 },
    },
    {
      filename: "detail-barrier-strong-damaged.glb",
      opts: { position: new Vector3(-13, 0, -11.5) },
    },
    {
      filename: "pallet.glb",
      opts: { position: new Vector3(-8, 0, -13), rotationY: Math.PI / 6 },
    },
    {
      filename: "resource-planks.glb",
      opts: { position: new Vector3(-11, 0, -14) },
    },
    {
      filename: "resource-wood.glb",
      opts: { position: new Vector3(-14, 0, -8), rotationY: Math.PI / 4 },
    },
    // Scattered rocks for natural cover
    { filename: "rock-a.glb", opts: { position: new Vector3(8, 0, -12) } },
    {
      filename: "rock-b.glb",
      opts: { position: new Vector3(11, 0, -8), rotationY: Math.PI / 3 },
    },
    {
      filename: "rock-a.glb",
      opts: { position: new Vector3(-6, 0, 12), rotationY: -Math.PI / 4 },
    },
    // Road tile pieces for a beat-up entry path running south->north.
    {
      filename: "road-asphalt-damaged.glb",
      opts: { position: new Vector3(0, 0, -12) },
    },
    {
      filename: "road-asphalt-damaged.glb",
      opts: { position: new Vector3(0, 0, -4) },
    },
  );

  // ---------------------------------------------------------------------
  // De-dupe filenames and fetch each unique GLB once. We keep load
  // concurrency low (handful at a time) to stay well under any
  // image-decoder queue limits the WebGPU loader has.
  // ---------------------------------------------------------------------
  const uniqueFilenames = Array.from(
    new Set(placements.map((p) => p.filename)),
  );
  const cache = new Map<string, Promise<AssetContainer | null>>();
  const templates = new Map<string, AssetContainer | null>();

  // Sequential awaits — slightly slower, dramatically more reliable than
  // Promise.all here because the glTF texture decoder pipeline serializes
  // poorly under heavy concurrency.
  for (const filename of uniqueFilenames) {
    const tpl = await fetchTemplate(scene, cache, filename);
    templates.set(filename, tpl);
  }

  // Now instantiate every placement from the cached templates. This is
  // synchronous — instantiateModelsToScene clones nodes without I/O.
  for (const placement of placements) {
    const tpl = templates.get(placement.filename) ?? null;
    placeFromTemplate(tpl, placement.filename, placement.opts);
  }

  return {
    spawnPoint: new Vector3(0, 0, 0),
    bounds: new BoundingBox(
      new Vector3(-HALF - 1, 0, -HALF - 1),
      new Vector3(HALF + 1, 10, HALF + 1),
    ),
  };
}

// ---------------------------------------------------------------------------
// Phase 5 — full gameplay scene wired around the arena geometry.
// ---------------------------------------------------------------------------
// `createArenaScene` is the entry-point used by main.ts now that the dev
// sandbox phase is over. It composes the existing pieces — Player, Weapon,
// Enemy, LootSystem, Combat — into a single playable scene:
//   • spawns the player at Arena.spawnPoint with a starter RIFLE
//   • places 3 zombies + 1 UFO at hand-picked courtyard positions
//   • routes left-click → Combat.fire → enemyByMesh.get(hit.mesh)?.takeDamage
//   • routes enemy.onAttack → player.takeDamage
//   • routes enemy.onDeath → spawnLoot with rarity-weighted by enemy type
//   • clamps the player to Arena.bounds each frame
//   • picks up the nearest loot drop on E
// All wiring is contained in this function — no new global registries.

const ZOMBIE_BASIC_PATH = "/assets/characters/Zombie_Basic.gltf";
const ZOMBIE_CHUBBY_PATH = "/assets/characters/Zombie_Chubby.gltf";
const ZOMBIE_RIBCAGE_PATH = "/assets/characters/Zombie_Ribcage.gltf";
const UFO_PATH = "/assets/enemies/enemy-ufo-a.glb";

// Heavy-tail rarity table for the UFO. UFOs are tougher and rarer than
// zombies, so when they die we want the loot to skew toward the middle/high
// tiers rather than COMMON. Total = 100 to match RARITY_WEIGHT's mental
// model; relative weights are 10/25/30/25/10 across the 5 tiers.
const UFO_RARITY_WEIGHT: Record<RarityTier, number> = {
  [RarityTier.COMMON]: 10,
  [RarityTier.UNCOMMON]: 25,
  [RarityTier.RARE]: 30,
  [RarityTier.EPIC]: 25,
  [RarityTier.LEGENDARY]: 10,
};

const ALL_ARCHETYPES: Archetype[] = [
  Archetype.PISTOL,
  Archetype.SMG,
  Archetype.RIFLE,
  Archetype.SHOTGUN,
  Archetype.BLASTER,
];

/**
 * Build the full gameplay scene used by main.ts. Returns a ready-to-render
 * Scene whose lifecycle is owned by the caller (main.ts disposes on HMR).
 *
 * Public surface mirrors `createGameScene(engine, canvas) -> Scene` so the
 * import swap in main.ts is a one-line change.
 */
export async function createArenaScene(
  engine: AbstractEngine,
  canvas: HTMLCanvasElement,
): Promise<Scene> {
  const scene = new Scene(engine);
  // Wasteland sky — desaturated dusk so the Kenney prop palette pops.
  scene.clearColor = new Color4(0.5, 0.55, 0.6, 1);

  // Lighting: hemispheric for cheap ambient + a directional sun for shape.
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.55;
  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.6), scene);
  sun.intensity = 0.9;
  sun.position = new Vector3(20, 30, 20);

  // Build the courtyard geometry (perimeter walls, props, building shells).
  const { spawnPoint, bounds } = await buildArena(scene);

  // Input + player. We construct the player at the spawn point so the first
  // rendered frame doesn't show a one-frame teleport from origin to spawn.
  const input = new Input();
  const player = new Player(scene, canvas, input);
  await player.init();
  player.setSpawnPoint(spawnPoint);
  player.rootMesh.position.copyFrom(spawnPoint);
  player.hideGuitarMesh();

  // Starter weapon — saved state takes precedence so reloads restore the
  // exact equipped weapon (archetype, mesh, rolled stats, rarity). On a
  // fresh game we fall through to the deterministic COMMON rifle path so
  // first-load is reproducible.
  const saved = loadSavedState();

  let starterArchetype: Archetype;
  let starterMeshPath: string;
  let starterDisplayName: string;
  let starterStats: WeaponStats;
  let starterRarity: RarityTier;

  if (saved && saved.equipped) {
    starterArchetype = saved.equipped.archetype;
    starterMeshPath = saved.equipped.meshPath;
    starterDisplayName = saved.equipped.displayName;
    starterStats = saved.equipped.stats;
    starterRarity = saved.equipped.rarity;
  } else {
    starterArchetype = Archetype.RIFLE;
    const starterEntry = WEAPONS_BY_ARCHETYPE[starterArchetype][0];
    if (!starterEntry) {
      throw new Error("Arena: WEAPONS_BY_ARCHETYPE has no RIFLE entries");
    }
    starterMeshPath = starterEntry.meshPath;
    starterDisplayName = starterEntry.displayName;
    starterStats = rollWeapon(starterArchetype, RarityTier.COMMON);
    starterRarity = RarityTier.COMMON;
  }

  // `let` because Phase 7 #13's inventory equip flow re-assigns this after
  // disposing the previous Weapon instance. The Hud + click-to-fire closures
  // below capture the binding (not the value) so they always see the live
  // weapon.
  let weapon: Weapon = await Weapon.create(
    scene,
    {
      stats: starterStats,
      rarity: starterRarity,
      meshPath: starterMeshPath,
      displayName: starterDisplayName,
    },
    player.getRightHandTransform(),
  );

  if (saved) {
    // Restore inventory + currency + kills wholesale. setSavedState also
    // reseats `equipped`, so we don't double-set it below.
    player.setSavedState({
      inventory: saved.inventory.map(serializedToItem),
      equipped: saved.equipped ? serializedToItem(saved.equipped) : null,
      currency: saved.currency,
      totalKills: saved.totalKills,
    });
  } else {
    // Seed Player.equipped with the starter weapon's metadata so the
    // inventory compare panel can read it on first open.
    player.setEquipped({
      stats: starterStats,
      archetype: starterArchetype,
      rarity: starterRarity,
      meshPath: starterMeshPath,
      displayName: starterDisplayName,
    });
  }

  // Single source of truth for "save current loadout to localStorage".
  // Called after every discrete state mutation that affects what the
  // saved state should be — never per-frame.
  function persist(): void {
    const equipped = player.equipped;
    saveState({
      schemaVersion: SAVE_SCHEMA_VERSION,
      equipped: equipped ? itemToSerialized(equipped) : null,
      inventory: player.inventory.map(itemToSerialized),
      currency: player.currency,
      totalKills: player.totalKills,
    });
  }

  // ---- enemies + mesh→Enemy registry for damage routing ----
  // The Combat raycast returns whichever picked sub-mesh got hit, but
  // damage has to be applied on the owning Enemy instance. We populate a
  // Map<AbstractMesh, Enemy> at spawn time over each enemy's full mesh
  // hierarchy; the click handler does an O(1) lookup on the picked mesh.
  const enemyByMesh = new Map<AbstractMesh, Enemy>();
  const enemies: Enemy[] = [];

  // WaveSpawner delegates the actual Enemy.create to this callback so the
  // Arena keeps ownership of the mesh→Enemy registry, the loot drop wiring,
  // and the onAttack → player.takeDamage hookup. The spawner just decides
  // *which* enemies to spawn, *where*, and *with what HP*.
  async function spawnFromWave(
    unit: SpawnUnit,
    position: Vector3,
    hp: number,
  ): Promise<Enemy> {
    let enemy: Enemy;
    if (unit.kind === "ufo") {
      enemy = await Enemy.create(
        scene,
        UFO_PATH,
        {
          type: "ufo",
          position,
          hp,
          damage: 8,
          hoverHeight: 6,
          fireInterval: 2,
          detectionRadius: 30,
          scaling: 2,
        },
        "ufoDisc",
      );
    } else {
      const path =
        unit.variant === "basic"
          ? ZOMBIE_BASIC_PATH
          : unit.variant === "chubby"
            ? ZOMBIE_CHUBBY_PATH
            : ZOMBIE_RIBCAGE_PATH;
      // Variant-specific feel knobs — chubby is slow & big, ribcage is
      // fast & small, basic is the baseline. Mirrors the prior hand-placed
      // tuning so wave 1's three Basics behave the same as before.
      const speed =
        unit.variant === "chubby"
          ? 2.2
          : unit.variant === "ribcage"
            ? 3.6
            : 3;
      const scaling =
        unit.variant === "chubby"
          ? 1.15
          : unit.variant === "ribcage"
            ? 0.9
            : 1;
      enemy = await Enemy.create(scene, path, {
        type: "zombie",
        position,
        hp,
        speed,
        detectionRadius: 18,
        attackRange: 2,
        attackCooldown: 1,
        scaling,
      });
    }

    // Mesh registry + death wiring. We notify the spawner BEFORE running
    // the loot drop so the wave count refreshes ahead of any heavier
    // mesh-instantiation work the loot drop kicks off.
    for (const mesh of enemy.getMeshes()) {
      enemyByMesh.set(mesh, enemy);
    }
    enemy.onDeath.addOnce((dead) => {
      for (const mesh of enemy.getMeshes()) {
        enemyByMesh.delete(mesh);
      }
      spawner.notifyEnemyDeath(dead);
      handleEnemyDeath(dead);
      // Award progression on every confirmed death. UFOs are the rarer +
      // tougher enemy so they pay 5x what a zombie does. Numbers are
      // placeholders pending Phase 9's economy pass.
      player.addKill();
      player.addCurrency(dead.type === "ufo" ? 25 : 5);
      persist();
      // We deliberately leave `dead` in the `enemies` array — Enemy.update
      // still needs to drive the death sink-and-fade tween for ~800ms,
      // and Enemy.update internally noops once the tween disposes itself.
      // For a vertical slice the residual array growth across waves is
      // negligible.
    });
    enemy.onAttack.add((evt) => {
      player.takeDamage(evt.damage);
      console.log(
        `[Arena] hit by ${evt.enemy.type} for ${evt.damage} (HP=${player.hp})`,
      );
    });
    enemies.push(enemy);
    return enemy;
  }

  const spawner = new WaveSpawner({
    scene,
    bounds,
    player,
    spawnEnemy: spawnFromWave,
    breatherSeconds: 5,
  });

  // Death handler — rolls a weapon archetype + rarity weighted by enemy type
  // and spawns a LootDrop where the enemy fell. UFOs use the heavier
  // UFO_RARITY_WEIGHT so their drops skew toward EPIC/LEGENDARY.
  function handleEnemyDeath(deadEnemy: Enemy): void {
    const archetype = pickRandom(ALL_ARCHETYPES);
    const weights =
      deadEnemy.type === "ufo" ? UFO_RARITY_WEIGHT : RARITY_WEIGHT;
    const rarity = rollRarityWeighted(weights);
    const entry: WeaponEntry = pickWeaponEntry(archetype);
    const stats: WeaponStats = rollWeapon(archetype, rarity);
    const dropPos = deadEnemy.position.clone();
    // Anchor drop slightly above ground so the beam base sits on the floor.
    dropPos.y = 0;
    spawnLoot(scene, dropPos, stats, rarity, entry.meshPath);
    console.log(
      `[Arena] ${deadEnemy.type} died — dropped ${Archetype[archetype]} ` +
        `(${RarityTier[rarity]})`,
    );
  }

  // ---- left-click fire ----
  // Combat.fire raycasts from the active camera, picks the world, and asks
  // the weapon to consume ammo + draw visuals. We supply a predicate that
  // skips the player's own meshes, the weapon's own meshes, and any LootDrop
  // beam/weapon-mesh — those should never absorb a shot.
  const playerRoot = player.rootMesh;
  const weaponBarrelTipName = "weaponBarrelTip";

  function isPlayerOrWeaponOrLoot(mesh: AbstractMesh): boolean {
    if (mesh === playerRoot) return true;
    if (mesh.isDescendantOf(playerRoot)) return true;
    if (mesh.name === weaponBarrelTipName) return true;
    if (mesh.name.startsWith("weapon")) return true;
    if (mesh.name.startsWith("lootBeam")) return true;
    if (mesh.name.startsWith("lootDrop")) return true;
    return false;
  }

  // Combat already filters non-pickable meshes; we tighten its mesh-name
  // checks here by re-applying isPickable + name filtering at the source.
  // Because Combat.fire owns the raycast (we don't), we ensure pickable
  // exclusions are right by toggling isPickable on the player + weapon
  // hierarchies. Player meshes are skinned and pickable by default.
  for (const mesh of scene.meshes) {
    if (isPlayerOrWeaponOrLoot(mesh)) {
      mesh.isPickable = false;
    }
  }
  // Re-tag any mesh that gets created later (e.g. lazy-loaded loot drops)
  // when it enters the scene. This catches the LootDrop weapon mesh that
  // streams in after spawnLoot resolves.
  scene.onNewMeshAddedObservable.add((mesh) => {
    if (isPlayerOrWeaponOrLoot(mesh as AbstractMesh)) {
      (mesh as AbstractMesh).isPickable = false;
    }
  });

  const unsubscribeFire = input.onClick(0, () => {
    // Only fire while pointer is locked — clicking to lock the pointer
    // shouldn't also waste a bullet.
    if (!document.pointerLockElement) return;
    const hit = combatFire(weapon, scene);
    if (!hit) return;
    const target = enemyByMesh.get(hit.mesh);
    if (target) {
      const damage = weapon.stats.damage;
      target.takeDamage(damage);
      notifyHit({
        point: hit.point,
        mesh: hit.mesh,
        distance: hit.distance,
        damage,
      });
    }
  });

  // ---- HUD overlay ----
  // The HUD pulls live values from the player + active weapon every frame.
  // We thread the weapon through a closure so future weapon swaps (Phase 7
  // pickup-to-equip) just need to point this getter at the new instance.
  const hud = new Hud(scene, player, () => weapon);

  // Damage numbers are observable-driven off Combat.onHit; constructing
  // here is enough to subscribe. Lifecycle is owned by the dispose chain
  // below.
  const damageNumbers = new DamageNumbers(scene);

  // Minimap reads enemies + loot drops every frame and projects them onto
  // a circular GUI overlay top-right. Constructed after the HUD so the
  // ADT z-order naturally lands the minimap above the HUD bars.
  const minimap = new Minimap(scene, player, () => enemies, bounds);

  // Wire the wave indicator. setWaveState is called once eagerly so the
  // "idle" → "active" transition can't beat the HUD to the first frame.
  hud.setWaveState(spawner.state);
  spawner.onStateChange.add((s) => hud.setWaveState(s));

  // Gate wave 1 behind the StartScreen — no enemies spawn until the
  // player presses any key. The screen disposes itself on first keydown.
  const startScreen = new StartScreen(scene, () => {
    spawner.start();
  });

  // Death-screen state. The Player auto-respawns to full HP on takeDamage→0;
  // we use the onDied notification to overlay a YOU DIED screen with the
  // wave/kill summary, blocking gameplay perception until R restarts.
  let deathScreen: DeathScreen | null = null;
  let deathScreenActive = false;

  function restartGame(): void {
    for (const enemy of enemies) enemy.dispose();
    enemies.length = 0;
    enemyByMesh.clear();
    for (const drop of getActiveDrops()) disposeLoot(drop);
    spawner.reset();
    // Player auto-respawned already on death; teleporting + idempotent
    // respawn() guarantees a clean post-restart state regardless.
    player.respawn();
    player.rootMesh.position.copyFrom(spawnPoint);
    spawner.start();
  }

  player.onDied.add(() => {
    if (deathScreenActive) return;
    deathScreenActive = true;
    const wavesSurvived = Math.max(0, spawner.state.waveNumber - 1);
    deathScreen = new DeathScreen(scene, {
      wavesSurvived,
      totalKills: player.totalKills,
      onRestart: () => {
        restartGame();
        deathScreen = null;
        deathScreenActive = false;
      },
    });
  });

  // ---- Inventory UI ----
  // Equip + discard handlers are wired below; the inventory just bridges
  // UI clicks back to these. Re-equipping is async (Weapon.create awaits a
  // glTF load) so we serialize requests behind a Promise gate to avoid
  // double-spawning a weapon if the user spams E.
  let equipPending = false;

  async function equipFromInventory(
    item: InventoryItem,
    indexInInventory: number,
  ): Promise<void> {
    if (equipPending) return;
    equipPending = true;
    try {
      const removed = player.removeFromInventory(indexInInventory);
      if (!removed) return;

      const oldEquipped = player.equipped;

      // Drop old weapon at player's feet so the swap reads as "trade".
      // Anchor on ground so the loot beam sits flush.
      if (oldEquipped) {
        const dropPos = player.position.clone();
        dropPos.y = 0;
        spawnLoot(
          scene,
          dropPos,
          oldEquipped.stats,
          oldEquipped.rarity,
          oldEquipped.meshPath,
        );
      }

      // Tear down the old Weapon entity before building the new one so the
      // child meshes don't briefly stack on the same hand bone.
      weapon.dispose();

      weapon = await Weapon.create(
        scene,
        {
          stats: item.stats,
          rarity: item.rarity,
          meshPath: item.meshPath,
          displayName: item.displayName,
        },
        player.getRightHandTransform(),
      );

      player.setEquipped(item);
      inventory.refresh();
      persist();
      console.log(
        `[Arena] equipped ${RarityTier[item.rarity]} ${Archetype[item.archetype]}`,
        item.stats,
      );
    } finally {
      equipPending = false;
    }
  }

  function discardFromInventory(
    item: InventoryItem,
    indexInInventory: number,
  ): void {
    const removed = player.removeFromInventory(indexInInventory);
    if (!removed) return;
    const dropPos = player.position.clone();
    dropPos.y = 0;
    spawnLoot(scene, dropPos, item.stats, item.rarity, item.meshPath);
    inventory.refresh();
    persist();
    console.log(
      `[Arena] discarded ${RarityTier[item.rarity]} ${Archetype[item.archetype]}`,
    );
  }

  const inventory = new Inventory(
    scene,
    player,
    (item, idx) => {
      void equipFromInventory(item, idx);
    },
    discardFromInventory,
  );

  // Tab toggles the panel. We intercept the keydown so the browser's
  // default focus-shift behavior doesn't move focus off the canvas while
  // we're in the middle of a game session. Auto-repeat is filtered with
  // `e.repeat` so holding Tab doesn't strobe the panel open/closed.
  const tabKeyListener = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    if (e.repeat) return;
    inventory.toggle();
    if (inventory.isOpen()) {
      // Release pointer-lock so the cursor is free to click cards, and
      // suppress Player's canvas-click handler so clicking a card doesn't
      // drag focus back into mouse-look.
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
      player.setPointerLockSuppressed(true);
    } else {
      player.setPointerLockSuppressed(false);
    }
  };
  window.addEventListener("keydown", tabKeyListener);

  // ---- E key picks up nearest drop, R key reloads ----
  let eWasDown = false;
  let rWasDown = false;
  let xWasDown = false;

  // ---- per-frame tick ----
  const beforeRender = scene.onBeforeRenderObservable.add(() => {
    const dt = getDeltaSeconds(scene);
    if (dt <= 0) return;

    weapon.update(dt);
    spawner.update(dt);
    for (const e of enemies) {
      e.update(player, dt);
    }

    // Bounds clamp last so any late motion (Player.update via its own
    // observer) is contained. Babylon dispatches observers in registration
    // order; Player.init() registers first, so its update has already run
    // before this callback fires.
    player.clampToBounds(bounds);

    // E keypress edge — single fire on transition from up to down. E has
    // two meanings depending on inventory state: closed = pickup nearest
    // drop, open = equip currently-selected card. We never fire both
    // branches in the same edge.
    const eNow = input.isDown("e");
    if (eNow && !eWasDown) {
      if (inventory.isOpen()) {
        inventory.equipSelected();
      } else {
        const drop = nearestPickup(player);
        if (drop) {
          const entry = lookupWeaponEntryByMeshPath(drop.meshPath);
          if (!entry) {
            console.warn(
              `[Arena] LootDrop mesh ${drop.meshPath} not in catalogue — cannot pick up`,
            );
          } else {
            const item: InventoryItem = {
              stats: drop.weapon,
              archetype: entry.archetype,
              rarity: drop.rarity,
              meshPath: entry.meshPath,
              displayName: entry.displayName,
            };
            const added = player.addToInventory(item);
            if (added) {
              console.log(
                `[Arena] picked up ${RarityTier[drop.rarity]} ${Archetype[entry.archetype]}`,
                drop.weapon,
              );
              disposeLoot(drop);
              inventory.refresh();
              persist();
            } else {
              console.warn(
                "[Arena] inventory full — leaving loot drop in world",
              );
            }
          }
        }
      }
    }
    eWasDown = eNow;

    // X keypress edge — discard the selected card while inventory is open.
    const xNow = input.isDown("x");
    if (xNow && !xWasDown) {
      if (inventory.isOpen()) {
        inventory.discardSelected();
      }
    }
    xWasDown = xNow;

    // R keypress edge — kicks off a reload on the equipped weapon.
    const rNow = input.isDown("r");
    if (rNow && !rWasDown) {
      weapon.reload();
    }
    rWasDown = rNow;
  });

  // ---- teardown ----
  scene.onDisposeObservable.addOnce(() => {
    scene.onBeforeRenderObservable.remove(beforeRender);
    unsubscribeFire();
    window.removeEventListener("keydown", tabKeyListener);
    startScreen.dispose();
    deathScreen?.dispose();
    inventory.dispose();
    spawner.dispose();
    hud.dispose();
    minimap.dispose();
    damageNumbers.dispose();
    for (const e of enemies) e.dispose();
    weapon.dispose();
    player.dispose();
    input.dispose();
  });

  // Debug globals so the browser console can poke at scene state. Mirrors
  // the WeaponDemo dev hooks so manual testing (HUD verification, damage
  // routing) doesn't have to fight pointer-lock.
  if (import.meta.env.DEV) {
    const w = window as unknown as {
      __scene?: Scene;
      __player?: Player;
      __weapon?: Weapon;
      __hud?: Hud;
      __enemies?: Enemy[];
      __spawner?: WaveSpawner;
    };
    w.__scene = scene;
    w.__player = player;
    w.__weapon = weapon;
    w.__hud = hud;
    w.__enemies = enemies;
    w.__spawner = spawner;
  }

  return scene;
}

// -- helpers --

function pickRandom<T>(arr: readonly T[]): T {
  if (arr.length === 0) {
    throw new Error("Arena.pickRandom: empty array");
  }
  const idx = Math.floor(Math.random() * arr.length);
  const value = arr[idx];
  if (value === undefined) {
    throw new Error("Arena.pickRandom: index out of range");
  }
  return value;
}

/**
 * Walk a weighted rarity table once and pick a tier. Mirrors the LootDemo
 * helper so per-enemy weight tables (RARITY_WEIGHT / UFO_RARITY_WEIGHT) get
 * the same treatment.
 */
function rollRarityWeighted(
  weights: Record<RarityTier, number>,
): RarityTier {
  const tiers: RarityTier[] = [
    RarityTier.COMMON,
    RarityTier.UNCOMMON,
    RarityTier.RARE,
    RarityTier.EPIC,
    RarityTier.LEGENDARY,
  ];
  let total = 0;
  for (const t of tiers) total += weights[t];
  let pick = Math.random() * total;
  for (const t of tiers) {
    pick -= weights[t];
    if (pick <= 0) return t;
  }
  return RarityTier.COMMON;
}
