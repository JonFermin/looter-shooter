// Settlement Arena scene — wasteland courtyard built from Kenney
// retro-urban-kit + survival-kit + city-kit-industrial GLBs. Loads each
// unique environment GLB into an AssetContainer once, then instantiates
// clones for each placement so we don't re-decode shared textures (which
// the Babylon WebGPU loader chokes on when the same GLB is fetched in
// parallel).
//
// Coord system: courtyard is centered at the origin, +X is east, +Z is
// north. Walls run along the four perimeter edges at z=±HALF / x=±HALF.
// Kenney retro-urban-kit walls are ~4 units long; we space at 4u on
// the perimeter so adjacent segments butt cleanly. Wall facings rotate
// to face into the courtyard center.

import type { Scene } from "@babylonjs/core/scene.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { BoundingBox } from "@babylonjs/core/Culling/boundingBox.js";
import { loadGLB } from "../utils/AssetLoader.js";

const ASSET_BASE = "/assets/environment";

// Kenney retro-urban-kit walls and survival props ship at ~1u and ~0.25u
// respectively. We scale everything up so the courtyard reads at a
// human-walking scale (≈1.6u tall character would clear a wall etc.).
const PROP_SCALE = 4;
// Perimeter wall step in world units after PROP_SCALE. wall-a is 1u
// wide in the source GLB; scaled by 4 we get 4u segments that butt
// edge-to-edge.
const WALL_STEP = 4;
// Inner half-extent of the courtyard floor — perimeter walls sit at this
// distance from the origin on each cardinal axis. ~25u half-extent gives
// the ~50u courtyard the task calls for.
const HALF = 24;

export interface ArenaInfo {
  spawnPoint: Vector3;
  bounds: BoundingBox;
}

interface PlacementOpts {
  position: Vector3;
  rotationY?: number;
  scale?: number;
}

// Apply transform to a Node-like with position/rotation/scaling. The
// glTF root is a TransformNode in practice, but typing through Node is
// awkward — we narrow structurally to dodge a deep import.
type Transformable = {
  position: Vector3;
  rotation: Vector3;
  scaling: Vector3;
};

// Cache of AssetContainers keyed by filename. Each unique GLB is fetched
// at most once per scene; subsequent placements call
// `instantiateModelsToScene()` which clones the meshes without re-parsing
// the buffer or re-decoding textures.
async function fetchTemplate(
  scene: Scene,
  cache: Map<string, Promise<AssetContainer | null>>,
  filename: string,
): Promise<AssetContainer | null> {
  const existing = cache.get(filename);
  if (existing) return existing;
  const promise = loadGLB(scene, `${ASSET_BASE}/${filename}`).catch(
    (err: unknown) => {
      console.warn(`Arena: failed to load ${filename}:`, err);
      return null;
    },
  );
  cache.set(filename, promise);
  return promise;
}

// Instantiate one clone of the cached template at the given transform.
// Returns true on success, false if the template wasn't loadable.
function placeFromTemplate(
  template: AssetContainer | null,
  filename: string,
  opts: PlacementOpts,
): boolean {
  if (!template) return false;
  const entries = template.instantiateModelsToScene(
    (name) => `${filename}:${name}`,
    false,
    { doNotInstantiate: true },
  );
  const root = entries.rootNodes[0];
  if (!root) {
    console.warn(`Arena: ${filename} instantiated but has no root node`);
    return false;
  }
  const transform = root as unknown as Transformable;
  transform.position = opts.position.clone();
  if (opts.rotationY !== undefined) {
    transform.rotation = new Vector3(0, opts.rotationY, 0);
  }
  // Always apply PROP_SCALE so the source 1u Kenney models read at the
  // courtyard's human scale. Caller can override with opts.scale for
  // outliers (large buildings, etc.).
  const scale = opts.scale ?? PROP_SCALE;
  transform.scaling = new Vector3(scale, scale, scale);
  return true;
}

// Generate placements for one straight perimeter edge. The edge runs
// along `axis` ("x" = east-west, "z" = north-south) at the fixed value
// of the other coordinate. Walls face into the courtyard via rotationY.
// `doorIndex` substitutes a door segment for a courtyard entrance, and
// `brokenIndices` substitute broken-wall variants for ramshackle flavor.
interface EdgeSpec {
  axis: "x" | "z";
  fixed: number;
  facingY: number;
  doorIndex?: number;
  brokenIndices?: number[];
}

