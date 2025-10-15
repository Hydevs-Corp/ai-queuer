import { serve } from "@hono/node-server";
import * as dotenv from "dotenv";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { estimateTokenCount } from "tokenx";
import {
    getEnvStrategy,
    getPort,
    KeyConfig,
    resolveGeminiKeyConfigs,
    resolveMistralApiKey,
    resolveMistralKeyConfigs,
} from "./env";
import { GeminiService } from "./gemini-service";
import { MistralService } from "./mistral-service";
import { RequestQueuer } from "./queuer";
import {
    AnalyzeImageRequestBody,
    AskRequestBody,
    LLMService,
    ModelTarget,
    ProviderName,
} from "./types";

dotenv.config({ quiet: true });

const app = new Hono();

app.use("*", cors());
app.use("*", logger());

const queuesByProvider: Record<string, RequestQueuer[]> = {};
const clientsByProvider: Record<string, LLMService[]> = {};
const QUEUE_DELAY_MS = 1000;
const USAGE_STRATEGY = (process.env.USAGE_STRATEGY || "RAM") as
    | "RAM"
    | "pocketbase";

function getLeastLoadedIndex(queues: RequestQueuer[]): number {
    if (!queues || queues.length === 0) return -1;
    let min = Number.MAX_SAFE_INTEGER;
    let idx = 0;
    for (let i = 0; i < queues.length; i++) {
        const len = queues[i].getQueueLength();
        if (len < min) {
            min = len;
            idx = i;
        }
    }
    return idx;
}

function parseTargets<T extends { model?: any }>(
    body: T,
    fallbackProvider: ProviderName = "mistral"
): ModelTarget[] {
    const raw = (body as any).model;
    if (!raw)
        return [{ provider: fallbackProvider, model: "mistral-small-latest" }];
    if (typeof raw === "string")
        return [{ provider: fallbackProvider, model: raw }];
    if (Array.isArray(raw)) return raw as ModelTarget[];
    return [raw as ModelTarget];
}

function chooseQueue(
    provider: ProviderName,
    model: string,
    tokenText?: string
): {
    client: LLMService;
    queue: RequestQueuer;
    estimatedWaitMs: number;
} | null {
    const providerQueues = queuesByProvider[provider];
    const providerClients = clientsByProvider[provider];
    if (
        !providerQueues ||
        !providerQueues.length ||
        !providerClients ||
        !providerClients.length
    )
        return null;

    let tokensNeeded = 0;
    try {
        if (tokenText) {
            const { estimateTokenCount } = require("tokenx");
            tokensNeeded = estimateTokenCount(tokenText);
        }
    } catch {}

    let bestIdx = -1;
    let bestWait = Number.POSITIVE_INFINITY;
    for (let i = 0; i < providerQueues.length; i++) {
        const q = providerQueues[i];
        const wait = q.estimateWaitMs(model, tokensNeeded);
        console.log(
            `Provider ${provider} model ${model} queue ${i} estimated wait: ${wait}ms`
        );
        if (wait < bestWait) {
            bestWait = wait;
            bestIdx = i;
        }
    }
    if (bestIdx < 0) bestIdx = getLeastLoadedIndex(providerQueues);
    if (bestIdx < 0) return null;
    return {
        client: providerClients[bestIdx],
        queue: providerQueues[bestIdx],
        estimatedWaitMs: bestWait,
    };
}

