import type { Scene } from "@babylonjs/core/scene.js";
import type { Bone } from "@babylonjs/core/Bones/bone.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { FollowCamera } from "@babylonjs/core/Cameras/followCamera.js";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Nullable } from "@babylonjs/core/types.js";

import { loadGLB } from "../utils/AssetLoader.js";
import { getDeltaSeconds } from "../utils/time.js";
import type { Input } from "../input/Input.js";

const PLAYER_MESH_PATH = "/assets/characters/Characters_Lis_SingleWeapon.gltf";

const WALK_SPEED = 5; // units / second
const RUN_SPEED = 8; // units / second (shift-held)
const JUMP_VELOCITY = 9; // initial vy on jump
const GRAVITY = -25; // units / sec^2
const GROUND_Y = 0;

// Sensitivity in degrees of camera yaw per pixel of mouse-X movement, and
// degrees of camera pitch per pixel of mouse-Y. Tuned for a 1080p canvas.
const MOUSE_YAW_DEG_PER_PIXEL = 0.2;
const MOUSE_PITCH_PER_PIXEL = 0.005;

// FollowCamera tuning. radius = how far behind the player; heightOffset =
// how high above the player; rotationOffset is in *degrees*. The
// acceleration values control how quickly the camera catches up.
const CAMERA_RADIUS = 6;
const CAMERA_HEIGHT_MIN = 1.5;
const CAMERA_HEIGHT_MAX = 5;
const CAMERA_HEIGHT_DEFAULT = 2.5;
const CAMERA_ROT_ACCEL = 0.05;
const CAMERA_HEIGHT_ACCEL = 0.05;
const CAMERA_RADIUS_ACCEL = 0.05;
const CAMERA_MAX_ROT_SPEED = 1000;
const CAMERA_MAX_HEIGHT_SPEED = 50;
const CAMERA_MAX_RADIUS_SPEED = 50;

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
  // FollowCamera.lockedTarget can accept it (lockedTarget requires an
  // AbstractMesh, not a TransformNode).
  private root!: Mesh;
  private camera!: FollowCamera;
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

  // Yaw of the player root in radians. Driven by mouse-X while pointer is
  // locked. Camera trails behind by mirroring this onto rotationOffset.
  private yaw = 0;
  // Camera pitch in radians (vertical look). Translated into heightOffset
  // by mapping pitch range -> height range so FollowCamera handles the rest.
  private pitch = 0.4; // ~23 deg above horizontal — looking slightly down

  private vy = 0;
  private grounded = true;
  private guitarHidden = false;

  // Keep references so dispose() can detach/clean up.
  private beforeRenderObserver: Nullable<Observer<Scene>> = null;
  private clickListener?: () => void;

  constructor(scene: Scene, canvas: HTMLCanvasElement, input: Input) {
    this.scene = scene;
    this.canvas = canvas;
    this.input = input;
  }

  /**
   * Async constructor helper. Loads the character glTF, instantiates it
   * into the scene, wires up the FollowCamera, and starts the per-frame
   * update loop. Call once after `new Player(...)`.
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
    // geometry, doesn't render, but satisfies FollowCamera.lockedTarget's
    // AbstractMesh requirement.
    const wrapper = new Mesh("playerRoot", this.scene);
    firstRoot.parent = wrapper;
    // Quaternius Lis exports facing -Z; rotate 180° so the model faces +Z
    // (camera-forward when yaw=0). rootNodes[0] is typed as Node, so we
    // narrow to TransformNode before calling rotate.
    if (firstRoot instanceof TransformNode) {
      firstRoot.rotate(Vector3.Up(), Math.PI);
    }
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
    // FollowCamera orbits a target every frame, smoothly catching up. We
    // rotate around the player by setting `rotationOffset` (degrees).
    const startTarget = new Vector3(0, 1.5, 0);
    const camera = new FollowCamera(
      "playerFollowCam",
      startTarget.add(new Vector3(0, CAMERA_HEIGHT_DEFAULT, -CAMERA_RADIUS)),
      this.scene,
    );
    camera.radius = CAMERA_RADIUS;
    camera.heightOffset = CAMERA_HEIGHT_DEFAULT;
    camera.rotationOffset = 180; // start behind the player
    camera.cameraAcceleration = CAMERA_ROT_ACCEL;
    camera.maxCameraSpeed = CAMERA_MAX_ROT_SPEED;
    // Babylon FollowCamera also exposes the lerp params on inherited
    // TargetCamera under different names; the public ones above are all we
    // need. Quaternions on the target work fine for follow.
    camera.lockedTarget = this.root;
    // Constrain pitch via the constants above.
    camera.minZ = 0.1;

    // We don't call attachControl — we drive the camera ourselves via the
    // mouse delta from Input. Babylon's default FollowCamera input would
    // fight us otherwise.
    this.scene.activeCamera = camera;
    this.camera = camera;

    // Apply initial pitch.
    this.applyPitchToCamera();

    // Cast to silence the unused TS hint for CAMERA_*_ACCEL constants on
    // FollowCamera without `cameraHeightAcceleration`/`maxHeightSpeed`
    // (those exist on ArcFollowCamera, not FollowCamera). We keep the
    // constants here for documentation; if Babylon adds height-acc later we
    // can wire them up.
    void CAMERA_HEIGHT_ACCEL;
    void CAMERA_RADIUS_ACCEL;
    void CAMERA_MAX_HEIGHT_SPEED;
    void CAMERA_MAX_RADIUS_SPEED;
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
    const moved = this.handleMovement(dt);
    this.handleJumpAndGravity(dt);
    this.updateAnimationState(moved);
    this.crossfadeAnimations(dt);
  }

  private handleMouseLook(): void {
    const { dx, dy } = this.input.getMouseDelta();
    if (dx === 0 && dy === 0) return;
    // Yaw: spin the player root, which the camera follows via lockedTarget.
    // Negative dx so a rightward mouse move spins the player clockwise (and
    // therefore the camera orbits to look from the right).
    this.yaw -= dx * MOUSE_YAW_DEG_PER_PIXEL * (Math.PI / 180);
    // Apply yaw as a quaternion to avoid Euler order surprises.
    this.root.rotationQuaternion = Quaternion.RotationYawPitchRoll(
      this.yaw,
      0,
      0,
    );

    // Pitch: clamped vertical look. Negative dy because moving the mouse up
    // should look up.
    this.pitch -= dy * MOUSE_PITCH_PER_PIXEL;
    // Clamp to roughly -45..+60 degrees of pitch.
    const minPitch = -Math.PI / 4;
    const maxPitch = Math.PI / 3;
    if (this.pitch < minPitch) this.pitch = minPitch;
    if (this.pitch > maxPitch) this.pitch = maxPitch;

    this.applyPitchToCamera();
  }

  private applyPitchToCamera(): void {
    // Map pitch [-PI/4 .. PI/3] -> heightOffset [MIN .. MAX]. Higher pitch
    // (looking up) raises the camera so we look down on the player.
    const t =
      (this.pitch + Math.PI / 4) / (Math.PI / 3 + Math.PI / 4); // 0..1
    this.camera.heightOffset =
      CAMERA_HEIGHT_MIN + t * (CAMERA_HEIGHT_MAX - CAMERA_HEIGHT_MIN);
  }

  private handleMovement(dt: number): boolean {
    const fwd = this.input.isDown("w") ? 1 : 0;
    const back = this.input.isDown("s") ? 1 : 0;
    const left = this.input.isDown("a") ? 1 : 0;
    const right = this.input.isDown("d") ? 1 : 0;
    const dz = fwd - back;
    const dx = right - left;

    if (dz === 0 && dx === 0) return false;

    // Movement is relative to the player's facing (which is locked to yaw).
    // Forward = +Z when yaw=0; rotate by yaw to get world-space direction.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = dx * cos + dz * sin;
    let wz = -dx * sin + dz * cos;
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