function buildEdgePlacements(
  edge: EdgeSpec,
): Array<{ filename: string; opts: PlacementOpts }> {
  const placements: Array<{ filename: string; opts: PlacementOpts }> = [];
  const start = -HALF + WALL_STEP / 2;
  const segments = Math.floor((HALF * 2) / WALL_STEP);
  for (let i = 0; i < segments; i++) {
    const along = start + i * WALL_STEP;
    const pos =
      edge.axis === "x"
        ? new Vector3(along, 0, edge.fixed)
        : new Vector3(edge.fixed, 0, along);
    let filename = "wall-a.glb";
    if (edge.doorIndex !== undefined && i === edge.doorIndex) {
      filename = "wall-a-door.glb";
    } else if (edge.brokenIndices?.includes(i)) {
      filename =
        i % 2 === 0 ? "wall-broken-type-a.glb" : "wall-broken-type-b.glb";
    } else if (i === 2 || i === segments - 3) {
      filename = "wall-a-window.glb";
    }
    placements.push({ filename, opts: { position: pos, rotationY: edge.facingY } });
  }
  return placements;
}

/**
 * Build the settlement arena into `scene`. Loads >=15 distinct
 * environment GLBs (each fetched once, then instantiated for repeats)
 * forming an enclosed ~50x50 wasteland courtyard with cover props and
 * 2-3 building shells.
 *
 * @param scene - target Babylon scene
 * @returns spawn point at the courtyard center and the playable bounds
 */