app.get("/", (c) => {
    return c.json({
        message: "AI Queuer API is running",
        providers: Object.entries(queuesByProvider).reduce(
            (acc, [prov, qs]) => ({
                ...acc,
                [prov]: qs.length,
            }),
            {}
        ),
        docs: {
            ask: {
                method: "POST",
                url: "/ask",
                description:
                    "Ask a question to the AI model. Provide 'history' in the request body.",
            },
            analyzeImage: {
                method: "POST",
                url: "/analyze-image",
                description:
                    "Analyze a base64-encoded image. Provide 'image' in the request body.",
            },
            queueStatus: {
                method: "GET",
                url: "/queue/status",
                description: "Get the status of all provider queues.",
            },
            usage: {
                method: "GET",
                url: "/usage",
                description: "Get usage statistics for all queues and models.",
            },
            models: {
                method: "GET",
                url: "/models",
                description: "List available models for each provider.",
            },
            estimateTokens: {
                method: "GET",
                url: "/estimate-tokens?text=Your+text+here",
                description:
                    "Estimate the number of tokens for a given text and model.",
            },
            reloadKeys: {
                method: "POST",
                url: "/admin/reload-keys",
                description: "Reload API keys for providers.",
            },
        },
        environment: {
            strategy: getEnvStrategy(),
            usageStrategy: USAGE_STRATEGY,
        },
    });
});

app.get("/health", (c) => c.text("OK"));

app.post("/ask", async (c) => {
    try {
        const body = (await c.req.json()) as AskRequestBody;

        if (!body.history || !Array.isArray(body.history)) {
            return c.json(
                { error: "history is required and must be an array" },
                400
            );
        }
        const targets = parseTargets(body);
        for (const message of body.history) {
            if (
                !message.role ||
                !["user", "assistant", "system"].includes(message.role)
            ) {
                return c.json(
                    {
                        error: "Invalid message role. Must be user, assistant, or system",
                    },
                    400
                );
            }
            if (!message.content || typeof message.content !== "string") {
                return c.json(
                    { error: "Each message must have content as a string" },
                    400
                );
            }
        }
        const tokenText = body.history.map((m) => m.content).join("\n");
        let best: {
            provider: ProviderName;
            model: string;
            client: LLMService;
            queue: RequestQueuer;
            estimatedWaitMs: number;
        } | null = null;
        for (const t of targets) {
            const sel = chooseQueue(t.provider, t.model, tokenText);
            if (!sel) continue;
            if (!best || sel.estimatedWaitMs < best.estimatedWaitMs) {
                best = {
                    provider: t.provider,
                    model: t.model,
                    client: sel.client,
                    queue: sel.queue,
                    estimatedWaitMs: sel.estimatedWaitMs,
                };
            }
        }
        if (!best)
            throw new Error(
                "No available provider queues. Service not initialized"
            );
        const req = { history: body.history, model: best.model };
        const result = await best.queue.add(
            async () => await best!.client.askQuestion(req),
            tokenText,
            best.model
        );

        return c.json({
            response: result,
            provider: best.provider,
            model: best.model,
            providers: Object.fromEntries(
                Object.entries(queuesByProvider).map(([prov, qs]) => [
                    prov,
                    {
                        totalQueueLength: qs.reduce(
                            (acc, q) => acc + q.getQueueLength(),
                            0
                        ),
                    },
                ])
            ),
        });
    } catch (error) {
        console.error("Error in /ask endpoint:", error);
        return c.json(
            {
                error: "Internal server error",
                details:
                    error instanceof Error ? error.message : "Unknown error",
            },
            500
        );
    }
});

