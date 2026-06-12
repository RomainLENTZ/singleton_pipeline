import { describe, it, expect } from 'vitest';
import { aggregate } from './aggregator.js';
import type { Run } from './types.js'
import { scanRuns } from './reader.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';


const run1: Run = {createdAt : "2026-06-04T13:11:23.495Z", provider : 'claude', cost : 0.04};
const run2: Run = {createdAt : "2026-06-04T13:11:23.495Z", provider : 'claude', cost : 0.06};
const run3: Run = {createdAt : "2026-06-02T13:11:23.495Z", provider : 'claude', cost : 0.10};
const run4: Run = {createdAt : "2026-05-04T13:11:23.495Z", provider : 'claude', cost : 0.30};
const run5: Run = {createdAt : "2026-03-04T13:11:23.495Z", provider : 'claude', cost : 0.02};

const run6: Run = {createdAt : "2026-06-04T13:11:23.495Z", provider : 'codex', cost : 0};
const run7: Run = {createdAt : "2026-06-04T13:11:23.495Z", provider : 'codex', cost : 0};

const runs = [run1, run2, run3, run4, run5, run6, run7];
const now = new Date('2026-06-03T12:00:00Z')

describe('aggregate', () => {
    it('returns an empty structure when there are no runs', () => {
        const result = aggregate([], new Date('2026-06-03T12:00:00Z'));
        expect(result.today.total).toBe(0);
        expect(result.lastMonth.total).toBe(0);
    });
});

describe('Test bucket through time ', () => {


    it('returns cost of claude today == $0.10', () => {
        const result = aggregate(runs, now);
        expect(result.today.total).toBe(0.10);
    });
    it('returns cost of claude last month == $0.30', () => {
        const result = aggregate(runs, now);
        expect(result.lastMonth.total).toBe(0.30);
    });
    it('returns cost of claude this month == $0.20', () => {
        const result = aggregate(runs, now);
        expect(result.thisMonth.total).toBe(0.20);
    });
    it('returns cost of claude all time == $0.52', () => {
        const result = aggregate(runs, now);
        expect(result.allTime.total).toBe(0.52);
    });
    it('returns all cost == $0.52', () => {
        const result = aggregate(runs, now);
        expect(result.allTime.total).toBe(0.52);
        expect(result.today.byProvider["codex"].reported).toBe(false);

    });
    it('returns reported false', () => {
        const result = aggregate(runs, now);
        expect(result.today.byProvider["codex"].reported).toBe(false);
    });
    it('returns reported true', () => {
        const result = aggregate(runs, now);
        expect(result.today.byProvider["claude"].reported).toBe(true);
    });
});

describe('Test total cost per provider through time', () => {
    it('returns today\'s claude total cost == 0.1 ', () => {
        const result = aggregate(runs, now);
        expect(result.today.byProvider["claude"].totalCost).toBe(0.1);
    })

    it('returns this month claude total cost == 0.1 ', () => {
        const result = aggregate(runs, now);
        expect(result.thisMonth.byProvider["claude"].totalCost).toBe(0.2);
    })

    it('returns all time claude total cost == 0.52 ', () => {
        const result = aggregate(runs, now);
        expect(result.allTime.byProvider["claude"].totalCost).toBe(0.52);
    })
});

describe('Test run count', () => {
    it('returns total claude run count == 5', () => {
        const result = aggregate(runs, now);
        expect(result.allTime.byProvider["claude"].runCount).toBe(5);
    })

    it('returns today\'s claude run count == 2', () => {
        const result = aggregate(runs, now);
        expect(result.today.byProvider["claude"].runCount).toBe(2);
    })

    it('returns total codex run count == 2', () => {
        const result = aggregate(runs, now);
        expect(result.allTime.byProvider["codex"].runCount).toBe(2);
    })

    it('returns total run count == 7', () => {
        const result = aggregate(runs, now);

        const totalRunCount = result.allTime.byProvider["codex"].runCount + result.allTime.byProvider["claude"].runCount;
        expect(totalRunCount).toBe(7);
    })
});