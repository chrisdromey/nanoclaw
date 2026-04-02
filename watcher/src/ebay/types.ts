/** Raw item from Browse API search response. */
export interface ItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  currentBidPrice?: { value: string; currency: string };
  buyingOptions?: string[];
  condition?: string;
  bidCount?: number;
  itemEndDate?: string;
  itemLocation?: { postalCode?: string; country?: string };
  seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
  itemWebUrl?: string;
  shippingOptions?: Array<{ shippingCost?: { value: string; currency: string } }>;
  categories?: Array<{ categoryId: string; categoryName: string }>;
  [key: string]: unknown;
}

export interface SearchResponse {
  total: number;
  itemSummaries?: ItemSummary[];
  warnings?: unknown[];
}

export interface FormatResult {
  format: string;
  items: ItemSummary[];
  total: number;
  error?: string;
}

/** Full item detail from getItem endpoint. */
export interface ItemDetail {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  currentBidPrice?: { value: string; currency: string };
  buyingOptions?: string[];
  condition?: string;
  bidCount?: number;
  itemEndDate?: string;
  seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
  shippingOptions?: Array<{ shippingCost?: { value: string; currency: string } }>;
  itemWebUrl?: string;
  itemLocation?: { postalCode?: string; country?: string };
  // getItem may return additional fields; we pick what we need
  [key: string]: unknown;
}
