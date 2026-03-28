<script lang="ts">
	/**
	 * GraphView.svelte
	 * Рендерит JSXGraph эпюру по массиву точек.
	 */
	import { onMount, onDestroy } from 'svelte';

	interface GraphPoint {
		x: number;
		y: number;
	}

	let { points, title = 'График' }: { points: GraphPoint[]; title?: string } = $props();

	let boardEl: HTMLDivElement | undefined = $state();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let board: any = null;
	const boardId = `jsxgraph-${Math.random().toString(36).slice(2, 9)}`;

	onMount(async () => {
		if (!points || points.length < 2) return;

		// Dynamic import — JSXGraph is a heavy browser-only library
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
			showInfobox: false, // Отключаем стандартный инфобокс в пользу Glider
			showScreenshot: false
		});

		// Override board colors for theme
		board.options.grid.strokeColor = 'var(--border-subtle)';
		board.options.axis.strokeColor = 'var(--border-medium)';

		// Plot the curve - Monochrome
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

		// Создаем Glider - точку, которая следует по кривой
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

		// При наведении (движении мыши по доске) перемещаем Glider за курсором
		board.on('move', (e: any) => {
			const coords = board.getUsrCoordsOfMouse(e);
			glider.moveTo([coords[1], coords[2]]);
			glider.setAttribute({
				name: `x: ${glider.X().toFixed(2)}, y: ${glider.Y().toFixed(2)}`
			});
		});

		// Начальное состояние имени
		glider.setAttribute({ name: `x: ${glider.X().toFixed(2)}, y: ${glider.Y().toFixed(2)}` });
	});

	onDestroy(() => {
		if (board) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(globalThis as any).JXG?.JSXGraph?.freeBoard(board);
			} catch {
				// ignore
			}
		}
	});
</script>

{#if points && points.length >= 2}
	<div class="graph-wrapper">
		<div class="graph-title">{title}</div>
		<div class="graph-board" id={boardId} bind:this={boardEl}></div>
	</div>
{/if}

<style>
	.graph-wrapper {
		margin: 1rem 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--bg-elevated);
	}

	.graph-title {
		padding: 0.5rem 1rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-surface);
	}

	.graph-board {
		width: 100%;
		height: 300px;
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
</style>
