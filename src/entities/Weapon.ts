// Weapon — equippable weapon entity. Owns the loaded glTF/GLB mesh,
// parents it under the supplied right-hand TransformNode, tracks ammo +
// reload state, and produces visual fire effects (tracer line + brief
// muzzle flash). The actual raycast + damage logic lives in
// systems/Combat.ts so Weapon stays focused on "what is this gun, where
// is its barrel, how many bullets are left".
//
// Construction is async because we have to await the glTF load, so callers
// use `await Weapon.create(scene, cfg, rightHand)` rather than `new Weapon`.
//
// The weapon mesh is parented under the `parent` TransformNode passed in.
// In the normal flow that's `Player.getRightHandTransform()` — but the
// constructor doesn't care, which keeps WeaponDemo simple and lets future
// turrets / NPC weapons use the same class.

import "@babylonjs/loaders/glTF/index.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";

import { loadGLB } from "../utils/AssetLoader.js";
import type { WeaponStats } from "../data/WeaponArchetype.js";
import { RARITY_COLOR, type RarityTier } from "../data/Rarity.js";

export interface WeaponConfig {
  stats: WeaponStats;
  rarity: RarityTier;
  meshPath: string;
  displayName: string;
}

export interface FireResult {
  /** Origin (barrel tip) of the shot in world space. */
  origin: Vector3;
  /** Forward direction the shot was fired in. */
  direction: Vector3;
  /** Convenience Ray for downstream picking. */
  ray: Ray;
}

// Small lift+forward offset applied to the weapon mesh after it's parented
// under the right-hand transform. The Lis rig's wrist points roughly along
// the local +Z axis so the weapon sits forward of the palm; tweak via
// constants here if the rig changes.
const WEAPON_LOCAL_OFFSET = new Vector3(0, 0, 0.15);
const WEAPON_LOCAL_SCALE = 1.0;

// Distance ahead of the weapon root (in local space) where the muzzle
// "should" be. We never read the actual barrel from the glTF — the meshes
// don't expose a consistent barrel-tip node — so we approximate. The visual
// tracer + flash both originate from this offset.
const BARREL_LOCAL_OFFSET = new Vector3(0, 0, 0.6);

// Tracer visuals.
const TRACER_LIFETIME_MS = 200;
const TRACER_MAX_DISTANCE = 60;
const TRACER_COLOR_HOT = new Color3(1, 0.9, 0.4);

// Muzzle flash visuals — a tiny emissive sphere that briefly inflates.
// We avoid the full ParticleSystem here because a single-frame flash is
// indistinguishable visually and the sphere is one cheap draw call.
const MUZZLE_FLASH_LIFETIME_MS = 60;
const MUZZLE_FLASH_DIAMETER = 0.18;

export class Weapon {
  private readonly scene: Scene;
  private readonly cfg: WeaponConfig;
  private readonly container: AssetContainer;

  // Visual hierarchy:
  //   parent (right hand TN)
  //     └─ weaponRoot (local offset / scale)
  //         └─ glTF root (instantiated)
  //             └─ barrelMarker (TransformNode at BARREL_LOCAL_OFFSET)
  private readonly weaponRoot: TransformNode;
  private readonly barrelMarker: TransformNode;
  // We hold a reference to the visible muzzle-flash sphere so update() can
  // tick it down each frame. Reused across shots to avoid re-creating
  // material+geometry on every trigger pull.
  private readonly muzzleFlash: Mesh;
  private muzzleFlashRemainingMs = 0;

  private _ammo: number;
  private _isReloading = false;
  private reloadRemainingMs = 0;
  private cooldownRemainingMs = 0;

  // Active tracer cleanup queue. Each entry = (mesh, dispose-at-ms,
  // dispose-callback). Per-frame update fades alpha and disposes when due.
  private tracers: TracerEntry[] = [];

  private disposed = false;

  private constructor(
    scene: Scene,
    cfg: WeaponConfig,
    container: AssetContainer,
    weaponRoot: TransformNode,
    barrelMarker: TransformNode,
    muzzleFlash: Mesh,
  ) {
    this.scene = scene;
    this.cfg = cfg;
    this.container = container;
    this.weaponRoot = weaponRoot;
    this.barrelMarker = barrelMarker;
    this.muzzleFlash = muzzleFlash;
    this._ammo = cfg.stats.magazine;
  }

