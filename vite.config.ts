import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: '0.0.0.0', // Слушать на всех интерфейсах (0.0.0.0)
		port: 5173,      // Основной порт Vite
		strictPort: true,
		cors: true,      // Разрешить CORS запросы
		hmr: {
			host: '79.164.121.156', // Явный IP сервера для Hot Module Replacement
			port: 5173
		}
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
