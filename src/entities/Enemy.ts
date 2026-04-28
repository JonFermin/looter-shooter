// Enemy entity covering both ground zombies and the UFO flyer. Handles the
// IDLE -> CHASE -> ATTACK -> DEAD lifecycle, animation crossfading, and the
// death sink-and-fade tween. The Demo / Game scene calls `update()` from its
// own per-frame loop so we don't fight Player's existing onBeforeRender hook.
//
// Two enemy archetypes share this class:
//   - 'zombie' : walks toward the player on the XZ plane, attacks at melee
//     range, plays the Quaternius zombiekit animations (Idle / Walk /
//     Idle_Attack / Death).
//   - 'ufo'    : holds altitude over the spawn point, periodically casts a
//     line-of-sight ray at the player and spawns a brief tracer line. No
//     damage is dealt yet (Phase 5 wires that in).

import "@babylonjs/loaders/glTF/index.js";
import { Scene } from "@babylonjs/core/scene.js";
import { AssetContainer } from "@babylonjs/core/assetContainer.js";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Nullable } from "@babylonjs/core/types.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import { Ray } from "@babylonjs/core/Culling/ray.core.js";
import { Observable } from "@babylonjs/core/Misc/observable.js";

import { loadGLB } from "../utils/AssetLoader.js";
import { EnemyState, EnemyStateMachine } from "../ai/EnemyStateMachine.js";
import { play, playRandom, SCREAM_KEYS } from "../audio/AudioManager.js";

export type EnemyType = "zombie" | "ufo" | "boss";

// Boss reuses the zombie state machine + animations (it's a buffed Chubby
// zombie). Anywhere we previously branched on `type === "zombie"` we now
// route through this helper so bosses inherit the same ground-AI path.
function isGroundUnit(t: EnemyType): boolean {
  return t === "zombie" || t === "boss";
}

export interface EnemyOptions {
  type: EnemyType;
  position: Vector3;
  hp?: number;
  damage?: number;
  speed?: number;
  detectionRadius?: number;
  attackRange?: number;
  attackCooldown?: number; // seconds
  hoverHeight?: number; // ufo only
  fireInterval?: number; // ufo seconds between tracer fires
  scaling?: number; // visual scale multiplier
}

const DEFAULT_HP = 30;
const DEFAULT_DAMAGE = 5;
const DEFAULT_SPEED = 3;
const DEFAULT_DETECTION = 15;
const DEFAULT_ATTACK_RANGE = 2;
const DEFAULT_ATTACK_COOLDOWN = 1.0;
const DEFAULT_UFO_HOVER = 6;
const DEFAULT_UFO_FIRE_INTERVAL = 2.0;

const DEATH_TWEEN_MS = 800;
const DEATH_SINK_DISTANCE = 1.5;
const TRACER_LIFETIME_MS = 200;

// Reasonable yaw smoothing — radians per second. Zombies snap toward the
// player but don't pop instantaneously.
const YAW_TURN_RATE = 6;

/**
 * Per-target signal payload. Held outside the class so we don't allocate a
 * fresh object every attack frame. `damage` is the per-swing damage amount
 * the receiver should apply (the Arena scene wires this into
 * `player.takeDamage(evt.damage)`).
 */
export interface EnemyAttackEvent {
  enemy: Enemy;
  damage: number;
}

export class Enemy {
  private readonly scene: Scene;
  private readonly opts: Required<EnemyOptions>;
  private readonly stateMachine: EnemyStateMachine;

  // Anchor TransformNode for translation/rotation. The instantiated glTF
  // root is parented under this so we don't have to track whatever transform
  // the export baked in.
  private readonly root: TransformNode;
  private readonly visualRoot: TransformNode;

  // Cached collection of meshes spawned for this instance — used for the
  // alpha-fade death tween. We touch each material's alpha directly.
  private readonly meshes: AbstractMesh[];

  // Animation groups by intent. Zombies have all four; UFO has none (it's a
  // static prop).
  private readonly animIdle?: AnimationGroup;
  private readonly animWalk?: AnimationGroup;
  private readonly animAttack?: AnimationGroup;
  private readonly animDeath?: AnimationGroup;
  private readonly allAnims: AnimationGroup[];

  // Per-frame state.
  private currentAnim?: AnimationGroup;
  private timeSinceAttack = DEFAULT_ATTACK_COOLDOWN; // start ready to swing
  private timeSinceFire = 0;
  private deathStartedAtMs: number | null = null;
  private _isDead = false;
  private _onDeathFired = false;

