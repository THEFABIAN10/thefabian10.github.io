async function initializePushNotifications() {
    const button = document.getElementById('notification-toggle');
    const status = document.getElementById('notification-status');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOS && !standalone) {
        status.textContent = 'На iPhone/iPad: «Поділитися» → «На початковий екран», потім відкрийте сайт з іконки та увімкніть сповіщення (iOS 16.4+).';
        return;
    }

    if (!window.isSecureContext || !('Notification' in window) || !('serviceWorker' in navigator)) {
        status.textContent = 'Цей браузер не підтримує push-сповіщення. Спробуйте відкрити сайт у звичайному вікні сучасного браузера через HTTPS.';
        return;
    }

    try {
        const response = await fetch('push-config.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('Cannot load push configuration');
        const config = await response.json();
        if (!config.appId) {
            status.textContent = 'Сповіщення ще налаштовуються.';
            return;
        }

        window.OneSignalDeferred = window.OneSignalDeferred || [];
        const sdk = document.createElement('script');
        sdk.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
        sdk.defer = true;
        const loadingTimeout = setTimeout(() => {
            status.textContent = 'Не вдалося підключити сповіщення. Перезавантажте сторінку або перевірте блокувальник вмісту.';
        }, 15000);
        sdk.onerror = () => {
            clearTimeout(loadingTimeout);
            status.textContent = 'Не вдалося підключити сповіщення. Перезавантажте сторінку або перевірте блокувальник вмісту.';
        };

        window.OneSignalDeferred.push(async OneSignal => {
            try {
                await OneSignal.init({
                    appId: config.appId,
                    serviceWorkerPath: 'OneSignalSDKWorker.js',
                    serviceWorkerParam: { scope: '/' },
                    notifyButton: { enable: false },
                    welcomeNotification: { disable: true },
                    promptOptions: { slidedown: { prompts: [{ type: 'push', autoPrompt: false }] } }
                });
                clearTimeout(loadingTimeout);
                if (!OneSignal.Notifications.isPushSupported()) {
                    status.textContent = 'Push-сповіщення недоступні в цьому браузері.';
                    return;
                }

                let requestInProgress = false;
                let awaitingRegistration = false;
                let registrationTimeout;
                let subscriptionError = '';

                function isSubscribed() {
                    const subscription = OneSignal.User.PushSubscription;
                    return Boolean(subscription.optedIn && subscription.id && subscription.token &&
                        OneSignal.Notifications.permission);
                }

                function updateSubscriptionUI() {
                    const subscribed = isSubscribed();
                    const denied = Notification.permission === 'denied';
                    if (subscribed || denied) {
                        clearTimeout(registrationTimeout);
                        awaitingRegistration = false;
                        subscriptionError = '';
                    }
                    button.disabled = denied || requestInProgress || awaitingRegistration;
                    button.textContent = subscribed ? '🔕 Вимкнути сповіщення' : '🔔 Увімкнути сповіщення';
                    button.setAttribute('aria-pressed', String(subscribed));
                    status.textContent = denied
                        ? 'Сповіщення заблоковані. Дозвольте їх у налаштуваннях цього сайту в браузері.'
                        : awaitingRegistration ? 'Завершення підписки…' : subscriptionError;
                }

                OneSignal.User.PushSubscription.addEventListener('change', updateSubscriptionUI);
                OneSignal.Notifications.addEventListener('permissionChange', updateSubscriptionUI);
                window.addEventListener('focus', updateSubscriptionUI);
                button.addEventListener('click', async () => {
                    if (requestInProgress || awaitingRegistration) return;
                    requestInProgress = true;
                    subscriptionError = '';
                    updateSubscriptionUI();
                    try {
                        // Call directly from the click so Safari retains the user gesture.
                        if (isSubscribed()) {
                            await OneSignal.User.PushSubscription.optOut();
                        } else {
                            const subscription = OneSignal.User.PushSubscription;
                            if (Notification.permission !== 'granted' || !subscription.id || !subscription.token) {
                                // optIn alone only toggles a flag when permission is already granted.
                                const registered = await OneSignal.Notifications.requestPermission();
                                if (registered === false && Notification.permission === 'granted') {
                                    throw new Error('Push registration failed');
                                }
                            }
                            if (Notification.permission === 'granted') {
                                await subscription.optIn();
                                if (!isSubscribed()) {
                                    awaitingRegistration = true;
                                    registrationTimeout = setTimeout(() => {
                                        awaitingRegistration = false;
                                        subscriptionError = 'OneSignal не підтвердив підписку. Спробуйте ще раз.';
                                        updateSubscriptionUI();
                                    }, 15000);
                                }
                            }
                        }
                    } catch (error) {
                        console.error('Push subscription failed:', error);
                        requestInProgress = false;
                        updateSubscriptionUI();
                        status.textContent = 'Не вдалося змінити підписку. Спробуйте ще раз.';
                        return;
                    }
                    requestInProgress = false;
                    updateSubscriptionUI();
                });
                updateSubscriptionUI();
            } catch (error) {
                clearTimeout(loadingTimeout);
                console.error('Push initialization failed:', error);
                status.textContent = 'Не вдалося підключити сповіщення. Спробуйте перезавантажити сторінку пізніше.';
            }
        });
        document.head.appendChild(sdk);
    } catch (error) {
        console.error('Push configuration failed:', error);
        status.textContent = 'Не вдалося підключити сповіщення. Спробуйте перезавантажити сторінку пізніше.';
    }
}

initializePushNotifications();
