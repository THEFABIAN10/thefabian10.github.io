
function extractFactData(html) {
    const assignment = /\bDisconSchedule\.fact\s*=\s*/.exec(html);
    if (!assignment) {
        const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]
            .replace(/\s+/g, ' ').trim().slice(0, 160);
        const protectionPage = /incapsula|cf-chl-|challenge-platform/i.test(html);
        const details = [
            `${Buffer.byteLength(html, 'utf8')} bytes`,
            title && `title: ${title}`,
            protectionPage && 'possible bot-protection page'
        ].filter(Boolean).join('; ');
        throw new Error(`Could not find DisconSchedule.fact in the DTEK response (${details})`);
    }

    const start = assignment.index + assignment[0].length;
    if (html[start] !== '{') {
        throw new Error('Invalid DisconSchedule.fact JSON');
    }

    // Match the complete JSON object, including nested schedules and quoted braces.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
        const char = html[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
        } else if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth++;
        } else if (char === '}' && --depth === 0) {
            return JSON.parse(html.slice(start, i + 1));
        }
    }
    throw new Error('Incomplete DisconSchedule.fact JSON');
}

function ukraineDate(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

function convertHourValueToOutage(hourValue, hourIndex) {
    // Convert hour-based values to minute-based outage intervals
    // hourIndex is 1-based (1-24 representing hours of the day)

    const hourStartMinutes = (hourIndex - 1) * 60;
    const hourEndMinutes = hourIndex * 60;
    const hourMidpoint = hourStartMinutes + 30;

    switch (hourValue) {
        case 'yes':
            return []; // No outages
        case 'no':
            return [{ start: hourStartMinutes, end: hourEndMinutes }]; // Outage for entire hour
        case 'first':
            return [{ start: hourStartMinutes, end: hourMidpoint }]; // Outage for first half hour
        case 'second':
            return [{ start: hourMidpoint, end: hourEndMinutes }]; // Outage for second half hour
        default:
            return []; // Default to no outages for unknown values
    }
}

function processDayData(gpvData, timestamp, isToday) {
    const outages = [];

    // Process each hour (1-24)
    for (let hour = 1; hour <= 24; hour++) {
        const hourValue = gpvData[hour.toString()];
        if (hourValue && hourValue !== 'yes') {
            const hourOutages = convertHourValueToOutage(hourValue, hour);
            outages.push(...hourOutages);
        }
    }

    // Merge consecutive outages
    const mergedOutages = [];
    if (outages.length > 0) {
        let current = { ...outages[0] };

        for (let i = 1; i < outages.length; i++) {
            if (outages[i].start === current.end) {
                // Consecutive outage, extend current
                current.end = outages[i].end;
            } else {
                // Non-consecutive, save current and start new
                mergedOutages.push(current);
                current = { ...outages[i] };
            }
        }
        mergedOutages.push(current); // Add the last outage
    }

    return {
        // Preserve the actual instant: Kyiv uses UTC+3 during daylight saving time.
        date: new Date(timestamp * 1000).toISOString(),
        isToday: isToday,
        outages: mergedOutages
    };
}

function processData(data, now = new Date()) {
    const factData = extractFactData(data);

    // Get the GPV1.1 data
    const gpvData = factData.data;
    const todayTimestamp = factData.today;

    // DTEK legitimately publishes data: [] when no schedule is available.
    // Reject malformed payloads, but publish an empty days list for that case.
    if (!gpvData || typeof gpvData !== 'object' ||
        (Array.isArray(gpvData) && gpvData.length > 0) ||
        !Number.isFinite(todayTimestamp) || todayTimestamp <= 0) {
        throw new Error('Invalid DTEK schedule response');
    }

    const currentDateStr = ukraineDate(now);

    console.log('Current Ukraine date (for isToday logic):', currentDateStr);

    const processedDays = [];

    // Process available days (today and possibly tomorrow)
    Object.keys(gpvData).forEach((timestamp) => {
        const dayData = gpvData[timestamp];

        // Check if GPV1.1 exists for this day
        if (dayData && dayData['GPV1.1']) {
            // Calculate the actual date for this timestamp in Ukraine timezone
            const dayDate = new Date(parseInt(timestamp) * 1000);
            const dayDateStr = ukraineDate(dayDate);

            const isToday = dayDateStr === currentDateStr;
            console.log(`Day ${dayDateStr} isToday: ${isToday}`);

            const processedDay = processDayData(dayData['GPV1.1'], parseInt(timestamp), isToday);
            processedDays.push(processedDay);
        }
    });

    const output = {
        source: 'DTEK',
        lastUpdate: now.toISOString(),
        days: processedDays
    };

    return output;
}

if (require.main === module) {
    const fs = require('node:fs');
    try {
        console.log('Processing DTEK data from downloaded HTML...');

        // Read the HTML file fetched directly from DTEK.
        const data = fs.readFileSync('raw-dtek-data.html', 'utf8');

        // Process the data
        const output = processData(data);

        // Ensure data directory exists
        if (!fs.existsSync('data')) {
            fs.mkdirSync('data', { recursive: true });
        }

        fs.writeFileSync('data/dtek-outages.json', JSON.stringify(output, null, 2));
        console.log('Successfully processed DTEK outages data');
        console.log(`Days processed: ${output.days.length}`);
        output.days.forEach(day => {
            console.log(`  ${day.date}: ${day.outages.length} outages`);
        });

    } catch (error) {
        console.error('Error processing DTEK data:', error.message);
        process.exitCode = 1;
    }
}

module.exports = { extractFactData, processData };
