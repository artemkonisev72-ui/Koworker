/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const STATIC_CACHE = `coworker-static-${version}`;
const PAGE_CACHE = `coworker-pages-${version}`;
const OFFLINE_URL = '/offline.html';

const ASSET_DESTINATIONS = new Set(['style', 'script', 'worker', 'font', 'image', 'manifest']);
const STATIC_ASSETS = new Set([...build, ...files, OFFLINE_URL]);
const ACTIVE_CACHES = new Set([STATIC_CACHE, PAGE_CACHE]);

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

self.addEventListener('fetch', (event) => {
	const { request } = event;

	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	// API responses stay network-only to avoid caching auth-sensitive payloads.
	if (url.pathname.startsWith('/api/')) return;

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
	const pageCache = await caches.open(PAGE_CACHE);

	try {
		const response = await fetch(request);
		if (response.ok) {
			await pageCache.put(request, response.clone());
		}
		return response;
	} catch {
		const cachedPage = await pageCache.match(request);
		if (cachedPage) return cachedPage;

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
