export type ProviderName = 'mistral' | 'gemini' | (string & {});

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface ModelTarget {
    provider: ProviderName;
    model: string;
}

export interface RequestOptions {
    temperature?: number;
    maxTokens?: number;
    seed?: number;
}

export interface AskRequestBody {
    history: ChatMessage[];
    model: string | ModelTarget | ModelTarget[];
    options?: RequestOptions;
}

export interface AnalyzeImageRequestBody {
    image: string;
    model?: string | ModelTarget | ModelTarget[];
    prompt?: string;
}

export interface ChatQuery {
    history: ChatMessage[];
    model: string;
    options?: RequestOptions;
}

export interface ImageAnalysisQuery {
    image: string;
    model?: string;
    options?: RequestOptions;
}

export interface LLMService {
    askQuestion(request: ChatQuery): Promise<string>;
    analyzeImage(request: ImageAnalysisQuery): Promise<string>;
}
