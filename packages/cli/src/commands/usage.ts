import path from 'node:path';
import { scanRuns } from '../usage/reader.js';
import { aggregate } from '../usage/aggregator.js';
import {ProviderId} from "../types.js";
import {BucketWithProviders, BucketTotalOnly, BucketKey} from "../usage/types.js";
import {S} from "../shell.js";

type UsageOptions = {
    root: string;
};

export async function usageCommand(opts: UsageOptions, bucket : string): Promise<string> {
    const root = path.resolve(opts.root);

    const runs = await scanRuns(root);
    const result = aggregate(runs, new Date());

    const buckets = {
        "today" : () => renderBucketWithProvider("Today", result.today),
        "this-month" : () => renderBucketWithProvider("This month", result.thisMonth),
        "last-month" : () => renderBucketTotalOnly("Last month", result.lastMonth),
        "all-time" : () => renderBucketWithProvider("All time", result.allTime),
    }

    if(isBucketKey(bucket)){
        return buckets[bucket]();
    }else if(!bucket){
        return "All costs summary:" + Object.values(buckets).map(r => r()).join('\n')
    }

    return `"${bucket}" is not a valid bucket name. Use one of: today, this-month, last-month, all-time.`;

}

const LABEL_COL = 22;

function renderBucketWithProvider (label : string, bucket : BucketWithProviders) : string {
    let msg = `\n{${S.muted}-fg}════════════════════════════════════════{/}\n{${S.keyword}-fg}{bold}${label}{/}\n`

    for (const provider of Object.keys(bucket.byProvider) as ProviderId[]) {
        const prefix = `   ${provider}`;
        const cost = `$${bucket.byProvider[provider].totalCost}`;
        msg += `{${S.text}-fg}{bold}${prefix.padEnd(LABEL_COL)}{/}${cost}\n`;
    }

    const totalPrefix = `${label} total:`;
    const totalCost = `$${bucket.total}`;
    msg += `{${S.accent}-fg}{bold}${totalPrefix.padEnd(LABEL_COL)}${totalCost}{/}`;

    return msg;
}

function renderBucketTotalOnly (label : string, bucket : BucketTotalOnly) : string {
    const totalPrefix = `${label} total:`;
    const totalCost = `$${bucket.total}`;
    return `\n{${S.muted}-fg}════════════════════════════════════════{/}\n{${S.keyword}-fg}{bold}${label}{/}\n{${S.accent}-fg}{bold}${totalPrefix.padEnd(LABEL_COL)}${totalCost}{/}`;
}

function isBucketKey (value : string) : value is BucketKey {
    return value === 'today' || value === 'this-month' || value === 'last-month' || value === 'all-time';
}
