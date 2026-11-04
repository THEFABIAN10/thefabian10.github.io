import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
const root = new URL('../', import.meta.url);
const path = new URL('.dev.vars.deploy.json', root);
const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const input = parseEnv(readFileSync(new URL('.dev.vars', root), 'utf8'));
if (!input.GITHUB_ACTIONS_TOKEN?.trim()) throw new Error('Set GITHUB_ACTIONS_TOKEN in .dev.vars');
writeFileSync(path, JSON.stringify({
    ADMIN_TOKEN: previous.ADMIN_TOKEN || input.ADMIN_TOKEN || randomBytes(32).toString('base64url'),
    GITHUB_ACTIONS_TOKEN: input.GITHUB_ACTIONS_TOKEN.trim(),
}), { mode: 0o600 });
chmodSync(path, 0o600);
console.log('Scheduler secrets prepared; values are not printed.');
