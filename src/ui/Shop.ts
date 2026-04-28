// Shop UI — Babylon GUI overlay that opens during the WaveSpawner breather
// phase and offers four randomly-rolled weapons priced by rarity. Inputs are
// keyboard-only (1/2/3/4 to buy, Space to skip) so the overlay never has to
// release pointer-lock — the player stays in combat-ready stance through the
// breather. Open/close is driven by Arena's onStateChange subscription;
// fresh stock is generated on every open() so each breather feels like a
// new shop visit.

// AdvancedDynamicTexture relies on engine.createDynamicTexture, which is
// registered by side-effect from these two files. Mirrors Hud.ts so the
// shop's own ADT can mount even when constructed before the HUD.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js";

import type { Scene } from "@babylonjs/core/scene.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Nullable } from "@babylonjs/core/types.js";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture.js";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle.js";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";

import type { Player } from "../entities/Player.js";
import type { InventoryItem } from "../data/InventoryItem.js";
import { Archetype } from "../data/WeaponArchetype.js";
import { RARITY_COLOR, RarityTier, RARITY_WEIGHT } from "../data/Rarity.js";
import { pickWeaponEntry, type WeaponEntry } from "../data/WeaponDatabase.js";
import { rollWeapon } from "../systems/StatRoll.js";

// Pricing rationale: Wave 1 yields ~15 currency (3 zombies × 5), wave 2 ~50
// (5z + 1u = 25+25), wave 3 ~90. Cumulative through wave 3 is ~155, so an
// UNCOMMON is reachable by wave 2-3 and a RARE by wave 3-4. EPIC and
// LEGENDARY remain stretch goals — feels right for a roguelite economy.
const PRICE_BY_RARITY: Record<RarityTier, number> = {
  [RarityTier.COMMON]: 25,
  [RarityTier.UNCOMMON]: 75,
  [RarityTier.RARE]: 200,
  [RarityTier.EPIC]: 500,
  [RarityTier.LEGENDARY]: 1500,
};

const SLOT_COUNT = 4;
const CARD_WIDTH_PX = 160;
const CARD_HEIGHT_PX = 220;
const CARD_GAP_PX = 12;
const PANEL_PADDING_PX = 16;
const TITLE_HEIGHT_PX = 32;
const HINT_HEIGHT_PX = 24;
const PANEL_WIDTH_PX =
  SLOT_COUNT * CARD_WIDTH_PX + (SLOT_COUNT - 1) * CARD_GAP_PX +
  PANEL_PADDING_PX * 2;
const PANEL_HEIGHT_PX =
  CARD_HEIGHT_PX + TITLE_HEIGHT_PX + HINT_HEIGHT_PX +
  PANEL_PADDING_PX * 2 + 8;
const PANEL_TOP_OFFSET_PX = 56;

const PANEL_BG_COLOR = "#0e1119ee";
const PANEL_BORDER_COLOR = "#2a2f3aff";
const CARD_BG_COLOR = "#1c2030cc";
const CARD_SOLD_BG_COLOR = "#11141d77";
const CARD_SOLD_BORDER_COLOR = "#2a2f3aaa";
const CURRENCY_COLOR = "#ffe066";
const PRICE_COLOR_AFFORDABLE = "#ffe066";
const PRICE_COLOR_UNAFFORDABLE = "#7a6432";
const FLASH_COLOR = "#ef4444";
const FLASH_DURATION_MS = 320;

interface StockSlot {
  archetype: Archetype;
  rarity: RarityTier;
  entry: WeaponEntry;
  item: InventoryItem;
  price: number;
  sold: boolean;
}

export type ShopPurchaseResult = "ok" | "inventory-full";

export interface ShopOptions {
  scene: Scene;
  player: Player;
  /**
   * Called when the player attempts to buy a slot they can afford. The Arena
   * is responsible for adding the item to inventory and persisting state.
   * Returning "inventory-full" rolls back the purchase: Shop will not mark
   * the slot SOLD and the caller must NOT have mutated currency. Currency
   * subtraction lives inside the Shop (via Player.spendCurrency) so this
   * callback only owns inventory.
   */
  onPurchase: (item: InventoryItem) => ShopPurchaseResult;
}

