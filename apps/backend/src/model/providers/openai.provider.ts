import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

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
export class OpenAiProvider {
  async chat(apiKey: string, model: string, messages: LlmMessage[]): Promise<LlmResponse> {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({ model, messages });

    const content = response.choices[0]?.message?.content ?? '';

    return { content, model: response.model, provider: 'gpt' };
  }
}
