# Гайд по развёртыванию Coworker на Ubuntu 22.04

Этот гайд привязан к текущему состоянию репозитория:

- фронтенд и сервер: `SvelteKit` + `@sveltejs/adapter-node`
- прод-запуск: `node build/index.js`
- dev-запуск: `npm run dev`
- база данных: `PostgreSQL`
- ORM: `Prisma`
- инициализация схемы БД: `prisma db push`

Важно:

- в проекте сейчас нет каталога `prisma/migrations`, поэтому для новой БД нужно использовать `npx prisma db push`, а не `npx prisma migrate deploy`
- в `.env.example` указан `PROXYAPI_API_KEY`, но в реальном коде используется `GEMINI_API_KEY`
- `npm run build` проходит успешно, прод-схема запуска подтверждена
- `npm run dev` уже разрешает хосты `dev.koworker.oops.wtf` и `koworker.oops.wtf` в [vite.config.ts](/abs/g:/Project%20X/Coworker/vite.config.ts:8)

## 1. Целевая схема

Рекомендуемая схема для одного сервера:

- `prod`: `https://koworker.oops.wtf/`
- `dev`: `https://dev.koworker.oops.wtf/`
- `nginx` принимает HTTPS и проксирует трафик
- `prod` приложение слушает `127.0.0.1:3000`
- `dev` приложение слушает `127.0.0.1:5173`
- `prod` и `dev` используют разные базы:
- `coworker_prod`
- `coworker_dev`

Так вы не смешаете рабочие данные с тестовыми.

## 2. Что подготовить заранее

Нужно:

- Ubuntu 22.04
- DNS-записи:
- `koworker.oops.wtf` -> IP сервера
- `dev.koworker.oops.wtf` -> IP сервера
- доступ по `sudo`
- доступ к git-репозиторию проекта
- SMTP-реквизиты, если в `prod` нужна нормальная отправка писем подтверждения email
- ключ `GEMINI_API_KEY`

## 3. Установка системных пакетов

### 3.1. Обновить сервер

```bash
sudo apt update
sudo apt upgrade -y
```

### 3.2. Установить базовые пакеты

```bash
sudo apt install -y git curl ca-certificates gnupg build-essential nginx postgresql postgresql-contrib
```

### 3.3. Установить Node.js 22 LTS

Текущий `vite@7.3.1` из `node_modules` требует Node `^20.19.0 || >=22.12.0`, поэтому на Ubuntu 22.04 проще сразу ставить Node 22 LTS.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Проверьте, что версия Node не ниже `22.12.0`.

## 4. Создать системного пользователя

```bash
sudo adduser --system --group --home /srv/coworker coworker
sudo mkdir -p /srv/coworker
sudo chown coworker:coworker /srv/coworker
```

## 5. Развернуть код проекта

Проще всего держать два независимых checkout:

- `/srv/coworker/prod`
- `/srv/coworker/dev`

```bash
sudo -u coworker git clone <URL_ВАШЕГО_РЕПОЗИТОРИЯ> /srv/coworker/prod
sudo -u coworker git clone <URL_ВАШЕГО_РЕПОЗИТОРИЯ> /srv/coworker/dev
```

Если `dev` должен идти с другой ветки:

```bash
sudo -u coworker bash -lc "cd /srv/coworker/dev && git checkout <dev-branch>"
```

## 6. Развернуть новую PostgreSQL БД

### 6.1. Включить PostgreSQL

```bash
sudo systemctl enable --now postgresql
sudo systemctl status postgresql
```

### 6.2. Создать пользователя БД

Замените пароль на свой.

```bash
sudo -u postgres psql
```

Внутри `psql`:

```sql
CREATE ROLE coworker WITH LOGIN PASSWORD 'STRONG_DB_PASSWORD';
CREATE DATABASE coworker_prod OWNER coworker;
CREATE DATABASE coworker_dev OWNER coworker;
\q
```

### 6.3. Проверить подключение

```bash
psql "postgresql://coworker:STRONG_DB_PASSWORD@127.0.0.1:5432/coworker_prod" -c "\dt"
psql "postgresql://coworker:STRONG_DB_PASSWORD@127.0.0.1:5432/coworker_dev" -c "\dt"
```

Если таблиц нет, это нормально: схема будет создана Prisma.

## 7. Настроить env-файлы

В этом проекте сервер использует переменные из `.env`.

Обязательные переменные по коду:

- `DATABASE_URL`
- `GEMINI_API_KEY`
- `APP_BASE_URL`

Нужны для email-верификации:

- `EMAIL_VERIFY_TTL_MINUTES`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

