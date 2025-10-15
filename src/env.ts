/**
 * Environment strategies for resolving the Mistral API key.
 * Supports three strategies:
 *  - env: read directly from process.env.MISTRAL_API_KEY
 *  - pocketbase: authenticate against a pocketbase instance and read from a keys collection
 *  - fetch: fetch a JSON array of { name, key } from a URL
 */

export type EnvStrategy = "env" | "pocketbase" | "fetch";

export interface NamedKey {
    type?: string;
    name?: string;
    key: string;
    label?: string;
    limit?: any;
}

export type LimitType = "RPS" | "RPm" | "TPM" | "TPm" | "RPD" | "RPM";
export interface LimitConfig {
    type: LimitType;
    limit: number;
}

export interface KeyConfig {
    key: string;
    defaultLimits?: LimitConfig[];
    modelLimits?: Record<string, LimitConfig[]>;
    delayMs?: number; // for env strategy fallback
    label: string;
}

function normalizeLimits(raw: any): LimitConfig[] | undefined {
    if (!raw) return undefined;
    const arr = Array.isArray(raw) ? raw : [raw];
    const out: LimitConfig[] = [];
    for (const l of arr) {
        if (!l) continue;
        const type = l.type;
        const limit = typeof l.limit === "number" ? l.limit : Number(l.limit);
        if (type && Number.isFinite(limit)) out.push({ type, limit });
    }
    return out.length ? out : undefined;
}

function isLimitTypeKey(k: string): k is LimitType {
    return (
        k === "RPS" ||
        k === "RPm" ||
        k === "RPD" ||
        k === "TPM" ||
        k === "TPm" ||
        k === "RPM"
    );
}

function normalizeLimitsFlexible(raw: any): LimitConfig[] | undefined {
    if (!raw) return undefined;
    if (Array.isArray(raw)) return normalizeLimits(raw);
    if (typeof raw === "object") {
        const verbose = normalizeLimits(raw);
        if (verbose && verbose.length) return verbose;

        const out: LimitConfig[] = [];
        for (const [k, v] of Object.entries(raw)) {
            if (!isLimitTypeKey(k)) continue;
            const n = typeof v === "number" ? v : Number(v);
            if (Number.isFinite(n))
                out.push({ type: k as LimitType, limit: n });
        }
        return out.length ? out : undefined;
    }
    return undefined;
}

function getEnv(name: string, fallback?: string): string | undefined {
    const v = process.env[name];
    return v === undefined || v === null || v === "" ? fallback : v;
}

function assertEnv(names: string[]): void {
    const missing = names.filter((n) => !getEnv(n));
    if (missing.length) {
        throw new Error(
            `Missing required environment variables: ${missing.join(", ")}`
        );
    }
}

function pickFromRecord(
    record: Record<string, unknown>,
    provider: string
): string | undefined {
    const val = (record as any)[provider];
    if (typeof val === "string" && val.trim().length > 0) return val;
    return undefined;
}

function pickFromNamedList(
    list: NamedKey[],
    provider: string
): string | undefined {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const norm = (s: string) => (s || "").toLowerCase().trim();
    const item = list.find(
        (x) => norm(x.type || x.name || "") === norm(provider)
    );
    if (item && typeof item.key === "string" && item.key.trim())
        return item.key;
    return undefined;
}

function providerEnvVar(provider: string): string {
    return `${provider.toUpperCase()}_API_KEY`;
}

async function resolveFromEnvProvider(provider: string): Promise<string> {
    const envVar = providerEnvVar(provider);
    const key = getEnv(envVar);
    if (!key) throw new Error(`${envVar} environment variable is required`);
    return key;
}

