import type {ManifestStat, Run} from "./types.js";
import path from "node:path";
import {ProviderId} from "../types.js";
import fs from 'node:fs/promises';


const PROVIDERS = ['claude', 'codex', 'copilot', 'opencode'] as const;

export async  function scanRuns(rootPath : string): Promise<Run[]> {

    const runsPath = path.join(rootPath, '.singleton' ,"runs")
    const rundDirectories = await fs.readdir(runsPath, { withFileTypes: true })

    const runs: Run[] = []

    for (const runDirectory of rundDirectories) {

        if(runDirectory.isDirectory()) {
            const runPath = path.join(runsPath, runDirectory.name)
            const directory = await fs.readdir(runPath, { withFileTypes: true })

            for (const file of directory) {
                if (file.isFile() && file.name == "run-manifest.json"){
                    const runManifestFile = path.join(runPath, file.name)
                    const runManifest = await fs.readFile(runManifestFile, 'utf8')
                    const runManifestJson = JSON.parse(runManifest)

                    for (const stats of runManifestJson["stats"]) {
                        if(!isProvider(stats.provider)) continue

                        runs.push({createdAt : runManifestJson.createdAt, provider : stats.provider, cost : stats.cost})
                    }
                }
            }
        }
    }

    return runs;
}

function isProvider(value: unknown): value is ProviderId {
    return value === 'claude' || value === 'codex' || value === 'copilot' || value === 'opencode';
}

