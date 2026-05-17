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
  async *chatStream(baseUrl: string, model: string, messages: LlmMessage[]): AsyncGenerator<string> {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });

    if (!res.ok || !res.body) throw new InternalServerErrorException(`Ollama error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n').filter(Boolean);
      for (const line of lines) {
        const data = JSON.parse(line);
        if (data.message?.content) yield data.message.content;
        if (data.done) return;
      }
    }
  }
}