app.post("/analyze-image", async (c) => {
    try {
        const body = (await c.req.json()) as AnalyzeImageRequestBody;

        if (!body.image || typeof body.image !== "string") {
            return c.json(
                { error: "image is required and must be a base64 string" },
                400
            );
        }

        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        if (!base64Regex.test(body.image)) {
            return c.json({ error: "Invalid base64 image format" }, 400);
        }

        const originalModelRaw = (body as any).model;
        const targets = originalModelRaw
            ? parseTargets(body)
            : [
                  {
                      provider: "mistral" as ProviderName,
                      model: "magistral-small-2509",
                  },
              ];
        const prompt =
            body.prompt &&
            typeof body.prompt === "string" &&
            body.prompt.trim().length
                ? body.prompt
                : "Analyze this image and describe what you see.";
        let best: {
            provider: ProviderName;
            model: string;
            client: LLMService;
            queue: RequestQueuer;
            estimatedWaitMs: number;
        } | null = null;
        for (const t of targets) {
            const sel = chooseQueue(t.provider, t.model, prompt);
            if (!sel) continue;
            if (!best || sel.estimatedWaitMs < best.estimatedWaitMs) {
                best = {
                    provider: t.provider,
                    model: t.model,
                    client: sel.client,
                    queue: sel.queue,
                    estimatedWaitMs: sel.estimatedWaitMs,
                };
            }
        }
        if (!best)
            throw new Error(
                "No available provider queues. Service not initialized"
            );
        const req = {
            image: body.image,
            model: originalModelRaw ? best.model : undefined,
        };
        const result = await best.queue.add(
            async () => await best!.client.analyzeImage(req),
            prompt,
            best.model
        );

        return c.json({
            analysis: result,
            provider: best.provider,
            model: best.model,
            providers: Object.fromEntries(
                Object.entries(queuesByProvider).map(([prov, qs]) => [
                    prov,
                    {
                        totalQueueLength: qs.reduce(
                            (acc, q) => acc + q.getQueueLength(),
                            0
                        ),
                    },
                ])
            ),
        });
    } catch (error) {
        console.error("Error in /analyze-image endpoint:", error);
        return c.json(
            {
                error: "Internal server error",
                details:
                    error instanceof Error ? error.message : "Unknown error",
            },
            500
        );
    }
});

app.get("/queue/status", (c) => {
    const providers = Object.fromEntries(
        Object.entries(queuesByProvider).map(([prov, qs]) => [
            prov,
            {
                queues: qs.map((q, i) => ({
                    index: i,
                    queueLength: q.getQueueLength(),
                    isProcessing: q.isCurrentlyProcessing(),
                    label: q.getLabel(),
                })),
                totalQueueLength: qs.reduce(
                    (acc, q) => acc + q.getQueueLength(),
                    0
                ),
            },
        ])
    );
    return c.json({ providers });
});

app.get("/usage", (c) => {
    const now = Date.now();
    const perQueue = Object.fromEntries(
        Object.entries(queuesByProvider).map(([prov, qs]) => [
            prov,
            qs.map((q, i) => ({
                index: i,
                label: q.getLabel(),
                usage: q.getUsageSnapshot(),
            })),
        ])
    );

    const totals: Record<string, any> = {};
    for (const qs of Object.values(queuesByProvider)) {
        for (const q of qs) {
            const snap = q.getUsageSnapshot();
            for (const [model, m] of Object.entries(snap)) {
                const t = (totals[model] ||= {
                    second: { requests: 0 },
                    minute: { requests: 0, tokens: { count: 0 } },
                    day: { requests: 0 },
                    month: { requests: { count: 0 }, tokens: { count: 0 } },
                });
                t.second.requests += (m as any).second.requests || 0;
                t.minute.requests += (m as any).minute.requests || 0;
                t.minute.tokens.count += (m as any).minute.tokens.count || 0;
                t.day.requests += (m as any).day.requests || 0;
                t.month.requests.count += (m as any).month.requests.count || 0;
                t.month.tokens.count += (m as any).month.tokens.count || 0;
            }
        }
    }

    return c.json({
        now,
        queues: perQueue,
        totals,
    });
});

app.get("/models", async (c) => {
    try {
        const collectModels = async (
            resolver: () => Promise<KeyConfig[]>
        ): Promise<string[]> => {
            try {
                const cfgs = await resolver();
                const models = new Set<string>();
                for (const kc of cfgs) {
                    const ml = kc.modelLimits || {};
                    for (const m of Object.keys(ml)) {
                        if (m && m !== "__default__") models.add(m);
                    }
                }
                return Array.from(models).sort();
            } catch {
                return [];
            }
        };

        const [mistralModels, geminiModels] = await Promise.all([
            collectModels(resolveMistralKeyConfigs),
            collectModels(resolveGeminiKeyConfigs),
        ]);

        return c.json({
            mistral: mistralModels,
            gemini: geminiModels,
        });
    } catch (error) {
        console.error("Error in /usage/models endpoint:", error);
        return c.json(
            {
                error: "Internal server error",
                details:
                    error instanceof Error ? error.message : "Unknown error",
            },
            500
        );
    }
});

