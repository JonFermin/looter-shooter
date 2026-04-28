// Start screen — fullscreen GUI overlay shown on scene boot. Listens
// for any window-level keydown to start gameplay, then disposes itself.
//
// Window-level keydown (not Input class): the Input helper is gated on
// pointer-lock for clicks, but the start screen explicitly should NOT
// acquire pointer-lock — gameplay flow takes over after dismiss.

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

import { loadSkipIntro, saveSkipIntro } from "../persistence/SaveLoad.js";

const BACKDROP_COLOR = "#000000aa";
const TITLE_COLOR = "#ffffff";
const PROMPT_COLOR = "#cccccc";
const HINT_COLOR = "#9aa3b2";

export class StartScreen {
  private texture: AdvancedDynamicTexture | null = null;
  private readonly onStart: () => void;
  private keyListener: ((e: KeyboardEvent) => void) | null = null;
  private disposed = false;

  constructor(scene: Scene, onStart: () => void) {
    this.onStart = onStart;

    // Skip-intro path: returning users have already seen the title once;
    // fire onStart immediately and never mount the GUI overlay so the
    // arena renders without a one-frame backdrop flash.
    if (loadSkipIntro()) {
      this.disposed = true;
      saveSkipIntro();
      this.onStart();
      return;
    }

    this.texture = AdvancedDynamicTexture.CreateFullscreenUI(
      "startScreen",
      true,
      scene,
    );

    const backdrop = new Rectangle("startScreenBackdrop");
    backdrop.width = "100%";
    backdrop.height = "100%";
    backdrop.thickness = 0;
    backdrop.background = BACKDROP_COLOR;
    backdrop.isPointerBlocker = true;
    this.texture.addControl(backdrop);

    const title = new TextBlock("startScreenTitle");
    title.text = "LOOTER SHOOTER";
    title.color = TITLE_COLOR;
    title.fontSize = 64;
    title.fontFamily = "monospace";
    title.fontStyle = "bold";
    title.height = "80px";
    title.top = "-80px";
    title.shadowColor = "#000000";
    title.shadowOffsetX = 3;
    title.shadowOffsetY = 3;
    title.shadowBlur = 0;
    title.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    title.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.texture.addControl(title);

    const prompt = new TextBlock("startScreenPrompt");
    prompt.text = "Press any key to begin";
    prompt.color = PROMPT_COLOR;
    prompt.fontSize = 24;
    prompt.fontFamily = "monospace";
    prompt.height = "40px";
    prompt.top = "0px";
    prompt.shadowColor = "#000000";
    prompt.shadowOffsetX = 2;
    prompt.shadowOffsetY = 2;
    prompt.shadowBlur = 0;
    prompt.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    prompt.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.texture.addControl(prompt);

    const hint = new TextBlock("startScreenHint");
    hint.text = "WASD move  |  Mouse aim  |  LMB fire  |  R reload  |  Tab inventory";
    hint.color = HINT_COLOR;
    hint.fontSize = 16;
    hint.fontFamily = "monospace";
    hint.height = "30px";
    hint.top = "60px";
    hint.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    hint.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.texture.addControl(hint);

    this.keyListener = (e: KeyboardEvent): void => {
      if (this.disposed) return;
      if (e.repeat) return;
      e.preventDefault();
      saveSkipIntro();
      this.onStart();
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
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
  }
}
