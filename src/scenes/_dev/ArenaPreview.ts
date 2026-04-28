// Dev-only preview entry for the Settlement Arena. Mirrors the public
// signature of `createGameScene` so swapping the import in main.ts is
// a one-line change. Sets up an orbit camera, basic lighting, a dark
// ground plane for visual context, then awaits buildArena().
//
// To use: in src/main.ts, replace
//   import { createGameScene } from "./scenes/Game.js";
//   const scene = await createGameScene(engine, canvas);
// with
//   import { createArenaPreviewScene } from "./scenes/_dev/ArenaPreview.js";
//   const scene = await createArenaPreviewScene(engine, canvas);
// Revert before committing.

import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { buildArena } from "../Arena.js";

export async function createArenaPreviewScene(
  engine: AbstractEngine,
  canvas: HTMLCanvasElement,
): Promise<Scene> {
  const scene = new Scene(engine);
  // Wasteland sky color — slightly desaturated dusk so cover props read
  // against the background.
  scene.clearColor = new Color4(0.18, 0.16, 0.2, 1);

  // Orbit camera — radius 50 puts the whole 50x50 courtyard in frame
  // from a low-angle aerial perspective. alpha = -PI/2 looks "north"
  // along +Z, beta = PI/3 sits well above the deck.
  const camera = new ArcRotateCamera(
    "preview-camera",
    -Math.PI / 2,
    Math.PI / 3,
    50,
    Vector3.Zero(),
    scene,
  );
  camera.attachControl(canvas, true);
  // Allow zooming in close enough to inspect prop scale and out far
  // enough to see all four building shells outside the perimeter.
  camera.lowerRadiusLimit = 5;
  camera.upperRadiusLimit = 120;
  camera.wheelDeltaPercentage = 0.01;

  // Hemispheric ambient — top-down sky/ground colors keep dark sides
  // of meshes from reading as solid black.
  const ambient = new HemisphericLight(
    "ambient",
    new Vector3(0, 1, 0),
    scene,
  );
  ambient.intensity = 0.55;
  ambient.groundColor = new Color3(0.18, 0.15, 0.12);

  // Directional sun — angled so courtyard cover props cast distinct
  // shadows on the ground (shadow generator can be added later;
  // unlit-style preview is fine for this milestone).
  const sun = new DirectionalLight(
    "sun",
    new Vector3(-0.4, -1, -0.6).normalize(),
    scene,
  );
  sun.intensity = 0.9;

  // Ground plane — 60x60 dark gray, slightly larger than the courtyard
  // so the perimeter walls have visible footing. Set to single-sided
  // (default), camera stays above so backface culling is fine.
  const ground = MeshBuilder.CreateGround(
    "preview-ground",
    { width: 60, height: 60 },
    scene,
  );
  const groundMat = new StandardMaterial("preview-ground-mat", scene);
  groundMat.diffuseColor = new Color3(0.22, 0.2, 0.18);
  groundMat.specularColor = new Color3(0, 0, 0);
  ground.material = groundMat;

  await buildArena(scene);

  return scene;
}
