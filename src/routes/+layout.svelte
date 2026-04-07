<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Koworker AI — Точные науки</title>
	<meta name="description" content="AI-ассистент для решения инженерных и математических задач" />
</svelte:head>

{@render children()}