  // Cached yaw on the XZ plane.
  private yaw = 0;

  /** Public observable fired exactly once on death. */
  readonly onDeath = new Observable<Enemy>();
  /** Public observable fired each time an attack swing lands. */
  readonly onAttack = new Observable<EnemyAttackEvent>();

  constructor(scene: Scene, container: AssetContainer, opts: EnemyOptions) {
    this.scene = scene;
    this.opts = {
      type: opts.type,
      position: opts.position,
      hp: opts.hp ?? DEFAULT_HP,
      damage: opts.damage ?? DEFAULT_DAMAGE,
      speed: opts.speed ?? DEFAULT_SPEED,
      detectionRadius: opts.detectionRadius ?? DEFAULT_DETECTION,
      attackRange: opts.attackRange ?? DEFAULT_ATTACK_RANGE,
      attackCooldown: opts.attackCooldown ?? DEFAULT_ATTACK_COOLDOWN,
      hoverHeight: opts.hoverHeight ?? DEFAULT_UFO_HOVER,
      fireInterval: opts.fireInterval ?? DEFAULT_UFO_FIRE_INTERVAL,
      scaling: opts.scaling ?? 1,
    };

    this.stateMachine = new EnemyStateMachine(EnemyState.IDLE);

    // Outer anchor — owns position + yaw.
    this.root = new TransformNode(`enemy-${opts.type}-root`, scene);
    this.root.position.copyFrom(this.opts.position);

    // Instantiate a clone of the AssetContainer.
    const instance = container.instantiateModelsToScene(
      (n) => `${this.root.name}-${n}`,
      false,
      { doNotInstantiate: false },
    );

    // Wrap glTF root under our anchor.
    this.visualRoot = new TransformNode(`${this.root.name}-visual`, scene);
    this.visualRoot.parent = this.root;
    if (this.opts.scaling !== 1) {
      this.visualRoot.scaling.setAll(this.opts.scaling);
    }
    for (const node of instance.rootNodes) {
      node.parent = this.visualRoot;
    }

    this.meshes = collectChildMeshes(this.root);

    // Stop all auto-played animations; we drive playback manually.
    for (const g of instance.animationGroups) {
      g.stop();
      g.setWeightForAllAnimatables(0);
    }
    this.allAnims = instance.animationGroups;

    const byName = new Map<string, AnimationGroup>();
    for (const g of instance.animationGroups) byName.set(g.name, g);
    // Quaternius zombiekit clip names (verified in Zombie_Basic.gltf):
    //   Idle, Walk, Run, Crawl, Death, HitReact, Idle_Attack, Run_Attack,
    //   Punch, Jump, Jump_Idle, Jump_Land, No, Wave, Yes.
    this.animIdle = byName.get("Idle");
    this.animWalk = byName.get("Walk");
    this.animAttack = byName.get("Idle_Attack") ?? byName.get("Punch");
    this.animDeath = byName.get("Death");

    this.wireStateHandlers();

    // Ensure idle is the visible starting clip for ground units (zombies + bosses).
    if (isGroundUnit(this.opts.type)) {
      this.playAnim(this.animIdle, /*loop=*/ true);
    }
  }

  /** Dispose meshes, animations, and the asset container clone. */
  dispose(): void {
    this.onDeath.clear();
    this.onAttack.clear();
    for (const g of this.allAnims) g.stop();
    this.root.dispose(false, true);
  }

  /** True once HP <= 0 and the death tween has begun. */
  get isDead(): boolean {
    return this._isDead;
  }

  get type(): EnemyType {
    return this.opts.type;
  }

  /** World position of the enemy root. Read-only by convention. */
  get position(): Vector3 {
    return this.root.position;
  }

  /**
   * Public accessor for the outer anchor TransformNode. The Arena scene's
   * mesh→Enemy registry walks this node's child meshes once on spawn so a
   * Combat raycast that picks any sub-mesh of the rigged glTF can resolve
   * back to the owning Enemy instance.
   */
  get rootNode(): TransformNode {
    return this.root;
  }

  /** Snapshot of every AbstractMesh under this enemy. Used by the Arena
   *  scene to populate its mesh→Enemy lookup for damage routing. */
  getMeshes(): AbstractMesh[] {
    return this.meshes.slice();
  }

  get state(): EnemyState {
    return this.stateMachine.current;
  }

