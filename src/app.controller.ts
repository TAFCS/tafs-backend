import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Process-alive probe for Railway. No DB — must stay instant under load. */
  @Get('healthz')
  healthz() {
    return { ok: true, ts: new Date().toISOString() };
  }
}
