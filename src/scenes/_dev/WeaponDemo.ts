// Dev-only sandbox for the Weapon entity + Combat system (roadmap task #7).
// Mirrors the public signature of `createGameScene` so swapping the import
// in main.ts is a one-line change.
//
// Controls:
//   WASD / Shift / Space — Player movement (inherited from Player.ts)
//   Mouse                — look (pointer-locks on canvas click)
//   Left-click           — fire weapon (raycasts from camera)
//   R                    — reload
//
// The demo rolls a single weapon at scene load (random archetype, weighted
// rarity), parents it under the player's right-hand transform, hides the
// guitar prop on the Lis rig, and shows ammo on a fullscreen ADT overlay.
//
// To use: in src/main.ts, replace the active scene import with:
//   import { createWeaponDemoScene as createGameScene } from
//     "./scenes/_dev/WeaponDemo.js";
// Revert before committing.

import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture.js";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";

import { Player } from "../../entities/Player.js";
import { Input } from "../../input/Input.js";
import { Weapon } from "../../entities/Weapon.js";
import { fire as combatFire } from "../../systems/Combat.js";
import { Archetype } from "../../data/WeaponArchetype.js";
import { RarityTier, RARITY_WEIGHT, RARITY_COLOR } from "../../data/Rarity.js";
import { rollWeapon } from "../../systems/StatRoll.js";
import { pickWeaponEntry } from "../../data/WeaponDatabase.js";
import { getDeltaSeconds } from "../../utils/time.js";

// Anything in here is "interesting target" for fire-test — a few low-poly
// dummy boxes around the spawn so the player can see tracers terminate on
// something. Picked colors that read distinctly against the green ground.
const TARGET_POSITIONS: { pos: Vector3; color: Color3 }[] = [
  { pos: new Vector3(0, 0.75, 8), color: new Color3(0.85, 0.3, 0.3) },
  { pos: new Vector3(4, 0.75, 8), color: new Color3(0.3, 0.4, 0.85) },
  { pos: new Vector3(-4, 0.75, 8), color: new Color3(0.85, 0.7, 0.3) },
  { pos: new Vector3(8, 0.75, 4), color: new Color3(0.6, 0.85, 0.3) },
];

export async function createWeaponDemoScene(
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
    { width: 50, height: 50, subdivisions: 1 },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.25, 0.4, 0.25);
  groundMat.specularColor = new Color3(0, 0, 0);
  ground.material = groundMat;

  // -- target dummies -- so tracer hits register on something visible.
  for (let i = 0; i < TARGET_POSITIONS.length; i++) {
    const t = TARGET_POSITIONS[i];
    if (!t) continue;
    const box = MeshBuilder.CreateBox(`target-${i}`, { size: 1.5 }, scene);
    box.position.copyFrom(t.pos);
    const mat = new StandardMaterial(`targetMat-${i}`, scene);
    mat.diffuseColor = t.color;
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    box.material = mat;
  }

  // -- player + input --
  const input = new Input();
  const player = new Player(scene, canvas, input);
  await player.init();

  // Hide the guitar prop on the Lis SingleWeapon rig now that we're about
  // to attach a real weapon.
  player.hideGuitarMesh();

  // -- weapon roll --
  const archetype = pickArchetype();
  const rarity = rollRarity();
  const stats = rollWeapon(archetype, rarity);
  const entry = pickWeaponEntry(archetype);

  const weapon = await Weapon.create(
    scene,
    {
      stats,
      rarity,
      meshPath: entry.meshPath,
      displayName: entry.displayName,
    },
    player.getRightHandTransform(),
  );

  console.log("[WeaponDemo] Equipped", {
    archetype: Archetype[archetype],
    rarity: RarityTier[rarity],
    displayName: entry.displayName,
    meshPath: entry.meshPath,
    stats,
  });

  // -- HUD overlay --
  const hud = AdvancedDynamicTexture.CreateFullscreenUI("hud", true, scene);

  const ammoText = new TextBlock("ammoText");
  ammoText.text = formatAmmo(weapon);
  ammoText.color = "#FFFFFF";
  ammoText.fontSize = 28;
  ammoText.fontFamily = "monospace";
  ammoText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
  ammoText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  ammoText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
  ammoText.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  ammoText.paddingRight = "24px";
  ammoText.paddingBottom = "24px";
  // Subtle text shadow for readability against bright ground/sky.
  ammoText.shadowColor = "#000000";
  ammoText.shadowOffsetX = 2;
  ammoText.shadowOffsetY = 2;
  ammoText.shadowBlur = 0;
  hud.addControl(ammoText);

  const weaponNameText = new TextBlock("weaponNameText");
  weaponNameText.text = `${entry.displayName} (${RarityTier[rarity]})`;
  weaponNameText.color = RARITY_COLOR[rarity];
  weaponNameText.fontSize = 18;
  weaponNameText.fontFamily = "monospace";
  weaponNameText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
  weaponNameText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  weaponNameText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
  weaponNameText.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  weaponNameText.paddingRight = "24px";
  weaponNameText.paddingBottom = "60px";
  weaponNameText.shadowColor = "#000000";
  weaponNameText.shadowOffsetX = 2;
  weaponNameText.shadowOffsetY = 2;
  hud.addControl(weaponNameText);

  // -- input wiring -- left-click to fire (one-shot per mouse-down event),
  // R held to reload.
  const removeFireHandler = input.onClick(0, () => {
    // Skip firing if the user just clicked to acquire pointer-lock — first
    // click of a session is consumed by the lock request. We detect "no
    // pointer lock" and bail; subsequent clicks fire normally.
    if (!document.pointerLockElement) return;
    const hit = combatFire(weapon, scene);
    if (hit) {
      console.log("[WeaponDemo] Hit", {
        mesh: hit.mesh.name,
        distance: hit.distance.toFixed(2),
        point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      });
    }
  });

  // R reload — debounce by tracking down/up edge so a held key fires once.
  let rWasDown = false;

  const tickObserver = scene.onBeforeRenderObservable.add(() => {
    const dt = getDeltaSeconds(scene);

    const rNow = input.isDown("r");
    if (rNow && !rWasDown) {
      weapon.reload();
    }
    rWasDown = rNow;

    weapon.update(dt);

    // HUD readout — refreshed every frame; cheap because GUI is a single
    // texture upload only when text changes.
    ammoText.text = formatAmmo(weapon);
  });

  // -- teardown --
  scene.onDisposeObservable.addOnce(() => {
    scene.onBeforeRenderObservable.remove(tickObserver);
    removeFireHandler();
    weapon.dispose();
    hud.dispose();
    player.dispose();
    input.dispose();
  });

  if (import.meta.env.DEV) {
    (
      window as unknown as {
        __scene?: Scene;
        __weapon?: Weapon;
        __player?: Player;
      }
    ).__scene = scene;
    (
      window as unknown as { __weapon?: Weapon }
    ).__weapon = weapon;
    (
      window as unknown as { __player?: Player }
    ).__player = player;
  }

  return scene;
}

// -- helpers --

function formatAmmo(weapon: Weapon): string {
  if (weapon.isReloading) {
    return `Ammo: -- / ${weapon.magazine}  (reloading)`;
  }
  return `Ammo: ${weapon.ammo} / ${weapon.magazine}`;
}

function pickArchetype(): Archetype {
  const all: Archetype[] = [
    Archetype.PISTOL,
    Archetype.SMG,
    Archetype.RIFLE,
    Archetype.SHOTGUN,
    Archetype.BLASTER,
  ];
  const idx = Math.floor(Math.random() * all.length);
  return all[idx] ?? Archetype.RIFLE;
}

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
