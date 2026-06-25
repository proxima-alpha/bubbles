import { Injectable, InternalServerErrorException } from '@nestjs/common';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  model: string;
  provider: string;
}

@Injectable()
export class OllamaProvider {
  async embed(baseUrl: string, text: string): Promise<number[]> {
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
    const data = await res.json();
    return data.embedding as number[];
  }

  async embedBatch(baseUrl: string, texts: string[]): Promise<number[][]> {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
    const data = await res.json();
    return data.embeddings as number[][];
  }

  async chat(
    baseUrl: string,
    model: string,
    messages: LlmMessage[],
    options?: { num_predict?: number },
    format?: 'json' | Record<string, unknown>,
  ): Promise<string> {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, think: false, enable_thinking: false, ...(format && { format }), ...(options && { options }) }),
    });
    if (!res.ok) throw new InternalServerErrorException(`Ollama error: ${res.status}`);
    const data = await res.json();
    return data.message?.content ?? '';
  }

  async *chatStream(
    baseUrl: string,
    model: string,
    messages: LlmMessage[],
  ): AsyncGenerator<string, { inputTokens: number | null; outputTokens: number | null }, unknown> {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, think: false, enable_thinking: false }),
    });

    if (!res.ok || !res.body) throw new InternalServerErrorException(`Ollama error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line);
        if (data.message?.content) yield data.message.content;
        if (data.done) {
          return {
            inputTokens: data.prompt_eval_count ?? null,
            outputTokens: data.eval_count ?? null,
          };
        }
      }

      if (done) break;
    }

    if (buffer.trim()) {
      const data = JSON.parse(buffer.trim());
      if (data.message?.content) yield data.message.content;
    }

    return { inputTokens: null, outputTokens: null };
  }
}