async function resolveFrompocketbase(provider: string): Promise<string> {
    const PB_URL = getEnv("PB_URL");
    const PB_USERNAME = getEnv("PB_USERNAME");
    const PB_PASSWORD = getEnv("PB_PASSWORD");
    const PB_USER_COLLECTION = getEnv("PB_USER_COLLECTION", "users")!;
    const PB_KEYS_COLLECTIONS = getEnv("PB_KEYS_COLLECTIONS", "keys")!;

    assertEnv(["PB_URL", "PB_USERNAME", "PB_PASSWORD"]);

    const base = PB_URL!.replace(/\/$/, "");

    const authUrl = `${base}/api/collections/${PB_USER_COLLECTION}/auth-with-password`;
    const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: PB_USERNAME, password: PB_PASSWORD }),
    });

    if (!authRes.ok) {
        const text = await authRes.text().catch(() => "");
        throw new Error(
            `pocketbase auth failed (${authRes.status}): ${
                text || authRes.statusText
            }`
        );
    }
    const authJson = (await authRes.json()) as { token?: string };
    const token = authJson.token;
    if (!token) throw new Error("pocketbase auth response missing token");

    const keysUrl = `${base}/api/collections/${PB_KEYS_COLLECTIONS}/records?perPage=50`;
    const keysRes = await fetch(keysUrl, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!keysRes.ok) {
        const text = await keysRes.text().catch(() => "");
        throw new Error(
            `pocketbase keys fetch failed (${keysRes.status}): ${
                text || keysRes.statusText
            }`
        );
    }
    const keysJson = (await keysRes.json()) as any;
    const items: any[] = Array.isArray(keysJson?.items)
        ? keysJson.items
        : Array.isArray(keysJson)
        ? keysJson
        : [];

    if (!items.length) throw new Error("pocketbase keys collection is empty");

    const named = items
        .map((it) => ({ type: it?.type, name: it?.name, key: it?.key }))
        .filter(
            (x) =>
                (typeof x.type === "string" || typeof x.name === "string") &&
                typeof x.key === "string"
        ) as NamedKey[];
    let key = pickFromNamedList(named, provider);
    if (!key) {
        const norm = (s: string) => (s || "").toLowerCase().trim();
        const rec = items.find(
            (it) =>
                typeof it?.name === "string" &&
                norm(it.name) === norm(provider) &&
                typeof it?.key === "string" &&
                it.key.trim()
        );
        key = rec?.key;
        if (!key) {
            for (const it of items) {
                const v = pickFromRecord(it, provider);
                if (v) {
                    key = v;
                    break;
                }
            }
        }
    }

    if (!key)
        throw new Error("No valid Mistral API key found in pocketbase records");
    return key;
}

async function resolveAllFrompocketbase(provider: string): Promise<string[]> {
    const PB_URL = getEnv("PB_URL");
    const PB_USERNAME = getEnv("PB_USERNAME");
    const PB_PASSWORD = getEnv("PB_PASSWORD");
    const PB_USER_COLLECTION = getEnv("PB_USER_COLLECTION", "users")!;
    const PB_KEYS_COLLECTIONS = getEnv("PB_KEYS_COLLECTIONS", "keys")!;

    assertEnv(["PB_URL", "PB_USERNAME", "PB_PASSWORD"]);

    const base = PB_URL!.replace(/\/$/, "");

    const authUrl = `${base}/api/collections/${PB_USER_COLLECTION}/auth-with-password`;
    const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: PB_USERNAME, password: PB_PASSWORD }),
    });
    if (!authRes.ok) {
        const text = await authRes.text().catch(() => "");
        throw new Error(
            `pocketbase auth failed (${authRes.status}): ${
                text || authRes.statusText
            }`
        );
    }
    const { token } = (await authRes.json()) as { token?: string };
    if (!token) throw new Error("pocketbase auth response missing token");

    const keysUrl = `${base}/api/collections/${PB_KEYS_COLLECTIONS}/records?perPage=200`;
    const keysRes = await fetch(keysUrl, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!keysRes.ok) {
        const text = await keysRes.text().catch(() => "");
        throw new Error(
            `pocketbase keys fetch failed (${keysRes.status}): ${
                text || keysRes.statusText
            }`
        );
    }
    const keysJson = (await keysRes.json()) as any;
    const items: any[] = Array.isArray(keysJson?.items)
        ? keysJson.items
        : Array.isArray(keysJson)
        ? keysJson
        : [];
    if (!items.length) throw new Error("pocketbase keys collection is empty");

    const named = items
        .map((it) => ({ type: it?.type, name: it?.name, key: it?.key }))
        .filter(
            (x) =>
                (typeof x.type === "string" || typeof x.name === "string") &&
                typeof x.key === "string"
        ) as NamedKey[];

    let keys: string[] = [];
    if (named.length) {
        const norm = (s: string) => (s || "").toLowerCase().trim();
        keys = named
            .filter((x) => norm(x.type || x.name || "") === norm(provider))
            .map((x) => x.key)
            .filter((k) => typeof k === "string" && k.trim());
    }

    if (!keys.length) {
        for (const it of items) {
            const v = pickFromRecord(it, provider);
            if (v) keys.push(v);
        }
    }

    keys = Array.from(new Set(keys.map((k) => k.trim()))).filter(Boolean);
    if (!keys.length)
        throw new Error(
            "No valid Mistral API keys found in pocketbase records"
        );
    return keys;
}

