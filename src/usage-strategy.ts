/**
 * Usage storage strategies for RequestQueuer
 * - RAMUsageStrategy: in-memory map (default)
 * - pocketbaseUsageStrategy: persists usage snapshots to pocketbase
 */

export type UsageBucket = {
    secondWindowTimestamps: number[];
    minuteWindowTimestamps: number[];
    dayWindowTimestamps: number[];
    monthTokenCount: number;
    monthTokenResetAt: number;
    monthRequestCount: number;
    monthRequestResetAt: number;
    minuteTokenCount: number;
    minuteTokenWindowStart: number;
};

export interface UsageStrategy {
    getBucket(modelKey: string): UsageBucket;
    setBucket(modelKey: string, bucket: UsageBucket): void;
    entries(): IterableIterator<[string, UsageBucket]>;
    persist(now?: number): Promise<void>;
    dispose?(): void;
}

export class RAMUsageStrategy implements UsageStrategy {
    private map = new Map<string, UsageBucket>();

    constructor(private readonly initialFactory: () => UsageBucket) {}

    getBucket(modelKey: string): UsageBucket {
        let u = this.map.get(modelKey);
        if (!u) {
            u = this.initialFactory();
            this.map.set(modelKey, u);
        }
        return u;
    }
    setBucket(modelKey: string, bucket: UsageBucket): void {
        this.map.set(modelKey, bucket);
    }
    *entries(): IterableIterator<[string, UsageBucket]> {
        yield* this.map.entries();
    }
    async persist(): Promise<void> {
        // no-op for RAM
    }
}

type PBAuth = { token: string; tokenExpires?: number };

export type pocketbaseUsageOptions = {
    url?: string; // PB_URL
    username?: string; // PB_USERNAME
    password?: string; // PB_PASSWORD
    collection?: string; // PB_USAGE_COLLECTION, default "usage"
    label?: string; // queue label to disambiguate keys across queues
    autoIntervalMs?: number; // auto persist interval
};

export class pocketbaseUsageStrategy implements UsageStrategy {
    private map = new Map<string, UsageBucket>();
    private recordIds = new Map<string, string>(); // key -> record id
    private changed = new Set<string>();
    private auth: PBAuth | null = null;
    private disposed = false;
    private timer?: ReturnType<typeof setInterval>;

    private readonly url: string;
    private readonly username: string;
    private readonly password: string;
    private readonly collection: string;
    private readonly label?: string;

    constructor(
        private readonly initialFactory: () => UsageBucket,
        opts: pocketbaseUsageOptions = {}
    ) {
        const getEnv = (k: string, fb?: string) =>
            process.env[k] ?? (fb as any);
        this.url = (opts.url ?? getEnv("PB_URL"))?.replace(/\/$/, "") ?? "";
        this.username = opts.username ?? getEnv("PB_USERNAME") ?? "";
        this.password = opts.password ?? getEnv("PB_PASSWORD") ?? "";
        this.collection =
            opts.collection ??
            getEnv("PB_USAGE_COLLECTION", "usage") ??
            "usage";
        this.label = opts.label;
        const autoMs = opts.autoIntervalMs ?? 15_000;

        if (!this.url || !this.username || !this.password) {
            throw new Error(
                "pocketbaseUsageStrategy requires PB_URL, PB_USERNAME, PB_PASSWORD"
            );
        }
        // Load existing records synchronously in background; callers can use immediately with new buckets
        this.bootstrap().catch((e) => {
            console.error("pocketbase usage bootstrap failed:", e);
        });

        if (autoMs && Number.isFinite(autoMs) && autoMs > 0) {
            this.timer = setInterval(() => {
                this.persist().catch((e) =>
                    console.error("PB persist failed:", e)
                );
            }, autoMs);
        }
    }

    dispose() {
        this.disposed = true;
        if (this.timer) clearInterval(this.timer);
    }

    private makeKey(modelKey: string): string {
        return this.label ? `${this.label}::${modelKey}` : modelKey;
    }

    getBucket(modelKey: string): UsageBucket {
        const key = this.makeKey(modelKey);
        let u = this.map.get(key);
        if (!u) {
            u = this.initialFactory();
            this.map.set(key, u);
            this.changed.add(key);
        }
        return u;
    }
    setBucket(modelKey: string, bucket: UsageBucket): void {
        const key = this.makeKey(modelKey);
        this.map.set(key, bucket);
        this.changed.add(key);
    }
    *entries(): IterableIterator<[string, UsageBucket]> {
        // Present entries without label prefix to the caller
        for (const [k, v] of this.map.entries()) {
            const plain =
                this.label && k.startsWith(this.label + "::")
                    ? k.slice(this.label.length + 2)
                    : k;
            yield [plain, v];
        }
    }

