import { GoogleGenerativeAI } from '@google/generative-ai';
import { ChatQuery, ImageAnalysisQuery, LLMService } from '../types';

export class GeminiService implements LLMService {
    private client: GoogleGenerativeAI;

    constructor(apiKey: string) {
        this.client = new GoogleGenerativeAI(apiKey);
    }

    async askQuestion(request: ChatQuery): Promise<string> {
        const model = this.client.getGenerativeModel({ model: request.model });
        const contents = request.history.map((m) => ({
            role: m.role === 'system' ? 'user' : (m.role as any),
            parts: [{ text: m.content }],
        }));
        const res = await model.generateContent({
            contents,
            generationConfig: {
                temperature: request.options?.temperature,
                maxOutputTokens: request.options?.maxTokens,
            },
        });
        return res.response.text() ?? 'No response generated';
    }

    async analyzeImage(request: ImageAnalysisQuery): Promise<string> {
        const modelName = request.model ?? 'gemini-1.5-flash';
        const model = this.client.getGenerativeModel({ model: modelName });
        const prompt =
            request.prompt ?? 'Analyze this image and describe what you see.';
        const res = await model.generateContent({
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            text: prompt,
                        },
                        {
                            inlineData: {
                                mimeType: 'image/jpeg',
                                data: request.image,
                            },
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: request.options?.temperature,
                maxOutputTokens: request.options?.maxTokens,
            },
        });
        return res.response.text() ?? 'No analysis generated';
    }
}
