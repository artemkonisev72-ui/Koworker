<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { clientSandbox } from '$lib/client/sandbox/index.js';

	interface BeforeInstallPromptEvent extends Event {
		prompt: () => Promise<void>;
		userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
	}

	let { children, data }: { children: Snippet; data: import('./$types').LayoutData } = $props();

	let deferredInstallPrompt = $state<BeforeInstallPromptEvent | null>(null);
	let showInstallOffer = $state(false);
	let installHintText = $state('');
	let installInProgress = $state(false);
	let pyodideWarmupStarted = false;

	function isAndroidDevice(): boolean {
		const navigatorWithUAData = navigator as Navigator & { userAgentData?: { platform?: string } };
		const platform = navigatorWithUAData.userAgentData?.platform;
		if (platform && /android/i.test(platform)) {
			return true;
		}
		return /android/i.test(navigator.userAgent);
	}

	function isStandalonePwa(): boolean {
		const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
		return (
			window.matchMedia('(display-mode: standalone)').matches ||
			navigatorWithStandalone.standalone === true ||
			document.referrer.startsWith('android-app://')
		);
	}

	function consumePostLoginParam(): void {
		const current = new URL(window.location.href);
		if (current.searchParams.get('postLogin') !== '1') return;

		current.searchParams.delete('postLogin');
		const cleanedUrl = `${current.pathname}${current.search}${current.hash}`;
		window.history.replaceState(window.history.state, '', cleanedUrl);
	}

	async function registerServiceWorker() {
		if (!('serviceWorker' in navigator)) return;
		try {
			await navigator.serviceWorker.register('/service-worker.js');
		} catch (error) {
			console.error('Service worker registration failed:', error);
		}
	}

	function schedulePyodideWarmup() {
		if (pyodideWarmupStarted || !data.user) return;
		pyodideWarmupStarted = true;

		const runWarmup = async () => {
			if ('serviceWorker' in navigator) {
				try {
					const registration = await navigator.serviceWorker.ready;
					registration.active?.postMessage({ type: 'cache-pyodide' });
				} catch (error) {
					console.warn('Failed to trigger pyodide cache warmup:', error);
				}
			}

			try {
				await clientSandbox.warm();
			} catch (error) {
				console.warn('Client sandbox warmup failed:', error);
			}
		};

		if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
			(window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => void })
				.requestIdleCallback?.(() => {
					void runWarmup();
				}, { timeout: 4000 });
		} else {
			setTimeout(() => {
				void runWarmup();
			}, 500);
		}
	}

	function canOfferInstallAfterLogin(): boolean {
		if (!data.user) return false;
		if (!isAndroidDevice()) return false;
		if (isStandalonePwa()) return false;
		return true;
	}

	async function installPwa() {
		if (installInProgress) return;

		if (isStandalonePwa()) {
			showInstallOffer = false;
			installHintText = '';
			return;
		}

		if (!deferredInstallPrompt) {
			installHintText = 'Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран».';
			return;
		}

		installInProgress = true;
		installHintText = '';
		try {
			await deferredInstallPrompt.prompt();
			const { outcome } = await deferredInstallPrompt.userChoice;
			if (outcome === 'accepted') {
				showInstallOffer = false;
			} else {
				installHintText = 'Вы сможете установить Koworker позже через меню браузера.';
			}
		} catch (error) {
			console.error('PWA install prompt failed:', error);
			installHintText = 'Сейчас системное окно установки недоступно. Попробуйте установить через меню браузера.';
		} finally {
			installInProgress = false;
			deferredInstallPrompt = null;
		}
	}

	function dismissInstallOffer() {
		showInstallOffer = false;
		installHintText = '';
	}

	onMount(() => {
		void registerServiceWorker().then(() => {
			schedulePyodideWarmup();
		});
		schedulePyodideWarmup();

		if (data.postLogin) {
			consumePostLoginParam();
		}

		const shouldOfferNow = data.postLogin && canOfferInstallAfterLogin();

		if (shouldOfferNow) {
			showInstallOffer = true;
		}

		const handleBeforeInstallPrompt = (event: Event) => {
			const installEvent = event as BeforeInstallPromptEvent;
			installEvent.preventDefault();
			deferredInstallPrompt = installEvent;

			if (shouldOfferNow && !isStandalonePwa()) {
				showInstallOffer = true;
			}
		};

		const handleAppInstalled = () => {
			deferredInstallPrompt = null;
			showInstallOffer = false;
			installHintText = '';
		};

		window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt as EventListener);
		window.addEventListener('appinstalled', handleAppInstalled);

		return () => {
			window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt as EventListener);
			window.removeEventListener('appinstalled', handleAppInstalled);
		};
	});
