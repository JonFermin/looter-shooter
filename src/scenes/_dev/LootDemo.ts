// Dev-only sandbox for the LootDrop entity + LootSystem. Mirrors the
// public signature of `createGameScene` so swapping the import in main.ts
// is a one-line change.
//
// Controls:
//   WASD / Shift / Space — Player movement (inherited from Player.ts)
//   Mouse                — look (pointer-locks on canvas click)
//   G                    — spawn a new LootDrop with a random archetype
//                          and a weighted-random rarity
//   E                    — pick up the nearest drop within 2 units; logs
//                          the rolled stats and despawns the drop
//
// To use: in src/main.ts, replace
//   import { createGameScene } from "./scenes/Game.js";
//   const scene = await createGameScene(engine, canvas);
// with
//   import { createLootDemoScene as createGameScene } from
//     "./scenes/_dev/LootDemo.js";
// Revert before committing.

import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";

import { Player } from "../../entities/Player.js";
import { Input } from "../../input/Input.js";
import {
  spawnLoot,
  nearestPickup,
  dispose as disposeLoot,
} from "../../systems/LootSystem.js";
import { Archetype } from "../../data/WeaponArchetype.js";
import { RarityTier, RARITY_WEIGHT } from "../../data/Rarity.js";
import { rollWeapon } from "../../systems/StatRoll.js";

// All five archetypes are eligible. Demo cycles through them randomly so a
// few G-presses produce visual variety (different mesh, different color).
const ALL_ARCHETYPES: Archetype[] = [
  Archetype.PISTOL,
  Archetype.SMG,
  Archetype.RIFLE,
  Archetype.SHOTGUN,
  Archetype.BLASTER,
];

// Map archetype -> weapon mesh path. Quaternius firearms (Pistol/SMG/Rifle/
// Shotgun) are self-contained gltf+textures and render cleanly. The
// BLASTER bucket borrows a Kenney blaster — if its companion textures
// aren't yet copied (Phase 2 task #18), it'll render untextured-white but
// still demonstrates the spawn/pickup flow.
const ARCHETYPE_MESH_PATH: Record<Archetype, string> = {
  [Archetype.PISTOL]: "/assets/weapons/Pistol.gltf",
  [Archetype.SMG]: "/assets/weapons/SMG.gltf",
  [Archetype.RIFLE]: "/assets/weapons/Rifle.gltf",
  [Archetype.SHOTGUN]: "/assets/weapons/Shotgun.gltf",
  [Archetype.BLASTER]: "/assets/weapons/blaster-a.glb",
};

// Each subsequent G-press spawns a new drop slightly offset so they don't
// overlap. We track the count and arrange spawns on a small grid around
// the demo's center.
const SPAWN_BASE = new Vector3(5, 0, 5);
const SPAWN_OFFSET = 1.5;

export async function createLootDemoScene(
  engine: AbstractEngine,
  canvas: HTMLCanvasElement,
): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.12, 0.18, 1);

  // Lighting — same hemispheric + directional combo as Game.ts.
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.5;
  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.6), scene);
  sun.intensity = 0.8;
  sun.position = new Vector3(20, 30, 20);

  // 50x50 ground at y=0.
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: 50, height: 50, subdivisions: 1 },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.25, 0.45, 0.25);
  groundMat.specularColor = new Color3(0, 0, 0);
  ground.material = groundMat;

  // Shared input + player.
  const input = new Input();
  const player = new Player(scene, canvas, input);
  await player.init();

  // Per-demo state for the G/E one-shot key tracking.
  let gWasDown = false;
  let eWasDown = false;
  let spawnCount = 0;

  const observer = scene.onBeforeRenderObservable.add(() => {
    const gNow = input.isDown("g");
    if (gNow && !gWasDown) {
      handleSpawn();
    }
    gWasDown = gNow;

    const eNow = input.isDown("e");
    if (eNow && !eWasDown) {
      handlePickup();
    }
    eWasDown = eNow;
  });

  function handleSpawn(): void {
    const archetype = pickRandom(ALL_ARCHETYPES);
    const rarity = rollRarity();
    const stats = rollWeapon(archetype, rarity);
    const meshPath = ARCHETYPE_MESH_PATH[archetype];
    const position = stagger(spawnCount);
    spawnCount += 1;
    const drop = spawnLoot(scene, position, stats, rarity, meshPath);
    console.log("Spawned loot:", {
      archetype: Archetype[archetype],
      rarity: RarityTier[rarity],
      position: { x: position.x, y: position.y, z: position.z },
      stats,
      drop,
    });
  }

  function handlePickup(): void {
    const drop = nearestPickup(player);
    if (!drop) return;
    console.log("Picked up:", {
      rarity: RarityTier[drop.rarity],
      stats: drop.weapon,
    });
    disposeLoot(drop);
  }

  scene.onDisposeObservable.addOnce(() => {
    scene.onBeforeRenderObservable.remove(observer);
    player.dispose();
    input.dispose();
  });

  if (import.meta.env.DEV) {
    (window as unknown as { __scene?: Scene }).__scene = scene;
  }

  return scene;
}

// -- helpers --

function pickRandom<T>(arr: readonly T[]): T {
  if (arr.length === 0) {
    throw new Error("pickRandom: empty array");
  }
  const idx = Math.floor(Math.random() * arr.length);
  // noUncheckedIndexedAccess is on, so we narrow with a runtime guard.
  // arr.length > 0 is checked above so idx is in-bounds.
  const value = arr[idx];
  if (value === undefined) {
    throw new Error("pickRandom: index out of range");
  }
  return value;
}

// Weighted draw using RARITY_WEIGHT (50/25/15/8/2). Total is 100 but we
// derive the sum so future tweaks don't break.
function rollRarity(): RarityTier {
  const tiers: RarityTier[] = [
    RarityTier.COMMON,
    RarityTier.UNCOMMON,
    RarityTier.RARE,
    RarityTier.EPIC,
    RarityTier.LEGENDARY,
  ];
  let total = 0;
  for (const t of tiers) total += RARITY_WEIGHT[t];
  let pick = Math.random() * total;
  for (const t of tiers) {
    pick -= RARITY_WEIGHT[t];
    if (pick <= 0) return t;
  }
  return RarityTier.COMMON;
}

// Spread sequential spawns on a small 3x3 grid around SPAWN_BASE so the
// scene reads as multiple distinct drops, not a single overlapping pile.
function stagger(index: number): Vector3 {
  const col = index % 3;
  const row = Math.floor(index / 3) % 3;
  return new Vector3(
    SPAWN_BASE.x + (col - 1) * SPAWN_OFFSET,
    SPAWN_BASE.y,
    SPAWN_BASE.z + (row - 1) * SPAWN_OFFSET,
  );
}