app.get("/estimate-tokens", async (c) => {
    try {
        const text = c.req.query("text") || "";
        if (typeof text !== "string" || !text.trim().length) {
            return c.json({ error: "text query parameter is required" }, 400);
        }
        let model = c.req.query("model") || "mistral-small-latest";
        if (Array.isArray(model)) model = model[0];
        if (typeof model !== "string" || !model.trim().length) {
            model = "mistral-small-latest";
        }

        let estimate = 0;
        try {
            estimate = estimateTokenCount(text);
        } catch {
            return c.json(
                {
                    error: "Token estimation not available. Ensure 'tokenx' package is installed.",
                },
                500
            );
        }

        return c.json({
            model,
            textLength: text.length,
            estimatedTokens: estimate,
        });
    } catch (error) {
        console.error("Error in /estimate-tokens endpoint:", error);
        return c.json(
            {
                error: "Internal server error",
                details:
                    error instanceof Error ? error.message : "Unknown error",
            },
            500
        );
    }
});

app.post("/admin/reload-keys", async (c) => {
    try {
        const strategy = getEnvStrategy();
        if (strategy === "env") {
            return c.json(
                { error: "Reload not supported for ENV_STRATEGY=env" },
                400
            );
        }

        let provider: string | undefined;
        try {
            provider = (
                c.req.query("provider") ||
                (await c.req.json().catch(() => ({})))?.provider
            )?.toString();
        } catch {
            provider = c.req.query("provider")?.toString();
        }
        const providersToReload = (
            (provider || "mistral").toLowerCase() === "all"
                ? ["mistral", "gemini"]
                : [(provider || "mistral").toLowerCase()]
        ) as Array<"mistral" | "gemini">;

        const rebuild = async (prov: "mistral" | "gemini") => {
            let keyConfigs: KeyConfig[] = [];
            if (prov === "mistral")
                keyConfigs = await resolveMistralKeyConfigs();
            if (prov === "gemini") keyConfigs = await resolveGeminiKeyConfigs();
            clientsByProvider[prov] = [];
            queuesByProvider[prov] = [];
            for (const kc of keyConfigs) {
                if (prov === "mistral")
                    clientsByProvider[prov].push(new MistralService(kc.key));
                if (prov === "gemini")
                    clientsByProvider[prov].push(new GeminiService(kc.key));
                if (
                    (kc.defaultLimits && kc.defaultLimits.length) ||
                    (kc.modelLimits && Object.keys(kc.modelLimits).length)
                ) {
                    queuesByProvider[prov].push(
                        new RequestQueuer({
                            defaultLimits: kc.defaultLimits,
                            modelLimits: kc.modelLimits,
                            label: kc.label || "default",
                            usageStrategy: USAGE_STRATEGY,
                        })
                    );
                } else if (kc.delayMs != null) {
                    queuesByProvider[prov].push(
                        new RequestQueuer({
                            fallbackDelayMs: kc.delayMs,
                            label: kc.label || "default",
                            usageStrategy: USAGE_STRATEGY,
                        })
                    );
                } else {
                    queuesByProvider[prov].push(
                        new RequestQueuer({
                            label: kc.label || "default",
                            usageStrategy: USAGE_STRATEGY,
                        })
                    );
                }
            }
        };

        for (const p of providersToReload) {
            await rebuild(p);
        }

        return c.json({
            strategy,
            providers: Object.fromEntries(
                Object.entries(queuesByProvider).map(([prov, qs]) => [
                    prov,
                    {
                        totalQueueLength: qs.reduce(
                            (acc, q) => acc + q.getQueueLength(),
                            0
                        ),
                    },
                ])
            ),
        });
    } catch (error) {
        console.error("Error reloading API keys:", error);
        return c.json(
            {
                error: "Failed to reload API keys",
                details:
                    error instanceof Error ? error.message : "Unknown error",
            },
            500
        );
    }
});

