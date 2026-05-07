import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  model: string;
  provider: string;
}

@Injectable()
export class ClaudeProvider {
  async chat(apiKey: string, model: string, messages: LlmMessage[]): Promise<LlmResponse> {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      messages,
    });

    const block = response.content[0];
    const content = block.type === 'text' ? block.text : '';

    return { content, model: response.model, provider: 'claude' };
  }
}
