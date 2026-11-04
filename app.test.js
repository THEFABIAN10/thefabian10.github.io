const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const warning = {
    sub_type: 'Аварійні ремонтні роботи',
    start_date: '23:16 31.10.2026', end_date: '10:50 01.11.2026',
    lastUpdate: '2026-11-01T06:40:00Z', sourceUpdate: '08:31 01.11.2026'
};
const schedule = { days: [], lastUpdate: '2026-11-01T06:00:00Z' };

function element() {
    return {
        hidden: true, children: [], innerHTML: '', textContent: '',
        replaceChildren() { this.children = []; },
        append(child) { this.children.push(child); }
    };
}

function createApp(fetch, dataBaseUrl = '') {
    const content = element();
    const notice = element();
    const freshness = element();
    const context = vm.createContext({
        URLSearchParams,
        window: { location: { search: '' }, OUTAGE_DATA_BASE_URL: dataBaseUrl },
        fetch, console: { error() {} }, setInterval() {}, clearInterval() {},
        document: {
            hidden: true,
            getElementById: id => ({ content, 'dtek-notice': notice, 'data-freshness': freshness }[id]),
            createElement: element,
            addEventListener() {}, querySelectorAll: () => []
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context);
    return { context, content, notice, freshness };
}

const response = data => ({ ok: true, json: async () => data });
const settle = () => new Promise(resolve => setImmediate(resolve));
const noticeText = notice => notice.children.map(line => line.textContent).join('\n');

test('schedule download failure still displays the independent address warning', async () => {
    const { content, notice } = createApp(async url => {
        if (url.startsWith('data/dtek-address.json')) return response(warning);
        throw new Error('schedule unavailable');
    });
    await settle();
    assert.match(content.innerHTML, /Помилка завантаження/);
    assert.equal(notice.hidden, false);
    const text = noticeText(notice);
    assert.equal(notice.children[0].textContent, `⚠️ ${warning.sub_type}`);
    assert.equal(text.split(warning.sub_type).length - 1, 1);
    assert.match(text, /31\.10\.2026, 23:16/);
    assert.match(text, /01\.11\.2026, 10:50/);
    assert.match(text, /Інформацію оновлено:.*08:31/);
});

test('address download failure still renders the schedule', async () => {
    const { content, notice } = createApp(async url => {
        if (url.startsWith('data/dtek-address.json')) throw new Error('address unavailable');
        return response(schedule);
    });
    await settle();
    assert.match(content.innerHTML, /Інформація щодо графіків відсутня/);
    assert.equal(notice.hidden, true);
});

test('empty address fields remove a prior warning, including its update time', async () => {
    const { context, notice } = createApp(async url => response(
        url.startsWith('data/dtek-address.json') ? warning : schedule
    ));
    await settle();
    assert.equal(notice.hidden, false);
    context.emptyAddress = { sub_type: '', start_date: '', end_date: '', lastUpdate: warning.lastUpdate };
    vm.runInContext('renderDtekNotice(emptyAddress)', context);
    assert.equal(notice.hidden, true);
    assert.equal(notice.children.length, 0);
});

test('upstream message markup is rendered as literal text', async () => {
    const sub_type = '<img src=x onerror=alert(1)> Аварійні роботи';
    const { notice } = createApp(async url => response(
        url.startsWith('data/dtek-address.json') ? { ...warning, sub_type } : schedule
    ));
    await settle();
    assert.equal(notice.children[0].textContent, `⚠️ ${sub_type}`);
    assert.equal(notice.innerHTML, '');
});

test('switching to Yasno hides address warnings and ignores a late DTEK response', async () => {
    let finishAddress;
    const { context, content, notice } = createApp(async url => {
        if (url.startsWith('data/dtek-address.json')) {
            return new Promise(resolve => { finishAddress = resolve; });
        }
        return response(schedule);
    });
    vm.runInContext("switchDataSource('yasno')", context);
    await settle();
    finishAddress(response(warning));
    await settle();
    assert.equal(notice.hidden, true);
    assert.match(content.innerHTML, /Інформація щодо графіків відсутня/);
});

test('address warning is positioned before all schedule content in the page', () => {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    assert.ok(html.indexOf('id="dtek-notice"') < html.indexOf('id="content"'));
});


test('loads both DTEK endpoints from the configured Worker without falling back to old files', async () => {
    const urls = [];
    const { context } = createApp(async url => {
        urls.push(url);
        return response(url.includes('dtek-address') ? warning : schedule);
    }, 'https://norivka-outages.example.workers.dev/');
    await settle();
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.startsWith('https://norivka-outages.example.workers.dev/data/')));
    vm.runInContext("switchDataSource('yasno')", context);
    await settle();
    assert.ok(urls[2].startsWith('https://norivka-outages.example.workers.dev/data/outages.json?'));
});

