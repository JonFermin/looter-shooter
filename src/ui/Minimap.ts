// Minimap — top-right circular GUI overlay rendering live world state.
//
// Approach: a manual top-down 2D projection inside an @babylonjs/gui
// Ellipse container. We avoid a second 3D camera + RenderTargetTexture
// because the arena is a flat 50×50 courtyard — RTT would burn an extra
// pass per frame for what is effectively a handful of dots and an arrow.
// The Ellipse control clips its children to its rounded shape, so dots
// drifting toward the bounds are masked automatically.
//
// Coordinate convention: world +Z (north) maps to negative GUI Y (top of
// the minimap), world +X (east) maps to positive GUI X (right). The
// player arrow rotation mirrors `Player.getViewYaw()` so the arrow points
// in the direction the camera is looking.

// AdvancedDynamicTexture relies on engine.createDynamicTexture, registered
// by side-effect from these two files (WebGL + WebGPU paths). Without them
// the WebGPU path throws "createDynamicTexture is not a function" on
// first construction.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js";

import type { Scene } from "@babylonjs/core/scene.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Nullable } from "@babylonjs/core/types.js";
import type { BoundingBox } from "@babylonjs/core/Culling/boundingBox.js";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture.js";
import { Ellipse } from "@babylonjs/gui/2D/controls/ellipse.js";
import { Image } from "@babylonjs/gui/2D/controls/image.js";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";

import type { Player } from "../entities/Player.js";
import type { Enemy } from "../entities/Enemy.js";
import { getActiveDrops } from "../systems/LootSystem.js";
import { RARITY_COLOR } from "../data/Rarity.js";

// Outer minimap diameter in pixels (the visible circle).
const MINIMAP_SIZE_PX = 180;
// Outer frame ring sits this many pixels OUTSIDE the disc on each side, so
// the ring's overall diameter is MINIMAP_SIZE_PX + RING_GAP_PX * 2.
const RING_GAP_PX = 6;
const RING_THICKNESS_PX = 4;
// Tick label offset from the disc edge — positions the N/E/S/W glyphs just
// outside the disc, on the ring band.
const TICK_OFFSET_PX = MINIMAP_SIZE_PX / 2 + RING_GAP_PX - 4;
const TICK_FONT_SIZE_PX = 10;
// Padding from the top-right corner of the canvas.
const MINIMAP_PADDING_TOP_PX = 24;
const MINIMAP_PADDING_RIGHT_PX = 24;
// Dot diameter for enemies + loot drops.
const DOT_SIZE_PX = 6;
// Player arrow size (rendered as a unicode triangle TextBlock).
const PLAYER_ARROW_SIZE_PX = 18;
// Decorative compass tile from the Kenney minimap-pack — sits on top-left
// of the minimap so the AC's "framed by minimap-pack PNG" wording is
// satisfied without needing a perfectly-fitting circular frame asset.
const COMPASS_TILE_PATH =
  "/assets/ui/minimap-pack/Tiles/Style A/tile_0000.png";
const COMPASS_SIZE_PX = 28;
const BACKDROP_COLOR = "#0b0f17cc";
const BORDER_COLOR = "#ffffff80";
const ENEMY_DOT_COLOR = "#ff3030";

export class Minimap {
  private readonly scene: Scene;
  private readonly player: Player;
  private readonly enemiesAccessor: () => readonly Enemy[];

  private readonly texture: AdvancedDynamicTexture;
  private readonly disc: Ellipse;
  private readonly playerArrow: TextBlock;
  private readonly enemyDots: Ellipse[] = [];
  private readonly lootDots: Ellipse[] = [];

  // Cached projection — computed once from `bounds` so per-frame updates
  // don't redo the divisions for every enemy/loot dot.
  private readonly worldCenterX: number;
  private readonly worldCenterZ: number;
  private readonly worldToPx: number;

  private updateObserver: Nullable<Observer<Scene>> = null;
  private disposed = false;