  /**
   * Async factory. Loads the weapon glTF, instantiates it, parents under
   * the supplied transform, and returns a ready-to-fire Weapon.
   *
   * If the load fails we throw — the caller gets the asset error directly.
   * Failure handling is intentionally not silent here because a missing
   * gun is a louder bug than a missing world-pickup mesh (LootDrop).
   */
  static async create(
    scene: Scene,
    cfg: WeaponConfig,
    parent: TransformNode,
  ): Promise<Weapon> {
    const container = await loadGLB(scene, cfg.meshPath);

    // Instantiate clones into the scene under our own root so dispose()
    // can tear everything down deterministically.
    const instance = container.instantiateModelsToScene(
      (n) => `weapon:${n}`,
      false,
      { doNotInstantiate: false },
    );

    const weaponRoot = new TransformNode("weaponRoot", scene);
    weaponRoot.parent = parent;
    weaponRoot.position.copyFrom(WEAPON_LOCAL_OFFSET);
    weaponRoot.scaling.setAll(WEAPON_LOCAL_SCALE);

    for (const node of instance.rootNodes) {
      node.parent = weaponRoot;
    }

    // Make every mesh under this weapon non-pickable so Combat's raycast
    // doesn't hit our own gun barrel and report a self-intersection.
    for (const mesh of instance.rootNodes) {
      const tnMesh = mesh as { getChildMeshes?: () => { isPickable: boolean }[] };
      const children = tnMesh.getChildMeshes?.() ?? [];
      for (const child of children) {
        child.isPickable = false;
      }
    }

    const barrelMarker = new TransformNode("weaponBarrelTip", scene);
    barrelMarker.parent = weaponRoot;
    barrelMarker.position.copyFrom(BARREL_LOCAL_OFFSET);

    const muzzleFlash = createMuzzleFlash(scene, cfg.rarity);
    muzzleFlash.parent = barrelMarker;
    muzzleFlash.isVisible = false;
    muzzleFlash.isPickable = false;

    return new Weapon(
      scene,
      cfg,
      container,
      weaponRoot,
      barrelMarker,
      muzzleFlash,
    );
  }

  // -- read-only state accessors --

  get stats(): WeaponStats {
    return this.cfg.stats;
  }

  get rarity(): RarityTier {
    return this.cfg.rarity;
  }

  get displayName(): string {
    return this.cfg.displayName;
  }

  get meshPath(): string {
    return this.cfg.meshPath;
  }

  get ammo(): number {
    return this._ammo;
  }

  get magazine(): number {
    return this.cfg.stats.magazine;
  }

  get isReloading(): boolean {
    return this._isReloading;
  }

  /**
   * Returns the world-space barrel tip position. Computed lazily because
   * Babylon's world matrix is only fresh after the parent's update — we
   * force-compute on access so callers can read a meaningful value any
   * time after the parent transform tree has been laid out.
   */
  getBarrelTipWorld(): Vector3 {
    this.barrelMarker.computeWorldMatrix(true);
    return this.barrelMarker.getAbsolutePosition().clone();
  }

  /**
   * Attempt to fire. Returns the ray (origin = barrel tip world, direction
   * = forward of the supplied camera or the weaponRoot's parent forward)
   * if the trigger pull succeeded, or null on out-of-ammo / reload / fire
   * cooldown. Spawns the visible tracer + muzzle flash on success.
   *
   * @param forwardWorldDirection - normalized world-space firing direction
   *        (caller-supplied so Combat.fire can use the camera's forward,
   *        which gives third-person hipfire that "shoots where you look")
   * @param hitPointWorld - if Combat picked a hit, pass it so the tracer
   *        ends there; otherwise pass null and we draw to TRACER_MAX_DISTANCE
   *        in the firing direction.
   */
  fire(
    forwardWorldDirection: Vector3,
    hitPointWorld: Vector3 | null,
  ): FireResult | null {
    if (this._isReloading) return null;
    if (this._ammo <= 0) return null;
    if (this.cooldownRemainingMs > 0) return null;

    this._ammo -= 1;

    // Per-shot cooldown derived from fireRate (shots/sec). 1/fireRate sec
    // between shots. Multiply by 1000 once for ms.
    const cooldownMs = (1 / Math.max(0.1, this.cfg.stats.fireRate)) * 1000;
    this.cooldownRemainingMs = cooldownMs;

    const origin = this.getBarrelTipWorld();
    const direction = forwardWorldDirection.clone().normalize();

    // End-point for the tracer is either the picked hit point or a far
    // point along the firing direction.
    const tracerEnd =
      hitPointWorld ?? origin.add(direction.scale(TRACER_MAX_DISTANCE));

    this.spawnTracer(origin, tracerEnd);
    this.flashMuzzle();

    const ray = new Ray(origin, direction, TRACER_MAX_DISTANCE);
    return { origin, direction, ray };
  }

  /**
   * Begin a reload cycle. No-op if we're already reloading or already
   * full. The reload completes after `stats.reloadTime` seconds elapse,
   * tracked by `update(dtSec)`.
   */
  reload(): void {
    if (this._isReloading) return;
    if (this._ammo >= this.cfg.stats.magazine) return;
    this._isReloading = true;
    this.reloadRemainingMs = this.cfg.stats.reloadTime * 1000;
  }

