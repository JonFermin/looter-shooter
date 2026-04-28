// Centralized glTF/GLB loader. The side-effect import below is required for
// SceneLoader to recognize the .gltf/.glb extensions — forgetting it is the
// #1 silent-failure mode (see AI_RULES.md "Black-Screen Debugging Checklist").
// We import it here so any consumer of loadGLB gets the registration
// automatically; main.ts also imports it but this util stays self-contained.
import "@babylonjs/loaders/glTF/index.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer.js";

/**
 * Load a glTF or GLB into an AssetContainer without instantiating it into the
 * scene. Caller decides when to `addAllToScene()` or instantiate clones.
 *
 * @param scene - target Babylon scene
 * @param path - public-relative URL, e.g. "/assets/weapons/blaster-a.glb"
 */
export function loadGLB(scene: Scene, path: string): Promise<AssetContainer> {
  return LoadAssetContainerAsync(path, scene);
}
