// Dev-only sandbox for the Enemy AI work (roadmap task #8). Mirrors the
// public signature of `createGameScene` so swapping the import in main.ts
// is a one-line change. Spawns the player on a flat ground, drops three
// zombie variants and a UFO around them, and wires the enemy update loop.
//
// To use: in src/main.ts, replace the `createGameScene` import with:
//   import { createEnemyDemoScene as createGameScene } from
//     "./scenes/_dev/EnemyDemo.js";
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
import { Enemy } from "../../entities/Enemy.js";
import { getDeltaSeconds } from "../../utils/time.js";

const ZOMBIE_BASIC_PATH = "/assets/characters/Zombie_Basic.gltf";
const ZOMBIE_CHUBBY_PATH = "/assets/characters/Zombie_Chubby.gltf";
const ZOMBIE_RIBCAGE_PATH = "/assets/characters/Zombie_Ribcage.gltf";
const UFO_PATH = "/assets/enemies/enemy-ufo-a.glb";

export async function createEnemyDemoScene(
  engine: AbstractEngine,
  canvas: HTMLCanvasElement,
): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.12, 0.18, 1);

  // -- lighting + ground -- (mirrors Game.ts so the demo reads the same).
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.55;
  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.6), scene);
  sun.intensity = 0.8;
  sun.position = new Vector3(20, 30, 20);

  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: 100, height: 100, subdivisions: 1 },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.25, 0.4, 0.25);
  groundMat.specularColor = new Color3(0, 0, 0);
  ground.material = groundMat;

  // -- player -- using the existing Player class for visual context.
  const input = new Input();
  const player = new Player(scene, canvas, input);
  await player.init();

  // -- enemies --
  // Each zombie variant uses the same Quaternius zombiekit clip set; the
  // visual difference comes from the model + scale tweak. Chubby is a hair
  // larger and slower, Ribcage a hair smaller and faster — gives the demo
  // some immediate variety without diverging the AI.
  const zombieBasic = await Enemy.create(scene, ZOMBIE_BASIC_PATH, {
    type: "zombie",
    position: new Vector3(5, 0, 5),
    speed: 3,
    detectionRadius: 15,
    attackRange: 2,
    attackCooldown: 1,
  });
  const zombieChubby = await Enemy.create(scene, ZOMBIE_CHUBBY_PATH, {
    type: "zombie",
    position: new Vector3(-5, 0, 5),
    speed: 2.2,
    detectionRadius: 15,
    attackRange: 2,
    attackCooldown: 1,
    scaling: 1.15,
  });
  const zombieRibcage = await Enemy.create(scene, ZOMBIE_RIBCAGE_PATH, {
    type: "zombie",
    position: new Vector3(0, 0, 8),
    speed: 3.6,
    detectionRadius: 15,
    attackRange: 2,
    attackCooldown: 1,
    scaling: 0.9,
  });

  // The Kenney UFO .glb references external textures that may not yet be
  // copied into public/assets/ (task #18 owns the asset-copy script fix).
  // Pass the 'ufoDisc' fallback so a procedural saucer renders if the glTF
  // load fails — keeps this demo functional independent of #18.
  const ufo = await Enemy.create(
    scene,
    UFO_PATH,
    {
      type: "ufo",
      position: new Vector3(0, 6, 12),
      hoverHeight: 6,
      fireInterval: 2,
      detectionRadius: 30,
      scaling: 2,
    },
    "ufoDisc",
  );

  const enemies: Enemy[] = [zombieBasic, zombieChubby, zombieRibcage, ufo];

  // Locate the player root mesh by name (Player wraps its glTF in a Mesh
  // called "playerRoot"). Doing this once and reusing the reference keeps
  // the per-frame loop allocation-free.
  const playerRoot = scene.getMeshByName("playerRoot");
  if (!playerRoot) {
    // Defensive: should never trigger because Player.init() ran above. We
    // surface a console error rather than crash so the dev sees the issue
    // in the overlay.
    console.error(
      "[EnemyDemo] playerRoot mesh missing — enemies will not chase.",
    );
  }
  const target = playerRoot ?? { position: Vector3.Zero() };

  // -- per-frame enemy tick --
  scene.onBeforeRenderObservable.add(() => {
    const dt = getDeltaSeconds(scene);
    if (dt <= 0) return;
    for (const e of enemies) {
      e.update(target, dt);
    }
  });

  // -- debug keybind: K damages the nearest non-dead enemy by 1000 (instant
  // death). Lets you visually verify the death tween + onDeath observable
  // without having to wire a weapon system into the demo.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "k" && e.key !== "K") return;
    let nearest: Enemy | null = null;
    let nearestSq = Infinity;
    for (const en of enemies) {
      if (en.isDead) continue;
      const dx = en.position.x - target.position.x;
      const dz = en.position.z - target.position.z;
      const dy = en.position.y - target.position.y;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < nearestSq) {
        nearestSq = d;
        nearest = en;
      }
    }
    if (nearest) {
      nearest.takeDamage(1000);
    }
  };
  window.addEventListener("keydown", onKeyDown);

  // Fire a one-time console log on each death so the dev can confirm the
  // observable wiring without opening the inspector.
  for (const e of enemies) {
    e.onDeath.addOnce((dead) => {
      console.log(`[EnemyDemo] enemy died: ${dead.type}`);
    });
    e.onAttack.add(({ enemy }) => {
      // Trim noise: log only zombies' attack swings.
      if (enemy.type === "zombie") {
        console.log(`[EnemyDemo] zombie attack swing`);
      }
    });
  }

  // -- teardown --
  scene.onDisposeObservable.addOnce(() => {
    window.removeEventListener("keydown", onKeyDown);
    player.dispose();
    input.dispose();
    for (const en of enemies) en.dispose();
  });

  if (import.meta.env.DEV) {
    (
      window as unknown as { __scene?: Scene; __enemies?: Enemy[] }
    ).__scene = scene;
    (
      window as unknown as { __scene?: Scene; __enemies?: Enemy[] }
    ).__enemies = enemies;
  }

  return scene;
}
