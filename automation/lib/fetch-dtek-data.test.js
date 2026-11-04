const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const validHtml = '<script>DisconSchedule.fact = {"data":[],"today":1793224800};</script>';
const challengeHtml = '<html><title>Request unsuccessful</title>Incapsula incident ID</html>';

function runFetcher(responses) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dtek-fetch-test-'));
    try {
        fs.mkdirSync(path.join(cwd, 'bin'));
        fs.mkdirSync(path.join(cwd, 'data'));
        fs.writeFileSync(path.join(cwd, 'data/dtek-outages.json'), 'previous data');
        // A failed download must never cause a leftover valid response to be processed.
        fs.writeFileSync(path.join(cwd, 'raw-dtek-data.html'), validHtml);
        fs.writeFileSync(path.join(cwd, 'responses.json'), JSON.stringify(responses));
        fs.writeFileSync(path.join(cwd, 'bin/curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const responses = JSON.parse(fs.readFileSync('responses.json', 'utf8'));
const attempt = fs.existsSync('attempts') ? Number(fs.readFileSync('attempts', 'utf8')) : 0;
fs.writeFileSync('attempts', String(attempt + 1));
const response = responses[attempt];
if (!response) process.exit(99);
if (response.html !== undefined) fs.writeFileSync('raw-dtek-data.html', response.html);
process.exit(response.status || 0);
`, { mode: 0o755 });
        fs.writeFileSync(path.join(cwd, 'bin/sleep'), '#!/bin/sh\necho "$1" >> sleeps\n', { mode: 0o755 });
        const result = spawnSync('bash', [path.join(__dirname, 'fetch-dtek-data.sh')], {
            cwd, encoding: 'utf8',
            env: { ...process.env, PATH: `${path.join(cwd, 'bin')}:${process.env.PATH}` }
        });
        return {
            ...result,
            attempts: Number(fs.readFileSync(path.join(cwd, 'attempts'), 'utf8')),
            sleeps: fs.existsSync(path.join(cwd, 'sleeps'))
                ? fs.readFileSync(path.join(cwd, 'sleeps'), 'utf8').trim().split('\n') : [],
            output: fs.readFileSync(path.join(cwd, 'data/dtek-outages.json'), 'utf8'),
            html: fs.readFileSync(path.join(cwd, 'raw-dtek-data.html'), 'utf8')
        };
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}

test('retries HTTP 200 protection pages and publishes the next valid schedule', () => {
    const result = runFetcher([{ html: challengeHtml }, { html: validHtml }]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.sleeps, ['10']);
    assert.deepEqual(JSON.parse(result.output).days, []);
    assert.match(result.stderr, /possible bot-protection page/);
});

test('retries transport and HTTP errors before processing a successful download', () => {
    const result = runFetcher([{ status: 28 }, { status: 22 }, { html: validHtml }]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.sleeps, ['10', '10']);
    assert.deepEqual(JSON.parse(result.output).days, []);
});

test('stops after three unusable responses and retains previous data and the last response', () => {
    const invalidHtml = '<script>DisconSchedule.fact = {"data":null};</script>';
    const result = runFetcher([
        { html: challengeHtml }, { html: invalidHtml }, { html: challengeHtml }
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.sleeps, ['10', '10']);
    assert.equal(result.output, 'previous data');
    assert.equal(result.html, challengeHtml);
});

test('failed downloads never process leftover HTML', () => {
    const result = runFetcher([{ status: 28 }, { status: 28 }, { status: 28 }]);
    assert.equal(result.status, 1);
    assert.equal(result.attempts, 3);
    assert.equal(result.output, 'previous data');
    assert.doesNotMatch(result.stdout, /Processing DTEK data from downloaded HTML/);
});

test('HTTP 403 responses remain available for diagnostics without replacing published data', () => {
    const result = runFetcher(Array.from({ length: 3 }, () => ({ status: 22, html: challengeHtml })));
    assert.equal(result.status, 1);
    assert.equal(result.output, 'previous data');
    assert.equal(result.html, challengeHtml);
    assert.doesNotMatch(result.stdout, /Processing DTEK data from downloaded HTML/);
});

test('valid empty schedules succeed immediately without retrying', () => {
    const result = runFetcher([{ html: validHtml }]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.sleeps, []);
    assert.deepEqual(JSON.parse(result.output).days, []);
});
