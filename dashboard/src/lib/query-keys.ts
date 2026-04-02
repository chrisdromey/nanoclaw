export const queryKeys = {
  overview: ['overview'] as const,
  systemHealth: ['system', 'health'] as const,
  hunts: {
    all: ['hunts'] as const,
    detail: (id: number) => ['hunts', id] as const,
    offers: (id: number, status?: string) =>
      ['hunts', id, 'offers', status] as const,
    prices: (id: number, period?: string) =>
      ['hunts', id, 'prices', period] as const,
    searches: (id: number) => ['hunts', id, 'searches'] as const,
    evaluations: (id: number) => ['hunts', id, 'evaluations'] as const,
    alerts: (id: number) => ['hunts', id, 'alerts'] as const,
    segments: (id: number) => ['hunts', id, 'segments'] as const,
    segmentPrices: (id: number, segmentId: number) =>
      ['hunts', id, 'segments', segmentId, 'prices'] as const,
    baseline: (id: number) => ['hunts', id, 'baseline'] as const,
  },
  offers: {
    detail: (id: number) => ['offers', id] as const,
    prices: (id: number) => ['offers', id, 'prices'] as const,
  },
  watched: ['watched'] as const,
  searches: (params?: Record<string, string>) =>
    ['searches', params] as const,
  searchEffectiveness: (params?: Record<string, string>) =>
    ['searches', 'effectiveness', params] as const,
  evaluations: (params?: Record<string, string>) =>
    ['evaluations', params] as const,
  agent: {
    activity: (page?: number) => ['agent', 'activity', page] as const,
    logs: (id: string) => ['agent', 'logs', id] as const,
  },
};
