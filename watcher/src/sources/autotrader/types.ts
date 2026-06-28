/**
 * AutoTrader-specific types for the source adapter.
 */

export interface AutotraderFilterInput {
  filter: string;
  selected: string[];
}

export interface AutotraderSearchParams {
  /** Raw AT filter array — build via translateCarsCriteriaToAutotrader() */
  filters: AutotraderFilterInput[];
  page?: number;
  sortBy?: 'relevance' | 'price-asc' | 'distance';
}

/** Shape of one SearchListing from the GraphQL response */
export interface ATSearchListing {
  type: string;
  advertId: string;
  title: string;
  subTitle: string | null;
  attentionGrabber: string | null;
  price: string | null;               // e.g. "£14,995"
  vehicleLocation: string | null;     // e.g. "Leicester (3 miles)"
  locationType: string | null;
  discount: unknown;
  images: string[];
  numberOfImages: number;
  rrp: unknown;
  sellerType: 'TRADE' | 'PRIVATE' | null;
  dealerLink: string | null;
  fpaLink: string | null;
  hasDigitalRetailing: boolean;
  preReg: boolean;
  position: number;
  trackingContext: {
    advertContext: {
      id: string;
      make: string;
      model: string;
      year: number;
      condition: string;
      price: number;
      vehicleCategory: string;
    };
    distance: {
      distance: number;
      distance_unit: string | null;
    };
  };
}

/** Shape of the page block in the GraphQL response */
export interface ATPageInfo {
  number: number;
  count: number;
  results: { count: number };
}

/** Full GraphQL search response (outer array wrapper stripped) */
export interface ATSearchResponse {
  data: {
    searchResults: {
      listings: ATSearchListing[];
      page: ATPageInfo;
      trackingContext: { searchId: string };
    };
  };
  errors?: Array<{ message: string; locations?: unknown[]; path?: unknown[] }>;
}

/** One equipment category from featuresWithDisclaimer, e.g. "Drivers Assistance". */
export interface ATFeatureCategory {
  category: string;
  items: Array<{ name: string; type: string | null }>;   // type: "Standard" | "Optional"
}

/** One spec category from advert.specs, e.g. "Performance", "Size and dimensions". */
export interface ATSpecCategory {
  category: string;
  items: Array<{ name: string; value: string | null }>;
}

/** Extracted detail-page data */
export interface ATDetailData {
  priceIndicator: string | null;          // "LOW" | "GREAT" | "GOOD" | "HIGH" | "NOANALYSIS"
  priceIndicatorLabel: string | null;     // "Lower price" | "Great price" | etc.
  deviation: number | null;              // £ (negative = below market avg)
  mileageText: string | null;            // "55,010 miles"
  mileageNum: number | null;             // 55010
  fuel: string | null;
  transmission: string | null;
  bodyType: string | null;
  colour: string | null;
  year: number | null;
  registrationPlate: string | null;      // e.g. "65 reg"
  /** Canonical seller type from detail page advertContext.advertiserType. Optional: SVG fallback / older callers may omit. */
  sellerType?: 'trade' | 'private' | null;
  sellerName: string | null;
  dealerUrl: string | null;
  /** Granular location text from detail page, e.g. "Leicester, LE3 5AB". Overwrites search-level location_text if present. */
  detailLocationText: string | null;
  priceFormatted: string | null;
  priceNumeric: number | null;
  priceDeviationText: string | null;     // "£1,732 below market average"
  // Extra keySpecification fields (beyond the core spec triage set)
  seats: string | null;
  doors: string | null;
  engineLitres: string | null;           // e.g. "2.0L"
  owners: string | null;
  // Equipment + spec data for feature verification (cars are bought by feature)
  features: ATFeatureCategory[] | null;  // categorized equipment list, Standard/Optional per item
  specs: ATSpecCategory[] | null;        // performance + dimensions (boot space, BHP, MPG, etc.)
  description: string | null;            // seller free-text description
}
