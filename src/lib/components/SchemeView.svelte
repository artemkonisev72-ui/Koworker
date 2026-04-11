<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { SchemaData, SchemaPoint } from '$lib/schema/schema-data.js';
	import type { NodeV2, ObjectV2, ResultV2, SchemaDataV2 } from '$lib/schema/schema-v2.js';
	import { normalizeSchemaDataV2 } from '$lib/schema/normalize-v2.js';
	import { adaptSchemaV1ToV2 } from '$lib/schema/adapters-v2.js';

	let { schemaData, title = 'Verified scheme' }: { schemaData: unknown; title?: string } = $props();

	let board: any = null;
	const boardId = `scheme-${Math.random().toString(36).slice(2, 10)}`;

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

	function vectorFromAngleDegrees(angle: number): SchemaPoint {
		const rad = (angle * Math.PI) / 180;
		return { x: Math.cos(rad), y: Math.sin(rad) };
	}

	function normalizeDirection(geometry: Record<string, unknown>, fallbackAngle = -90): SchemaPoint {
		const dir = geometry.direction;
		if (isPoint(dir)) {
			const len = Math.hypot(dir.x, dir.y) || 1;
			return { x: dir.x / len, y: dir.y / len };
		}

		const angle = isFiniteNumber(geometry.directionAngle) ? geometry.directionAngle : null;
		if (angle !== null) return vectorFromAngleDegrees(angle);

		const cardinal = typeof geometry.cardinal === 'string' ? geometry.cardinal.toLowerCase() : '';
		if (cardinal === 'up') return { x: 0, y: 1 };
		if (cardinal === 'down') return { x: 0, y: -1 };
		if (cardinal === 'left') return { x: -1, y: 0 };
		if (cardinal === 'right') return { x: 1, y: 0 };

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

	function drawFixedWall(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!node) return;
		const angleDeg = isFiniteNumber(object.geometry.angle) ? object.geometry.angle : 90;
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
		const start = { x: node.x + direction.x * magnitude, y: node.y + direction.y * magnitude };
		drawArrow(start, node, { strokeColor: color, strokeWidth: 2 });
		const label = labelText(object, isFiniteNumber(object.geometry.magnitude) ? `${prefix}=${object.geometry.magnitude}` : prefix);
		drawText({ x: start.x, y: start.y + 0.15 }, label, { strokeColor: COLOR.text });
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
			const from = { x: base.x + direction.x * length, y: base.y + direction.y * length };
			drawArrow(from, base, { strokeColor: COLOR.load, strokeWidth: 1.4 });
		}

		drawSegment(
			{ x: start.x + direction.x * length, y: start.y + direction.y * length },
			{ x: end.x + direction.x * length, y: end.y + direction.y * length },
			{ strokeColor: COLOR.load, strokeWidth: 1.2, dash: 1 }
		);

		const intensity = object.geometry.intensity;
		let label = labelText(object, 'q');
		if (isFiniteNumber(intensity)) label = `q=${intensity}`;
		if (isRecord(intensity) && isFiniteNumber(intensity.start) && isFiniteNumber(intensity.end)) {
			label = `q=[${intensity.start}; ${intensity.end}]`;
		}
		drawText({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 + direction.y * (length + 0.2) }, label, { anchorX: 'middle' });
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

	function drawEpure(result: ResultV2, nodeMap: Map<string, NodeV2>): void {
		if (!isRecord(result.geometry.baseLine)) return;
		const startNodeId = typeof result.geometry.baseLine.startNodeId === 'string' ? result.geometry.baseLine.startNodeId : undefined;
		const endNodeId = typeof result.geometry.baseLine.endNodeId === 'string' ? result.geometry.baseLine.endNodeId : undefined;
		const start = getNode(nodeMap, startNodeId);
		const end = getNode(nodeMap, endNodeId);
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

	onMount(async () => {
		const schema = normalizedSchema;
		if (!schema || schema.objects.length === 0) return;

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
			keepAspectRatio: false
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
		height: 340px;
	}

	:global(.jxgtext) {
		font-family: var(--font-mono);
	}
</style>
