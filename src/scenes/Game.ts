import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";

export async function createGameScene(
  engine: AbstractEngine,
  canvas: HTMLCanvasElement,
): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.1, 0.18, 1);

  // Camera
  const camera = new ArcRotateCamera(
    "camera",
    Math.PI / 4,
    Math.PI / 3,
    8,
    Vector3.Zero(),
    scene,
  );
  camera.attachControl(canvas, true);

  // Lighting
  const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.8;

  // Geometry — smoke-test box
  MeshBuilder.CreateBox("box", { size: 1 }, scene);

  return scene;
}
