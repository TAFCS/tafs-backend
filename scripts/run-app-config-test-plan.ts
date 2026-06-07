/**
 * Executes App Config Test Plan Phase 1 against a live backend.
 * Usage: npx ts-node scripts/run-app-config-test-plan.ts [baseUrl]
 * Default baseUrl: http://127.0.0.1:8080/api/v1
 */

const BASE = (process.argv[2]?.replace(/\/$/, '') || 'http://127.0.0.1:8080/api/v1');

type Result = { name: string; pass: boolean; detail?: string };

const results: Result[] = [];

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`  [${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getStatus(platform: string, build: number | string) {
  const url = `${BASE}/app-config/status?platform=${platform}&build=${build}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log(`\nApp Config Test Plan — Live API (${BASE})\n`);

  try {
    const { status, body } = await getStatus('android', 9);
    const data = body?.data;
    record(
      '1.1 baseline android build 9',
      status === 200 && data?.maintenanceMode === false && data?.forceUpdate === false,
      data ? JSON.stringify(data) : `status ${status}`,
    );
  } catch (e: any) {
    record('1.1 baseline android', false, e.message);
  }

  try {
    const { status, body } = await getStatus('ios', 9);
    record('1.1 baseline ios', status === 200 && body?.data?.forceUpdate === false);
  } catch (e: any) {
    record('1.1 baseline ios', false, e.message);
  }

  try {
    const { status } = await getStatus('windows', 9);
    record('1.6 invalid platform', status === 400, `status ${status}`);
  } catch (e: any) {
    record('1.6 invalid platform', false, e.message);
  }

  try {
    const { status } = await getStatus('android', 'abc');
    record('1.6 invalid build', status === 400, `status ${status}`);
  } catch (e: any) {
    record('1.6 invalid build', false, e.message);
  }

  try {
    const res = await fetch(`${BASE}/app-config`);
    record('1.5 GET /app-config without auth', res.status === 401, `status ${res.status}`);
  } catch (e: any) {
    record('1.5 GET /app-config without auth', false, e.message);
  }

  try {
    const { status } = await getStatus('android', 1);
    record('1.5 GET status public', status === 200);
  } catch (e: any) {
    record('1.5 GET status public', false, e.message);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed (${results.length} total)\n`);

  if (failed > 0) {
    console.log(
      'Note: Live API tests require backend running latest code with app_config migrated/seeded.',
    );
    process.exit(1);
  }
}

main();