    private async bootstrap(): Promise<void> {
        // authenticate and load existing usage records
        await this.ensureAuth();
        try {
            const listUrl = `${this.url}/api/collections/${this.collection}/records?perPage=200`;
            const res = await fetch(listUrl, {
                headers: { Authorization: `Bearer ${this.auth!.token}` },
            });
            if (!res.ok) {
                const t = await res.text().catch(() => "");
                throw new Error(
                    `PB list usage failed (${res.status}): ${
                        t || res.statusText
                    }`
                );
            }
            const json: any = await res.json();
            const items: any[] = Array.isArray(json?.items)
                ? json.items
                : Array.isArray(json)
                ? json
                : [];
            for (const it of items) {
                const key =
                    typeof it?.key === "string"
                        ? (it.key as string)
                        : undefined;
                const data = it?.data;
                if (!key || !data) continue;
                // Only load records that belong to this label (or all if no label)
                if (this.label) {
                    if (!key.startsWith(this.label + "::")) continue;
                }
                const bucket: UsageBucket | undefined = this.parseBucket(data);
                if (bucket) {
                    this.map.set(key, bucket);
                    if (typeof it?.id === "string")
                        this.recordIds.set(key, it.id);
                }
            }
        } catch (e) {
            console.error("pocketbase usage load error:", e);
        }
    }

    private parseBucket(obj: any): UsageBucket | undefined {
        try {
            const b = obj as UsageBucket;
            if (!b) return undefined;
            // validate minimal shape
            if (!Array.isArray(b.secondWindowTimestamps)) return undefined;
            if (!Array.isArray(b.minuteWindowTimestamps)) return undefined;
            if (!Array.isArray(b.dayWindowTimestamps)) return undefined;
            return {
                secondWindowTimestamps: b.secondWindowTimestamps
                    .map(Number)
                    .filter(Number.isFinite),
                minuteWindowTimestamps: b.minuteWindowTimestamps
                    .map(Number)
                    .filter(Number.isFinite),
                dayWindowTimestamps: b.dayWindowTimestamps
                    .map(Number)
                    .filter(Number.isFinite),
                monthTokenCount: Number(b.monthTokenCount) || 0,
                monthTokenResetAt: Number(b.monthTokenResetAt) || Date.now(),
                monthRequestCount: Number(b.monthRequestCount) || 0,
                monthRequestResetAt:
                    Number(b.monthRequestResetAt) || Date.now(),
                minuteTokenCount: Number(b.minuteTokenCount) || 0,
                minuteTokenWindowStart:
                    Number(b.minuteTokenWindowStart) || Date.now(),
            };
        } catch {
            return undefined;
        }
    }

    private async ensureAuth(): Promise<void> {
        if (this.auth?.token) return;
        const authUrl = `${this.url}/api/collections/${
            process.env.PB_USER_COLLECTION ?? "users"
        }/auth-with-password`;
        const res = await fetch(authUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                identity: this.username,
                password: this.password,
            }),
        });
        if (!res.ok) {
            const t = await res.text().catch(() => "");
            throw new Error(
                `pocketbase auth failed (${res.status}): ${t || res.statusText}`
            );
        }
        const j = (await res.json()) as { token?: string };
        if (!j.token) throw new Error("pocketbase auth response missing token");
        this.auth = { token: j.token };
    }

    async persist(): Promise<void> {
        if (this.disposed) return;
        await this.ensureAuth();
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.auth!.token}`,
        } as Record<string, string>;

        const toPersist = Array.from(this.changed.values());
        this.changed.clear();
        for (const key of toPersist) {
            const bucket = this.map.get(key);
            if (!bucket) continue;
            const recId = this.recordIds.get(key);
            const body = JSON.stringify({ key, data: bucket });
            try {
                if (recId) {
                    const url = `${this.url}/api/collections/${this.collection}/records/${recId}`;
                    const res = await fetch(url, {
                        method: "PATCH",
                        headers,
                        body,
                    });
                    if (!res.ok) {
                        // fallback to create (in case record was deleted)
                        await this.createRecord(headers, key, bucket);
                    }
                } else {
                    await this.createRecord(headers, key, bucket);
                }
            } catch (e) {
                console.error("pocketbase persist error for", key, e);
            }
        }
    }

    private async createRecord(
        headers: Record<string, string>,
        key: string,
        bucket: UsageBucket
    ) {
        const url = `${this.url}/api/collections/${this.collection}/records`;
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ key, data: bucket }),
        });
        if (res.ok) {
            try {
                const j: any = await res.json();
                if (typeof j?.id === "string") this.recordIds.set(key, j.id);
            } catch {}
        } else {
            const t = await res.text().catch(() => "");
            console.error(
                `pocketbase create usage failed (${res.status}): ${
                    t || res.statusText
                }`
            );
        }
    }
}
