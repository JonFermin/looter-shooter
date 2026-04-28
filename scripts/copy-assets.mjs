#!/usr/bin/env node
// Copies the curated set of game-assets into public/assets/ for runtime use.
// Idempotent: re-running is a no-op when destination files exist with matching
// size. Resolves source root relative to this script so it works regardless of
// the user's cwd. Per game-assets/CLAUDE.md, consuming projects must copy out;
// nothing in src/ should reach across the repo at runtime.
//
// GLB companion textures (Phase 3 / roadmap #18):
// Kenney 3D GLBs reference companion PNGs via external URI fields like
// `Textures/colormap.png`. Babylon's loader resolves those relative to the
// GLB URL, so we mirror them next to each GLB. Each top-level category
// (environment/, weapons/, enemies/) gets a single shared `Textures/`
// folder colocated with its GLBs.
//
// Collision strategy (Option B — flat with documented winners):
// `colormap.png` differs across kits but several kits ship one named that.
// We accept a documented "last write wins" merge per category:
//   - environment/Textures/colormap.png -> city-kit-industrial wins
//     (registered last in ENVIRONMENT_GLBS; survival-kit's variant is
//     visually equivalent for the courtyard preview)
//   - weapons/Textures/colormap.png     -> blaster-kit (only kit there)
//   - enemies/Textures/colormap.png     -> tower-defense-kit (only kit)
// To preserve idempotency we *plan* companion copies during GLB scanning
// and flush them once per category — without that, two kits writing the
// same destination would ping-pong on every run. Whenever a collision is
// detected, the script prints a `companion-collision` warning naming the
// winner and skipped owners so future kit additions surface the conflict
// instead of silently swapping textures.

import { readdir, mkdir, copyFile, stat, readFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, basename, posix } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const SRC_ROOT = resolve(REPO_ROOT, "..", "game-assets");
const DEST_ROOT = resolve(REPO_ROOT, "public", "assets");

let totalCopied = 0;
let totalSkipped = 0;
let totalBytes = 0;
let failures = 0;

// ---------------------------------------------------------------------------
// Curated asset manifest. Every entry below is verified in `game-assets/`.
// ---------------------------------------------------------------------------

// Quaternius Lis is the Phase 3 player mesh.
const CHARACTER_GLTFS = [
  "quaternius/3d/zombieapocalypsekit/Characters/glTF/Characters_Lis_SingleWeapon.gltf",
  // Zombies live in characters/ rather than enemies/ because they're rigged.
  "quaternius/3d/zombieapocalypsekit/Characters/glTF/Zombie_Basic.gltf",
  "quaternius/3d/zombieapocalypsekit/Characters/glTF/Zombie_Chubby.gltf",
  "quaternius/3d/zombieapocalypsekit/Characters/glTF/Zombie_Ribcage.gltf",
];

// 18 Kenney blasters A..R + 4 Quaternius zombiekit firearms = 22 weapon meshes
// mapped to 5 archetypes in Phase 4 (#7 WeaponDatabase).
const WEAPON_GLBS = "abcdefghijklmnopqr"
  .split("")
  .map((c) => `kenney/3d/blaster-kit/Models/GLB format/blaster-${c}.glb`);

const WEAPON_GLTFS = [
  "quaternius/3d/zombieapocalypsekit/Weapons/glTF/Pistol.gltf",
  "quaternius/3d/zombieapocalypsekit/Weapons/glTF/SMG.gltf",
  "quaternius/3d/zombieapocalypsekit/Weapons/glTF/Rifle.gltf",
  "quaternius/3d/zombieapocalypsekit/Weapons/glTF/Shotgun.gltf",
];

// UFO flyers from tower-defense-kit; zombies handled above.
const ENEMY_GLBS = [
  "kenney/3d/tower-defense-kit/Models/GLB format/enemy-ufo-a.glb",
  "kenney/3d/tower-defense-kit/Models/GLB format/enemy-ufo-b.glb",
];

