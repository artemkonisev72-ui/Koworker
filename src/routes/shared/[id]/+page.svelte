<script lang="ts">
	import MessageRenderer from '$lib/components/MessageRenderer.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.chat.title} — Koworker Shared</title>
</svelte:head>

<div class="shared-container">
	<header class="shared-header">
		<div class="header-content">
			<div class="logo">
				<img
					src="/favicon.svg"
					alt="Koworker Logo"
					width="24"
					height="24"
					style="object-fit: contain;"
				/>
				<span class="logo-text">Koworker</span>
				<span class="badge">SHARED</span>
			</div>
			<h1>{data.chat.title}</h1>
			<div class="meta">
				Создано: {new Date(data.chat.createdAt).toLocaleDateString()}
			</div>
		</div>
	</header>

	<main class="message-list">
		{#each data.messages as message}
			<MessageRenderer message={message as any} />
		{/each}
	</main>

	<footer class="shared-footer">
		<p>
			Это публичная копия чата. Чтобы создать свой проект, <a href="/login">войдите в систему</a>.
		</p>
	</footer>
</div>

<style>
	:global(html),
	:global(body) {
		overflow: auto !important;
	}

	.shared-container {
		max-width: 900px;
		margin: 0 auto;
		padding: calc(2rem + env(safe-area-inset-top)) calc(1rem + env(safe-area-inset-right))
			calc(1.5rem + env(safe-area-inset-bottom)) calc(1rem + env(safe-area-inset-left));
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}

	.shared-header {
		margin-bottom: 2rem;
		padding-bottom: 1.5rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.header-content {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
	}

	.logo-text {
		font-family: var(--font-serif);
		font-weight: 600;
		letter-spacing: -0.015em;
		font-size: 1.25rem;
	}

	.badge {
		font-size: 0.65rem;
		font-weight: 700;
		padding: 2px 6px;
		background: var(--bg-surface);
		border: 1px solid var(--border-medium);
		border-radius: 4px;
		color: var(--text-secondary);
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0;
	}

	.meta {
		font-size: 0.875rem;
		color: var(--text-tertiary);
	}

	.message-list {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.shared-footer {
		margin-top: 4rem;
		padding: 2rem 0;
		text-align: center;
		border-top: 1px solid var(--border-subtle);
		color: var(--text-tertiary);
		font-size: 0.875rem;
	}

	.shared-footer a {
		color: var(--accent-primary);
		text-decoration: underline;
		font-weight: 500;
	}
</style>
