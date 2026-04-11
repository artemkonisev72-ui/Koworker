<script lang="ts">
	/**
	 * MessageRenderer.svelte
	 * Safe Markdown + KaTeX renderer with graph/scheme visual blocks.
	 */
	import { onMount } from 'svelte';
	import GraphView from './GraphView.svelte';
	import SchemeView from './SchemeView.svelte';
	import { isSchemaDataV2 } from '$lib/schema/schema-v2.js';

	interface GraphPoint {
		x: number;
		y: number;
	}
	interface GraphData {
		title?: string;
		type?: 'function' | 'diagram';
		points: GraphPoint[];
	}
	interface Message {
		id: string;
		role: 'USER' | 'ASSISTANT' | 'SYSTEM';
		content: string;
		graphData?: GraphData[] | string | null;
		schemaData?: unknown;
		schemaVersion?: string | null;
		usedModels?: string[] | string | null;
		createdAt?: string;
	}

	let { message, schemeDebug = false }: { message: Message; schemeDebug?: boolean } = $props();

	let renderedHtml = $state('');

	let usedModels = $derived.by(() => {
		if (!message.usedModels) return [];
		if (typeof message.usedModels === 'string') {
			try {
				return JSON.parse(message.usedModels) as string[];
			} catch {
				return [];
			}
		}
		return message.usedModels as string[];
	});

	let graphs = $derived.by(() => {
		if (!message.graphData) return [];
		if (typeof message.graphData === 'string') {
			try {
				return JSON.parse(message.graphData) as GraphData[];
			} catch {
				return [];
			}
		}
		return message.graphData as GraphData[];
	});

	let schemes = $derived.by(() => {
		if (!message.schemaData) return [] as unknown[];
		const raw = message.schemaData;
		let parsed: unknown = raw;
		if (typeof raw === 'string') {
			try {
				parsed = JSON.parse(raw);
			} catch {
				return [] as unknown[];
			}
		}
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const schema = parsed as Record<string, unknown>;
			if (Array.isArray(schema.elements)) return [schema];
			if (isSchemaDataV2(schema)) return [schema];
		}
		return [] as unknown[];
	});

	const KATEX_CLASSES =
		/^(katex|katex-display|katex-html|katex-mathml|base|strut|mord|mbin|mrel|mopen|mclose|mpunct|mspace|minner|mop|accent|overline|underline|vlist|col-align|mtable|mrow|mfrac|msup|msub|munder|mover|msupsub|sqrt|rule|newline|arraycolsep|hline|mtd|mtr|mfrac|mstyle|mphantom|mpadded|menclose)(-[a-z]+)*$/;

	const DOMPURIFY_CONFIG = {
		ALLOWED_TAGS: [
			'p',
			'br',
			'b',
			'strong',
			'i',
			'em',
			'u',
			's',
			'del',
			'h1',
			'h2',
			'h3',
			'h4',
			'h5',
			'h6',
			'ul',
			'ol',
			'li',
			'blockquote',
			'pre',
			'code',
			'table',
			'thead',
			'tbody',
			'tr',
			'th',
			'td',
			'hr',
			'a',
			'span',
			'div',
			'semantics',
			'annotation',
			'math',
			'mrow',
			'mi',
			'mo',
			'mn',
			'msup',
			'msub',
			'mfrac',
			'msqrt',
			'mover',
			'munder',
			'mtable',
			'mtr',
			'mtd'
		],
		ALLOWED_ATTR: ['class', 'href', 'style', 'aria-hidden', 'focusable', 'xmlns', 'encoding'],
		FORCE_BODY: true
	};

	onMount(() => renderContent());
	$effect(() => {
		message.content;
		renderContent();
	});

	async function renderContent() {
		if (!message.content) {
			renderedHtml = '';
			return;
		}

		const [{ marked }, DOMPurifyModule, katex] = await Promise.all([
			import('marked'),
			import('dompurify'),
			import('katex')
		]);

		const DOMPurify = DOMPurifyModule.default;
		DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
			if (data.attrName === 'class') {
				const classes = (data.attrValue || '').split(/\s+/);
				const allSafe = classes.every(
					(c) => !c || KATEX_CLASSES.test(c) || /^prose/.test(c) || /^(hljs|language-)/.test(c)
				);
				if (!allSafe) data.attrValue = '';
			}
		});

		marked.setOptions({ breaks: true, gfm: true });
		let processed = message.content;

		processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
			try {
				return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false });
			} catch {
				return `<span class="katex-error">$$${_}$$</span>`;
			}
		});

		processed = processed.replace(/\$([^$\n]+?)\$/g, (_, math) => {
			if (/^\d/.test(math.trim()) && !math.includes('=') && !math.includes('\\')) return `$${math}$`;
			try {
				return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
			} catch {
				return `<span class="katex-error">$${_}$</span>`;
			}
		});

		const rawHtml = await marked.parse(processed);
		renderedHtml = DOMPurify.sanitize(rawHtml, DOMPURIFY_CONFIG as any) as unknown as string;
	}
</script>

<div class="message-renderer prose">
	{#if renderedHtml}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html renderedHtml}
	{/if}

	{#if schemes.length > 0}
		<div class="schemes-container">
			{#each schemes as schema, index}
				<SchemeView schemaData={schema} title={`Scheme revision #${index + 1}`} debug={schemeDebug} />
			{/each}
		</div>
	{/if}

	{#if graphs.length > 0}
		<div class="graphs-container">
			{#each graphs as graph}
				<GraphView points={graph.points} title={graph.title || 'Solution graph'} type={graph.type} />
			{/each}
		</div>
	{/if}

	{#if usedModels.length > 0}
		<div class="models-attribution">
			<span class="attribution-label">Models:</span>
			{usedModels.join(', ')}
		</div>
	{/if}
</div>

<style>
	.message-renderer {
		width: 100%;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.schemes-container,
	.graphs-container {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		margin-top: 1rem;
	}

	.models-attribution {
		margin-top: 1.25rem;
		padding-top: 0.75rem;
		border-top: 1px dashed var(--border-subtle);
		font-size: 0.75rem;
		color: var(--text-muted);
		font-family: var(--font-mono);
		opacity: 0.8;
	}

	.attribution-label {
		font-weight: 600;
		color: var(--text-secondary);
		margin-right: 0.4rem;
	}
</style>
