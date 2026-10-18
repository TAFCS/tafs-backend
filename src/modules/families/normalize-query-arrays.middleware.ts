import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Some HTTP clients send array params with bracket notation (types[]=a&types[]=b).
 * NestJS's ValidationPipe sees `types[]` as an unknown property and rejects it.
 * This middleware strips the brackets from query param keys before validation runs.
 */
@Injectable()
export class NormalizeQueryArraysMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const query = req.query as Record<string, unknown>;
    for (const key of Object.keys(query)) {
      if (key.endsWith('[]')) {
        const normalKey = key.slice(0, -2);
        if (!(normalKey in query)) {
          query[normalKey] = query[key];
        }
        delete query[key];
      }
    }
    next();
  }
}
