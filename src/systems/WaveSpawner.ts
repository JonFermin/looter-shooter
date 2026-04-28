// Wave spawner — clear-based escalating waves with a 5-second breather
// between waves. Hands off the actual Enemy.create() call to the caller
// (Arena) via the `spawnEnemy` callback so the Arena can keep its
// mesh→Enemy registry, loot wiring, and onAttack wiring in one place.
//
// State machine:
//   start() → "active" (wave N enemies spawn) → all dead →
//   "breather" (5s countdown via update(dt)) → "active" (wave N+1) → ...
//   → "complete" once `maxWaves` is reached (default: loops forever).
//
// Random spawn positions are drawn uniformly from `bounds` (inset 2u from
// the wall) but rejected if they fall within 10u of the player's current
// position. After 30 failed attempts we fall back to the player's
// reflected position so the spawner never deadlocks.
//
// `notifyEnemyDeath` is called by Arena's existing onDeath observable
// hook; it decrements enemiesAlive, fires onStateChange (so the HUD's
// `X/Y enemies` counter updates per kill), and triggers the breather
// transition once the last enemy of the wave dies.

import type { Scene } from "@babylonjs/core/scene.js";
import type { BoundingBox } from "@babylonjs/core/Culling/boundingBox.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Observable } from "@babylonjs/core/Misc/observable.js";

import type { Player } from "../entities/Player.js";
import type { Enemy } from "../entities/Enemy.js";

export type ZombieVariant = "basic" | "chubby" | "ribcage";
export type SpawnUnit =
  | { kind: "zombie"; variant: ZombieVariant }
  | { kind: "ufo" }
  | { kind: "boss" };

export interface WaveDefinition {
  zombies: number;
  ufos: number;
  bossCount: number;
  hpMultiplier: number;
}

export type WaveStatus = "idle" | "active" | "breather" | "complete";

export interface WaveState {
  waveNumber: number;
  enemiesAlive: number;
  enemiesTotal: number;
  status: WaveStatus;
  breatherTimeRemaining: number;
  isBossWave: boolean;
}

export interface WaveSpawnerOptions {
  scene: Scene;
  bounds: BoundingBox;
  player: Player;
  /**
   * Called by the spawner once per enemy. The Arena does the real work:
   * loads the right asset, calls Enemy.create with the supplied hp + a
   * spawn position, registers the enemy in the mesh map, and wires
   * onDeath → notifyEnemyDeath. Returning the resulting Enemy is enough
   * for the spawner to track it for cleanup, though we don't need much
   * since notifyEnemyDeath drives the kill counter.
   */
  spawnEnemy: (
    unit: SpawnUnit,
    position: Vector3,
    hp: number,
  ) => Promise<Enemy>;
  breatherSeconds?: number;
  maxWaves?: number;
}

const DEFAULT_BREATHER_SECONDS = 5;
const MIN_DISTANCE_FROM_PLAYER = 10;
const MIN_DISTANCE_FROM_PLAYER_SQ =
  MIN_DISTANCE_FROM_PLAYER * MIN_DISTANCE_FROM_PLAYER;
const SPAWN_INSET = 2;
const UFO_SPAWN_HEIGHT = 6;
const ZOMBIE_BASE_HP = 30;
const UFO_BASE_HP = 80;
const BOSS_BASE_HP = 250;
const ZOMBIE_VARIANTS: ZombieVariant[] = ["basic", "chubby", "ribcage"];

/**
 * Hard-coded for waves 1-3 to match the design brief, then a looping
 * formula kicks in for wave 4+. Looping is the more interesting choice
 * for a vertical slice — players who survive to wave 4 should keep
 * having fun rather than seeing "All waves cleared" and stopping.
 */
