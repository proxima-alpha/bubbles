import { IsString } from 'class-validator';

export class UpdateModelDto {
  @IsString()
  model: string;
}
