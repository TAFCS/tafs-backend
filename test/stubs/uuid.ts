// Jest stub for `uuid`. uuid@13 ships ESM only, which ts-jest's CJS transform
// can't load; the backend only ever calls v4(). Node's crypto gives the same
// RFC 4122 v4 ids.
import { randomUUID } from 'crypto';

export const v4 = (): string => randomUUID();
export const validate = (s: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
