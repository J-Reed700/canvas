import { spawnSync } from 'node:child_process';
const steps = ['lint:react', 'typecheck', 'test:coverage', 'test:python:coverage', 'build', 'test:e2e', 'perf:check'];
for (const step of steps) {
  console.log(`\nQuality check: ${step}`);
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', step], {
    stdio: 'inherit', env: { ...process.env, DOWNBEAT_REQUIRE_E2E: '1' },
    shell: process.platform === 'win32',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
