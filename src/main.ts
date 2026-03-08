import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  const rawOrigins = process.env.CORS_ORIGIN;
  const corsOrigins = rawOrigins
    ? rawOrigins.split(',').map((o) => o.trim().replace(/\/$/, ''))
    : [/^http:\/\/localhost(:\d+)?$/];

  // Enable CORS first thing to ensure OPTIONS requests are handled before other middleware
  app.enableCors({
    origin: corsOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Requested-With',
      'Origin',
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Security headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      contentSecurityPolicy: false, // Temporarily disable CSP to rule it out
    }),
  );

  // Gzip / Brotli compression — reduces JSON payload size by 60-80%
  app.use(compression());

  // Required to read cookies in controllers / strategies
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Consistent JSON error shape for all unhandled exceptions
  app.useGlobalFilters(new HttpExceptionFilter());

  // eslint-disable-next-line no-console
  console.log('CORS origins configured:', corsOrigins);

  app.use(
    morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'),
  );

  const config = new DocumentBuilder()
    .setTitle('TAFS API')
    .setDescription('TAFS Backend API documentation')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        in: 'header',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);

  const appUrl = await app.getUrl();
  // eslint-disable-next-line no-console
  console.log(`Swagger docs available at: ${appUrl}/api/docs`);
}
bootstrap();
