import "@babylonjs/core/Culling/ray.js";

import type { Scene } from "@babylonjs/core/scene.js";
import type { Bone } from "@babylonjs/core/Bones/bone.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import type { BoundingBox } from "@babylonjs/core/Culling/boundingBox.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Nullable } from "@babylonjs/core/types.js";

import { loadGLB } from "../utils/AssetLoader.js";
import { getDeltaSeconds } from "../utils/time.js";
import type { Input } from "../input/Input.js";
import type { InventoryItem } from "../data/InventoryItem.js";

const PLAYER_MESH_PATH = "/assets/characters/Characters_Lis_SingleWeapon.gltf";

// Hard cap on Player.inventory length. Phase 7 #13's AC asks for a 4×6 grid
// (24 slots); enforced here so callers can't sneak past the UI by going via
// the Player API.
export const INVENTORY_CAPACITY = 24;

const WALK_SPEED = 5; // units / second
const RUN_SPEED = 8; // units / second (shift-held)
const JUMP_VELOCITY = 9; // initial vy on jump
const GRAVITY = -25; // units / sec^2
const GROUND_Y = 0;

// Sensitivity in radians per pixel. Slightly lower than the old FollowCamera
// tuning because modern shoulder cams need precision around the reticle.
const MOUSE_YAW_RAD_PER_PIXEL = 0.0035;
const MOUSE_PITCH_RAD_PER_PIXEL = 0.0028;

// Over-the-shoulder third-person camera. Position stays mostly locked behind
// the player while pitch changes the aim direction, not the boom height, so
// mouse look feels like a shooter rather than an orbit camera.
const CAMERA_DISTANCE = 4.75;
const CAMERA_COLLISION_MIN_DISTANCE = 0.35;
const CAMERA_COLLISION_BUFFER = 0.15;
const CAMERA_FOV = 1.05;
const CAMERA_LOOK_AHEAD = 30;
const CAMERA_AIM_HEIGHT = 1.5;
const CAMERA_SHOULDER_OFFSET_X = 0.8;
const CAMERA_SHOULDER_OFFSET_Y = 0.35;
const CAMERA_PITCH_MIN = -Math.PI / 4;
const CAMERA_PITCH_MAX = Math.PI / 3;

// How fast (in 0..1 weight per second) the active animation group fades in
// while the others fade out, for crossfading. 6 -> ~166 ms blend.
const ANIM_BLEND_RATE = 6;

// Velocity thresholds (m/s) below/above which we pick idle vs walk vs run.
// Hysteresis isn't needed because crossfade smooths out the transition.
const WALK_THRESHOLD = 0.05;
const RUN_THRESHOLD = WALK_SPEED + 0.5;

type AnimState = "idle" | "walk" | "run" | "jump";

export class Player {
  private readonly scene: Scene;
  private readonly canvas: HTMLCanvasElement;
  private readonly input: Input;

  // Root anchor for the loaded character — receives translation + yaw
  // rotation. Implemented as a bare Mesh (no geometry, invisible) so that
  // gameplay systems can treat it as a concrete mesh for picking/filtering.
  private root!: Mesh;
  private camera!: FreeCamera;
  private container?: AssetContainer;
  private rightHandTransform!: TransformNode;

  // Animation groups keyed by intent. Always non-null after init() succeeds —
  // if a clip is missing we fall back to whichever group we did find.
  private animIdle?: AnimationGroup;
  private animWalk?: AnimationGroup;
  private animRun?: AnimationGroup;
  private animJump?: AnimationGroup;
  private allAnimGroups: AnimationGroup[] = [];

  private currentState: AnimState = "idle";

  // View yaw in radians. The player body tracks this directly so movement is
  // camera-relative and strafing keeps the crosshair aligned with the weapon.
  private yaw = 0;
  // Vertical look angle in radians. 0 = level, positive = aim up.
  private pitch = -0.12;

  private vy = 0;
  private grounded = true;
  private guitarHidden = false;
  // When true the canvas click listener stops requesting pointer-lock.
  // The Arena toggles this while the inventory panel is open so clicks on
  // inventory cards don't drag the camera back into mouse-look mode.
  private pointerLockSuppressed = false;

  // HP/respawn state. Settable spawn point so the Arena scene can position
  // the player at the courtyard center. takeDamage() clamps to 0 and triggers
  // respawn() which logs "you died", restores HP, and teleports back to
  // _spawnPoint without disturbing the equipped weapon (weapons are parented
  // to the bone TransformNode and travel with the player root).
  private _hp = 100;
  private _maxHp = 100;
  private _spawnPoint = new Vector3(0, 0, 0);

