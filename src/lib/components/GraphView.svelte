<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { buildEpureLayout } from '$lib/epure/layout.js';
	import { getEpureDisplayFactor, normalizeGraphEpure, type GraphData } from '$lib/graphs/types.js';

	let { graph, title = 'Graph' }: { graph: GraphData; title?: string } = $props();

	let wrapperEl: HTMLDivElement | undefined = $state();
	let boardEl: HTMLDivElement | undefined = $state();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let board: any = null;
	let isReady = $state(false);
	let isFullscreen = $state(false);
	let initRequested = false;

	const boardId = `jsxgraph-${Math.random().toString(36).slice(2, 9)}`;

	let visibilityObserver: IntersectionObserver | null = null;
	let resizeObserver: ResizeObserver | null = null;

	function applyBoardTheme() {
		if (!board) return;
		const axisStroke = 'var(--border-medium)';
		const axisText = 'var(--text-secondary)';
		board.options.grid.strokeColor = 'var(--border-subtle)';
		board.options.axis.strokeColor = axisStroke;

		const axes = [board.defaultAxes?.x, board.defaultAxes?.y].filter(Boolean);
		for (const axis of axes) {
			axis.setAttribute?.({
				strokeColor: axisStroke,
				highlightStrokeColor: axisStroke
			});
			axis.defaultTicks?.setAttribute?.({
				strokeColor: axisText,
				highlightStrokeColor: axisText,
				label: {
					strokeColor: axisText,
					highlightStrokeColor: axisText
				}
			});
		}

		board.options.text.strokeColor = axisText;
		board.options.text.highlightStrokeColor = axisText;
	}

	function getTitleHeight(): number {
		const titleEl = wrapperEl?.querySelector<HTMLElement>('.graph-title');
		if (!titleEl) return 0;
		return titleEl.offsetHeight;
	}

	function computeBoardSize(): { width: number; height: number } | null {
		if (!boardEl) return null;
		const titleHeight = getTitleHeight();
		const fallbackWidth = Math.floor(boardEl.clientWidth || 320);
		const fallbackHeight = Math.floor(boardEl.clientHeight || 220);

		if (isFullscreen) {
			const viewportWidth = Math.floor(window.visualViewport?.width ?? window.innerWidth);
			const viewportHeight = Math.floor(window.visualViewport?.height ?? window.innerHeight);
			return {
				width: Math.max(320, viewportWidth),
				height: Math.max(200, viewportHeight - titleHeight)
			};
		}

		return {
			width: Math.max(220, fallbackWidth),
			height: Math.max(180, fallbackHeight)
		};
	}

	function requestBoardResize() {
		if (!board || !boardEl) return;
		if (!isFullscreen) {
			// Drop stale fullscreen inline size before measuring normal chat layout.
			boardEl.style.width = '';
			boardEl.style.height = '';
		}
		const size = computeBoardSize();
		if (!size) return;
		const width = size.width;
		const height = size.height;
		if (width <= 0 || height <= 0) return;
		if (isFullscreen) {
			boardEl.style.width = `${width}px`;
			boardEl.style.height = `${height}px`;
		}
		if (typeof board.resizeContainer === 'function') {
			board.resizeContainer(width, height);
		}
		board.fullUpdate?.();
		board.update?.();
	}

	async function toggleFullscreen() {
		if (document.fullscreenElement === wrapperEl) {
			try {
				await document.exitFullscreen();
			} catch {
				// fallback below
			}
			isFullscreen = false;
			await tick();
			requestBoardResize();
			return;
		}

		if (isFullscreen && document.fullscreenElement !== wrapperEl) {
			isFullscreen = false;
			await tick();
			requestBoardResize();
			return;
		}

		if (wrapperEl && typeof wrapperEl.requestFullscreen === 'function') {
			try {
				await wrapperEl.requestFullscreen();
				return;
			} catch {
				// Continue with CSS fullscreen fallback.
			}
		}

		isFullscreen = true;
		await tick();
		requestBoardResize();
	}

	function closeFullscreen() {
		if (!isFullscreen) return;
		if (document.fullscreenElement === wrapperEl) {
			void document.exitFullscreen();
			return;
		}
		isFullscreen = false;
		requestAnimationFrame(requestBoardResize);
	}

	async function initializeBoard() {
		if (board || !boardEl || !graph?.points || graph.points.length < 2) return;

		const JSXGraph = await import('jsxgraph');
		const JXG = JSXGraph.default ?? JSXGraph;
		const normalizedGraph = normalizeGraphEpure(graph).graph;
		const epureFactor = getEpureDisplayFactor(normalizedGraph.epure);
		const epureLayout =
			normalizedGraph.type === 'diagram'
				? buildEpureLayout(
						normalizedGraph.points.map((point) => ({
							x: point.x,
							value: point.y,
							displayValue: point.y * epureFactor
						}))
					)
				: null;
		const curvePoints = epureLayout?.curvePoints ?? normalizedGraph.points;
		if (curvePoints.length < 2) return;

		const xs = curvePoints.map((p) => p.x);
		const ys = curvePoints.map((p) => p.y);
		const xMin = Math.min(...xs);
		const xMax = Math.max(...xs);
		const yMin = Math.min(...ys);
		const yMax = Math.max(...ys);
		const xPad = (xMax - xMin) * 0.1 || 1;
		const yPad = (yMax - yMin) * 0.1 || 1;

		board = JXG.JSXGraph.initBoard(boardId, {
			boundingbox: [xMin - xPad, yMax + yPad, xMax + xPad, yMin - yPad],
			axis: true,
			grid: true,
			showCopyright: false,
			showNavigation: false,
			showInfobox: false,
			showScreenshot: false
		});

		applyBoardTheme();
		if (normalizedGraph.type === 'diagram' && epureLayout) {
			const fillOpacity = normalizedGraph.epure?.fillHatch === false ? 0.12 : 0.05;
			for (const region of epureLayout.regions) {
				board.create(
					'polygon',
					region.polygon.map((point) => [point.x, point.y]),
					{
						fillColor: 'var(--accent-primary)',
						fillOpacity,
						withLines: false,
						borders: { visible: false },
						vertices: { visible: false, withLabel: false },
						highlight: false,
						layer: 0
					}
				);

				if (normalizedGraph.epure?.fillHatch !== false) {
					for (const hatch of region.hatchSegments) {
						board.create(
							'segment',
							[
								[hatch.start.x, hatch.start.y],
								[hatch.end.x, hatch.end.y]
							],
							{
								fixed: true,
								highlight: false,
								strokeColor: 'var(--accent-primary)',
								opacity: 0.45,
								strokeWidth: 1,
								layer: 1
							}
						);
					}
				}

				if (normalizedGraph.epure?.showSigns !== false && region.showSign) {
					board.create('text', [region.centroid.x, region.centroid.y, region.sign > 0 ? '+' : '-'], {
						fontSize: 28,
						fontWeight: 'bold',
						anchorX: 'middle',
						anchorY: 'middle',
						strokeColor: 'var(--text-primary)',
						highlight: false,
						cssClass: 'diagram-sign'
					});
				}
			}
		}

		const curve = board.create(
			'curve',
			[curvePoints.map((point) => point.x), curvePoints.map((point) => point.y)],
			{
				strokeColor: 'var(--text-primary)',
				strokeWidth: 2.5,
				highlight: true,
				highlightStrokeColor: 'var(--accent-primary)',
				highlightStrokeWidth: 3,
				layer: 4
			}
		);

		const glider = board.create('point', [curvePoints[0].x, curvePoints[0].y], {
			name: '',
			slideObject: curve,
			visible: true,
			size: 3,
			fillColor: 'var(--bg-base)',
			strokeColor: 'var(--accent-primary)',
			strokeWidth: 2,
			withLabel: true,
			label: {
				position: 'urt',
				offset: [10, 10],
				fontSize: 12,
				fontFamily: 'var(--font-mono)',
				color: 'var(--text-primary)',
				strokeColor: 'none',
				highlight: false,
				cssClass: 'graph-tooltip-label'
			}
		});

		glider.on('drag', () => {
			glider.setAttribute({
				name: `x: ${glider.X().toFixed(2)}, y: ${glider.Y().toFixed(2)}`
			});
		});

		board.on('move', (e: any) => {
			const ev = e.nativeEvent || e;
			const pos = board.getMousePosition(ev);
			const coords = new JXG.Coords(JXG.COORDS_BY_SCREEN, pos, board);
			glider.moveTo([coords.usrCoords[1], coords.usrCoords[2]], 0);
			glider.setAttribute({
				name: `x: ${glider.X().toFixed(2)}, y: ${glider.Y().toFixed(2)}`
			});
		});

		glider.setAttribute({ name: `x: ${glider.X().toFixed(2)}, y: ${glider.Y().toFixed(2)}` });
		isReady = true;
		requestAnimationFrame(() => requestBoardResize());
	}

	onMount(() => {
		if (!graph?.points || graph.points.length < 2) return;

		const activate = () => {
			if (initRequested) return;
			initRequested = true;
			void initializeBoard();
		};

		if (typeof IntersectionObserver === 'function' && wrapperEl) {
			visibilityObserver = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
						activate();
						visibilityObserver?.disconnect();
						visibilityObserver = null;
					}
				},
				{ threshold: 0.12 }
			);
			visibilityObserver.observe(wrapperEl);
		} else {
			activate();
		}

		if (typeof ResizeObserver === 'function' && wrapperEl) {
			resizeObserver = new ResizeObserver(() => requestBoardResize());
			resizeObserver.observe(wrapperEl);
		}

		const onViewportChanged = () => requestBoardResize();
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') closeFullscreen();
		};
		const onThemeChanged = () => {
			applyBoardTheme();
			requestAnimationFrame(requestBoardResize);
		};
		const onFullscreenChanged = () => {
			const nativeFullscreenActive = document.fullscreenElement === wrapperEl;
			if (nativeFullscreenActive !== isFullscreen) {
				isFullscreen = nativeFullscreenActive;
			}
			requestAnimationFrame(requestBoardResize);
		};

		window.addEventListener('resize', onViewportChanged);
		window.addEventListener('orientationchange', onViewportChanged);
		window.addEventListener('keydown', onKeydown);
		window.addEventListener('coworker-theme-change', onThemeChanged as EventListener);
		document.addEventListener('fullscreenchange', onFullscreenChanged);

		return () => {
			window.removeEventListener('resize', onViewportChanged);
			window.removeEventListener('orientationchange', onViewportChanged);
			window.removeEventListener('keydown', onKeydown);
			window.removeEventListener('coworker-theme-change', onThemeChanged as EventListener);
			document.removeEventListener('fullscreenchange', onFullscreenChanged);
			visibilityObserver?.disconnect();
			resizeObserver?.disconnect();
			visibilityObserver = null;
			resizeObserver = null;
		};
	});

	onDestroy(() => {
		if (!board) return;
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(globalThis as any).JXG?.JSXGraph?.freeBoard(board);
		} catch {
			// ignore cleanup errors
		}
	});
