import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import dns from 'node:dns';

// Жестко заставляем Node.js/Vite использовать только IPv4 для всех сетевых запросов (fetch, db и др.)
dns.setDefaultResultOrder('ipv4first');

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: '0.0.0.0', // Слушать на всех интерфейсах (0.0.0.0)
		port: 5173,      // Основной порт Vite
		strictPort: true,
		cors: true,      // Разрешить CORS запросы
		hmr: {
			// При доступе через SSH-туннель браузер видит localhost, а не IP сервера
			clientPort: 5173
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
