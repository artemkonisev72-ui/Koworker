<script lang="ts">
	import './layout.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/favicon.ico" sizes="any" />
	<link rel="icon" href="/pwa-192x192.png" type="image/png" />
	<title>Koworker AI — Точные науки</title>
	<meta name="description" content="AI-ассистент для решения инженерных и математических задач" />
</svelte:head>

{@render children()}