Дополнительно можно задать:

- `GEMINI_REQUEST_TIMEOUT_MS`
- `HOST`
- `PORT`
- `ORIGIN`
- `DEV_SERVER_PORT`
- `DEV_STRICT_PORT`

### 7.1. Prod `.env`

Создайте `/srv/coworker/prod/.env`:

```env
DATABASE_URL="postgresql://coworker:STRONG_DB_PASSWORD@127.0.0.1:5432/coworker_prod"
GEMINI_API_KEY="PASTE_REAL_KEY_HERE"
APP_BASE_URL="https://koworker.oops.wtf"

EMAIL_VERIFY_TTL_MINUTES="1440"
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_SECURE="false"
SMTP_USER="smtp-user"
SMTP_PASS="smtp-password"
SMTP_FROM="Coworker <no-reply@oops.wtf>"

GEMINI_REQUEST_TIMEOUT_MS="60000"
HOST="127.0.0.1"
PORT="3000"
ORIGIN="https://koworker.oops.wtf"
```

### 7.2. Dev `.env`

Создайте `/srv/coworker/dev/.env`:

```env
DATABASE_URL="postgresql://coworker:STRONG_DB_PASSWORD@127.0.0.1:5432/coworker_dev"
GEMINI_API_KEY="PASTE_REAL_KEY_HERE"
APP_BASE_URL="https://dev.koworker.oops.wtf"

EMAIL_VERIFY_TTL_MINUTES="1440"

DEV_SERVER_PORT="5173"
DEV_STRICT_PORT="true"
```

Замечания по `dev`:

- если SMTP не задан, в dev-режиме ссылки подтверждения email будут писаться в логи сервиса, это поведение есть в [src/lib/server/auth-email.ts](/abs/g:/Project%20X/Coworker/src/lib/server/auth-email.ts:78)
- если нужен полноценный публичный dev-стенд с регистрацией, лучше тоже прописать SMTP-параметры

### 7.3. Права на env-файлы

```bash
sudo chown coworker:coworker /srv/coworker/prod/.env /srv/coworker/dev/.env
sudo chmod 600 /srv/coworker/prod/.env /srv/coworker/dev/.env
```

## 8. Установить npm-зависимости

### 8.1. Prod

```bash
sudo -u coworker bash -lc "cd /srv/coworker/prod && npm ci"
```

### 8.2. Dev

```bash
sudo -u coworker bash -lc "cd /srv/coworker/dev && npm ci"
```

## 9. Инициализировать Prisma и новую БД

В этом проекте нужно выполнить две команды:

- `npm run prisma:generate`
- `npx prisma db push`

### 9.1. Prod

```bash
sudo -u coworker bash -lc "cd /srv/coworker/prod && npm run prisma:generate && npx prisma db push"
```

### 9.2. Dev

```bash
sudo -u coworker bash -lc "cd /srv/coworker/dev && npm run prisma:generate && npx prisma db push"
```

После этого Prisma создаст таблицы в пустой PostgreSQL-базе по [prisma/schema.prisma](/abs/g:/Project%20X/Coworker/prisma/schema.prisma:1).

## 10. Собрать prod-версию

`prod` запускается не через `npm run dev`, а через собранный `adapter-node` bundle.

```bash
sudo -u coworker bash -lc "cd /srv/coworker/prod && npm run build"
```

После сборки точка входа будет:

- `/srv/coworker/prod/build/index.js`

Это соответствует `@sveltejs/adapter-node` из [svelte.config.js](/abs/g:/Project%20X/Coworker/svelte.config.js:1).

## 10.1. Команды ручного запуска

Если нужно запустить проект вручную без `systemd`, используйте такие команды.

### Prod запуск

Сначала сборка:

```bash
cd /srv/coworker/prod
npm ci
npm run prisma:generate
npx prisma db push
npm run build
```

Потом запуск:

```bash
cd /srv/coworker/prod
export NODE_ENV=production
export HOST=127.0.0.1
export PORT=3000
node build/index.js
```

Если `.env` уже заполнен, можно запускать так:

```bash
cd /srv/coworker/prod
set -a
source .env
set +a
export NODE_ENV=production
node build/index.js
```

### Dev запуск

```bash
cd /srv/coworker/dev
npm ci
npm run prisma:generate
npx prisma db push
npm run dev
```

Если хотите явно зафиксировать порт и хост для dev-стенда:

```bash
cd /srv/coworker/dev
export NODE_ENV=development
export DEV_SERVER_PORT=5173
export DEV_STRICT_PORT=true
npm run dev
```

После запуска:

