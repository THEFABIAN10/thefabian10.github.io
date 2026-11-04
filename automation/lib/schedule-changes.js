// Compare schedule contents, ignoring fetch timestamps and the rolling isToday flag.
function scheduleSnapshot(data) {
    if (!data || !Array.isArray(data.days)) {
        throw new Error('Invalid schedule');
    }

    return data.days.map(day => {
        const date = new Date(day.date);
        if (!Number.isFinite(date.getTime()) || !Array.isArray(day.outages)) {
            throw new Error('Invalid schedule day');
        }
        return {
            date: new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(date),
            outages: day.outages.map(({ start, end }) => {
                if (!Number.isInteger(start) || !Number.isInteger(end) ||
                    start < 0 || end > 1440 || start >= end) {
                    throw new Error('Invalid outage interval');
                }
                return { start, end };
            }).sort((a, b) => a.start - b.start || a.end - b.end)
        };
    }).sort((a, b) => a.date.localeCompare(b.date));
}

function changedScheduleDates(previous, next) {
    if (previous === null) return [];
    const before = new Map(previous.map(day => [day.date, JSON.stringify(day.outages)]));
    const after = new Map(next.map(day => [day.date, JSON.stringify(day.outages)]));
    return [...new Set([...before.keys(), ...after.keys()])]
        .filter(date => before.get(date) !== after.get(date)).sort();
}

function scheduleChangeKind(previous, next, today) {
    // Empty days carry no planned outages; expired days disappear as time passes.
    const relevantDays = days => days.filter(day => day.date >= today && day.outages.length > 0);
    const before = relevantDays(previous);
    const after = relevantDays(next);
    const changed = changedScheduleDates(before, after);
    if (changed.length === 0) return null;
    if (after.length === 0) return 'cancelled';
    if (before.length === 0) return 'published';

    // Publishing tomorrow is still a publication when today's schedule exists.
    const previousDates = new Set(before.map(day => day.date));
    if (changed.every(date => !previousDates.has(date))) return 'published';
    return 'changed';
}

function addressNotice(data) {
    if (data == null) return { sub_type: '', start_date: '', end_date: '' };
    const fields = ['sub_type', 'start_date', 'end_date'];
    if (fields.some(field => typeof data[field] !== 'string')) {
        throw new Error('Invalid DTEK address notice');
    }
    return Object.fromEntries(fields.map(field => [field, data[field].replace(/\s+/g, ' ').trim()]));
}

function isNotifiableAddressNotice(notice) {
    return Object.values(notice).some(Boolean);
}

function isStabilizationNotice(notice) {
    return /^стабілізаційне відключення/iu.test(notice.sub_type);
}

function addressChangeKind(previous, next) {
    if (!isNotifiableAddressNotice(next)) return null;
    if (!isNotifiableAddressNotice(previous) ||
        isStabilizationNotice(previous) !== isStabilizationNotice(next)) return 'appeared';
    if (isStabilizationNotice(next)) return null;
    if (Object.keys(next).some(field => next[field] !== previous[field])) return 'changed';
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scheduleSnapshot, changedScheduleDates, scheduleChangeKind, addressNotice, isNotifiableAddressNotice, isStabilizationNotice, addressChangeKind };
}