const PICKUP_GLTFS = [
  "quaternius/3d/ultimatespacekit/Items/GLTF/Pickup_Bullets.gltf",
  "quaternius/3d/ultimatespacekit/Items/GLTF/Pickup_Health.gltf",
  "quaternius/3d/ultimatespacekit/Items/GLTF/Pickup_Crate.gltf",
  "quaternius/3d/ultimatespacekit/Items/GLTF/Pickup_Sphere.gltf",
];

// Curated >=30 environment GLBs across three Kenney kits, picked for a
// wasteland-courtyard build (cover props + walls + a few building shells).
const ENVIRONMENT_GLBS = [
  // retro-urban-kit (12) — buildings, walls, dumpsters, barriers, road tiles
  "kenney/3d/retro-urban-kit/Models/GLB format/wall-a.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/wall-a-corner.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/wall-a-door.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/wall-a-window.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/wall-broken-type-a.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/wall-broken-type-b.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/detail-dumpster-closed.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/detail-dumpster-open.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/detail-barrier-strong-type-a.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/detail-barrier-strong-damaged.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/pallet.glb",
  "kenney/3d/retro-urban-kit/Models/GLB format/road-asphalt-damaged.glb",
  // survival-kit (12) — barrels, crates, fences, rocks, wood resources
  "kenney/3d/survival-kit/Models/GLB format/barrel.glb",
  "kenney/3d/survival-kit/Models/GLB format/barrel-open.glb",
  "kenney/3d/survival-kit/Models/GLB format/box.glb",
  "kenney/3d/survival-kit/Models/GLB format/box-open.glb",
  "kenney/3d/survival-kit/Models/GLB format/box-large.glb",
  "kenney/3d/survival-kit/Models/GLB format/box-large-open.glb",
  "kenney/3d/survival-kit/Models/GLB format/fence.glb",
  "kenney/3d/survival-kit/Models/GLB format/fence-fortified.glb",
  "kenney/3d/survival-kit/Models/GLB format/rock-a.glb",
  "kenney/3d/survival-kit/Models/GLB format/rock-b.glb",
  "kenney/3d/survival-kit/Models/GLB format/resource-planks.glb",
  "kenney/3d/survival-kit/Models/GLB format/resource-wood.glb",
  // city-kit-industrial (8) — building shells + chimneys for skyline
  "kenney/3d/city-kit-industrial/Models/GLB format/building-a.glb",
  "kenney/3d/city-kit-industrial/Models/GLB format/building-c.glb",
  "kenney/3d/city-kit-industrial/Models/GLB format/building-f.glb",
  "kenney/3d/city-kit-industrial/Models/GLB format/building-h.glb",
  "kenney/3d/city-kit-industrial/Models/GLB format/building-l.glb",
  "kenney/3d/city-kit-industrial/Models/GLB format/building-q.glb",
  "kenney/3d/city-kit-industrial/Models/GLB format/chimney-medium.glb",
  "kenney/3d/city-kit-industrial/Models/GLB format/detail-tank.glb",
];

// 2D PNG packs — copy each pack tree as-is into ui/ or fx/ keeping pack name.
const FX_PACKS = ["particle-pack", "smoke-particles", "splat-pack"];
const UI_PACKS = [
  "crosshair-pack",
  "minimap-pack",
  "ui-pack-sci-fi",
  "game-icons",
];

// ---------------------------------------------------------------------------
// File-copy helpers
// ---------------------------------------------------------------------------

async function copyOneFile(srcAbs, destAbs) {
  if (!existsSync(srcAbs)) {
    console.error(`  MISSING: ${srcAbs}`);
    failures += 1;
    return { copied: false, bytes: 0, overwroteDifferent: false };
  }
  const srcStat = await stat(srcAbs);
  let overwroteDifferent = false;
  if (existsSync(destAbs)) {
    const destStat = await stat(destAbs);
    if (destStat.size === srcStat.size) {
      totalSkipped += 1;
      return { copied: false, bytes: srcStat.size, overwroteDifferent: false };
    }
    // Size mismatch — we're overwriting an existing file with different
    // content. Bubble that up so callers can warn on companion clashes.
    overwroteDifferent = true;
  }
  await mkdir(dirname(destAbs), { recursive: true });
  await copyFile(srcAbs, destAbs);
  totalCopied += 1;
  totalBytes += srcStat.size;
  return { copied: true, bytes: srcStat.size, overwroteDifferent };
}

