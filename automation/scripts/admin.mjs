import { readFile } from 'node:fs/promises';
const [action, endpoint = 'https://norivka-outages.numrut.workers.dev'] = process.argv.slice(2);
if (!['dispatch', 'status'].includes(action)) throw new Error('Usage: node scripts/admin.mjs dispatch|status [Worker URL]');
const base = new URL(endpoint);
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Use HTTPS');
const secrets = action === 'dispatch' ? JSON.parse(await readFile(new URL('../.dev.vars.deploy.json', import.meta.url), 'utf8')) : {};
const response = await fetch(new URL(action === 'status' ? '/health' : '/admin/dispatch', base), {
    method: action === 'status' ? 'GET' : 'POST',
    headers: action === 'dispatch' ? { Authorization: `Bearer ${secrets.ADMIN_TOKEN}` } : {},
    signal: AbortSignal.timeout(60000),
});
console.log(`HTTP ${response.status}`);
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
