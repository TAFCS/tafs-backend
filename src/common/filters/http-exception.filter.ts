import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    // NestJS built-in exceptions return either a string or an object
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : typeof exceptionResponse === 'object' && exceptionResponse !== null
          ? (exceptionResponse as { message?: string | string[] }).message ?? 'Internal server error'
          : 'Internal server error';

    const payload: Record<string, any> = {
      status,
      message,
      data: null,
    };

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      if ('code' in exceptionResponse) {
        payload.code = (exceptionResponse as any).code;
      }
      if ('minBuildNumber' in exceptionResponse) {
        payload.minBuildNumber = (exceptionResponse as any).minBuildNumber;
      }
      if ('storeUrl' in exceptionResponse) {
        payload.storeUrl = (exceptionResponse as any).storeUrl;
      }
    }

    const isMaintenance503 =
      status === HttpStatus.SERVICE_UNAVAILABLE &&
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      (exceptionResponse as any).code === 'MAINTENANCE';

    if (status >= 500 && !isMaintenance503) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(status).json(payload);
  }
}
