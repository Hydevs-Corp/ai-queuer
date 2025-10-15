import { GoogleGenerativeAI } from "@google/generative-ai";
import { ChatMessage, LLMService } from "./types";

export class GeminiService implements LLMService {
    private client: GoogleGenerativeAI;

    constructor(apiKey: string) {
        this.client = new GoogleGenerativeAI(apiKey);
    }

    async askQuestion(request: {
        history: ChatMessage[];
        model: string;
    }): Promise<string> {
        const model = this.client.getGenerativeModel({ model: request.model });
        const contents = request.history.map((m) => ({
            role: m.role === "system" ? "user" : (m.role as any),
            parts: [{ text: m.content }],
        }));
        const res = await model.generateContent({ contents });
        return res.response.text() ?? "No response generated";
    }

    async analyzeImage(request: {
        image: string;
        model?: string;
    }): Promise<string> {
        const modelName = request.model ?? "gemini-1.5-flash";
        const model = this.client.getGenerativeModel({ model: modelName });
        const res = await model.generateContent({
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            text: "Analyze this image and describe what you see.",
                        },
                        {
                            inlineData: {
                                mimeType: "image/jpeg",
                                data: request.image,
                            },
                        },
                    ],
                },
            ],
        });
        return res.response.text() ?? "No analysis generated";
    }
}
