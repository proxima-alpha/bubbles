import { Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRepository } from '../user/user.repository';
import { OllamaProvider, LlmMessage } from './providers/ollama.provider';

@Injectable()
export class ModelService {
  constructor(
    private userRepo: UserRepository,
    private config: ConfigService,
    private ollamaProvider: OllamaProvider,
  ) {}

  async getModelInfo(userId: string) {
    const user = await this.userRepo.findByIdWithModel(userId);
    if (!user?.model) throw new ForbiddenException('No model selected');
    const baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
    const modelCode = user.model_code ? { code: user.model_code.code, name: user.model_code.name } : null;
    const providerCode = user.model_code?.parent ? { code: user.model_code.parent.code, name: user.model_code.parent.name } : null;
    return { model: user.model, baseUrl, provider: providerCode?.code ?? 'unknown', modelCode, providerCode };
  }

  async chat(userId: string, messages: LlmMessage[], options?: { num_predict?: number }, format?: 'json' | Record<string, unknown>): Promise<string> {
    const { model, baseUrl } = await this.getModelInfo(userId);
    return this.ollamaProvider.chat(baseUrl, model, messages, options, format);
  }

  async *chatStream(
    userId: string,
    messages: LlmMessage[],
  ): AsyncGenerator<string, { inputTokens: number | null; outputTokens: number | null }, unknown> {
    const { model, baseUrl } = await this.getModelInfo(userId);
    return yield* this.ollamaProvider.chatStream(baseUrl, model, messages);
  }

  async embedText(text: string): Promise<number[]> {
    const baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.ollamaProvider.embed(baseUrl, text);
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw new Error('unreachable');
  }

  async embedTexts(texts: string[], prefix?: string): Promise<number[][]> {
    const baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
    const prefixed = prefix ? texts.map(t => `${prefix}${t}`) : texts;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.ollamaProvider.embedBatch(baseUrl, prefixed);
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw new Error('unreachable');
  }

  async embedTextChunked(text: string, prefix?: string): Promise<number[]> {
    const chunks = this.chunkText(text);
    const vectors = await this.embedTexts(chunks, prefix);
    return this.averageVectors(vectors);
  }

  async embedTextsChunked(texts: string[], prefix?: string): Promise<number[][]> {
    const chunkGroups = texts.map(t => this.chunkText(t));
    const allVectors = await this.embedTexts(chunkGroups.flat(), prefix);
    let offset = 0;
    return chunkGroups.map(chunks => {
      const vectors = allVectors.slice(offset, offset + chunks.length);
      offset += chunks.length;
      return this.averageVectors(vectors);
    });
  }

  private averageVectors(vectors: number[][]): number[] {
    if (vectors.length === 1) return vectors[0];
    const dim = vectors[0].length;
    const sum = new Array<number>(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
    return sum.map(x => x / vectors.length);
  }

  private chunkText(text: string, maxLen = 200): string[] {
    const sentences = text.split(/(?<=[.!?。\n])\s+/);
    const chunks: string[] = [];
    let current = '';
    for (const s of sentences) {
      if (current.length + s.length > maxLen && current.length > 0) {
        chunks.push(current.trim());
        current = s;
      } else {
        current += (current ? ' ' : '') + s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
  }
}
