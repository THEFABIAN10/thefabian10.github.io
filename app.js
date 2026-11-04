const DATA_BASE_URL = (window.OUTAGE_DATA_BASE_URL || '').replace(/\/$/, '');
const dataUrl = path => DATA_BASE_URL ? `${DATA_BASE_URL}/${path}` : path;
const DATA_URLS = {
    yasno: 'data/outages.json',
    dtek: 'data/dtek-outages.json'
};
const DTEK_ADDRESS_URL = 'data/dtek-address.json';

const requestedSource = new URLSearchParams(window.location.search).get('source');
let currentDataSource = Object.hasOwn(DATA_URLS, requestedSource) ? requestedSource : 'dtek';
let currentData = null;
const FOREGROUND_CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes when app is visible

function formatTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function calculateDuration(start, end) {
    const durationMinutes = end - start;
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;
    
    if (hours > 0 && mins > 0) {
        return `${hours} год ${mins} хв`;
    } else if (hours > 0) {
        return `${hours} год`;
    } else {
        return `${mins} хв`;
    }
}

function getCurrentTime() {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return minutes;
}

function renderSchedule(data) {
    const content = document.getElementById('content');
    
    const currentMinutes = getCurrentTime();
    let html = '';

    // Check if there's valid data to display
    if (!data || !data.days || data.days.length === 0) {
        html = '<div class="status warning">Інформація щодо графіків відсутня</div>';
    } else {
        data.days.forEach(day => {
            // Skip tomorrow's section if it has no outages
            if (!day.isToday && day.outages.length === 0) {
                return;
            }

            const date = new Date(day.date);
            const dateStr = date.toLocaleDateString('uk-UA', {
                weekday: 'long',
                day: 'numeric',
                month: 'long'
            });

            html += `<div class="day-section">`;
            html += `<div class="day-title">${dateStr}</div>`;

            if (day.outages.length === 0) {
                html += '<div class="status warning">Інформація щодо графіків відсутня</div>';
            } else {
                day.outages.forEach(outage => {
                    const isActive = day.isToday && currentMinutes >= outage.start && currentMinutes < outage.end;
                    const activeClass = isActive ? ' style="border-left-color: #ff6b6b; background: #fff5f5;"' : '';
                    
                    html += `<div class="outage-item"${activeClass}>`;
                    html += `<div class="outage-time">`;
                    if (isActive) html += '🔴 ';
                    html += `${formatTime(outage.start)} — ${formatTime(outage.end)}`;
                    html += `</div>`;
                    html += `<div class="outage-duration">Тривалість: ${calculateDuration(outage.start, outage.end)}</div>`;
                    html += `</div>`;
                });
            }

            html += `</div>`;
        });
    }

    // Always show last update time if available
    if (data && data.lastUpdate) {
        const updateTime = new Date(data.lastUpdate).toLocaleString('uk-UA');
        html += `<div class="last-update">Останнє оновлення: ${updateTime}</div>`;
    }

    content.innerHTML = html;
}

function formatAddressDate(value) {
    // Both formats represent local Kyiv time, without a UTC offset.
    const timeFirst = /^(\d{2}:\d{2}) (\d{2}\.\d{2}\.\d{4})$/.exec(value);
    if (timeFirst) value = `${timeFirst[2]} ${timeFirst[1]}`;
    const match = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
    if (!match) return value;
    const [, day, month, year, hour, minute] = match;
    return `${day}.${month}.${year}, ${hour}:${minute}`;
}

function renderDtekNotice(data) {
    const notice = document.getElementById('dtek-notice');
    notice.replaceChildren();
    const fields = [data?.sub_type, data?.start_date, data?.end_date];
    notice.hidden = !fields.some(value => typeof value === 'string' && value.trim());
    if (notice.hidden) return;

    function addLine(text, className) {
        const line = document.createElement('div');
        line.textContent = text;
        if (className) line.className = className;
        notice.append(line);
    }

    addLine(`⚠️ ${data.sub_type || 'Відключення електроенергії'}`, 'address-notice-title');
    if (data.start_date) addLine(`Початок: ${formatAddressDate(data.start_date)}`);
    if (data.end_date) addLine(`Завершення: ${formatAddressDate(data.end_date)}`);
    if (data.lastUpdate) {
        const updated = data.sourceUpdate ? formatAddressDate(data.sourceUpdate) :
            new Date(data.lastUpdate).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
        addLine(`Інформацію оновлено: ${updated}`, 'last-update');
    }
}

async function loadDtekNotice(source) {
    if (source !== 'dtek') return;
    try {
        const response = await fetch(dataUrl(DTEK_ADDRESS_URL) + '?t=' + Date.now());
        if (!response.ok) throw new Error('Failed to load DTEK address information');
        const data = await response.json();
        if (source === currentDataSource) renderDtekNotice(data);
    } catch (error) {
        console.error('Error loading DTEK address information:', error);
    }
}

async function loadScheduleData(source) {
    try {
        const response = await fetch(dataUrl(DATA_URLS[source]) + '?t=' + Date.now());
        if (!response.ok) {
            throw new Error('Failed to load data');
        }
        
        const data = await response.json();
        if (source !== currentDataSource) return;
        currentData = data;
        renderSchedule(data);
        if (source === 'yasno') {
            renderDtekNotice(data.today?.status === 'EmergencyShutdowns'
                ? { sub_type: 'Екстрені відключення', lastUpdate: data.lastUpdate } : null);
        }
        updateDataSourceIndicator(source);
        
    } catch (error) {
        console.error('Error loading schedule:', error);
        if (source !== currentDataSource) return;
        document.getElementById('content').innerHTML = 
            '<div class="error">Помилка завантаження даних. Спробуйте пізніше.</div>';
    }
}

async function loadSchedule(source = currentDataSource) {
    await Promise.allSettled([loadScheduleData(source), loadDtekNotice(source)]);
}

function updateDataSourceIndicator(source) {
    const indicator = document.getElementById('data-source-indicator');
    if (indicator) {
        const sourceNames = {
            yasno: 'ЯСНО',
            dtek: 'ДТЕК'
        };
        indicator.textContent = `Джерело: ${sourceNames[source]}`;
    }
}

function switchDataSource(source) {
    if (source !== currentDataSource && DATA_URLS[source]) {
        currentDataSource = source;
        renderDtekNotice(null);
        loadSchedule(source);
        
        // Update button states
        document.querySelectorAll('.source-switcher button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.source === source);
        });
    }
}

// Initialize
document.querySelectorAll('.source-switcher button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.source === currentDataSource);
});
loadSchedule();

// Poll for updates when app is visible
let visibilityCheckInterval;

function startVisibilityPolling() {
    if (!document.hidden) {
        visibilityCheckInterval = setInterval(() => {
            if (!document.hidden) {
                loadSchedule();
            }
        }, FOREGROUND_CHECK_INTERVAL);
    }
}

// Start/stop polling based on page visibility
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        clearInterval(visibilityCheckInterval);
    } else {
        loadSchedule(); // Load immediately when page becomes visible
        startVisibilityPolling();
    }
});

// Start polling if page is initially visible
startVisibilityPolling();
