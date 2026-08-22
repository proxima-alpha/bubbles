import { IsString } from 'class-validator';

export class MessageContent {
  @IsString()
  id: string;
  @IsString()
  content: string;
}
