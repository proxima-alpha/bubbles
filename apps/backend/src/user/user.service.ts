import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { UpdateLicenseKeyDto } from './dto/update-license-key.dto';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { license_keys: true },
    });
    if (!user) throw new NotFoundException();

    const providers = await this.prisma.common_code.findMany({
      where: { category_code: 'provider', is_active: true },
      orderBy: { order: 'asc' },
    });

    return {
      email: user.email,
      model: user.model,
      providers: providers.map(p => ({
        provider: p.code,
        hasKey: user.license_keys.some(lk => lk.provider === p.code),
      })),
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
    await this.prisma.user.update({ where: { id: userId }, data });
    return {};
  }

  async updateModel(userId: string, dto: UpdateModelDto) {
    const modelCode = await this.prisma.common_code.findUnique({
      where: { category_code_code: { category_code: 'model', code: dto.model } },
    });
    if (!modelCode) throw new NotFoundException('Model not found');

    const provider = modelCode.parent_code;
    if (!provider) throw new ForbiddenException('Model has no provider');

    const licenseKey = await this.prisma.license_key.findUnique({
      where: { user_id_provider: { user_id: userId, provider } },
    });
    if (!licenseKey) throw new ForbiddenException('No license key for this provider');

    await this.prisma.user.update({ where: { id: userId }, data: { model: dto.model } });
    return {};
  }

  async updateLicenseKey(userId: string, dto: UpdateLicenseKeyDto) {
    await this.prisma.license_key.upsert({
      where: { user_id_provider: { user_id: userId, provider: dto.provider } },
      update: { key: dto.key },
      create: { user_id: userId, provider: dto.provider, key: dto.key },
    });
    return {};
  }
}