  /**
   * Per-frame tick. Drives reload countdown, fire-cooldown countdown, and
   * fades pending tracers / muzzle flash. Caller should pump this from
   * scene.onBeforeRenderObservable.
   */
  update(dtSec: number): void {
    if (this.disposed) return;
    if (dtSec <= 0) return;
    const dtMs = dtSec * 1000;

    if (this._isReloading) {
      this.reloadRemainingMs -= dtMs;
      if (this.reloadRemainingMs <= 0) {
        this.reloadRemainingMs = 0;
        this._ammo = this.cfg.stats.magazine;
        this._isReloading = false;
      }
    }

    if (this.cooldownRemainingMs > 0) {
      this.cooldownRemainingMs -= dtMs;
      if (this.cooldownRemainingMs < 0) this.cooldownRemainingMs = 0;
    }

    this.tickTracers(dtMs);
    this.tickMuzzleFlash(dtMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.tracers) {
      if (!t.mesh.isDisposed()) t.mesh.dispose();
    }
    this.tracers = [];
    if (!this.muzzleFlash.isDisposed()) this.muzzleFlash.dispose();
    this.barrelMarker.dispose();
    this.weaponRoot.dispose();
    this.container.dispose();
  }

  // -- internals --

  private spawnTracer(from: Vector3, to: Vector3): void {
    // Vertex-color line so we can fade alpha by per-vertex Color4 over
    // time — cheap and avoids spawning a unique material per tracer.
    const startColor = new Color4(
      TRACER_COLOR_HOT.r,
      TRACER_COLOR_HOT.g,
      TRACER_COLOR_HOT.b,
      1,
    );
    const endColor = new Color4(
      TRACER_COLOR_HOT.r,
      TRACER_COLOR_HOT.g,
      TRACER_COLOR_HOT.b,
      1,
    );
    const tracer = CreateLines(
      "weapon-tracer",
      {
        points: [from, to],
        colors: [startColor, endColor],
        useVertexAlpha: true,
        updatable: true,
      },
      this.scene,
    );
    tracer.color = TRACER_COLOR_HOT;
    tracer.isPickable = false;

    this.tracers.push({
      mesh: tracer,
      remainingMs: TRACER_LIFETIME_MS,
      points: [from, to],
    });
  }

  private flashMuzzle(): void {
    this.muzzleFlash.isVisible = true;
    this.muzzleFlash.scaling.setAll(1);
    this.muzzleFlashRemainingMs = MUZZLE_FLASH_LIFETIME_MS;
  }

  private tickTracers(dtMs: number): void {
    if (this.tracers.length === 0) return;
    const stillAlive: TracerEntry[] = [];
    for (const t of this.tracers) {
      t.remainingMs -= dtMs;
      if (t.remainingMs <= 0 || t.mesh.isDisposed()) {
        if (!t.mesh.isDisposed()) t.mesh.dispose();
        continue;
      }
      // Fade the line alpha proportional to remaining lifetime. Babylon's
      // LinesMesh respects mesh-level `alpha` because the material is the
      // ColorLineMaterial which honors vertex alpha + mesh alpha.
      const alpha = t.remainingMs / TRACER_LIFETIME_MS;
      t.mesh.alpha = alpha;
      stillAlive.push(t);
    }
    this.tracers = stillAlive;
  }

  private tickMuzzleFlash(dtMs: number): void {
    if (this.muzzleFlashRemainingMs <= 0) {
      if (this.muzzleFlash.isVisible) this.muzzleFlash.isVisible = false;
      return;
    }
    this.muzzleFlashRemainingMs -= dtMs;
    if (this.muzzleFlashRemainingMs <= 0) {
      this.muzzleFlash.isVisible = false;
      return;
    }
    // Inflate slightly toward the end of the lifetime so the flash reads
    // as a quick puff rather than a static ball.
    const t = 1 - this.muzzleFlashRemainingMs / MUZZLE_FLASH_LIFETIME_MS;
    const scale = 1 + t * 0.5;
    this.muzzleFlash.scaling.setAll(scale);
  }
}

interface TracerEntry {
  mesh: ReturnType<typeof CreateLines>;
  remainingMs: number;
  // Kept for potential future re-vertexing (e.g. recoil shake on tracer).
  points: Vector3[];
}

/**
 * Build a single-use emissive sphere to stand in for a particle muzzle
 * flash. The color is biased toward the rarity color so high-rarity guns
 * have a distinctive flash tint without us needing a per-rarity texture.
 */
function createMuzzleFlash(scene: Scene, rarity: RarityTier): Mesh {
  const sphere = MeshBuilder.CreateSphere(
    "weaponMuzzleFlash",
    { diameter: MUZZLE_FLASH_DIAMETER, segments: 8 },
    scene,
  );
  const mat = new StandardMaterial("weaponMuzzleFlashMat", scene);
  // Mix rarity color with hot-yellow so common-tier weapons still flash
  // bright and high-rarity weapons have a recognizable tint.
  const rarityColor = Color3.FromHexString(RARITY_COLOR[rarity]);
  const blend = new Color3(
    Math.min(1, rarityColor.r * 0.4 + 1 * 0.6),
    Math.min(1, rarityColor.g * 0.4 + 0.85 * 0.6),
    Math.min(1, rarityColor.b * 0.4 + 0.4 * 0.6),
  );
  mat.emissiveColor = blend;
  mat.diffuseColor = blend;
  mat.specularColor = new Color3(0, 0, 0);
  mat.disableLighting = true;
  sphere.material = mat;
  return sphere;
}
