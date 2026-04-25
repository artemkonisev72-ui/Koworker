import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const devServerPort = Number(process.env.DEV_SERVER_PORT ?? '5173');
const devStrictPort = process.env.DEV_STRICT_PORT !== 'false';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	worker: {
		format: 'es'
	},
	server: {
		host: '0.0.0.0',
		port: devServerPort,
		strictPort: devStrictPort,
		allowedHosts: ['dev.koworker.oops.wtf', 'koworker.oops.wtf'],
		cors: true,
		hmr: devStrictPort ? { clientPort: devServerPort } : undefined
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