- `prod` будет доступен локально на `http://127.0.0.1:3000`
- `dev` будет доступен локально на `http://127.0.0.1:5173`

## 10.2. Prod запуск через pm2

Если хотите управлять `prod` не через `systemd`, а через `pm2`, используйте этот вариант.

Важно:

- для одного и того же `prod` процесса выбирайте что-то одно: либо `pm2`, либо `systemd`
- если `coworker-prod.service` уже включён, не запускайте поверх него второй `prod` через `pm2` на том же порту `3000`

### Установить pm2

Лучше ставить глобально:

```bash
sudo npm install -g pm2
pm2 -v
```

### Подготовить prod перед первым запуском

```bash
cd /srv/coworker/prod
npm ci
npm run prisma:generate
npx prisma db push
npm run build
```

### Запустить prod через pm2

Если `.env` уже заполнен:

```bash
cd /srv/coworker/prod
set -a
source .env
set +a
export NODE_ENV=production
pm2 start build/index.js --name coworker-prod
```

Более надёжный вариант одной командой:

```bash
cd /srv/coworker/prod
pm2 start "bash -lc 'set -a && source .env && set +a && export NODE_ENV=production && exec node build/index.js'" --name coworker-prod
```

После запуска проверьте:

```bash
pm2 status
pm2 logs coworker-prod
curl -I http://127.0.0.1:3000
```

### Сохранить процесс и включить автозапуск после reboot

```bash
pm2 save
pm2 startup
```

Команда `pm2 startup` выведет ещё одну команду, её нужно выполнить от `root`.

Обычно это выглядит примерно так:

```bash
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u <USER> --hp /home/<USER>
```

После этого ещё раз:

```bash
pm2 save
```

### Основные команды pm2 для prod

Статус:

```bash
pm2 status
pm2 show coworker-prod
```

Логи:

```bash
pm2 logs coworker-prod
```

Перезапуск:

```bash
pm2 restart coworker-prod
```

Остановка:

```bash
pm2 stop coworker-prod
```

Удаление процесса из pm2:

```bash
pm2 delete coworker-prod
```

### Обновление prod при запуске через pm2

```bash
cd /srv/coworker/prod
git pull
npm ci
npm run prisma:generate
npx prisma db push
npm run build
pm2 restart coworker-prod
```

Если меняли переменные в `.env`, лучше перезапустить процесс так:

```bash
pm2 delete coworker-prod
pm2 start "bash -lc 'set -a && source .env && set +a && export NODE_ENV=production && exec node build/index.js'" --name coworker-prod
pm2 save
```

## 11. Настроить systemd

### 11.1. Prod service

Создайте `/etc/systemd/system/coworker-prod.service`:

```ini
[Unit]
Description=Coworker production
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=coworker
Group=coworker
WorkingDirectory=/srv/coworker/prod
EnvironmentFile=/srv/coworker/prod/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node build/index.js
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

### 11.2. Dev service

Создайте `/etc/systemd/system/coworker-dev.service`:

```ini
[Unit]
Description=Coworker development
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=coworker
Group=coworker
WorkingDirectory=/srv/coworker/dev
EnvironmentFile=/srv/coworker/dev/.env
Environment=NODE_ENV=development
ExecStart=/usr/bin/npm run dev
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

### 11.3. Включить сервисы

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coworker-prod
sudo systemctl enable --now coworker-dev
sudo systemctl status coworker-prod
sudo systemctl status coworker-dev
```

Проверка локально на сервере:

```bash
curl -I http://127.0.0.1:3000
curl -I http://127.0.0.1:5173
```

## 12. Настроить nginx

Нужны два upstream:

- `127.0.0.1:3000` для `prod`
- `127.0.0.1:5173` для `dev`

### 12.1. Временный HTTP-конфиг для выпуска сертификатов

Сначала создайте временный `/etc/nginx/sites-available/koworker.conf` без SSL:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name koworker.oops.wtf;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name dev.koworker.oops.wtf;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Активируйте его:

```bash
sudo ln -sf /etc/nginx/sites-available/koworker.conf /etc/nginx/sites-enabled/koworker.conf
sudo nginx -t
sudo systemctl reload nginx
```

### 12.2. TLS сертификаты

Установите Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
```

Получите сертификаты:

```bash
sudo certbot certonly --webroot -w /var/www/html -d koworker.oops.wtf -d dev.koworker.oops.wtf
```

### 12.3. Финальный HTTPS-конфиг nginx

