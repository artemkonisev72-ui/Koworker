# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.13.0 create --template minimal --types ts --add tailwindcss="plugins:none" prettier eslint vitest="usages:unit" --install npm ./
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Local test database (PostgreSQL)

The project has a dedicated local test DB connection in `.env.test`:

```sh
DATABASE_URL="postgresql://postgres@127.0.0.1:5433/coworker_test"
DEV_SERVER_PORT="5174"
DEV_STRICT_PORT="false"
```

Useful commands:

```sh
npm run db:test:push   # apply Prisma schema to test DB
npm run db:test:reset  # reset test DB schema
npm run test:db        # sync schema + run tests
npm run dev:testdb     # run local app with test DB (.env.test)
```

Note: `npm run dev` and `npm run dev:testdb` now run `prisma generate` automatically, so Prisma Client stays in sync with `prisma/schema.prisma`.

## Auth email verification

New registrations now require email confirmation before login.

Environment variables for this flow:

```sh
APP_BASE_URL="http://localhost:5173"
EMAIL_VERIFY_TTL_MINUTES="1440"
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_SECURE="false"
SMTP_USER="smtp-user"
SMTP_PASS="smtp-password"
SMTP_FROM="Coworker <no-reply@example.com>"
```

If SMTP variables are not configured, the app logs verification links to server logs (dev/test fallback).

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
