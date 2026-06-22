import { Injectable, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { UserRepository } from '../user/user.repository';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private userRepo: UserRepository,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<{ accessToken: string }> {
    const existing = await this.userRepo.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already in use');

    const modelCode = await this.userRepo.findModelCode('model', dto.model);
    if (!modelCode) throw new NotFoundException('Model not found');

    const salt = crypto.randomBytes(32).toString('hex');
    const password = crypto.createHash('sha256').update(dto.password + salt).digest('hex');

    const user = await this.userRepo.create({ email: dto.email, password, salt, model: dto.model });

    const accessToken = this.jwtService.sign({ sub: user.id, email: user.email });
    return { accessToken };
  }

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.userRepo.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException();

    const hash = crypto.createHash('sha256').update(dto.password + user.salt).digest('hex');
    if (hash !== user.password) throw new UnauthorizedException();

    const accessToken = this.jwtService.sign({ sub: user.id, email: user.email });
    return { accessToken };
  }
}
