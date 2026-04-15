<script lang="ts">
	/**
	 * MessageRenderer.svelte
	 * Safe Markdown + KaTeX renderer with graph/scheme visual blocks.
	 */
	import { onMount, tick } from 'svelte';
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
		memberId?: string;
		diagramType?: string;
		points: GraphPoint[];
	}
	interface GraphGroup {
		memberId: string | null;
		items: GraphData[];
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
		isStreaming?: boolean;
	}

	type ExportActionId = 'pdf';

	let { message, schemeDebug = false }: { message: Message; schemeDebug?: boolean } = $props();

	let renderedHtml = $state('');
	let exportRootEl: HTMLDivElement | undefined = $state();
	let exportControlsEl: HTMLDivElement | undefined = $state();
	let menuOpen = $state(false);
	let isExporting = $state(false);
	let exportError = $state('');

	const TEXT_EXPORT = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442';
	const TEXT_EXPORTING = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442\u0438\u0440\u0443\u0435\u0442\u0441\u044f...';
	const TEXT_EXPORT_TO_PDF = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u0432 PDF';
	const TEXT_EXPORT_ERROR =
		'\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u0444\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u0442\u044c PDF. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0441\u043d\u043e\u0432\u0430.';
	const TEXT_EXPORT_MENU_ARIA = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f';

	const exportActions: Array<{ id: ExportActionId; label: string }> = [
		{ id: 'pdf', label: TEXT_EXPORT_TO_PDF }
	];

	let canExport = $derived(
		message.role === 'ASSISTANT' && !message.schemaData && !message.isStreaming
	);

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

	let graphGroups = $derived.by(() => {
		const groups = new Map<string, GraphGroup>();
		for (const graph of graphs) {
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
		ALLOWED_ATTR: ['class', 'href', 'style', 'aria-hidden', 'focusable', 'xmlns', 'encoding'],
		FORCE_BODY: true
	};

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
	});

	$effect(() => {
		if (!canExport) {
			menuOpen = false;
			exportError = '';
		}
	});

	function toggleExportMenu() {
		if (isExporting) return;
		exportError = '';
		menuOpen = !menuOpen;
	}

	function makePdfTimestamp(date: Date): string {
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
			date.getHours()
		)}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	}

	function isCanvasLikelyBlank(canvas: HTMLCanvasElement): boolean {
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx || canvas.width <= 0 || canvas.height <= 0) return true;

		const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		if (data.length < 4) return true;

		const r0 = data[0];
		const g0 = data[1];
		const b0 = data[2];
		const a0 = data[3];

		const totalPixels = canvas.width * canvas.height;
		const sampleCount = Math.min(4000, totalPixels);
		const step = Math.max(1, Math.floor(totalPixels / sampleCount));
		let diffPixels = 0;
		let opaquePixels = 0;
		let minLuminance = Number.POSITIVE_INFINITY;
		let maxLuminance = Number.NEGATIVE_INFINITY;

		for (let pixel = 0; pixel < totalPixels; pixel += step) {
			const i = pixel * 4;
			const alpha = data[i + 3];
			if (alpha > 2) {
				opaquePixels += 1;
				const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
				if (luminance < minLuminance) minLuminance = luminance;
				if (luminance > maxLuminance) maxLuminance = luminance;
			}

			if (
				Math.abs(data[i] - r0) > 3 ||
				Math.abs(data[i + 1] - g0) > 3 ||
				Math.abs(data[i + 2] - b0) > 3 ||
				Math.abs(alpha - a0) > 3
			) {
				diffPixels += 1;
				if (diffPixels > 20) return false;
			}
		}

		// html2canvas sometimes returns almost transparent output in dev + complex SVG/KaTeX.
		if (opaquePixels === 0) return true;

		// Very low variance + almost no pixel differences usually means "empty sheet".
		if (Number.isFinite(minLuminance) && Number.isFinite(maxLuminance)) {
			const luminanceRange = maxLuminance - minLuminance;
			if (luminanceRange < 2 && diffPixels <= 3) {
				return true;
			}
		}

		return false;
	}

	async function exportAsPdf() {
		if (!exportRootEl || isExporting) return;
		const targetEl = exportRootEl;
		isExporting = true;
		menuOpen = false;
		exportError = '';

		await tick();

		try {
			const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
				import('html2canvas'),
				import('jspdf')
			]);

			if ('fonts' in document) {
				await (document as Document & { fonts: FontFaceSet }).fonts.ready;
			}
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});

			const computed = getComputedStyle(document.documentElement);
			const backgroundColor = computed.getPropertyValue('--bg-base').trim() || '#ffffff';
			const scale = Math.max(2, Math.min(3, window.devicePixelRatio || 1));

			const renderToCanvas = async (foreignObjectRendering: boolean) =>
				html2canvas(targetEl, {
					scale,
					useCORS: true,
					backgroundColor,
					logging: false,
					foreignObjectRendering,
					ignoreElements: (element) => {
						if (element === exportControlsEl) return true;
						return Boolean(element.classList?.contains('message-actions'));
					}
				});

			// Keep KaTeX geometry accurate: fractions/limits are rendered correctly with foreignObjectRendering=true.
			// Fallback to false only when true yields a blank canvas.
			const renderModes = [true, false];

			let canvas: HTMLCanvasElement | null = null;
			for (const foreignObjectRendering of renderModes) {
				const candidate = await renderToCanvas(foreignObjectRendering);
				if (candidate.width <= 0 || candidate.height <= 0) continue;
				if (isCanvasLikelyBlank(candidate)) {
					console.warn(
						`[Export] Canvas looks blank with foreignObjectRendering=${foreignObjectRendering}`
					);
					continue;
				}
				canvas = candidate;
				break;
			}

			if (!canvas) {
				throw new Error('Rendered canvas is blank');
			}

			const pdf = new jsPDF({
				orientation: 'portrait',
				unit: 'mm',
				format: 'a4',
				compress: true
			});

			const marginMm = 10;
			const pageWidthMm = pdf.internal.pageSize.getWidth();
			const pageHeightMm = pdf.internal.pageSize.getHeight();
			const contentWidthMm = pageWidthMm - marginMm * 2;
			const contentHeightMm = pageHeightMm - marginMm * 2;
			const mmPerPx = contentWidthMm / canvas.width;
			const pageHeightPx = Math.max(1, Math.floor(contentHeightMm / mmPerPx));

			let renderedPx = 0;
			let pageIndex = 0;

			while (renderedPx < canvas.height) {
				const sliceHeightPx = Math.min(pageHeightPx, canvas.height - renderedPx);
				const sliceCanvas = document.createElement('canvas');
				sliceCanvas.width = canvas.width;
				sliceCanvas.height = sliceHeightPx;
				const ctx = sliceCanvas.getContext('2d');
				if (!ctx) {
					throw new Error('Failed to get 2D context for PDF slice');
				}

				ctx.drawImage(
					canvas,
					0,
					renderedPx,
					canvas.width,
					sliceHeightPx,
					0,
					0,
					canvas.width,
					sliceHeightPx
				);

				const sliceDataUrl = sliceCanvas.toDataURL('image/png');
				const sliceHeightMm = sliceHeightPx * mmPerPx;
				if (pageIndex > 0) {
					pdf.addPage();
				}
				pdf.addImage(
					sliceDataUrl,
					'PNG',
					marginMm,
					marginMm,
					contentWidthMm,
					sliceHeightMm,
					undefined,
					'FAST'
				);

				renderedPx += sliceHeightPx;
				pageIndex += 1;
			}

			pdf.save(`coworker-solution-${makePdfTimestamp(new Date())}.pdf`);
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
		renderedHtml = DOMPurify.sanitize(rawHtml, DOMPURIFY_CONFIG as any) as unknown as string;
	}
</script>

<div class="message-renderer prose" class:is-exporting={isExporting}>
	<div class="message-export-root" bind:this={exportRootEl}>
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

		{#if graphGroups.length > 0}
			<div class="graphs-container">
				{#each graphGroups as group}
					{#if group.memberId}
						<div class="graph-group-title">Member: {group.memberId}</div>
					{/if}
					{#each group.items as graph}
						<GraphView
							points={graph.points}
							title={
								graph.title ||
								(graph.diagramType && group.memberId
									? `${graph.diagramType} - ${group.memberId}`
									: group.memberId
										? `Member ${group.memberId}`
										: 'Solution graph')
							}
							type={graph.type}
						/>
					{/each}
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
