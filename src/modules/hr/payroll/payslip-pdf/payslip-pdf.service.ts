import { Injectable, Logger } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import * as React from 'react';
import { PayslipPDF, PayslipPDFProps } from './PayslipPDF';

export type PayslipPdfData = PayslipPDFProps;

@Injectable()
export class PayslipPdfService {
  private readonly logger = new Logger(PayslipPdfService.name);

  async generatePayslipPdf(data: PayslipPdfData): Promise<Buffer> {
    this.logger.debug(`Generating payslip PDF for ${data.employee.fullName} (${period(data)})`);
    try {
      const reactElement = React.createElement(PayslipPDF, data) as any;
      const buffer = await renderToBuffer(reactElement);
      return Buffer.from(buffer);
    } catch (error) {
      this.logger.error(`Failed to generate payslip PDF for ${data.employee.fullName}`, error);
      throw error;
    }
  }
}

function period(data: PayslipPdfData): string {
  return `${data.period.start} - ${data.period.end}`;
}
