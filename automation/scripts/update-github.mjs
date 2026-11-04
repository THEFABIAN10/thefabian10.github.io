import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fetchSchedule, fetchAddress, fetchYasno } from '../src/providers.ts';
const require = createRequire(import.meta.url);
const { FILES, collectData, waitForPublication, notifySources } = require('../lib/github-pipeline.js');
const config = require('../push-config.json');
const [phase, statePath, sitePath] = process.argv.slice(2);
if (!['fetch', 'publish', 'notify', 'verify'].includes(phase) || !statePath || !sitePath) throw new Error('Usage: update-github.mjs fetch|publish|notify|verify STATE SITE');
const state = resolve(statePath);
const site = resolve(sitePath);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function commit(dir, branch, paths, message) {
    git(dir, 'config', 'user.name', 'outages-bot');
    git(dir, 'config', 'user.email', 'outages-bot@users.noreply.github.com');
    git(dir, 'add', '--', ...paths);
    const diff = spawnSync('git', ['-C', dir, 'diff', '--cached', '--quiet']);
    if (diff.status === 0) return;
    if (diff.status !== 1) throw new Error('Could not inspect staged changes');
    git(dir, 'commit', '-m', message);
    // Never force-push. Refuse conflicts instead of replacing other changes.
    git(dir, 'pull', '--rebase', 'origin', branch);
    git(dir, 'push', 'origin', `HEAD:${branch}`);
}
function loadData() {
    return Object.fromEntries(Object.values(FILES).filter(file => existsSync(join(state, 'data', file)))
        .map(file => [file, read(join(state, 'data', file))]));
}
if (phase === 'fetch') {
    const now = new Date();
    const result = await collectData(loadData(), {
        schedule: () => fetchSchedule(now), address: () => fetchAddress(now), yasno: () => fetchYasno(now),
    });
    mkdirSync(join(state, 'data'), { recursive: true });
    for (const [file, data] of Object.entries(result.data)) write(join(state, 'data', file), data);
    write(join(state, 'run.json'), { checkedAt: now.toISOString(), updated: result.updated, errors: result.errors });
    commit(state, 'outage-state', ['data', 'run.json'], 'Update collected outage data');
    console.log(JSON.stringify({ updated: result.updated, errors: result.errors }));
} else if (phase === 'publish') {
    mkdirSync(join(site, 'data'), { recursive: true });
    for (const file of Object.keys(loadData())) copyFileSync(join(state, 'data', file), join(site, 'data', file));
    commit(site, 'main', ['data'], 'Update outage data');
    // GITHUB_TOKEN pushes do not trigger push workflows. Dispatch Pages explicitly.
    if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required to publish Pages');
    const response = await fetch('https://api.github.com/repos/norivka/norivka.github.io/actions/workflows/pages.yml/dispatches', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'norivka-outages-publisher' },
        body: JSON.stringify({ ref: 'main' }), signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Pages dispatch HTTP ${response.status}`);
    await response.body?.cancel();
    console.log('Pages deployment dispatched');
} else {
    const data = loadData();
    const run = read(join(state, 'run.json'));
    let notificationErrors = {};
    if (phase === 'verify') await waitForPublication(data, config.siteUrl);
    else {
        const states = Object.fromEntries(['dtek', 'yasno'].map(source => [source, read(join(state, 'notifications', `${source}.json`))]));
        notificationErrors = await notifySources({ data, updated: run.updated, states, config,
            apiKey: process.env.ONESIGNAL_REST_API_KEY,
            acknowledge: async (source, next) => {
                write(join(state, 'notifications', `${source}.json`), next);
                commit(state, 'outage-state', ['notifications'], `Acknowledge ${source} notification state`);
            },
        });
    }
    console.log(JSON.stringify({ publication: 'confirmed', fetchErrors: run.errors, notificationErrors }));
    if (Object.keys(run.errors).length || Object.keys(notificationErrors).length) process.exitCode = 1;
}