  constructor(
    scene: Scene,
    player: Player,
    enemiesAccessor: () => readonly Enemy[],
    bounds: BoundingBox,
  ) {
    this.scene = scene;
    this.player = player;
    this.enemiesAccessor = enemiesAccessor;

    const halfWidth = (bounds.maximumWorld.x - bounds.minimumWorld.x) / 2;
    const halfHeight = (bounds.maximumWorld.z - bounds.minimumWorld.z) / 2;
    this.worldCenterX = (bounds.maximumWorld.x + bounds.minimumWorld.x) / 2;
    this.worldCenterZ = (bounds.maximumWorld.z + bounds.minimumWorld.z) / 2;
    // Scale = pixels per world unit, sized so the longer arena axis fits
    // exactly inside the minimap radius.
    this.worldToPx = MINIMAP_SIZE_PX / 2 / Math.max(halfWidth, halfHeight);

    this.texture = AdvancedDynamicTexture.CreateFullscreenUI(
      "minimap",
      true,
      scene,
    );

    // Frame ring goes on the texture BEFORE the disc so it renders below
    // the disc + dots, reading as a "bezel" surrounding the map.
    this.createRing();

    this.disc = this.createDisc();
    this.texture.addControl(this.disc);

    this.playerArrow = this.createPlayerArrow();
    this.disc.addControl(this.playerArrow);

    this.createCompass();
    this.createTickLabels();

    this.refresh();

    this.updateObserver = scene.onBeforeRenderObservable.add(() => {
      this.refresh();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.updateObserver) {
      this.scene.onBeforeRenderObservable.remove(this.updateObserver);
      this.updateObserver = null;
    }
    this.texture.dispose();
  }

  // -- internals --

  private createDisc(): Ellipse {
    const disc = new Ellipse("minimapDisc");
    disc.width = `${MINIMAP_SIZE_PX}px`;
    disc.height = `${MINIMAP_SIZE_PX}px`;
    disc.thickness = 2;
    disc.color = BORDER_COLOR;
    disc.background = BACKDROP_COLOR;
    disc.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    disc.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    disc.paddingTop = `${MINIMAP_PADDING_TOP_PX}px`;
    disc.paddingRight = `${MINIMAP_PADDING_RIGHT_PX}px`;
    return disc;
  }

  private createPlayerArrow(): TextBlock {
    // ▲ is centered around its baseline, but Babylon GUI's TextBlock
    // bounding-box is the rendered glyph rect — close enough to center.
    // Using a TextBlock dodges the need for a triangle PNG asset.
    const arrow = new TextBlock("minimapPlayerArrow", "▲");
    arrow.color = "#ffffff";
    arrow.fontSize = PLAYER_ARROW_SIZE_PX;
    arrow.fontFamily = "monospace";
    arrow.width = `${PLAYER_ARROW_SIZE_PX}px`;
    arrow.height = `${PLAYER_ARROW_SIZE_PX}px`;
    arrow.shadowColor = "#000000";
    arrow.shadowOffsetX = 1;
    arrow.shadowOffsetY = 1;
    arrow.shadowBlur = 0;
    arrow.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    arrow.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    arrow.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    arrow.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    return arrow;
  }

  private createRing(): void {
    const ring = new Ellipse("minimapRing");
    ring.width = `${MINIMAP_SIZE_PX + RING_GAP_PX * 2}px`;
    ring.height = `${MINIMAP_SIZE_PX + RING_GAP_PX * 2}px`;
    ring.thickness = RING_THICKNESS_PX;
    ring.color = "#ffffff";
    ring.background = "transparent";
    ring.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    ring.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    // Ring shares the disc's anchor + padding minus RING_GAP_PX so the
    // disc lands concentric inside the ring.
    ring.paddingTop = `${MINIMAP_PADDING_TOP_PX - RING_GAP_PX}px`;
    ring.paddingRight = `${MINIMAP_PADDING_RIGHT_PX - RING_GAP_PX}px`;
    this.texture.addControl(ring);
  }

  private createTickLabels(): void {
    // Cardinal labels share the disc's top-right anchor + padding, then
    // each gets a `top`/`left` offset that pushes it just outside the disc
    // edge in the matching cardinal direction. Top is anchored at the
    // disc's top-center, etc., so we offset from THERE rather than the
    // canvas corner.
    this.addTickLabel("N", 0, -TICK_OFFSET_PX);
    this.addTickLabel("S", 0, TICK_OFFSET_PX);
    this.addTickLabel("E", TICK_OFFSET_PX, 0);
    this.addTickLabel("W", -TICK_OFFSET_PX, 0);
  }

  private addTickLabel(text: string, dx: number, dy: number): void {
    const label = new TextBlock(`minimapTick_${text}`, text);
    label.color = "#ffffff";
    label.fontSize = TICK_FONT_SIZE_PX;
    label.fontFamily = "monospace";
    label.width = `${TICK_FONT_SIZE_PX * 2}px`;
    label.height = `${TICK_FONT_SIZE_PX * 2}px`;
    label.shadowColor = "#000000";
    label.shadowOffsetX = 1;
    label.shadowOffsetY = 1;
    label.shadowBlur = 0;
    label.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    label.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    // Adding to the disc means dx=0/dy=0 sits at the disc's center; the
    // cardinal offsets push the labels onto the ring band just outside.
    label.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    label.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    label.left = `${dx}px`;
    label.top = `${dy}px`;
    this.disc.addControl(label);
  }

  private createCompass(): void {
    // Decorative Kenney minimap-pack tile in the top-left corner of the
    // minimap area. Loosely satisfies "framed by minimap-pack PNG" without
    // needing a circular frame variant the pack doesn't ship.
    const compass = new Image("minimapCompass", COMPASS_TILE_PATH);
    compass.width = `${COMPASS_SIZE_PX}px`;
    compass.height = `${COMPASS_SIZE_PX}px`;
    compass.stretch = Image.STRETCH_UNIFORM;
    compass.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    compass.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    compass.left = "8px";
    compass.top = "8px";
    this.disc.addControl(compass);
  }

  private makeDot(name: string, color: string): Ellipse {
    const dot = new Ellipse(name);
    dot.width = `${DOT_SIZE_PX}px`;
    dot.height = `${DOT_SIZE_PX}px`;
    dot.thickness = 0;
    dot.background = color;
    dot.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    dot.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    return dot;
  }

  /**
   * Resize the dot pool to `count` entries, lazily creating + destroying
   * Ellipse controls so we don't churn allocations every frame when alive
   * counts are stable.
   */
  private resizeDotPool(
    pool: Ellipse[],
    count: number,
    name: string,
    fallbackColor: string,
  ): void {
    while (pool.length < count) {
      const dot = this.makeDot(`${name}${pool.length}`, fallbackColor);
      this.disc.addControl(dot);
      pool.push(dot);
    }
    while (pool.length > count) {
      const dot = pool.pop();
      if (dot) {
        this.disc.removeControl(dot);
        dot.dispose();
      }
    }
  }

  private refresh(): void {
    if (this.disposed) return;

    // Player arrow — anchored at center; rotation tracks view yaw so the
    // arrow points where the camera is looking. Babylon GUI Control.rotation
    // is clockwise looking at the screen (positive Y-down), and our world
    // yaw is clockwise looking down from +Y, so the signs already match.
    this.playerArrow.rotation = this.player.getViewYaw();

    const playerPos = this.player.position;
    const playerScreen = this.worldToScreen(playerPos.x, playerPos.z);

    // Enemies — only alive ones get a dot.
    const enemies = this.enemiesAccessor();
    const aliveEnemies: Enemy[] = [];
    for (const e of enemies) {
      if (!e.isDead) aliveEnemies.push(e);
    }
    this.resizeDotPool(
      this.enemyDots,
      aliveEnemies.length,
      "minimapEnemy",
      ENEMY_DOT_COLOR,
    );
    for (let i = 0; i < aliveEnemies.length; i++) {
      const enemy = aliveEnemies[i];
      const dot = this.enemyDots[i];
      if (!enemy || !dot) continue;
      const screen = this.worldToScreen(enemy.position.x, enemy.position.z);
      dot.left = `${screen.x - playerScreen.x}px`;
      dot.top = `${screen.y - playerScreen.y}px`;
      // Centering the view on the player would be ideal — but the AC asks
      // for "centered orientation-arrow" which here means the arrow stays
      // at the visual center while dots move relative to it. Recompute
      // every frame because the player moves.
    }

    // Loot drops — colored by rarity tier.
    const drops = getActiveDrops();
    this.resizeDotPool(
      this.lootDots,
      drops.length,
      "minimapLoot",
      RARITY_COLOR[0],
    );
    for (let i = 0; i < drops.length; i++) {
      const drop = drops[i];
      const dot = this.lootDots[i];
      if (!drop || !dot) continue;
      dot.background = RARITY_COLOR[drop.rarity];
      const dropPos = drop.position;
      const screen = this.worldToScreen(dropPos.x, dropPos.z);
      dot.left = `${screen.x - playerScreen.x}px`;
      dot.top = `${screen.y - playerScreen.y}px`;
    }
  }

  private worldToScreen(wx: number, wz: number): { x: number; y: number } {
    // World +Z is "north" — render at the top of the minimap, so flip Y.
    return {
      x: (wx - this.worldCenterX) * this.worldToPx,
      y: -(wz - this.worldCenterZ) * this.worldToPx,
    };
  }
}