interface CardControls {
  card: Rectangle;
  slotLabel: TextBlock;
  nameText: TextBlock;
  archText: TextBlock;
  rarityText: TextBlock;
  statsText: TextBlock;
  priceText: TextBlock;
  buyHint: TextBlock;
  flash: Rectangle;
  flashRemainingMs: number;
}

export class Shop {
  private readonly scene: Scene;
  private readonly player: Player;
  private readonly onPurchase: (item: InventoryItem) => ShopPurchaseResult;

  private readonly texture: AdvancedDynamicTexture;
  private readonly panel: Rectangle;
  private readonly titleText: TextBlock;
  private readonly currencyText: TextBlock;
  private readonly hintText: TextBlock;
  private readonly cards: CardControls[] = [];

  private stock: StockSlot[] = [];
  private isOpen = false;
  private disposed = false;

  private keyListener: ((e: KeyboardEvent) => void) | null = null;
  private updateObserver: Nullable<Observer<Scene>> = null;

  constructor(opts: ShopOptions) {
    this.scene = opts.scene;
    this.player = opts.player;
    this.onPurchase = opts.onPurchase;

    this.texture = AdvancedDynamicTexture.CreateFullscreenUI(
      "shop",
      true,
      this.scene,
    );
    this.texture.rootContainer.isVisible = false;

    this.panel = this.buildPanel();
    this.texture.addControl(this.panel);

    this.titleText = this.buildTitle();
    this.panel.addControl(this.titleText);

    this.currencyText = this.buildCurrencyReadout();
    this.panel.addControl(this.currencyText);

    for (let i = 0; i < SLOT_COUNT; i++) {
      const card = this.buildCard(i);
      this.cards.push(card);
      this.panel.addControl(card.card);
    }

    this.hintText = this.buildHint();
    this.panel.addControl(this.hintText);
  }

  /**
   * Show the shop and roll a fresh 4-slot stock. Idempotent — calling
   * open() twice in a row keeps the same stock.
   */
  open(): void {
    if (this.disposed) return;
    if (this.isOpen) return;
    this.isOpen = true;
    this.rollStock();
    this.refresh();
    this.texture.rootContainer.isVisible = true;
    this.attachKeyListener();
    this.attachUpdateObserver();
  }

  /** Hide the shop and detach the keyboard listener. Stock is not cleared. */
  close(): void {
    if (this.disposed) return;
    if (!this.isOpen) return;
    this.isOpen = false;
    this.texture.rootContainer.isVisible = false;
    this.detachKeyListener();
    this.detachUpdateObserver();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachKeyListener();
    this.detachUpdateObserver();
    this.texture.dispose();
  }

  // -- internals --

  private rollStock(): void {
    const fresh: StockSlot[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const archetype = pickRandomArchetype();
      const rarity = rollRarityWeighted(RARITY_WEIGHT);
      const entry = pickWeaponEntry(archetype);
      const stats = rollWeapon(archetype, rarity);
      fresh.push({
        archetype,
        rarity,
        entry,
        item: {
          stats,
          archetype,
          rarity,
          meshPath: entry.meshPath,
          displayName: entry.displayName,
        },
        price: PRICE_BY_RARITY[rarity],
        sold: false,
      });
    }
    this.stock = fresh;
  }

  private attachKeyListener(): void {
    if (this.keyListener) return;
    this.keyListener = (e: KeyboardEvent): void => {
      if (this.disposed || !this.isOpen) return;
      if (e.repeat) return;
      const slotIndex = parseSlotKey(e.key);
      if (slotIndex === null) return;
      e.preventDefault();
      this.tryBuySlot(slotIndex);
    };
    window.addEventListener("keydown", this.keyListener);
  }

  private detachKeyListener(): void {
    if (!this.keyListener) return;
    window.removeEventListener("keydown", this.keyListener);
    this.keyListener = null;
  }

