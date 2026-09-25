export const TIERS = ["inline", "settings", "advanced"] as const;
export type Tier = (typeof TIERS)[number];

export const SURFACES: Readonly<Record<string, Tier>> = {};
