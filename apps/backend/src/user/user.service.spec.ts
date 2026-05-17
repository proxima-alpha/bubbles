import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { UserService } from './user.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  common_code: {
    findUnique: jest.fn(),
  },
};

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(UserService);
    jest.clearAllMocks();
  });

  describe('getUser', () => {
    it('유저 ID로 조회하면 email과 model이 반환되어야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ email: 'a@a.com', model: 'exaone3.5:2.4b' });

      const result = await service.getUser('u1');

      expect(result).toEqual({ email: 'a@a.com', model: 'exaone3.5:2.4b' });
    });

    it('존재하지 않는 ID면 NotFoundException이 발생해야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getUser('none')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateModel', () => {
    it('유효한 모델 코드로 변경하면 성공해야 한다', async () => {
      mockPrisma.common_code.findUnique.mockResolvedValue({ category_code: 'model', code: 'exaone3.5:2.4b' });
      mockPrisma.user.update.mockResolvedValue({});

      const result = await service.updateModel('u1', { model: 'exaone3.5:2.4b' });

      expect(result).toEqual({});
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { model: 'exaone3.5:2.4b' },
      });
    });

    it('유효하지 않은 모델 코드면 NotFoundException이 발생해야 한다', async () => {
      mockPrisma.common_code.findUnique.mockResolvedValue(null);

      await expect(service.updateModel('u1', { model: 'invalid-model' }))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('updateUser', () => {
    it('중복 이메일이면 ConflictException이 발생해야 한다', async () => {
      mockPrisma.user.update.mockRejectedValue(
        new PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.updateUser('u1', { email: 'dup@a.com' }))
        .rejects.toThrow(ConflictException);
    });
  });
});
