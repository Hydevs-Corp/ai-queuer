export type ProviderName = "mistral" | "gemini" | (string & {});

export interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

export interface ModelTarget {
    provider: ProviderName;
    model: string;
}

export interface AskRequestBody {
    history: ChatMessage[];
    model: string | ModelTarget | ModelTarget[];
}

export interface AnalyzeImageRequestBody {
    image: string;
    model?: string | ModelTarget | ModelTarget[];
    prompt?: string;
}

export interface LLMService {
    askQuestion(request: {
        history: ChatMessage[];
        model: string;
    }): Promise<string>;
    analyzeImage(request: { image: string; model?: string }): Promise<string>;
}
