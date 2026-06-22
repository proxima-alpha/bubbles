import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UserRepository {
  constructor(private prisma: PrismaService) {}

  async findById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: { model_code: true },
    });
  }

  async findByIdWithModel(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: { model_code: { include: { parent: true } } },
    });
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async create(data: { email: string; password: string; salt: string; model: string }) {
    return this.prisma.user.create({ data });
  }

  async update(userId: string, data: Record<string, unknown>) {
    return this.prisma.user.update({ where: { id: userId }, data });
  }

  async findModelCode(category: string, code: string) {
    return this.prisma.common_code.findUnique({
      where: { category_code_code: { category_code: category, code } },
    });
  }
}