</script>

<svelte:head>
	<link rel="icon" href="/favicon.ico" sizes="any" />
	<link rel="icon" href="/pwa-192x192.png" type="image/png" />
	<title>Koworker AI — Точные науки</title>
	<meta name="description" content="AI-ассистент для решения инженерных и математических задач" />
</svelte:head>

{#if showInstallOffer}
	<section class="pwa-install-offer" aria-live="polite" aria-label="Install Koworker">
		<div class="pwa-install-copy">
			<h2>Установите Koworker на Android</h2>
			<p>Закрепите приложение на главном экране и открывайте его в одно касание.</p>
			{#if installHintText}
				<p class="pwa-install-hint">{installHintText}</p>
			{/if}
		</div>
		<div class="pwa-install-actions">
			<button class="pwa-install-btn primary" type="button" onclick={installPwa} disabled={installInProgress}>
				{#if installInProgress}
					Открываем...
				{:else if deferredInstallPrompt}
					Установить
				{:else}
					Как установить
				{/if}
			</button>
			<button class="pwa-install-btn secondary" type="button" onclick={dismissInstallOffer}>
				Позже
			</button>
		</div>
	</section>
{/if}

{@render children()}

<style>
	.pwa-install-offer {
		position: fixed;
		right: max(1rem, env(safe-area-inset-right));
		bottom: max(1rem, env(safe-area-inset-bottom));
		width: min(25rem, calc(100vw - 2rem));
		background: var(--bg-card);
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		padding: 0.85rem;
		z-index: 130;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.pwa-install-copy h2 {
		margin: 0;
		font-size: 0.96rem;
		font-weight: 650;
		color: var(--text-primary);
	}

	.pwa-install-copy p {
		margin: 0.35rem 0 0;
		font-size: 0.82rem;
		color: var(--text-secondary);
		line-height: 1.45;
	}

	.pwa-install-hint {
		margin-top: 0.45rem;
		color: var(--text-primary) !important;
	}

	.pwa-install-actions {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}

	.pwa-install-btn {
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-sm);
		background: var(--bg-elevated);
		color: var(--text-primary);
		padding: 0.5rem 0.72rem;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			opacity var(--transition-fast),
			border-color var(--transition-fast),
			transform var(--transition-fast);
	}

	.pwa-install-btn:hover:not(:disabled) {
		opacity: 0.94;
		border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
		transform: translateY(-1px);
	}

	.pwa-install-btn:disabled {
		opacity: 0.58;
		cursor: wait;
		transform: none;
	}

	.pwa-install-btn.primary {
		background: var(--accent-gradient);
		border-color: color-mix(in srgb, var(--accent-primary) 60%, transparent);
		color: #fff8f1;
	}

	@media (max-width: 700px) {
		.pwa-install-offer {
			left: max(0.7rem, env(safe-area-inset-left));
			right: max(0.7rem, env(safe-area-inset-right));
			width: auto;
			bottom: max(0.7rem, env(safe-area-inset-bottom));
		}

		.pwa-install-actions {
			flex-wrap: wrap;
		}
	}
</style>