async function resolveKeyConfigsFrompocketbase(
    provider: string
): Promise<KeyConfig[]> {
    const PB_URL = getEnv("PB_URL");
    const PB_USERNAME = getEnv("PB_USERNAME");
    const PB_PASSWORD = getEnv("PB_PASSWORD");
    const PB_USER_COLLECTION = getEnv("PB_USER_COLLECTION", "users")!;
    const PB_KEYS_COLLECTIONS = getEnv("PB_KEYS_COLLECTIONS", "keys")!;

    assertEnv(["PB_URL", "PB_USERNAME", "PB_PASSWORD"]);

    const base = PB_URL!.replace(/\/$/, "");
    const authUrl = `${base}/api/collections/${PB_USER_COLLECTION}/auth-with-password`;
    const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: PB_USERNAME, password: PB_PASSWORD }),
    });
    if (!authRes.ok) {
        const text = await authRes.text().catch(() => "");
        throw new Error(
            `pocketbase auth failed (${authRes.status}): ${
                text || authRes.statusText
            }`
        );
    }
    const { token } = (await authRes.json()) as { token?: string };
    if (!token) throw new Error("pocketbase auth response missing token");

    const keysUrl = `${base}/api/collections/${PB_KEYS_COLLECTIONS}/records?perPage=200`;
    const keysRes = await fetch(keysUrl, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!keysRes.ok) {
        const text = await keysRes.text().catch(() => "");
        throw new Error(
            `pocketbase keys fetch failed (${keysRes.status}): ${
                text || keysRes.statusText
            }`
        );
    }
    const keysJson = (await keysRes.json()) as any;
    const items: any[] = Array.isArray(keysJson?.items)
        ? keysJson.items
        : Array.isArray(keysJson)
        ? keysJson
        : [];
    if (!items.length) return [];

    const norm = (s: string) => (s || "").toLowerCase().trim();

    const results: KeyConfig[] = [];
    for (const it of items) {
        const type = typeof it?.type === "string" ? it.type : undefined;
        const name = typeof it?.name === "string" ? it.name : undefined;
        if (norm(type || name || "") !== norm(provider)) continue;

        const key: string | undefined =
            typeof it?.key === "string" && it.key.trim()
                ? it.key
                : pickFromRecord(it, provider);
        if (!key) continue;

        let defaultLimits: LimitConfig[] | undefined;
        let modelLimits: Record<string, LimitConfig[]> | undefined;
        const rawLimit = (it as any)?.limit;
        if (rawLimit) {
            if (Array.isArray(rawLimit)) {
                defaultLimits = normalizeLimitsFlexible(rawLimit);
            } else if (typeof rawLimit === "object") {
                const keys = Object.keys(rawLimit);
                const looksLikeDefaultCompact = keys.every(
                    (k) => isLimitTypeKey(k) || k === "default"
                );
                const perModel: Record<string, LimitConfig[]> = {};
                if (looksLikeDefaultCompact && !keys.includes("default")) {
                    defaultLimits = normalizeLimitsFlexible(rawLimit);
                } else {
                    for (const mk of keys) {
                        const entry = (rawLimit as any)[mk];
                        if (mk === "default")
                            defaultLimits = normalizeLimitsFlexible(entry);
                        else {
                            const lim = normalizeLimitsFlexible(entry);
                            if (lim && lim.length) perModel[mk] = lim;
                        }
                    }
                }
                modelLimits = Object.keys(perModel).length
                    ? perModel
                    : undefined;
            }
        }
        results.push({ key, defaultLimits, modelLimits, label: it.label });
    }

    const seen = new Set<string>();
    const deduped = results.filter((r) => {
        if (seen.has(r.key)) return false;
        seen.add(r.key);
        return true;
    });
    return deduped;
}

