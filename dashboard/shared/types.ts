// --- Database row types (matching deal-hunter.db schema) ---

export interface Hunt {
  id: number;
  name: string;
  status: 'active' | 'paused' | 'closed';
  criteria: string; // JSON
  search_terms: string; // JSON array
  cadence_minutes: number;
  monitoring: number;
  category_ids: string | null;
  created_at: string;
  closed_at: string | null;
  close_reason: string | null;
  last_reviewed_at: string | null;
  // Multi-vertical fields (Phase 1 schema addition)
  vertical: string;
  sources: string[]; // JSON array parsed to string[] by API
  poll_interval_minutes: number | null;
}

export interface Offer {
  id: number;
  source: string;
  source_id: string;
  title: string;
  url: string | null;
  seller: string | null;
  seller_rating: number | null;
  // eBay-flavoured fields — nullable; populated by eBay adapter, null for other sources
  condition: string | null;
  buying_format: string | null;
  auction_end_time: string | null;
  bid_count: number | null;
  specs_extracted: string; // JSON
  watching: number;
  watch_conditions: string | null; // JSON
  status: 'active' | 'ended' | 'removed' | 'sold';
  first_seen_at: string;
  last_seen_at: string;
  last_status_change: string | null;
  notified_thresholds: string | null; // JSON
  thumbnail_url: string | null;
  // Multi-vertical fields (Phase 1 schema addition)
  vertical: string | null;
  // vertical-specific extras (mileage, year, etc.). Stored as a JSON string in
  // the DB but parsed to an object by every API endpoint (list + detail), so it
  // is always an object on the client.
  attributes: Record<string, unknown>;
}

export interface Price {
  id: number;
  offer_id: number;
  price: number;
  shipping: number | null;
  currency: string;
  total_landed_gbp: number | null;
  observed_at: string;
}

export interface SearchQuery {
  id: number;
  hunt_id: number;
  source: string;
  terms: string;
  result_count: number;
  new_offer_count: number;
  relevant_count: number;
  searched_at: string;
}

export interface HuntOffer {
  hunt_id: number;
  offer_id: number;
  search_query_id: number | null;
  status: 'new' | 'evaluated' | 'watching' | 'dismissed';
  first_associated_at: string;
}

export interface Evaluation {
  id: number;
  offer_id: number;
  hunt_id: number;
  decision: 'alert' | 'skip' | 'watch';
  reasoning: string | null;
  evaluated_at: string;
}

export interface Alert {
  id: number;
  offer_id: number;
  hunt_id: number;
  urgency: 'high' | 'medium' | 'low';
  message_sent: string | null;
  alerted_at: string;
  user_response: string | null;
  feedback_extracted: string | null;
  responded_at: string | null;
}

// --- API response types ---

export interface HuntSummary extends Hunt {
  new_count: number;
  evaluated_count: number;
  watching_count: number;
  dismissed_count: number;
  min_price: number | null;
  max_price: number | null;
  last_searched: string | null;
  last_result_count: number | null;
  last_new_count: number | null;
}

export interface WatchedOffer extends Offer {
  hunt_id: number;
  hunt_name: string;
  pipeline_status: string;
  current_price: number | null;
  first_price: number | null;
  current_shipping: number | null;
}

export interface OfferDetail extends Offer {
  hunt_associations: Array<{
    hunt_id: number;
    hunt_name: string;
    status: string;
  }>;
  evaluations: Array<Evaluation & { hunt_name?: string }>;
  alerts: Array<Alert & { hunt_name?: string }>;
}

export interface OverviewData {
  hunts: HuntSummary[];
  quick_stats: {
    active_offers: number;
    watching_count: number;
    searches_today: number;
    evaluations_today: number;
  };
  attention: {
    auctions_ending_soon: number;
    price_drops: number;
    unevaluated: number;
  };
  recent_activity: ActivityItem[];
}

export interface ActivityItem {
  type: 'search' | 'evaluation' | 'alert' | 'price_change';
  description: string;
  timestamp: string;
  hunt_name?: string;
  metadata?: Record<string, unknown>;
}

export interface SystemHealth {
  watcher: {
    status: 'running' | 'slow' | 'stale';
    last_search: string | null;
  };
  api: {
    searches_today: number;
    budget: number;
  };
  agent: {
    last_run: string | null;
    last_duration_ms: number | null;
    last_status: string | null;
  };
}

export interface OfferWithPrices extends Offer {
  current_price: number | null;
  first_price: number | null;
  pipeline_status?: string;
}

export interface SearchQueryWithHunt extends SearchQuery {
  hunt_name: string;
}

export interface EvaluationWithDetails extends Evaluation {
  offer_title: string;
  hunt_name: string;
}

export interface TaskRunLog {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

export interface ContainerLog {
  filename: string;
  timestamp: string;
  group: string;
  duration_ms: number;
  exit_code: number;
  session_id: string | null;
  is_main: boolean;
}

export interface PriceAggregates {
  observation_count: number;
  min_price: number;
  max_price: number;
  avg_price: number;
  median_price: number;
  offer_count: number;
}

export interface HuntPriceData {
  aggregates: PriceAggregates;
  observations: Array<
    Price & {
      offer_title: string;
      offer_condition: string | null;
      offer_status: string;
      offer_watching: number;
    }
  >;
}

export interface SearchScheduleItem {
  hunt_id: number;
  hunt_name: string;
  cadence_minutes: number;
  status: string;
  last_search: string | null;
  next_expected: string | null;
}

export interface DecisionDistribution {
  alert: number;
  watch: number;
  skip: number;
}

export interface DecisionTrendDay {
  day: string;
  alert: number;
  watch: number;
  skip: number;
}

export interface MarketSegment {
  id: number;
  hunt_id: number;
  name: string;
  description: string | null;
  tags: string;
  filter_patterns: string;
  price_low: number | null;
  price_mid: number | null;
  price_high: number | null;
  sample_size: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BaselinePrice {
  id: number;
  segment_id: number | null;
  hunt_id: number;
  source_type: 'sold' | 'active' | 'auction_completed';
  title: string;
  price: number;
  shipping: number | null;
  total_landed_gbp: number | null;
  condition: string | null;
  sold_date: string | null;
  observed_at: string;
  source_url: string | null;
  source_item_id: string | null;
  tags: string;
  created_at: string;
}

export interface SegmentWithStats extends MarketSegment {
  data_point_count: number;
  sold_count: number;
  active_count: number;
  earliest_data: string | null;
  latest_data: string | null;
}

export interface HuntBaselineData {
  segments: SegmentWithStats[];
  unclassified_count: number;
  active_offer_prices: Array<{
    offer_id: number;
    title: string;
    current_price: number | null;
    condition: string | null;
    buying_format: string | null;
  }>;
}

export interface TermEffectiveness {
  terms: string;
  hunt_id: number;
  hunt_name: string;
  total_searches: number;
  total_results: number;
  total_new_offers: number;
  avg_new_per_search: number;
  last_searched: string;
  sparkline: number[];
  stale: boolean;
}

export interface HuntLogEntry {
  id: number;
  hunt_id: number;
  trigger: string;
  summary: string;
  offers_evaluated: number;
  offers_alerted: number;
  offers_watched: number;
  offers_skipped: number;
  logged_at: string;
}

export interface HuntDailyStat {
  date: string;
  runs: number;
  evaluated: number;
  alerted: number;
  skipped: number;
}

export interface HuntActivityData {
  log_entries: HuntLogEntry[];
  daily_stats: HuntDailyStat[];
}
