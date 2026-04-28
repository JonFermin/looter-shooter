// Inventory UI — fullscreen Babylon GUI panel that toggles on Tab. Renders
// a 4×6 grid of cards backed by Player._inventory plus a side compare panel
// that shows the selected card next to the currently equipped weapon. Card
// click selects, E equips the selection (delegated to Arena via callback),
// X discards (likewise delegated).
//
// The inventory is a "menu state": opening it releases pointer-lock so the
// player can click cards. The Arena scene gates its mouse-look + click-fire
// behind document.pointerLockElement, so closing the menu and re-clicking
// the canvas restores normal play. Because of that gating the Inventory
// class doesn't need to know anything about combat — it just toggles
// visibility and runs the equip/discard callbacks the Arena registered.
//
// Lifecycle: a single AdvancedDynamicTexture owned for the inventory's
// lifetime; dispose() tears it down. The Arena chains dispose() into
// scene.onDisposeObservable.

// AdvancedDynamicTexture relies on engine.createDynamicTexture, which is
// registered by side-effect from these two files (one for WebGL, one for
// WebGPU). Hud.ts already imports them but Inventory builds its own ADT
// lazily — keep the imports here so module ordering can't strand us.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js";

import type { Scene } from "@babylonjs/core/scene.js";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture.js";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle.js";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import { Grid } from "@babylonjs/gui/2D/controls/grid.js";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";

import type { Player } from "../entities/Player.js";
import type { InventoryItem } from "../data/InventoryItem.js";
import { Archetype } from "../data/WeaponArchetype.js";
import { RARITY_COLOR, RarityTier } from "../data/Rarity.js";

const GRID_COLS = 4;
const GRID_ROWS = 6;

// Card / panel pixel dimensions. The grid sits left-of-center; the compare
// panel sits to its right. Sized so both fit in a 1280×720 viewport with
// margin.
const CARD_WIDTH_PX = 150;
const CARD_HEIGHT_PX = 90;
const CARD_GAP_PX = 8;
const GRID_WIDTH_PX = GRID_COLS * CARD_WIDTH_PX + (GRID_COLS - 1) * CARD_GAP_PX;
const GRID_HEIGHT_PX = GRID_ROWS * CARD_HEIGHT_PX + (GRID_ROWS - 1) * CARD_GAP_PX;

const COMPARE_WIDTH_PX = 360;
const COMPARE_HEIGHT_PX = GRID_HEIGHT_PX;
const PANEL_PADDING_PX = 24;
const PANEL_TITLE_HEIGHT_PX = 36;

const PANEL_WIDTH_PX =
  GRID_WIDTH_PX + COMPARE_WIDTH_PX + PANEL_PADDING_PX * 3;
const PANEL_HEIGHT_PX =
  GRID_HEIGHT_PX + PANEL_PADDING_PX * 2 + PANEL_TITLE_HEIGHT_PX;

const PANEL_BG_COLOR = "#0e1119ee";
const PANEL_BORDER_COLOR = "#2a2f3aff";
const COMPARE_BG_COLOR = "#161a25cc";

const CARD_BG_COLOR = "#1c2030cc";
const CARD_EMPTY_BG_COLOR = "#11141d77";
const CARD_EMPTY_BORDER_COLOR = "#2a2f3aaa";

const SELECTED_BORDER_THICKNESS_PX = 3;
const UNSELECTED_BORDER_THICKNESS_PX = 2;

const STAT_BETTER_COLOR = "#4ade80"; // green
const STAT_WORSE_COLOR = "#ef4444"; // red
const STAT_NEUTRAL_COLOR = "#cccccc";

const HINT_TEXT =
  "Click card to select  |  E equip  |  X discard  |  Tab close";

export type EquipHandler = (item: InventoryItem, index: number) => void;
export type DiscardHandler = (item: InventoryItem, index: number) => void;

export class Inventory {
  private readonly player: Player;
  private readonly onEquip: EquipHandler;
  private readonly onDiscard: DiscardHandler;