async function bootstrap() {
    try {
        const mistralKeyConfigs: KeyConfig[] =
            await resolveMistralKeyConfigs().catch(async () => {
                const k = await resolveMistralApiKey();
                return [{ key: k, delayMs: QUEUE_DELAY_MS } as KeyConfig];
            });
        console.log(
            `Using ${
                mistralKeyConfigs.length
            } Mistral API key(s) with strategy: ${getEnvStrategy()}`
        );
        clientsByProvider["mistral"] = [];
        queuesByProvider["mistral"] = [];
        for (const kc of mistralKeyConfigs) {
            clientsByProvider["mistral"].push(new MistralService(kc.key));
            if (
                (kc.defaultLimits && kc.defaultLimits.length) ||
                (kc.modelLimits && Object.keys(kc.modelLimits).length)
            ) {
                queuesByProvider["mistral"].push(
                    new RequestQueuer({
                        defaultLimits: kc.defaultLimits,
                        modelLimits: kc.modelLimits,
                        label: kc.label || "default",
                        usageStrategy: USAGE_STRATEGY,
                    })
                );
            } else if (kc.delayMs != null) {
                queuesByProvider["mistral"].push(
                    new RequestQueuer({
                        fallbackDelayMs: kc.delayMs,
                        label: kc.label || "default",
                        usageStrategy: USAGE_STRATEGY,
                    })
                );
            } else {
                queuesByProvider["mistral"].push(
                    new RequestQueuer({
                        label: kc.label || "default",
                        usageStrategy: USAGE_STRATEGY,
                    })
                );
            }
        }

        try {
            const geminiKeyConfigs: KeyConfig[] =
                await resolveGeminiKeyConfigs();
            if (geminiKeyConfigs.length) {
                clientsByProvider["gemini"] = [];
                queuesByProvider["gemini"] = [];
                for (const kc of geminiKeyConfigs) {
                    clientsByProvider["gemini"].push(new GeminiService(kc.key));
                    if (
                        (kc.defaultLimits && kc.defaultLimits.length) ||
                        (kc.modelLimits && Object.keys(kc.modelLimits).length)
                    ) {
                        queuesByProvider["gemini"].push(
                            new RequestQueuer({
                                defaultLimits: kc.defaultLimits,
                                modelLimits: kc.modelLimits,
                                label: kc.label || "default",
                                usageStrategy: USAGE_STRATEGY,
                            })
                        );
                    } else if (kc.delayMs != null) {
                        queuesByProvider["gemini"].push(
                            new RequestQueuer({
                                fallbackDelayMs: kc.delayMs,
                                label: kc.label || "default",
                                usageStrategy: USAGE_STRATEGY,
                            })
                        );
                    } else {
                        queuesByProvider["gemini"].push(
                            new RequestQueuer({
                                label: kc.label || "default",
                                usageStrategy: USAGE_STRATEGY,
                            })
                        );
                    }
                }
                console.log(
                    `Gemini provider enabled with ${geminiKeyConfigs.length} API key(s)`
                );
            } else {
                console.log("Gemini provider not configured");
            }
        } catch (e) {
            console.log(
                "Gemini provider not configured or failed to resolve keys:",
                e instanceof Error ? e.message : e
            );
        }

        const port = getPort();
        console.log(`Starting server on port ${port}`);
        serve({ port, fetch: app.fetch });
    } catch (e) {
        console.error("Failed to start server:", e);
        process.exit(1);
    }
}

bootstrap();