  // Shield: regenerating overshield that absorbs damage before HP. Drains
  // first on takeDamage(); overflow rolls into HP. Out-of-combat for
  // _shieldRegenDelay seconds re-engages the regen at _shieldRegenRate
  // points/sec until full. _timeSinceLastDamage resets to 0 every time the
  // player is hit so sustained pressure prevents regen.
  private _shield = 100;
  private _maxShield = 100;
  private readonly _shieldRegenRate = 5; // points/sec
  private readonly _shieldRegenDelay = 3; // sec out of combat before regen
  private _timeSinceLastDamage = 0;

  // Inventory + equipped weapon metadata. The actual Weapon entity (mesh,
  // ammo, fire timing) lives in the Arena scene closure — Player only owns
  // the data side so save/load can serialize it without touching scene
  // graphs. equipped mirrors whatever Arena currently has rendered as the
  // hand weapon; the Arena equip-flow keeps the two in sync.
  private _inventory: InventoryItem[] = [];
  private _equipped: InventoryItem | null = null;

  // Persisted across sessions via SaveLoad. Currency is a tracked counter
  // only in v1 (no spending UI yet); kills feed the future death-screen
  // summary and any "kills until next wave" HUD work.
  private _currency = 0;
  private _totalKills = 0;

  // Keep references so dispose() can detach/clean up.
  private beforeRenderObserver: Nullable<Observer<Scene>> = null;
  private clickListener?: () => void;
  private readonly flatForward = new Vector3(0, 0, 1);
  private readonly lookForward = new Vector3(0, 0, 1);
  private readonly right = new Vector3(1, 0, 0);
  private readonly aimOrigin = new Vector3();
  private readonly desiredCameraPosition = new Vector3();
  private readonly resolvedCameraPosition = new Vector3();
  private readonly cameraTarget = new Vector3();
  private readonly cameraRayDirection = new Vector3(0, 0, -1);
  private readonly cameraCollisionRay = new Ray(
    Vector3.Zero(),
    new Vector3(0, 0, -1),
    CAMERA_DISTANCE,
  );

  constructor(scene: Scene, canvas: HTMLCanvasElement, input: Input) {
    this.scene = scene;
    this.canvas = canvas;
    this.input = input;
  }

  /**
   * Async constructor helper. Loads the character glTF, instantiates it
   * into the scene, wires up the over-the-shoulder camera, and starts the
   * per-frame update loop. Call once after `new Player(...)`.
   */
  async init(): Promise<void> {
    this.container = await loadGLB(this.scene, PLAYER_MESH_PATH);

    const instance = this.container.instantiateModelsToScene(
      (sourceName) => sourceName,
      false,
      { doNotInstantiate: false },
    );

    // Pick the first root node as the player root. Quaternius models export
    // a single top-level node ("CharacterArmature" or similar) that owns
    // both the skeleton and the skinned mesh.
    const firstRoot = instance.rootNodes[0];
    if (!firstRoot) {
      throw new Error("Player.init: glTF produced no root nodes");
    }

    // Wrap in a clean Mesh anchor so we own translation/rotation without
    // fighting whatever transforms the export baked in. Bare Mesh has no
    // geometry, doesn't render, and gives downstream systems a concrete mesh
    // to filter against. Quaternius Lis exports facing +Z natively, matching
    // our convention (camera at -Z = behind, W = +Z forward), so no extra
    // rotation is applied here.
    const wrapper = new Mesh("playerRoot", this.scene);
    firstRoot.parent = wrapper;
    wrapper.rotationQuaternion = Quaternion.Identity();
    this.root = wrapper;

    this.collectAnimationGroups(instance.animationGroups);
    this.setupCamera();
    this.setupRightHandTransform(instance);
    this.setupPointerLockOnClick();

    // Ensure exactly one animation is playing at start.
    this.applyAnimState("idle", /*instant=*/ true);

    this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(() =>
      this.update(),
    );
  }

  /**
   * Returns a TransformNode that follows the right-hand bone every frame,
   * suitable for parenting weapons in Phase 4. We attach a TransformNode to
   * the bone via `attachToBone` — Babylon then drives its world matrix from
   * the bone's pose during animation.
   */
  getRightHandTransform(): TransformNode {
    return this.rightHandTransform;
  }

