import { Injectable, InternalServerErrorException } from '@nestjs/common';

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
export class OllamaProvider {
  async chat(baseUrl: string, model: string, messages: LlmMessage[]): Promise<LlmResponse> {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
    });

    if (!res.ok) throw new InternalServerErrorException(`Ollama error: ${res.status}`);

    const data = await res.json();
    return { content: data.message.content, model: data.model, provider: 'ollama' };
  }
}