  /** Current HP (after any damage applied). -1 sentinel = "use opts.hp". */
  private hpRemaining = -1;

  takeDamage(amount: number): void {
    if (this._isDead) return;
    if (this.hpRemaining < 0) this.hpRemaining = this.opts.hp;
    this.hpRemaining -= amount;
    if (this.hpRemaining <= 0) {
      this.beginDeath();
    }
  }

  /**
   * Per-frame tick. Call from the demo's onBeforeRenderObservable. The
   * Player target is read for position + line-of-sight only — we never
   * mutate it.
   */
  update(playerTarget: { position: Vector3 }, dtSec: number): void {
    if (this._isDead) {
      this.tickDeathTween();
      return;
    }
    if (dtSec <= 0) return;

    if (this.opts.type === "ufo") {
      this.updateUfo(playerTarget, dtSec);
      return;
    }

    // Zombies and bosses share the same ground-unit chase/attack loop.
    this.updateZombie(playerTarget, dtSec);
  }

  // ---------- factory helpers ----------

  /**
   * Convenience wrapper around `loadGLB` + constructor. Keeps the Demo /
   * Game scene short — they don't need to thread the AssetContainer through.
   *
   * If the glTF/GLB load fails (e.g. the Kenney UFO `.glb` references
   * external textures that haven't been copied yet — task #18), and the
   * caller passes `fallback: 'ufoDisc'`, we substitute a procedural disc.
   * The console gets a warning so the dev sees what happened.
   */
  static async create(
    scene: Scene,
    assetPath: string,
    opts: EnemyOptions,
    fallback?: "ufoDisc",
  ): Promise<Enemy> {
    try {
      const container = await loadGLB(scene, assetPath);
      return new Enemy(scene, container, opts);
    } catch (err) {
      if (fallback === "ufoDisc") {
        console.warn(
          `[Enemy] glTF load failed for ${assetPath}, using procedural ` +
            `disc fallback. Original error:`,
          err,
        );
        const container = buildProceduralUfoContainer(scene);
        return new Enemy(scene, container, opts);
      }
      throw err;
    }
  }

  // ---------- internals ----------

  private wireStateHandlers(): void {
    if (!isGroundUnit(this.opts.type)) return;

    this.stateMachine.onEnter(EnemyState.IDLE, () => {
      this.playAnim(this.animIdle, true);
    });
    this.stateMachine.onEnter(EnemyState.CHASE, () => {
      this.playAnim(this.animWalk ?? this.animIdle, true);
    });
    this.stateMachine.onEnter(EnemyState.ATTACK, () => {
      this.playAnim(this.animAttack ?? this.animIdle, true);
      // Force the next attack swing to be ready immediately on entering
      // ATTACK; the cooldown timer then resumes its normal cadence.
      this.timeSinceAttack = this.opts.attackCooldown;
    });
    this.stateMachine.onEnter(EnemyState.DEAD, () => {
      this.playAnim(this.animDeath, false);
    });
  }

  private playAnim(group: AnimationGroup | undefined, loop: boolean): void {
    if (!group) return;
    if (this.currentAnim === group && group.isPlaying) return;
    // Snap-cut: hard stop everything else, then start the requested clip.
    // Crossfade is overkill for enemies and noisy at 30+ instances.
    for (const g of this.allAnims) {
      if (g === group) continue;
      if (g.isPlaying) {
        g.stop();
        g.setWeightForAllAnimatables(0);
      }
    }
    group.start(loop, 1.0);
    group.setWeightForAllAnimatables(1);
    this.currentAnim = group;
  }

