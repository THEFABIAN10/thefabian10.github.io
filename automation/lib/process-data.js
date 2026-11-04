const fs = require('fs');

try {
    const rawData = JSON.parse(fs.readFileSync('raw-data.json', 'utf8'));
    
    // Get the element "1.1"
    const element = rawData?.['1.1'];
    
    if (!element) {
        console.error('Element 1.1 not found');
        process.exit(1);
    }

    const days = [];
    if (element.today) days.push({...element.today, isToday: true });
    if (element.tomorrow) days.push({ ...element.tomorrow, isToday: false });

    if (days.length === 0) {
        console.error('No days found in element 1.1');
        process.exit(1);
    }

    const processedDays = days.filter(day => day.status === "ScheduleApplies").map(day => {
        // Filter slots with type="Definite"
        const definiteSlots = (day.slots || [])
            .filter(slot => slot.type === 'Definite')
            .map(slot => ({
                start: slot.start,
                end: slot.end
            }))
            .sort((a, b) => a.start - b.start);

        return {
            date: day.date,
            isToday: day.isToday,
            outages: definiteSlots
        };
    });

    const output = {
        lastUpdate: new Date().toISOString(),
        days: processedDays
    };

    // Ensure data directory exists
    if (!fs.existsSync('data')) {
        fs.mkdirSync('data', { recursive: true });
    }

    fs.writeFileSync('data/outages.json', JSON.stringify(output, null, 2));
    console.log('Successfully processed outages data');
    console.log(`Days processed: ${processedDays.length}`);
    processedDays.forEach(day => {
        console.log(`  ${day.date}: ${day.outages.length} outages`);
    });

} catch (error) {
    console.error('Error processing data:', error);
    process.exit(1);
}
