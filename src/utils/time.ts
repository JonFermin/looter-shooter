import type { Scene } from "@babylonjs/core/scene.js";

export function getDeltaSeconds(scene: Scene): number {
  return scene.getEngine().getDeltaTime() / 1000;
}
