import type { ProviderId } from '../types.js';

export const BUCKET_KEYS = ["today", "this-month", "last-month", "all-time"] as const;
export type BucketKey = typeof BUCKET_KEYS[number];

type ProviderStats = {
    totalCost: number;
    runCount: number;
    reported: boolean;
};

export type BucketWithProviders = {
    byProvider: Record<ProviderId, ProviderStats>;
    total: number;
};

export type BucketTotalOnly = {
    total: number;
};

export type Aggregate = {
    today: BucketWithProviders;
    thisMonth: BucketWithProviders;
    lastMonth: BucketTotalOnly;
    allTime: BucketWithProviders;
};


export type Run = {
    createdAt: string;
    provider: 'claude' | 'codex' | 'copilot' | 'opencode';
    cost: number;
};

export type ManifestStat = {
    createdAt : string;
    provider : 'claude' | 'codex' | 'copilot' | 'opencode';
    cost: number;
}

export type BucketKeys = {

}
