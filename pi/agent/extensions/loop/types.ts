/** Shared plain-data shapes for the loop extension. */

export interface StoredTask {
    /** 8-hex job id (first char a–f, never mistaken for an interval token). */
    id: string;
    /** 5-field cron string in local time — the scheduling truth. */
    cron: string;
    prompt: string;
    createdAt: number;
    /** Epoch ms of the most recent fire (recurring only). */
    lastFiredAt?: number;
    recurring?: boolean;
}

export interface LoopFile {
    version: 2;
    tasks: unknown[];
}

export interface OwnerLock {
    sessionId: string;
    pid: number;
    acquiredAt: number;
}

export interface LoopEnv {
    repoRoot: string;
}
