import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseDtek } from '../src/providers.ts';

// Import the exact production providers, including headers, cookie handling,
// CSRF extraction, form encoding, timeouts and response validation.
console.log(JSON.stringify({ transport: 'production-fetch', ...await diagnoseDtek() }));

// Separately exercise the surviving curl scripts, including the address POST.
// These are the current repository's scripts, not recovered deleted workflows.
const dir = mkdtempSync(join(tmpdir(), 'dtek-probe-'));
try {
    for (const [name, script, file] of [
        ['schedule', 'fetch-dtek-data.sh', 'dtek-outages.json'],
        ['address', 'fetch-dtek-address.sh', 'dtek-address.json'],
    ]) {
        try {
            execFileSync('bash', [fileURLToPath(new URL(`../lib/${script}`, import.meta.url))],
                { cwd: dir, encoding: 'utf8', timeout: 180000, stdio: 'pipe' });
            console.log(JSON.stringify({ transport: 'repository-curl-script', name, ok: true,
                data: JSON.parse(readFileSync(join(dir, 'data', file), 'utf8')) }));
        } catch {
            console.log(JSON.stringify({ transport: 'repository-curl-script', name, ok: false,
                error: 'Script failed or timed out; raw responses and session credentials omitted' }));
        }
    }
} finally { rmSync(dir, { recursive: true, force: true }); }