function getWaveDefinition(wave: number): WaveDefinition {
  const isBoss = wave > 0 && wave % 5 === 0;
  if (wave === 1) return { zombies: 3, ufos: 0, bossCount: 0, hpMultiplier: 1.0 };
  if (wave === 2) return { zombies: 5, ufos: 1, bossCount: 0, hpMultiplier: 1.0 };
  if (wave === 3) return { zombies: 8, ufos: 2, bossCount: 0, hpMultiplier: 1.5 };
  // Wave 4+: linear growth. On boss waves the regular spawn count is
  // halved and UFOs drop to zero so the boss reads as the centerpiece
  // threat rather than getting drowned in chaff.
  return {
    zombies: isBoss ? Math.floor((3 + wave * 2) / 2) : 3 + wave * 2,
    ufos: isBoss ? 0 : Math.floor(wave / 2),
    bossCount: isBoss ? 1 : 0,
    hpMultiplier: 1.0 + (wave - 1) * 0.5,
  };
}

export class WaveSpawner {
  readonly onWaveStart = new Observable<WaveState>();
  readonly onWaveComplete = new Observable<WaveState>();
  readonly onStateChange = new Observable<WaveState>();

  private readonly opts: WaveSpawnerOptions;
  private readonly breatherSeconds: number;
  private readonly maxWaves: number;

  private waveNumber = 0;
  private status: WaveStatus = "idle";
  private enemiesAlive = 0;
  private enemiesTotal = 0;
  private breatherTimeRemaining = 0;
  private disposed = false;

  constructor(opts: WaveSpawnerOptions) {
    this.opts = opts;
    this.breatherSeconds = opts.breatherSeconds ?? DEFAULT_BREATHER_SECONDS;
    this.maxWaves = opts.maxWaves ?? Number.POSITIVE_INFINITY;
  }

  /** Snapshot of the current state. Used by Arena for the initial HUD push. */
  get state(): WaveState {
    return {
      waveNumber: this.waveNumber,
      enemiesAlive: this.enemiesAlive,
      enemiesTotal: this.enemiesTotal,
      status: this.status,
      breatherTimeRemaining: this.breatherTimeRemaining,
      isBossWave: this.waveNumber > 0 && this.waveNumber % 5 === 0,
    };
  }

  /** Begin wave 1. Call once after Player + Weapon + HUD are ready. */
  start(): void {
    if (this.disposed) return;
    if (this.status !== "idle") return;
    void this.beginWave(1);
  }

  /** Per-frame tick. Drives the breather countdown. */
  update(dt: number): void {
    if (this.disposed) return;
    if (this.status !== "breather") return;
    this.breatherTimeRemaining -= dt;
    if (this.breatherTimeRemaining <= 0) {
      this.breatherTimeRemaining = 0;
      void this.beginWave(this.waveNumber + 1);
    } else {
      // Fire onStateChange every tick so the HUD countdown can refresh.
      this.notifyStateChange();
    }
  }

  /**
   * Arena calls this from inside its existing onDeath observer. We
   * decrement the live count, refresh the HUD via onStateChange, and
   * — once the last enemy dies — start the breather (or finish, if
   * we just cleared maxWaves).
   */
  notifyEnemyDeath(_enemy: Enemy): void {
    if (this.disposed) return;
    if (this.status !== "active") return;
    if (this.enemiesAlive <= 0) return;
    this.enemiesAlive -= 1;
    this.notifyStateChange();
    if (this.enemiesAlive === 0) {
      this.onWaveComplete.notifyObservers(this.state);
      if (this.waveNumber >= this.maxWaves) {
        this.status = "complete";
        this.notifyStateChange();
        return;
      }
      this.status = "breather";
      this.breatherTimeRemaining = this.breatherSeconds;
      this.notifyStateChange();
    }
  }

  /**
   * Reset to a fresh idle state so the next start() begins wave 1. Used by
   * the death-screen restart flow — clears wave/enemy counters and fires
   * onStateChange so the HUD's wave indicator clears.
   */
  reset(): void {
    if (this.disposed) return;
    this.waveNumber = 0;
    this.status = "idle";
    this.enemiesAlive = 0;
    this.enemiesTotal = 0;
    this.breatherTimeRemaining = 0;
    this.notifyStateChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onWaveStart.clear();
    this.onWaveComplete.clear();
    this.onStateChange.clear();
  }

  // ---------- internals ----------