async function resolveFromFetch(provider: string): Promise<string> {
    const url = getEnv("ENV_FETCH_URL");
    const token = getEnv("ENV_FETCH_TOKEN");
    assertEnv(["ENV_FETCH_URL"]);

    const res = await fetch(url!, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
            `ENV fetch failed (${res.status}): ${text || res.statusText}`
        );
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
        throw new Error("ENV fetch response is not an array of {name, key}");
    }
    const list = data as NamedKey[];
    const key = pickFromNamedList(list, provider);
    if (!key)
        throw new Error(`No valid ${provider} API key found in fetched data`);
    return key;
}

async function resolveAllFromFetch(provider: string): Promise<string[]> {
    const url = getEnv("ENV_FETCH_URL");
    const token = getEnv("ENV_FETCH_TOKEN");
    assertEnv(["ENV_FETCH_URL"]);

    const res = await fetch(url!, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
            `ENV fetch failed (${res.status}): ${text || res.statusText}`
        );
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
        throw new Error("ENV fetch response is not an array of {type, key}");
    }
    const list = data as NamedKey[];
    const norm = (s: string) => (s || "").toLowerCase().trim();

    let keys: string[] = list
        .filter((x) => norm(x.type || x.name || "") === norm(provider))
        .map((x) => x.key)
        .filter((k) => typeof k === "string" && k.trim());

    keys = Array.from(new Set(keys.map((k) => k.trim()))).filter(Boolean);
    if (!keys.length)
        throw new Error(`No valid ${provider} API keys found in fetched data`);
    return keys;
}

async function resolveKeyConfigsFromFetch(
    provider: string
): Promise<KeyConfig[]> {
    const url = getEnv("ENV_FETCH_URL");
    const token = getEnv("ENV_FETCH_TOKEN");
    assertEnv(["ENV_FETCH_URL"]);

    const res = await fetch(url!, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
            `ENV fetch failed (${res.status}): ${text || res.statusText}`
        );
    }
    const data = (await res.json()) as any;
    const list: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
        ? data.items
        : [];
    const norm = (s: string) => (s || "").toLowerCase().trim();

    const results: KeyConfig[] = [];
    for (const it of list) {
        const type = typeof it?.type === "string" ? it.type : undefined;
        const name = typeof it?.name === "string" ? it.name : undefined;
        if (norm(type || name || "") !== norm(provider)) continue;
        let key: string | undefined =
            typeof it?.key === "string" && it.key.trim()
                ? it.key
                : pickFromRecord(it, provider);
        if (!key) continue;
        let defaultLimits: LimitConfig[] | undefined;
        let modelLimits: Record<string, LimitConfig[]> | undefined;
        const rawLimit = (it as any)?.limit;
        if (rawLimit) {
            if (Array.isArray(rawLimit)) {
                defaultLimits = normalizeLimitsFlexible(rawLimit);
            } else if (typeof rawLimit === "object") {
                const keys = Object.keys(rawLimit);
                const looksLikeDefaultCompact = keys.every(
                    (k) => isLimitTypeKey(k) || k === "default"
                );
                const perModel: Record<string, LimitConfig[]> = {};
                if (looksLikeDefaultCompact && !keys.includes("default")) {
                    defaultLimits = normalizeLimitsFlexible(rawLimit);
                } else {
                    for (const mk of keys) {
                        const entry = (rawLimit as any)[mk];
                        if (mk === "default")
                            defaultLimits = normalizeLimitsFlexible(entry);
                        else {
                            const lim = normalizeLimitsFlexible(entry);
                            if (lim && lim.length) perModel[mk] = lim;
                        }
                    }
                }
                modelLimits = Object.keys(perModel).length
                    ? perModel
                    : undefined;
            }
        }
        results.push({ key, defaultLimits, modelLimits, label: it.label });
    }

    const seen = new Set<string>();
    const deduped = results.filter((r) => {
        if (seen.has(r.key)) return false;
        seen.add(r.key);
        return true;
    });
    return deduped;
}

