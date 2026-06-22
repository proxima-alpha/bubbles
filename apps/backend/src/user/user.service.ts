import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import * as crypto from 'crypto';
import { UserRepository } from './user.repository';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateModelDto } from './dto/update-model.dto';

@Injectable()
export class UserService {
  constructor(private userRepo: UserRepository) {}

  async getUser(userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new NotFoundException();

    return {
      email: user.email,
      model: user.model_code ? { code: user.model_code.code, name: user.model_code.name } : null,
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
      await this.userRepo.update(userId, data);
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email already in use');
      }
      throw error;
    }

    return {};
  }

  async updateModel(userId: string, dto: UpdateModelDto) {
    const modelCode = await this.userRepo.findModelCode('model', dto.model);
    if (!modelCode) throw new NotFoundException('Model not found');

    await this.userRepo.update(userId, { model: dto.model });
    return {};
  }
}
