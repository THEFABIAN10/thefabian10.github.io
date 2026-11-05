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
function loadData(root = state) {
    return Object.fromEntries(Object.values(FILES).filter(file => existsSync(join(root, 'data', file)))
        .map(file => [file, read(join(root, 'data', file))]));
}
if (phase === 'fetch') {
    const now = new Date();
    const result = await collectData(loadData(), {
        schedule: () => fetchSchedule(now), address: () => fetchAddress(now), yasno: () => fetchYasno(now),
    });
    mkdirSync(join(state, 'data'), { recursive: true });
    for (const [file, data] of Object.entries(result.data)) write(join(state, 'data', file), data);
    write(join(state, 'run.json'), { checkedAt: now.toISOString(), updated: result.updated, errors: result.errors, notify: process.env.NOTIFY !== 'false' });
    commit(state, 'outage-state', ['data', 'run.json'], 'Update collected outage data');
    console.log(JSON.stringify({ updated: result.updated, errors: result.errors }));
} else if (phase === 'publish') {
    mkdirSync(join(site, 'data'), { recursive: true });
    for (const file of Object.keys(loadData())) copyFileSync(join(state, 'data', file), join(site, 'data', file));
    copyFileSync(join(state, 'run.json'), join(site, '.outage-run.json'));
    commit(site, 'main', ['data', '.outage-run.json'], 'Update outage data');
    // Branch-based Pages starts automatically when main is pushed.
    // An additional POST /pages/builds would duplicate the same deployment.
    console.log('Published outage data to main');
    if (Object.keys(read(join(state, 'run.json')).errors).length) process.exitCode = 1;
} else {
    // Read the deployed snapshot, while acknowledgements use the latest state branch.
    if (!existsSync(join(site, '.outage-run.json'))) {
        console.log('No outage publication metadata in this deployment; skipping notifications');
        process.exit(0);
    }
    const data = loadData(site);
    const run = read(join(site, '.outage-run.json'));
    if (phase === 'notify' && run.notify === false) {
        console.log('Notifications disabled for this publication');
        process.exit(0);
    }
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
