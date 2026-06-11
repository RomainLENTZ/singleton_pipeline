import type {Aggregate, BucketWithProviders, Run} from './types.js';

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

    for (const run of runs) {

        const runDate = new Date(run.createdAt)

        if (runDate >= todayStart) {
            result.today.byProvider[run.provider].reported = run.provider !== "codex";

            result.today.byProvider[run.provider].runCount += 1
            result.today.byProvider[run.provider].totalCost += run.cost

            result.today.total += run.cost
        }

        if(runDate >= thisMonthStart) {
            result.today.byProvider[run.provider].reported = run.provider !== "codex";

            result.thisMonth.byProvider[run.provider].runCount += 1
            result.thisMonth.byProvider[run.provider].totalCost += run.cost
            result.thisMonth.total += run.cost

            result.allTime.byProvider[run.provider].totalCost += run.cost
            result.allTime.total += run.cost
            result.allTime.byProvider[run.provider].runCount += 1
        }

        if(runDate < thisMonthStart && runDate >= lastMonthStart) {
            result.lastMonth.total += run.cost

            result.allTime.total += run.cost

            result.allTime.byProvider[run.provider].runCount += 1
            result.allTime.byProvider[run.provider].totalCost += run.cost

        }

        if(runDate < lastMonthStart) {
            result.allTime.total += run.cost
            result.allTime.byProvider[run.provider].runCount += 1
            result.allTime.byProvider[run.provider].totalCost += run.cost
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