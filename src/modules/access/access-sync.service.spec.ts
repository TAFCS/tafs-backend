import { AccessSyncService } from './access-sync.service';
import { TILES_MANIFEST } from './tiles.manifest';

const manifestKeys = [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))];

function makePrisma(existingKeys: string[]) {
  const rows = new Map(existingKeys.map((k, i) => [k, i + 1]));
  const permissions = {
    findMany: jest.fn(async () =>
      [...rows.entries()].map(([key, id]) => ({ id, key })),
    ),
    createMany: jest.fn(async ({ data }: { data: { key: string }[] }) => {
      for (const d of data) if (!rows.has(d.key)) rows.set(d.key, rows.size + 1);
      return { count: data.length };
    }),
  };
  const prisma = {
    permissions,
    $executeRaw: jest.fn(async () => 0),
    access_tile_capabilities: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    access_tiles: { updateMany: jest.fn(async () => ({ count: 0 })) },
    access_tile_actions: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async () => []),
      createMany: jest.fn(async () => ({ count: 0 })),
      upsert: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : (ops as any)(prisma),
    ),
  };
  return prisma;
}

describe('AccessSyncService permission bootstrap', () => {
  it('creates placeholder rows for manifest keys missing from the table instead of aborting boot', async () => {
    const [missingKey, ...present] = manifestKeys;
    const prisma = makePrisma(present);
    const service = new AccessSyncService(prisma as any);

    await service.sync().catch((err) => {
      // Later projection steps use loose mocks; only the bootstrap matters here.
      expect(String(err?.message)).not.toMatch(/do not exist/);
    });

    expect(prisma.permissions.createMany).toHaveBeenCalledTimes(1);
    const arg = (prisma.permissions.createMany.mock.calls as any)[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data.map((d: { key: string }) => d.key)).toEqual([missingKey]);
    expect(arg.data[0].module.length).toBeLessThanOrEqual(50);
    expect(arg.data[0].description.length).toBeLessThanOrEqual(255);
  });

  it('inserts nothing when every manifest key already exists', async () => {
    const prisma = makePrisma(manifestKeys);
    const service = new AccessSyncService(prisma as any);

    await service.sync().catch(() => undefined);

    expect(prisma.permissions.createMany).not.toHaveBeenCalled();
  });
});
