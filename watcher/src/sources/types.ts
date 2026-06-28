/**
 * Source adapter interface — the contract every data source must implement.
 * Phase 1 foundation: types only; adapters added per-source in later phases.
 */

export interface SourceAdapter {
  id: string;
  capabilities: {
    hasAuctions: boolean;
    richSearch: boolean;
    needsDetailFetch: boolean;
  };
  minIntervalMs: number;
  search(nativeParams: unknown): Promise<SearchOutcome>;
  fetchDetail?(sourceId: string): Promise<DetailOutcome>;
  getState(sourceId: string): Promise<StateOutcome>;
}

export interface NormalisedListing {
  source: string;
  sourceId: string;
  title: string;
  url: string;
  priceGbp: number | null;
  currency: string;
  thumbnailUrl?: string;
  sellerType?: 'TRADE' | 'PRIVATE' | null;
  attributes: Record<string, unknown>;
  // eBay-flavoured fields preserved for the eBay adapter; nullable for others:
  condition?: string | null;
  buyingFormat?: string | null;       // e.g. "AUCTION,FIXED_PRICE"
  auctionEndTime?: string | null;     // ISO
  bidCount?: number | null;
}

export interface SearchOutcome {
  listings: NormalisedListing[];
  apiCalls: number;
  sourceMeta?: Record<string, unknown>;  // eBay's totalByFormat goes here
  errors: Array<{ scope: string; error: string }>;
}

export interface DetailOutcome {
  listing: NormalisedListing | null;
  apiCalls: number;
  error?: string;
}

export interface StateOutcome {
  status: 'active' | 'ended' | 'removed' | 'sold';
  // Optional snapshot fields for change detection (mirrors current eBay watch):
  priceGbp?: number | null;
  bidCount?: number | null;
  auctionEndTime?: string | null;
  attributes?: Record<string, unknown>;
  apiCalls: number;
  error?: string;
}