export async function buildArena(scene: Scene): Promise<ArenaInfo> {
  // ---------------------------------------------------------------------
  // Build the full placement list first, then de-dupe filenames so we
  // fetch each GLB exactly once. This is the difference between "loads
  // cleanly" and "8 textures fail to decode" on the WebGPU loader path.
  // ---------------------------------------------------------------------
  const placements: Array<{ filename: string; opts: PlacementOpts }> = [];

  // Perimeter walls — four edges, with one door on each side and a few
  // broken segments for wasteland flavor.
  const edges: EdgeSpec[] = [
    {
      axis: "x",
      fixed: HALF,
      facingY: Math.PI,
      doorIndex: 5,
      brokenIndices: [2, 9],
    },
    {
      axis: "x",
      fixed: -HALF,
      facingY: 0,
      doorIndex: 6,
      brokenIndices: [3],
    },
    {
      axis: "z",
      fixed: HALF,
      facingY: -Math.PI / 2,
      doorIndex: 4,
      brokenIndices: [8],
    },
    {
      axis: "z",
      fixed: -HALF,
      facingY: Math.PI / 2,
      doorIndex: 7,
      brokenIndices: [1, 10],
    },
  ];
  for (const edge of edges) {
    for (const placement of buildEdgePlacements(edge)) {
      placements.push(placement);
    }
  }

  // Corner pieces — one wall-a-corner.glb at each of the four corners.
  const corners: Array<{ pos: Vector3; rotY: number }> = [
    { pos: new Vector3(-HALF, 0, -HALF), rotY: 0 },
    { pos: new Vector3(HALF, 0, -HALF), rotY: -Math.PI / 2 },
    { pos: new Vector3(HALF, 0, HALF), rotY: Math.PI },
    { pos: new Vector3(-HALF, 0, HALF), rotY: Math.PI / 2 },
  ];
  for (const corner of corners) {
    placements.push({
      filename: "wall-a-corner.glb",
      opts: { position: corner.pos, rotationY: corner.rotY },
    });
  }

  // Building shells — sit just outside the courtyard so their facades
  // form the visible skyline through the wall gaps.
  placements.push(
    {
      filename: "building-a.glb",
      opts: {
        position: new Vector3(-HALF - 8, 0, -HALF - 8),
        rotationY: Math.PI / 4,
      },
    },
    {
      filename: "building-c.glb",
      opts: {
        position: new Vector3(HALF + 9, 0, HALF + 6),
        rotationY: -Math.PI * 0.6,
      },
    },
    {
      filename: "building-f.glb",
      opts: {
        position: new Vector3(HALF + 8, 0, -HALF - 9),
        rotationY: Math.PI * 0.75,
      },
    },
    {
      filename: "chimney-medium.glb",
      opts: { position: new Vector3(-HALF - 10, 0, HALF + 5) },
    },
    {
      filename: "detail-tank.glb",
      opts: {
        position: new Vector3(HALF - 4, 0, HALF - 4),
        rotationY: Math.PI / 6,
      },
    },
  );

  // Cover props inside the courtyard — staggered clusters of barrels,
  // crates, dumpsters, fences, rocks. Positions hand-tuned so the layout
  // reads as "salvaged settlement" rather than a regular grid.
  placements.push(
    // Central crate cluster + barrels
    { filename: "box-large.glb", opts: { position: new Vector3(-3, 0, 4) } },
    {
      filename: "box-large-open.glb",
      opts: { position: new Vector3(-1, 0, 6.5), rotationY: Math.PI / 5 },
    },
    { filename: "box.glb", opts: { position: new Vector3(-4.2, 0, 6.2) } },
    {
      filename: "box-open.glb",
      opts: { position: new Vector3(2.5, 0, 5), rotationY: -Math.PI / 3 },
    },
    { filename: "barrel.glb", opts: { position: new Vector3(4.5, 0, 7) } },
    { filename: "barrel-open.glb", opts: { position: new Vector3(5.5, 0, 8.5) } },
    // Northeast nook — dumpster + fence cover
    {
      filename: "detail-dumpster-closed.glb",
      opts: { position: new Vector3(12, 0, 14), rotationY: Math.PI / 2 },
    },
    {
      filename: "detail-dumpster-open.glb",
      opts: { position: new Vector3(15, 0, 11) },
    },
    { filename: "fence.glb", opts: { position: new Vector3(10, 0, 17) } },
    {
      filename: "fence-fortified.glb",
      opts: { position: new Vector3(14, 0, 18) },
    },
    // Southwest barricade line
    {
      filename: "detail-barrier-strong-type-a.glb",
      opts: { position: new Vector3(-10, 0, -10), rotationY: Math.PI / 8 },
    },
    {
      filename: "detail-barrier-strong-damaged.glb",
      opts: { position: new Vector3(-13, 0, -11.5) },
    },
    {
      filename: "pallet.glb",
      opts: { position: new Vector3(-8, 0, -13), rotationY: Math.PI / 6 },
    },
    {
      filename: "resource-planks.glb",
      opts: { position: new Vector3(-11, 0, -14) },
    },
    {
      filename: "resource-wood.glb",
      opts: { position: new Vector3(-14, 0, -8), rotationY: Math.PI / 4 },
    },
    // Scattered rocks for natural cover
    { filename: "rock-a.glb", opts: { position: new Vector3(8, 0, -12) } },
    {
      filename: "rock-b.glb",
      opts: { position: new Vector3(11, 0, -8), rotationY: Math.PI / 3 },
    },
    {
      filename: "rock-a.glb",
      opts: { position: new Vector3(-6, 0, 12), rotationY: -Math.PI / 4 },
    },
    // Road tile pieces for a beat-up entry path running south->north.
    {
      filename: "road-asphalt-damaged.glb",
      opts: { position: new Vector3(0, 0, -12) },
    },
    {
      filename: "road-asphalt-damaged.glb",
      opts: { position: new Vector3(0, 0, -4) },
    },
  );

  // ---------------------------------------------------------------------
  // De-dupe filenames and fetch each unique GLB once. We keep load
  // concurrency low (handful at a time) to stay well under any
  // image-decoder queue limits the WebGPU loader has.
  // ---------------------------------------------------------------------
  const uniqueFilenames = Array.from(
    new Set(placements.map((p) => p.filename)),
  );
  const cache = new Map<string, Promise<AssetContainer | null>>();
  const templates = new Map<string, AssetContainer | null>();

  // Sequential awaits — slightly slower, dramatically more reliable than
  // Promise.all here because the glTF texture decoder pipeline serializes
  // poorly under heavy concurrency.
  for (const filename of uniqueFilenames) {
    const tpl = await fetchTemplate(scene, cache, filename);
    templates.set(filename, tpl);
  }

  // Now instantiate every placement from the cached templates. This is
  // synchronous — instantiateModelsToScene clones nodes without I/O.
  for (const placement of placements) {
    const tpl = templates.get(placement.filename) ?? null;
    placeFromTemplate(tpl, placement.filename, placement.opts);
  }

  return {
    spawnPoint: new Vector3(0, 0, 0),
    bounds: new BoundingBox(
      new Vector3(-HALF - 1, 0, -HALF - 1),
      new Vector3(HALF + 1, 10, HALF + 1),
    ),
  };
}
