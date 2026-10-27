jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { UsersService } from './users.service';

describe('UsersService.findParentByUsername', () => {
  it('normalizes username to lowercase and trims whitespace with case-insensitive search', async () => {
    const mockFindFirst = jest.fn().mockResolvedValue({
      id: 42,
      email: 'parent@example.com',
      household_name: 'Khan Household',
      password_hash: 'hashed',
    });

    const prismaMock: any = {
      families: {
        findFirst: mockFindFirst,
      },
    };

    const service = new UsersService(prismaMock, {} as any, {} as any, {} as any);

    const result = await service.findParentByUsername('  Parent@Example.COM  ');

    expect(result).toBeDefined();
    expect(result?.id).toBe(42);
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: 'parent@example.com', mode: 'insensitive' },
        deleted_at: null,
        password_hash: { not: null },
      },
      select: {
        id: true,
        email: true,
        household_name: true,
        password_hash: true,
      },
    });
  });
});