</script>

{#if graph?.points && graph.points.length >= 2}
	<div class="graph-wrapper" bind:this={wrapperEl} class:fullscreen={isFullscreen}>
		<div class="graph-title">
			<span>{title}</span>
			{#if isFullscreen}
				<span class="graph-fullscreen-hint">Shift + ЛКМ для перемещения</span>
			{/if}
			<button class="graph-fullscreen-btn" onclick={toggleFullscreen}>
				{isFullscreen ? 'Close' : 'Full screen'}
			</button>
		</div>
		<div class="graph-board" id={boardId} bind:this={boardEl}></div>
		{#if !isReady}
			<div class="graph-loading">Preparing graph...</div>
		{/if}
	</div>
{/if}

<style>
	.graph-wrapper {
		margin: 1rem 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--bg-elevated);
		position: relative;
	}

	.graph-title {
		padding: 0.5rem 0.75rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-surface);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.graph-fullscreen-btn {
		border: 1px solid var(--border-subtle);
		background: var(--bg-card);
		color: var(--text-secondary);
		border-radius: var(--radius-sm);
		font-size: 0.67rem;
		padding: 0.2rem 0.45rem;
		cursor: pointer;
	}

	.graph-fullscreen-hint {
		margin-left: auto;
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.graph-board {
		width: 100%;
		height: clamp(220px, 44vh, 340px);
	}

	.graph-loading {
		position: absolute;
		inset: auto 0 0 0;
		padding: 0.4rem 0.65rem;
		font-size: 0.73rem;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--bg-surface) 86%, transparent);
		border-top: 1px dashed var(--border-subtle);
	}

	.graph-wrapper.fullscreen {
		position: fixed;
		inset: 0;
		margin: 0;
		z-index: 1200;
		border-radius: 0;
		display: flex;
		flex-direction: column;
		width: 100vw;
		height: 100dvh;
	}

	.graph-wrapper:fullscreen {
		margin: 0;
		border-radius: 0;
		display: flex;
		flex-direction: column;
		width: 100vw;
		height: 100dvh;
	}

	.graph-wrapper.fullscreen .graph-title,
	.graph-wrapper:fullscreen .graph-title {
		padding-top: calc(0.5rem + env(safe-area-inset-top));
	}

	.graph-wrapper.fullscreen .graph-board,
	.graph-wrapper:fullscreen .graph-board {
		flex: 1;
		min-height: 0;
		height: auto;
	}

	:global(.graph-tooltip-label) {
		background: var(--bg-elevated);
		padding: 2px 6px;
		border-radius: 4px;
		border: 1px solid var(--border-subtle);
		box-shadow: var(--shadow-sm);
		font-weight: 600;
	}

	:global(.jxgbox_infobox) {
		display: none !important;
	}

	:global(.diagram-sign) {
		user-select: none;
		pointer-events: none;
		opacity: 0.8;
	}

	@media (max-width: 768px) {
		.graph-fullscreen-hint {
			display: none;
		}

		.graph-title {
			padding: 0.45rem 0.58rem;
			font-size: 0.68rem;
		}

		.graph-fullscreen-btn {
			font-size: 0.63rem;
			padding: 0.18rem 0.42rem;
		}

		.graph-board {
			height: clamp(190px, 34dvh, 260px);
		}
	}
</style>