  /**
   * World-space position of the player root anchor. Returned as a live
   * reference (not a clone) — callers should treat it as read-only. Used by
   * downstream systems (LootSystem nearestPickup, weapon HUD, AI targeting)
   * that need the player's location without reaching through scene mesh
   * lookups.
   */
  get position(): Vector3 {
    return this.root.position;
  }

  /**
   * Public read-only accessor for the player's root Mesh. The Combat picking
   * predicate uses this to walk up the parent chain when checking whether
   * a hit mesh belongs to the player so we never self-hit. Also used for
   * weapon-mesh exclusion in shared scenes.
   */
  get rootMesh(): Mesh {
    return this.root;
  }

  /** Current hit points (0..maxHp). */
  get hp(): number {
    return this._hp;
  }

  /** Maximum hit points (constant for now; tuning will live in data later). */
  get maxHp(): number {
    return this._maxHp;
  }

  /** Current shield points (0..maxShield). Shields absorb damage before HP. */
  get shield(): number {
    return this._shield;
  }

  /** Maximum shield points. */
  get maxShield(): number {
    return this._maxShield;
  }

  /**
   * Where the player respawns when HP hits zero. Defaults to (0,0,0); the
   * Arena scene calls this with `Arena.spawnPoint` once buildArena resolves.
   * Stores a clone so external mutation of the supplied Vector3 doesn't drift
   * the spawn point under us.
   */
  setSpawnPoint(p: Vector3): void {
    this._spawnPoint = p.clone();
  }

  /**
   * Read-only view of the player's inventory (newest-first ordering is not
   * guaranteed; UI iterates by index 0..len). Returns the live array as a
   * readonly reference so the caller can iterate cheaply — mutations must
   * go through addToInventory / removeFromInventory.
   */
  get inventory(): readonly InventoryItem[] {
    return this._inventory;
  }

  /** Currently equipped weapon's metadata, or null if unarmed. */
  get equipped(): InventoryItem | null {
    return this._equipped;
  }

  /**
   * Append an item to the inventory. Returns false (and leaves the inventory
   * untouched) if we're already at INVENTORY_CAPACITY so the caller — Arena's
   * E-pickup handler — can leave the loot in the world for retry.
   */
  addToInventory(item: InventoryItem): boolean {
    if (this._inventory.length >= INVENTORY_CAPACITY) return false;
    this._inventory.push(item);
    return true;
  }

  /**
   * Remove and return the item at `index`. Returns null if the index is
   * out of bounds — the inventory UI delegates equip/discard through this
   * so an invalid selection doesn't crash the click handler.
   */
  removeFromInventory(index: number): InventoryItem | null {
    if (index < 0 || index >= this._inventory.length) return null;
    const [removed] = this._inventory.splice(index, 1);
    return removed ?? null;
  }

  /** Replace the equipped item. Pass null to clear (unarmed state). */
  setEquipped(item: InventoryItem | null): void {
    this._equipped = item;
  }

  /** Currency the player has accumulated across the session (and saves). */
  get currency(): number {
    return this._currency;
  }

  /** Lifetime kill counter. Persisted across reloads. */
  get totalKills(): number {
    return this._totalKills;
  }

  /**
   * Award currency to the player. Negative or zero amounts are no-ops so
   * callers (loot, quests) don't have to guard. There's no cap yet — Phase
   * 9's economy work will own balancing.
   */
  addCurrency(amount: number): void {
    if (amount <= 0) return;
    this._currency += amount;
  }

  /** Increment the lifetime kill counter by one. Called from Arena's enemy.onDeath. */
  addKill(): void {
    this._totalKills += 1;
  }

  /**
   * Restore persisted state. Replaces inventory, equipped, currency, and
   * totalKills wholesale. Does NOT touch HP/shield (those reset to max on
   * load via the existing init path). Called once during scene setup,
   * after init() but before the first frame, so the Player is fully
   * constructed when the data lands.
   */
  setSavedState(state: {
    inventory: InventoryItem[];
    equipped: InventoryItem | null;
    currency: number;
    totalKills: number;
  }): void {
    this._inventory = [...state.inventory];
    this._equipped = state.equipped;
    this._currency = state.currency;
    this._totalKills = state.totalKills;
  }

