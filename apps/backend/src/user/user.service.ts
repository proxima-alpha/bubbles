import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateModelDto } from './dto/update-model.dto';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException();

    const modelCode = user.model
      ? await this.prisma.common_code.findUnique({
          where: { category_code_code: { category_code: 'model', code: user.model } },
        })
      : null;

    return {
      email: user.email,
      model: modelCode ? { code: modelCode.code, name: modelCode.name } : null,
    };
  }

  async updateUser(userId: string, dto: UpdateUserDto) {
    const data: Record<string, unknown> = {};
    if (dto.email) data.email = dto.email;
    if (dto.password) {
      const salt = crypto.randomBytes(32).toString('hex');
      data.salt = salt;
      data.password = crypto.createHash('sha256').update(dto.password + salt).digest('hex');
    }
    try {
      await this.prisma.user.update({ where: { id: userId }, data });
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email already in use');
      }
      throw error;
    }

    return {};
  }

  async updateModel(userId: string, dto: UpdateModelDto) {
    const modelCode = await this.prisma.common_code.findUnique({
      where: { category_code_code: { category_code: 'model', code: dto.model } },
    });
    if (!modelCode) throw new NotFoundException('Model not found');

    await this.prisma.user.update({ where: { id: userId }, data: { model: dto.model } });
    return {};
  }
}