for (const todayStatus of ['EmergencyShutdowns', 'ScheduleApplies', undefined]) {
    test(`Yasno renders one notice only for today's emergency: ${todayStatus}`, async () => {
        const data = { ...schedule, today: { status: todayStatus },
            tomorrow: { status: 'EmergencyShutdowns' } };
        const { context, notice } = createApp(async url => response(
            url.includes('dtek-address') ? warning : data));
        await settle();
        vm.runInContext("switchDataSource('yasno')", context);
        await settle();
        assert.equal(notice.hidden, todayStatus !== 'EmergencyShutdowns');
        if (todayStatus === 'EmergencyShutdowns') {
            assert.equal(noticeText(notice).split('Екстрені відключення').length - 1, 1);
            await vm.runInContext('loadSchedule()', context);
            assert.equal(notice.hidden, false);
            data.today.status = 'ScheduleApplies';
            await vm.runInContext('loadSchedule()', context);
            assert.equal(notice.hidden, true);
        }
    });
}

test('staleness checks the active provider and DTEK address independently at the 15-minute boundary', async () => {
    const timestamp = '2026-11-05T00:00:00Z';
    const { context, freshness, notice } = createApp(async url => response(url.includes('dtek-address')
        ? { ...warning, lastUpdate: timestamp } : { ...schedule, lastUpdate: timestamp }));
    await settle();
    vm.runInContext(`renderFreshness(Date.parse('${timestamp}') + 15 * 60000)`, context);
    assert.equal(freshness.hidden, true);
    vm.runInContext(`renderFreshness(Date.parse('${timestamp}') + 15 * 60000 + 1)`, context);
    assert.match(freshness.textContent, /Графік/);
    assert.match(notice.children.at(-1).textContent, /Дані не оновлювалися/);
    assert.doesNotMatch(noticeText(notice), /Адресна інформація:/);
    vm.runInContext(`freshness.dtek.schedule.lastUpdate = '2026-11-05T00:15:00Z'; renderFreshness(Date.parse('${timestamp}') + 16 * 60000)`, context);
    assert.doesNotMatch(freshness.textContent, /Графік/);
    assert.match(notice.children.at(-1).textContent, /Дані не оновлювалися/);
    assert.doesNotMatch(noticeText(notice), /Адресна інформація:/);
    await vm.runInContext("switchDataSource('yasno')", context);
    await settle();
    vm.runInContext(`renderFreshness(Date.parse('${timestamp}') + 16 * 60000)`, context);
    assert.doesNotMatch(freshness.textContent, /Адресна інформація/);
    assert.match(freshness.textContent, /Графік/);
});

test('temporary download failures retain the last schedule and show its actual age', async () => {
    let failing = false;
    const { context, content, freshness } = createApp(async url => {
        if (failing) throw new Error('offline');
        return response(url.includes('dtek-address') ? warning : {
            ...schedule, days: [{ date: '2026-11-01', isToday: true, outages: [{ start: 60, end: 120 }] }]
        });
    });
    await settle();
    assert.match(content.innerHTML, /01:00 — 02:00/);
    failing = true;
    await vm.runInContext('loadSchedule()', context);
    assert.match(content.innerHTML, /01:00 — 02:00/);
    assert.equal(freshness.hidden, false);
    assert.match(freshness.textContent, /понад 15 хвилин/);
});
