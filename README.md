# Графік відключень Норівка

Єдиний репозиторій для сайту, збору даних, push-сповіщень і коду Worker.
Сайт: https://norivka.github.io/

## Як працює оновлення

Cloudflare Worker `norivka-outages` кожні 6 хвилин запускає
`.github/workflows/update-outages.yml`. Workflow у цьому публічному репозиторії
отримує ДТЕК і ЯСНО, зберігає дані та підтверджений стан сповіщень у гілці
`outage-state`, публікує JSON у `main/data/` і запитує стандартну збірку GitHub Pages.
Окремий `notify-outages.yml` запускається лише після успішного
`pages-build-deployment` для `main`, перевіряє опубліковані JSON і надсилає push.
Сам Worker лише запускає workflow; старі адреси його JSON перенаправляють на сайт.

GitHub Actions використовує стандартний Ubuntu runner публічного репозиторію.
Окремого токена для публікації немає: автоматичний `GITHUB_TOKEN` має
`contents: write` і `pages: write`. Явний запуск Pages потрібен, бо push,
зроблений `GITHUB_TOKEN`, не запускає автоматичну збірку Pages. Використовується `POST /repos/{owner}/{repo}/pages/builds`.
У Settings → Pages джерело: **Deploy from a branch**, **main / (root)**.

## Структура

- `index.html`, `app.js`, `data-config.js`: сторінка та завантаження JSON.
- `data/`: три публічні JSON (графіки ДТЕК, адресна інформація ДТЕК, ЯСНО).
- `push-notifications.js`, `OneSignalSDKWorker.js`: підписка користувачів на push.
- `automation/`: парсери, сповіщення, код Worker та тести.
- гілка `outage-state`: дані й підтверджені ревізії сповіщень; секретів немає.

Якщо графік старший за 15 хвилин, сторінка показує попередження над ним.
Адресне попередження показується внизу адресного блоку без префікса.
Після тимчасового збою мережі останній завантажений графік залишається видимим.

## Перевірки та локальна робота

```sh
node --test *.test.js
cd automation
npm ci
npm run check
```

Для Worker використовується `automation/cloudflare.config.ts` і Cloudflare CLI:

```sh
cd automation
node scripts/prepare-secrets.mjs
npm run deploy -- --secrets-file .dev.vars.deploy.json
node scripts/admin.mjs status
node scripts/admin.mjs dispatch
```

У Cloudflare Builds: репозиторій `norivka/norivka.github.io`, гілка `main`,
кореневий каталог `automation`, build `npm run build`, deploy `npm run deploy`.
Зміни лише `data/` не повинні перевипускати Worker; фільтр — `automation/**`.
Деплой Worker виконується Cloudflare Builds, не GitHub Actions.

## Секрети

- Worker: `GITHUB_ACTIONS_TOKEN`, fine-grained токен лише цього репозиторію з
  **Actions: Read and write**, та `ADMIN_TOKEN` для ручного запуску.
- GitHub Actions: `ONESIGNAL_REST_API_KEY`.
- `push-config.json` містить публічні App ID та URL, не секретний ключ.

Локальні `.dev.vars` і `.dev.vars.deploy.json` не комітяться. Секрети та приватні
файли не комітяться; `_config.yml` виключає автоматизацію, README і тести зі збірки Pages.

## Контроль збоїв

`check-update-health.yml` незалежно від Worker кожні 15 хвилин перевіряє
запуски оновлення, три послідовні невдачі та вік кожного JSON (поріг 20 хвилин).
Розклад GitHub може затримуватися. Для листів увімкніть у
https://github.com/settings/notifications:
**System → Actions → Email → Only notify for failed workflows**.
Це особисте налаштування, його неможливо ввімкнути файлом репозиторію.

Подробиці формування сповіщень і роботи автоматизації — [automation/README.md](automation/README.md).
