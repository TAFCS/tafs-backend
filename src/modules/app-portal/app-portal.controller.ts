import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { AppPortalService } from './app-portal.service';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';

@Controller('app')
@UseGuards(JwtParentGuard)
export class AppPortalController {
  constructor(private readonly appPortalService: AppPortalService) {}

  @Get('student/:cc/ledger')
  async getStudentLedger(@Param('cc', ParseIntPipe) cc: number) {
    return this.appPortalService.getStudentLedger(cc);
  }
}
