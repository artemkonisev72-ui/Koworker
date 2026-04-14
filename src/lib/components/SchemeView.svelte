<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import type { SchemaData, SchemaPoint } from '$lib/schema/schema-data.js';
	import type { NodeV2, ObjectV2, ResultV2, SchemaDataV2 } from '$lib/schema/schema-v2.js';
	import { normalizeSchemaDataV2 } from '$lib/schema/normalize-v2.js';
	import { adaptSchemaV1ToV2 } from '$lib/schema/adapters-v2.js';

	let {
		schemaData,
		title = 'Verified scheme',
		debug = false
	}: { schemaData: unknown; title?: string; debug?: boolean } = $props();

	let board: any = null;
	let wrapperEl: HTMLDivElement | undefined = $state();
	let boardEl: HTMLDivElement | undefined = $state();
	let isReady = $state(false);
	let isFullscreen = $state(false);
	let initRequested = false;
	const boardId = `scheme-${Math.random().toString(36).slice(2, 10)}`;
	let visibilityObserver: IntersectionObserver | null = null;
	let resizeObserver: ResizeObserver | null = null;

	const COLOR = {
		base: 'var(--text-primary)',
		support: 'var(--accent-primary)',
		load: 'var(--error)',
		kinematic: 'var(--accent-secondary)',
		result: 'var(--warning)',
		muted: 'var(--text-muted)',
		text: 'var(--text-secondary)'
	} as const;

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function isFiniteNumber(value: unknown): value is number {
		return typeof value === 'number' && Number.isFinite(value);
	}

	function isPoint(value: unknown): value is SchemaPoint {
		return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
	}

	function toPoint(value: unknown): SchemaPoint | null {
		if (isPoint(value)) return { x: value.x, y: value.y };
		if (Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
			return { x: value[0], y: value[1] };
		}
		return null;
	}

	function parseSchema(input: unknown): SchemaDataV2 | null {
		let parsed = input;
		if (typeof input === 'string') {
			try {
				parsed = JSON.parse(input);
			} catch {
				return null;
			}
		}
		if (!isRecord(parsed)) return null;

		if (Array.isArray(parsed.elements)) {
			return adaptSchemaV1ToV2(parsed as unknown as SchemaData);
		}

		if (Array.isArray(parsed.nodes) || Array.isArray(parsed.objects)) {
			return normalizeSchemaDataV2(parsed).value;
		}

		if (isRecord(parsed.schemaData)) {
			return parseSchema(parsed.schemaData);
		}

		return null;
	}

	const normalizedSchema = $derived.by(() => parseSchema(schemaData));

	function metricSnapshot(metrics: Record<string, unknown> | null): string | null {
		if (!metrics) return null;
		const collapse = isFiniteNumber(metrics.coordCollapseRate) ? metrics.coordCollapseRate.toFixed(3) : '-';
		const minSep = isFiniteNumber(metrics.minElementSeparation) ? metrics.minElementSeparation.toFixed(3) : '-';
		const aspect = isFiniteNumber(metrics.aspectDistortion) ? metrics.aspectDistortion.toFixed(3) : '-';
		return `collapse=${collapse} | minSep=${minSep} | aspect=${aspect}`;
	}

	const layoutDiagnostics = $derived.by(() => {
		const schema = normalizedSchema;
		if (!schema || !isRecord(schema.meta)) return null;
		const metrics = isRecord(schema.meta.layoutMetrics) ? schema.meta.layoutMetrics : null;
		const before = metrics && isRecord(metrics.before) ? metrics.before : null;
		const after = metrics && isRecord(metrics.after) ? metrics.after : null;
		const corrections = Array.isArray(schema.meta.layoutCorrections)
			? schema.meta.layoutCorrections.filter((item): item is string => typeof item === 'string')
			: [];
		return {
			beforeSnapshot: metricSnapshot(before),
			afterSnapshot: metricSnapshot(after),
			corrections,
			autoCorrected: schema.meta.layoutAutoCorrected === true
		};
	});

	function vectorFromAngleDegrees(angle: number): SchemaPoint {
		const rad = (angle * Math.PI) / 180;
		return { x: Math.cos(rad), y: Math.sin(rad) };
	}

	function directionFromKeyword(value: string): SchemaPoint | null {
		const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
		if (!normalized) return null;
		if (normalized === 'up' || normalized === 'u' || normalized === 'north' || normalized === '+y') return { x: 0, y: 1 };
		if (normalized === 'down' || normalized === 'd' || normalized === 'south' || normalized === '-y') return { x: 0, y: -1 };
		if (normalized === 'left' || normalized === 'l' || normalized === 'west' || normalized === '-x') return { x: -1, y: 0 };
		if (normalized === 'right' || normalized === 'r' || normalized === 'east' || normalized === '+x') return { x: 1, y: 0 };
		if (normalized === 'upright' || normalized === 'northeast') return { x: 1, y: 1 };
		if (normalized === 'upleft' || normalized === 'northwest') return { x: -1, y: 1 };
		if (normalized === 'downright' || normalized === 'southeast') return { x: 1, y: -1 };
		if (normalized === 'downleft' || normalized === 'southwest') return { x: -1, y: -1 };
		return null;
	}

	function normalizeDirection(geometry: Record<string, unknown>, fallbackAngle = -90): SchemaPoint {
		const dir = geometry.direction;
		if (isPoint(dir)) {
			const len = Math.hypot(dir.x, dir.y) || 1;
			return { x: dir.x / len, y: dir.y / len };
		}
		if (Array.isArray(dir) && dir.length >= 2 && isFiniteNumber(dir[0]) && isFiniteNumber(dir[1])) {
			const len = Math.hypot(dir[0], dir[1]) || 1;
			return { x: dir[0] / len, y: dir[1] / len };
		}
		if (typeof dir === 'string') {
			const fromKeyword = directionFromKeyword(dir);
			if (fromKeyword) {
				const len = Math.hypot(fromKeyword.x, fromKeyword.y) || 1;
				return { x: fromKeyword.x / len, y: fromKeyword.y / len };
			}
			const angleFromString = Number.parseFloat(dir.replace(',', '.'));
			if (Number.isFinite(angleFromString)) return vectorFromAngleDegrees(angleFromString);
		}

		const angle =
			isFiniteNumber(geometry.directionAngle) ? geometry.directionAngle :
			isFiniteNumber(geometry.angleDeg) ? geometry.angleDeg :
			isFiniteNumber(geometry.angle) ? geometry.angle :
			isFiniteNumber(geometry.thetaDeg) ? geometry.thetaDeg :
			isFiniteNumber(geometry.theta) ? geometry.theta :
			null;
		if (angle !== null) return vectorFromAngleDegrees(angle);

		const cardinals = [geometry.cardinal, geometry.orientation, geometry.bearing, geometry.dir];
		for (const candidate of cardinals) {
			if (typeof candidate !== 'string') continue;
			const fromKeyword = directionFromKeyword(candidate);
			if (fromKeyword) {
				const len = Math.hypot(fromKeyword.x, fromKeyword.y) || 1;
				return { x: fromKeyword.x / len, y: fromKeyword.y / len };
			}
		}

		return vectorFromAngleDegrees(fallbackAngle);
	}

	function collectPoints(schema: SchemaDataV2): SchemaPoint[] {
		const points: SchemaPoint[] = schema.nodes.map((n) => ({ x: n.x, y: n.y }));

		for (const object of schema.objects) {
			if (object.type === 'trajectory' && Array.isArray(object.geometry.points)) {
				for (const rawPoint of object.geometry.points) {
					const point = toPoint(rawPoint);
					if (point) points.push(point);
				}
			}
		}

		for (const result of schema.results ?? []) {
			if (result.type === 'trajectory' && Array.isArray(result.geometry.points)) {
				for (const rawPoint of result.geometry.points) {
					const point = toPoint(rawPoint);
					if (point) points.push(point);
				}
			}
		}

		if (schema.coordinateSystem?.origin && isPoint(schema.coordinateSystem.origin)) {
			points.push(schema.coordinateSystem.origin);
		}
		return points;
	}

	function createNodeMap(schema: SchemaDataV2): Map<string, NodeV2> {
		return new Map(schema.nodes.map((node) => [node.id, node]));
	}

	function getNode(nodeMap: Map<string, NodeV2>, id: string | undefined): NodeV2 | null {
		if (!id) return null;
		return nodeMap.get(id) ?? null;
	}

	function getPair(nodeMap: Map<string, NodeV2>, refs: string[] | undefined): [NodeV2, NodeV2] | null {
		if (!refs || refs.length < 2) return null;
		const a = getNode(nodeMap, refs[0]);
		const b = getNode(nodeMap, refs[1]);
		if (!a || !b) return null;
		return [a, b];
	}

	function labelText(object: ObjectV2 | ResultV2, fallback = ''): string {
		if (typeof object.label === 'string' && object.label.trim()) return object.label.trim();
		if (typeof object.geometry.label === 'string' && object.geometry.label.trim()) return object.geometry.label.trim();
		if (typeof object.geometry.text === 'string' && object.geometry.text.trim()) return object.geometry.text.trim();
		return fallback;
	}

	function drawSegment(a: SchemaPoint, b: SchemaPoint, options: Record<string, unknown>): void {
		board.create('segment', [[a.x, a.y], [b.x, b.y]], {
			fixed: true,
			highlight: false,
			...options
		});
	}

	function drawArrow(a: SchemaPoint, b: SchemaPoint, options: Record<string, unknown>): void {
		board.create('arrow', [[a.x, a.y], [b.x, b.y]], {
			fixed: true,
			highlight: false,
			lastArrow: true,
			...options
		});
	}

	function drawText(point: SchemaPoint, text: string, options: Record<string, unknown> = {}): void {
		if (!text.trim()) return;
		board.create('text', [point.x, point.y, text], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.text,
			fontSize: 12,
			...options
		});
	}

	function drawBar(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		drawSegment(pair[0], pair[1], {
			strokeColor: COLOR.base,
			strokeWidth: isFiniteNumber(object.geometry.thickness) ? Math.max(1, object.geometry.thickness) : 4,
			dash: object.geometry.lineType === 'dashed' ? 2 : 0
		});
	}

	function drawCable(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [a, b] = pair;
		const sag = isFiniteNumber(object.geometry.sag) ? Math.max(0, object.geometry.sag) : 0.1;
		const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - sag };
		board.create('curve', [[a.x, mid.x, b.x], [a.y, mid.y, b.y]], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.base,
			strokeWidth: 2
		});
	}

	function drawSpring(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [a, b] = pair;
		const turns = isFiniteNumber(object.geometry.turns) ? Math.max(3, Math.round(object.geometry.turns)) : 6;
		const amplitude = isFiniteNumber(object.geometry.amplitude) ? Math.max(0.05, object.geometry.amplitude) : 0.12;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy) || 1;
		const tx = dx / len;
		const ty = dy / len;
		const nx = -ty;
		const ny = tx;

		const xs: number[] = [];
		const ys: number[] = [];
		for (let i = 0; i <= turns * 2; i++) {
			const t = i / (turns * 2);
			const baseX = a.x + dx * t;
			const baseY = a.y + dy * t;
			const offset = i === 0 || i === turns * 2 ? 0 : i % 2 === 0 ? -amplitude : amplitude;
			xs.push(baseX + nx * offset);
			ys.push(baseY + ny * offset);
		}

		board.create('curve', [xs, ys], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.base,
			strokeWidth: 2
		});
	}

	function drawDamper(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [a, b] = pair;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy) || 1;
		const tx = dx / len;
		const ty = dy / len;
		const nx = -ty;
		const ny = tx;

		const bodyL = isFiniteNumber(object.geometry.bodyLength) ? Math.min(0.6, Math.max(0.15, object.geometry.bodyLength)) : 0.35;
		const halfW = 0.09;
		const center = { x: a.x + dx * 0.45, y: a.y + dy * 0.45 };
		const p1 = { x: center.x - tx * bodyL + nx * halfW, y: center.y - ty * bodyL + ny * halfW };
		const p2 = { x: center.x + tx * bodyL + nx * halfW, y: center.y + ty * bodyL + ny * halfW };
		const p3 = { x: center.x + tx * bodyL - nx * halfW, y: center.y + ty * bodyL - ny * halfW };
		const p4 = { x: center.x - tx * bodyL - nx * halfW, y: center.y - ty * bodyL - ny * halfW };

		drawSegment(a, { x: center.x - tx * bodyL, y: center.y - ty * bodyL }, { strokeColor: COLOR.base, strokeWidth: 2 });
		drawSegment({ x: center.x + tx * bodyL, y: center.y + ty * bodyL }, b, { strokeColor: COLOR.base, strokeWidth: 2 });
		board.create('polygon', [[p1.x, p1.y], [p2.x, p2.y], [p3.x, p3.y], [p4.x, p4.y]], {
			fixed: true,
			highlight: false,
			vertices: { visible: false },
			fillColor: 'transparent',
			strokeColor: COLOR.base,
			strokeWidth: 1.5
		});
	}

	function drawDisk(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const center = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!center) return;
		const radius = isFiniteNumber(object.geometry.radius) ? Math.max(0.1, object.geometry.radius) : 0.5;
		board.create('circle', [[center.x, center.y], radius], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.base,
			strokeWidth: 2,
			fillColor: 'transparent'
		});
	}

	function resolveMemberTangentAtNode(
		anchorNodeId: string | undefined,
		nodeMap: Map<string, NodeV2>
	): SchemaPoint | null {
		if (!anchorNodeId) return null;
		const schema = normalizedSchema;
		if (!schema) return null;
		const member = schema.objects.find(
			(object) =>
				(object.type === 'bar' || object.type === 'cable' || object.type === 'spring' || object.type === 'damper') &&
				Array.isArray(object.nodeRefs) &&
				object.nodeRefs.length >= 2 &&
				(object.nodeRefs[0] === anchorNodeId || object.nodeRefs[1] === anchorNodeId)
		);
		if (!member || !member.nodeRefs) return null;
		const from = getNode(nodeMap, member.nodeRefs[0]);
		const to = getNode(nodeMap, member.nodeRefs[1]);
		if (!from || !to) return null;
		const anchorIsStart = member.nodeRefs[0] === anchorNodeId;
		const dx = anchorIsStart ? to.x - from.x : from.x - to.x;
		const dy = anchorIsStart ? to.y - from.y : from.y - to.y;
		const length = Math.hypot(dx, dy);
		if (!length) return null;
		return { x: dx / length, y: dy / length };
	}

	function drawFixedWall(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!node) return;
		let angleDeg = isFiniteNumber(object.geometry.angle) ? object.geometry.angle : 90;
		const wallSide =
			typeof object.geometry.wallSide === 'string' ? object.geometry.wallSide.trim().toLowerCase() : '';
		if (!isFiniteNumber(object.geometry.angle) && wallSide) {
			const tangent = resolveMemberTangentAtNode(object.nodeRefs?.[0], nodeMap) ?? { x: 1, y: 0 };
			const normal = { x: -tangent.y, y: tangent.x };
			let hatchDirection = { ...normal };
			if (wallSide === 'left') hatchDirection = { x: -tangent.x, y: -tangent.y };
			if (wallSide === 'right') hatchDirection = { x: tangent.x, y: tangent.y };
			if (wallSide === 'top') hatchDirection = { x: normal.x, y: normal.y };
			if (wallSide === 'bottom') hatchDirection = { x: -normal.x, y: -normal.y };
			const wallDirection = { x: hatchDirection.y, y: -hatchDirection.x };
			angleDeg = (Math.atan2(wallDirection.y, wallDirection.x) * 180) / Math.PI;
		}
		const t = vectorFromAngleDegrees(angleDeg);
		const n = { x: -t.y, y: t.x };
		const a = { x: node.x - t.x * 0.45, y: node.y - t.y * 0.45 };
		const b = { x: node.x + t.x * 0.45, y: node.y + t.y * 0.45 };
		drawSegment(a, b, { strokeColor: COLOR.support, strokeWidth: 3 });
		for (let i = -2; i <= 2; i++) {
			const s = {
				x: node.x + t.x * i * 0.18,
				y: node.y + t.y * i * 0.18
			};
			drawSegment(
				{ x: s.x + n.x * 0.04, y: s.y + n.y * 0.04 },
				{ x: s.x + n.x * 0.22, y: s.y + n.y * 0.22 },
				{ strokeColor: COLOR.support, strokeWidth: 1 }
			);
		}
	}

	function drawHingeFixed(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!node) return;
		board.create('polygon', [[node.x - 0.3, node.y - 0.25], [node.x + 0.3, node.y - 0.25], [node.x, node.y]], {
			fixed: true,
			highlight: false,
			vertices: { visible: false },
			fillColor: 'var(--bg-surface)',
			fillOpacity: 0.85,
			strokeColor: COLOR.support,
			strokeWidth: 1.5
		});
		drawSegment({ x: node.x - 0.36, y: node.y - 0.28 }, { x: node.x + 0.36, y: node.y - 0.28 }, { strokeColor: COLOR.support, strokeWidth: 1.2 });
	}

	function drawHingeRoller(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!node) return;
		drawHingeFixed(object, nodeMap);
		board.create('circle', [[node.x - 0.16, node.y - 0.45], 0.1], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.support,
			fillColor: 'transparent'
		});
		board.create('circle', [[node.x + 0.16, node.y - 0.45], 0.1], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.support,
			fillColor: 'transparent'
		});
		drawSegment({ x: node.x - 0.5, y: node.y - 0.56 }, { x: node.x + 0.5, y: node.y - 0.56 }, { strokeColor: COLOR.support, strokeWidth: 1.2 });
	}

	function drawInternalHinge(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!node) return;
		board.create('circle', [[node.x, node.y], 0.08], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.base,
			strokeWidth: 1.5,
			fillColor: 'var(--bg-surface)',
			fillOpacity: 1
		});
	}

	function drawSlider(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		const guideStart = getNode(nodeMap, object.nodeRefs?.[1]);
		const guideEnd = getNode(nodeMap, object.nodeRefs?.[2]);
		if (!node || !guideStart || !guideEnd) return;
		drawSegment(guideStart, guideEnd, { strokeColor: COLOR.muted, strokeWidth: 1.2, dash: 2 });
		board.create('polygon', [[node.x - 0.16, node.y - 0.12], [node.x + 0.16, node.y - 0.12], [node.x + 0.16, node.y + 0.12], [node.x - 0.16, node.y + 0.12]], {
			fixed: true,
			highlight: false,
			vertices: { visible: false },
			fillColor: 'var(--bg-elevated)',
			strokeColor: COLOR.base,
			strokeWidth: 1.2
		});
	}

	function drawVectorLike(object: ObjectV2, nodeMap: Map<string, NodeV2>, color: string, prefix: string): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!node) return;
		const direction = normalizeDirection(object.geometry);
		const magnitude = isFiniteNumber(object.geometry.magnitude)
			? Math.max(0.35, Math.min(1.4, Math.abs(object.geometry.magnitude) / 8))
			: 0.9;
		const start = { x: node.x - direction.x * magnitude, y: node.y - direction.y * magnitude };
		drawArrow(start, node, { strokeColor: color, strokeWidth: 2 });
		const label = labelText(
			object,
			isFiniteNumber(object.geometry.magnitude) ? `${prefix}=${object.geometry.magnitude}` : prefix
		);
		drawText(
			{ x: start.x - direction.x * 0.12, y: start.y - direction.y * 0.12 },
			label,
			{ strokeColor: COLOR.text }
		);
	}

	function drawMomentLike(object: ObjectV2, nodeMap: Map<string, NodeV2>, color: string, defaultLabel: string): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!node) return;
		const direction = object.geometry.direction === 'cw' ? 'cw' : 'ccw';
		const radius = isFiniteNumber(object.geometry.radius) ? Math.max(0.2, Math.min(1.2, Math.abs(object.geometry.radius))) : 0.45;
		board.create('circle', [[node.x, node.y], radius], {
			fixed: true,
			highlight: false,
			strokeColor: color,
			strokeWidth: 1.6,
			dash: 2,
			fillColor: 'transparent'
		});
		const arrowFrom = direction === 'cw' ? { x: node.x + radius, y: node.y + 0.05 } : { x: node.x - radius, y: node.y + 0.05 };
		const arrowTo = direction === 'cw' ? { x: node.x + radius - 0.15, y: node.y - 0.16 } : { x: node.x - radius + 0.15, y: node.y - 0.16 };
		drawArrow(arrowFrom, arrowTo, { strokeColor: color, strokeWidth: 1.8 });
		const label = labelText(object, defaultLabel);
		drawText({ x: node.x + radius + 0.14, y: node.y + radius + 0.1 }, label, { strokeColor: COLOR.text });
	}

	function drawDistributed(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [start, end] = pair;
		const direction = normalizeDirection(object.geometry, isFiniteNumber(object.geometry.directionAngle) ? object.geometry.directionAngle : -90);
		const count = isFiniteNumber(object.geometry.arrowCount) ? Math.max(3, Math.min(16, Math.round(object.geometry.arrowCount))) : 7;
		const length = 0.75;

		for (let i = 0; i < count; i++) {
			const t = count === 1 ? 0 : i / (count - 1);
			const base = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
			const from = { x: base.x - direction.x * length, y: base.y - direction.y * length };
			drawArrow(from, base, { strokeColor: COLOR.load, strokeWidth: 1.4 });
		}

		drawSegment(
			{ x: start.x - direction.x * length, y: start.y - direction.y * length },
			{ x: end.x - direction.x * length, y: end.y - direction.y * length },
			{ strokeColor: COLOR.load, strokeWidth: 1.2, dash: 1 }
		);

		const intensity = object.geometry.intensity;
		let label = labelText(object, 'q');
		if (isFiniteNumber(intensity)) label = `q=${intensity}`;
		if (isRecord(intensity) && isFiniteNumber(intensity.start) && isFiniteNumber(intensity.end)) {
			label = `q=[${intensity.start}; ${intensity.end}]`;
		}
		drawText(
			{
				x: (start.x + end.x) / 2 - direction.x * (length + 0.2),
				y: (start.y + end.y) / 2 - direction.y * (length + 0.2)
			},
			label,
			{ anchorX: 'middle' }
		);
	}

	function drawTrajectory(object: ObjectV2 | ResultV2): void {
		if (!Array.isArray(object.geometry.points)) return;
		const points = object.geometry.points.map((entry) => toPoint(entry)).filter((entry): entry is SchemaPoint => Boolean(entry));
		if (points.length < 2) return;
		const xs = points.map((p) => p.x);
		const ys = points.map((p) => p.y);
		board.create('curve', [xs, ys], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.kinematic,
			strokeWidth: 1.3,
			dash: object.geometry.lineType === 'solid' ? 0 : 2
		});
	}

	function drawDimension(object: ObjectV2 | ResultV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [a, b] = pair;
		const offset = isFiniteNumber(object.geometry.offset) ? object.geometry.offset : 0.28;
		const p1 = { x: a.x, y: a.y + offset };
		const p2 = { x: b.x, y: b.y + offset };
		drawSegment(p1, p2, { strokeColor: COLOR.muted, strokeWidth: 1, dash: 1 });
		drawArrow({ x: p1.x + 0.001, y: p1.y }, { x: p1.x + 0.15, y: p1.y }, { strokeColor: COLOR.muted, strokeWidth: 1 });
		drawArrow({ x: p2.x - 0.001, y: p2.y }, { x: p2.x - 0.15, y: p2.y }, { strokeColor: COLOR.muted, strokeWidth: 1 });
		drawText({ x: (p1.x + p2.x) / 2, y: p1.y + 0.1 }, labelText(object, ''), { anchorX: 'middle' });
	}

	function drawAxis(object: ObjectV2 | ResultV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		drawArrow(pair[0], pair[1], { strokeColor: COLOR.muted, strokeWidth: 1.2, dash: 2 });
		drawText({ x: pair[1].x, y: pair[1].y }, labelText(object, 'axis'), { strokeColor: COLOR.muted });
	}

	function drawGround(object: ObjectV2 | ResultV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		drawSegment(pair[0], pair[1], { strokeColor: COLOR.muted, strokeWidth: 1.2 });
		const count = 8;
		for (let i = 0; i <= count; i++) {
			const t = i / count;
			const x = pair[0].x + (pair[1].x - pair[0].x) * t;
			const y = pair[0].y + (pair[1].y - pair[0].y) * t;
			drawSegment({ x, y }, { x: x + 0.1, y: y - 0.12 }, { strokeColor: COLOR.muted, strokeWidth: 0.8 });
		}
	}

	function drawLabelObject(object: ObjectV2 | ResultV2, nodeMap: Map<string, NodeV2>): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (node) {
			drawText({ x: node.x, y: node.y }, labelText(object, 'label'));
			return;
		}
		const p = toPoint(object.geometry.point);
		if (p) drawText(p, labelText(object, 'label'));
	}

	function drawDebugLayer(schema: SchemaDataV2, nodeMap: Map<string, NodeV2>): void {
		for (const node of schema.nodes) {
			board.create('point', [node.x, node.y], {
				name: node.id,
				withLabel: true,
				size: 2,
				face: 'o',
				strokeColor: '#16a34a',
				fillColor: '#16a34a',
				fixed: true,
				highlight: false,
				label: {
					offset: [5, 5],
					strokeColor: '#16a34a',
					fontSize: 10
				}
			});
		}

		for (const object of schema.objects) {
			const pair = getPair(nodeMap, object.nodeRefs);
			if (!pair) continue;
			if (!isFiniteNumber(object.geometry.length) && !isFiniteNumber(object.geometry.L)) continue;
			const hintedLength = isFiniteNumber(object.geometry.length) ? object.geometry.length : object.geometry.L;
			drawText(
				{ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 + 0.12 },
				`L=${hintedLength}`,
				{ strokeColor: '#16a34a', fontSize: 10, anchorX: 'middle' }
			);
		}
	}

	function drawEpure(result: ResultV2, nodeMap: Map<string, NodeV2>): void {
		if (!isRecord(result.geometry.baseLine)) return;
		const baseLine = result.geometry.baseLine;
		const startNodeId = typeof baseLine.startNodeId === 'string' ? baseLine.startNodeId : undefined;
		const endNodeId = typeof baseLine.endNodeId === 'string' ? baseLine.endNodeId : undefined;
		const startFromRef = getNode(nodeMap, result.nodeRefs?.[0]);
		const endFromRef = getNode(nodeMap, result.nodeRefs?.[1]);
		const startFromPoint = toPoint(baseLine.start) ?? toPoint(baseLine.from);
		const endFromPoint = toPoint(baseLine.end) ?? toPoint(baseLine.to);
		const start = getNode(nodeMap, startNodeId) ?? startFromRef ?? startFromPoint;
		const end = getNode(nodeMap, endNodeId) ?? endFromRef ?? endFromPoint;
		if (!start || !end || !Array.isArray(result.geometry.values)) return;

		const values = result.geometry.values
			.map((entry) => {
				if (!isRecord(entry) || !isFiniteNumber(entry.s) || !isFiniteNumber(entry.value)) return null;
				return { s: entry.s, value: entry.value };
			})
			.filter((entry): entry is { s: number; value: number } => Boolean(entry));
		if (values.length < 2) return;

		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const len = Math.hypot(dx, dy) || 1;
		const tx = dx / len;
		const ty = dy / len;
		const nx = -ty;
		const ny = tx;
		const maxAbs = Math.max(...values.map((v) => Math.abs(v.value)), 1);
		const scale = 0.8 / maxAbs;

		const upper = values.map((v) => {
			const bx = start.x + dx * v.s;
			const by = start.y + dy * v.s;
			return { x: bx + nx * v.value * scale, y: by + ny * v.value * scale };
		});
		const base = values
			.slice()
			.reverse()
			.map((v) => ({ x: start.x + dx * v.s, y: start.y + dy * v.s }));

		const polygon = [...upper, ...base].map((p) => [p.x, p.y]);
		board.create('polygon', polygon as any, {
			fixed: true,
			highlight: false,
			vertices: { visible: false },
			fillColor: 'rgba(245, 158, 11, 0.15)',
			strokeColor: COLOR.result,
			strokeWidth: 1.3
		});

		const kind = typeof result.geometry.kind === 'string' ? result.geometry.kind : 'epure';
		drawText({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 + 0.2 }, kind, { strokeColor: COLOR.result, anchorX: 'middle' });
	}

	type DrawFn = (object: ObjectV2, nodeMap: Map<string, NodeV2>) => void;
	const objectRenderers: Record<string, DrawFn> = {
		bar: drawBar,
		cable: drawCable,
		spring: drawSpring,
		damper: drawDamper,
		rigid_disk: drawDisk,
		fixed_wall: drawFixedWall,
		hinge_fixed: drawHingeFixed,
		hinge_roller: drawHingeRoller,
		internal_hinge: drawInternalHinge,
		slider: drawSlider,
		force: (o, m) => drawVectorLike(o, m, COLOR.load, 'F'),
		moment: (o, m) => drawMomentLike(o, m, COLOR.load, 'M'),
		distributed: drawDistributed,
		velocity: (o, m) => drawVectorLike(o, m, COLOR.kinematic, 'v'),
		acceleration: (o, m) => drawVectorLike(o, m, '#ef4444', 'a'),
		angular_velocity: (o, m) => drawMomentLike(o, m, COLOR.kinematic, '?'),
		angular_acceleration: (o, m) => drawMomentLike(o, m, '#ef4444', '?'),
		trajectory: (o) => drawTrajectory(o),
		label: drawLabelObject,
		dimension: drawDimension,
		axis: drawAxis,
		ground: drawGround,
		epure: () => {
			// Epure should live in results; silently ignore in objects.
		}
	};

	function renderObject(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const renderer = objectRenderers[object.type];
		if (!renderer) return;
		renderer(object, nodeMap);
	}

	function renderResult(result: ResultV2, nodeMap: Map<string, NodeV2>): void {
		if (result.type === 'epure') {
			drawEpure(result, nodeMap);
			return;
		}
		if (result.type === 'trajectory') {
			drawTrajectory(result);
			return;
		}
		if (result.type === 'label') {
			drawLabelObject(result, nodeMap);
			return;
		}
		if (result.type === 'dimension') {
			drawDimension(result, nodeMap);
			return;
		}
		if (result.type === 'axis') {
			drawAxis(result, nodeMap);
			return;
		}
	}

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
		const schema = normalizedSchema;
		if (!schema || schema.objects.length === 0 || board) return;

		const JSXGraphModule = await import('jsxgraph');
		const JXG = JSXGraphModule.default ?? JSXGraphModule;

		const points = collectPoints(schema);
		const xs = points.map((point) => point.x);
		const ys = points.map((point) => point.y);
		const xMin = xs.length > 0 ? Math.min(...xs) : -2;
		const xMax = xs.length > 0 ? Math.max(...xs) : 2;
		const yMin = ys.length > 0 ? Math.min(...ys) : -2;
		const yMax = ys.length > 0 ? Math.max(...ys) : 2;
		const xPad = Math.max(0.8, (xMax - xMin) * 0.24);
		const yPad = Math.max(0.8, (yMax - yMin) * 0.24);

		board = JXG.JSXGraph.initBoard(boardId, {
			boundingbox: [xMin - xPad, yMax + yPad, xMax + xPad, yMin - yPad],
			axis: true,
			grid: true,
			showCopyright: false,
			showNavigation: false,
			showScreenshot: false,
			keepAspectRatio: true
		});

		board.options.grid.strokeColor = 'var(--border-subtle)';
		board.options.axis.strokeColor = 'var(--border-medium)';

		const nodeMap = createNodeMap(schema);
		for (const object of schema.objects) {
			try {
				renderObject(object, nodeMap);
			} catch (err) {
				console.warn('[SchemeView] Failed to render object:', object.id, err);
			}
		}

		for (const result of schema.results ?? []) {
			try {
				renderResult(result, nodeMap);
			} catch (err) {
				console.warn('[SchemeView] Failed to render result:', result.id, err);
			}
		}

		if (debug) {
			drawDebugLayer(schema, nodeMap);
		}
		isReady = true;
		requestAnimationFrame(() => requestBoardResize());
	}

	onMount(() => {
		const schema = normalizedSchema;
		if (!schema || schema.objects.length === 0) return;

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
			(globalThis as any).JXG?.JSXGraph?.freeBoard(board);
		} catch {
			// ignore cleanup errors
		}
	});
