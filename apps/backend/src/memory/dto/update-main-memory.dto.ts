import { IsArray, IsString } from 'class-validator';

export class UpdateMainMemoryDto {
  @IsArray()
  @IsString({ each: true })
  contents: string[];
}
