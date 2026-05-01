<script lang="ts">
	/**
	 * MessageRenderer.svelte
	 * Safe Markdown + KaTeX renderer with graph/scheme visual blocks.
	 */
	import { onMount } from 'svelte';
	import GraphView from './GraphView.svelte';
	import SchemeView from './SchemeView.svelte';
	import { isSchemaDataV2, type SchemaDataV2 } from '$lib/schema/schema-v2.js';
	import { normalizeSchemaDataV2 } from '$lib/schema/normalize-v2.js';
	import {
		formatGraphDisplayTitle,
		formatGraphMemberLabel,
		normalizeGraphEpure,
		type GraphData
	} from '$lib/graphs/types.js';
	interface GraphGroup {
		memberId: string | null;
		items: GraphData[];
	}
	interface Message {
		id: string;
		role: 'USER' | 'ASSISTANT' | 'SYSTEM';
		content: string;
		graphData?: GraphData[] | string | null;
		exactAnswers?: unknown;
		schemaData?: unknown;
		schemaDescription?: string | null;
		schemaVersion?: string | null;
		usedModels?: string[] | string | null;
		createdAt?: string;
		isStreaming?: boolean;
	}

	type StructureKind =
		| 'beam'
		| 'planar_frame'
		| 'spatial_frame'
		| 'planar_mechanism'
		| 'spatial_mechanism';
	const FRAME_COMPONENT_ORDER = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'] as const;
	type RenderMode = 'chat' | 'print';

	type ExportActionId = 'pdf';
	interface RenderState {
		ready: boolean;
		pendingBlocks: number;
		failedBlocks: number;
	}

	let {
		message,
		schemeDebug = false,
		renderMode = 'chat',
		onRenderStateChange
	}: {
		message: Message;
		schemeDebug?: boolean;
		renderMode?: RenderMode;
		onRenderStateChange?: (state: RenderState) => void;
	} = $props();

	let renderedHtml = $state('');
	let exportControlsEl: HTMLDivElement | undefined = $state();
	let menuOpen = $state(false);
	let isExporting = $state(false);
	let exportError = $state('');
	let markdownReady = $state(false);
	let graphReadyMap = $state<Record<string, true>>({});
	let schemeReadyMap = $state<Record<string, true>>({});
	let failedBlocks = $state(0);
	let renderCycle = 0;

	let isPrintMode = $derived(renderMode === 'print');

	const TEXT_EXPORT = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442';
	const TEXT_EXPORTING = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442\u0438\u0440\u0443\u0435\u0442\u0441\u044f...';
	const TEXT_EXPORT_TO_PDF = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u0432 PDF';
	const TEXT_EXPORT_ERROR =
		'\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u0444\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u0442\u044c PDF. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0441\u043d\u043e\u0432\u0430.';
	const TEXT_EXPORT_MENU_ARIA = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f';

	const exportActions: Array<{ id: ExportActionId; label: string }> = [
		{ id: 'pdf', label: TEXT_EXPORT_TO_PDF }
	];

	let canExport = $derived(!isPrintMode && message.role === 'ASSISTANT' && !message.isStreaming);

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
				return (JSON.parse(message.graphData) as GraphData[]).map((graph) => normalizeGraphEpure(graph).graph);
			} catch {
				return [];
			}
		}
		return (message.graphData as GraphData[]).map((graph) => normalizeGraphEpure(graph).graph);
	});

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function normalizeStructureKind(value: unknown): StructureKind {
		if (typeof value !== 'string') return 'beam';
		const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
		if (
			normalized === 'beam' ||
			normalized === 'planar_frame' ||
			normalized === 'spatial_frame' ||
			normalized === 'planar_mechanism' ||
			normalized === 'spatial_mechanism'
		) {
			return normalized;
		}
		return 'beam';
	}

	function resolveStructureKind(schema: SchemaDataV2): StructureKind {
		const fromMeta = normalizeStructureKind(schema.meta?.structureKind);
		if (fromMeta !== 'beam') return fromMeta;
		if (schema.coordinateSystem?.modelSpace === 'spatial') return 'spatial_frame';
		return fromMeta;
	}

	function buildGraphGroups(items: GraphData[]): GraphGroup[] {
		const groups = new Map<string, GraphGroup>();
		for (const graph of items) {
			if (!graph || !Array.isArray(graph.points) || graph.points.length < 2) continue;
			const memberId =
				typeof graph.memberId === 'string' && graph.memberId.trim().length > 0
					? graph.memberId.trim()
					: null;
			const key = memberId ?? '__general__';
			if (!groups.has(key)) {
				groups.set(key, { memberId, items: [] });
			}
			groups.get(key)?.items.push(graph);
		}
		return Array.from(groups.values()).sort((a, b) => {
			if (a.memberId === null && b.memberId !== null) return 1;
			if (a.memberId !== null && b.memberId === null) return -1;
			return (a.memberId ?? '').localeCompare(b.memberId ?? '');
		});
	}

	let graphGroups = $derived.by(() => {
		return buildGraphGroups(graphs);
	});

	let schemes = $derived.by(() => {
		if (!message.schemaData) return [] as SchemaDataV2[];
		const raw = message.schemaData;
		let parsed: unknown = raw;
		if (typeof raw === 'string') {
			try {
				parsed = JSON.parse(raw);
			} catch {
				return [] as SchemaDataV2[];
			}
		}
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const schema = parsed as Record<string, unknown>;
			if (Array.isArray(schema.elements) || isSchemaDataV2(schema)) {
				return [normalizeSchemaDataV2(schema).value];
			}
		}
		return [] as SchemaDataV2[];
	});

	let schemeDescription = $derived.by(() => {
		if (typeof message.schemaDescription !== 'string') return '';
		const normalized = message.schemaDescription.trim();
		return normalized.length > 0 ? normalized : '';
	});

	let exactAnswers = $derived.by(() => {
		if (!message.exactAnswers) return [] as Array<Record<string, unknown>>;
		const raw = message.exactAnswers;
		let parsed: unknown = raw;
		if (typeof raw === 'string') {
			try {
				parsed = JSON.parse(raw);
			} catch {
				return [] as Array<Record<string, unknown>>;
			}
		}
		if (!Array.isArray(parsed)) return [] as Array<Record<string, unknown>>;
		return parsed.filter((entry): entry is Record<string, unknown> => isRecord(entry));
	});

	function isMostlyRussian(text: string): boolean {
		const cyrillicCount = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
		const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
		if (cyrillicCount === 0 && latinCount === 0) return false;
		return cyrillicCount >= latinCount * 0.6;
	}

	let schemeDescriptionTitle = $derived.by(() => {
		if (schemeDescription) {
			return isMostlyRussian(schemeDescription) ? 'Описание схемы' : 'Scheme description';
		}
		return 'Scheme description';
	});

	let frameGraphGroups = $derived.by(() => {
		const frameGraphs: GraphData[] = [];

		for (const schema of schemes) {
			const structureKind = resolveStructureKind(schema);
			if (structureKind !== 'planar_frame' && structureKind !== 'spatial_frame') continue;

			for (const result of schema.results ?? []) {
				if (result.type !== 'epure' || !isRecord(result.geometry) || !Array.isArray(result.geometry.values)) {
					continue;
				}
				const component =
					typeof result.geometry.component === 'string' && result.geometry.component.trim()
						? result.geometry.component.trim()
						: null;
				if (!component) continue;

				const points = result.geometry.values
					.map((entry) => {
						if (!isRecord(entry)) return null;
						const x = typeof entry.s === 'number' && Number.isFinite(entry.s) ? entry.s : null;
						const y = typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : null;
						if (x === null || y === null) return null;
						return { x, y };
					})
					.filter((entry): entry is { x: number; y: number } => Boolean(entry))
					.sort((a, b) => a.x - b.x);
				if (points.length < 2) continue;

				const meta = isRecord(result.meta) ? result.meta : null;
				const memberIdRaw = typeof meta?.baseObjectId === 'string' ? meta.baseObjectId.trim() : '';
				const memberId = memberIdRaw.length > 0 ? memberIdRaw : undefined;
				const epureKind =
					component === 'N' ? 'N'
						: component === 'Vy' ? 'Q'
						: component === 'Mz' ? 'M'
						: 'custom';
				const compressedFiberSide =
					result.geometry.compressedFiberSide === '+n' || result.geometry.compressedFiberSide === '-n'
						? result.geometry.compressedFiberSide
						: undefined;
				const axisOrigin =
					result.geometry.axisOrigin === 'auto' ||
					result.geometry.axisOrigin === 'free_end' ||
					result.geometry.axisOrigin === 'fixed_end' ||
					result.geometry.axisOrigin === 'member_start' ||
					result.geometry.axisOrigin === 'member_end'
						? result.geometry.axisOrigin
						: undefined;
				const normalizedGraph = normalizeGraphEpure({
					type: 'diagram',
					memberId,
					diagramType: component,
					points,
					epure: {
						kind: epureKind,
						component:
							component === 'N' || component === 'Vy' || component === 'Vz' || component === 'T' || component === 'My' || component === 'Mz'
								? component
								: undefined,
						fillHatch: result.geometry.fillHatch !== false,
						showSigns: result.geometry.showSigns !== false,
						...(axisOrigin ? { axisOrigin } : {}),
						...(compressedFiberSide ? { compressedFiberSide } : {})
					}
				}).graph;

				frameGraphs.push(normalizedGraph);
			}
		}

		const componentRank = (diagramType: string | undefined): number => {
			if (!diagramType) return FRAME_COMPONENT_ORDER.length + 1;
			const index = FRAME_COMPONENT_ORDER.indexOf(diagramType as (typeof FRAME_COMPONENT_ORDER)[number]);
			return index >= 0 ? index : FRAME_COMPONENT_ORDER.length;
		};

		frameGraphs.sort((a, b) => {
			const memberCmp = (a.memberId ?? '').localeCompare(b.memberId ?? '');
			if (memberCmp !== 0) return memberCmp;
			return componentRank(a.diagramType) - componentRank(b.diagramType);
		});

		return buildGraphGroups(frameGraphs);
	});

	let visibleGraphGroups = $derived.by(() => {
		const groups: GraphGroup[] = [];
		if (frameGraphGroups.length > 0) groups.push(...frameGraphGroups);
		if (graphGroups.length > 0) groups.push(...graphGroups);
		return groups;
	});

	interface GraphRenderItem {
		key: string;
		groupTitle: string | null;
		graph: GraphData;
		title: string;
	}

	let graphRenderItems = $derived.by(() => {
		const items: GraphRenderItem[] = [];
		let globalIndex = 0;
		for (const group of visibleGraphGroups) {
			const groupTitle = group.memberId ? formatGraphMemberLabel(group.memberId) : null;
			for (let index = 0; index < group.items.length; index += 1) {
				const graph = group.items[index];
				items.push({
					key: `graph-${globalIndex}`,
					groupTitle: index === 0 ? groupTitle : null,
					graph,
					title: formatGraphDisplayTitle(graph)
				});
				globalIndex += 1;
			}
		}
		return items;
	});

	interface SchemeRenderItem {
		key: string;
		schema: SchemaDataV2;
		title: string;
	}

	let schemeRenderItems = $derived.by(() => {
		const renderable = schemes.filter(
			(schema) => Array.isArray(schema.objects) && schema.objects.length > 0
		);
		return renderable.map((schema, index) => ({
			key: `scheme-${index}`,
			schema,
			title: `Scheme revision #${index + 1}`
		}));
	});

	let renderedGraphCount = $derived(Object.keys(graphReadyMap).length);
	let renderedSchemeCount = $derived(Object.keys(schemeReadyMap).length);
	let pendingBlocks = $derived(
		(markdownReady ? 0 : 1) +
			Math.max(0, graphRenderItems.length - renderedGraphCount) +
			Math.max(0, schemeRenderItems.length - renderedSchemeCount)
	);
	let renderReady = $derived(
		markdownReady &&
			renderedGraphCount >= graphRenderItems.length &&
			renderedSchemeCount >= schemeRenderItems.length
	);

	const SAFE_CLASS_TOKEN = /^[A-Za-z0-9_-]+$/;

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
		ALLOWED_ATTR: ['class', 'href', 'style', 'align', 'aria-hidden', 'focusable', 'xmlns', 'encoding'],
		FORCE_BODY: true
	};

	function markGraphRendered(key: string, failed = false) {
		if (graphReadyMap[key]) return;
		graphReadyMap = { ...graphReadyMap, [key]: true };
		if (failed) failedBlocks += 1;
	}

	function markSchemeRendered(key: string, failed = false) {
		if (schemeReadyMap[key]) return;
		schemeReadyMap = { ...schemeReadyMap, [key]: true };
		if (failed) failedBlocks += 1;
	}

	function escapeHtml(text: string): string {
		return text
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	onMount(() => renderContent());
	onMount(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!menuOpen) return;
			const target = event.target as Node | null;
			if (!target) return;
			if (exportControlsEl?.contains(target)) return;
			menuOpen = false;
		};
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && menuOpen) menuOpen = false;
		};
		document.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('keydown', onKeydown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('keydown', onKeydown);
		};
	});

	$effect(() => {
		message.content;
		renderContent();
	});

	$effect(() => {
		message.id;
		menuOpen = false;
		exportError = '';
		markdownReady = false;
		graphReadyMap = {};
		schemeReadyMap = {};
		failedBlocks = 0;
	});

	$effect(() => {
		if (!canExport) {
			menuOpen = false;
			exportError = '';
		}
	});

	$effect(() => {
		onRenderStateChange?.({
			ready: renderReady,
			pendingBlocks,
			failedBlocks
		});
	});

	function toggleExportMenu() {
		if (isExporting) return;
		exportError = '';
		menuOpen = !menuOpen;
	}

	async function exportAsPdf() {
		if (isExporting) return;
		isExporting = true;
		menuOpen = false;
		exportError = '';

		try {
			const exportUrl = `/export/messages/${encodeURIComponent(message.id)}`;
			const popup = window.open(exportUrl, '_blank', 'noopener,noreferrer');
			if (!popup) {
				window.location.assign(exportUrl);
			}
		} catch (err) {
			console.error('[Export] PDF export failed:', err);
			exportError = TEXT_EXPORT_ERROR;
		} finally {
			isExporting = false;
		}
	}

	async function handleExport(actionId: ExportActionId) {
		if (actionId === 'pdf') {
			await exportAsPdf();
		}
	}

	async function renderContent() {
		const currentCycle = ++renderCycle;
		markdownReady = false;
		if (!message.content) {
			renderedHtml = '';
			if (currentCycle === renderCycle) {
				markdownReady = true;
			}
			return;
		}

		try {
			const [{ marked }, DOMPurifyModule, katex] = await Promise.all([
				import('marked'),
				import('dompurify'),
				import('katex')
			]);

			const DOMPurify = DOMPurifyModule.default;
			DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
				if (data.attrName === 'class') {
					const classes = (data.attrValue || '').split(/\s+/).filter(Boolean);
					const safeClasses = classes.filter((c) => SAFE_CLASS_TOKEN.test(c));
					data.attrValue = safeClasses.join(' ');
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
			const tableWrappedHtml = rawHtml
				.replace(/<table(\s[^>]*)?>/g, '<div class="markdown-table-wrap"><table$1>')
				.replace(/<\/table>/g, '</table></div>');
			if (currentCycle !== renderCycle) return;
			renderedHtml = DOMPurify.sanitize(tableWrappedHtml, DOMPURIFY_CONFIG as any) as unknown as string;
		} catch (error) {
			console.error('[MessageRenderer] Failed to render markdown content:', error);
			if (currentCycle !== renderCycle) return;
			renderedHtml = `<p>${escapeHtml(message.content)}</p>`;
			failedBlocks += 1;
		} finally {
			if (currentCycle === renderCycle) {
				markdownReady = true;
			}
		}
	}
</script>

<div class="message-renderer prose" class:is-exporting={isExporting} class:print-mode={isPrintMode}>
	<div class="message-export-root">
		{#if renderedHtml}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html renderedHtml}
		{/if}

		{#if schemeRenderItems.length > 0}
			<div class="schemes-container">
				{#each schemeRenderItems as item (item.key)}
					<SchemeView
						schemaData={item.schema}
						title={item.title}
						debug={schemeDebug}
						{renderMode}
						onRenderReady={() => markSchemeRendered(item.key)}
						onRenderError={() => markSchemeRendered(item.key, true)}
					/>
				{/each}
			</div>
		{/if}

		{#if schemes.length > 0 && schemeDescription}
			<div class="scheme-description-card">
				<div class="scheme-description-title">{schemeDescriptionTitle}</div>
				<div class="scheme-description-body">{schemeDescription}</div>
			</div>
		{/if}

		{#if graphRenderItems.length > 0}
			<div class="graphs-container">
				{#each graphRenderItems as item (item.key)}
					{#if item.groupTitle}
						<div class="graph-group-title">{item.groupTitle}</div>
					{/if}
					<GraphView
						graph={item.graph}
						title={item.title}
						{renderMode}
						onRenderReady={() => markGraphRendered(item.key)}
						onRenderError={() => markGraphRendered(item.key, true)}
					/>
				{/each}
			</div>
		{/if}

		{#if exactAnswers.length > 0}
			<div class="exact-answers-card">
				<div class="exact-answers-title">Exact answers</div>
				<div class="exact-answers-list">
					{#each exactAnswers as answer, index}
						<div class="exact-answer-row">
							<span class="exact-answer-label">
								{typeof answer.label === 'string' && answer.label.trim()
									? answer.label
									: `Answer ${index + 1}`}
							</span>
							<span class="exact-answer-value">
								{typeof answer.valueText === 'string' && answer.valueText.trim()
									? answer.valueText
									: typeof answer.numericValue === 'number'
										? answer.numericValue
										: '-'}
								{typeof answer.unit === 'string' && answer.unit.trim() ? ` ${answer.unit}` : ''}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if usedModels.length > 0}
			<div class="models-attribution">
				<span class="attribution-label">Models:</span>
				{usedModels.join(', ')}
			</div>
		{/if}
	</div>

	{#if canExport}
		<div class="message-actions" bind:this={exportControlsEl}>
			<button
				class="message-action-btn"
				type="button"
				onclick={toggleExportMenu}
				disabled={isExporting}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
			>
				{isExporting ? TEXT_EXPORTING : TEXT_EXPORT}
			</button>

			{#if menuOpen}
				<div class="message-actions-menu" role="menu" aria-label={TEXT_EXPORT_MENU_ARIA}>
					{#each exportActions as action}
						<button
							class="message-actions-menu-item"
							type="button"
							role="menuitem"
							onclick={() => void handleExport(action.id)}
							disabled={isExporting}
						>
							{action.label}
						</button>
					{/each}
				</div>
			{/if}

			{#if exportError}
				<div class="message-actions-error">{exportError}</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.message-renderer {
		width: 100%;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.message-export-root {
		position: relative;
	}

	.schemes-container,
	.graphs-container {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		margin-top: 1rem;
	}

	.scheme-description-card {
		margin-top: 0.9rem;
		padding: 0.85rem 0.95rem;
		border: 1px solid var(--border-medium);
		background: color-mix(in srgb, var(--bg-surface) 68%, transparent);
		border-radius: 0.65rem;
	}

	.exact-answers-card {
		margin-top: 0.9rem;
		padding: 0.85rem 0.95rem;
		border: 1px solid var(--border-medium);
		background: color-mix(in srgb, var(--bg-surface) 72%, transparent);
		border-radius: 0.65rem;
	}

	.exact-answers-title {
		font-size: 0.76rem;
		font-weight: 700;
		color: var(--text-secondary);
		letter-spacing: 0.03em;
		text-transform: uppercase;
		margin-bottom: 0.45rem;
	}

	.exact-answers-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.exact-answer-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.9rem;
		font-size: 0.88rem;
		line-height: 1.45;
	}

	.exact-answer-label {
		color: var(--text-secondary);
	}

	.exact-answer-value {
		font-family: var(--font-mono);
		font-weight: 600;
		color: var(--text-primary);
	}

	.scheme-description-title {
		font-size: 0.76rem;
		font-weight: 700;
		color: var(--text-secondary);
		letter-spacing: 0.03em;
		text-transform: uppercase;
		margin-bottom: 0.45rem;
	}

	.scheme-description-body {
		white-space: pre-wrap;
		font-size: 0.9rem;
		line-height: 1.45;
		color: var(--text-primary);
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

	.graph-group-title {
		margin: 0.25rem 0 -0.65rem;
		padding-left: 0.1rem;
		font-size: 0.73rem;
		font-weight: 600;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.message-renderer.print-mode .scheme-description-card,
	.message-renderer.print-mode .exact-answers-card,
	.message-renderer.print-mode .models-attribution,
	.message-renderer.print-mode .graph-group-title {
		break-inside: avoid-page;
		page-break-inside: avoid;
	}

	.message-renderer.print-mode .graph-group-title {
		break-after: avoid-page;
		page-break-after: avoid;
	}

	.message-renderer.print-mode :global(.katex-display),
	.message-renderer.print-mode :global(table) {
		break-inside: avoid-page;
		page-break-inside: avoid;
	}

	.message-renderer :global(.markdown-table-wrap) {
		max-width: 100%;
		margin: 1rem 0 1.15rem;
		overflow-x: auto;
		overflow-y: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--bg-card) 88%, var(--bg-surface));
		box-shadow: 0 1px 0 color-mix(in srgb, var(--border-subtle) 70%, transparent);
		scrollbar-gutter: stable;
		-webkit-overflow-scrolling: touch;
	}

	.message-renderer :global(.markdown-table-wrap table) {
		width: max-content;
		min-width: 100%;
		margin: 0;
		border-collapse: separate;
		border-spacing: 0;
		font-size: 0.88rem;
		line-height: 1.45;
		color: var(--text-primary);
	}

	.message-renderer :global(.markdown-table-wrap thead th) {
		background: color-mix(in srgb, var(--bg-surface) 82%, var(--accent-soft));
		color: var(--text-primary);
		font-weight: 700;
	}

	.message-renderer :global(.markdown-table-wrap th),
	.message-renderer :global(.markdown-table-wrap td) {
		min-width: 7rem;
		padding: 0.62rem 0.75rem;
		border-right: 1px solid var(--border-subtle);
		border-bottom: 1px solid var(--border-subtle);
		text-align: left;
		vertical-align: top;
		overflow-wrap: normal;
		word-break: normal;
		hyphens: none;
		font-variant-numeric: tabular-nums;
	}

	.message-renderer :global(.markdown-table-wrap th:first-child),
	.message-renderer :global(.markdown-table-wrap td:first-child) {
		width: 1%;
		min-width: 3.5rem;
		text-align: center;
		white-space: nowrap;
	}

	.message-renderer :global(.markdown-table-wrap th:nth-child(2)),
	.message-renderer :global(.markdown-table-wrap td:nth-child(2)) {
		min-width: 12rem;
	}

	.message-renderer :global(.markdown-table-wrap th:last-child),
	.message-renderer :global(.markdown-table-wrap td:last-child) {
		border-right: none;
	}

	.message-renderer :global(.markdown-table-wrap tbody tr:last-child td) {
		border-bottom: none;
	}

	.message-renderer :global(.markdown-table-wrap tbody tr:nth-child(even) td) {
		background: color-mix(in srgb, var(--bg-surface) 48%, transparent);
	}

	.message-renderer :global(.markdown-table-wrap tbody tr:hover td) {
		background: color-mix(in srgb, var(--accent-soft) 32%, transparent);
	}

	.message-renderer :global(.markdown-table-wrap th[align='center']),
	.message-renderer :global(.markdown-table-wrap td[align='center']) {
		text-align: center;
	}

	.message-renderer :global(.markdown-table-wrap th[align='right']),
	.message-renderer :global(.markdown-table-wrap td[align='right']) {
		text-align: right;
	}

	.message-renderer :global(.markdown-table-wrap p) {
		margin: 0;
	}

	.message-renderer :global(.markdown-table-wrap .katex),
	.message-renderer :global(.markdown-table-wrap code) {
		white-space: nowrap;
	}

	.message-renderer.print-mode :global(.markdown-table-wrap) {
		overflow: visible;
		box-shadow: none;
	}

	.attribution-label {
		font-weight: 600;
		color: var(--text-secondary);
		margin-right: 0.4rem;
	}

	.message-actions {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.35rem;
		margin-top: 0.85rem;
	}

	.message-action-btn {
		border: 1px solid var(--border-subtle);
		background: var(--bg-card);
		color: var(--text-secondary);
		border-radius: var(--radius-sm);
		font-size: 0.72rem;
		font-weight: 600;
		padding: 0.28rem 0.56rem;
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			color var(--transition-fast),
			opacity var(--transition-fast);
	}

	.message-action-btn:hover:not(:disabled) {
		border-color: var(--accent-primary);
		color: var(--text-primary);
	}

	.message-action-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.message-actions-menu {
		position: absolute;
		top: calc(100% + 0.35rem);
		left: 0;
		min-width: 170px;
		padding: 0.25rem;
		background: var(--bg-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-md);
		z-index: 20;
	}

	.message-actions-menu-item {
		width: 100%;
		border: none;
		background: transparent;
		color: var(--text-primary);
		font-size: 0.75rem;
		text-align: left;
		padding: 0.42rem 0.5rem;
		border-radius: 0.35rem;
		cursor: pointer;
		transition: background-color var(--transition-fast), color var(--transition-fast);
	}

	.message-actions-menu-item:hover:not(:disabled) {
		background: var(--bg-card);
		color: var(--text-primary);
	}

	.message-actions-menu-item:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.message-actions-error {
		font-size: 0.73rem;
		line-height: 1.35;
		color: var(--error);
		max-width: 280px;
	}

	.message-renderer.is-exporting .message-actions {
		visibility: hidden;
		pointer-events: none;
	}

	@media (max-width: 768px) {
		.message-renderer :global(.markdown-table-wrap) {
			margin-right: -0.25rem;
			margin-left: -0.25rem;
			border-radius: 0.45rem;
		}

		.message-renderer :global(.markdown-table-wrap table) {
			font-size: 0.82rem;
		}

		.message-renderer :global(.markdown-table-wrap th),
		.message-renderer :global(.markdown-table-wrap td) {
			min-width: 6.5rem;
			padding: 0.52rem 0.62rem;
		}

		.message-renderer :global(.markdown-table-wrap th:nth-child(2)),
		.message-renderer :global(.markdown-table-wrap td:nth-child(2)) {
			min-width: 10rem;
		}

		.message-actions {
			width: 100%;
		}

		.message-action-btn {
			font-size: 0.76rem;
			padding: 0.34rem 0.62rem;
		}

		.message-actions-menu {
			min-width: 190px;
		}
	}
</style>
