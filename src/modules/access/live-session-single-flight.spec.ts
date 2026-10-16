import { StaffRole } from '@prisma/client';
import { AccessService } from './access.service';
import { ScopeService } from '../../common/scope/scope.service';

/**
 * TAFSD-326: a page load fires many requests at once. On a cache miss they
 * must share one access lookup and one scope resolution, not each run the
 * full set of queries.
 */
describe('live session and scope single-flight', () => {
  const access = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const findUnique = jest.fn(async () => {
      await gate;
      return { is_active: true, role: StaffRole.EMPLOYEE };
    });
    const svc = new AccessService({ users: { findUnique } } as any, {} as any, {} as any);
    const resolveEffective = jest
      .spyOn(svc, 'resolveEffective')
      .mockResolvedValue({ capabilityKeys: ['a'], actionIds: ['t#view'] } as any);
    return { svc, findUnique, resolveEffective, release };
  };

  it('shares one lookup between concurrent requests and caches it', async () => {
    const { svc, findUnique, resolveEffective, release } = access();
    const calls = Array.from({ length: 10 }, () => svc.resolveLiveSession('u1'));
    release();
    const sessions = await Promise.all(calls);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(resolveEffective).toHaveBeenCalledTimes(1);
    expect(new Set(sessions).size).toBe(1);

    await svc.resolveLiveSession('u1');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not cache a lookup that was invalidated while it ran', async () => {
    const { svc, findUnique, release } = access();
    const first = svc.resolveLiveSession('u1');
    svc.invalidateLiveSession('u1');
    release();
    await first;
    await svc.resolveLiveSession('u1');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('shares one scope resolution between concurrent requests', async () => {
    const svc = new ScopeService({} as any);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const resolve = jest.spyOn(svc, 'resolve').mockImplementation(async () => {
      await gate;
      return {} as any;
    });
    jest.spyOn(svc as any, 'withSegmentClasses').mockImplementation(async (s: any) => s);
    jest.spyOn(svc as any, 'withCategoryDepartments').mockImplementation(async (s: any) => s);

    const calls = Array.from({ length: 10 }, () => svc.resolveEffective('u1'));
    release();
    await Promise.all(calls);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
