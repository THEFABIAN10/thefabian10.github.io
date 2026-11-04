const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(`${__dirname}/push-notifications.js`, 'utf8');

async function setup({
    ios = false, standalone = false, permission = 'default', failSDK = false,
    registered = permission === 'granted', registrationSucceeds = true, deferRegistration = false
} = {}) {
    const button = {
        disabled: true, attributes: {}, handlers: {},
        setAttribute(key, value) { this.attributes[key] = value; },
        addEventListener(name, handler) { this.handlers[name] = handler; }
    };
    const status = { textContent: '' };
    const notification = { permission };
    const calls = { init: 0, optIn: 0, optOut: 0, requestPermission: 0, fetch: 0, scripts: 0 };
    const timers = new Map();
    let timerId = 0;
    const subscriptionListeners = {};
    const permissionListeners = {};
    const subscription = {
        id: registered ? 'test-subscription-id' : null,
        token: registered ? 'test-push-token' : null,
        optedIn: permission === 'granted',
        addEventListener: (name, handler) => { subscriptionListeners[name] = handler; },
        async optIn() {
            calls.optIn++;
            subscription.optedIn = true;
            subscriptionListeners.change();
        },
        async optOut() {
            calls.optOut++;
            subscription.optedIn = false;
            subscriptionListeners.change();
        }
    };
    const sdk = {
        init: async options => { calls.init++; calls.options = options; },
        Notifications: {
            permission: permission === 'granted',
            async requestPermission() {
                calls.requestPermission++;
                notification.permission = 'granted';
                sdk.Notifications.permission = true;
                if (!registrationSucceeds) return false;
                if (!deferRegistration) {
                    subscription.id = 'test-subscription-id';
                    subscription.token = 'test-push-token';
                    subscriptionListeners.change();
                }
                return true;
            },
            isPushSupported: () => true,
            addEventListener: (name, handler) => { permissionListeners[name] = handler; }
        },
        User: { PushSubscription: subscription }
    };
    let ready;
    const window = {
        Notification: notification, isSecureContext: true,
        matchMedia: () => ({ matches: standalone }), addEventListener() {}
    };
    const context = vm.createContext({
        window, Notification: notification,
        navigator: { userAgent: ios ? 'iPhone' : 'test browser', serviceWorker: {} },
        fetch: async () => {
            calls.fetch++;
            return { ok: true, json: async () => ({ appId: 'public-app-id' }) };
        },
        document: {
            getElementById: id => id === 'notification-toggle' ? button : status,
            createElement: () => ({}),
            head: { appendChild(script) {
                calls.scripts++;
                if (failSDK) script.onerror();
                else ready = window.OneSignalDeferred[0](sdk);
            } }
        },
        console: { error() {} },
        setTimeout(handler, delay) { timers.set(++timerId, { handler, delay }); return timerId; },
        clearTimeout(id) { timers.delete(id); }
    });
    await vm.runInContext(code, context);
    await ready;
    return { button, status, calls, subscription, notification, sdk, permissionListeners, subscriptionListeners, timers };
}

test('permission is requested only on a click; subscribing and unsubscribing update the UI', async () => {
    const { calls, button, status } = await setup();
    assert.equal(calls.init, 1);
    assert.equal(calls.optIn, 0);
    assert.equal(calls.options.welcomeNotification.disable, true);
    assert.equal(calls.options.promptOptions.slidedown.prompts[0].autoPrompt, false);
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, '');
    await button.handlers.click();
    assert.equal(calls.optIn, 1);
    assert.equal(calls.requestPermission, 1);
    assert.equal(button.attributes['aria-pressed'], 'true');
    assert.equal(status.textContent, '');
    assert.equal(button.textContent, '🔕 Вимкнути сповіщення');
    await button.handlers.click();
    assert.equal(calls.optOut, 1);
    assert.equal(button.attributes['aria-pressed'], 'false');
    assert.equal(status.textContent, '');
});

