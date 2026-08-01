import { IsString } from 'class-validator';

export class UpdateMainMemoryDto {
  @IsString()
  summary: string;
}
