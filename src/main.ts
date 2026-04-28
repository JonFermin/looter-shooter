import { EngineFactory } from "@babylonjs/core/Engines/engineFactory.js";
import "@babylonjs/core/Engines/webgpuEngine.js";
import "@babylonjs/loaders/glTF/index.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { createGameScene } from "./scenes/Game.js";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

let engineRef: AbstractEngine | undefined;

try {
  const engine = await EngineFactory.CreateAsync(canvas, {});
  engineRef = engine;
  applyHardwareScaling(engine);

  const scene = await createGameScene(engine, canvas);

  engine.runRenderLoop(() => scene.render());

  const disposeResize = observeCanvasResize(canvas, () => engine.resize());
  const disposeDprWatch = watchDevicePixelRatio(() =>
    applyHardwareScaling(engine),
  );

  setupInspectorToggle(scene);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      disposeResize();
      disposeDprWatch();
      scene.dispose();
      engine.dispose();
    });
  }
} catch (err) {
  showFatalError(err, engineRef);
}

// Cap the renderer at 2x device pixel ratio. Higher DPR (common on phones
// and 4K laptops) tanks perf with little visual gain. Re-applied on DPR
// change via matchMedia in watchDevicePixelRatio().
function applyHardwareScaling(engine: AbstractEngine) {
  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  engine.setHardwareScalingLevel(1 / dpr);
}

// ResizeObserver catches CSS-driven layout changes (sidebar toggles, split
// panes, devtools docked). `window.resize` misses those and the canvas
// goes stretched. Falls back to window.resize if the API is missing.
function observeCanvasResize(target: HTMLCanvasElement, onResize: () => void) {
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => onResize());
    ro.observe(target);
    return () => ro.disconnect();
  }
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}

function watchDevicePixelRatio(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const handler = () => onChange();
  mql.addEventListener?.("change", handler);
  return () => mql.removeEventListener?.("change", handler);
}

function setupInspectorToggle(scene: Scene) {
  window.addEventListener("keydown", async (e) => {
    if (e.key !== "i" && e.key !== "I") return;
    try {
      await import("@babylonjs/core/Debug/debugLayer.js");
      // Build a non-literal specifier so Vite's import-analysis skips it.
      // Inspector is an optional dev dependency that may not be installed.
      const inspectorPkg = ["@babylonjs", "inspector"].join("/");
      await import(/* @vite-ignore */ inspectorPkg);
      if (scene.debugLayer.isVisible()) {
        scene.debugLayer.hide();
      } else {
        await scene.debugLayer.show({ overlay: true });
      }
    } catch {
      console.warn(
        "Babylon Inspector not installed. Run: npm i -D @babylonjs/inspector",
      );
    }
  });
}

function showFatalError(err: unknown, engine?: AbstractEngine) {
  console.error(err);
  const engineName = engine?.getClassName?.() ?? "(engine not created)";
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#1a1a2e;color:#fff;font-family:system-ui,sans-serif;padding:2rem;text-align:center;";
  const safeEngine = escapeHtml(engineName);
  const safeMessage = escapeHtml(message);
  overlay.innerHTML = `<div><h1 style="margin-bottom:1rem;">Failed to start Babylon engine</h1><p style="margin-bottom:1rem;opacity:0.8;">Engine: ${safeEngine}</p><pre style="white-space:pre-wrap;color:#ff8a8a;text-align:left;max-width:80ch;">${safeMessage}</pre></div>`;
  document.body.appendChild(overlay);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
