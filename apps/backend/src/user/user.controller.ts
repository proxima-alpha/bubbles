import { Controller, Get, Put, Body, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserService } from './user.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { UpdateLicenseKeyDto } from './dto/update-license-key.dto';

@Controller('user')
@UseGuards(AuthGuard('jwt'))
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  getUser(@Request() req: any) {
    return this.userService.getUser(req.user.id);
  }

  @Put()
  updateUser(@Request() req: any, @Body() dto: UpdateUserDto) {
    return this.userService.updateUser(req.user.id, dto);
  }

  @Put('model')
  updateModel(@Request() req: any, @Body() dto: UpdateModelDto) {
    return this.userService.updateModel(req.user.id, dto);
  }

  @Put('license-key')
  updateLicenseKey(@Request() req: any, @Body() dto: UpdateLicenseKeyDto) {
    return this.userService.updateLicenseKey(req.user.id, dto);
  }
}
