<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';

	interface GraphPoint {
		x: number;
		y: number;
	}

	let {
		points,
		title = 'Graph',
		type = 'function'
	}: { points: GraphPoint[]; title?: string; type?: 'function' | 'diagram' } = $props();

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

	function requestBoardResize() {
		if (!board || !boardEl) return;
		const width = Math.floor(boardEl.clientWidth);
		const height = Math.floor(boardEl.clientHeight);
		if (width <= 0 || height <= 0) return;
		if (typeof board.resizeContainer === 'function') {
			board.resizeContainer(width, height);
		}
		board.fullUpdate?.();
		board.update?.();
	}

	async function toggleFullscreen() {
		isFullscreen = !isFullscreen;
		await tick();
		requestBoardResize();
	}

	function closeFullscreen() {
		if (!isFullscreen) return;
		isFullscreen = false;
		requestAnimationFrame(() => requestBoardResize());
	}

	async function initializeBoard() {
		if (board || !boardEl || !points || points.length < 2) return;

		const JSXGraph = await import('jsxgraph');
		const JXG = JSXGraph.default ?? JSXGraph;

		const xs = points.map((p) => p.x);
		const ys = points.map((p) => p.y);
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

		board.options.grid.strokeColor = 'var(--border-subtle)';
		board.options.axis.strokeColor = 'var(--border-medium)';

		const curve = board.create(
			'curve',
			[points.map((p) => p.x), points.map((p) => p.y)],
			{
				strokeColor: 'var(--text-primary)',
				strokeWidth: 2.5,
				highlight: true,
				highlightStrokeColor: 'var(--accent-primary)',
				highlightStrokeWidth: 3
			}
		);

		if (type === 'diagram') {
			const xCoords = points.map((p) => p.x);
			board.create(
				'polygon',
				[[xCoords[0], 0], ...points.map((p) => [p.x, p.y]), [xCoords[xCoords.length - 1], 0]],
				{
					fillColor: 'var(--accent-primary)',
					fillOpacity: 0.15,
					withLines: false,
					borders: { visible: false },
					vertices: { visible: false },
					highlight: false,
					layer: 0
				}
			);

			const regions: { sign: number; points: GraphPoint[] }[] = [];
			let currentRegion = { sign: 0, points: [] as GraphPoint[] };

			for (const p of points) {
				if (Math.abs(p.y) < 1e-6) continue;
				const sign = p.y > 0 ? 1 : -1;
				if (currentRegion.sign === 0) {
					currentRegion.sign = sign;
					currentRegion.points.push(p);
				} else if (currentRegion.sign === sign) {
					currentRegion.points.push(p);
				} else {
					regions.push(currentRegion);
					currentRegion = { sign, points: [p] };
				}
			}
			if (currentRegion.points.length > 0) regions.push(currentRegion);

			const heightThreshold = (yMax - yMin) * 0.05;
			for (const region of regions) {
				let peak = region.points[0];
				for (const point of region.points) {
					if (Math.abs(point.y) > Math.abs(peak.y)) peak = point;
				}
				if (Math.abs(peak.y) > heightThreshold) {
					board.create('text', [peak.x, peak.y / 2, region.sign > 0 ? '+' : '-'], {
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

		const glider = board.create('point', [xMin, points[0].y], {
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
		if (!points || points.length < 2) return;

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

		if (typeof ResizeObserver === 'function' && boardEl) {
			resizeObserver = new ResizeObserver(() => requestBoardResize());
			resizeObserver.observe(boardEl);
		}

		const onViewportChanged = () => requestBoardResize();
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') closeFullscreen();
		};

		window.addEventListener('resize', onViewportChanged);
		window.addEventListener('orientationchange', onViewportChanged);
		window.addEventListener('keydown', onKeydown);

		return () => {
			window.removeEventListener('resize', onViewportChanged);
			window.removeEventListener('orientationchange', onViewportChanged);
			window.removeEventListener('keydown', onKeydown);
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

{#if points && points.length >= 2}
	<div class="graph-wrapper" bind:this={wrapperEl} class:fullscreen={isFullscreen}>
		<div class="graph-title">
			<span>{title}</span>
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
	}

	.graph-wrapper.fullscreen .graph-title {
		padding-top: calc(0.5rem + env(safe-area-inset-top));
	}

	.graph-wrapper.fullscreen .graph-board {
		height: calc(100dvh - 46px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
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