  /**
   * Toggle the canvas-click pointer-lock acquisition. The Arena calls this
   * when opening the inventory so clicking a card doesn't relock the
   * cursor (which would yank focus away from the menu). Closing the
   * inventory re-enables the normal click-to-lock behaviour.
   */
  setPointerLockSuppressed(suppress: boolean): void {
    this.pointerLockSuppressed = suppress;
  }

  /**
   * Apply incoming damage to the player. Shield absorbs first (1:1) and any
   * remainder spills into HP. Clamps HP at 0. When HP reaches 0 we trigger
   * an immediate respawn (no death animation yet — Phase 6 will own the
   * proper death state + UI). Damage values <= 0 are no-ops.
   *
   * Resets the out-of-combat regen timer to 0 every hit so sustained
   * pressure prevents shield from regenerating mid-fight.
   */
  takeDamage(amount: number): void {
    if (amount <= 0) return;
    if (this._hp <= 0) return; // already dead, mid-respawn; ignore
    this._timeSinceLastDamage = 0;
    const shieldHit = Math.min(this._shield, amount);
    this._shield -= shieldHit;
    const hpHit = amount - shieldHit;
    if (hpHit > 0) {
      this._hp = Math.max(0, this._hp - hpHit);
      if (this._hp === 0) {
        this.respawn();
      }
    }
  }

  /**
   * Restore full HP + shield and teleport back to the configured spawn
   * point. Also clears in-flight jump velocity / grounded state so the
   * player lands on the floor at the spawn rather than continuing a
   * previous arc, and resets the shield-regen cooldown so the next hit
   * after respawn doesn't regen instantly.
   */
  respawn(): void {
    console.log("you died");
    this._hp = this._maxHp;
    this._shield = this._maxShield;
    this._timeSinceLastDamage = 0;
    this.root.position.copyFrom(this._spawnPoint);
    this.vy = 0;
    this.grounded = true;
  }

  /**
   * Clamp the player's XZ position to the supplied bounding box. Y is left
   * alone so jumping still works. Called from the Arena scene's per-frame
   * loop after Player.update() so the player can't walk through perimeter
   * walls into the void.
   */
  clampToBounds(bounds: BoundingBox): void {
    const p = this.root.position;
    const min = bounds.minimumWorld;
    const max = bounds.maximumWorld;
    if (p.x < min.x) p.x = min.x;
    else if (p.x > max.x) p.x = max.x;
    if (p.z < min.z) p.z = min.z;
    else if (p.z > max.z) p.z = max.z;
  }

  /**
   * Hide the Lis rig's `Guitar` sub-mesh. The Quaternius "SingleWeapon"
   * variant of the character ships with a guitar prop attached — it's
   * visible by default and looks wrong once we attach a real weapon at the
   * right hand. Idempotent: safe to call repeatedly.
   *
   * We accept any mesh whose name matches /guitar/i (the export typically
   * names it "Guitar" but variants/skinned-mesh suffixes can creep in).
   * Hides the matching mesh AND every descendant so child geometry under
   * the guitar transform also disappears.
   */
  hideGuitarMesh(): void {
    if (this.guitarHidden) return;
    let hit = false;
    for (const mesh of this.scene.meshes) {
      // Only consider meshes that descend from this player's root so we
      // don't accidentally hide a guitar elsewhere in the scene.
      if (!mesh.isDescendantOf(this.root)) continue;
      if (!/guitar/i.test(mesh.name)) continue;
      mesh.isVisible = false;
      // Also hide any descendant meshes (multi-part guitars exist on some
      // Quaternius rigs — body + strings + head).
      for (const child of mesh.getChildMeshes()) {
        child.isVisible = false;
      }
      hit = true;
    }
    // Mark idempotent regardless of hit so callers don't re-scan every
    // frame even if the mesh was missing on this rig variant.
    this.guitarHidden = true;
    if (!hit) {
      // Quiet warning — keeps the demo clean if the guitar prop ever moves
      // to a different name in a future Quaternius export.
      console.warn(
        "[Player.hideGuitarMesh] no Guitar mesh found under playerRoot",
      );
    }
  }

  dispose(): void {
    if (this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
      this.beforeRenderObserver = null;
    }
    if (this.clickListener) {
      this.canvas.removeEventListener("click", this.clickListener);
      this.clickListener = undefined;
    }
    for (const g of this.allAnimGroups) {
      g.stop();
    }
    this.allAnimGroups = [];
    this.rightHandTransform?.dispose();
    this.camera?.dispose();
    this.root?.dispose();
    this.container?.dispose();
  }

