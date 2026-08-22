import { IsString } from 'class-validator';

export class ChatMessageRequest {
  @IsString()
  content: string;
}
