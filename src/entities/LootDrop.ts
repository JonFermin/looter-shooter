// LootDrop — a world-pickup entity for a rolled weapon. Renders the weapon
// mesh on the ground beneath a tall, semi-transparent vertical light beam
// colored by the weapon's rarity (Borderlands palette). Mesh slowly rotates
// for visual flair.
//
// Construction is intentionally synchronous: the LootDrop is usable
// immediately (beam visible, position set), and the weapon mesh is loaded
// in the background and parented under the root anchor on resolution. This
// keeps `LootSystem.spawnLoot` non-async while still respecting the
// `loadGLB` Promise contract.

import type { Scene } from "@babylonjs/core/scene.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Nullable } from "@babylonjs/core/types.js";

import { loadGLB } from "../utils/AssetLoader.js";
import { getDeltaSeconds } from "../utils/time.js";
import { RARITY_COLOR, RarityTier } from "../data/Rarity.js";
import type { WeaponStats } from "../data/WeaponArchetype.js";

// Beam tuning. 4 units tall is enough to peek over the player and most
// cover props; the cone-shape (narrower at top, wider at base) sells the
// "spotlight from above" read without needing a real light source.
const BEAM_HEIGHT = 4;
const BEAM_DIAMETER_TOP = 0.3;
const BEAM_DIAMETER_BOTTOM = 0.6;
const BEAM_ALPHA = 0.5;

// Scale applied to the loaded weapon GLB so it reads as a hand-held
// pickup instead of a microscopic Kenney prop or a building-sized
// firearm. Both Kenney blasters (~1u) and Quaternius firearms (varies)
// look reasonable at 1.0 — we lift slightly off ground via Y offset.
const WEAPON_MESH_SCALE = 1.0;
const WEAPON_GROUND_OFFSET = 0.4;

// Per-second rotation around Y. Borderlands-y "drop is alive" feel.
const WEAPON_ROTATION_SPEED = 0.5;

export class LootDrop {
  private readonly scene: Scene;
  private readonly _weapon: WeaponStats;
  private readonly _rarity: RarityTier;
  private readonly weaponMeshPath: string;

  // Anchor node — owns world position. Beam + weapon mesh parent under it.
  private readonly root: TransformNode;
  private beam!: Mesh;
  private container?: AssetContainer;
  private weaponRoot?: TransformNode;

  private beforeRenderObserver: Nullable<Observer<Scene>> = null;
  private disposed = false;

  constructor(
    scene: Scene,
    position: Vector3,
    weapon: WeaponStats,
    rarity: RarityTier,
    weaponMeshPath: string,
  ) {
    this.scene = scene;
    this._weapon = weapon;
    this._rarity = rarity;
    this.weaponMeshPath = weaponMeshPath;

    this.root = new TransformNode("lootDropRoot", scene);
    this.root.position = position.clone();

    this.createBeam();
    this.startSpinObserver();

    // Fire-and-forget weapon mesh load. If it fails we keep the beam so
    // the drop is still visible and pickup-able.
    void this.loadWeaponMesh();
  }

  /** World position of the drop (clone — caller may not mutate). */
  get position(): Vector3 {
    return this.root.position.clone();
  }

  /** The rolled weapon stats this drop represents. */
  get weapon(): WeaponStats {
    return this._weapon;
  }

  /** Rarity tier of this drop — used for beam color + pickup readout. */
  get rarity(): RarityTier {
    return this._rarity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
      this.beforeRenderObserver = null;
    }
    this.weaponRoot?.dispose();
    this.weaponRoot = undefined;
    this.container?.dispose();
    this.container = undefined;
    this.beam?.dispose();
    this.root.dispose();
  }

  // -- internals --

  private createBeam(): void {
    // CreateCylinder with different top/bottom diameters yields a truncated
    // cone — narrower at the top reads as "beam shining down".
    const beam = MeshBuilder.CreateCylinder(
      "lootBeam",
      {
        height: BEAM_HEIGHT,
        diameterTop: BEAM_DIAMETER_TOP,
        diameterBottom: BEAM_DIAMETER_BOTTOM,
      },
      this.scene,
    );
    // Cylinder is centered on origin by default — lift so the bottom sits
    // at the drop's ground position.
    beam.position.y = BEAM_HEIGHT / 2;
    beam.parent = this.root;

    const mat = new StandardMaterial("lootBeamMat", this.scene);
    const hex = RARITY_COLOR[this._rarity];
    const color = Color3.FromHexString(hex);
    mat.emissiveColor = color;
    mat.diffuseColor = color;
    // Suppress specular highlights so the beam reads as a flat glowing
    // column instead of a shiny solid.
    mat.specularColor = new Color3(0, 0, 0);
    mat.alpha = BEAM_ALPHA;
    mat.backFaceCulling = false;
    beam.material = mat;
    // Beam should not block clicks/picks if anything ever ray-tests against
    // the scene — make it non-pickable.
    beam.isPickable = false;

    this.beam = beam;
  }

  private async loadWeaponMesh(): Promise<void> {
    try {
      this.container = await loadGLB(this.scene, this.weaponMeshPath);
      if (this.disposed) {
        this.container.dispose();
        this.container = undefined;
        return;
      }
      const instance = this.container.instantiateModelsToScene(
        (sourceName) => `lootDrop:${sourceName}`,
        false,
        { doNotInstantiate: false },
      );
      const firstRoot = instance.rootNodes[0];
      if (!firstRoot) {
        console.warn(
          `LootDrop: ${this.weaponMeshPath} produced no root nodes`,
        );
        return;
      }
      // Wrap in a TransformNode so we own the offset/scale without
      // fighting whatever transforms the export baked in.
      const wrapper = new TransformNode("lootDropWeapon", this.scene);
      firstRoot.parent = wrapper;
      wrapper.parent = this.root;
      wrapper.position = new Vector3(0, WEAPON_GROUND_OFFSET, 0);
      wrapper.scaling = new Vector3(
        WEAPON_MESH_SCALE,
        WEAPON_MESH_SCALE,
        WEAPON_MESH_SCALE,
      );
      this.weaponRoot = wrapper;
    } catch (err) {
      console.warn(`LootDrop: failed to load ${this.weaponMeshPath}:`, err);
    }
  }

  private startSpinObserver(): void {
    this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(() => {
      const dt = getDeltaSeconds(this.scene);
      if (dt <= 0) return;
      // Rotate only the weapon mesh — leaving the beam stationary keeps
      // the cone read clean (a spinning cone looks like noise).
      if (this.weaponRoot) {
        this.weaponRoot.rotation.y += dt * WEAPON_ROTATION_SPEED;
      }
    });
  }
}
