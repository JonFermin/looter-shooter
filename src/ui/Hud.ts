// HUD overlay — fullscreen @babylonjs/gui AdvancedDynamicTexture composed
// of:
//   • bottom-left: HP bar (green→red below 25%) with N/M numeric overlay
//   • above HP: shield bar (cyan) with N/M numeric overlay
//   • bottom-right: ammo readout "current / magazine"
//   • center: crosshair PNG (Kenney crosshair-pack)
//
// Construction takes the scene + player + a getWeapon callback. The
// callback is the indirection point for Phase 7 weapon swaps — for now
// the Arena scene returns a fixed weapon instance, but HUD never caches
// it so swaps will Just Work.
//
// Lifecycle: HUD owns one onBeforeRenderObservable subscription and the
// AdvancedDynamicTexture; dispose() clears both. Arena.createArenaScene
// chains dispose() into scene.onDisposeObservable so HMR reloads don't
// leak the HUD layer.

// AdvancedDynamicTexture relies on engine.createDynamicTexture, which is
// registered by side-effect from these two files (one for WebGL, one for
// WebGPU). Without them the WebGPU path throws "createDynamicTexture is
// not a function" the first time we build the HUD.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js";

import type { Scene } from "@babylonjs/core/scene.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Nullable } from "@babylonjs/core/types.js";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture.js";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle.js";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel.js";
import { Image } from "@babylonjs/gui/2D/controls/image.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";

import type { Player } from "../entities/Player.js";
import type { Weapon } from "../entities/Weapon.js";
import type { WaveState } from "../systems/WaveSpawner.js";
import { onHit, type HitEvent } from "../systems/Combat.js";
import type { WeaponStats } from "../data/WeaponArchetype.js";
import { Archetype } from "../data/WeaponArchetype.js";
import { RARITY_COLOR, RarityTier } from "../data/Rarity.js";

// Crosshair PNG: Kenney crosshair-pack #007 (clean broken-plus, white).
// Picked by inspecting the preview sheet; reads cleanly against both the
// dusty courtyard ground and the desaturated sky.
const CROSSHAIR_PATH = "/assets/ui/crosshair-pack/PNG/White/crosshair007.png";
const CROSSHAIR_HIP_SIZE_PX = 38;
const CROSSHAIR_AIM_SIZE_PX = 26;

// Bar geometry. Hardcoded pixel dimensions — Babylon GUI's percentage
// width units fight with control alignment so fixed pixels are simpler
// and survive resize because the ADT renders against canvas pixels.
//
// Anchoring: we use `left` (positive offset from the left edge) and `top`
// (negative offset from the bottom edge) instead of `paddingLeft` /
// `paddingBottom` because padding on a fixed-size Rectangle gets
// subtracted from its width/height, collapsing the bar to a degenerate
// negative-height rect. `left` + `top` are pure positional offsets that
// don't touch the bar's intrinsic dimensions.
const BAR_WIDTH_PX = 240;
const BAR_HEIGHT_PX = 18;
const BAR_OFFSET_LEFT_PX = 24;
const BAR_OFFSET_BOTTOM_HP_PX = 24;
const BAR_OFFSET_BOTTOM_SHIELD_PX = 24 + BAR_HEIGHT_PX + 6; // stacked above HP
const BAR_BG_COLOR = "#222a"; // semi-transparent dark gray
const BAR_BG_BORDER = "#000a";

const HP_FILL_COLOR_HEALTHY = "#4ade80"; // green
const HP_FILL_COLOR_LOW = "#ef4444"; // red
const HP_LOW_THRESHOLD = 0.25;

const SHIELD_FILL_COLOR = "#22d3ee"; // cyan

const AMMO_PADDING_RIGHT_PX = 24;
const AMMO_PADDING_BOTTOM_PX = 24;

// Wave indicator — top-center, sits clear of any future minimap and
// doesn't interfere with the bottom-left bars or bottom-right ammo.
const WAVE_PADDING_TOP_PX = 20;
const WAVE_FONT_SIZE_PX = 22;

// Currency readout — top-left, padded 24px from the left edge so it sits
// just inside the viewport without colliding with the wave indicator
// (top-center) or minimap (top-right).
const CURRENCY_PADDING_TOP_PX = 20;
const CURRENCY_PADDING_LEFT_PX = 24;
const CURRENCY_FONT_SIZE_PX = 18;
const CURRENCY_COLOR = "#ffe066";

