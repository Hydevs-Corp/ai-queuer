import { estimateTokenCount } from "tokenx";
import {
    RAMUsageStrategy,
    pocketbaseUsageStrategy,
    UsageStrategy,
    UsageBucket,
} from "./usage-strategy";

export interface QueueItem<T = any> {
    id: string;
    execute: () => Promise<T>;
    tokens?: number;
    modelName?: string;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
}

export type LimitType = "RPS" | "RPm" | "RPD" | "TPM" | "TPm" | "RPM";

export interface RateLimitConfig {
    type: LimitType;
    limit: number;
}

export interface QueuerOptions {
    defaultLimits?: RateLimitConfig[];
    modelLimits?: Record<string, RateLimitConfig[]>;
    fallbackDelayMs?: number;
    label?: string;
    usageStrategy?: "RAM" | "pocketbase";
}

export class RequestQueuer {
    private queue: QueueItem[] = [];
    private isProcessing = false;
    private readonly opts: QueuerOptions;
    private readonly usage: UsageStrategy;

    private execEwmaMs: number | undefined;
    private readonly execEwmaAlpha = 0.25; // smoothing factor
    private execSamples = 0;

    constructor(options: QueuerOptions = {}) {
        this.opts = options;
        const makeInitial = () => ({
            secondWindowTimestamps: [],
            minuteWindowTimestamps: [],
            dayWindowTimestamps: [],
            monthTokenCount: 0,
            monthTokenResetAt: RequestQueuer.startOfNextMonth(),
            monthRequestCount: 0,
            monthRequestResetAt: RequestQueuer.startOfNextMonth(),
            minuteTokenCount: 0,
            minuteTokenWindowStart: Date.now(),
        });
        const strategy = (options.usageStrategy || "RAM").toLowerCase();
        if (strategy === "pocketbase") {
            this.usage = new pocketbaseUsageStrategy(makeInitial, {
                label: options.label,
            });
        } else {
            this.usage = new RAMUsageStrategy(makeInitial);
        }
    }

    public getUsageSnapshot(): Record<
        string,
        {
            second: { requests: number };
            minute: {
                requests: number;
                tokens: { count: number; windowStart: number };
            };
            day: { requests: number; windowMs: number };
            month: {
                requests: {
                    count: number;
                    resetAt: number;
                    resetInMs: number;
                };
                tokens: {
                    count: number;
                    resetAt: number;
                    resetInMs: number;
                };
            };
        }
    > {
        const now = Date.now();
        const out: Record<string, any> = {};
        for (const [model, usage] of this.usage.entries()) {
            this.maybeResetMonthlyTokens(now, usage as any);
            this.maybeResetMonthlyRequests(now, usage as any);
            this.maybeResetMinuteTokens(now, usage as any);
            this.pruneWindows(now, usage as any);

            const secondCount = usage.secondWindowTimestamps.length;
            const minuteReqCount = usage.minuteWindowTimestamps.length;
            const dayReqCount = usage.dayWindowTimestamps.length;
            const minuteTokens = usage.minuteTokenCount;
            const minuteStart = usage.minuteTokenWindowStart;
            const monthTokenCount = usage.monthTokenCount;
            const monthTokenResetAt = usage.monthTokenResetAt;
            const monthReqCount = usage.monthRequestCount;
            const monthReqResetAt = usage.monthRequestResetAt;

            out[model] = {
                second: { requests: secondCount },
                minute: {
                    requests: minuteReqCount,
                    tokens: { count: minuteTokens, windowStart: minuteStart },
                },
                day: { requests: dayReqCount, windowMs: 86_400_000 },
                month: {
                    requests: {
                        count: monthReqCount,
                        resetAt: monthReqResetAt,
                        resetInMs: Math.max(0, monthReqResetAt - now),
                    },
                    tokens: {
                        count: monthTokenCount,
                        resetAt: monthTokenResetAt,
                        resetInMs: Math.max(0, monthTokenResetAt - now),
                    },
                },
            };
        }
        return out;
    }

    static startOfNextMonth(): number {
        const now = new Date();
        const next = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
        return next.getTime();
    }

