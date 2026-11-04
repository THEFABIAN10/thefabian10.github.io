import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assessUpdateHealth } = require('../lib/update-health.js');
const { siteUrl } = require('../push-config.json');
const repo = process.env.GITHUB_REPOSITORY || 'norivka/norivka.github.io';
if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required to inspect workflow runs');
async function getJson(url, headers = {}) {
    const response = await fetch(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} reading ${new URL(url).pathname}`);
    return response.json();
}
const errors = [];
let runs;
try {
    const result = await getJson(`https://api.github.com/repos/${repo}/actions/workflows/update-outages.yml/runs?branch=main&per_page=10`, {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'norivka-outages-health',
    });
    if (!Array.isArray(result.workflow_runs)) throw new Error('Invalid workflow runs response');
    runs = result.workflow_runs;
} catch (error) { errors.push(`Cannot check update runs: ${error.message}`); }
const files = {};
await Promise.all(['dtek-outages.json', 'dtek-address.json', 'outages.json'].map(async file => {
    const url = new URL(`data/${file}`, siteUrl);
    url.searchParams.set('t', String(Date.now()));
    try { files[file] = await getJson(url); }
    catch (error) { errors.push(`${file}: ${error.message}`); }
}));
errors.push(...assessUpdateHealth(runs || [], files));
if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
} else console.log('Healthy: update dispatches and all three public data files are recent; no repeated run failures.');