  private readonly texture: AdvancedDynamicTexture;
  private readonly panel: Rectangle;
  private readonly grid: Grid;
  private readonly comparePanel: Rectangle;
  private readonly compareEquippedText: TextBlock;
  private readonly compareSelectedText: TextBlock;

  // Per-slot card containers indexed 0..23. Reused across refreshes so we
  // don't re-allocate Babylon GUI controls every time the inventory mutates.
  private readonly cards: Rectangle[] = [];

  private selectedIndex: number | null = null;
  private open = false;
  private disposed = false;

  constructor(
    scene: Scene,
    player: Player,
    onEquip: EquipHandler,
    onDiscard: DiscardHandler,
  ) {
    this.player = player;
    this.onEquip = onEquip;
    this.onDiscard = onDiscard;

    this.texture = AdvancedDynamicTexture.CreateFullscreenUI(
      "inventory",
      true,
      scene,
    );
    // Hide the entire ADT until toggled open — cheaper than disposing /
    // rebuilding the controls every time the user presses Tab.
    this.texture.rootContainer.isVisible = false;

    this.panel = this.buildPanelBackground();
    this.texture.addControl(this.panel);

    this.buildTitle();
    this.buildHint();

    this.grid = this.buildGrid();
    this.panel.addControl(this.grid);

    this.buildEmptyAndCardSlots();

    this.comparePanel = this.buildComparePanel();
    this.panel.addControl(this.comparePanel);

    this.compareEquippedText = makeStatsText("inventoryCompareEquippedText");
    this.compareSelectedText = makeStatsText("inventoryCompareSelectedText");
    this.buildCompareLayout();

    this.refresh();
  }

  /** Toggle the panel visibility. Caller is responsible for pointer-lock. */
  toggle(): void {
    if (this.disposed) return;
    this.open = !this.open;
    this.texture.rootContainer.isVisible = this.open;
    if (!this.open) {
      // Drop selection when closing so re-opening starts fresh.
      this.selectedIndex = null;
      this.refresh();
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  /**
   * Re-render every card from Player.inventory + repaint the compare panel.
   * Called automatically inside toggle/select handlers; Arena calls it after
   * external mutations (pickup, equip, discard) so the UI stays current.
   */
  refresh(): void {
    if (this.disposed) return;
    const items = this.player.inventory;

    if (this.selectedIndex !== null && this.selectedIndex >= items.length) {
      this.selectedIndex = null;
    }

    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i];
      if (!card) continue;
      const item = items[i] ?? null;
      this.paintCard(card, item, i === this.selectedIndex);
    }

    this.refreshComparePanel();
  }

  /**
   * Equip the currently-selected card. Delegates to the registered handler;
   * no-op if no card is selected. The handler swaps weapons and removes
   * the equipped item from inventory; this method just bridges UI → Arena.
   */
  equipSelected(): void {
    if (this.disposed || !this.open) return;
    const idx = this.selectedIndex;
    if (idx === null) return;
    const items = this.player.inventory;
    const item = items[idx];
    if (!item) return;
    this.onEquip(item, idx);
    this.selectedIndex = null;
    this.refresh();
  }

  /** Discard the currently-selected card. See equipSelected for semantics. */
  discardSelected(): void {
    if (this.disposed || !this.open) return;
    const idx = this.selectedIndex;
    if (idx === null) return;
    const items = this.player.inventory;
    const item = items[idx];
    if (!item) return;
    this.onDiscard(item, idx);
    this.selectedIndex = null;
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture.dispose();
  }

  // -- internals --

  private buildPanelBackground(): Rectangle {
    const panel = new Rectangle("inventoryPanel");
    panel.width = `${PANEL_WIDTH_PX}px`;
    panel.height = `${PANEL_HEIGHT_PX}px`;
    panel.background = PANEL_BG_COLOR;
    panel.color = PANEL_BORDER_COLOR;
    panel.thickness = 1;
    panel.cornerRadius = 4;
    panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    panel.isPointerBlocker = true;
    return panel;
  }