// Crosshair hit flash — a white square overlaid on the crosshair that
// pulses to alpha=1 on a confirmed enemy hit and decays to 0 over
// CROSSHAIR_FLASH_MS. Sized to match the crosshair so the flash reads as
// "the crosshair lit up" rather than "a separate sprite appeared".
// Lethal hits swap to the kill color so the player gets visual confirmation
// that the shot finished the enemy off.
const CROSSHAIR_FLASH_MS = 120;
const CROSSHAIR_FLASH_COLOR = "#ffffff";
const CROSSHAIR_KILL_FLASH_COLOR = "#ff3a3a";

// Pickup prompt — appears bottom-center when the player is within pickup
// range of a LootDrop. Sits above the HP/Shield bars (which top out at
// ~66 px from the bottom) and below the crosshair so it doesn't fight for
// attention with combat focus.
const PICKUP_PROMPT_BOTTOM_PX = 140;
const PICKUP_PROMPT_WIDTH_PX = 420;
const PICKUP_PROMPT_PAD_PX = 12;
const PICKUP_PROMPT_BG = "#0e1119e6";
const PICKUP_PROMPT_BORDER = "#ffffff55";

// Display strings keyed by enum index (RarityTier + Archetype enums are
// numeric and the order matches these arrays). All-caps is the Borderlands
// convention and reads as "label" rather than "title".
const RARITY_NAME: Record<RarityTier, string> = {
  [RarityTier.COMMON]: "COMMON",
  [RarityTier.UNCOMMON]: "UNCOMMON",
  [RarityTier.RARE]: "RARE",
  [RarityTier.EPIC]: "EPIC",
  [RarityTier.LEGENDARY]: "LEGENDARY",
};

const ARCHETYPE_NAME: Record<Archetype, string> = {
  [Archetype.PISTOL]: "PISTOL",
  [Archetype.SMG]: "SMG",
  [Archetype.RIFLE]: "RIFLE",
  [Archetype.SHOTGUN]: "SHOTGUN",
  [Archetype.BLASTER]: "BLASTER",
};

/**
 * Data the HUD needs to render the pickup prompt for a LootDrop. The Hud
 * intentionally doesn't import LootDrop / WeaponDatabase so the dependency
 * runs Arena → HUD (one direction), not the other way round.
 */
export interface PickupPromptInfo {
  weapon: WeaponStats;
  rarity: RarityTier;
  archetype: Archetype;
  displayName: string;
}

export class Hud {
  private readonly scene: Scene;
  private readonly player: Player;
  private readonly getWeapon: () => Weapon | null;

  private readonly texture: AdvancedDynamicTexture;
  private readonly hpBg: Rectangle;
  private readonly hpFill: Rectangle;
  private readonly hpText: TextBlock;
  private readonly shieldBg: Rectangle;
  private readonly shieldFill: Rectangle;
  private readonly shieldText: TextBlock;
  private readonly ammoText: TextBlock;
  private readonly waveText: TextBlock;
  private readonly currencyText: TextBlock;
  private readonly crosshair: Image;
  private readonly crosshairFlash: Rectangle;
  private readonly pickupPanel: Rectangle;
  private readonly pickupActionText: TextBlock;
  private readonly pickupNameText: TextBlock;
  private readonly pickupStatsText: TextBlock;
  private readonly pickupHintText: TextBlock;

  private waveState: WaveState | null = null;
  private crosshairFlashRemainingMs = 0;
  // Reference-equality cache so we don't rebuild text every frame while the
  // player stands next to the same drop. `weapon` is the unique key — same
  // LootDrop returns the same WeaponStats reference each call.
  private currentPickupWeapon: WeaponStats | null = null;

  private updateObserver: Nullable<Observer<Scene>> = null;
  private hitObserver: Nullable<Observer<HitEvent>> = null;
  private disposed = false;

