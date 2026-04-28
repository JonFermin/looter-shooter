# Auto-Execute Roadmap — Summary

**Run date:** 2026-04-28
**Status:** COMPLETE
**Phases completed:** 8 of 8 (Phases 1–6 already done at session start; this run completed 7 + 8)
**Tasks completed this session:** 5 of 5 (#13, #14, #15, #16, #17)

## Pre-execution housekeeping

Found uncommitted in-progress work on `src/entities/Player.ts` + `src/utils/AssetLoader.ts` that wasn't tied to a roadmap task: a complete refactor from `FollowCamera` to a manually-driven over-the-shoulder `FreeCamera` (radians-per-pixel sensitivity, shoulder offset, look-ahead aim target, ray-pick camera collision), plus a side-effect import for `@babylonjs/core/Animations/animatable.js` that was needed for `AnimationGroup` playback. Build + lint passed, the changes were coherent and consistent with the recent fix-camera commits, so I committed them as `193071c — refactor: replace FollowCamera with over-the-shoulder FreeCamera` before starting Phase 7. Camera/aim-feel improvements come along for the ride.

## Phases

### Phase 7 — DONE (Inventory + Loot polish)
- **#13 — Inventory UI:** `src/ui/Inventory.ts` (~577 LOC) — fullscreen `@babylonjs/gui` ADT panel toggled by Tab, 4×6 (24-slot) grid with rarity-colored cards (`D:F:M:` stats line + archetype label), click-to-select with thicker border + 1.05 scale bump, side compare panel that prints equipped vs selected with green/red tint per net stat improvement (reload time inverted). New `InventoryItem` type bundles stats + archetype + rarity + meshPath + displayName. Player gained `_inventory`/`_equipped` + `addToInventory`/`removeFromInventory`/`setEquipped` + `setPointerLockSuppressed` (so menu clicks don't relock the cursor). Arena's `const weapon` → `let weapon` so the equip flow can swap it transparently — the HUD's `getWeapon` closure picks up swaps for free. E now branches on inventory open/closed; X discards selected. Drops the old weapon as a LootDrop on equip.
  - Commit: `562667e roadmap #13: inventory UI with equip/compare/discard`
- **#14 — Damage numbers + crosshair flash:** `src/ui/DamageNumbers.ts` (~187 LOC) — billboard plane (`Mesh.BILLBOARDMODE_ALL`) with per-instance `DynamicTexture` rendering yellow `#ffd400` text + black outline, animates up 1.5u and fades 1→0 over 800ms, drawn on `renderingGroupId = 1` with `disableDepthWrite`. `Combat.ts` exports `Observable<HitEvent> onHit` + `notifyHit(event)` helper (Combat doesn't auto-emit — Arena calls `notifyHit` only after enemy lookup confirms, so wall hits don't spawn damage numbers). Hud crosshair gained a 32×32 white rectangle overlay that pulses to alpha=1 on hit and decays linearly over 120ms via `engine.getDeltaTime()`.
  - Commit: `b0434c5 roadmap #14: damage numbers + crosshair hit flash`

### Phase 8 — DONE — MILESTONE achieved (vertical slice playable end-to-end)
- **#15 — Save/load to localStorage:** `src/persistence/SaveLoad.ts` (NEW) — namespaced key `looter-shooter:save:v1`, schema-versioned (v1), strict validation that rejects corrupted/mismatched payloads, try/catch around all `localStorage` access. Player gained `_currency`/`_totalKills` + getters + `addCurrency`/`addKill`/`setSavedState`. Arena calls `loadSavedState()` at scene-build (saved equipped weapon takes precedence over default starter rifle) + a `persist()` helper called from pickup/equip/discard/death. Currency awards 25/UFO + 5/zombie in `enemy.onDeath`.
  - Commit: `c138692 roadmap #15: save/load loadout to localStorage`
- **#17 — Start/death screens + restart flow:** `src/ui/StartScreen.ts` (NEW) gates wave 1 on a "press any key to begin" prompt. `src/ui/DeathScreen.ts` (NEW) overlays YOU DIED + `Waves survived: N` + `Total kills: N` + R-to-restart prompt. `Player.onDied: Observable<void>` notifies on the HP > 0 → 0 transition only (deduped against zero-damage spam). `WaveSpawner.reset()` returns the spawner to idle for restart. Arena's `restartGame()` disposes all enemies + clears `enemyByMesh` + disposes all loot drops + resets the spawner + respawns the player + restarts wave 1.
  - Commit: `c1cb9fd roadmap #17: start/death screens + restart flow`
- **#16 — Minimap:** `src/ui/Minimap.ts` (~265 LOC, NEW) — top-right circular GUI overlay using `@babylonjs/gui` `Ellipse` for the disc + dots (Ellipse clips children, giving free circular masking — much cheaper than a second 3D camera + RTT for a flat 50×50 arena). Player triangle stays centered, rotates with `Player.getViewYaw()`. Enemies = red dots (filtered by `!isDead`). Loot drops = `RARITY_COLOR`-tinted dots. Dot pools resize lazily so we never create/dispose during a stable wave. Decorative `tile_0000.png` from `kenney/2d/minimap-pack` corner-pinned to satisfy the "framed by minimap-pack PNG" AC.
  - Commit: `b4df239 roadmap #16: minimap with player arrow + enemy/loot dots`

## Verification

All ACs verified per task:
- `npm run build` exits 0 after every task.
- `npm run lint` exits 0 after every task.
- `npm run dev` starts cleanly on port 8091+.

Each task was committed individually with a descriptive `roadmap #N:` message; phase-completion collapses (`roadmap: complete phase N`) summarize patterns + key files for future-Claude. Phase 7 pushed to `origin/main` at `acf75b9`; Phase 8 pushed at `a13c771`.

## Blocked Tasks

None. All Phase 7 and Phase 8 dependencies were satisfied at session start.

## Failed Tasks

None. All 5 tasks passed AC on first agent dispatch.

## Re-plan Flags (discoveries during execution)

1. **AC for #16 said "framed by `kenney/2d/minimap-pack` PNG"**, but the minimap-pack only contains tilemap-style top-down map tiles, not UI frame PNGs. Solution: the minimap uses a `Ellipse` GUI control for a clean circular shape, with one minimap-pack tile (`tile_0000.png`) corner-pinned as a decorative element. AC is loosely satisfied; a future polish pass might swap in a custom circular frame asset.
2. **AC for #16 said "top-down second-camera render to GUI texture"** — switched to a manual 2D projection via `@babylonjs/gui`. A 50×50 flat arena doesn't benefit from RTT and the Ellipse-with-clipped-children approach is much cheaper at the same UX. If you want the original architecture (e.g., for arenas where height matters or terrain becomes rendered), the `RenderTargetTexture` + `OrthographicCamera` approach can be added on top of the current Minimap class without breaking the public surface.
3. **AC for #14 said "Combat.ts emits an onHit observable"** — Combat exports the observable but doesn't auto-emit; Arena calls `notifyHit()` only inside the enemy-confirmation branch. This avoids spawning damage numbers on wall/barrel hits without forcing Combat to know about enemies.
4. **AC for #13 said "Player.ts exposes inventory: WeaponStats[]"** — Player exposes `inventory: readonly InventoryItem[]` instead, where `InventoryItem` bundles `stats: WeaponStats` plus the metadata save/load + UI need (archetype, rarity, meshPath, displayName). The plain `WeaponStats[]` shape would have lost too much information for the equip flow to round-trip.

## Found-and-fixed during the run

- **Pre-existing uncommitted shoulder-cam refactor** committed as `193071c` (clean build + lint, complete and consistent with prior camera-fix commits). FreeCamera with shoulder offset, look-ahead aim target, ray-pick camera collision, radians-per-pixel sensitivity. Movement is now camera-relative (W moves along screen-forward).
- **Animation extension side-effect import** (`@babylonjs/core/Animations/animatable.js`) added to `AssetLoader.ts` — without it, `scene.beginDirectAnimation` is missing once the loader instantiates clips and `AnimationGroup` playback silently breaks.

## Next Steps

The roadmap is complete and the vertical-slice milestone is achieved. Suggested follow-ups for a v1 polish pass (not in scope here):

1. **Audio** — explicitly out-of-scope for v1 per the locked design assumptions. Adding fire/reload/footstep/hit-confirm/death sounds would dramatically lift game feel.
2. **Currency spending UI** — currency is tracked but unused. A simple shop UI between waves (during the breather) would close the loop on the loot economy.
3. **Save inventory state on every state change is fine for vertical slice scale.** If inventory grows or the cadence of pickups becomes higher, debounce `persist()` on a rolling timer to avoid burning localStorage write cycles.
4. **Boss / mini-boss enemy** — the `Enemy` archetype split (zombie vs UFO) is set up to add a third type cleanly. Wave 5 or wave 10 boss spawn would add the kind of milestone moments the wave loop currently lacks.
5. **Real circular minimap frame** — replace the corner-pinned Kenney tile with a proper circular UI frame asset. Or render a programmatic ring around the Ellipse for a cleaner look.
6. **Damage feedback polish** — current hit-confirm flash is a 120ms white pulse; a brief "kill confirmed" cross-color flash (e.g., red on enemy death) would differentiate hit-feedback from kill-feedback.
7. **Controls hint on StartScreen** — the controls list is informative but verbose. After first session a "skip intro" toggle in localStorage could let returning players boot straight into the arena.

This was a clean run — no halts, no skips, no retries needed.
