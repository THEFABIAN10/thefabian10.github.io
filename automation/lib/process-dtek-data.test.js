const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractFactData, processData } = require('./process-dtek-data');

function scheduleHtml(fact) {
    return `<html><script>DisconSchedule.fact = ${JSON.stringify(fact)};\nDisconSchedule.other = {};</script></html>`;
}

function runProcessor(fact, html = scheduleHtml(fact)) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dtek-test-'));
    try {
        fs.mkdirSync(path.join(cwd, 'data'));
        fs.writeFileSync(path.join(cwd, 'data/dtek-outages.json'), 'previous data');
        fs.writeFileSync(path.join(cwd, 'raw-dtek-data.html'), html);
        // Leftover Puppeteer output must never override a fresh HTML response.
        fs.writeFileSync(path.join(cwd, 'dtek-raw-data.json'), JSON.stringify({ data: [], today: 1790802000 }));
        const result = spawnSync(process.execPath, [path.join(__dirname, 'process-dtek-data.js')], {
            cwd, encoding: 'utf8'
        });
        return { ...result, output: fs.readFileSync(path.join(cwd, 'data/dtek-outages.json'), 'utf8') };
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}

test('empty DTEK schedules successfully replace stale data', () => {
    for (const data of [[], {}]) {
        const result = runProcessor({ data, today: 1790802000, update: '24.07.2026 08:30' });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.output);
        assert.equal(output.source, 'DTEK');
        assert.deepEqual(output.days, []);
        assert.ok(Number.isFinite(Date.parse(output.lastUpdate)));
    }
});

test('malformed responses fail and preserve previous data', () => {
    for (const fact of [{}, { data: null }, { data: 'invalid', today: 1790802000 },
        { data: [1], today: 1790802000 }, { data: [] }]) {
        const result = runProcessor(fact);
        assert.notEqual(result.status, 0);
        assert.equal(result.output, 'previous data');
    }
});

test('existing populated schedule conversion still works', () => {
    const hours = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i + 1, 'yes']));
    Object.assign(hours, { 2: 'second', 3: 'no', 4: 'first' });
    const result = runProcessor({
        data: { 1770415200: { 'GPV1.1': hours } }, today: 1770415200
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.output).days[0].outages, [{ start: 90, end: 210 }]);
});

test('extracts nested JSON with escaped quotes and braces in strings', () => {
    const fact = { data: {}, today: 1790802000, update: 'text } "quoted" \\ { text' };
    assert.deepEqual(extractFactData(scheduleHtml(fact)), fact);
});

test('missing, truncated, and invalid HTML data preserve previous output', () => {
    for (const html of ['<html>Service unavailable</html>',
        '<script>DisconSchedule.fact = {"data":{',
        '<script>DisconSchedule.fact = {invalid};</script>',
        '<script>DisconSchedule.fact = null;</script>']) {
        const result = runProcessor({}, html);
        assert.notEqual(result.status, 0);
        assert.equal(result.output, 'previous data');
    }
});

test('missing schedule errors identify protection responses without dumping the HTML', () => {
    const html = '<html><title> Request\n unsuccessful </title>Incapsula incident ID: private details</html>';
    assert.throws(() => extractFactData(html), (error) => {
        assert.match(error.message, /Could not find DisconSchedule.fact/);
        assert.match(error.message, new RegExp(`${Buffer.byteLength(html)} bytes`));
        assert.match(error.message, /title: Request unsuccessful/);
        assert.match(error.message, /possible bot-protection page/);
        assert.doesNotMatch(error.message, /private details/);
        return true;
    });
});

test('parses the saved DTEK page with both days and all groups', () => {
    const html = fs.readFileSync(path.join(__dirname, 'dtek-page.html'), 'utf8');
    const result = runProcessor({}, html);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.output);
    assert.equal(output.days.length, 2);
    assert.deepEqual(output.days[0].outages, [
        { start: 90, end: 600 }, { start: 810, end: 1230 }, { start: 1320, end: 1440 }
    ]);
    assert.deepEqual(output.days[1].outages, []);
});

test('Kyiv dates and isToday handle summer and winter midnight', () => {
    const hours = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i + 1, 'yes']));
    for (const [midnight, now] of [
        ['2026-10-17T00:00:00+03:00', '2026-10-17T00:30:00+03:00'],
        ['2026-02-07T00:00:00+02:00', '2026-02-07T00:30:00+02:00']
    ]) {
        const timestamp = Date.parse(midnight) / 1000;
        const output = processData(scheduleHtml({
            data: { [timestamp]: { 'GPV1.1': hours } }, today: timestamp
        }), new Date(now));
        assert.equal(output.days[0].date, new Date(midnight).toISOString());
        assert.equal(output.days[0].isToday, true);
    }
});
