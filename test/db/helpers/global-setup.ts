import { assertThrowawayDatabase } from './assert-throwaway-db';

// Runs once before any DB spec is even loaded, so a misconfigured run stops
// before a single module (or PrismaClient) is constructed.
export default async function globalSetup() {
    assertThrowawayDatabase();
}