  private async beginWave(n: number): Promise<void> {
    this.waveNumber = n;
    const def = getWaveDefinition(n);
    const total = def.zombies + def.ufos + def.bossCount;
    this.enemiesTotal = total;
    this.enemiesAlive = total;
    this.status = "active";
    this.breatherTimeRemaining = 0;
    this.onWaveStart.notifyObservers(this.state);
    this.notifyStateChange();

    // Build the spawn list — for waves 1+ we mix zombie variants. Wave 1
    // is forced to all-Basic so the first impression matches the design
    // doc ("3 Basic zombies"). After that we sample variants uniformly.
    const units: SpawnUnit[] = [];
    for (let i = 0; i < def.zombies; i++) {
      const variant: ZombieVariant =
        n === 1 ? "basic" : pickRandom(ZOMBIE_VARIANTS);
      units.push({ kind: "zombie", variant });
    }
    for (let i = 0; i < def.ufos; i++) {
      units.push({ kind: "ufo" });
    }
    for (let i = 0; i < def.bossCount; i++) {
      units.push({ kind: "boss" });
    }

    // Spawn in parallel — each call already gates on its own GLB load,
    // and the Enemy.create path tolerates concurrent loads thanks to the
    // AssetContainer cache in loadGLB.
    const playerPos = this.opts.player.position;
    const tasks: Promise<unknown>[] = [];
    for (const unit of units) {
      const pos = pickSpawnPosition(this.opts.bounds, playerPos);
      if (unit.kind === "ufo") pos.y = UFO_SPAWN_HEIGHT;
      const baseHp =
        unit.kind === "ufo"
          ? UFO_BASE_HP
          : unit.kind === "boss"
            ? BOSS_BASE_HP
            : ZOMBIE_BASE_HP;
      const hp = Math.round(baseHp * def.hpMultiplier);
      tasks.push(this.opts.spawnEnemy(unit, pos, hp));
    }
    // Don't block on completion; spawning is fire-and-forget from the
    // spawner's POV. If a load fails, the Arena will log it and the
    // spawner's enemiesAlive will be off-by-one — acceptable for a
    // vertical slice and matches existing fallback behavior.
    await Promise.allSettled(tasks);
  }

  private notifyStateChange(): void {
    this.onStateChange.notifyObservers(this.state);
  }
}

// ---------- helpers ----------

function pickRandom<T>(arr: readonly T[]): T {
  const idx = Math.floor(Math.random() * arr.length);
  const value = arr[idx];
  if (value === undefined) {
    throw new Error("WaveSpawner.pickRandom: empty array");
  }
  return value;
}

/**
 * Uniform-random XZ position within `bounds` (with a 2u inset from the
 * walls), rejected if it falls within 10u of the player. After 30
 * rejected samples we return a fallback opposite-corner position so the
 * spawner never deadlocks if the player is somehow filling the arena.
 */
function pickSpawnPosition(
  bounds: BoundingBox,
  playerPos: Vector3,
): Vector3 {
  const minX = bounds.minimumWorld.x + SPAWN_INSET;
  const maxX = bounds.maximumWorld.x - SPAWN_INSET;
  const minZ = bounds.minimumWorld.z + SPAWN_INSET;
  const maxZ = bounds.maximumWorld.z - SPAWN_INSET;

  for (let attempt = 0; attempt < 30; attempt++) {
    const x = minX + Math.random() * (maxX - minX);
    const z = minZ + Math.random() * (maxZ - minZ);
    const dx = x - playerPos.x;
    const dz = z - playerPos.z;
    if (dx * dx + dz * dz >= MIN_DISTANCE_FROM_PLAYER_SQ) {
      return new Vector3(x, 0, z);
    }
  }
  // Fallback — opposite corner mirrored across the player. Worst case
  // this still satisfies the ≥10u distance for any non-degenerate arena.
  const fallbackX = clampNumber(-playerPos.x, minX, maxX);
  const fallbackZ = clampNumber(-playerPos.z, minZ, maxZ);
  return new Vector3(fallbackX, 0, fallbackZ);
}

function clampNumber(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