// Parse the JSON chunk out of a binary glTF (.glb). GLB layout per the
// Khronos spec:
//   - 12-byte header: magic("glTF"), version (u32), length (u32)
//   - chunk 0: u32 length, u32 type ("JSON"), then `length` bytes of JSON
//     padded with 0x20 to a 4-byte boundary
//   - chunk 1: BIN buffer (we don't need it for companion-texture discovery)
// Returns the parsed JSON object, or null if parsing fails — callers should
// log a warning and continue (we still copied the GLB itself).
async function parseGlbJsonChunk(srcAbs) {
  if (!existsSync(srcAbs)) return null;
  let fh;
  try {
    fh = await open(srcAbs, "r");
  } catch {
    return null;
  }
  try {
    const header = Buffer.alloc(12);
    await fh.read(header, 0, 12, 0);
    const magic = header.toString("ascii", 0, 4);
    if (magic !== "glTF") return null;
    const chunkHeader = Buffer.alloc(8);
    await fh.read(chunkHeader, 0, 8, 12);
    const chunkLen = chunkHeader.readUInt32LE(0);
    const chunkType = chunkHeader.toString("ascii", 4, 8);
    if (chunkType !== "JSON") return null;
    const jsonBuf = Buffer.alloc(chunkLen);
    await fh.read(jsonBuf, 0, chunkLen, 20);
    // Trim trailing 0x20 padding before parsing.
    let end = jsonBuf.length;
    while (end > 0 && jsonBuf[end - 1] === 0x20) end -= 1;
    return JSON.parse(jsonBuf.toString("utf8", 0, end));
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// Per-run cache of companion writes: destAbs -> srcAbs. Used to make the
// companion-copy idempotent across kits that share a filename: only the
// LAST source registered for a given destination actually gets copied,
// matching the documented "last write wins" precedence in the script
// header. Without this, idempotency would break — re-running with two
// kits that both ship `Textures/colormap.png` would ping-pong overwrite
// the destination on every invocation. We also use the cache to log a
// single collision warning per destination instead of one per visit.
const companionPlan = new Map();
const companionCollisions = new Map();

function planCompanion(srcAbs, destAbs, ownerRel) {
  const prev = companionPlan.get(destAbs);
  if (prev && prev.srcAbs !== srcAbs) {
    const list = companionCollisions.get(destAbs) ?? [];
    if (!list.includes(prev.ownerRel)) list.push(prev.ownerRel);
    list.push(ownerRel);
    companionCollisions.set(destAbs, list);
  }
  companionPlan.set(destAbs, { srcAbs, ownerRel });
}

// Copy a .glb and *plan* (don't yet copy) any external companions it
// references. The actual companion copy happens later via
// `flushCompanionPlan` so we can apply last-writer-wins precedence
// across kits that share a filename (see header comment for the
// collision strategy). Companions are matched against the GLB's own
// directory so Babylon's relative-URI resolution finds them at runtime.
async function copyGlbWithCompanions(srcRel, destRel) {
  const srcAbs = join(SRC_ROOT, srcRel);
  const destAbs = join(DEST_ROOT, destRel);
  const main = await copyOneFile(srcAbs, destAbs);
  let companions = 0;
  const gltf = await parseGlbJsonChunk(srcAbs);
  if (!gltf) {
    if (main.bytes > 0) {
      console.warn(`  WARN: ${srcRel} GLB JSON unreadable; copied without scanning companions`);
    }
    return { mainBytes: main.bytes, companions, companionBytes: 0 };
  }
  const refs = [];
  for (const img of gltf.images ?? []) {
    if (img.uri && !img.uri.startsWith("data:")) refs.push(img.uri);
  }
  for (const buf of gltf.buffers ?? []) {
    if (buf.uri && !buf.uri.startsWith("data:")) refs.push(buf.uri);
  }
  const srcDir = dirname(srcAbs);
  const destDir = dirname(destAbs);
  for (const uri of refs) {
    const decoded = decodeURI(uri);
    const refSrc = resolve(srcDir, decoded);
    const refDest = resolve(destDir, decoded);
    planCompanion(refSrc, refDest, srcRel);
    companions += 1;
  }
  return { mainBytes: main.bytes, companions, companionBytes: 0 };
}

// Execute the planned companion copies. Called once per category after
// all GLBs in that category have been registered, so that last-writer-
// wins precedence within the category is final before we touch disk.
async function flushCompanionPlan() {
  let copied = 0;
  let bytes = 0;
  for (const [destAbs, { srcAbs }] of companionPlan) {
    const r = await copyOneFile(srcAbs, destAbs);
    if (r.copied || r.bytes > 0) {
      copied += 1;
      bytes += r.bytes;
    }
  }
  for (const [destAbs, owners] of companionCollisions) {
    const winner = companionPlan.get(destAbs);
    const rel = relative(DEST_ROOT, destAbs).split(/[\\/]/).join("/");
    const losers = owners.filter((o) => o !== winner?.ownerRel);
    console.warn(
      `  WARN: companion-collision ${rel} — chose ${winner?.ownerRel}, skipped ${losers.join(", ")}`,
    );
  }
  companionPlan.clear();
  companionCollisions.clear();
  return { copied, bytes };
}

// Quaternius glTFs in this repo embed all buffers/images as base64 data URIs,
// so there is nothing external to chase. We still parse the JSON and copy any
// non-data buffer/image URIs if present (defensive, future-proof). Texture
// folders alongside Kenney FBX/OBJ kits are unrelated to the glTF binding and
// are deliberately ignored.
async function copyGltfWithCompanions(srcRel, destRel) {
  const srcAbs = join(SRC_ROOT, srcRel);
  const destAbs = join(DEST_ROOT, destRel);
  const main = await copyOneFile(srcAbs, destAbs);
  let companions = 0;
  let companionBytes = 0;
  try {
    const jsonText = await readFile(srcAbs, "utf8");
    const gltf = JSON.parse(jsonText);
    const refs = [];
    for (const buf of gltf.buffers ?? []) {
      if (buf.uri && !buf.uri.startsWith("data:")) refs.push(buf.uri);
    }
    for (const img of gltf.images ?? []) {
      if (img.uri && !img.uri.startsWith("data:")) refs.push(img.uri);
    }
    const srcDir = dirname(srcAbs);
    const destDir = dirname(destAbs);
    for (const uri of refs) {
      // glTF URIs are POSIX-style relative paths. decodeURI handles spaces.
      const decoded = decodeURI(uri);
      const refSrc = resolve(srcDir, decoded);
      const refDest = resolve(destDir, decoded);
      const r = await copyOneFile(refSrc, refDest);
      if (r.copied || r.bytes > 0) {
        companions += 1;
        companionBytes += r.bytes;
      }
    }
  } catch (err) {
    console.error(`  Failed to parse ${srcRel}: ${String(err)}`);
    failures += 1;
  }
  return { mainBytes: main.bytes, companions, companionBytes };
}

async function copyTreeFiltered(srcAbs, destAbs, predicate) {
  if (!existsSync(srcAbs)) {
    console.error(`  MISSING DIR: ${srcAbs}`);
    failures += 1;
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  const entries = await readdir(srcAbs, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(srcAbs, entry.name);
    const destChild = join(destAbs, entry.name);
    if (entry.isDirectory()) {
      const sub = await copyTreeFiltered(srcChild, destChild, predicate);
      count += sub.count;
      bytes += sub.bytes;
    } else if (entry.isFile() && predicate(entry.name)) {
      const r = await copyOneFile(srcChild, destChild);
      count += 1;
      bytes += r.bytes;
    }
  }
  return { count, bytes };
}

// ---------------------------------------------------------------------------
// Category copiers
// ---------------------------------------------------------------------------

function summary(category, parts) {
  const pieces = Object.entries(parts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${k}`);
  console.log(`[${category}] ${pieces.join(", ") || "no work"}`);
}

async function copyCharacters() {
  let gltfs = 0;
  let companions = 0;
  for (const rel of CHARACTER_GLTFS) {
    const filename = basename(rel);
    const destRel = posix.join("characters", filename);
    const r = await copyGltfWithCompanions(rel, destRel);
    gltfs += 1;
    companions += r.companions;
  }
  summary("characters", { glTF: gltfs, companions });
}

async function copyWeapons() {
  let glbs = 0;
  for (const rel of WEAPON_GLBS) {
    const destRel = posix.join("weapons", basename(rel));
    await copyGlbWithCompanions(rel, destRel);
    glbs += 1;
  }
  const glbCompanionFlush = await flushCompanionPlan();
  let gltfs = 0;
  let gltfCompanions = 0;
  for (const rel of WEAPON_GLTFS) {
    const destRel = posix.join("weapons", basename(rel));
    const r = await copyGltfWithCompanions(rel, destRel);
    gltfs += 1;
    gltfCompanions += r.companions;
  }
  summary("weapons", {
    GLB: glbs,
    glTF: gltfs,
    companions: gltfCompanions + glbCompanionFlush.copied,
  });
}

async function copyEnemies() {
  let glbs = 0;
  for (const rel of ENEMY_GLBS) {
    const destRel = posix.join("enemies", basename(rel));
    await copyGlbWithCompanions(rel, destRel);
    glbs += 1;
  }
  const flushed = await flushCompanionPlan();
  summary("enemies", { GLB: glbs, companions: flushed.copied });
}

async function copyPickups() {
  let gltfs = 0;
  let companions = 0;
  for (const rel of PICKUP_GLTFS) {
    const destRel = posix.join("pickups", basename(rel));
    const r = await copyGltfWithCompanions(rel, destRel);
    gltfs += 1;
    companions += r.companions;
  }
  summary("pickups", { glTF: gltfs, companions });
}

async function copyEnvironment() {
  let glbs = 0;
  for (const rel of ENVIRONMENT_GLBS) {
    const destRel = posix.join("environment", basename(rel));
    await copyGlbWithCompanions(rel, destRel);
    glbs += 1;
  }
  // ENVIRONMENT_GLBS is intentionally ordered retro-urban → survival →
  // city-kit-industrial so that city-industrial wins the colormap.png
  // collision (per the script header). The flush below preserves that
  // last-writer-wins precedence.
  const flushed = await flushCompanionPlan();
  summary("environment", { GLB: glbs, companions: flushed.copied });
}

async function copyPngPacks(category, packs, sourceParent) {
  let pngs = 0;
  let bytes = 0;
  for (const pack of packs) {
    const srcAbs = join(SRC_ROOT, sourceParent, pack);
    const destAbs = join(DEST_ROOT, category, pack);
    const r = await copyTreeFiltered(srcAbs, destAbs, (name) =>
      name.toLowerCase().endsWith(".png"),
    );
    pngs += r.count;
    bytes += r.bytes;
  }
  summary(category, { PNG: pngs });
  return bytes;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log(`source: ${SRC_ROOT}`);
  console.log(`destination: ${DEST_ROOT}`);
  console.log("");

  await copyCharacters();
  await copyWeapons();
  await copyEnemies();
  await copyPickups();
  await copyEnvironment();
  await copyPngPacks("fx", FX_PACKS, "kenney/2d");
  await copyPngPacks("ui", UI_PACKS, "kenney/2d");

  console.log("");
  console.log(
    `total: copied ${totalCopied} file(s), skipped ${totalSkipped} (unchanged), ${failures} failure(s)`,
  );
  console.log(`bytes copied: ${totalBytes.toLocaleString()}`);

  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