  constructor(
    scene: Scene,
    player: Player,
    getWeapon: () => Weapon | null,
  ) {
    this.scene = scene;
    this.player = player;
    this.getWeapon = getWeapon;

    // Foreground fullscreen ADT — `true` puts it above 3D content.
    this.texture = AdvancedDynamicTexture.CreateFullscreenUI(
      "hud",
      true,
      scene,
    );

    // ---- HP bar (bottom-left) ----
    this.hpBg = makeBarBackground(
      "hudHpBg",
      BAR_OFFSET_LEFT_PX,
      BAR_OFFSET_BOTTOM_HP_PX,
    );
    this.hpFill = makeBarFill("hudHpFill", HP_FILL_COLOR_HEALTHY);
    this.hpBg.addControl(this.hpFill);
    this.hpText = makeBarText("hudHpText");
    this.hpBg.addControl(this.hpText);
    this.texture.addControl(this.hpBg);

    // ---- Shield bar (above HP) ----
    this.shieldBg = makeBarBackground(
      "hudShieldBg",
      BAR_OFFSET_LEFT_PX,
      BAR_OFFSET_BOTTOM_SHIELD_PX,
    );
    this.shieldFill = makeBarFill("hudShieldFill", SHIELD_FILL_COLOR);
    this.shieldBg.addControl(this.shieldFill);
    this.shieldText = makeBarText("hudShieldText");
    this.shieldBg.addControl(this.shieldText);
    this.texture.addControl(this.shieldBg);

    // ---- Ammo readout (bottom-right) ----
    this.ammoText = new TextBlock("hudAmmoText");
    this.ammoText.text = "-- / --";
    this.ammoText.color = "#FFFFFF";
    this.ammoText.fontSize = 28;
    this.ammoText.fontFamily = "monospace";
    this.ammoText.textHorizontalAlignment =
      Control.HORIZONTAL_ALIGNMENT_RIGHT;
    this.ammoText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    this.ammoText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    this.ammoText.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    this.ammoText.paddingRight = `${AMMO_PADDING_RIGHT_PX}px`;
    this.ammoText.paddingBottom = `${AMMO_PADDING_BOTTOM_PX}px`;
    this.ammoText.shadowColor = "#000000";
    this.ammoText.shadowOffsetX = 2;
    this.ammoText.shadowOffsetY = 2;
    this.ammoText.shadowBlur = 0;
    this.texture.addControl(this.ammoText);

    // ---- Wave indicator (top-center) ----
    this.waveText = new TextBlock("hudWaveText");
    this.waveText.text = "";
    this.waveText.color = "#FFFFFF";
    this.waveText.fontSize = WAVE_FONT_SIZE_PX;
    this.waveText.fontFamily = "monospace";
    this.waveText.textHorizontalAlignment =
      Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.waveText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    this.waveText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.waveText.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    this.waveText.paddingTop = `${WAVE_PADDING_TOP_PX}px`;
    this.waveText.shadowColor = "#000000";
    this.waveText.shadowOffsetX = 2;
    this.waveText.shadowOffsetY = 2;
    this.waveText.shadowBlur = 0;
    this.texture.addControl(this.waveText);

    // ---- Currency readout (top-left) ----
    this.currencyText = new TextBlock("hudCurrencyText");
    this.currencyText.text = "$ 0";
    this.currencyText.color = CURRENCY_COLOR;
    this.currencyText.fontSize = CURRENCY_FONT_SIZE_PX;
    this.currencyText.fontFamily = "monospace";
    this.currencyText.fontStyle = "bold";
    this.currencyText.textHorizontalAlignment =
      Control.HORIZONTAL_ALIGNMENT_LEFT;
    this.currencyText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    this.currencyText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    this.currencyText.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    this.currencyText.paddingLeft = `${CURRENCY_PADDING_LEFT_PX}px`;
    this.currencyText.paddingTop = `${CURRENCY_PADDING_TOP_PX}px`;
    this.currencyText.shadowColor = "#000000";
    this.currencyText.shadowOffsetX = 2;
    this.currencyText.shadowOffsetY = 2;
    this.currencyText.shadowBlur = 0;
    this.texture.addControl(this.currencyText);

    // ---- Crosshair (centered) ----
    this.crosshair = new Image("hudCrosshair", CROSSHAIR_PATH);
    this.crosshair.width = `${CROSSHAIR_HIP_SIZE_PX}px`;
    this.crosshair.height = `${CROSSHAIR_HIP_SIZE_PX}px`;
    this.crosshair.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.crosshair.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.crosshair.stretch = Image.STRETCH_UNIFORM;
    this.texture.addControl(this.crosshair);

    // Crosshair hit-flash overlay — a white rect centered on the
    // crosshair, alpha=0 by default. Combat.onHit drives a brief flash by
    // setting crosshairFlashRemainingMs > 0; refresh() decays it back to 0
    // each frame using the engine's getDeltaTime().
    this.crosshairFlash = new Rectangle("hudCrosshairFlash");
    this.crosshairFlash.width = `${CROSSHAIR_HIP_SIZE_PX}px`;
    this.crosshairFlash.height = `${CROSSHAIR_HIP_SIZE_PX}px`;
    this.crosshairFlash.thickness = 0;
    this.crosshairFlash.background = CROSSHAIR_FLASH_COLOR;
    this.crosshairFlash.horizontalAlignment =
      Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.crosshairFlash.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.crosshairFlash.alpha = 0;
    this.texture.addControl(this.crosshairFlash);

    // ---- Pickup prompt (bottom-center, hidden by default) ----
    // Wrapper rectangle owns the background + border. Child StackPanel
    // stacks four lines of text vertically. Hidden via isVisible so the
    // texture re-render only fires when the prompt actually shows/hides.
    this.pickupPanel = new Rectangle("hudPickupPanel");
    this.pickupPanel.width = `${PICKUP_PROMPT_WIDTH_PX}px`;
    this.pickupPanel.adaptHeightToChildren = true;
    this.pickupPanel.thickness = 2;
    this.pickupPanel.color = PICKUP_PROMPT_BORDER;
    this.pickupPanel.background = PICKUP_PROMPT_BG;
    this.pickupPanel.cornerRadius = 6;
    this.pickupPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.pickupPanel.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    // Bottom-anchored, so a *negative* `top` lifts the panel UP from the
    // bottom edge. Mirrors the HP/Shield bar offset convention.
    this.pickupPanel.top = `${-PICKUP_PROMPT_BOTTOM_PX}px`;
    this.pickupPanel.isVisible = false;

    const pickupStack = new StackPanel("hudPickupStack");
    pickupStack.isVertical = true;
    pickupStack.paddingTop = `${PICKUP_PROMPT_PAD_PX}px`;
    pickupStack.paddingBottom = `${PICKUP_PROMPT_PAD_PX}px`;
    pickupStack.paddingLeft = `${PICKUP_PROMPT_PAD_PX}px`;
    pickupStack.paddingRight = `${PICKUP_PROMPT_PAD_PX}px`;
    this.pickupPanel.addControl(pickupStack);

    this.pickupActionText = makePickupLine(
      "hudPickupAction",
      "Press [E] to pick up",
      22,
      "#ffe066",
      "bold",
      26,
    );
    pickupStack.addControl(this.pickupActionText);

    this.pickupNameText = makePickupLine(
      "hudPickupName",
      "",
      18,
      "#FFFFFF",
      "bold",
      24,
    );
    pickupStack.addControl(this.pickupNameText);

    this.pickupStatsText = makePickupLine(
      "hudPickupStats",
      "",
      14,
      "#cccccc",
      "normal",
      20,
    );
    pickupStack.addControl(this.pickupStatsText);

    this.pickupHintText = makePickupLine(
      "hudPickupHint",
      "Stored in inventory  —  press TAB to equip",
      13,
      "#9aa0aa",
      "normal",
      18,
    );
    pickupStack.addControl(this.pickupHintText);

    this.texture.addControl(this.pickupPanel);

    // Initial sync so the HUD reads correctly on the very first rendered
    // frame, before onBeforeRender has fired even once.
    this.refresh();

    this.updateObserver = scene.onBeforeRenderObservable.add(() => {
      this.refresh();
    });

    this.hitObserver = onHit.add((event) => {
      this.crosshairFlashRemainingMs = CROSSHAIR_FLASH_MS;
      this.crosshairFlash.background = event.lethal
        ? CROSSHAIR_KILL_FLASH_COLOR
        : CROSSHAIR_FLASH_COLOR;
    });
  }