export async function resolveProviderApiKey(provider: string): Promise<string> {
    const strategy = (
        getEnv("ENV_STRATEGY", "env") as EnvStrategy
    ).toLowerCase() as EnvStrategy;
    switch (strategy) {
        case "env":
            return resolveFromEnvProvider(provider);
        case "pocketbase":
            return resolveFrompocketbase(provider);
        case "fetch":
            return resolveFromFetch(provider);
        default:
            throw new Error(`Unknown ENV_STRATEGY: ${strategy}`);
    }
}

export async function resolveMistralApiKey(): Promise<string> {
    return resolveProviderApiKey("mistral");
}
export async function resolveGeminiApiKey(): Promise<string> {
    return resolveProviderApiKey("gemini");
}

export async function resolveProviderApiKeys(
    provider: string
): Promise<string[]> {
    const strategy = (
        getEnv("ENV_STRATEGY", "env") as EnvStrategy
    ).toLowerCase() as EnvStrategy;
    switch (strategy) {
        case "env":
            return [await resolveFromEnvProvider(provider)];
        case "pocketbase":
            return resolveAllFrompocketbase(provider);
        case "fetch":
            return resolveAllFromFetch(provider);
        default:
            throw new Error(`Unknown ENV_STRATEGY: ${strategy}`);
    }
}

export async function resolveMistralApiKeys(): Promise<string[]> {
    return resolveProviderApiKeys("mistral");
}
export async function resolveGeminiApiKeys(): Promise<string[]> {
    return resolveProviderApiKeys("gemini");
}

export function getEnvStrategy(): EnvStrategy {
    const s = (getEnv("ENV_STRATEGY", "env") || "env").toLowerCase();
    if (s === "env" || s === "pocketbase" || s === "fetch") return s;
    return "env";
}

export async function resolveProviderKeyConfigs(
    provider: string
): Promise<KeyConfig[]> {
    const strategy = getEnvStrategy();
    if (strategy === "env") {
        const key = await resolveFromEnvProvider(provider);
        const delayStr = getEnv("QUEUER_DELAY", "1000");
        const delayMs = Number(delayStr);
        return [
            {
                key,
                delayMs:
                    Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 1000,
                label: "env",
            },
        ];
    }
    if (strategy === "pocketbase") {
        return resolveKeyConfigsFrompocketbase(provider);
    }
    if (strategy === "fetch") {
        return resolveKeyConfigsFromFetch(provider);
    }
    throw new Error(`Unknown ENV_STRATEGY: ${strategy}`);
}

export async function resolveMistralKeyConfigs(): Promise<KeyConfig[]> {
    return resolveProviderKeyConfigs("mistral");
}
export async function resolveGeminiKeyConfigs(): Promise<KeyConfig[]> {
    return resolveProviderKeyConfigs("gemini");
}

export function getPort(): number {
    const v = getEnv("PORT", "3000");
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 3000;
}
