# Project Overview

3D third-person looter shooter (Borderlands-style vertical slice). Asset library at `../game-assets` (sibling repo) — copied into `public/assets/` via `scripts/copy-assets.mjs` (Phase 2). Browser target via Vite. See ROADMAP.md for the full plan.

# Tech Stack

- You are building a 3D application/game with Babylon.js 8 and TypeScript.
- Use the @babylonjs/core package (ES module imports), NOT the monolithic babylonjs package.
- Use Vite as the build tool.
- Always put source code in the src/ folder.
- Put scenes into src/scenes/
- Put game objects/entities into src/entities/
- Put input handling into src/input/
- Put UI overlays into src/ui/
- Put utility functions into src/utils/
- The entry point is src/main.ts which creates the Engine and starts the render loop.

# Architecture

- Use a <canvas id="renderCanvas"> element in index.html. The Engine attaches to this canvas.
- Create the engine with EngineFactory.CreateAsync(canvas, {}) for automatic WebGPU/WebGL selection.
- Import the WebGPU engine side-effect for factory support: import "@babylonjs/core/Engines/webgpuEngine.js"
- Scene functions accept AbstractEngine (not Engine) so they work with both WebGL and WebGPU engines.
- NEVER import the concrete `Engine` class in scene/entity code — always type against `AbstractEngine`. Importing `Engine` forces WebGL-only and breaks the WebGPU path.
- The render loop is engine.runRenderLoop(() => scene.render()).
- Handle window resize with window.addEventListener("resize", () => engine.resize()).
- Dispose the engine on Vite HMR (`import.meta.hot?.dispose(...)`) so hot reloads don't leak WebGL contexts. main.ts already does this — keep it.
- Use ArcRotateCamera for orbital controls, FreeCamera for first-person, or FollowCamera for third-person.
- Use HemisphericLight for ambient lighting, DirectionalLight for sun-like lighting, PointLight for local sources.
- Per-frame logic must be frame-rate independent. Use `getDeltaSeconds(scene)` from `src/utils/time.ts`, NOT a hardcoded per-frame increment.

# Code Style

- Do NOT use React, HTML DOM elements, or CSS for 3D rendering. Everything renders on the Babylon.js canvas.
- Do NOT install or use shadcn/ui, Tailwind CSS, or any UI component library.
- All @babylonjs/core imports MUST include the .js file extension for proper ES module resolution:
  - import { EngineFactory } from "@babylonjs/core/Engines/engineFactory.js";
  - import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
  - import { Scene } from "@babylonjs/core/scene.js";
  - import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
  - import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
- Import only what you need from @babylonjs/core for tree-shaking.
- NEVER write `import * as BABYLON from "@babylonjs/core"` or `import "@babylonjs/core"`. Both pull in the entire engine and destroy bundle size. Always import named symbols from their deep paths above.
- Use TypeScript interfaces for game data structures.
- For 2D UI overlays (HUD, menus), use @babylonjs/gui and AdvancedDynamicTexture, NOT HTML elements. See `src/ui/Hud.ts` for the stub.

# Side-Effect Imports (the #1 cause of silent black-screen bugs)

Several Babylon features require side-effect imports in addition to their named imports. If you forget these, the feature silently no-ops at runtime. ALWAYS add the matching side-effect when using:

- **Shadows** → `import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js";`
- **glTF / GLB loading** → `import "@babylonjs/loaders/glTF/index.js";` (after `npm i @babylonjs/loaders`)
- **OBJ loading** → `import "@babylonjs/loaders/OBJ/index.js";`
- **Inspector** → `import "@babylonjs/core/Debug/debugLayer.js";` then dynamic-import `@babylonjs/inspector`.
- **Action manager / triggers** → `import "@babylonjs/core/Culling/ray.js";` (for picking) and use `ActionManager` from `Actions/actionManager.js`.
- **Physics (Havok)** → `import "@babylonjs/core/Physics/physicsEngineComponent.js";`
- **PostProcess pipelines** → `import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent.js";`

# Common Patterns

- Create meshes with MeshBuilder (CreateBox, CreateSphere, CreateGround, CreateCylinder, etc.).
- `MeshBuilder.CreateGround` is **single-sided** — if it disappears when the camera goes below it, pass `sideOrientation: Mesh.DOUBLESIDE` or use `CreateGroundFromHeightMap`.
- Apply materials with StandardMaterial or PBRMaterial.
- Load 3D models: install @babylonjs/loaders and use SceneLoader.ImportMeshAsync(). Don't forget the loader side-effect import above.
- Use scene.onBeforeRenderObservable for per-frame updates, and read delta time via `getDeltaSeconds(scene)`.
- Physics: install @babylonjs/havok for Havok physics if physics are needed.
- Shadows: create a ShadowGenerator attached to a DirectionalLight (with the side-effect import above).
- Particle effects: use ParticleSystem from @babylonjs/core.
- Animations: use Animation class or scene.beginAnimation() for keyframe animations.
- Input: use the `Input` helper in `src/input/Input.ts` for held-key state. Don't reinvent per entity.

# Black-Screen Debugging Checklist

When the canvas renders black or empty, check in this order:

1. Did `EngineFactory.CreateAsync` actually resolve? (Check the error overlay in main.ts.)
2. Is there a camera in the scene, and did you call `camera.attachControl(canvas, true)`?
3. Is there at least one light? (HemisphericLight is the cheapest sanity check.)
4. Is the mesh position inside the camera frustum? Default ArcRotateCamera looks at origin — meshes far from origin won't be visible.
5. Is the mesh inside the camera's near/far planes?
6. For shadows: did you import `shadowGeneratorSceneComponent.js`?
7. For glTF loads: did you import the loader side-effect AND await the promise?
8. Did a previous HMR reload leak the WebGL context? Hard refresh and check the browser console for "Too many active WebGL contexts".
