// Combat — top-level fire API. Caller hands us a Weapon and the active
// scene; we raycast from the active camera's viewpoint, decide what (if
// anything) was hit, ask the Weapon to play its visuals (tracer + muzzle
// flash), and return a Hit | null result for damage application.
//
// Why fire from the camera instead of the barrel: in third-person, a
// barrel-origin shot would diverge from the crosshair (which sits over the
// camera reticle), making aiming feel wrong. We instead raycast from the
// camera, then tell the weapon to draw a tracer that *originates* at the
// barrel and *ends* at the camera-ray's hit point — so the visual reads as
// "bullet from gun", but the hit logic matches "where you pointed".

import "@babylonjs/core/Culling/ray.js"; // side-effect: registers picking
import { Ray } from "@babylonjs/core/Culling/ray.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Observable } from "@babylonjs/core/Misc/observable.js";

import type { Weapon } from "../entities/Weapon.js";
import { playRandom, IMPACT_KEYS } from "../audio/AudioManager.js";

export interface Hit {
  /** World-space hit point. */
  point: Vector3;
  /** Mesh that was hit. */
  mesh: AbstractMesh;
  /** Distance from camera origin to hit point. */
  distance: number;
}

export interface HitEvent extends Hit {
  /** Damage applied for this hit (read from weapon.stats.damage by caller). */
  damage: number;
  /** True iff this hit was the killing blow on the target enemy. */
  lethal: boolean;
}

export interface FireOptions {
  /**
   * 0 = hip fire, 1 = fully braced aim. When omitted, Combat preserves the
   * old perfect camera-ray behavior for legacy/dev call sites.
   */
  aimAmount?: number;
}

/**
 * Manual notification channel for confirmed enemy hits. Combat.fire does
 * NOT auto-emit — Combat doesn't know which meshes are enemies vs.
 * environment. Arena owns the enemy registry and calls `notifyHit` after
 * resolving the picked mesh to an Enemy, so subscribers (DamageNumbers,
 * HUD crosshair flash) only react to enemy hits.
 */
export const onHit: Observable<HitEvent> = new Observable<HitEvent>();

export function notifyHit(event: HitEvent): void {
  onHit.notifyObservers(event);
  playRandom(IMPACT_KEYS);
}

const MAX_RANGE = 100;

/**
 * Fire the supplied weapon. Returns the Hit on success, or null on miss /
 * out-of-ammo / reload / cooldown. The Weapon decides whether the trigger
 * pull is even possible (ammo / reload / cooldown gate); we ask it to fire
 * AFTER computing the camera ray + pick result so a missed shot still
 * spends a bullet.
 *
 * The function is intentionally named `fire` (re-exported as default) so
 * callers can write `Combat.fire(weapon, scene)` after a wildcard import,
 * matching the AC's `Combat.fire()` shape.
 */
export function fire(
  weapon: Weapon,
  scene: Scene,
  options: FireOptions = {},
): Hit | null {
  const camera = scene.activeCamera;
  if (!camera) {
    console.warn("[Combat.fire] no active camera; cannot fire");
    return null;
  }

  // Build a ray from the camera. `getForwardRay` returns a Ray in world
  // space pointing along the camera's view direction. We rebuild it so we
  // can clamp to MAX_RANGE.
  const cameraRay = camera.getForwardRay(MAX_RANGE);
  const cameraOrigin = cameraRay.origin.clone();
  const baseCameraDirection = cameraRay.direction.clone().normalize();
  const cameraDirection =
    options.aimAmount === undefined
      ? baseCameraDirection
      : applyAccuracySpread(
          baseCameraDirection,
          weapon.stats.accuracy,
          options.aimAmount,
        );
  const aimingRay = new Ray(cameraOrigin, cameraDirection, MAX_RANGE);

  // Pick predicate: skip non-pickable meshes (Weapon disables picking on
  // its own mesh, which avoids self-hit). Default predicate already skips
  // unpickable meshes, but we narrow further: also skip the weapon
  // hierarchy and the player root by name. The Weapon's children are
  // already isPickable=false so the name check is belt-and-suspenders.
  const pickInfo = scene.pickWithRay(aimingRay, (mesh) => {
    if (!mesh.isPickable) return false;
    if (mesh.name.startsWith("weapon")) return false;
    if (mesh.name === "playerRoot") return false;
    return true;
  });

  // Have the Weapon play visuals. If the weapon refuses (out-of-ammo,
  // reload, cooldown), we return null without consulting the pick.
  const hitPoint = pickInfo?.hit ? pickInfo.pickedPoint?.clone() ?? null : null;
  const fired = weapon.fire(cameraDirection, hitPoint);
  if (!fired) return null;

  if (!pickInfo?.hit || !pickInfo.pickedMesh || !pickInfo.pickedPoint) {
    return null;
  }

  return {
    point: pickInfo.pickedPoint.clone(),
    mesh: pickInfo.pickedMesh,
    distance: pickInfo.distance,
  };
}

function applyAccuracySpread(
  direction: Vector3,
  accuracy: number,
  aimAmount: number,
): Vector3 {
  const spread = getSpreadRadians(accuracy, aimAmount);
  if (spread <= 0.0001) return direction;

  const up =
    Math.abs(direction.y) > 0.98
      ? new Vector3(1, 0, 0)
      : new Vector3(0, 1, 0);
  const right = Vector3.Cross(up, direction).normalize();
  const realUp = Vector3.Cross(direction, right).normalize();
  const theta = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * spread;
  const offsetScale = Math.tan(radius);

  return direction
    .add(right.scale(Math.cos(theta) * offsetScale))
    .add(realUp.scale(Math.sin(theta) * offsetScale))
    .normalize();
}

function getSpreadRadians(accuracy: number, aimAmount: number): number {
  const precision = clamp01(accuracy);
  const braced = clamp01(aimAmount);
  const weaponCone = (1 - precision) * lerp(0.055, 0.014, braced);
  const hipPenalty = (1 - braced) * 0.04;
  return weaponCone + hipPenalty;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}
