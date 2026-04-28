#!/usr/bin/env node
// Copies the curated set of game-assets into public/assets/ for runtime use.
// Idempotent: re-running is a no-op when destination files exist with matching
// size. Resolves source root relative to this script so it works regardless of
// the user's cwd. Per game-assets/CLAUDE.md, consuming projects must copy out;
// nothing in src/ should reach across the repo at runtime.

import { readdir, mkdir, copyFile, stat, readFile } from "node:fs/promises";
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
    return { copied: false, bytes: 0 };
  }
  const srcStat = await stat(srcAbs);
  if (existsSync(destAbs)) {
    const destStat = await stat(destAbs);
    if (destStat.size === srcStat.size) {
      totalSkipped += 1;
      return { copied: false, bytes: srcStat.size };
    }
  }
  await mkdir(dirname(destAbs), { recursive: true });
  await copyFile(srcAbs, destAbs);
  totalCopied += 1;
  totalBytes += srcStat.size;
  return { copied: true, bytes: srcStat.size };
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
    const destRel = join("weapons", basename(rel));
    await copyOneFile(join(SRC_ROOT, rel), join(DEST_ROOT, destRel));
    glbs += 1;
  }
  let gltfs = 0;
  let companions = 0;
  for (const rel of WEAPON_GLTFS) {
    const destRel = posix.join("weapons", basename(rel));
    const r = await copyGltfWithCompanions(rel, destRel);
    gltfs += 1;
    companions += r.companions;
  }
  summary("weapons", { GLB: glbs, glTF: gltfs, companions });
}

async function copyEnemies() {
  let glbs = 0;
  for (const rel of ENEMY_GLBS) {
    const destRel = join("enemies", basename(rel));
    await copyOneFile(join(SRC_ROOT, rel), join(DEST_ROOT, destRel));
    glbs += 1;
  }
  summary("enemies", { GLB: glbs });
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
    const destRel = join("environment", basename(rel));
    await copyOneFile(join(SRC_ROOT, rel), join(DEST_ROOT, destRel));
    glbs += 1;
  }
  summary("environment", { GLB: glbs });
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

// quiet unused warnings from tooling that scans imports
void relative;
