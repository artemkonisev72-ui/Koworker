<script lang="ts">
	/**
	 * MessageRenderer.svelte
	 * Безопасный рендер Markdown + KaTeX + JSXGraph.
	 *
	 * Безопасность (XSS):
	 *   Все HTML-строки проходят через DOMPurify с белым списком тегов.
	 *   Разрешены только безопасные теги + классы KaTeX.
	 */
	import { onMount } from 'svelte';
	import GraphView from './GraphView.svelte';

	interface GraphPoint { x: number; y: number; }
	interface Message {
		id: string;
		role: 'USER' | 'ASSISTANT' | 'SYSTEM';
		content: string;
		graphData?: GraphPoint[] | null;
		createdAt?: string;
	}

	let { message }: { message: Message } = $props();

	let renderedHtml = $state('');

	// KaTeX-разрешённые классы (белый список для DOMPurify)
	const KATEX_CLASSES = /^(katex|katex-display|katex-html|katex-mathml|base|strut|mord|mbin|mrel|mopen|mclose|mpunct|mspace|minner|mop|accent|overline|underline|vlist|col-align|mtable|mrow|mfrac|msup|msub|munder|mover|msupsub|sqrt|rule|newline|arraycolsep|hline|mtd|mtr|mfrac|mstyle|mphantom|mpadded|menclose)(-[a-z]+)*$/;

	// DOMPurify конфигурация — только безопасные теги и KaTeX-классы
	const DOMPURIFY_CONFIG = {
		ALLOWED_TAGS: [
			'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del',
			'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
			'ul', 'ol', 'li',
			'blockquote', 'pre', 'code',
			'table', 'thead', 'tbody', 'tr', 'th', 'td',
			'hr', 'a', 'span', 'div',
			// KaTeX-specific
			'semantics', 'annotation', 'math', 'mrow', 'mi', 'mo', 'mn', 'msup',
			'msub', 'mfrac', 'msqrt', 'mover', 'munder', 'mtable', 'mtr', 'mtd'
		],
		ALLOWED_ATTR: ['class', 'href', 'style', 'aria-hidden', 'focusable', 'xmlns', 'encoding'],
		ALLOW_DATA_ATTR: false,
		FORCE_BODY: true,
		ALLOWED_URI_REGEXP: /^https?:/i,
		HOOK_EVENT: 'uponSanitizeAttribute',
	};

	onMount(async () => {
		await renderContent();
	});

	$effect(() => {
		message.content; // track
		renderContent();
	});

	async function renderContent() {
		if (!message.content) { renderedHtml = ''; return; }

		// Dynamic imports — browser only
		const [{ marked }, DOMPurifyModule, katex] = await Promise.all([
			import('marked'),
			import('dompurify'),
			import('katex')
		]);

		const DOMPurify = DOMPurifyModule.default;

		// Хук для проверки классов KaTeX
		DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
			if (data.attrName === 'class') {
				const classes = (data.attrValue || '').split(/\s+/);
				const allSafe = classes.every((c) => !c || KATEX_CLASSES.test(c) || /^prose/.test(c) || /^(hljs|language-)/.test(c));
				if (!allSafe) data.attrValue = '';
			}
		});

		// Настройка marked
		marked.setOptions({ breaks: true, gfm: true });

		// Рендерим KaTeX: заменяем $$...$$ и $...$ до Markdown-парсинга
		let processed = message.content;

		// $$...$$  → display math
		processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
			try { return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false }); }
			catch { return `<span class="katex-error">$$${_}$$</span>`; }
		});

		// $...$  → inline math (не-пустые, не-money)
		processed = processed.replace(/\$([^$\n]+?)\$/g, (_, math) => {
			if (/^\d/.test(math.trim())) return `$${math}$`; // Skip bare numbers like $42
			try { return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false }); }
			catch { return `<span class="katex-error">$${_}$</span>`; }
		});

		// Markdown → HTML
		const rawHtml = await marked.parse(processed);

		// Санитаризация DOMPurify
		const safeHtml = DOMPurify.sanitize(rawHtml, DOMPURIFY_CONFIG as Parameters<typeof DOMPurify.sanitize>[1]);

		renderedHtml = safeHtml;
	}
</script>

<div class="message-renderer prose">
	{#if renderedHtml}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html renderedHtml}
	{/if}

	{#if message.graphData && message.graphData.length >= 2}
		<GraphView points={message.graphData} title="График решения" />
	{/if}
</div>

<style>
	.message-renderer {
		width: 100%;
		overflow-wrap: break-word;
		word-break: break-word;
	}
</style>
