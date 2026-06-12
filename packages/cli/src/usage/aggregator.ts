import type {Aggregate, BucketTotalOnly, BucketWithProviders, Run} from './types.js';

export function aggregate(runs: Run[], now: Date): Aggregate {
    const result =  {
        today : emptyBucketWithProviders(),
        thisMonth : emptyBucketWithProviders(),
        lastMonth : {total : 0},
        allTime : emptyBucketWithProviders()
    }

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const buckets = [
        { match: (d : Date) => d >= todayStart, apply: (run: Run) => addToBucketWithProvider(result.today, run) },
        { match: (d : Date) => d >= thisMonthStart, apply: (run: Run) => addToBucketWithProvider(result.thisMonth, run) },
        { match: (d : Date) => d >= lastMonthStart && d <= thisMonthStart, apply: (run: Run) => addToBucketTotalOnly(result.lastMonth, run)},
        { match: () => true, apply: (run: Run) => addToBucketWithProvider(result.allTime, run) },
    ];

    for (const run of runs) {
        const runDate = new Date(run.createdAt)

        for (const b of buckets) {
            if (b.match(runDate)) b.apply(run);
        }
    }

    return result;
}

function emptyBucketWithProviders(): BucketWithProviders {
    return {
        byProvider: {
            claude: { totalCost: 0, runCount: 0, reported: true },
            codex: { totalCost: 0, runCount: 0, reported: false },
            copilot: { totalCost: 0, runCount: 0, reported: true },
            opencode: { totalCost: 0, runCount: 0, reported: true },
        },
        total: 0,
    };
}

function addToBucketWithProvider (bucketTarget : BucketWithProviders, run : Run) : void {
    bucketTarget.total += run.cost

    bucketTarget.byProvider[run.provider].totalCost += run.cost
    bucketTarget.byProvider[run.provider].runCount += 1
}

function addToBucketTotalOnly (bucketTarget : BucketTotalOnly, run : Run) : void {
    bucketTarget.total += run.cost
}