  /**
   * Show or hide the "press [E] to pick up" prompt. Pass `null` when the
   * player has no drop in pickup range; pass a populated PickupPromptInfo
   * when they do. Cheap to call every frame — text is only rebuilt when
   * the underlying weapon reference actually changes.
   */
  setPickupPrompt(info: PickupPromptInfo | null): void {
    if (this.disposed) return;
    if (info === null) {
      if (this.pickupPanel.isVisible) {
        this.pickupPanel.isVisible = false;
      }
      this.currentPickupWeapon = null;
      return;
    }
    if (this.currentPickupWeapon !== info.weapon) {
      const rarityName = RARITY_NAME[info.rarity];
      const archetypeName = ARCHETYPE_NAME[info.archetype];
      this.pickupNameText.text =
        `${rarityName} ${archetypeName}  —  ${info.displayName}`;
      this.pickupNameText.color = RARITY_COLOR[info.rarity];
      this.pickupStatsText.text = formatPickupStats(info.weapon);
      this.currentPickupWeapon = info.weapon;
    }
    if (!this.pickupPanel.isVisible) {
      this.pickupPanel.isVisible = true;
    }
  }

  /**
   * Update the wave indicator. Arena wires this to
   * `WaveSpawner.onStateChange` and also calls it once with the spawner's
   * initial state so the HUD reads correctly before the first wave fires.
   * Pass `null` to clear the indicator.
   */
  setWaveState(state: WaveState | null): void {
    if (this.disposed) return;
    this.waveState = state;
    this.refreshWaveText();
  }