  // -- internals --

  private collectAnimationGroups(groups: AnimationGroup[]): void {
    this.allAnimGroups = groups;
    // Stop everything first — instantiateModelsToScene auto-plays the first
    // group otherwise, which would briefly play "Death" (alphabetical first).
    for (const g of groups) {
      g.stop();
      g.setWeightForAllAnimatables(0);
    }
    const byName = new Map<string, AnimationGroup>();
    for (const g of groups) byName.set(g.name, g);

    // Quaternius Lis exposes plain "Idle"/"Walk"/"Run"/"Jump" plus weapon
    // variants. Prefer the unarmed clips for the base movement loop.
    this.animIdle = byName.get("Idle") ?? byName.get("Idle_Gun");
    this.animWalk = byName.get("Walk") ?? byName.get("Walk_Gun");
    this.animRun = byName.get("Run") ?? byName.get("Run_Gun");
    this.animJump = byName.get("Jump") ?? byName.get("Jump_Idle");
  }

  private setupCamera(): void {
    const camera = new FreeCamera(
      "playerShoulderCam",
      new Vector3(0, CAMERA_AIM_HEIGHT + CAMERA_SHOULDER_OFFSET_Y, -CAMERA_DISTANCE),
      this.scene,
    );
    camera.fov = CAMERA_FOV;
    camera.minZ = 0.1;

    // We don't call attachControl — the Player owns mouse look so camera aim,
    // movement, and combat reticle all stay in sync.
    this.scene.activeCamera = camera;
    this.camera = camera;
    this.syncRootRotation();
    this.updateCameraBasis();
    this.updateCamera();
  }

  // The Lis rig has no explicit "Hand.R" bone — the fingers parent directly
  // to LowerArm.R. We attach a TransformNode to LowerArm.R so weapons line
  // up at the wrist. If the rig changes, prefer "Hand.R" / "RightHand"
  // first.
  private setupRightHandTransform(instance: {
    skeletons: { bones: Bone[] }[];
  }): void {
    const tn = new TransformNode("playerRightHand", this.scene);

    const candidates = ["Hand.R", "RightHand", "Hand_R", "LowerArm.R"];
    let bone: Bone | undefined;
    for (const skel of instance.skeletons) {
      for (const candidate of candidates) {
        const found = skel.bones.find((b) => b.name === candidate);
        if (found) {
          bone = found;
          break;
        }
      }
      if (bone) break;
    }

    if (bone) {
      // attachToBone expects an associated mesh that owns the skeleton — we
      // can locate it via the skin's transform on the player root tree.
      const meshWithSkeleton = this.scene.meshes.find(
        (m) => m.skeleton && m.isDescendantOf(this.root),
      );
      if (meshWithSkeleton) {
        tn.attachToBone(bone, meshWithSkeleton);
      } else {
        // Fallback: parent under root so weapons at least follow the player
        // body, even if they don't track wrist motion.
        tn.parent = this.root;
      }
    } else {
      tn.parent = this.root;
    }
    this.rightHandTransform = tn;
  }

  private setupPointerLockOnClick(): void {
    this.clickListener = () => {
      if (this.pointerLockSuppressed) return;
      if (!document.pointerLockElement) {
        this.input.requestPointerLock(this.canvas);
      }
    };
    this.canvas.addEventListener("click", this.clickListener);
  }

  private update(): void {
    const dt = getDeltaSeconds(this.scene);
    if (dt <= 0) return;

    this.handleMouseLook();
    this.updateCameraBasis();
    this.syncRootRotation();
    const moved = this.handleMovement(dt);
    this.handleJumpAndGravity(dt);
    this.updateCamera();
    this.updateAnimationState(moved);
    this.crossfadeAnimations(dt);
    this.updateShield(dt);
  }

  /**
   * Tick the out-of-combat timer and regen shield once the delay has
   * elapsed. Regen rate is constant (linear); when shield reaches max it
   * stops being incremented but the timer keeps ticking harmlessly.
   */
  private updateShield(dt: number): void {
    this._timeSinceLastDamage += dt;
    if (
      this._timeSinceLastDamage >= this._shieldRegenDelay &&
      this._shield < this._maxShield
    ) {
      this._shield = Math.min(
        this._maxShield,
        this._shield + this._shieldRegenRate * dt,
      );
    }
  }

