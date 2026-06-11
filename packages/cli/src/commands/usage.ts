import path from 'node:path';
import { style } from '../theme.js';
import { scanRuns } from '../usage/reader.js';
import { aggregate } from '../usage/aggregator.js';
import {ProviderId} from "../types.js";
import {Argument} from "commander";
import {BucketWithProviders, BucketTotalOnly, BucketKey} from "../usage/types.js";

type UsageOptions = {
    root: string;
};

export async function usageCommand(opts: UsageOptions, bucket : string): Promise<void> {
    const root = path.resolve(opts.root);

    const runs = await scanRuns(root);
    const result = aggregate(runs, new Date());

    const buckets = {
        "today" : () => renderBucketWithProvider("Today", result.today),
        "this-month" : () => renderBucketWithProvider("This month", result.thisMonth),
        "last-month" : () => renderBucketTotalOnly("Last month", result.lastMonth),
        "all-time" : () => renderBucketWithProvider("All time", result.allTime),
    }

    if(!bucket){
        console.log("All costs summary :");
        Object.values(buckets).forEach(render => render())
    } else if(isBucketKey(bucket)){
        buckets[bucket]();
    } else {
        console.log(bucket + "Is not a valid vallid bucket name. Please provide a valid bucket name(today, this-month, last-month, all-time");
    }
}

function renderBucketWithProvider (label : string, bucket : BucketWithProviders) : void {
    console.log("\n" + label + " : \n");

    for (const provider of Object.keys(bucket.byProvider) as ProviderId[]) {
        console.log(`${provider.padEnd(10)} ${"$".padStart(8) + bucket.byProvider[provider].totalCost}`);
    }
    console.log(`${label + " total : ".padEnd(10)} ${"$".padStart(8) + bucket.total}`);

}

function renderBucketTotalOnly (label : string, bucket : BucketTotalOnly) : void {
    console.log("\n" + label + "\n");
    console.log(`${"total".padEnd(10)} ${"$".padStart(8) + bucket.total}`);
}

function isBucketKey (value : string) : value is BucketKey {
    return value === 'today' || value === 'this-month' || value === 'last-month' || value === 'all-time';
}