  private buildTitle(): void {
    const title = new TextBlock("inventoryTitle");
    title.text = "Inventory";
    title.color = "#FFFFFF";
    title.fontStyle = "bold";
    title.fontSize = 22;
    title.fontFamily = "monospace";
    title.height = `${PANEL_TITLE_HEIGHT_PX}px`;
    title.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    title.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    title.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    title.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    title.left = `${PANEL_PADDING_PX}px`;
    title.top = `${PANEL_PADDING_PX / 2}px`;
    title.width = `${GRID_WIDTH_PX}px`;
    this.panel.addControl(title);
  }

  private buildHint(): void {
    const hint = new TextBlock("inventoryHint");
    hint.text = HINT_TEXT;
    hint.color = "#9aa3b2";
    hint.fontSize = 12;
    hint.fontFamily = "monospace";
    hint.height = `${PANEL_TITLE_HEIGHT_PX}px`;
    hint.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    hint.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    hint.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    hint.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    hint.paddingRight = `${PANEL_PADDING_PX}px`;
    hint.top = `${PANEL_PADDING_PX / 2}px`;
    hint.width = `${PANEL_WIDTH_PX - PANEL_PADDING_PX * 2}px`;
    this.panel.addControl(hint);
  }

  private buildGrid(): Grid {
    const grid = new Grid("inventoryGrid");
    grid.width = `${GRID_WIDTH_PX}px`;
    grid.height = `${GRID_HEIGHT_PX}px`;
    grid.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    grid.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    grid.left = `${PANEL_PADDING_PX}px`;
    grid.top = `${PANEL_PADDING_PX + PANEL_TITLE_HEIGHT_PX}px`;
    for (let c = 0; c < GRID_COLS; c++) {
      grid.addColumnDefinition(1 / GRID_COLS);
    }
    for (let r = 0; r < GRID_ROWS; r++) {
      grid.addRowDefinition(1 / GRID_ROWS);
    }
    return grid;
  }

