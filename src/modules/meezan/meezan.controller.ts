import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { MeezanService } from './meezan.service';
import { MeezanBillInquiryDto } from './dto/bill-inquiry.dto';
import { MeezanBillPaymentDto } from './dto/bill-payment.dto';

@Controller('meezan')
export class MeezanController {
  constructor(private readonly meezanService: MeezanService) {}

  @Post('bill-inquiry')
  @HttpCode(200)
  async billInquiry(@Body() dto: MeezanBillInquiryDto) {
    return this.meezanService.handleBillInquiry(dto);
  }

  @Post('bill-payment')
  @HttpCode(200)
  async billPayment(@Body() dto: MeezanBillPaymentDto) {
    return this.meezanService.handleBillPayment(dto);
  }
}