После выпуска сертификатов замените `/etc/nginx/sites-available/koworker.conf` на финальный вариант:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name koworker.oops.wtf dev.koworker.oops.wtf;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name koworker.oops.wtf;

    ssl_certificate /etc/letsencrypt/live/koworker.oops.wtf/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/koworker.oops.wtf/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name dev.koworker.oops.wtf;

    ssl_certificate /etc/letsencrypt/live/dev.koworker.oops.wtf/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dev.koworker.oops.wtf/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Примените:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Проверьте автообновление:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

## 13. Открыть firewall

Если используете `ufw`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Порты `3000` и `5173` наружу открывать не нужно.

## 14. Первая проверка после запуска

Проверьте:

- `https://koworker.oops.wtf/`
- `https://dev.koworker.oops.wtf/`
- регистрацию пользователя
- подтверждение email
- подключение к БД
- работу AI-функций через `GEMINI_API_KEY`

Полезные команды:

```bash
sudo systemctl status coworker-prod
sudo systemctl status coworker-dev
sudo journalctl -u coworker-prod -f
sudo journalctl -u coworker-dev -f
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

Для `dev` без SMTP ссылка подтверждения будет в логах:

```bash
sudo journalctl -u coworker-dev -f
```

## 15. Обновление проекта

### 15.1. Обновление prod

```bash
sudo -u coworker bash -lc "cd /srv/coworker/prod && git pull"
sudo -u coworker bash -lc "cd /srv/coworker/prod && npm ci"
sudo -u coworker bash -lc "cd /srv/coworker/prod && npm run prisma:generate && npx prisma db push"
sudo -u coworker bash -lc "cd /srv/coworker/prod && npm run build"
sudo systemctl restart coworker-prod
```

### 15.2. Обновление dev

```bash
sudo -u coworker bash -lc "cd /srv/coworker/dev && git pull"
sudo -u coworker bash -lc "cd /srv/coworker/dev && npm ci"
sudo -u coworker bash -lc "cd /srv/coworker/dev && npm run prisma:generate && npx prisma db push"
sudo systemctl restart coworker-dev
```

## 16. Частые проблемы

### 16.1. `DATABASE_URL is not defined`

Проблема будет из [src/lib/server/db.ts](/abs/g:/Project%20X/Coworker/src/lib/server/db.ts:16), если не подхватился `.env`.

Проверьте:

- существует ли `.env`
- подключён ли `EnvironmentFile` в systemd
- совпадает ли путь `WorkingDirectory`

### 16.2. Прод не отправляет письма

В `production` без SMTP код падает с ошибкой из [src/lib/server/auth-email.ts](/abs/g:/Project%20X/Coworker/src/lib/server/auth-email.ts:80).

Для `prod` обязательно задайте:

- `SMTP_HOST`
- `SMTP_FROM`

И обычно ещё:

- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`

### 16.3. `prisma migrate deploy` ничего не делает

Это ожидаемо: в проекте нет миграций. Для пустой или обновляемой БД используйте:

```bash
npx prisma db push
```

### 16.4. `dev` стенд работает, но логин ведёт себя странно

Проверьте:

- что `APP_BASE_URL="https://dev.koworker.oops.wtf"`
- что nginx передаёт `Host` и `X-Forwarded-Proto`
- что домен действительно открывается по HTTPS

### 16.5. HMR на `dev` не работает через nginx

Проверьте в nginx:

- `proxy_http_version 1.1`
- `proxy_set_header Upgrade $http_upgrade`
- `proxy_set_header Connection "upgrade"`

## 17. Что можно улучшить позже

Для базового запуска этого гайда достаточно, но дальше можно улучшить:

- сделать CI/CD вместо ручного `git pull`
- собирать `prod` на CI и доставлять на сервер артефакт
- вынести секреты в `systemd-creds`, Vault или хотя бы `/etc/coworker/*.env`
- запускать `dev` не как публичный стенд, а как закрытый внутренний хост
- добавить бэкапы PostgreSQL через `pg_dump` и `systemd timer`

## 18. Краткий чек-лист

1. Установить `nginx`, `postgresql`, `nodejs 22`.
2. Создать пользователя `coworker`.
3. Склонировать репозиторий в `/srv/coworker/prod` и `/srv/coworker/dev`.
4. Создать БД `coworker_prod` и `coworker_dev`.
5. Заполнить `.env` для `prod` и `dev`.
6. Выполнить `npm ci`.
7. Выполнить `npm run prisma:generate && npx prisma db push`.
8. Для `prod` выполнить `npm run build`.
9. Создать `systemd` сервисы.
10. Настроить `nginx`.
11. Выпустить сертификаты через `certbot`.
12. Проверить `https://koworker.oops.wtf/` и `https://dev.koworker.oops.wtf/`.
