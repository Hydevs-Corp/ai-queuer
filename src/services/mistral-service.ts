import { Mistral } from '@mistralai/mistralai';
import { TextChunk } from '@mistralai/mistralai/models/components';
import { ChatQuery, ImageAnalysisQuery, LLMService } from '../types';

export class MistralService implements LLMService {
    private client: Mistral;

    constructor(apiKey: string) {
        this.client = new Mistral({
            apiKey: apiKey,
        });
    }

    async askQuestion(request: ChatQuery): Promise<string> {
        try {
            const response = await this.client.chat.complete({
                model: request.model,
                messages: request.history.map((msg) => ({
                    role: msg.role,
                    content: msg.content,
                })),
                temperature: request.options?.temperature,
                maxTokens: request.options?.maxTokens,
                randomSeed: request.options?.seed,
            });

            const content = response.choices[0]?.message?.content;
            if (typeof content === 'string') {
                return content;
            }
            return 'No response generated';
        } catch (error) {
            console.error('Error in askQuestion:', error);
            throw new Error(`Failed to get response from Mistral: ${error}`);
        }
    }

    async analyzeImage(request: ImageAnalysisQuery): Promise<string> {
        try {
            const model = request.model || 'magistral-small-2509';
            const prompt =
                request.prompt ??
                'Analyze this image and describe what you see.';

            const response = await this.client.chat.complete({
                model: model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: prompt,
                            },
                            {
                                type: 'image_url',
                                imageUrl: {
                                    url: `data:image/jpeg;base64,${request.image}`,
                                },
                            },
                        ],
                    },
                ],
                temperature: request.options?.temperature,
                maxTokens: request.options?.maxTokens,
                randomSeed: request.options?.seed,
            });

            const content = response.choices[0]?.message?.content;
            if (typeof content === 'string') {
                return content;
            }
            if (Array.isArray(content)) {
                return content
                    .filter((part) => part.type === 'text')
                    .map((part) => (part as TextChunk).text)
                    .join('');
            }
            return 'No analysis generated';
        } catch (error) {
            console.error('Error in analyzeImage:', error);
            throw new Error(`Failed to analyze image with Mistral: ${error}`);
        }
    }
}