  private updateZombie(target: { position: Vector3 }, dt: number): void {
    const dx = target.position.x - this.root.position.x;
    const dz = target.position.z - this.root.position.z;
    const distSq = dx * dx + dz * dz;
    const detectSq = this.opts.detectionRadius * this.opts.detectionRadius;
    const attackSq = this.opts.attackRange * this.opts.attackRange;

    this.timeSinceAttack += dt;

    // State transitions purely based on horizontal distance.
    switch (this.stateMachine.current) {
      case EnemyState.IDLE:
        if (distSq <= detectSq) {
          this.stateMachine.transition(EnemyState.CHASE);
        }
        break;
      case EnemyState.CHASE:
        if (distSq <= attackSq) {
          this.stateMachine.transition(EnemyState.ATTACK);
        } else if (distSq > detectSq) {
          // Player escaped — fall back to idle. (Not strictly required by
          // the AC, but feels natural and avoids zombies chasing forever.)
          this.stateMachine.transition(EnemyState.IDLE);
        }
        break;
      case EnemyState.ATTACK:
        if (distSq > attackSq) {
          this.stateMachine.transition(EnemyState.CHASE);
        }
        break;
      default:
        break;
    }

    // Per-state behavior.
    if (this.stateMachine.current === EnemyState.CHASE) {
      const dist = Math.sqrt(distSq);
      if (dist > 1e-4) {
        const nx = dx / dist;
        const nz = dz / dist;
        this.root.position.x += nx * this.opts.speed * dt;
        this.root.position.z += nz * this.opts.speed * dt;
      }
      this.faceTowards(dx, dz, dt);
    } else if (this.stateMachine.current === EnemyState.ATTACK) {
      this.faceTowards(dx, dz, dt);
      if (this.timeSinceAttack >= this.opts.attackCooldown) {
        this.timeSinceAttack = 0;
        this.onAttack.notifyObservers({
          enemy: this,
          damage: this.opts.damage,
        });
      }
    }
  }

  private updateUfo(target: { position: Vector3 }, dt: number): void {
    // Hold altitude — clamp Y to hover height regardless of any drift.
    this.root.position.y = this.opts.hoverHeight;

    // Slowly face the player so the disc visually orients toward them.
    const dx = target.position.x - this.root.position.x;
    const dz = target.position.z - this.root.position.z;
    this.faceTowards(dx, dz, dt);

    this.timeSinceFire += dt;
    if (this.timeSinceFire < this.opts.fireInterval) return;
    this.timeSinceFire = 0;

    // Line-of-sight ray. We only fire if there's nothing between the UFO
    // and the player — but in a flat demo arena there's nothing to occlude
    // so this is mostly future-proofing for Phase 5 cover.
    const origin = this.root.position.clone();
    const toTarget = target.position.subtract(origin);
    const length = toTarget.length();
    if (length < 1e-3) return;
    const direction = toTarget.scale(1 / length);
    const ray = new Ray(origin, direction, length);
    // Skip our own meshes when picking — without this the ray hits the
    // UFO's own hull and reports "no LoS".
    const ownMeshNames = new Set(this.meshes.map((m) => m.name));
    const pickInfo = this.scene.pickWithRay(ray, (m) => {
      if (ownMeshNames.has(m.name)) return false;
      return m.isPickable;
    });

    // Ignore the pick result for the visible tracer — we always show the
    // beam from UFO to player so the player can see the threat. A future
    // damage hookup would gate on `pickInfo?.pickedMesh === playerMesh`.
    void pickInfo;

    this.spawnTracer(origin, target.position.clone());
    play("ufo-fire");
  }

  private faceTowards(dx: number, dz: number, dt: number): void {
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
    const targetYaw = Math.atan2(dx, dz);
    // Shortest-arc lerp: wrap delta to [-PI, PI] so we never spin the long
    // way around at the +PI/-PI seam.
    let diff = targetYaw - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const step = Math.sign(diff) * Math.min(Math.abs(diff), YAW_TURN_RATE * dt);
    this.yaw += step;
    this.root.rotation.y = this.yaw;
  }

  private spawnTracer(from: Vector3, to: Vector3): void {
    // Create a single-segment line in red, with vertex alpha so we can fade
    // it out via setTimeout dispose. Color4 alpha 1 keeps it solid.
    const colors = [
      new Color4(1, 0.2, 0.2, 1),
      new Color4(1, 0.2, 0.2, 1),
    ];
    const tracer = CreateLines(
      "ufo-tracer",
      { points: [from, to], colors, useVertexAlpha: true },
      this.scene,
    );
    tracer.color = new Color3(1, 0.2, 0.2);
    tracer.isPickable = false;
    setTimeout(() => {
      if (!tracer.isDisposed()) tracer.dispose();
    }, TRACER_LIFETIME_MS);
  }

  private beginDeath(): void {
    if (this._isDead) return;
    this._isDead = true;
    this.stateMachine.transition(EnemyState.DEAD);
    this.deathStartedAtMs = performance.now();
    if (this.opts.type === "ufo") {
      play("ufo-death");
    } else {
      playRandom(SCREAM_KEYS);
    }
    if (!this._onDeathFired) {
      this._onDeathFired = true;
      this.onDeath.notifyObservers(this);
    }
  }