test('granted permission and optedIn without a subscription never show success and can be repaired', async () => {
    const app = await setup({ permission: 'granted', registered: false });
    assert.equal(app.button.attributes['aria-pressed'], 'false');
    assert.equal(app.button.textContent, '🔔 Увімкнути сповіщення');
    await app.button.handlers.click();
    assert.equal(app.calls.requestPermission, 1);
    assert.equal(app.calls.optOut, 0);
    assert.equal(app.button.textContent, '🔕 Вимкнути сповіщення');
    assert.equal(app.button.attributes['aria-pressed'], 'true');
});

test('failed registration after permission shows an error rather than a subscribed button', async () => {
    const app = await setup({ permission: 'granted', registered: false, registrationSucceeds: false });
    await app.button.handlers.click();
    assert.equal(app.button.attributes['aria-pressed'], 'false');
    assert.equal(app.button.disabled, false);
    assert.match(app.status.textContent, /Не вдалося змінити підписку/);
});

test('stale stored subscription data does not skip requesting browser permission', async () => {
    const app = await setup({ registered: true, permission: 'default' });
    await app.button.handlers.click();
    assert.equal(app.calls.requestPermission, 1);
    assert.equal(app.button.attributes['aria-pressed'], 'true');
});

test('unsubscribe errors remain visible while preserving the actual subscribed state', async () => {
    const app = await setup({ permission: 'granted' });
    app.subscription.optOut = async () => { throw new Error('opt-out failed'); };
    await app.button.handlers.click();
    assert.equal(app.button.attributes['aria-pressed'], 'true');
    assert.equal(app.button.disabled, false);
    assert.match(app.status.textContent, /Не вдалося змінити підписку/);
});

test('waits for the Subscription ID and token before confirming an asynchronous registration', async () => {
    const app = await setup({ deferRegistration: true });
    await app.button.handlers.click();
    assert.equal(app.button.attributes['aria-pressed'], 'false');
    assert.equal(app.button.disabled, true);
    assert.equal(app.status.textContent, 'Завершення підписки…');
    app.subscription.id = 'confirmed-subscription-id';
    app.subscription.token = 'confirmed-push-token';
    app.subscriptionListeners.change();
    assert.equal(app.button.attributes['aria-pressed'], 'true');
    assert.equal(app.button.disabled, false);
    assert.equal(app.status.textContent, '');
    assert.equal(app.timers.size, 0);
});

test('registration timeout enables retry without claiming success', async () => {
    const app = await setup({ deferRegistration: true });
    await app.button.handlers.click();
    const timeout = [...app.timers.values()].find(timer => timer.delay === 15000);
    timeout.handler();
    assert.equal(app.button.disabled, false);
    assert.equal(app.button.attributes['aria-pressed'], 'false');
    assert.match(app.status.textContent, /OneSignal не підтвердив підписку/);
});

test('denied permission explains site settings and prevents another prompt', async () => {
    const { button, status, calls } = await setup({ permission: 'denied' });
    assert.equal(button.disabled, true);
    assert.match(status.textContent, /заблоковані/);
    assert.equal(calls.optIn, 0);
});

test('iOS tab shows installation instructions; a home screen app enables subscription', async () => {
    const tab = await setup({ ios: true });
    assert.equal(tab.calls.fetch, 0);
    assert.equal(tab.calls.scripts, 0);
    assert.equal(tab.button.disabled, true);
    assert.match(tab.status.textContent, /На початковий екран/);
    const app = await setup({ ios: true, standalone: true });
    assert.equal(app.button.disabled, false);
});

test('blocked SDK and subscription failures show useful status without breaking the page', async () => {
    const blocked = await setup({ failSDK: true });
    assert.equal(blocked.button.disabled, true);
    assert.match(blocked.status.textContent, /блокувальник/);
    const app = await setup();
    app.subscription.optIn = async () => { throw new Error('service unavailable'); };
    await app.button.handlers.click();
    assert.equal(app.button.disabled, false);
    assert.match(app.status.textContent, /Спробуйте ще раз/);
});
