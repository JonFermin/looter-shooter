// Death screen — fullscreen translucent red overlay shown when the player
// dies. Displays waves survived + total kills, then waits for R to restart.
//
// Releases pointer-lock on mount so the player can read the overlay
// without their cursor being captured. The R-handler invokes the
// caller's onRestart callback (Arena.restartGame), then disposes.

// AdvancedDynamicTexture relies on engine.createDynamicTexture, which is
// registered by side-effect from these two files (one for WebGL, one for
// WebGPU). Without them the WebGPU path throws "createDynamicTexture is
// not a function" the first time we build the overlay.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js";

import type { Scene } from "@babylonjs/core/scene.js";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture.js";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle.js";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";

const BACKDROP_COLOR = "#5b0000aa";
const TITLE_COLOR = "#ffeeee";
const STAT_COLOR = "#dddddd";
const PROMPT_COLOR = "#ffcccc";

export interface DeathScreenOptions {
  wavesSurvived: number;
  totalKills: number;
  onRestart: () => void;
}

export class DeathScreen {
  private readonly texture: AdvancedDynamicTexture;
  private readonly onRestart: () => void;
  private keyListener: ((e: KeyboardEvent) => void) | null = null;
  private disposed = false;

  constructor(scene: Scene, opts: DeathScreenOptions) {
    this.onRestart = opts.onRestart;

    // Release pointer-lock so the player can read the overlay without
    // their cursor being captured. Safe even if not currently locked.
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }

    this.texture = AdvancedDynamicTexture.CreateFullscreenUI(
      "deathScreen",
      true,
      scene,
    );

    const backdrop = new Rectangle("deathScreenBackdrop");
    backdrop.width = "100%";
    backdrop.height = "100%";
    backdrop.thickness = 0;
    backdrop.background = BACKDROP_COLOR;
    backdrop.isPointerBlocker = true;
    this.texture.addControl(backdrop);

    const title = new TextBlock("deathScreenTitle");
    title.text = "YOU DIED";
    title.color = TITLE_COLOR;
    title.fontSize = 72;
    title.fontFamily = "monospace";
    title.fontStyle = "bold";
    title.height = "90px";
    title.top = "-120px";
    title.shadowColor = "#000000";
    title.shadowOffsetX = 3;
    title.shadowOffsetY = 3;
    title.shadowBlur = 0;
    title.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    title.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.texture.addControl(title);

    const wavesText = new TextBlock("deathScreenWaves");
    wavesText.text = `Waves survived: ${opts.wavesSurvived}`;
    wavesText.color = STAT_COLOR;
    wavesText.fontSize = 26;
    wavesText.fontFamily = "monospace";
    wavesText.height = "36px";
    wavesText.top = "-30px";
    wavesText.shadowColor = "#000000";
    wavesText.shadowOffsetX = 2;
    wavesText.shadowOffsetY = 2;
    wavesText.shadowBlur = 0;
    wavesText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    wavesText.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.texture.addControl(wavesText);

    const killsText = new TextBlock("deathScreenKills");
    killsText.text = `Total kills: ${opts.totalKills}`;
    killsText.color = STAT_COLOR;
    killsText.fontSize = 26;
    killsText.fontFamily = "monospace";
    killsText.height = "36px";
    killsText.top = "10px";
    killsText.shadowColor = "#000000";
    killsText.shadowOffsetX = 2;
    killsText.shadowOffsetY = 2;
    killsText.shadowBlur = 0;
    killsText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    killsText.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.texture.addControl(killsText);

    const prompt = new TextBlock("deathScreenPrompt");
    prompt.text = "Press R to restart";
    prompt.color = PROMPT_COLOR;
    prompt.fontSize = 22;
    prompt.fontFamily = "monospace";
    prompt.height = "40px";
    prompt.top = "90px";
    prompt.shadowColor = "#000000";
    prompt.shadowOffsetX = 2;
    prompt.shadowOffsetY = 2;
    prompt.shadowBlur = 0;
    prompt.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    prompt.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.texture.addControl(prompt);

    this.keyListener = (e: KeyboardEvent): void => {
      if (this.disposed) return;
      if (e.repeat) return;
      if (e.key !== "r" && e.key !== "R") return;
      e.preventDefault();
      this.onRestart();
      this.dispose();
    };
    window.addEventListener("keydown", this.keyListener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.keyListener) {
      window.removeEventListener("keydown", this.keyListener);
      this.keyListener = null;
    }
    this.texture.dispose();
  }
}