  private tickDeathTween(): void {
    if (this.deathStartedAtMs === null) return;
    const elapsed = performance.now() - this.deathStartedAtMs;
    const t = Math.min(1, elapsed / DEATH_TWEEN_MS);

    // Sink Y toward original_y - DEATH_SINK_DISTANCE.
    this.root.position.y = this.opts.position.y - t * DEATH_SINK_DISTANCE;
    if (this.opts.type === "ufo") {
      this.root.position.y = this.opts.hoverHeight - t * DEATH_SINK_DISTANCE;
    }

    // Fade alpha by blending each material's alpha. We can't bake this onto
    // the visualRoot directly because materials are shared instances from
    // the AssetContainer clone — we mutate per-material alpha but only on
    // the cloned materials (instantiateModelsToScene gives us new copies
    // when it can; for shared materials we accept a one-frame visual
    // bleed, which is invisible at this duration).
    const alpha = 1 - t;
    for (const m of this.meshes) {
      const mat = m.material as Nullable<{
        alpha: number;
        transparencyMode?: number;
      }>;
      if (mat) {
        mat.alpha = alpha;
        // 2 = ALPHABLEND so transparent rendering kicks in. Most StandardMat
        // and PBRMat instances coming out of glTF default to OPAQUE (0).
        if ("transparencyMode" in mat && t > 0) {
          mat.transparencyMode = 2;
        }
      }
    }

    if (t >= 1) {
      this.deathStartedAtMs = null;
      this.dispose();
    }
  }
}

/**
 * Build a tiny AssetContainer holding a procedurally-generated gray disc +
 * dome to stand in for the real UFO glTF. We register the meshes in the
 * container so `instantiateModelsToScene` can clone them on demand the same
 * way it does for real glTF imports.
 */
function buildProceduralUfoContainer(scene: Scene): AssetContainer {
  const container = new AssetContainer(scene);

  const root = new TransformNode("ufo-fallback-root", scene);
  // Make the disc DOUBLE-sided so it renders both faces — our third-person
  // camera typically sees the underside, which would otherwise be culled.
  const disc = MeshBuilder.CreateDisc(
    "ufo-fallback-disc",
    { radius: 1, tessellation: 24, sideOrientation: 2 /* DOUBLESIDE */ },
    scene,
  );
  disc.rotation.x = Math.PI / 2;
  disc.parent = root;
  const dome = MeshBuilder.CreateSphere(
    "ufo-fallback-dome",
    { diameter: 0.9, segments: 16 },
    scene,
  );
  dome.position.y = 0.2;
  dome.scaling.y = 0.5;
  dome.parent = root;

  const discMat = new StandardMaterial("ufo-fallback-mat", scene);
  discMat.diffuseColor = new Color3(0.5, 0.5, 0.55);
  discMat.specularColor = new Color3(0.2, 0.2, 0.2);
  disc.material = discMat;

  const domeMat = new StandardMaterial("ufo-fallback-dome-mat", scene);
  domeMat.diffuseColor = new Color3(0.4, 0.7, 0.9);
  domeMat.alpha = 0.7;
  dome.material = domeMat;

  container.transformNodes.push(root);
  container.meshes.push(disc, dome);
  container.materials.push(discMat, domeMat);

  // Detach from the live scene so consumers can use
  // `instantiateModelsToScene` to spawn clones, matching the glTF code path.
  container.removeAllFromScene();

  return container;
}

/** Walk the TransformNode hierarchy and collect every AbstractMesh under it. */
function collectChildMeshes(root: TransformNode): AbstractMesh[] {
  const out: AbstractMesh[] = [];
  const stack: { getChildren?: () => unknown[] }[] = [
    root as unknown as { getChildren?: () => unknown[] },
  ];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    const children = (node.getChildren?.() ?? []) as unknown[];
    for (const c of children) {
      // AbstractMesh has a `getTotalVertices` method; use the soft brand
      // check `isReady` + `material` to identify meshes without importing
      // AbstractMesh as a constructable. Cheaper duck check: a mesh has
      // `getClassName()` returning "Mesh" / "InstancedMesh" / etc.
      const child = c as { getClassName?: () => string } & TransformNode;
      const cls = child.getClassName?.();
      if (
        cls === "Mesh" ||
        cls === "InstancedMesh" ||
        cls === "GroundMesh" ||
        cls === "LinesMesh"
      ) {
        out.push(child as unknown as AbstractMesh);
      }
      stack.push(child as unknown as TransformNode);
    }
  }
  return out;
}
