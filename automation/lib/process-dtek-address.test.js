const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { formatUpdateFact, processAddressData, extractCsrfHeader } = require('./process-dtek-address');

const address = {
    sub_type: 'Аварійні ремонтні роботи',
    start_date: '23:16 31.10.2026',
    end_date: '10:50 01.11.2026'
};
const validResponse = JSON.stringify({ result: true, data: { '1': address } });
const sessionPage = '<meta name="csrf-token" content="test-token">';

function inTempDirectory(callback) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dtek-address-test-'));
    try {
        fs.mkdirSync(path.join(cwd, 'data'));
        fs.writeFileSync(path.join(cwd, 'data/dtek-address.json'), 'previous address');
        fs.writeFileSync(path.join(cwd, 'data/dtek-outages.json'), 'previous schedule');
        return callback(cwd);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}

test('updateFact uses Kyiv midnight across UTC date boundaries, seasons and DST changes', () => {
    for (const [instant, expected] of [
        ['2026-10-31T22:30:00Z', '01.11.2026 00:00'],
        ['2026-07-01T21:30:00Z', '02.07.2026 00:00'],
        ['2026-12-31T22:30:00Z', '01.01.2027 00:00'],
        ['2026-03-29T01:30:00Z', '29.03.2026 00:00'],
        ['2026-10-25T01:30:00Z', '25.10.2026 00:00']
    ]) assert.equal(formatUpdateFact(new Date(instant)), expected);
});

test('only house 1 and requested fields are published, with independent timestamps', () => {
    const now = new Date('2026-11-01T06:40:00Z');
    assert.deepEqual(processAddressData({
        result: true, updateTimestamp: '08:31 01.11.2026',
        data: { '1': { ...address, type: '2' }, '2': { ...address, sub_type: 'wrong' }, '16': {} }
    }, now), {
        source: 'DTEK', lastUpdate: now.toISOString(), sourceUpdate: '08:31 01.11.2026', ...address
    });
    assert.throws(() => processAddressData({ data: { '2': address } }), /house 1/);
});

