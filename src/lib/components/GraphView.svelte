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
			showNavigation: false
		});

		// Override board colors for dark theme
		board.options.grid.strokeColor = 'rgba(255,255,255,0.05)';
		board.options.axis.strokeColor = 'rgba(255,255,255,0.25)';

		// Plot the curve
		board.create(
			'curve',
			[points.map((p) => p.x), points.map((p) => p.y)],
			{
				strokeColor: '#6c63ff',
				strokeWidth: 2.5,
				highlight: false
			}
		);
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
		border: 1px solid rgba(108, 99, 255, 0.2);
		border-radius: 12px;
		overflow: hidden;
		background: #0b0b14;
	}

	.graph-title {
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--accent-secondary);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		border-bottom: 1px solid rgba(108, 99, 255, 0.15);
	}

	.graph-board {
		width: 100%;
		height: 300px;
	}
</style>
