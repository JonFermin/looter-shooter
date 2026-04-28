// Persisted loadout state — equipped weapon, inventory, currency, kill
// counter — written to localStorage so a page reload restores the player's
// progress. The save key is namespaced and versioned so future schema
// changes can migrate cleanly. Validation is deliberately strict: any
// shape mismatch reads as a corrupted save and falls back to defaults
// rather than silently restoring partial state.

import { Archetype } from "../data/WeaponArchetype.js";
import type { WeaponStats } from "../data/WeaponArchetype.js";
import { RarityTier } from "../data/Rarity.js";
import type { InventoryItem } from "../data/InventoryItem.js";

export const SAVE_KEY = "looter-shooter:save:v1";
export const SAVE_SCHEMA_VERSION = 1;

export const SKIP_INTRO_KEY = "looter-shooter:skip-intro:v1";

export function loadSkipIntro(): boolean {
  try {
    return localStorage.getItem(SKIP_INTRO_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSkipIntro(): void {
  try {
    localStorage.setItem(SKIP_INTRO_KEY, "1");
  } catch (err) {
    console.warn("[SaveLoad] failed to set skip-intro flag:", err);
  }
}

export interface SerializedItem {
  archetype: Archetype;
  rarity: RarityTier;
  meshPath: string;
  displayName: string;
  stats: WeaponStats;
}

export interface SavedState {
  schemaVersion: number;
  equipped: SerializedItem | null;
  inventory: SerializedItem[];
  currency: number;
  totalKills: number;
}

export function itemToSerialized(item: InventoryItem): SerializedItem {
  return {
    archetype: item.archetype,
    rarity: item.rarity,
    meshPath: item.meshPath,
    displayName: item.displayName,
    stats: { ...item.stats },
  };
}

export function serializedToItem(s: SerializedItem): InventoryItem {
  return {
    archetype: s.archetype,
    rarity: s.rarity,
    meshPath: s.meshPath,
    displayName: s.displayName,
    stats: { ...s.stats },
  };
}

export function loadSavedState(): SavedState | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch (err) {
    console.warn("[SaveLoad] localStorage.getItem failed:", err);
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Corrupted JSON — log so the bug isn't silent, then bail to defaults.
    console.warn("[SaveLoad] save payload failed to parse:", err);
    return null;
  }

  if (!isSavedState(parsed)) {
    console.warn("[SaveLoad] save payload failed validation; ignoring");
    return null;
  }

  return parsed;
}

export function saveState(state: SavedState): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (err) {
    // Quota exceeded, private browsing mode, etc. — never throw out of a
    // save call so gameplay isn't interrupted.
    console.warn("[SaveLoad] localStorage.setItem failed:", err);
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (err) {
    console.warn("[SaveLoad] localStorage.removeItem failed:", err);
  }
}

// -- internal validation --

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isWeaponStats(v: unknown): v is WeaponStats {
  if (!isObject(v)) return false;
  return (
    typeof v.damage === "number" &&
    typeof v.fireRate === "number" &&
    typeof v.magazine === "number" &&
    typeof v.reloadTime === "number" &&
    typeof v.accuracy === "number"
  );
}

function isArchetype(v: unknown): v is Archetype {
  return (
    typeof v === "number" &&
    Object.values(Archetype).includes(v as Archetype)
  );
}

function isRarity(v: unknown): v is RarityTier {
  return (
    typeof v === "number" &&
    Object.values(RarityTier).includes(v as RarityTier)
  );
}

function isSerializedItem(v: unknown): v is SerializedItem {
  if (!isObject(v)) return false;
  return (
    isArchetype(v.archetype) &&
    isRarity(v.rarity) &&
    typeof v.meshPath === "string" &&
    typeof v.displayName === "string" &&
    isWeaponStats(v.stats)
  );
}

function isSavedState(v: unknown): v is SavedState {
  if (!isObject(v)) return false;
  if (v.schemaVersion !== SAVE_SCHEMA_VERSION) return false;
  if (typeof v.currency !== "number") return false;
  if (typeof v.totalKills !== "number") return false;
  if (v.equipped !== null && !isSerializedItem(v.equipped)) return false;
  if (!Array.isArray(v.inventory)) return false;
  for (const item of v.inventory) {
    if (!isSerializedItem(item)) return false;
  }
  return true;
}
