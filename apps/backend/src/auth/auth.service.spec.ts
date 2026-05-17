import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  common_code: {
    findUnique: jest.fn(),
  },
};

const mockJwt = { sign: jest.fn().mockReturnValue('token') };

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();
    service = module.get(AuthService);
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('새 이메일로 가입하면 accessToken이 반환되어야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.common_code.findUnique.mockResolvedValue({ category_code: 'model', code: 'exaone3.5:2.4b' });
      mockPrisma.user.create.mockResolvedValue({ id: 'u1', email: 'a@a.com' });

      const result = await service.register({ email: 'a@a.com', password: 'pass1234', model: 'exaone3.5:2.4b' });

      expect(result).toEqual({ accessToken: 'token' });
    });

    it('이미 사용 중인 이메일이면 ConflictException이 발생해야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1' });

      await expect(service.register({ email: 'a@a.com', password: 'pass1234', model: 'exaone3.5:2.4b' }))
        .rejects.toThrow(ConflictException);
    });

    it('유효하지 않은 모델이면 NotFoundException이 발생해야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.common_code.findUnique.mockResolvedValue(null);

      await expect(service.register({ email: 'a@a.com', password: 'pass1234', model: 'invalid-model' }))
        .rejects.toThrow(NotFoundException);
    });

    it('비밀번호는 salt와 함께 해시되어 저장되어야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.common_code.findUnique.mockResolvedValue({ category_code: 'model', code: 'exaone3.5:2.4b' });
      mockPrisma.user.create.mockResolvedValue({ id: 'u1', email: 'a@a.com' });

      await service.register({ email: 'a@a.com', password: 'pass1234', model: 'exaone3.5:2.4b' });

      const createCall = mockPrisma.user.create.mock.calls[0][0].data;
      expect(createCall.password).not.toBe('pass1234');
      expect(createCall.salt).toBeDefined();
    });
  });

  describe('login', () => {
    it('올바른 이메일/비밀번호면 accessToken이 반환되어야 한다', async () => {
      const salt = 'abc';
      const hashed = crypto.createHash('sha256').update('pass1234' + salt).digest('hex');
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@a.com', password: hashed, salt });

      const result = await service.login({ email: 'a@a.com', password: 'pass1234' });

      expect(result).toEqual({ accessToken: 'token' });
    });

    it('존재하지 않는 이메일이면 UnauthorizedException이 발생해야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.login({ email: 'none@a.com', password: 'pass1234' }))
        .rejects.toThrow(UnauthorizedException);
    });

    it('비밀번호가 틀리면 UnauthorizedException이 발생해야 한다', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', password: 'wrong', salt: 'abc' });

      await expect(service.login({ email: 'a@a.com', password: 'pass1234' }))
        .rejects.toThrow(UnauthorizedException);
    });
  });
});
