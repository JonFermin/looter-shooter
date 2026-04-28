# Roadmap

> Phase-based with dependency tracking. Tasks within a phase are independent.
> Statuses: `TODO` | `IN PROGRESS` | `DONE`
> Priorities: `P0` (must have) | `P1` (should have) | `P2` (nice to have)
> Sizes: `[S]` (small) | `[M]` (medium) | `[L]` (large — consider splitting)
> Flags: `[SPIKE]` — needs investigation before implementation; `[BLOCKED: reason]` — waiting on external dependency
> Dependencies: `depends: #x, #y` — all must be complete before task starts
> Scope: `scope: path/` — relevant files/directories for the task (required)
> Acceptance: `AC:` — machine-verifiable criteria (indented below task)
> Milestones: `MILESTONE:` — marks demo-able project states
> Completed phases are collapsed to one-line summaries.

## Tech Stack

- Language: TypeScript 5.7 (strict)
- Runtime / target: modern browser (Chromium primary), Node ≥20 for tooling
- Framework: Babylon.js 8.x — `@babylonjs/core`, `@babylonjs/loaders`, `@babylonjs/gui`
- Module system: ES modules with explicit `.js` extensions on `@babylonjs/core` deep imports (tree-shaking — never `import * as BABYLON`)
- Build tool: Vite 6.x
- Project layout: `src/{scenes,entities,input,ui,utils}` per `babylon-template` AI_RULES.md; this project extends with `src/{data,systems,ai,persistence}` and dev sandboxes under `src/scenes/_dev/`
- 3D assets: GLB / glTF in `public/assets/`, loaded via `SceneLoader.ImportMeshAsync` (requires side-effect import `import "@babylonjs/loaders/glTF/index.js"`)
- 2D UI: `@babylonjs/gui` `AdvancedDynamicTexture` overlays. **No React, no HTML/CSS for game UI.**
- Asset source: copy from sibling repo `C:\Users\honsf\DEVELOP\game-assets\` into `public/assets/` via a script — never reference cross-repo at runtime (per game-assets `CLAUDE.md`)
- Build: `npm run build` (`tsc` strict typecheck → `vite build`)
- Test: skipped for vertical slice (no runner installed) — AC verification via build + lint + dev visual check
- Lint: `npm run lint` (`eslint`, added in Phase 1)
- Dev: `npm run dev` (vite dev server)

### Locked design assumptions (filled defaults — flag any to revise)

- Single playable class (Quaternius `Characters_Lis_SingleWeapon` first; if its glTF lacks bones/animations the player task falls back to `kenney/animated-characters-survivors` with the `survivorMaleB` skin and bundled idle/jump/run FBX).
- Weapon pool: 18 Kenney blasters A–R + 4 zombiekit guns (Pistol/SMG/Rifle/Shotgun) = **22 distinct meshes** mapped to 5 archetypes (PISTOL, SMG, RIFLE, SHOTGUN, BLASTER).
- Rarity tiers: COMMON (white) / UNCOMMON (green) / RARE (blue) / EPIC (purple) / LEGENDARY (orange) — Borderlands palette.
- Wave loop: clear-based with a 5s breather; difficulty curve is enemy count + flat HP multiplier per wave (no new enemy types per wave).
- Inventory: 4×6 grid (24 slots), Tab toggles, equip swaps with current weapon and drops the old one to the ground.
- Aim model: hipfire only for v1, no ADS / right-click zoom.
- Death flow: respawn at arena origin, full HP, loadout preserved.
- Currency: tracked counter only — no spending UI in v1.
- Audio: out of scope for v1 (placeholder silent).
- Single arena, single class, no story/dialogue/quests, no vehicles, no elemental damage, no boss enemies — per user-stated out-of-scope list.

## Phase 1 — DONE
Built: Vite + TypeScript + Babylon.js 8 project scaffolded from `babylon-template`, with `@babylonjs/loaders` and `@babylonjs/gui` installed and `eslint` + `@typescript-eslint/*` configured. Smoke scene renders a CreateBox + HemisphericLight + ArcRotateCamera. Patterns: ES module deep imports with `.js` extensions on `@babylonjs/core/...`; `EngineFactory.CreateAsync` for WebGPU/WebGL auto-select; type against `AbstractEngine` (not `Engine`); side-effect imports for loaders/GUI added in `src/main.ts`; HMR-safe engine disposal via `import.meta.hot?.dispose`; per-frame logic uses `getDeltaSeconds(scene)` from `src/utils/time.ts`. ESLint config in `.eslintrc.cjs` with `argsIgnorePattern: "^_"` for unused-var warnings. `tsconfig.json` includes `"types": ["vite/client"]` so `import.meta.hot` resolves. Key files: `package.json` (scripts: `dev`/`build`/`build:dev`/`preview`/`lint`), `src/main.ts` (entry), `src/scenes/Game.ts` (`createGameScene` factory), `src/utils/time.ts`, `AI_RULES.md` (project conventions for all future agents to follow), `CLAUDE.md` (one-liner pointing at AI_RULES.md). (1/1 tasks)

## Phase 2 — Foundations (parallel)

- IN PROGRESS [P0] [M] #2: Asset copy script + initial asset bootstrap into `public/assets/{characters,weapons,enemies,pickups,environment,fx,ui}` + shared `AssetLoader` util — scope: `scripts/copy-assets.mjs`, `public/assets/`, `src/utils/AssetLoader.ts`
  AC: `build` exits 0; `lint` exits 0; running `node scripts/copy-assets.mjs` copies (a) `quaternius/zombieapocalypsekit/Characters/glTF/Characters_Lis_SingleWeapon.gltf` + companion `.bin`/textures, (b) all 18 `kenney/blaster-kit/Models/GLB format/blaster-{a..r}.glb`, (c) `zombieapocalypsekit/Weapons/glTF/{Pistol,SMG,Rifle,Shotgun}.gltf`, (d) `zombieapocalypsekit/Characters/glTF/Zombie_{Basic,Chubby,Ribcage}.gltf` + `kenney/tower-defense-kit/Models/GLB format/enemy-ufo-{a,b}.glb`, (e) `quaternius/ultimatespacekit/Items/GLTF/Pickup_{Bullets,Health,Crate,Sphere}.gltf`, (f) ≥30 GLBs from `kenney/{retro-urban-kit,survival-kit,city-kit-industrial}/Models/GLB format/`, (g) `kenney/2d/{crosshair-pack,minimap-pack,ui-pack-sci-fi,game-icons,particle-pack,smoke-particles,splat-pack}` PNGs into matching `public/assets/{ui,fx}/` subdirs; `src/utils/AssetLoader.ts` exports `loadGLB(scene, path): Promise<AssetContainer>` that wraps `SceneLoader.ImportMeshAsync` with the loader side-effect already imported

- DONE [P0] [S] #3: Input helper — held-key keyboard state + mouse-look pointer-lock + click events — scope: `src/input/Input.ts`
  AC: `build` exits 0; `lint` exits 0; `src/input/Input.ts` exports an `Input` class with `isDown(key: string): boolean`, `getMouseDelta(): {dx,dy}` (resets per frame), `requestPointerLock(canvas)`, `onClick(button, handler)` and `onPointerLockChange(handler)`; usable from any entity without per-entity wiring

- IN PROGRESS [P0] [M] #4: Rarity model + procedural stat-roll system (data + math, no rendering) — scope: `src/data/Rarity.ts`, `src/data/WeaponArchetype.ts`, `src/systems/StatRoll.ts`
  AC: `build` exits 0; `lint` exits 0; `Rarity.ts` exports `enum RarityTier { COMMON, UNCOMMON, RARE, EPIC, LEGENDARY }` plus a `RARITY_COLOR` map of hex strings (white/green/blue/purple/orange) and a `RARITY_WEIGHT` table for drop probability; `WeaponArchetype.ts` exports an `Archetype` enum (PISTOL/SMG/RIFLE/SHOTGUN/BLASTER) with base-stat ranges (damage, fireRate, magazine, reloadTime, accuracy); `StatRoll.ts` exports `rollWeapon(archetype, rarity, seed?): WeaponStats` returning a deterministic-with-seed randomized stat block where higher rarity yields higher stats on average; an inline self-test in the file's main-guard verifies a LEGENDARY roll's mean damage exceeds a COMMON roll's over 1000 samples

## Phase 3 — Player + Arena (parallel) — MILESTONE: walk on a flat plane, fly through the empty settlement

- TODO [P0] [L] #5: Player entity — rigged mesh + idle/walk/run animation playback + third-person `FollowCamera` + WASD movement + mouse-look + jump — depends: #2, #3 — scope: `src/entities/Player.ts`, `src/scenes/Game.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` shows a flat `CreateGround` with the player character standing on it; WASD moves the player relative to camera-forward; mouse rotates the FollowCamera around the player; space jumps with simple gravity (no Havok); animation transitions cleanly between idle ↔ walk/run based on velocity magnitude; `Player.ts` exports `getRightHandTransform()` returning a `TransformNode` for future weapon attachment; no console errors

- TODO [P0] [L] #6: Settlement arena scene — wasteland courtyard from `kenney/retro-urban-kit` + `survival-kit` + a few `city-kit-industrial` buildings — depends: #2 — scope: `src/scenes/Arena.ts`, `src/scenes/_dev/ArenaPreview.ts`
  AC: `build` exits 0; `lint` exits 0; `Arena.ts` exports `buildArena(scene): Promise<{spawnPoint: Vector3, bounds: BoundingBox}>` that loads ≥15 environment GLBs forming an enclosed ~50×50-unit wasteland courtyard with cover props (barrels, crates, ramshackle walls, 2–3 building shells); `_dev/ArenaPreview.ts` is a temporary entry that renders the arena with an `ArcRotateCamera`, a `HemisphericLight`, and a `DirectionalLight`; `dev` (when pointed at the preview) shows a navigable scene with no console errors

## Phase 4 — Combat building blocks (parallel)

- TODO [P0] [L] #7: Weapon entity — mesh attached to player hand transform, raycast firing with tracer line, muzzle-flash particle, ammo + reload — plus weapon database mapping the 22 mesh paths to archetypes — depends: #4, #5 — scope: `src/entities/Weapon.ts`, `src/data/WeaponDatabase.ts`, `src/systems/Combat.ts`, `src/scenes/_dev/WeaponDemo.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` (pointed at `WeaponDemo`) shows the player from Phase 3 holding a procedurally-generated weapon mesh attached to the right-hand transform; left-click fires a raycast forward from the camera with a tracer line that fades over 200ms; a particle muzzle-flash plays at the barrel tip; an in-world debug text `Ammo: N/M` decrements per shot; `R` reloads with `archetype.reloadTime` cooldown then refills magazine; `Combat.ts` exposes a `fire(weapon, scene): Hit | null` API that returns the hit point + hit mesh ID (or null on miss) so enemies can react in Phase 5

- TODO [P0] [L] #8: Enemy AI — zombie variants (Basic / Chubby / Ribcage) + UFO flyer with state machine `IDLE → CHASE → ATTACK → DEAD` — depends: #5 — scope: `src/entities/Enemy.ts`, `src/ai/EnemyStateMachine.ts`, `src/scenes/_dev/EnemyDemo.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` (pointed at `EnemyDemo`) renders the player + 3 zombie variants on flat ground + 1 UFO above; zombies idle until the player enters a 15-unit detection radius then chase at walking speed and trigger an `attack` event when within 2 units (cooldown 1s); the UFO holds altitude and fires a tracer-only raycast at the player every 2s when in line of sight; each enemy exposes `takeDamage(amount: number): void`, `isDead: boolean`, and an `onDeath` observable; on death the mesh plays a brief sink-and-disappear tween

- TODO [P0] [M] #9: Loot drop entity — rarity-colored vertical light beam, ground pickup mesh, interact-to-pickup — depends: #4, #5 — scope: `src/entities/LootDrop.ts`, `src/systems/LootSystem.ts`, `src/scenes/_dev/LootDemo.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` (pointed at `LootDemo`) — pressing `G` spawns a `LootDrop` at a fixed position with `rollWeapon(...)` stats and a randomly-rolled rarity; the drop renders the matching weapon mesh below a vertical column of light colored from `RARITY_COLOR`; walking within 2 units and pressing `E` logs the pickup's rolled stats to console and despawns the drop; `LootSystem.ts` exports `spawnLoot(scene, position, weapon): LootDrop` and `nearestPickup(player): LootDrop | null`

## Phase 5 — Combat integration — MILESTONE: shoot a zombie in the settlement, get a drop

- TODO [P0] [M] #10: Wire Phase 4 modules into Arena — weapon→enemy damage, enemy→player damage, kill→loot drop, player death+respawn — depends: #6, #7, #8, #9 — scope: `src/scenes/Arena.ts`, `src/entities/Player.ts`, `src/entities/Enemy.ts`, `src/systems/Combat.ts`, `src/main.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` loads `Arena` (not the dev sandboxes) — the player spawns at `Arena.spawnPoint` holding a starter weapon; 3 zombies + 1 UFO are placed manually in the arena; left-click fires and `Combat.fire()` damages the hit enemy; killed enemies invoke `LootSystem.spawnLoot` with rarity weighted by enemy archetype (UFO drops higher tier); enemies in melee range deal damage to the player's HP (starting 100); reaching 0 HP logs `you died` and respawns at `spawnPoint` with full HP and the same equipped weapon

## Phase 6 — HUD + Wave loop (parallel)

- TODO [P0] [L] #11: HUD overlay built with `@babylonjs/gui` — health bar, shield bar, ammo counter, crosshair PNG — depends: #5, #7 — scope: `src/ui/Hud.ts`, `src/main.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` shows a HUD `AdvancedDynamicTexture` overlay with: a health bar bottom-left that drains as the player takes damage and refills on `Pickup_Health`; a shield bar above it (regen 5/s after 3s out of combat, max 100); a `current/reserve` ammo readout bottom-right; a centered crosshair from `kenney/2d/crosshair-pack` rendered around the pointer-lock cursor; HUD updates every frame and disposes cleanly on scene change

- TODO [P0] [L] #12: Wave spawner — clear-based escalating waves with 5s breather, count + HP scaling — depends: #6, #8, #10 — scope: `src/systems/WaveSpawner.ts`, `src/scenes/Arena.ts`, `src/ui/Hud.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` in `Arena` — wave 1 spawns 3 Basic zombies; clearing all enemies starts a 5s breather then wave 2 spawns 5 zombies (mix of variants) + 1 UFO; wave 3 spawns 8 zombies + 2 UFOs with 1.5× HP; HUD displays `Wave N — X/Y enemies` indicator; spawn positions are randomized within the arena bounds but ≥10 units from the player

## Phase 7 — Inventory + Loot polish (parallel)

- TODO [P0] [L] #13: Inventory UI — 4×6 grid with rarity-colored item cards, equip / compare / discard, Tab to toggle — depends: #4, #7, #9 — scope: `src/ui/Inventory.ts`, `src/entities/Player.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` — `Tab` opens an inventory panel built with `@babylonjs/gui` showing a 4×6 grid; picking up loot adds a card to the next empty slot showing weapon name + archetype icon (from `kenney/2d/game-icons`) + damage / fireRate / magazine, with a colored border per `RarityTier`; clicking a card shows a compare-with-equipped tooltip side-by-side; `E` equips the selected card (swaps with current weapon, dropping the old one as a `LootDrop` at the player's feet); `X` discards; `Player.ts` exposes `inventory: WeaponStats[]` and `equipped: WeaponStats` for save/load to consume

- TODO [P1] [S] #14: Damage numbers (world-space billboards on hit) + crosshair hit-marker flash — depends: #10 — scope: `src/ui/DamageNumbers.ts`, `src/systems/Combat.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` — hitting an enemy spawns a yellow billboard text `damage` above the impact that drifts up + fades over 800ms; the HUD crosshair briefly flashes white on hit confirmation; `Combat.ts` emits an `onHit` observable consumed by both `DamageNumbers.ts` and `Hud.ts`

## Phase 8 — Persistence + Polish — MILESTONE: vertical slice playable end-to-end

- TODO [P0] [M] #15: Save / load loadout to `localStorage` — equipped weapon + inventory + currency + total kills — restore on page load — depends: #13 — scope: `src/persistence/SaveLoad.ts`, `src/entities/Player.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` — equipping a weapon and reloading the page restores the same equipped weapon (same archetype, same rolled stats, same rarity) and full inventory; kill counter and currency persist across reloads; the save key is namespaced (`looter-shooter:save:v1`); clearing `localStorage` resets to defaults; schema version field present so v2 saves can migrate

- TODO [P1] [M] #16: Minimap — top-down second-camera render to GUI texture, framed by `kenney/2d/minimap-pack` — depends: #5, #8 — scope: `src/ui/Minimap.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` shows a circular minimap top-right (~180×180px); the player appears as a centered orientation-arrow; enemies render as red dots; loot drops render as dots colored from `RARITY_COLOR`; the frame uses a `kenney/2d/minimap-pack` PNG; the minimap updates every frame without dropping main-camera fps below 60 on a mid-range Chromium

- TODO [P1] [M] #17: Start screen + death screen + restart flow — depends: #12 — scope: `src/ui/StartScreen.ts`, `src/ui/DeathScreen.ts`, `src/scenes/Arena.ts`
  AC: `build` exits 0; `lint` exits 0; `dev` — on page load a `StartScreen` overlay shows `LOOTER SHOOTER — Press any key to begin` + faint background of the arena; key press hides the overlay and starts wave 1; on player death a translucent `DeathScreen` overlays `YOU DIED — Press R to restart` showing waves survived + total kills; `R` resets waves to 1, restores player HP, respawns at `Arena.spawnPoint`, and preserves the loadout
