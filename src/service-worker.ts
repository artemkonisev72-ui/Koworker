/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const STATIC_CACHE = `coworker-static-${version}`;
const PYODIDE_VERSION = '0.29.3';
const PYODIDE_PATH_PREFIX = `/pyodide/v${PYODIDE_VERSION}/`;
const PYODIDE_CACHE = `coworker-pyodide-${version}-${PYODIDE_VERSION}`;
const OFFLINE_URL = '/offline.html';

const ASSET_DESTINATIONS = new Set(['style', 'script', 'worker', 'font', 'image', 'manifest']);
const STATIC_ASSETS = new Set([...build, ...files, OFFLINE_URL]);
const PYODIDE_ASSETS = [
	`${PYODIDE_PATH_PREFIX}pyodide.mjs`,
	`${PYODIDE_PATH_PREFIX}pyodide.asm.js`,
	`${PYODIDE_PATH_PREFIX}pyodide.asm.wasm`,
	`${PYODIDE_PATH_PREFIX}python_stdlib.zip`,
	`${PYODIDE_PATH_PREFIX}pyodide-lock.json`,
	`${PYODIDE_PATH_PREFIX}numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl`,
	`${PYODIDE_PATH_PREFIX}mpmath-1.3.0-py3-none-any.whl`,
	`${PYODIDE_PATH_PREFIX}sympy-1.13.3-py3-none-any.whl`
];
const ACTIVE_CACHES = new Set([STATIC_CACHE, PYODIDE_CACHE]);

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(STATIC_CACHE);
			await cache.addAll(Array.from(STATIC_ASSETS));
			await self.skipWaiting();
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const cacheKeys = await caches.keys();
			await Promise.all(
				cacheKeys.map((cacheName) => {
					if (!ACTIVE_CACHES.has(cacheName)) {
						return caches.delete(cacheName);
					}
					return Promise.resolve(false);
				})
			);
			await self.clients.claim();
		})()
	);
});

self.addEventListener('message', (event) => {
	const data = event.data as { type?: string } | undefined;
	if (!data || data.type !== 'cache-pyodide') return;
	event.waitUntil(cachePyodideAssets());
});

self.addEventListener('fetch', (event) => {
	const { request } = event;

	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	// API responses stay network-only to avoid caching auth-sensitive payloads.
	if (url.pathname.startsWith('/api/')) return;

	if (url.pathname.startsWith(PYODIDE_PATH_PREFIX)) {
		event.respondWith(handlePyodideRequest(request));
		return;
	}

	if (request.mode === 'navigate') {
		event.respondWith(handleNavigationRequest(request));
		return;
	}

	if (isCacheableStaticRequest(request, url)) {
		event.respondWith(handleStaticRequest(request));
	}
});

function isCacheableStaticRequest(request: Request, url: URL): boolean {
	if (STATIC_ASSETS.has(url.pathname)) return true;
	if (url.pathname.startsWith('/_app/immutable/')) return true;
	if (ASSET_DESTINATIONS.has(request.destination)) return true;
	return false;
}

async function handleNavigationRequest(request: Request): Promise<Response> {
	try {
		return await fetch(request);
	} catch {
		const staticCache = await caches.open(STATIC_CACHE);
		const offlineFallback = await staticCache.match(OFFLINE_URL);
		if (offlineFallback) return offlineFallback;

		return new Response('Offline', {
			status: 503,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}
}

async function handleStaticRequest(request: Request): Promise<Response> {
	const staticCache = await caches.open(STATIC_CACHE);
	const cached = await staticCache.match(request);

	const networkFetch = fetch(request)
		.then(async (response) => {
			if (response.ok) {
				await staticCache.put(request, response.clone());
			}
			return response;
		})
		.catch(() => null);

	if (cached) {
		void networkFetch;
		return cached;
	}

	const networkResponse = await networkFetch;
	if (networkResponse) return networkResponse;

	return new Response('Resource unavailable while offline.', {
		status: 503,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}

async function cachePyodideAssets(): Promise<void> {
	const cache = await caches.open(PYODIDE_CACHE);
	await Promise.all(
		PYODIDE_ASSETS.map(async (assetPath) => {
			const cached = await cache.match(assetPath);
			if (cached) return;
			try {
				const response = await fetch(assetPath, { cache: 'no-cache' });
				if (response.ok) {
					await cache.put(assetPath, response.clone());
				}
			} catch {
				// Asset is optional for warm cache process. Missing assets should
				// not break service worker lifecycle.
			}
		})
	);
}

async function handlePyodideRequest(request: Request): Promise<Response> {
	const cache = await caches.open(PYODIDE_CACHE);
	const cached = await cache.match(request);

	const networkFetch = fetch(request)
		.then(async (response) => {
			if (response.ok) {
				await cache.put(request, response.clone());
			}
			return response;
		})
		.catch(() => null);

	if (cached) {
		void networkFetch;
		return cached;
	}

	const networkResponse = await networkFetch;
	if (networkResponse) return networkResponse;

	return new Response('Pyodide asset unavailable while offline.', {
		status: 503,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}
