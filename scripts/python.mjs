// Use this checkout's Python environment on every supported platform.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const local = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const executable = process.env.DOWNBEAT_PYTHON || (existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