</script>

{#if normalizedSchema?.objects?.length}
	<div class="scheme-wrapper" bind:this={wrapperEl} class:fullscreen={isFullscreen}>
		<div class="scheme-title">
			<span>{title}</span>
			<button class="scheme-fullscreen-btn" onclick={toggleFullscreen}>
				{isFullscreen ? 'Close' : 'Full screen'}
			</button>
		</div>
		<div class="scheme-board" id={boardId} bind:this={boardEl}></div>
		{#if !isReady}
			<div class="scheme-loading">Preparing scheme...</div>
		{/if}
		{#if debug && layoutDiagnostics}
			<div class="scheme-debug">
				<div class="scheme-debug-line">
					Auto corrected: {layoutDiagnostics.autoCorrected ? 'yes' : 'no'} | Corrections: {layoutDiagnostics.corrections.length}
				</div>
				{#if layoutDiagnostics.afterSnapshot}
					<div class="scheme-debug-line">
						After: {layoutDiagnostics.afterSnapshot}
					</div>
				{/if}
				{#if layoutDiagnostics.beforeSnapshot}
					<div class="scheme-debug-line">
						Before: {layoutDiagnostics.beforeSnapshot}
					</div>
				{/if}
				{#if layoutDiagnostics.corrections.length > 0}
					<div class="scheme-debug-line">Ops: {layoutDiagnostics.corrections.join(', ')}</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.scheme-wrapper {
		margin: 1rem 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--bg-elevated);
		position: relative;
	}

	.scheme-title {
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

	.scheme-fullscreen-btn {
		border: 1px solid var(--border-subtle);
		background: var(--bg-card);
		color: var(--text-secondary);
		border-radius: var(--radius-sm);
		font-size: 0.67rem;
		padding: 0.2rem 0.45rem;
		cursor: pointer;
	}

	.scheme-board {
		width: 100%;
		height: clamp(250px, 48vh, 380px);
	}

	.scheme-loading {
		position: absolute;
		inset: auto 0 0 0;
		padding: 0.4rem 0.65rem;
		font-size: 0.73rem;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--bg-surface) 86%, transparent);
		border-top: 1px dashed var(--border-subtle);
	}

	.scheme-debug {
		padding: 0.5rem 0.75rem 0.65rem;
		border-top: 1px dashed var(--border-subtle);
		background: color-mix(in srgb, var(--bg-surface) 72%, transparent);
		font-family: var(--font-mono);
		font-size: 0.74rem;
		color: var(--text-muted);
	}

	.scheme-debug-line + .scheme-debug-line {
		margin-top: 0.22rem;
	}

	.scheme-wrapper.fullscreen {
		position: fixed;
		inset: 0;
		margin: 0;
		z-index: 1200;
		border-radius: 0;
	}

	.scheme-wrapper.fullscreen .scheme-title {
		padding-top: calc(0.5rem + env(safe-area-inset-top));
	}

	.scheme-wrapper.fullscreen .scheme-board {
		height: calc(100dvh - 46px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
	}

	:global(.jxgtext) {
		font-family: var(--font-mono);
	}

	@media (max-width: 768px) {
		.scheme-title {
			padding: 0.45rem 0.58rem;
			font-size: 0.68rem;
		}

		.scheme-fullscreen-btn {
			font-size: 0.63rem;
			padding: 0.18rem 0.42rem;
		}

		.scheme-board {
			height: clamp(210px, 37dvh, 290px);
		}

		.scheme-debug {
			font-size: 0.69rem;
		}
	}
</style>