  private refreshWaveText(): void {
    const state = this.waveState;
    if (!state || state.status === "idle") {
      this.waveText.text = "";
      return;
    }
    if (state.status === "active") {
      const bossLabel = state.isBossWave ? "  [BOSS]" : "";
      this.waveText.text =
        `Wave ${state.waveNumber}${bossLabel} — ` +
        `${state.enemiesAlive}/${state.enemiesTotal} enemies`;
      this.waveText.color = state.isBossWave ? "#ff5555" : "#FFFFFF";
      return;
    }
    // Reset to white for non-active states (breather countdown, complete).
    this.waveText.color = "#FFFFFF";
    if (state.status === "breather") {
      const seconds = Math.max(1, Math.ceil(state.breatherTimeRemaining));
      this.waveText.text =
        `Wave ${state.waveNumber + 1} incoming in ${seconds}...`;
      return;
    }
    // status === "complete"
    this.waveText.text = "All waves cleared!";
  }

  /**
   * Pull current values from the player + active weapon and push them
   * onto the GUI controls. Cheap: GUI only re-uploads texture pixels for
   * controls whose bound props actually changed, so calling this every
   * frame is fine even on integrated GPUs.
   */
  private refresh(): void {
    if (this.disposed) return;

    // HP bar: width scales with hp/maxHp; color flips red below threshold.
    const hpRatio = clamp01(this.player.hp / this.player.maxHp);
    this.hpFill.width = `${Math.round(BAR_WIDTH_PX * hpRatio)}px`;
    this.hpFill.background =
      hpRatio < HP_LOW_THRESHOLD ? HP_FILL_COLOR_LOW : HP_FILL_COLOR_HEALTHY;
    this.hpText.text = `${Math.round(this.player.hp)} / ${this.player.maxHp}`;

    // Shield bar: width scales with shield/maxShield; color stays cyan.
    const shieldRatio = clamp01(
      this.player.shield / this.player.maxShield,
    );
    this.shieldFill.width = `${Math.round(BAR_WIDTH_PX * shieldRatio)}px`;
    this.shieldText.text = `${Math.round(this.player.shield)} / ${this.player.maxShield}`;

    // Ammo readout — "-- / --" if no weapon is equipped, "(reloading)"
    // suffix while a reload cycle is in flight. Mirrors WeaponDemo.ts.
    const weapon = this.getWeapon();
    if (!weapon) {
      this.ammoText.text = "-- / --";
    } else if (weapon.isReloading) {
      this.ammoText.text = `-- / ${weapon.magazine}  (reloading)`;
    } else {
      this.ammoText.text = `${weapon.ammo} / ${weapon.magazine}`;
    }

    // Wave indicator — only the breather countdown changes per frame; the
    // active "X/Y" count and complete state are pushed via setWaveState.
    // Refreshing every frame is cheap and keeps countdown text live.
    if (this.waveState && this.waveState.status === "breather") {
      this.refreshWaveText();
    }

    // Currency readout — pull from the player every frame. Cheap; GUI only
    // re-uploads texture pixels when text actually changes.
    this.currencyText.text = `$ ${this.player.currency}`;

    const aimAmount = this.player.getAimAmount();
    const crosshairSize = Math.round(
      lerp(CROSSHAIR_HIP_SIZE_PX, CROSSHAIR_AIM_SIZE_PX, aimAmount),
    );
    const crosshairSizePx = `${crosshairSize}px`;
    this.crosshair.width = crosshairSizePx;
    this.crosshair.height = crosshairSizePx;
    this.crosshair.alpha = lerp(0.7, 1, aimAmount);
    this.crosshairFlash.width = crosshairSizePx;
    this.crosshairFlash.height = crosshairSizePx;

    // Crosshair flash decay. Engine delta is in milliseconds, matching
    // CROSSHAIR_FLASH_MS so we can subtract directly without unit conversion.
    if (this.crosshairFlashRemainingMs > 0) {
      const dtMs = this.scene.getEngine().getDeltaTime();
      this.crosshairFlashRemainingMs -= dtMs;
      if (this.crosshairFlashRemainingMs < 0) this.crosshairFlashRemainingMs = 0;
      this.crosshairFlash.alpha =
        this.crosshairFlashRemainingMs / CROSSHAIR_FLASH_MS;
    } else if (this.crosshairFlash.alpha !== 0) {
      this.crosshairFlash.alpha = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.updateObserver) {
      this.scene.onBeforeRenderObservable.remove(this.updateObserver);
      this.updateObserver = null;
    }
    if (this.hitObserver) {
      onHit.remove(this.hitObserver);
      this.hitObserver = null;
    }
    // Disposing the ADT removes every child control + its native texture.
    this.texture.dispose();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/**
 * Bottom-left-anchored Rectangle with a fixed pixel size and the bar
 * background style applied. The fill child renders inside this and is
 * left-aligned so its width shrinks from the right as the value drops.
 *
 * Position is set via `left`/`top` rather than `paddingLeft` /
 * `paddingBottom` so the Rectangle's intrinsic 240×18 size isn't eaten
 * by the GUI padding pass. `top` is a *negative* offset because the
 * Rectangle is bottom-anchored: -24 means "24 px above the bottom edge".
 */
function makeBarBackground(
  name: string,
  offsetLeftPx: number,
  offsetBottomPx: number,
): Rectangle {
  const bg = new Rectangle(name);
  bg.width = `${BAR_WIDTH_PX}px`;
  bg.height = `${BAR_HEIGHT_PX}px`;
  bg.thickness = 1;
  bg.color = BAR_BG_BORDER;
  bg.background = BAR_BG_COLOR;
  bg.cornerRadius = 2;
  bg.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  bg.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  bg.left = `${offsetLeftPx}px`;
  bg.top = `${-offsetBottomPx}px`;
  return bg;
}

/**
 * Inner fill rectangle. Anchored to the left edge of the parent
 * Rectangle so its `width` directly maps to "how much of the bar is
 * filled" as it animates from BAR_WIDTH_PX (full) to 0 (empty).
 */
function makeBarFill(name: string, color: string): Rectangle {
  const fill = new Rectangle(name);
  fill.width = `${BAR_WIDTH_PX}px`;
  fill.height = `${BAR_HEIGHT_PX}px`;
  fill.thickness = 0;
  fill.background = color;
  fill.cornerRadius = 2;
  fill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  fill.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  return fill;
}

/**
 * One line of the pickup prompt. StackPanel children need an explicit
 * height (it ignores intrinsic text height), and we want a 1px black drop
 * shadow on every line so the prompt stays legible against the daytime
 * dirt floor + the rarity-colored beam.
 */
function makePickupLine(
  name: string,
  initialText: string,
  fontSize: number,
  color: string,
  weight: "normal" | "bold",
  heightPx: number,
): TextBlock {
  const t = new TextBlock(name);
  t.text = initialText;
  t.color = color;
  t.fontSize = fontSize;
  t.fontFamily = "monospace";
  if (weight === "bold") t.fontStyle = "bold";
  t.height = `${heightPx}px`;
  t.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  t.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  t.shadowColor = "#000000";
  t.shadowOffsetX = 1;
  t.shadowOffsetY = 1;
  t.shadowBlur = 0;
  return t;
}

/**
 * Compact one-line stats summary for the pickup prompt. Shown in monospace
 * so the columns line up frame-to-frame as the player sweeps past drops.
 */
function formatPickupStats(s: WeaponStats): string {
  const dmg = Math.round(s.damage);
  const rof = s.fireRate.toFixed(1);
  return `DMG ${dmg}   |   ROF ${rof}/s   |   MAG ${s.magazine}`;
}

/**
 * Numeric "N / M" overlay centered inside the bar background. Uses a
 * black drop shadow so the text stays readable across the rapidly
 * changing fill colors.
 */
function makeBarText(name: string): TextBlock {
  const text = new TextBlock(name);
  text.text = "0 / 0";
  text.color = "#FFFFFF";
  text.fontSize = 14;
  text.fontFamily = "monospace";
  text.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  text.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  text.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  text.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  text.shadowColor = "#000000";
  text.shadowOffsetX = 1;
  text.shadowOffsetY = 1;
  text.shadowBlur = 0;
  return text;
}
