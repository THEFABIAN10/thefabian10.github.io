# norivka-outages

Приватна обробка графіків для https://norivka.github.io/.
Worker `norivka-outages` лише запускає GitHub Actions кожні 6 хвилин.

## Виконання

1. Cloudflare Cron `*/6 * * * *` викликає GitHub API `workflow_dispatch`
   для `.github/workflows/update-outages.yml`, гілка `main`, `notify: true`.
2. Actions отримує графік ДТЕК, адресне повідомлення та Yasno через HTTP,
   обробляє їх спільними парсерами і зберігає JSON у гілці `outage-state`.
3. Готові JSON комітяться в `data/` репозиторію `norivka/norivka.github.io`.
   Push у `main` автоматично запускає стандартний `pages-build-deployment`,
   який публікує `main / (root)`. Додаткового запиту збірки через API немає.
4. Окремий `notify-outages.yml` після успішного `pages-build-deployment` перевіряє, що JSON уже доступні на публічному сайті, потім надсилає
   push через OneSignal і комітить підтверджений стан у `outage-state`.

Публічні файли:

- https://norivka.github.io/data/dtek-outages.json
- https://norivka.github.io/data/dtek-address.json
- https://norivka.github.io/data/outages.json

Сайт читає ці файли зі свого домену. Worker не отримує дані постачальників,
не запускає браузер, не зберігає нові графіки й не надсилає push.
Старий клас `OutageFeed` залишений лише для збереження історичного namespace:
новий код не створює й не використовує його об'єкти. Старі маршрути `/data/*.json`
перенаправляють на GitHub Pages без кешування, щоб клієнти зі збереженою
конфігурацією також отримували актуальні дані. Старі адміністративні маршрути прибрано.

GitHub workflow не має власного schedule; запуск — Worker або вручну.
Наявність активного/очікуваного запуску перевіряється перед dispatch.
`concurrency` додатково серіалізує всі оновлення; поточний запуск не скасовується.
Черга GitHub і публікація Pages додають затримку до 5-хвилинного інтервалу.

## Стан і помилки

Гілка `outage-state` містить `data/*.json`, `notifications/dtek.json`,
`notifications/yasno.json` і `run.json` із результатами останнього отримання.
Код і workflow залишаються в `main`; коміти даних не змінюють його.

Кожне джерело має до трьох HTTP-спроб. Невдача не стирає попередніх даних
і не змінює їхній `lastUpdate`. Успішні джерела оновлюються незалежно.
Дані спершу зберігаються, потім публікуються. Помилка публікації не дозволяє push.
Помилка OneSignal не підтверджує відповідну зміну; наступна спроба використовує
той самий ключ ідемпотентності для того самого переходу стану.
Стан кожного джерела записується відразу після прийняття його повідомлення.
Всі записи через git — без force-push; конфлікт завершує запуск помилкою.

Статус workflow і `run.json` — джерела діагностики. OneSignal acceptance
означає прийняття сервісом, а не підтверджену доставку на пристрій.

## Сповіщення

Заголовок — `ДТЕК`. Тіло починається з малої літери;
час адресного повідомлення додається другим рядком. TTL — 2 години (7200 секунд).
Payload не задає іконок; платформа або налаштування OneSignal можуть показати
свою стандартну іконку.

ДТЕК: поява, зміна, скасування графіків; поява/зміна адресного повідомлення;
зникнення аварійного чи екстреного повідомлення. Часові зміни стабілізаційного
повідомлення не породжують повторного адресного push. Зникнення інших адресних
повідомлень беззвучне. Одночасна зміна графіка й адресного повідомлення — один push.
Сповіщення ЯСНО вимкнено, зокрема про початок і скасування екстрених
відключень. Дані ЯСНО на сайті та збережений стан продовжують оновлюватися.

Під час міграції підтверджені стани перенесено зі старих Durable Objects,
а старий відправник вимкнено до ввімкнення нового. `notify: false` у ручному
запуску зберігається в `.outage-run.json` разом із даними публікації;
workflow сповіщень пропускає такий деплой і не підтверджує сповіщень.
Дані й метадані беруться з `head_sha` завершеної збірки, а підтверджений
стан — з актуальної `outage-state`. Обидва workflows мають спільну concurrency group.
Деплої без `.outage-run.json` пропускаються до першого оновлення даних.

## Секрети

Окремі fine-grained GitHub tokens:

- Worker `GITHUB_ACTIONS_TOKEN`: лише `norivka/norivka.github.io`, **Actions: Read and write**.
- Actions secret `ONESIGNAL_REST_API_KEY`: ключ застосунку OneSignal.
- `GITHUB_TOKEN`, виданий самому workflow: **Contents: write** для `outage-state`
  і `main/data/`. Окремий дозвіл **Pages: write** не потрібен.
- Worker `ADMIN_TOKEN`: захищає ручний `/admin/dispatch`.

Значення зберігаються в secrets, не в git. Локально — `.dev.vars` і
`.dev.vars.deploy.json` (gitignored). Не використовувати широкий gh OAuth token
як runtime secret. Відстежуйте строки дії окремих токенів.

## Розробка й деплой Worker

```sh
npm ci
npm run check
node scripts/prepare-secrets.mjs
npm run deploy -- --secrets-file .dev.vars.deploy.json
node scripts/admin.mjs status
node scripts/admin.mjs dispatch
```

`npm run deploy` використовує `cf deploy --mode live`, cron активний.
`npm run deploy:shadow` вимикає dispatch. Для подальших деплоїв секрети
передавати знову не потрібно. Cloudflare Builds викликає `npm run deploy`;
деплой Worker не перенесений у GitHub Actions.

`test:core` перевіряє парсери, розсилку й GitHub pipeline в Node.js;
`test` перевіряє Worker-планувальник у Workers runtime. Реальних push у тестах немає.

Ручна діагностика отримання: `Diagnose DTEK HTTP` або
`node scripts/diagnose-dtek.mjs`. Вона не публікує дані й не надсилає push.

Документація: [Workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
[cf у CI](https://developers.cloudflare.com/cf/ci/),
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

## Контроль збоїв

`Check outage update health` запускається незалежно від Worker за розкладом
GitHub Actions раз на 15 хвилин. Він завершується помилкою, якщо понад 20 хвилин
не запускалося оновлення, хоча б один публічний JSON застарів, або три останні
завершені оновлення були невдалими. Розклад GitHub може виконуватися із затримкою;
це резервний моніторинг, не гарантія сповіщення рівно через 20 хвилин.

Для email у https://github.com/settings/notifications увімкніть
System → Actions → Email → Only notify for failed workflows.
Це особисте налаштування власника токена, який запускає оновлення, та автора
розкладу перевірки. Репозиторій не може ввімкнути його автоматично.
Стандартні листи GitHub надходять про кожен невдалий workflow, зокрема й про
окремі помилки основного оновлення; резервна перевірка додатково виявляє
три послідовні невдачі та повну зупинку оновлень. Листи не надсилаються
підписникам push-сповіщень сайту.