  // The flash decay needs a per-frame tick; we attach to the scene's
  // onBeforeRender only while the shop is open so closed-shop scenes don't
  // pay the per-frame cost.
  private attachUpdateObserver(): void {
    if (this.updateObserver) return;
    this.updateObserver = this.scene.onBeforeRenderObservable.add(() => {
      this.refreshLive();
    });
  }

  private detachUpdateObserver(): void {
    if (!this.updateObserver) return;
    this.scene.onBeforeRenderObservable.remove(this.updateObserver);
    this.updateObserver = null;
  }

  private tryBuySlot(slotIndex: number): void {
    const slot = this.stock[slotIndex];
    const card = this.cards[slotIndex];
    if (!slot || !card) return;
    if (slot.sold) return;

    if (!this.player.spendCurrency(slot.price)) {
      this.flashCard(card);
      return;
    }

    const result = this.onPurchase(slot.item);
    if (result === "inventory-full") {
      this.player.addCurrency(slot.price);
      this.flashCard(card);
      return;
    }

    slot.sold = true;
    this.refresh();
  }

  private flashCard(card: CardControls): void {
    card.flashRemainingMs = FLASH_DURATION_MS;
    card.flash.alpha = 1;
  }

  private refresh(): void {
    if (this.disposed) return;
    this.currencyText.text = `Currency: $${this.player.currency}`;
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i];
      const slot = this.stock[i];
      if (!card) continue;
      this.paintCard(card, slot ?? null, i + 1);
    }
  }

  private refreshLive(): void {
    if (this.disposed) return;
    this.currencyText.text = `Currency: $${this.player.currency}`;
    const dtMs = this.scene.getEngine().getDeltaTime();
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i];
      const slot = this.stock[i];
      if (!card) continue;
      if (card.flashRemainingMs > 0) {
        card.flashRemainingMs -= dtMs;
        if (card.flashRemainingMs < 0) card.flashRemainingMs = 0;
        card.flash.alpha = card.flashRemainingMs / FLASH_DURATION_MS;
      }
      if (slot && !slot.sold) {
        const affordable = this.player.currency >= slot.price;
        card.priceText.color = affordable
          ? PRICE_COLOR_AFFORDABLE
          : PRICE_COLOR_UNAFFORDABLE;
        card.buyHint.alpha = affordable ? 1 : 0.5;
      }
    }
  }

  private paintCard(
    card: CardControls,
    slot: StockSlot | null,
    slotNumber: number,
  ): void {
    card.slotLabel.text = `${slotNumber}`;
    card.flash.alpha = 0;
    card.flashRemainingMs = 0;

    if (!slot) {
      card.card.background = CARD_SOLD_BG_COLOR;
      card.card.color = CARD_SOLD_BORDER_COLOR;
      card.nameText.text = "";
      card.archText.text = "";
      card.rarityText.text = "";
      card.statsText.text = "";
      card.priceText.text = "";
      card.buyHint.text = "";
      return;
    }

    if (slot.sold) {
      card.card.background = CARD_SOLD_BG_COLOR;
      card.card.color = CARD_SOLD_BORDER_COLOR;
      card.nameText.text = slot.entry.displayName;
      card.nameText.color = "#5a6072";
      card.archText.text = Archetype[slot.archetype];
      card.archText.color = "#5a6072";
      card.rarityText.text = RarityTier[slot.rarity];
      card.rarityText.color = "#5a6072";
      const s = slot.item.stats;
      card.statsText.text =
        `D:${formatStat(s.damage)} F:${formatStat(s.fireRate)} M:${s.magazine}`;
      card.statsText.color = "#5a6072";
      card.priceText.text = "SOLD";
      card.priceText.color = "#5a6072";
      card.buyHint.text = "";
      return;
    }

    const rarityColor = RARITY_COLOR[slot.rarity];
    card.card.background = CARD_BG_COLOR;
    card.card.color = rarityColor;
    card.nameText.text = slot.entry.displayName;
    card.nameText.color = "#ffffff";
    card.archText.text = Archetype[slot.archetype];
    card.archText.color = "#9aa3b2";
    card.rarityText.text = RarityTier[slot.rarity];
    card.rarityText.color = rarityColor;

    const s = slot.item.stats;
    card.statsText.text =
      `D:${formatStat(s.damage)} F:${formatStat(s.fireRate)} M:${s.magazine}`;
    card.statsText.color = "#cccccc";

    const affordable = this.player.currency >= slot.price;
    card.priceText.text = `$${slot.price}`;
    card.priceText.color = affordable
      ? PRICE_COLOR_AFFORDABLE
      : PRICE_COLOR_UNAFFORDABLE;
    card.buyHint.text = `Press ${slotNumber} to BUY`;
    card.buyHint.alpha = affordable ? 1 : 0.5;
  }

  private buildPanel(): Rectangle {
    const panel = new Rectangle("shopPanel");
    panel.width = `${PANEL_WIDTH_PX}px`;
    panel.height = `${PANEL_HEIGHT_PX}px`;
    panel.background = PANEL_BG_COLOR;
    panel.color = PANEL_BORDER_COLOR;
    panel.thickness = 1;
    panel.cornerRadius = 4;
    panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    panel.top = `${PANEL_TOP_OFFSET_PX}px`;
    panel.isPointerBlocker = true;
    return panel;
  }

  private buildTitle(): TextBlock {
    const title = new TextBlock("shopTitle");
    title.text = "SHOP";
    title.color = "#ffffff";
    title.fontSize = 22;
    title.fontStyle = "bold";
    title.fontFamily = "monospace";
    title.height = `${TITLE_HEIGHT_PX}px`;
    title.width = "200px";
    title.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    title.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    title.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    title.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    title.left = `${PANEL_PADDING_PX}px`;
    title.top = `${PANEL_PADDING_PX / 2}px`;
    return title;
  }

  private buildCurrencyReadout(): TextBlock {
    const text = new TextBlock("shopCurrency");
    text.text = "Currency: $0";
    text.color = CURRENCY_COLOR;
    text.fontSize = 16;
    text.fontFamily = "monospace";
    text.height = `${TITLE_HEIGHT_PX}px`;
    text.width = "240px";
    text.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    text.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    text.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    text.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    text.paddingRight = `${PANEL_PADDING_PX}px`;
    text.top = `${PANEL_PADDING_PX / 2}px`;
    text.shadowColor = "#000000";
    text.shadowOffsetX = 1;
    text.shadowOffsetY = 1;
    return text;
  }

  private buildHint(): TextBlock {
    const hint = new TextBlock("shopHint");
    hint.text = "Press 1/2/3/4 to buy. Shop closes when next wave starts.";
    hint.color = "#9aa3b2";
    hint.fontSize = 12;
    hint.fontFamily = "monospace";
    hint.height = `${HINT_HEIGHT_PX}px`;
    hint.width = `${PANEL_WIDTH_PX - PANEL_PADDING_PX * 2}px`;
    hint.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    hint.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    hint.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    hint.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    hint.paddingBottom = `${PANEL_PADDING_PX / 2}px`;
    return hint;
  }

  private buildCard(index: number): CardControls {
    const card = new Rectangle(`shopCard${index}`);
    card.width = `${CARD_WIDTH_PX}px`;
    card.height = `${CARD_HEIGHT_PX}px`;
    card.thickness = 2;
    card.cornerRadius = 4;
    card.background = CARD_BG_COLOR;
    card.color = PANEL_BORDER_COLOR;
    card.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    card.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    const cardLeft =
      PANEL_PADDING_PX + index * (CARD_WIDTH_PX + CARD_GAP_PX);
    card.left = `${cardLeft}px`;
    card.top = `${PANEL_PADDING_PX + TITLE_HEIGHT_PX + 4}px`;

    const slotLabel = new TextBlock(`shopCardSlot${index}`);
    slotLabel.text = `${index + 1}`;
    slotLabel.color = "#ffe066";
    slotLabel.fontSize = 28;
    slotLabel.fontStyle = "bold";
    slotLabel.fontFamily = "monospace";
    slotLabel.width = "32px";
    slotLabel.height = "32px";
    slotLabel.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    slotLabel.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    slotLabel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    slotLabel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    slotLabel.paddingTop = "4px";
    slotLabel.paddingRight = "8px";
    card.addControl(slotLabel);

    const stack = new StackPanel(`shopCardStack${index}`);
    stack.isVertical = true;
    stack.width = `${CARD_WIDTH_PX - 16}px`;
    stack.paddingLeft = "8px";
    stack.paddingRight = "8px";
    stack.paddingTop = "10px";
    stack.paddingBottom = "8px";
    stack.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    stack.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;

    const nameText = makeStackText(`shopCardName${index}`, 13, "bold", 22);
    stack.addControl(nameText);

    const archText = makeStackText(`shopCardArch${index}`, 11, "normal", 16);
    stack.addControl(archText);

    const rarityText = makeStackText(`shopCardRarity${index}`, 12, "bold", 18);
    stack.addControl(rarityText);

    const statsText = makeStackText(`shopCardStats${index}`, 12, "normal", 18);
    stack.addControl(statsText);

    const priceText = makeStackText(`shopCardPrice${index}`, 18, "bold", 30);
    priceText.paddingTop = "12px";
    stack.addControl(priceText);

    const buyHint = makeStackText(`shopCardBuyHint${index}`, 11, "normal", 16);
    buyHint.color = "#9aa3b2";
    stack.addControl(buyHint);

    card.addControl(stack);

    const flash = new Rectangle(`shopCardFlash${index}`);
    flash.width = `${CARD_WIDTH_PX}px`;
    flash.height = `${CARD_HEIGHT_PX}px`;
    flash.thickness = 0;
    flash.background = FLASH_COLOR;
    flash.alpha = 0;
    flash.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    flash.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    flash.isHitTestVisible = false;
    card.addControl(flash);

    return {
      card,
      slotLabel,
      nameText,
      archText,
      rarityText,
      statsText,
      priceText,
      buyHint,
      flash,
      flashRemainingMs: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_ARCHETYPES: Archetype[] = [
  Archetype.PISTOL,
  Archetype.SMG,
  Archetype.RIFLE,
  Archetype.SHOTGUN,
  Archetype.BLASTER,
];

function pickRandomArchetype(): Archetype {
  const idx = Math.floor(Math.random() * ALL_ARCHETYPES.length);
  const value = ALL_ARCHETYPES[idx];
  if (value === undefined) {
    throw new Error("Shop.pickRandomArchetype: empty archetype list");
  }
  return value;
}

function rollRarityWeighted(weights: Record<RarityTier, number>): RarityTier {
  const tiers: RarityTier[] = [
    RarityTier.COMMON,
    RarityTier.UNCOMMON,
    RarityTier.RARE,
    RarityTier.EPIC,
    RarityTier.LEGENDARY,
  ];
  let total = 0;
  for (const t of tiers) total += weights[t];
  let pick = Math.random() * total;
  for (const t of tiers) {
    pick -= weights[t];
    if (pick <= 0) return t;
  }
  return RarityTier.COMMON;
}

function parseSlotKey(key: string): number | null {
  if (key === "1") return 0;
  if (key === "2") return 1;
  if (key === "3") return 2;
  if (key === "4") return 3;
  return null;
}

function formatStat(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

function makeStackText(
  name: string,
  fontSize: number,
  fontStyle: "bold" | "normal",
  height: number,
): TextBlock {
  const text = new TextBlock(name);
  text.text = "";
  text.color = "#cccccc";
  text.fontSize = fontSize;
  text.fontStyle = fontStyle === "bold" ? "bold" : "";
  text.fontFamily = "monospace";
  text.height = `${height}px`;
  text.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  text.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  text.resizeToFit = false;
  return text;
}
