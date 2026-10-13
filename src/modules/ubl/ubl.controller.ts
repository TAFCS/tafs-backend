import { Body, Controller, Get, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { UblBillInquiryQueryDto, UblBillPaymentDto } from './dto/ubl-bill.dto';
import { UblService, UBL_RESPONSE } from './ubl.service';

const unauthorized = () => ({ response_code: UBL_RESPONSE.UNAUTHORIZED[0], response_desc: UBL_RESPONSE.UNAUTHORIZED[1] });

/**
 * UBL bill inquiry / payment (TAFSD-294). Called by UBL's systems, not staff,
 * so there is no JWT: UBL authenticates with the X-UBL-User / X-UBL-Password
 * headers. Contract: TAFS API Documentation for UBL.
 */
@Controller('ubl')
export class UblController {
    constructor(private readonly ublService: UblService) {}

    @Get('bill-inquiry')
    @HttpCode(200)
    async billInquiry(
        @Query() query: UblBillInquiryQueryDto,
        @Headers('x-ubl-user') user?: string,
        @Headers('x-ubl-password') password?: string,
    ) {
        if (!this.ublService.isAuthorized(user, password)) return unauthorized();
        return this.ublService.billInquiry(query);
    }

    @Post('bill-payment')
    @HttpCode(200)
    async billPayment(
        @Body() dto: UblBillPaymentDto,
        @Headers('x-ubl-user') user?: string,
        @Headers('x-ubl-password') password?: string,
    ) {
        if (!this.ublService.isAuthorized(user, password)) return unauthorized();
        return this.ublService.billPayment(dto);
    }
}