  private buildEmptyAndCardSlots(): void {
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      const row = Math.floor(i / GRID_COLS);
      const col = i % GRID_COLS;
      const card = this.buildCard(i);
      this.cards.push(card);
      this.grid.addControl(card, row, col);
    }
  }

  private buildCard(index: number): Rectangle {
    const card = new Rectangle(`inventoryCard${index}`);
    // Subtract a small margin so adjacent cards don't visually butt
    // edge-to-edge.
    card.width = `${CARD_WIDTH_PX}px`;
    card.height = `${CARD_HEIGHT_PX}px`;
    card.thickness = UNSELECTED_BORDER_THICKNESS_PX;
    card.color = CARD_EMPTY_BORDER_COLOR;
    card.background = CARD_EMPTY_BG_COLOR;
    card.cornerRadius = 4;
    card.isPointerBlocker = true;

    const stack = new StackPanel(`inventoryCardStack${index}`);
    stack.isVertical = true;
    stack.width = `${CARD_WIDTH_PX - 12}px`;
    stack.paddingLeft = "6px";
    stack.paddingRight = "6px";
    stack.paddingTop = "4px";
    stack.paddingBottom = "4px";
    stack.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;

    const nameText = new TextBlock(`inventoryCardName${index}`);
    nameText.text = "";
    nameText.color = "#ffffff";
    nameText.fontSize = 13;
    nameText.fontStyle = "bold";
    nameText.fontFamily = "monospace";
    nameText.height = "18px";
    nameText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    nameText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    nameText.resizeToFit = false;
    nameText.textWrapping = true;
    stack.addControl(nameText);

    const archText = new TextBlock(`inventoryCardArch${index}`);
    archText.text = "";
    archText.color = "#9aa3b2";
    archText.fontSize = 11;
    archText.fontFamily = "monospace";
    archText.height = "16px";
    archText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    archText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    stack.addControl(archText);

    const statsText = new TextBlock(`inventoryCardStats${index}`);
    statsText.text = "";
    statsText.color = "#cccccc";
    statsText.fontSize = 12;
    statsText.fontFamily = "monospace";
    statsText.height = "16px";
    statsText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    statsText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    stack.addControl(statsText);

    card.addControl(stack);

    card.onPointerClickObservable.add(() => {
      this.handleCardClick(index);
    });

    return card;
  }

  private handleCardClick(index: number): void {
    const items = this.player.inventory;
    if (index >= items.length) {
      this.selectedIndex = null;
    } else if (this.selectedIndex === index) {
      this.selectedIndex = null;
    } else {
      this.selectedIndex = index;
    }
    this.refresh();
  }

  private paintCard(
    card: Rectangle,
    item: InventoryItem | null,
    selected: boolean,
  ): void {
    const stack = card.children[0] as StackPanel | undefined;
    const nameText = stack?.children[0] as TextBlock | undefined;
    const archText = stack?.children[1] as TextBlock | undefined;
    const statsText = stack?.children[2] as TextBlock | undefined;

    if (!item) {
      card.thickness = UNSELECTED_BORDER_THICKNESS_PX;
      card.color = CARD_EMPTY_BORDER_COLOR;
      card.background = CARD_EMPTY_BG_COLOR;
      card.scaleX = 1;
      card.scaleY = 1;
      if (nameText) nameText.text = "";
      if (archText) archText.text = "";
      if (statsText) statsText.text = "";
      return;
    }

    card.thickness = selected
      ? SELECTED_BORDER_THICKNESS_PX
      : UNSELECTED_BORDER_THICKNESS_PX;
    card.color = RARITY_COLOR[item.rarity];
    card.background = CARD_BG_COLOR;
    card.scaleX = selected ? 1.04 : 1;
    card.scaleY = selected ? 1.04 : 1;

    if (nameText) nameText.text = item.displayName;
    if (archText) archText.text = Archetype[item.archetype];
    if (statsText) {
      const s = item.stats;
      statsText.text =
        `D:${formatStat(s.damage)}  F:${formatStat(s.fireRate)}  ` +
        `M:${s.magazine}`;
    }
  }

  private buildComparePanel(): Rectangle {
    const panel = new Rectangle("inventoryComparePanel");
    panel.width = `${COMPARE_WIDTH_PX}px`;
    panel.height = `${COMPARE_HEIGHT_PX}px`;
    panel.thickness = 1;
    panel.color = PANEL_BORDER_COLOR;
    panel.background = COMPARE_BG_COLOR;
    panel.cornerRadius = 4;
    panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    panel.left = `${PANEL_PADDING_PX * 2 + GRID_WIDTH_PX}px`;
    panel.top = `${PANEL_PADDING_PX + PANEL_TITLE_HEIGHT_PX}px`;
    return panel;
  }

  private buildCompareLayout(): void {
    const title = new TextBlock("inventoryCompareTitle");
    title.text = "Compare with Equipped";
    title.color = "#ffffff";
    title.fontSize = 18;
    title.fontStyle = "bold";
    title.fontFamily = "monospace";
    title.height = "32px";
    title.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    title.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    title.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    title.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    title.top = "8px";
    this.comparePanel.addControl(title);

    const innerGrid = new Grid("inventoryCompareGrid");
    innerGrid.width = `${COMPARE_WIDTH_PX - 16}px`;
    innerGrid.height = `${COMPARE_HEIGHT_PX - 56}px`;
    innerGrid.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    innerGrid.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    innerGrid.top = "44px";
    innerGrid.addColumnDefinition(0.5);
    innerGrid.addColumnDefinition(0.5);
    innerGrid.addRowDefinition(1);
    this.comparePanel.addControl(innerGrid);

    const leftCol = new StackPanel("inventoryCompareLeft");
    leftCol.isVertical = true;
    leftCol.paddingLeft = "8px";
    leftCol.paddingRight = "4px";
    leftCol.paddingTop = "4px";
    leftCol.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    leftCol.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;

    const leftHeader = makeColumnHeader("Equipped");
    leftCol.addControl(leftHeader);
    leftCol.addControl(this.compareEquippedText);
    innerGrid.addControl(leftCol, 0, 0);

    const rightCol = new StackPanel("inventoryCompareRight");
    rightCol.isVertical = true;
    rightCol.paddingLeft = "4px";
    rightCol.paddingRight = "8px";
    rightCol.paddingTop = "4px";
    rightCol.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    rightCol.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;

    const rightHeader = makeColumnHeader("Selected");
    rightCol.addControl(rightHeader);
    rightCol.addControl(this.compareSelectedText);
    innerGrid.addControl(rightCol, 0, 1);
  }

  private refreshComparePanel(): void {
    const equipped = this.player.equipped;
    const selected =
      this.selectedIndex !== null
        ? this.player.inventory[this.selectedIndex] ?? null
        : null;

    if (!selected) {
      this.compareEquippedText.text = equipped
        ? formatItemBlock(equipped)
        : "No equipped weapon";
      this.compareEquippedText.color = STAT_NEUTRAL_COLOR;
      this.compareSelectedText.text = "Select a card to compare";
      this.compareSelectedText.color = STAT_NEUTRAL_COLOR;
      return;
    }

    this.compareEquippedText.text = equipped
      ? formatItemBlock(equipped)
      : "No equipped weapon";
    this.compareEquippedText.color = STAT_NEUTRAL_COLOR;

    this.compareSelectedText.text = formatItemBlock(selected);
    this.compareSelectedText.color = decideCompareColor(selected, equipped);
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept module-private. The compare-color helper needs to weight
// each stat (higher = better for damage/fireRate/magazine/accuracy, lower =
// better for reloadTime) and emit a single color so the right column reads
// as "this is better/worse on balance" rather than a per-stat dye job.
// ---------------------------------------------------------------------------

function makeColumnHeader(label: string): TextBlock {
  const text = new TextBlock(`inventoryCompareHeader_${label}`);
  text.text = label;
  text.color = "#9aa3b2";
  text.fontSize = 12;
  text.fontFamily = "monospace";
  text.height = "20px";
  text.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  text.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  return text;
}

function makeStatsText(name: string): TextBlock {
  const text = new TextBlock(name);
  text.text = "";
  text.color = STAT_NEUTRAL_COLOR;
  text.fontSize = 13;
  text.fontFamily = "monospace";
  text.height = "180px";
  text.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  text.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  text.textWrapping = true;
  return text;
}

function formatItemBlock(item: InventoryItem): string {
  const s = item.stats;
  const lines = [
    item.displayName,
    Archetype[item.archetype],
    RarityTier[item.rarity],
    "",
    `Damage     ${formatStat(s.damage)}`,
    `FireRate   ${formatStat(s.fireRate)}`,
    `Magazine   ${s.magazine}`,
    `Reload     ${formatStat(s.reloadTime)}s`,
    `Accuracy   ${formatStat(s.accuracy)}`,
  ];
  return lines.join("\n");
}

function decideCompareColor(
  selected: InventoryItem,
  equipped: InventoryItem | null,
): string {
  if (!equipped) return STAT_NEUTRAL_COLOR;
  let score = 0;
  if (selected.stats.damage > equipped.stats.damage) score++;
  else if (selected.stats.damage < equipped.stats.damage) score--;
  if (selected.stats.fireRate > equipped.stats.fireRate) score++;
  else if (selected.stats.fireRate < equipped.stats.fireRate) score--;
  if (selected.stats.magazine > equipped.stats.magazine) score++;
  else if (selected.stats.magazine < equipped.stats.magazine) score--;
  if (selected.stats.accuracy > equipped.stats.accuracy) score++;
  else if (selected.stats.accuracy < equipped.stats.accuracy) score--;
  // Reload: lower is better.
  if (selected.stats.reloadTime < equipped.stats.reloadTime) score++;
  else if (selected.stats.reloadTime > equipped.stats.reloadTime) score--;
  if (score > 0) return STAT_BETTER_COLOR;
  if (score < 0) return STAT_WORSE_COLOR;
  return STAT_NEUTRAL_COLOR;
}

function formatStat(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}