  private handleMouseLook(): void {
    const { dx, dy } = this.input.getMouseDelta();
    if (dx === 0 && dy === 0) return;
    // Negative dx so a rightward mouse move turns the view clockwise.
    this.yaw -= dx * MOUSE_YAW_RAD_PER_PIXEL;

    // Negative dy because moving the mouse up should look up.
    this.pitch -= dy * MOUSE_PITCH_RAD_PER_PIXEL;
    if (this.pitch < CAMERA_PITCH_MIN) this.pitch = CAMERA_PITCH_MIN;
    if (this.pitch > CAMERA_PITCH_MAX) this.pitch = CAMERA_PITCH_MAX;
  }

  private handleMovement(dt: number): boolean {
    const fwd = this.input.isDown("w") ? 1 : 0;
    const back = this.input.isDown("s") ? 1 : 0;
    const left = this.input.isDown("a") ? 1 : 0;
    const right = this.input.isDown("d") ? 1 : 0;
    const dz = fwd - back;
    const dx = right - left;

    if (dz === 0 && dx === 0) return false;

    // Modern TPS controls are camera-relative: W moves along the screen's
    // forward axis, A/D strafe using the camera's flattened right vector.
    let wx = this.right.x * dx + this.flatForward.x * dz;
    let wz = this.right.z * dx + this.flatForward.z * dz;
    const len = Math.hypot(wx, wz);
    if (len > 0) {
      wx /= len;
      wz /= len;
    }

    const running = this.input.isDown("shift");
    const speed = running ? RUN_SPEED : WALK_SPEED;

    this.root.position.x += wx * speed * dt;
    this.root.position.z += wz * speed * dt;
    return true;
  }

  private syncRootRotation(): void {
    const rotation = this.root.rotationQuaternion;
    if (!rotation) {
      this.root.rotationQuaternion = Quaternion.RotationYawPitchRoll(
        this.yaw,
        0,
        0,
      );
      return;
    }
    Quaternion.RotationYawPitchRollToRef(this.yaw, 0, 0, rotation);
  }

  private updateCameraBasis(): void {
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    const cosPitch = Math.cos(this.pitch);

    this.flatForward.set(sinYaw, 0, cosYaw);
    this.right.set(cosYaw, 0, -sinYaw);
    this.lookForward.set(
      sinYaw * cosPitch,
      Math.sin(this.pitch),
      cosYaw * cosPitch,
    );
  }

  private updateCamera(): void {
    this.aimOrigin.copyFrom(this.root.position);
    this.aimOrigin.y += CAMERA_AIM_HEIGHT;

    this.desiredCameraPosition.copyFrom(this.aimOrigin);
    this.desiredCameraPosition.x +=
      this.right.x * CAMERA_SHOULDER_OFFSET_X -
      this.flatForward.x * CAMERA_DISTANCE;
    this.desiredCameraPosition.y += CAMERA_SHOULDER_OFFSET_Y;
    this.desiredCameraPosition.z +=
      this.right.z * CAMERA_SHOULDER_OFFSET_X -
      this.flatForward.z * CAMERA_DISTANCE;

    this.resolveCameraCollision(
      this.aimOrigin,
      this.desiredCameraPosition,
      this.resolvedCameraPosition,
    );
    this.camera.position.copyFrom(this.resolvedCameraPosition);

    this.cameraTarget.copyFrom(this.aimOrigin);
    this.cameraTarget.x += this.lookForward.x * CAMERA_LOOK_AHEAD;
    this.cameraTarget.y += this.lookForward.y * CAMERA_LOOK_AHEAD;
    this.cameraTarget.z += this.lookForward.z * CAMERA_LOOK_AHEAD;
    this.camera.setTarget(this.cameraTarget);
  }

  private resolveCameraCollision(
    origin: Vector3,
    desired: Vector3,
    out: Vector3,
  ): void {
    const dx = desired.x - origin.x;
    const dy = desired.y - origin.y;
    const dz = desired.z - origin.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 1e-4) {
      out.copyFrom(desired);
      return;
    }

    const invDistance = 1 / distance;
    this.cameraRayDirection.set(
      dx * invDistance,
      dy * invDistance,
      dz * invDistance,
    );
    this.cameraCollisionRay.origin.copyFrom(origin);
    this.cameraCollisionRay.direction.copyFrom(this.cameraRayDirection);
    this.cameraCollisionRay.length = distance;

