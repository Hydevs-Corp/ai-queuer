import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage, AIMessage } from 'langchain';
import { ChatQuery, ImageAnalysisQuery, LLMService } from '../types';

export type LangChainProvider = 'claude' | 'openai' | 'gemini';
export const LANGCHAIN_PROVIDERS: LangChainProvider[] = [
    'claude',
    'openai',
    'gemini',
];

export class LangchainService implements LLMService {
    readonly provider: LangChainProvider;
    private apiKey: string;
    private baseUrl?: string;

    constructor(provider: LangChainProvider, apiKey: string, baseUrl?: string) {
        this.provider = provider;
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }

    private mapHistory(history: { role: string; content: string }[]) {
        return history.map((m) => {
            if (m.role === 'system') return new SystemMessage(m.content);
            if (m.role === 'assistant') return new AIMessage(m.content);
            return new HumanMessage(m.content);
        });
    }

    private createModel(
        modelName?: string,
        options?: { temperature?: number; maxTokens?: number }
    ) {
        const t = options?.temperature;
        const max = options?.maxTokens;
        if (this.provider === 'claude') {
            return new ChatAnthropic({
                apiKey: this.apiKey,
                modelName: modelName || 'claude-2',
                temperature: t,
                maxTokens: max,
                configuration: this.baseUrl
                    ? {
                          baseURL: this.baseUrl,
                      }
                    : {},
            });
        }
        if (this.provider === 'openai') {
            return new ChatOpenAI({
                apiKey: this.apiKey,
                modelName: modelName || 'gpt-4',
                temperature: t,
                maxTokens: max,
                configuration: {
                    ...(this.baseUrl
                        ? {
                              baseURL: this.baseUrl,
                          }
                        : {}),
                },
            });
        }
        return new ChatGoogleGenerativeAI({
            apiKey: this.apiKey,
            model: modelName || 'gemini-1.5-turbo',
            temperature: t,
            maxOutputTokens: max,
        });
    }

    async askQuestion(request: ChatQuery): Promise<string> {
        try {
            const messages = this.mapHistory(request.history);
            const model = this.createModel(request.model, {
                temperature: request.options?.temperature,
                maxTokens: request.options?.maxTokens,
            });
            // LangChain chat models typically expose generate([...messages])
            const resp = await (model as any).generate([messages]);
            return resp?.generations?.[0]?.[0]?.text ?? 'No response generated';
        } catch (err) {
            console.error('LangchainService askQuestion error:', err);
            throw err instanceof Error ? err : new Error(String(err));
        }
    }

    async analyzeImage(request: ImageAnalysisQuery): Promise<string> {
        try {
            const prompt =
                request.prompt ??
                'Analyze this image and describe what you see.';
            const dataUrl = `data:image/jpeg;base64,${request.image}`;
            const messages = [new HumanMessage(`${prompt}\nImage: ${dataUrl}`)];
            const model = this.createModel(request.model, {
                temperature: request.options?.temperature,
                maxTokens: request.options?.maxTokens,
            });
            const resp = await (model as any).generate([messages]);
            return resp?.generations?.[0]?.[0]?.text ?? 'No analysis generated';
        } catch (err) {
            console.error('LangchainService analyzeImage error:', err);
            throw err instanceof Error ? err : new Error(String(err));
        }
    }
}
