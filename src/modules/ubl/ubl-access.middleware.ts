import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { BlockList } from 'net';
import {
    CLOUDFLARE_RANGES,
    PerMinuteLimiter,
    clientIpOf,
    ipInList,
    parseIpList,
    rateLimitFromEnv,
} from './ubl-access';
import { UBL_RESPONSE } from './ubl.service';

/**
 * TAFSD-548: source-IP allow-list and per-client rate limit for UBL's bill
 * inquiry / payment routes. Runs as middleware so it answers before body
 * validation, guards or the credential check, in UBL's response format.
 *
 * Env (read once at startup):
 * - UBL_ALLOWED_IPS: comma-separated IPs / CIDRs. Unset or empty: no IP
 *   restriction. An invalid entry refuses ALL UBL requests (fails closed) and
 *   logs an error, rather than taking down the whole API.
 * - UBL_RATE_LIMIT_PER_MINUTE: requests per client per minute (default 600;
 *   0 turns the limit off).
 * - UBL_TRUSTED_PROXY_RANGES: optional override of Cloudflare's ranges.
 */
@Injectable()
export class UblAccessMiddleware implements NestMiddleware {
    private readonly logger = new Logger('UblAccess');
    private readonly allowList: BlockList | null;
    private readonly trustedProxies: BlockList;
    private readonly limiter: PerMinuteLimiter;
    private readonly misconfigured: string | null;

    constructor() {
        let misconfigured: string | null = null;
        let allowList: BlockList | null = null;
        let trusted = parseIpList(CLOUDFLARE_RANGES.join(','))!;
        let limit = 0;
        try {
            allowList = parseIpList(process.env.UBL_ALLOWED_IPS);
            const override = parseIpList(process.env.UBL_TRUSTED_PROXY_RANGES);
            if (override) trusted = override;
            limit = rateLimitFromEnv(process.env.UBL_RATE_LIMIT_PER_MINUTE);
        } catch (err) {
            misconfigured = (err as Error).message;
            this.logger.error(`UBL network controls misconfigured; refusing all UBL requests: ${misconfigured}`);
        }
        this.allowList = allowList;
        this.trustedProxies = trusted;
        this.limiter = new PerMinuteLimiter(limit);
        this.misconfigured = misconfigured;
        if (!misconfigured) {
            this.logger.log(
                `UBL IP allow-list ${allowList ? 'ON' : 'OFF (no UBL_ALLOWED_IPS)'}; rate limit ${limit > 0 ? `${limit}/min per client` : 'OFF'}`,
            );
        }
    }

    use(req: Request, res: Response, next: NextFunction) {
        const ip = clientIpOf(req.headers, req.socket?.remoteAddress, this.trustedProxies);
        const refuse = (status: number, code: readonly [string, string], desc: string, reason: string) => {
            this.logger.warn(`UBL request refused (${reason}): ${req.method} ${req.path} from ${ip ?? 'unknown'}`);
            res.status(status).json({ response_code: code[0], response_desc: desc, client_ip: ip });
        };

        if (this.misconfigured) {
            return refuse(503, UBL_RESPONSE.GENERAL_ERROR, 'Service is not available; please contact TAFS', 'misconfigured');
        }
        if (this.allowList && (!ip || !ipInList(this.allowList, ip))) {
            return refuse(403, UBL_RESPONSE.UNAUTHORIZED, 'Requests from this address are not allowed', 'ip-not-allowed');
        }
        if (!this.limiter.take(ip ?? 'unknown')) {
            res.setHeader('Retry-After', '60');
            return refuse(429, UBL_RESPONSE.GENERAL_ERROR, 'Too many requests; retry later', 'rate-limited');
        }
        next();
    }
}
