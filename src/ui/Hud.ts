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
import { Image } from "@babylonjs/gui/2D/controls/image.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";

import type { Player } from "../entities/Player.js";
import type { Weapon } from "../entities/Weapon.js";
import type { WaveState } from "../systems/WaveSpawner.js";

// Crosshair PNG: Kenney crosshair-pack #007 (clean broken-plus, white).
// Picked by inspecting the preview sheet; reads cleanly against both the
// dusty courtyard ground and the desaturated sky.
const CROSSHAIR_PATH = "/assets/ui/crosshair-pack/PNG/White/crosshair007.png";
const CROSSHAIR_SIZE_PX = 32;

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
  private readonly crosshair: Image;

  private waveState: WaveState | null = null;

  private updateObserver: Nullable<Observer<Scene>> = null;
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

    // ---- Crosshair (centered) ----
    this.crosshair = new Image("hudCrosshair", CROSSHAIR_PATH);
    this.crosshair.width = `${CROSSHAIR_SIZE_PX}px`;
    this.crosshair.height = `${CROSSHAIR_SIZE_PX}px`;
    this.crosshair.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.crosshair.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.crosshair.stretch = Image.STRETCH_UNIFORM;
    this.texture.addControl(this.crosshair);

    // Initial sync so the HUD reads correctly on the very first rendered
    // frame, before onBeforeRender has fired even once.
    this.refresh();

    this.updateObserver = scene.onBeforeRenderObservable.add(() => {
      this.refresh();
    });
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
      this.waveText.text =
        `Wave ${state.waveNumber} — ` +
        `${state.enemiesAlive}/${state.enemiesTotal} enemies`;
      return;
    }
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.updateObserver) {
      this.scene.onBeforeRenderObservable.remove(this.updateObserver);
      this.updateObserver = null;
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
