<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { SchemaData, SchemaElement, SchemaPoint } from '$lib/schema/schema-data.js';

	let { schemaData, title = 'Verified scheme' }: { schemaData: SchemaData; title?: string } = $props();

	let board: any = null;
	const boardId = `scheme-${Math.random().toString(36).slice(2, 10)}`;

	function isPoint(value: unknown): value is SchemaPoint {
		return (
			typeof value === 'object' &&
			value !== null &&
			!Array.isArray(value) &&
			typeof (value as Record<string, unknown>).x === 'number' &&
			typeof (value as Record<string, unknown>).y === 'number'
		);
	}

	function pointFrom(
		source: Record<string, unknown>,
		key: string,
		fallback: SchemaPoint = { x: 0, y: 0 }
	): SchemaPoint {
		const raw = source[key];
		return isPoint(raw) ? raw : fallback;
	}

	function vectorFromDirection(direction: string | undefined): SchemaPoint {
		switch (direction) {
			case 'up':
				return { x: 0, y: 1 };
			case 'left':
				return { x: -1, y: 0 };
			case 'right':
				return { x: 1, y: 0 };
			case 'down':
			default:
				return { x: 0, y: -1 };
		}
	}

	function collectPointsFromValue(value: unknown, target: SchemaPoint[]): void {
		if (isPoint(value)) {
			target.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) collectPointsFromValue(entry, target);
			return;
		}
		if (typeof value === 'object' && value !== null) {
			for (const entry of Object.values(value as Record<string, unknown>)) {
				collectPointsFromValue(entry, target);
			}
		}
	}

	function collectAllPoints(schema: SchemaData): SchemaPoint[] {
		const points: SchemaPoint[] = [];
		for (const element of schema.elements) {
			collectPointsFromValue(element.geometry, points);
		}
		if (schema.coordinateSystem?.origin && isPoint(schema.coordinateSystem.origin)) {
			points.push(schema.coordinateSystem.origin);
		}
		return points;
	}

	function drawBeam(JXG: any, geometry: Record<string, unknown>): void {
		const start = pointFrom(geometry, 'start');
		const end = pointFrom(geometry, 'end', { x: start.x + 1, y: start.y });
		board.create('segment', [[start.x, start.y], [end.x, end.y]], {
			strokeColor: 'var(--text-primary)',
			strokeWidth: 4,
			fixed: true,
			highlight: false
		});
	}

	function drawSupport(type: SchemaElement['type'], geometry: Record<string, unknown>): void {
		const point = pointFrom(geometry, 'point');
		const supportColor = 'var(--accent-primary)';

		board.create('point', [point.x, point.y], {
			name: '',
			size: 2.5,
			fillColor: supportColor,
			strokeColor: supportColor,
			fixed: true,
			highlight: false
		});

		if (type === 'support_pin') {
			board.create('polygon', [
				[point.x - 0.3, point.y - 0.28],
				[point.x + 0.3, point.y - 0.28],
				[point.x, point.y]
			], {
				fillColor: 'var(--bg-surface)',
				fillOpacity: 0.8,
				strokeColor: supportColor,
				strokeWidth: 1.5,
				fixed: true,
				highlight: false,
				vertices: { visible: false }
			});
		}

		if (type === 'support_roller') {
			board.create('circle', [[point.x, point.y - 0.2], 0.14], {
				strokeColor: supportColor,
				fillColor: 'transparent',
				fixed: true,
				highlight: false
			});
			board.create('circle', [[point.x - 0.2, point.y - 0.2], 0.14], {
				strokeColor: supportColor,
				fillColor: 'transparent',
				fixed: true,
				highlight: false
			});
		}

		if (type === 'support_fixed') {
			board.create('segment', [[point.x, point.y + 0.45], [point.x, point.y - 0.45]], {
				strokeColor: supportColor,
				strokeWidth: 3,
				fixed: true,
				highlight: false
			});
			for (let i = -2; i <= 2; i++) {
				const y = point.y + i * 0.18;
				board.create('segment', [[point.x - 0.08, y + 0.06], [point.x - 0.34, y - 0.06]], {
					strokeColor: supportColor,
					strokeWidth: 1,
					fixed: true,
					highlight: false
				});
			}
		}
	}

	function drawPointLoad(geometry: Record<string, unknown>): void {
		const point = pointFrom(geometry, 'point');
		const from = isPoint(geometry.from) ? geometry.from : null;
		const to = isPoint(geometry.to) ? geometry.to : null;

		let start = from;
		let end = to;

		if (!start || !end) {
			const directionRaw = typeof geometry.direction === 'string' ? geometry.direction : 'down';
			const vec = vectorFromDirection(directionRaw);
			const magnitude = typeof geometry.magnitude === 'number' ? Math.max(0.4, Math.min(1.3, Math.abs(geometry.magnitude) / 8)) : 0.9;
			start = { x: point.x + vec.x * magnitude, y: point.y + vec.y * magnitude };
			end = point;
		}

		board.create('arrow', [[start.x, start.y], [end.x, end.y]], {
			strokeColor: 'var(--error)',
			strokeWidth: 2,
			fixed: true,
			highlight: false,
			lastArrow: true
		});

		const label = typeof geometry.label === 'string' ? geometry.label : typeof geometry.magnitude === 'number' ? `${geometry.magnitude}` : '';
		if (label) {
			board.create('text', [start.x, start.y + 0.2, label], {
				strokeColor: 'var(--text-secondary)',
				fontSize: 12,
				fixed: true,
				highlight: false
			});
		}
	}

	function drawDistributedLoad(geometry: Record<string, unknown>): void {
		const start = pointFrom(geometry, 'start');
		const end = pointFrom(geometry, 'end', { x: start.x + 1, y: start.y });
		const count = typeof geometry.count === 'number' ? Math.max(3, Math.min(10, Math.round(geometry.count))) : 6;
		const directionRaw = typeof geometry.direction === 'string' ? geometry.direction : 'down';
		const vec = vectorFromDirection(directionRaw);
		const length = typeof geometry.arrowLength === 'number' ? Math.max(0.25, Math.min(1.2, Math.abs(geometry.arrowLength))) : 0.8;

		for (let i = 0; i < count; i++) {
			const t = count === 1 ? 0 : i / (count - 1);
			const base = {
				x: start.x + (end.x - start.x) * t,
				y: start.y + (end.y - start.y) * t
			};
			const from = { x: base.x + vec.x * length, y: base.y + vec.y * length };
			board.create('arrow', [[from.x, from.y], [base.x, base.y]], {
				strokeColor: 'var(--error)',
				strokeWidth: 1.5,
				fixed: true,
				highlight: false,
				lastArrow: true
			});
		}

		board.create('segment', [[start.x + vec.x * length, start.y + vec.y * length], [end.x + vec.x * length, end.y + vec.y * length]], {
			strokeColor: 'var(--error)',
			strokeWidth: 1.2,
			fixed: true,
			highlight: false,
			dash: 1
		});
	}

	function drawMoment(geometry: Record<string, unknown>): void {
		const center = pointFrom(geometry, 'center', pointFrom(geometry, 'point'));
		const direction = geometry.direction === 'cw' ? 'cw' : 'ccw';
		const magnitudeLabel = typeof geometry.magnitude === 'number' ? geometry.magnitude.toString() : '';
		const explicitLabel =
			typeof geometry.label === 'string'
				? geometry.label.trim()
				: typeof geometry.text === 'string'
					? geometry.text.trim()
					: '';
		const radius = typeof geometry.radius === 'number' ? Math.max(0.25, Math.min(1.2, Math.abs(geometry.radius))) : 0.5;

		board.create('circle', [[center.x, center.y], radius], {
			strokeColor: 'var(--warning)',
			strokeWidth: 1.5,
			dash: 2,
			fixed: true,
			highlight: false
		});

		const arrowFrom = direction === 'cw'
			? { x: center.x + radius, y: center.y + 0.05 }
			: { x: center.x - radius, y: center.y + 0.05 };
		const arrowTo = direction === 'cw'
			? { x: center.x + radius - 0.18, y: center.y - 0.18 }
			: { x: center.x - radius + 0.18, y: center.y - 0.18 };
		board.create('arrow', [[arrowFrom.x, arrowFrom.y], [arrowTo.x, arrowTo.y]], {
			strokeColor: 'var(--warning)',
			strokeWidth: 1.8,
			fixed: true,
			highlight: false,
			lastArrow: true
		});

		const label = explicitLabel || (magnitudeLabel ? `M=${magnitudeLabel}` : `M ${direction}`);
		board.create('text', [center.x + radius + 0.15, center.y + radius + 0.1, label], {
			strokeColor: 'var(--text-secondary)',
			fontSize: 12,
			fixed: true,
			highlight: false
		});
	}

	function drawJoint(geometry: Record<string, unknown>): void {
		const point = pointFrom(geometry, 'point');
		board.create('circle', [[point.x, point.y], 0.1], {
			strokeColor: 'var(--text-primary)',
			fillColor: 'var(--bg-surface)',
			fillOpacity: 1,
			strokeWidth: 1.5,
			fixed: true,
			highlight: false
		});
	}

	function drawAxis(geometry: Record<string, unknown>): void {
		const start = pointFrom(geometry, 'start');
		const end = pointFrom(geometry, 'end', { x: start.x + 1, y: start.y });
		board.create('arrow', [[start.x, start.y], [end.x, end.y]], {
			strokeColor: 'var(--text-muted)',
			strokeWidth: 1.2,
			dash: 2,
			fixed: true,
			highlight: false,
			lastArrow: true
		});
		if (typeof geometry.label === 'string') {
			board.create('text', [end.x, end.y, geometry.label], {
				strokeColor: 'var(--text-muted)',
				fontSize: 11,
				fixed: true,
				highlight: false
			});
		}
	}

	function drawDimension(geometry: Record<string, unknown>): void {
		const start = pointFrom(geometry, 'start');
		const end = pointFrom(geometry, 'end', { x: start.x + 1, y: start.y });
		const offset = typeof geometry.offset === 'number' ? geometry.offset : 0.3;
		const p1 = { x: start.x, y: start.y + offset };
		const p2 = { x: end.x, y: end.y + offset };

		board.create('segment', [[p1.x, p1.y], [p2.x, p2.y]], {
			strokeColor: 'var(--text-muted)',
			strokeWidth: 1,
			dash: 1,
			fixed: true,
			highlight: false
		});
		board.create('arrow', [[p1.x + 0.001, p1.y], [p1.x + 0.15, p1.y]], {
			strokeColor: 'var(--text-muted)',
			strokeWidth: 1,
			fixed: true,
			highlight: false,
			lastArrow: true
		});
		board.create('arrow', [[p2.x - 0.001, p2.y], [p2.x - 0.15, p2.y]], {
			strokeColor: 'var(--text-muted)',
			strokeWidth: 1,
			fixed: true,
			highlight: false,
			lastArrow: true
		});

		const label = typeof geometry.label === 'string' ? geometry.label : '';
		if (label) {
			board.create('text', [(p1.x + p2.x) / 2, p1.y + 0.1, label], {
				strokeColor: 'var(--text-secondary)',
				fontSize: 11,
				fixed: true,
				highlight: false,
				anchorX: 'middle'
			});
		}
	}

	function drawLabel(geometry: Record<string, unknown>): void {
		const point = pointFrom(geometry, 'point');
		const text = typeof geometry.text === 'string' ? geometry.text : typeof geometry.label === 'string' ? geometry.label : '';
		if (!text) return;
		board.create('text', [point.x, point.y, text], {
			strokeColor: 'var(--text-primary)',
			fontSize: 12,
			fixed: true,
			highlight: false
		});
	}

	function renderElement(JXG: any, element: SchemaElement): void {
		const geometry = element.geometry || {};
		switch (element.type) {
			case 'beam_segment':
				drawBeam(JXG, geometry);
				return;
			case 'support_pin':
			case 'support_roller':
			case 'support_fixed':
				drawSupport(element.type, geometry);
				return;
			case 'point_load':
				drawPointLoad(geometry);
				return;
			case 'distributed_load':
				drawDistributedLoad(geometry);
				return;
			case 'moment':
				drawMoment(geometry);
				return;
			case 'hinge':
			case 'joint':
				drawJoint(geometry);
				return;
			case 'axis':
				drawAxis(geometry);
				return;
			case 'dimension':
				drawDimension(geometry);
				return;
			case 'label':
				drawLabel(geometry);
				return;
			default:
				return;
		}
	}

	onMount(async () => {
		if (!schemaData?.elements || schemaData.elements.length === 0) return;

		const JSXGraphModule = await import('jsxgraph');
		const JXG = JSXGraphModule.default ?? JSXGraphModule;

		const points = collectAllPoints(schemaData);
		const xs = points.map((point) => point.x);
		const ys = points.map((point) => point.y);
		const xMin = xs.length > 0 ? Math.min(...xs) : -2;
		const xMax = xs.length > 0 ? Math.max(...xs) : 2;
		const yMin = ys.length > 0 ? Math.min(...ys) : -2;
		const yMax = ys.length > 0 ? Math.max(...ys) : 2;
		const xPad = Math.max(0.8, (xMax - xMin) * 0.22);
		const yPad = Math.max(0.8, (yMax - yMin) * 0.24);

		board = JXG.JSXGraph.initBoard(boardId, {
			boundingbox: [xMin - xPad, yMax + yPad, xMax + xPad, yMin - yPad],
			axis: true,
			grid: true,
			showCopyright: false,
			showNavigation: false,
			showScreenshot: false,
			keepAspectRatio: false
		});

		board.options.grid.strokeColor = 'var(--border-subtle)';
		board.options.axis.strokeColor = 'var(--border-medium)';

		for (const element of schemaData.elements) {
			try {
				renderElement(JXG, element);
			} catch (err) {
				console.warn('[SchemeView] Failed to render element:', element.id, err);
			}
		}
	});

	onDestroy(() => {
		if (!board) return;
		try {
			(globalThis as any).JXG?.JSXGraph?.freeBoard(board);
		} catch {
			// ignore cleanup errors
		}
	});
</script>

{#if schemaData?.elements?.length}
	<div class="scheme-wrapper">
		<div class="scheme-title">{title}</div>
		<div class="scheme-board" id={boardId}></div>
	</div>
{/if}

<style>
	.scheme-wrapper {
		margin: 1rem 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--bg-elevated);
	}

	.scheme-title {
		padding: 0.5rem 1rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-surface);
	}

	.scheme-board {
		width: 100%;
		height: 320px;
	}

	:global(.jxgtext) {
		font-family: var(--font-mono);
	}
</style>
