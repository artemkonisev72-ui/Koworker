<script lang="ts">
	/**
	 * MessageRenderer.svelte
	 * Safe Markdown + KaTeX renderer with graph/scheme visual blocks.
	 */
	import { onMount, tick } from 'svelte';
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
		if (schemes.length > 0) {
			if (frameGraphGroups.length > 0) return frameGraphGroups;
			return [] as GraphGroup[];
		}
		return graphGroups;
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

	interface CanvasEvaluation {
		blank: boolean;
		score: number;
		nonBackgroundRatio: number;
		strongNonBackgroundRatio: number;
		diffRatio: number;
		opaqueRatio: number;
		luminanceRange: number;
	}

	function parseCssRgb(color: string): { r: number; g: number; b: number } | null {
		const value = color.trim().toLowerCase();
		if (!value) return null;

		const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
		if (hexMatch) {
			const hex = hexMatch[1];
			if (hex.length === 3) {
				return {
					r: parseInt(hex[0] + hex[0], 16),
					g: parseInt(hex[1] + hex[1], 16),
					b: parseInt(hex[2] + hex[2], 16)
				};
			}
			return {
				r: parseInt(hex.slice(0, 2), 16),
				g: parseInt(hex.slice(2, 4), 16),
				b: parseInt(hex.slice(4, 6), 16)
			};
		}

		const rgbMatch = value.match(/^rgba?\((.+)\)$/i);
		if (!rgbMatch) return null;
		const parts = rgbMatch[1].split(',').map((part) => part.trim());
		if (parts.length < 3) return null;

		const toChannel = (part: string): number => {
			const n = Number.parseFloat(part.endsWith('%') ? String((Number.parseFloat(part) / 100) * 255) : part);
			if (!Number.isFinite(n)) return 0;
			return Math.max(0, Math.min(255, Math.round(n)));
		};

		return {
			r: toChannel(parts[0]),
			g: toChannel(parts[1]),
			b: toChannel(parts[2])
		};
	}

	function evaluateCanvas(canvas: HTMLCanvasElement, backgroundColor: string): CanvasEvaluation {
		const empty: CanvasEvaluation = {
			blank: true,
			score: 0,
			nonBackgroundRatio: 0,
			strongNonBackgroundRatio: 0,
			diffRatio: 0,
			opaqueRatio: 0,
			luminanceRange: 0
		};

		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx || canvas.width <= 0 || canvas.height <= 0) return empty;

		const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		if (data.length < 4) return empty;

		const background = parseCssRgb(backgroundColor) ?? { r: data[0], g: data[1], b: data[2] };
		const totalPixels = canvas.width * canvas.height;
		const sampleCount = Math.min(12000, totalPixels);
		const step = Math.max(1, Math.floor(totalPixels / sampleCount));

		const r0 = data[0];
		const g0 = data[1];
		const b0 = data[2];
		const a0 = data[3];

		let sampled = 0;
		let diffPixels = 0;
		let opaquePixels = 0;
		let nonBackgroundPixels = 0;
		let strongNonBackgroundPixels = 0;
		let minLuminance = Number.POSITIVE_INFINITY;
		let maxLuminance = Number.NEGATIVE_INFINITY;

		for (let pixel = 0; pixel < totalPixels; pixel += step) {
			const i = pixel * 4;
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];
			const alpha = data[i + 3];
			sampled += 1;

			if (alpha > 8) {
				opaquePixels += 1;
				const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
				if (luminance < minLuminance) minLuminance = luminance;
				if (luminance > maxLuminance) maxLuminance = luminance;
			}

			const bgDistance =
				Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b);

			if (alpha > 20 && bgDistance > 16) nonBackgroundPixels += 1;
			if (alpha > 50 && bgDistance > 36) strongNonBackgroundPixels += 1;

			if (
				Math.abs(r - r0) > 4 ||
				Math.abs(g - g0) > 4 ||
				Math.abs(b - b0) > 4 ||
				Math.abs(alpha - a0) > 4
			) {
				diffPixels += 1;
			}
		}

		if (sampled <= 0) return empty;

		const nonBackgroundRatio = nonBackgroundPixels / sampled;
		const strongNonBackgroundRatio = strongNonBackgroundPixels / sampled;
		const diffRatio = diffPixels / sampled;
		const opaqueRatio = opaquePixels / sampled;
		const luminanceRange =
			Number.isFinite(minLuminance) && Number.isFinite(maxLuminance) ? maxLuminance - minLuminance : 0;

		// Higher score means there is more "ink" and contrast versus page background.
		const score =
			strongNonBackgroundRatio * 6 +
			nonBackgroundRatio * 3 +
			diffRatio * 0.5 +
			Math.min(1, luminanceRange / 48) * 0.3;

		const blank =
			opaqueRatio < 0.01 ||
			(nonBackgroundRatio < 0.0008 &&
				strongNonBackgroundRatio < 0.0002 &&
				diffRatio < 0.006 &&
				luminanceRange < 6) ||
			(diffRatio < 0.0025 && luminanceRange < 1.6);

		return {
			blank,
			score,
			nonBackgroundRatio,
			strongNonBackgroundRatio,
			diffRatio,
			opaqueRatio,
			luminanceRange
		};
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

			// Prefer foreignObjectRendering=true for correct KaTeX baseline/fraction layout.
			// Keep a robust fallback to false only when true looks blank or clearly worse.
			const renderModes = [true, false];
			const candidates: Array<{
				foreignObjectRendering: boolean;
				canvas: HTMLCanvasElement;
				evaluation: CanvasEvaluation;
			}> = [];

			for (const foreignObjectRendering of renderModes) {
				const candidate = await renderToCanvas(foreignObjectRendering);
				if (candidate.width <= 0 || candidate.height <= 0) continue;
				const evaluation = evaluateCanvas(candidate, backgroundColor);
				if (evaluation.blank) {
					console.warn(
						`[Export] Canvas looks blank with foreignObjectRendering=${foreignObjectRendering}`,
						evaluation
					);
					continue;
				}
				candidates.push({
					foreignObjectRendering,
					canvas: candidate,
					evaluation
				});
			}

			let canvas: HTMLCanvasElement | null = null;
			const preferred = candidates.find((item) => item.foreignObjectRendering);
			const fallback = candidates.find((item) => !item.foreignObjectRendering);

			if (preferred && fallback) {
				const fallbackClearlyBetter = fallback.evaluation.score > preferred.evaluation.score * 2.2;
				canvas = fallbackClearlyBetter ? fallback.canvas : preferred.canvas;
				if (fallbackClearlyBetter) {
					console.warn(
						'[Export] Falling back to foreignObjectRendering=false because true-mode score is too low',
						{
							preferred: preferred.evaluation,
							fallback: fallback.evaluation
						}
					);
				}
			} else if (preferred) {
				canvas = preferred.canvas;
			} else if (fallback) {
				canvas = fallback.canvas;
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

		{#if schemes.length > 0 && schemeDescription}
			<div class="scheme-description-card">
				<div class="scheme-description-title">{schemeDescriptionTitle}</div>
				<div class="scheme-description-body">{schemeDescription}</div>
			</div>
		{/if}

		{#if visibleGraphGroups.length > 0}
			<div class="graphs-container">
				{#each visibleGraphGroups as group}
					{#if group.memberId}
						<div class="graph-group-title">{formatGraphMemberLabel(group.memberId)}</div>
					{/if}
					{#each group.items as graph}
						<GraphView {graph} title={formatGraphDisplayTitle(graph)} />
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

	.scheme-description-card {
		margin-top: 0.9rem;
		padding: 0.85rem 0.95rem;
		border: 1px solid var(--border-medium);
		background: color-mix(in srgb, var(--bg-surface) 68%, transparent);
		border-radius: 0.65rem;
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