    async add<T>(
        executeFunction: () => Promise<T>,
        tokenEstimateText?: string,
        modelName?: string
    ): Promise<T> {
        const tokens = tokenEstimateText
            ? estimateTokenCount(tokenEstimateText)
            : undefined;

        const activeLimits = this.getActiveLimits(modelName);
        if (
            (!activeLimits || activeLimits.length === 0) &&
            !this.opts.fallbackDelayMs
        ) {
            return executeFunction();
        }

        return new Promise<T>((resolve, reject) => {
            const item: QueueItem<T> = {
                id:
                    Date.now().toString() +
                    Math.random().toString(36).substr(2, 9),
                execute: executeFunction,
                tokens,
                modelName,
                resolve,
                reject,
            };
            this.queue.push(item);
            this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;
        try {
            while (this.queue.length > 0) {
                const now = Date.now();

                let runnableIndex = -1;
                let minWait = Number.POSITIVE_INFINITY;
                for (let i = 0; i < this.queue.length; i++) {
                    const qi = this.queue[i];
                    const wait = this.computeWaitMs(
                        now,
                        qi.modelName,
                        qi.tokens || 0
                    );
                    if (wait <= 0) {
                        runnableIndex = i;
                        break;
                    }
                    if (wait < minWait) minWait = wait;
                }

                if (runnableIndex === -1) {
                    await this.delay(Math.max(1, Math.min(minWait, 5_000)));
                    continue;
                }

                const item = this.queue.splice(runnableIndex, 1)[0];
                if (!item) continue;

                try {
                    console.log(`Processing queue item ${item.id}`);
                    const start = Date.now();
                    try {
                        const result = await item.execute();
                        item.resolve(result);
                        const end = Date.now();
                        this.recordUsage(end, item.tokens || 0, item.modelName);
                        void this.usage.persist(end).catch(() => {});
                    } finally {
                        const duration = Date.now() - start;
                        this.updateExecDuration(duration);
                    }
                } catch (error) {
                    console.error(
                        `Error processing queue item ${
                            item.id
                        } inside "${this.getLabel()}" queue with the model "${
                            item.modelName
                        }":`,
                        error
                    );
                    item.reject(
                        error instanceof Error
                            ? error
                            : new Error(String(error))
                    );
                }

                if (this.opts.fallbackDelayMs && this.queue.length > 0) {
                    await this.delay(this.opts.fallbackDelayMs);
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    private updateExecDuration(durationMs: number) {
        if (!Number.isFinite(durationMs) || durationMs < 0) return;
        if (this.execEwmaMs == null) {
            this.execEwmaMs = durationMs;
        } else {
            this.execEwmaMs =
                this.execEwmaAlpha * durationMs +
                (1 - this.execEwmaAlpha) * this.execEwmaMs;
        }
        this.execSamples++;
    }

    private getEstimatedExecMs(): number {
        return this.execEwmaMs ?? 500;
    }

    private computeWaitMs(
        now: number,
        modelName?: string,
        tokensNeeded: number = 0
    ): number {
        const active = this.getActiveLimits(modelName);
        if (!active || active.length === 0) return 0;

        const usage = this.getUsageBucket(modelName);
        this.maybeResetMonthlyTokens(now, usage);
        this.maybeResetMonthlyRequests(now, usage);
        this.maybeResetMinuteTokens(now, usage);
        this.pruneWindows(now, usage);

        let waitMs = 0;
        for (const l of active) {
            if (l.type === "RPS") {
                if (usage.secondWindowTimestamps.length >= l.limit) {
                    const earliest = usage.secondWindowTimestamps[0];
                    waitMs = Math.max(waitMs, 1000 - (now - earliest));
                }
            } else if (l.type === "RPm") {
                if (usage.minuteWindowTimestamps.length >= l.limit) {
                    const earliest = usage.minuteWindowTimestamps[0];
                    waitMs = Math.max(waitMs, 60_000 - (now - earliest));
                }
            } else if (l.type === "RPD") {
                if (usage.dayWindowTimestamps.length >= l.limit) {
                    const earliest = usage.dayWindowTimestamps[0];
                    waitMs = Math.max(waitMs, 86_400_000 - (now - earliest));
                }
            } else if (l.type === "TPM") {
                if (
                    usage.monthTokenCount + Math.max(0, tokensNeeded) >
                    l.limit
                ) {
                    waitMs = Math.max(waitMs, usage.monthTokenResetAt - now);
                }
            } else if (l.type === "RPM") {
                if (usage.monthRequestCount + 1 > l.limit) {
                    waitMs = Math.max(waitMs, usage.monthRequestResetAt - now);
                }
            } else if (l.type === "TPm") {
                const windowAge = now - usage.minuteTokenWindowStart;
                if (windowAge >= 60_000) {
                } else if (
                    usage.minuteTokenCount + Math.max(0, tokensNeeded) >
                    l.limit
                ) {
                    const until = usage.minuteTokenWindowStart + 60_000;
                    waitMs = Math.max(waitMs, until - now);
                }
            }
        }
        return Math.max(0, waitMs);
    }

    public estimateWaitMs(
        modelName?: string,
        tokensNeeded: number = 0
    ): number {
        const now = Date.now();

        const activeForThis = this.getActiveLimits(modelName);
        if (
            (!activeForThis || activeForThis.length === 0) &&
            !this.opts.fallbackDelayMs
        ) {
            return 0;
        }

        const usageSim = new Map<
            string,
            {
                secondWindowTimestamps: number[];
                minuteWindowTimestamps: number[];
                dayWindowTimestamps: number[];
                monthTokenCount: number;
                monthTokenResetAt: number;
                monthRequestCount: number;
                monthRequestResetAt: number;
                minuteTokenCount: number;
                minuteTokenWindowStart: number;
            }
        >();

        for (const [k, u] of this.usage.entries()) {
            usageSim.set(k, {
                secondWindowTimestamps: [...u.secondWindowTimestamps],
                minuteWindowTimestamps: [...u.minuteWindowTimestamps],
                dayWindowTimestamps: [...u.dayWindowTimestamps],
                monthTokenCount: u.monthTokenCount,
                monthTokenResetAt: u.monthTokenResetAt,
                monthRequestCount: u.monthRequestCount,
                monthRequestResetAt: u.monthRequestResetAt,
                minuteTokenCount: u.minuteTokenCount,
                minuteTokenWindowStart: u.minuteTokenWindowStart,
            });
        }

        const getKey = (m?: string) => (m ? m : "__default__");
        const getBucketSim = (m?: string) => {
            const key = getKey(m);
            let b = usageSim.get(key);
            if (!b) {
                b = {
                    secondWindowTimestamps: [],
                    minuteWindowTimestamps: [],
                    dayWindowTimestamps: [],
                    monthTokenCount: 0,
                    monthTokenResetAt: RequestQueuer.startOfNextMonth(),
                    monthRequestCount: 0,
                    monthRequestResetAt: RequestQueuer.startOfNextMonth(),
                    minuteTokenCount: 0,
                    minuteTokenWindowStart: now,
                };
                usageSim.set(key, b);
            }
            return b;
        };

        const pruneSim = (
            t: number,
            usage: {
                secondWindowTimestamps: number[];
                minuteWindowTimestamps: number[];
                dayWindowTimestamps: number[];
            }
        ) => this.pruneWindows(t, usage);

        const maybeResetMonthlyTokensSim = (
            t: number,
            usage: {
                monthTokenCount: number;
                monthTokenResetAt: number;
            }
        ) => this.maybeResetMonthlyTokens(t, usage);

        const maybeResetMonthlyRequestsSim = (
            t: number,
            usage: {
                monthRequestCount: number;
                monthRequestResetAt: number;
            }
        ) => this.maybeResetMonthlyRequests(t, usage);
        const maybeResetMinuteTokensSim = (
            t: number,
            usage: {
                minuteTokenCount: number;
                minuteTokenWindowStart: number;
            }
        ) => this.maybeResetMinuteTokens(t, usage);

        const computeWaitSim = (
            t: number,
            m?: string,
            tokens: number = 0
        ): number => {
            const limits = this.getActiveLimits(m);
            if (!limits || limits.length === 0) return 0;

            const usage = getBucketSim(m);
            maybeResetMonthlyTokensSim(t, usage);
            maybeResetMonthlyRequestsSim(t, usage);
            pruneSim(t, usage);

            let waitMs = 0;
            for (const l of limits) {
                if (l.type === "RPS") {
                    if (usage.secondWindowTimestamps.length >= l.limit) {
                        const earliest = usage.secondWindowTimestamps[0];
                        waitMs = Math.max(waitMs, 1000 - (t - earliest));
                    }
                } else if (l.type === "RPm") {
                    if (usage.minuteWindowTimestamps.length >= l.limit) {
                        const earliest = usage.minuteWindowTimestamps[0];
                        waitMs = Math.max(waitMs, 60_000 - (t - earliest));
                    }
                } else if (l.type === "RPD") {
                    if (usage.dayWindowTimestamps.length >= l.limit) {
                        const earliest = usage.dayWindowTimestamps[0];
                        waitMs = Math.max(waitMs, 86_400_000 - (t - earliest));
                    }
                } else if (l.type === "TPM") {
                    if (usage.monthTokenCount + Math.max(0, tokens) > l.limit) {
                        waitMs = Math.max(waitMs, usage.monthTokenResetAt - t);
                    }
                } else if (l.type === "RPM") {
                    if (usage.monthRequestCount + 1 > l.limit) {
                        waitMs = Math.max(
                            waitMs,
                            usage.monthRequestResetAt - t
                        );
                    }
                } else if (l.type === "TPm") {
                    const windowAge = t - usage.minuteTokenWindowStart;
                    if (windowAge >= 60_000) {
                    } else if (
                        usage.minuteTokenCount + Math.max(0, tokens) >
                        l.limit
                    ) {
                        const until = usage.minuteTokenWindowStart + 60_000;
                        waitMs = Math.max(waitMs, until - t);
                    }
                }
            }
            return Math.max(0, waitMs);
        };

        const recordUsageSim = (t: number, tokens: number, m?: string) => {
            const usage = getBucketSim(m);
            usage.secondWindowTimestamps.push(t);
            usage.minuteWindowTimestamps.push(t);
            usage.dayWindowTimestamps.push(t);
            if (tokens > 0) usage.monthTokenCount += tokens;
            usage.monthRequestCount += 1;
            if (t - usage.minuteTokenWindowStart >= 60_000) {
                usage.minuteTokenWindowStart = t;
                usage.minuteTokenCount = 0;
            }
            if (tokens > 0) usage.minuteTokenCount += tokens;
            pruneSim(t, usage);
        };

        type SimItem = {
            modelName?: string;
            tokens: number;
            hypothetical?: boolean;
        };
        const simQueue: SimItem[] = [
            ...this.queue.map((q) => ({
                modelName: q.modelName,
                tokens: q.tokens || 0,
            })),
            {
                modelName,
                tokens: Math.max(0, tokensNeeded),
                hypothetical: true,
            },
        ];

        let tCursor = now;
        const perItemExecMs = this.getEstimatedExecMs();
        while (simQueue.length) {
            let runnableIndex = -1;
            let minWait = Number.POSITIVE_INFINITY;
            for (let i = 0; i < simQueue.length; i++) {
                const item = simQueue[i];
                const wait = computeWaitSim(
                    tCursor,
                    item.modelName,
                    item.tokens
                );
                if (wait <= 0) {
                    runnableIndex = i;
                    break;
                }
                if (wait < minWait) minWait = wait;
            }

            if (runnableIndex === -1) {
                const advance = Math.max(1, Math.min(minWait, 5_000));
                tCursor += advance;
                continue;
            }

            const next = simQueue.splice(runnableIndex, 1)[0];
            if (next.hypothetical) {
                return Math.max(0, tCursor - now);
            }

            recordUsageSim(tCursor, next.tokens, next.modelName);

            tCursor += Math.max(0, perItemExecMs);

            if (this.opts.fallbackDelayMs && simQueue.length > 0) {
                tCursor += this.opts.fallbackDelayMs;
            }
        }

        return 0;
    }

    public getConfiguredLimits(
        modelName?: string
    ): RateLimitConfig[] | undefined {
        return this.getActiveLimits(modelName);
    }

    private getActiveLimits(modelName?: string): RateLimitConfig[] | undefined {
        const dl = this.opts.defaultLimits || [];
        const ml = this.opts.modelLimits || {};

        if (modelName && ml[modelName] && ml[modelName].length) {
            const modelSpecificLimits = ml[modelName];
            const combinedLimits = dl.map((defaultLimit) => {
                const override = modelSpecificLimits.find(
                    (modelLimit) => modelLimit.type === defaultLimit.type
                );
                return override || defaultLimit;
            });
            return [
                ...combinedLimits,
                ...modelSpecificLimits.filter(
                    (modelLimit) =>
                        !dl.some(
                            (defaultLimit) =>
                                defaultLimit.type === modelLimit.type
                        )
                ),
            ];
        }

        return dl.length ? dl : undefined;
    }

    private recordUsage(now: number, tokens: number, modelName?: string) {
        const usage = this.getUsageBucket(modelName);

        usage.secondWindowTimestamps.push(now);
        usage.minuteWindowTimestamps.push(now);
        usage.dayWindowTimestamps.push(now);

        if (tokens > 0) usage.monthTokenCount += tokens;
        usage.monthRequestCount += 1;
        if (now - usage.minuteTokenWindowStart >= 60_000) {
            usage.minuteTokenWindowStart = now;
            usage.minuteTokenCount = 0;
        }
        if (tokens > 0) usage.minuteTokenCount += tokens;

        this.pruneWindows(now, usage);
        void this.usage.persist(now).catch(() => {});
    }

    private pruneWindows(
        now: number,
        usage: {
            secondWindowTimestamps: number[];
            minuteWindowTimestamps: number[];
            dayWindowTimestamps: number[];
        }
    ) {
        const oneSecAgo = now - 1000;
        const oneMinAgo = now - 60_000;
        const oneDayAgo = now - 86_400_000;
        while (
            usage.secondWindowTimestamps.length &&
            usage.secondWindowTimestamps[0] <= oneSecAgo
        ) {
            usage.secondWindowTimestamps.shift();
        }
        while (
            usage.minuteWindowTimestamps.length &&
            usage.minuteWindowTimestamps[0] <= oneMinAgo
        ) {
            usage.minuteWindowTimestamps.shift();
        }
        while (
            usage.dayWindowTimestamps.length &&
            usage.dayWindowTimestamps[0] <= oneDayAgo
        ) {
            usage.dayWindowTimestamps.shift();
        }
    }

    private maybeResetMonthlyTokens(
        now: number,
        usage: {
            monthTokenCount: number;
            monthTokenResetAt: number;
        }
    ) {
        if (now >= usage.monthTokenResetAt) {
            usage.monthTokenCount = 0;
            usage.monthTokenResetAt = RequestQueuer.startOfNextMonth();
        }
    }

    private maybeResetMonthlyRequests(
        now: number,
        usage: {
            monthRequestCount: number;
            monthRequestResetAt: number;
        }
    ) {
        if (now >= usage.monthRequestResetAt) {
            usage.monthRequestCount = 0;
            usage.monthRequestResetAt = RequestQueuer.startOfNextMonth();
        }
    }

    private maybeResetMinuteTokens(
        now: number,
        usage: {
            minuteTokenCount: number;
            minuteTokenWindowStart: number;
        }
    ) {
        if (now - usage.minuteTokenWindowStart >= 60_000) {
            usage.minuteTokenCount = 0;
            usage.minuteTokenWindowStart = now;
        }
    }

    private getUsageBucket(modelName?: string): UsageBucket {
        const key = modelName || "__default__";
        return this.usage.getBucket(key);
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    getQueueLength(): number {
        return this.queue.length;
    }

    getLabel(): string | undefined {
        return this.opts.label;
    }

    isCurrentlyProcessing(): boolean {
        return this.isProcessing;
    }
}
