
function formatUpdateFact(now = new Date()) {
    const parts = new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.day}.${values.month}.${values.year} 00:00`;
}

function processAddressData(response, now = new Date()) {
    const address = response?.data?.['1'];
    const fields = ['sub_type', 'start_date', 'end_date'];
    if (response?.result === false || !address || typeof address !== 'object' || Array.isArray(address) ||
        fields.some(field => !Object.hasOwn(address, field) ||
            (address[field] !== null && typeof address[field] !== 'string'))) {
        throw new Error('Invalid DTEK address response: expected fields for house 1');
    }

    return {
        source: 'DTEK',
        lastUpdate: now.toISOString(),
        ...(typeof response.updateTimestamp === 'string' && response.updateTimestamp.trim()
            ? { sourceUpdate: response.updateTimestamp.trim() } : {}),
        sub_type: (address.sub_type ?? '').trim(),
        start_date: (address.start_date ?? '').trim(),
        end_date: (address.end_date ?? '').trim()
    };
}

function extractCsrfHeader(html) {
    const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of metaTags) {
        if (!/\bname\s*=\s*["']csrf-token["']/i.test(tag)) continue;
        const token = /\bcontent\s*=\s*["']([^"'\r\n]+)["']/i.exec(tag)?.[1];
        if (token) return `X-CSRF-Token: ${token}`;
    }
    throw new Error('No CSRF token in DTEK session page (possible bot-protection page)');
}

if (require.main === module) {
    const fs = require('node:fs');
    try {
        if (process.argv[2] === '--update-fact') {
            console.log(formatUpdateFact());
        } else if (process.argv[2] === '--csrf-header') {
            console.log(extractCsrfHeader(fs.readFileSync(process.argv[3], 'utf8')));
        } else {
            const response = JSON.parse(fs.readFileSync('raw-dtek-address.json', 'utf8'));
            const output = processAddressData(response);
            fs.mkdirSync('data', { recursive: true });
            fs.writeFileSync('data/dtek-address.json', JSON.stringify(output, null, 2));
            console.log('Successfully processed DTEK address information for house 1');
        }
    } catch (error) {
        console.error('Error processing DTEK address information:', error.message);
        process.exit(1);
    }
}

module.exports = { formatUpdateFact, processAddressData, extractCsrfHeader };
