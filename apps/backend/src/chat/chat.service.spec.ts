import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModelService } from '../model/model.service';

const mockPrisma = {
  user: { findUnique: jest.fn() },
  message: { create: jest.fn(), findMany: jest.fn() },
};

const mockModelService = {
  getModelInfo: jest.fn(),
  chatStream: jest.fn(),
};

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ModelService, useValue: mockModelService },
      ],
    }).compile();
    service = module.get(ChatService);
    jest.clearAllMocks();
  });

  describe('getHistory', () => {
    it('유저의 메시지 목록이 created_at 내림차순으로 반환되어야 한다', async () => {
      const rows = [
        { id: '1', role: 'user', provider_code: null, model_code: null, content: 'hi', created_at: new Date('2024-01-01') },
        { id: '2', role: 'assistant', provider_code: { code: 'exaone', name: 'EXAONE' }, model_code: { code: 'exaone3.5:2.4b', name: 'EXAONE 3.5 2.4B' }, content: 'hello', created_at: new Date('2024-01-02') },
      ];
      mockPrisma.message.findMany.mockResolvedValue(rows);

      const result = await service.getHistory('u1');

      expect(mockPrisma.message.findMany).toHaveBeenCalledWith({
        where: { user_id: 'u1' },
        orderBy: { created_at: 'desc' },
        include: { provider_code: true, model_code: true },
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: '1', role: 'user', content: 'hi' });
    });
  });

  describe('sendMessageStream', () => {
    it('user.model이 null이면 ForbiddenException이 발생해야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ model: null });
      const mockRes = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

      await expect(service.sendMessageStream('u1', { content: 'hi' }, mockRes as any))
        .rejects.toThrow(ForbiddenException);
    });

    it('스트림이 완료되면 assistant 메시지가 저장되어야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ model: 'exaone3.5:2.4b' });
      mockPrisma.message.create.mockResolvedValue({});
      mockPrisma.message.findMany.mockResolvedValue([]);
      mockModelService.getModelInfo.mockResolvedValue({ model: 'exaone3.5:2.4b', provider: 'exaone' });
      async function* fakeStream() { yield 'hello'; yield ' world'; }
      mockModelService.chatStream.mockReturnValue(fakeStream());
      const mockRes = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

      await service.sendMessageStream('u1', { content: 'hi' }, mockRes as any);

      expect(mockPrisma.message.create).toHaveBeenCalledTimes(2); // user + assistant
      const assistantCall = mockPrisma.message.create.mock.calls[1][0].data;
      expect(assistantCall.role).toBe('assistant');
      expect(assistantCall.content).toBe('hello world');
    });
  });
});
