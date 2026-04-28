// Rarity tiers used throughout the looter-shooter loot system.
// Color palette mirrors Borderlands' canonical white/green/blue/purple/orange.
// Drop weights bias heavily toward common; sum to 100 for an easy mental model.

export enum RarityTier {
  COMMON = 0,
  UNCOMMON = 1,
  RARE = 2,
  EPIC = 3,
  LEGENDARY = 4,
}

export const RARITY_COLOR: Record<RarityTier, string> = {
  [RarityTier.COMMON]: "#FFFFFF",
  [RarityTier.UNCOMMON]: "#3DD16C",
  [RarityTier.RARE]: "#3B82F6",
  [RarityTier.EPIC]: "#A855F7",
  [RarityTier.LEGENDARY]: "#F97316",
};

export const RARITY_WEIGHT: Record<RarityTier, number> = {
  [RarityTier.COMMON]: 50,
  [RarityTier.UNCOMMON]: 25,
  [RarityTier.RARE]: 15,
  [RarityTier.EPIC]: 8,
  [RarityTier.LEGENDARY]: 2,
};