    const pick = this.scene.pickWithRay(this.cameraCollisionRay, (mesh) =>
      this.shouldCameraCollideWith(mesh),
    );
    if (!pick?.hit || pick.distance >= distance) {
      out.copyFrom(desired);
      return;
    }

    const safeDistance = Math.min(
      distance,
      Math.max(
        CAMERA_COLLISION_MIN_DISTANCE,
        pick.distance - CAMERA_COLLISION_BUFFER,
      ),
    );
    out.copyFrom(origin);
    out.x += this.cameraRayDirection.x * safeDistance;
    out.y += this.cameraRayDirection.y * safeDistance;
    out.z += this.cameraRayDirection.z * safeDistance;
  }

  private shouldCameraCollideWith(mesh: AbstractMesh): boolean {
    if (!mesh.isEnabled() || !mesh.isVisible) return false;
    if (mesh === this.root || mesh.isDescendantOf(this.root)) return false;
    if (mesh.name.startsWith("weapon")) return false;
    if (mesh.name.startsWith("lootBeam")) return false;
    if (mesh.name.startsWith("lootDrop")) return false;
    if (mesh.name.startsWith("enemy-")) return false;
    if (mesh.name.startsWith("ufo-tracer")) return false;
    return true;
  }

  private handleJumpAndGravity(dt: number): void {
    if (this.grounded && this.input.isDown(" ")) {
      this.vy = JUMP_VELOCITY;
      this.grounded = false;
    }
    if (!this.grounded) {
      this.vy += GRAVITY * dt;
      this.root.position.y += this.vy * dt;
      if (this.root.position.y <= GROUND_Y) {
        this.root.position.y = GROUND_Y;
        this.vy = 0;
        this.grounded = true;
      }
    }
  }

  private updateAnimationState(_moved: boolean): void {
    if (!this.grounded) {
      this.currentState = "jump";
      return;
    }
    // Approximate horizontal speed via WASD intent (cheap — no per-frame
    // delta math). Running flag bumps us into the "run" bucket.
    const fwd = this.input.isDown("w") ? 1 : 0;
    const back = this.input.isDown("s") ? 1 : 0;
    const left = this.input.isDown("a") ? 1 : 0;
    const right = this.input.isDown("d") ? 1 : 0;
    const intentMag = Math.hypot(fwd - back, right - left);
    const running = this.input.isDown("shift");
    const effectiveSpeed = intentMag === 0 ? 0 : running ? RUN_SPEED : WALK_SPEED;

    if (effectiveSpeed < WALK_THRESHOLD) {
      this.currentState = "idle";
    } else if (effectiveSpeed >= RUN_THRESHOLD) {
      this.currentState = "run";
    } else {
      this.currentState = "walk";
    }
  }

  private getActiveGroup(): AnimationGroup | undefined {
    switch (this.currentState) {
      case "idle":
        return this.animIdle;
      case "walk":
        return this.animWalk;
      case "run":
        return this.animRun;
      case "jump":
        return this.animJump ?? this.animIdle;
    }
  }

  private applyAnimState(state: AnimState, instant: boolean): void {
    this.currentState = state;
    if (instant) {
      const active = this.getActiveGroup();
      for (const g of this.allAnimGroups) {
        if (g === active) {
          g.start(true, 1.0);
          g.setWeightForAllAnimatables(1);
        } else {
          g.stop();
          g.setWeightForAllAnimatables(0);
        }
      }
    }
  }

  // Crossfade by ramping the active group's weight to 1 and the others' to
  // 0. Babylon plays all groups simultaneously; weights determine blend.
  private crossfadeAnimations(dt: number): void {
    const active = this.getActiveGroup();
    if (!active) return;
    if (!active.isPlaying) {
      active.start(true, 1.0);
    }
    const blend = Math.min(1, ANIM_BLEND_RATE * dt);
    for (const g of this.allAnimGroups) {
      const targetWeight = g === active ? 1 : 0;
      // Read current weight via the first animatable, fall back to 0/1 if
      // none are alive yet.
      const animatables = g.animatables;
      const cur = animatables[0]?.weight ?? (g === active ? 0 : 1);
      const next = cur + (targetWeight - cur) * blend;
      g.setWeightForAllAnimatables(next);
      if (next < 0.01 && g !== active && g.isPlaying) {
        g.stop();
        g.setWeightForAllAnimatables(0);
      } else if (g === active && !g.isPlaying) {
        g.start(true, 1.0);
      }
    }
  }
}
