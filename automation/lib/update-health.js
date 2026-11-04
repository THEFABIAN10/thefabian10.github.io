const MAX_AGE_MS = 20 * 60 * 1000;
function assessUpdateHealth(runs, files, now = Date.now()) {
    const errors = [];
    const latest = runs[0];
    const created = Date.parse(latest?.created_at);
    if (!Number.isFinite(created) || now - created > MAX_AGE_MS) errors.push('No update workflow started in the last 20 minutes; check the Worker cron and GitHub token.');
    const completed = runs.filter(run => run.status === 'completed').slice(0, 3);
    if (completed.length === 3 && completed.every(run => run.conclusion !== 'success')) {
        errors.push('The last three completed update runs were unsuccessful.');
    }
    for (const [name, value] of Object.entries(files)) {
        const updated = Date.parse(value?.lastUpdate);
        if (!Number.isFinite(updated) || updated > now + 60000 || now - updated > MAX_AGE_MS) {
            errors.push(`${name}: public data is missing a valid recent timestamp or is more than 20 minutes old.`);
        }
    }
    return errors;
}
module.exports = { assessUpdateHealth };
