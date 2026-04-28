import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";

import { Player } from "../entities/Player.js";
import { Input } from "../input/Input.js";

export async function createGameScene(
  engine: AbstractEngine,
  canvas: HTMLCanvasElement,
): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.12, 0.18, 1);

  // Lighting — hemispheric for cheap ambient + a directional sun for shape.
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.5;
  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.6), scene);
  sun.intensity = 0.8;
  sun.position = new Vector3(20, 30, 20);

  // Ground — flat 50x50 plane at y=0. Using DOUBLESIDE-equivalent isn't
  // necessary because the camera stays above; default single-sided is fine.
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: 50, height: 50, subdivisions: 1 },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.25, 0.45, 0.25);
  groundMat.specularColor = new Color3(0, 0, 0);
  ground.material = groundMat;

  // Wire up shared input + player.
  const input = new Input();
  const player = new Player(scene, canvas, input);
  await player.init();

  // Tear down with the scene so HMR doesn't leak listeners.
  scene.onDisposeObservable.addOnce(() => {
    player.dispose();
    input.dispose();
  });

  // Debug-only window hook so smoke tests / browser console can inspect
  // scene state. Costs nothing in prod (v8 inlines the no-op condition for
  // import.meta.env.DEV at build time).
  if (import.meta.env.DEV) {
    (window as unknown as { __scene?: Scene }).__scene = scene;
  }

  return scene;
}
