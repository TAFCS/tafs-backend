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

  // 1. Setup Origins
  const rawOrigins = process.env.CORS_ORIGIN;
  const corsOrigins = rawOrigins
    ? rawOrigins.split(',').map((o) => o.trim().replace(/\/$/, ''))
    : [/^http:\/\/localhost(:\d+)?$/];

  // eslint-disable-next-line no-console
  console.log('--- Startup: CORS Configuration ---');
  // eslint-disable-next-line no-console
  console.log('Allowed Origins Raw:', rawOrigins);
  // eslint-disable-next-line no-console
  console.log('Allowed Origins Parsed:', corsOrigins);

  // 2. Request Logger (Debug)
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS' || req.url.includes('auth')) {
      // eslint-disable-next-line no-console
      console.log(`[HTTP] ${req.method} ${req.url} | Origin: ${req.headers.origin}`);
    }
    next();
  });

  // 3. Enable CORS (Must be before Helmet if using global prefix)
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const isAllowed = corsOrigins.some((pattern) => {
        if (pattern instanceof RegExp) return pattern.test(origin);
        // Case-insensitive and slash-agnostic comparison
        const normalizedOrigin = origin.trim().replace(/\/$/, '').toLowerCase();
        const normalizedPattern = String(pattern).trim().replace(/\/$/, '').toLowerCase();
        return normalizedOrigin === normalizedPattern;
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[CORS REJECTED] Origin: ${origin}`);
        callback(null, false);
      }
    },
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

  // 4. Security Headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  app.use(compression());
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

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
