import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { ChatQuery, ImageAnalysisQuery, LLMService } from '../types';

export class ClaudeService implements LLMService {
    private client: Anthropic;

    constructor(apiKey: string) {
        this.client = new Anthropic({ apiKey });
    }

    async askQuestion(request: ChatQuery): Promise<string> {
        try {
            const systemPrompt = request.history
                .filter((msg) => msg.role === 'system')
                .map((msg) => msg.content)
                .join('\n');
            const messages: MessageParam[] = request.history
                .filter((msg) => msg.role !== 'system')
                .map((msg) => ({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: [{ type: 'text', text: msg.content }],
                }));
            const response = await this.client.messages.create({
                model: request.model,
                system: systemPrompt || undefined,
                messages,
                max_tokens: request.options?.maxTokens ?? 1024,
                temperature: request.options?.temperature,
            });
            return (
                response.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('') || 'No response generated'
            );
        } catch (error) {
            console.error('Error in Claude askQuestion:', error);
            throw new Error(`Failed to get response from Claude: ${error}`);
        }
    }

    async analyzeImage(request: ImageAnalysisQuery): Promise<string> {
        try {
            const prompt =
                request.prompt ??
                'Analyze this image and describe what you see.';
            const model = request.model ?? 'claude-3-haiku-20240307';
            const response = await this.client.messages.create({
                model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: 'image/jpeg',
                                    data: request.image,
                                },
                            },
                            { type: 'text', text: prompt },
                        ],
                    },
                ],
                max_tokens: request.options?.maxTokens ?? 1024,
                temperature: request.options?.temperature,
            });
            return (
                response.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('') || 'No analysis generated'
            );
        } catch (error) {
            console.error('Error in Claude analyzeImage:', error);
            throw new Error(`Failed to analyze image with Claude: ${error}`);
        }
    }
}