test('valid empty fields clear old address warnings without changing schedules', () => {
    inTempDirectory(cwd => {
        fs.writeFileSync(path.join(cwd, 'raw-dtek-address.json'), JSON.stringify({
            result: true, data: { '1': { sub_type: ' ', start_date: null, end_date: '' } }
        }));
        const result = spawnSync(process.execPath, [path.join(__dirname, 'process-dtek-address.js')], {
            cwd, encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(fs.readFileSync(path.join(cwd, 'data/dtek-address.json'), 'utf8'));
        assert.equal(output.sub_type, '');
        assert.equal(output.start_date, '');
        assert.equal(output.end_date, '');
        assert.equal(fs.readFileSync(path.join(cwd, 'data/dtek-outages.json'), 'utf8'), 'previous schedule');
    });
});

test('protection pages, missing houses and malformed responses preserve published data', () => {
    for (const raw of ['<html>Incapsula</html>', '{}', '{"data":[]}',
        JSON.stringify({ data: { '1': {} } }),
        JSON.stringify({ result: false, data: { '1': address } }),
        JSON.stringify({ data: { '1': { ...address, start_date: 1 } } })]) {
        inTempDirectory(cwd => {
            fs.writeFileSync(path.join(cwd, 'raw-dtek-address.json'), raw);
            const result = spawnSync(process.execPath, [path.join(__dirname, 'process-dtek-address.js')], {
                cwd, encoding: 'utf8'
            });
            assert.notEqual(result.status, 0);
            assert.equal(fs.readFileSync(path.join(cwd, 'data/dtek-address.json'), 'utf8'), 'previous address');
        });
    }
});

test('session tokens are extracted regardless of meta attribute order; protection pages fail', () => {
    assert.equal(extractCsrfHeader(sessionPage), 'X-CSRF-Token: test-token');
    assert.equal(extractCsrfHeader("<meta content='other-token' name='csrf-token'>"), 'X-CSRF-Token: other-token');
    assert.throws(() => extractCsrfHeader('<html>Incapsula</html>'), /CSRF/);
    assert.throws(() => extractCsrfHeader('<meta name="csrf-token" content="a\r\nb">'), /CSRF/);
});

function runFetcher(responses) {
    return inTempDirectory(cwd => {
        fs.mkdirSync(path.join(cwd, 'bin'));
        fs.writeFileSync(path.join(cwd, 'raw-dtek-address.json'), validResponse);
        fs.writeFileSync(path.join(cwd, 'responses.json'), JSON.stringify(responses));
        fs.writeFileSync(path.join(cwd, 'bin/curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json', 'utf8')) : [];
const response = JSON.parse(fs.readFileSync('responses.json', 'utf8'))[calls.length];
const headerFile = args.find(arg => arg.startsWith('@'));
calls.push({args, headers: headerFile ? fs.readFileSync(headerFile.slice(1), 'utf8') : ''});
fs.writeFileSync('calls.json', JSON.stringify(calls));
if (!response) process.exit(99);
if (response.body !== undefined) fs.writeFileSync(args[args.indexOf('--output') + 1], response.body);
if (args.includes('--cookie-jar')) fs.writeFileSync(args[args.indexOf('--cookie-jar') + 1], 'session-cookie');
process.exit(response.status || 0);
`, { mode: 0o755 });
        fs.writeFileSync(path.join(cwd, 'bin/sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const result = spawnSync('bash', [path.join(__dirname, 'fetch-dtek-address.sh')], {
            cwd, encoding: 'utf8',
            env: { ...process.env, PATH: `${path.join(cwd, 'bin')}:${process.env.PATH}` }
        });
        return {
            ...result,
            calls: JSON.parse(fs.readFileSync(path.join(cwd, 'calls.json'), 'utf8')),
            output: fs.readFileSync(path.join(cwd, 'data/dtek-address.json'), 'utf8'),
            session: fs.existsSync(path.join(cwd, 'raw-dtek-address-session.html'))
                ? fs.readFileSync(path.join(cwd, 'raw-dtek-address-session.html'), 'utf8') : null,
            schedule: fs.readFileSync(path.join(cwd, 'data/dtek-outages.json'), 'utf8')
        };
    });
}

test('address fetch creates its own session and sends CSRF, cookies, AJAX headers and form data', () => {
    const result = runFetcher([{ body: sessionPage }, { body: validResponse }]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 2);
    assert.ok(result.calls[0].args.includes('https://www.dtek-dnem.com.ua/ua/shutdowns/'));
    const { args, headers } = result.calls[1];
    for (const expected of [
        'https://www.dtek-dnem.com.ua/ua/ajax', '--cookie',
        'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With: XMLHttpRequest', 'method=getHomeNum',
        'data[0][name]=city', 'data[0][value]=с. Любимівка',
        'data[1][name]=street', 'data[1][value]=вул. Центральна',
        'data[2][name]=updateFact', `data[2][value]=${formatUpdateFact()}`
    ]) assert.ok(args.includes(expected), expected);
    assert.equal(headers.trim(), 'X-CSRF-Token: test-token');
    assert.equal(JSON.parse(result.output).sub_type, address.sub_type);
    assert.equal(result.schedule, 'previous schedule');
});

test('retries both protected session pages and protected AJAX responses', () => {
    const result = runFetcher([
        { body: '<html>Incapsula</html>' },
        { body: sessionPage }, { body: '<html>Incapsula</html>' },
        { body: sessionPage }, { body: validResponse }
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 5);
    assert.ok(result.calls[1].args.some(arg => arg.includes('/ua/shutdowns/?t=')));
    assert.equal(JSON.parse(result.output).sub_type, address.sub_type);
});

test('failed AJAX downloads never process a leftover successful response', () => {
    const result = runFetcher(Array.from({ length: 3 }, () => [
        { body: sessionPage }, { status: 28 }
    ]).flat());
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 6);
    assert.equal(result.output, 'previous address');
    assert.equal(result.schedule, 'previous schedule');
});

test('HTTP 403 session responses are retained for diagnostics and never processed as address data', () => {
    const html = '<html>Forbidden</html>';
    const result = runFetcher(Array.from({ length: 3 }, () => ({ status: 22, body: html })));
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 3);
    assert.equal(result.session, html);
    assert.equal(result.output, 'previous address');
    assert.equal(result.schedule, 'previous schedule');
    assert.ok(result.calls.every(call => call.args.includes('--fail-with-body')));
});
