import OpenAI from 'openai';
import { ChatQuery, ImageAnalysisQuery, LLMService } from '../types';

export class OpenAIService implements LLMService {
    private client: OpenAI;

    constructor(apiKey: string) {
        this.client = new OpenAI({ apiKey });
    }

    async askQuestion(request: ChatQuery): Promise<string> {
        try {
            const response = await this.client.chat.completions.create({
                model: request.model,
                messages: request.history.map((msg) => ({
                    role: msg.role,
                    content: msg.content,
                })),
                temperature: request.options?.temperature,
                max_tokens: request.options?.maxTokens,
                seed: request.options?.seed,
            });
            return (
                response.choices[0]?.message?.content ?? 'No response generated'
            );
        } catch (error) {
            console.error('Error in OpenAI askQuestion:', error);
            throw new Error(`Failed to get response from OpenAI: ${error}`);
        }
    }

    async analyzeImage(request: ImageAnalysisQuery): Promise<string> {
        try {
            const prompt =
                request.prompt ??
                'Analyze this image and describe what you see.';
            const model = request.model ?? 'gpt-4o-mini';
            const response = await this.client.chat.completions.create({
                model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${request.image}`,
                                },
                            },
                        ],
                    },
                ],
                temperature: request.options?.temperature,
                max_tokens: request.options?.maxTokens,
                seed: request.options?.seed,
            });
            return (
                response.choices[0]?.message?.content ?? 'No analysis generated'
            );
        } catch (error) {
            console.error('Error in OpenAI analyzeImage:', error);
            throw new Error(`Failed to analyze image with OpenAI: ${error}`);
        }
    }
}
