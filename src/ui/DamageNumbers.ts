// DamageNumbers — transient floating damage numbers spawned at world-space
// hit points. Subscribes to `Combat.onHit`; for each event it builds a
// camera-facing billboard plane with a per-instance DynamicTexture showing
// the damage value in Borderlands-yellow with a black outline, then drifts
// the plane upward and fades its alpha to zero over BILLBOARD_LIFETIME_S.
//
// One DynamicTexture per billboard is intentional: we draw each number
// once at spawn, never again. AdvancedDynamicTexture in WORLD_SPACE would
// pull in the GUI runtime for what is essentially a static raster, so the
// DT-on-plane path is both lighter and matches the existing texture
// pipeline (LootDrop uses the same approach for rarity beams).

// DynamicTexture.update() routes through engine.createDynamicTexture /
// engine.updateDynamicTexture, registered by these side-effect imports
// (one for WebGL, one for WebGPU). Hud.ts already imports them but
// DamageNumbers is constructed independently — keeping the imports here
// makes the module self-contained against future load-order changes.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js";

import type { Scene } from "@babylonjs/core/scene.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Nullable } from "@babylonjs/core/types.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";

import { onHit, type HitEvent } from "../systems/Combat.js";
import { getDeltaSeconds } from "../utils/time.js";

const BILLBOARD_LIFETIME_S = 0.8;
const BILLBOARD_DRIFT_UP = 1.5;
const BILLBOARD_SPAWN_OFFSET_Y = 1.0;
// Source canvas is intentionally larger than the world-space plane so the
// rasterized text stays crisp under camera zoom. The plane is sized in
// world units (PLANE_WIDTH x PLANE_HEIGHT) and the texture is sampled
// linearly onto it.
const TEXTURE_WIDTH_PX = 256;
const TEXTURE_HEIGHT_PX = 128;
const PLANE_WIDTH = 1.5;
const PLANE_HEIGHT = 0.75;
const FONT = "bold 64px monospace";
const FILL_COLOR = "#ffd400";
const OUTLINE_COLOR = "#000000";
const OUTLINE_WIDTH_PX = 6;

interface ActiveBillboard {
  mesh: Mesh;
  texture: DynamicTexture;
  material: StandardMaterial;
  ageSeconds: number;
  startY: number;
}

export class DamageNumbers {
  private readonly scene: Scene;
  private readonly active: ActiveBillboard[] = [];
  private hitObserver: Nullable<Observer<HitEvent>> = null;
  private updateObserver: Nullable<Observer<Scene>> = null;
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;

    this.hitObserver = onHit.add((event) => this.spawn(event));
    this.updateObserver = scene.onBeforeRenderObservable.add(() => {
      this.update();
    });

    scene.onDisposeObservable.addOnce(() => this.dispose());
  }

  private spawn(event: HitEvent): void {
    if (this.disposed) return;

    const text = String(Math.round(event.damage));

    const texture = new DynamicTexture(
      "damageNumber",
      { width: TEXTURE_WIDTH_PX, height: TEXTURE_HEIGHT_PX },
      this.scene,
      false,
    );
    texture.hasAlpha = true;
    drawNumber(texture, text);

    const material = new StandardMaterial("damageNumberMat", this.scene);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = new Color3(1, 1, 1);
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;

    const plane = MeshBuilder.CreatePlane(
      "damageNumber",
      { width: PLANE_WIDTH, height: PLANE_HEIGHT },
      this.scene,
    );
    plane.material = material;
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    // Billboards must render above geometry — a literal hit on a wall would
    // otherwise paint the number behind the wall mesh from many camera
    // angles. Disabling depth + bumping renderingGroupId puts them in the
    // overlay pass.
    plane.renderingGroupId = 1;
    material.disableDepthWrite = true;

    const spawnPos = event.point.clone();
    spawnPos.y += BILLBOARD_SPAWN_OFFSET_Y;
    plane.position.copyFrom(spawnPos);

    this.active.push({
      mesh: plane,
      texture,
      material,
      ageSeconds: 0,
      startY: spawnPos.y,
    });
  }

  private update(): void {
    if (this.disposed) return;
    const dt = getDeltaSeconds(this.scene);
    if (dt <= 0) return;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const bb = this.active[i];
      if (!bb) continue;
      bb.ageSeconds += dt;
      const t = bb.ageSeconds / BILLBOARD_LIFETIME_S;
      if (t >= 1) {
        this.disposeBillboard(bb);
        this.active.splice(i, 1);
        continue;
      }
      bb.mesh.position.y = bb.startY + BILLBOARD_DRIFT_UP * t;
      bb.material.alpha = 1 - t;
    }
  }

  private disposeBillboard(bb: ActiveBillboard): void {
    bb.mesh.dispose();
    bb.material.dispose();
    bb.texture.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.hitObserver) {
      onHit.remove(this.hitObserver);
      this.hitObserver = null;
    }
    if (this.updateObserver) {
      this.scene.onBeforeRenderObservable.remove(this.updateObserver);
      this.updateObserver = null;
    }
    for (const bb of this.active) this.disposeBillboard(bb);
    this.active.length = 0;
  }
}

function drawNumber(texture: DynamicTexture, text: string): void {
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, TEXTURE_WIDTH_PX, TEXTURE_HEIGHT_PX);
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  const cx = TEXTURE_WIDTH_PX / 2;
  const cy = TEXTURE_HEIGHT_PX / 2;

  ctx.lineWidth = OUTLINE_WIDTH_PX;
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.strokeText(text, cx, cy);

  ctx.fillStyle = FILL_COLOR;
  ctx.fillText(text, cx, cy);

  texture.update(false);
}
