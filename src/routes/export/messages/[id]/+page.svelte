<script lang="ts">
	import { onMount } from 'svelte';
	import MessageRenderer from '$lib/components/MessageRenderer.svelte';

	let { data }: { data: import('./$types').PageData } = $props();

	let renderState = $state({
		ready: false,
		pendingBlocks: 1,
		failedBlocks: 0
	});
	let autoPrintDone = $state(false);
	let timedOut = $state(false);
	let timeoutHandle: number | undefined;

	function handleRenderStateChange(state: {
		ready: boolean;
		pendingBlocks: number;
		failedBlocks: number;
	}) {
		renderState = state;
	}

	async function triggerPrint(reason: 'ready' | 'timeout') {
		if (autoPrintDone) return;
		autoPrintDone = true;
		timedOut = reason === 'timeout';
		if (reason === 'timeout') {
			console.warn('[ExportPrint] Print fallback timeout reached', {
				pendingBlocks: renderState.pendingBlocks,
				failedBlocks: renderState.failedBlocks
			});
		}
		try {
			if ('fonts' in document) {
				await (document as Document & { fonts: FontFaceSet }).fonts.ready;
			}
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
			window.print();
		} catch (error) {
			console.error('[ExportPrint] Failed to open print dialog:', error);
		}
	}

	let createdAtLabel = $derived.by(() => {
		if (typeof data.message.createdAt !== 'string') return '';
		const parsed = new Date(data.message.createdAt);
		if (Number.isNaN(parsed.getTime())) return '';
		return parsed.toLocaleString('ru-RU', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
	});

	$effect(() => {
		if (!renderState.ready || autoPrintDone) return;
		if (timeoutHandle !== undefined) {
			window.clearTimeout(timeoutHandle);
			timeoutHandle = undefined;
		}
		void triggerPrint('ready');
	});

	onMount(() => {
		const root = document.documentElement;
		const previousExportMode = root.getAttribute('data-export-mode');
		root.setAttribute('data-export-mode', 'print');

		timeoutHandle = window.setTimeout(() => {
			if (autoPrintDone) return;
			void triggerPrint('timeout');
		}, 18_000);

		return () => {
			if (timeoutHandle !== undefined) {
				window.clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
			if (previousExportMode === null) {
				root.removeAttribute('data-export-mode');
			} else {
				root.setAttribute('data-export-mode', previousExportMode);
			}
		};
	});
</script>

<svelte:head>
	<title>PDF Export - {data.chat.title}</title>
</svelte:head>

<main class="export-page">
	<article class="export-sheet">
		<header class="export-header">
			<h1 class="export-title">{data.chat.title || 'Coworker solution export'}</h1>
			<div class="export-meta">
				<span>Message ID: {data.message.id}</span>
				{#if createdAtLabel}
					<span>Created: {createdAtLabel}</span>
				{/if}
			</div>
		</header>

		<MessageRenderer
			message={data.message}
			renderMode="print"
			onRenderStateChange={handleRenderStateChange}
		/>

		{#if !autoPrintDone && !renderState.ready}
			<div class="export-status">Preparing printable layout... pending blocks: {renderState.pendingBlocks}</div>
		{:else if timedOut}
			<div class="export-status warning">
				Some visual blocks did not finish in time. Check preview before saving.
			</div>
		{/if}
	</article>
</main>

<style>
	:global(:root[data-export-mode='print']) {
		color-scheme: light;
		--bg-base: #ffffff;
		--bg-surface: #ffffff;
		--bg-elevated: #f7f7f7;
		--bg-card: #ffffff;
		--bg-input: #ffffff;
		--border-subtle: #d9d9d9;
		--border-medium: #c6c6c6;
		--text-primary: #1f1f1f;
		--text-secondary: #3b3b3b;
		--text-muted: #686868;
		--text-code: #1f1f1f;
		--accent-primary: #2f5d8c;
		--accent-secondary: #1f4a74;
		--accent-soft: rgba(47, 93, 140, 0.16);
		--shadow-sm: none;
		--shadow-md: none;
		--shadow-lg: none;
	}

	:global(:root[data-export-mode='print'] body) {
		background: #ffffff;
		color: #1f1f1f;
		overflow: auto;
	}

	.export-page {
		min-height: 100dvh;
		background: #ffffff;
		padding: 1.2rem;
	}

	.export-sheet {
		width: min(100%, 190mm);
		margin: 0 auto;
		padding: 0.9rem 0.5rem 1.2rem;
	}

	.export-header {
		margin-bottom: 0.8rem;
		padding-bottom: 0.6rem;
		border-bottom: 1px solid #d7d7d7;
	}

	.export-title {
		font-size: 1.15rem;
		font-weight: 600;
		color: #1f1f1f;
		margin: 0;
	}

	.export-meta {
		margin-top: 0.3rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.8rem;
		font-size: 0.76rem;
		color: #555555;
	}

	.export-status {
		margin-top: 0.9rem;
		font-size: 0.78rem;
		color: #555555;
	}

	.export-status.warning {
		color: #a34720;
	}

	.export-sheet :global(.message-actions),
	.export-sheet :global(.graph-fullscreen-btn),
	.export-sheet :global(.scheme-fullscreen-btn),
	.export-sheet :global(.graph-loading),
	.export-sheet :global(.scheme-loading),
	.export-sheet :global(.scheme-debug),
	.export-sheet :global(.graph-fullscreen-hint),
	.export-sheet :global(.scheme-fullscreen-hint) {
		display: none !important;
	}

	.export-sheet :global(.scheme-wrapper),
	.export-sheet :global(.graph-wrapper),
	.export-sheet :global(.scheme-description-card),
	.export-sheet :global(.exact-answers-card),
	.export-sheet :global(.models-attribution),
	.export-sheet :global(.katex-display),
	.export-sheet :global(table) {
		break-inside: avoid-page;
		page-break-inside: avoid;
	}

	@media (max-width: 900px) {
		.export-page {
			padding: 0.8rem;
		}

		.export-sheet {
			width: 100%;
			padding: 0.5rem 0.2rem 0.9rem;
		}
	}

	@page {
		size: A4 portrait;
		margin: 12mm;
	}

	@media print {
		.export-page {
			padding: 0;
			background: #ffffff;
		}

		.export-sheet {
			width: 100%;
			margin: 0;
			padding: 0;
		}

		.export-status {
			display: none;
		}
	}
</style>
