import { BlockList, isIP } from 'net';

/**
 * TAFSD-548: network controls for the UBL bill inquiry / payment endpoints.
 *
 * - An optional source-IP allow-list (UBL_ALLOWED_IPS). Unset means "allow
 *   all", which is how testing ran before UBL shared its egress addresses.
 * - A per-client request rate limit (UBL_RATE_LIMIT_PER_MINUTE).
 *
 * Working out the client's address: the API sits behind Cloudflare, and
 * DigitalOcean App Platform's edge sets `do-connecting-ip` to whoever
 * connected to it. Through Cloudflare that is a Cloudflare edge address, and
 * the real client is in `cf-connecting-ip`. A request sent straight to the
 * DigitalOcean hostname can put anything in `cf-connecting-ip`, so that header
 * is trusted ONLY when the connecting peer is one of Cloudflare's published
 * ranges. `x-forwarded-for` is never trusted.
 */

/** Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). */
export const CLOUDFLARE_RANGES = [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22',
    '2400:cb00::/32',
    '2606:4700::/32',
    '2803:f800::/32',
    '2405:b500::/32',
    '2405:8100::/32',
    '2a06:98c0::/29',
    '2c0f:f248::/32',
];

/** `::ffff:1.2.3.4` (IPv4 seen on an IPv6 socket) → `1.2.3.4`. */
export function normalizeIp(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let ip = raw.trim();
    if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
    return isIP(ip) ? ip : null;
}

/**
 * Parses comma-separated IPs and CIDR ranges ("1.2.3.4, 10.0.0.0/24, 2001:db8::/32").
 * Returns null for an empty or unset list, meaning "no restriction".
 * Throws on an entry that is not an IP or CIDR, so a typo cannot silently open
 * or close the API.
 */
export function parseIpList(raw: string | null | undefined): BlockList | null {
    const entries = (raw ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
    if (!entries.length) return null;
    const list = new BlockList();
    for (const entry of entries) {
        const [addr, bits] = entry.split('/');
        const ip = normalizeIp(addr);
        if (!ip) throw new Error(`Invalid IP or CIDR in list: "${entry}"`);
        const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
        if (bits === undefined) {
            list.addAddress(ip, type);
            continue;
        }
        const prefix = Number(bits);
        const max = type === 'ipv6' ? 128 : 32;
        if (!/^\d+$/.test(bits) || prefix < 0 || prefix > max) {
            throw new Error(`Invalid IP or CIDR in list: "${entry}"`);
        }
        list.addSubnet(ip, prefix, type);
    }
    return list;
}

export function ipInList(list: BlockList, ip: string): boolean {
    return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

const header = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined => {
    const v = headers[name];
    return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || undefined;
};

/**
 * The caller's real address. `peer` is whoever connected to DigitalOcean's
 * edge (do-connecting-ip), falling back to the socket address (local runs).
 * Cloudflare's client header is believed only when that peer is Cloudflare.
 */
export function clientIpOf(
    headers: Record<string, string | string[] | undefined>,
    socketAddress: string | undefined,
    trustedProxies: BlockList,
): string | null {
    const peer = normalizeIp(header(headers, 'do-connecting-ip')) ?? normalizeIp(socketAddress);
    if (!peer) return null;
    if (ipInList(trustedProxies, peer)) {
        return normalizeIp(header(headers, 'cf-connecting-ip')) ?? peer;
    }
    return peer;
}

/** Fixed one-minute windows per key; old windows are dropped as they expire. */
export class PerMinuteLimiter {
    private readonly windows = new Map<string, { start: number; count: number }>();

    constructor(
        private readonly limit: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** True if this request is allowed; false once the key is over its limit this minute. */
    take(key: string): boolean {
        if (this.limit <= 0) return true;
        const t = this.now();
        const w = this.windows.get(key);
        if (!w || t - w.start >= 60_000) {
            this.windows.set(key, { start: t, count: 1 });
            if (this.windows.size > 10_000) this.sweep(t);
            return true;
        }
        w.count += 1;
        return w.count <= this.limit;
    }

    private sweep(t: number) {
        for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k);
    }
}

/** Default requests per minute per client when UBL_RATE_LIMIT_PER_MINUTE is not set. */
export const DEFAULT_UBL_RATE_LIMIT_PER_MINUTE = 600;

export function rateLimitFromEnv(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_UBL_RATE_LIMIT_PER_MINUTE;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`UBL_RATE_LIMIT_PER_MINUTE must be a whole number ≥ 0, got "${raw}"`);
    return n; // 0 turns the limit off
}
