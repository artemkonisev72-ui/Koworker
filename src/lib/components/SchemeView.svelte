<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import {
		buildEpureLayout,
		transformEpurePoint,
		transformEpureSegment
	} from '$lib/epure/layout.js';
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

	function applyBoardTheme() {
		if (!board) return;
		const axisStroke = 'var(--border-medium)';
		const axisText = 'var(--text-secondary)';
		board.options.grid.strokeColor = 'var(--border-subtle)';
		board.options.axis.strokeColor = axisStroke;
		board.options.text.strokeColor = axisText;
		board.options.text.highlightStrokeColor = axisText;

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
	}

	function getTitleHeight(): number {
		const titleEl = wrapperEl?.querySelector<HTMLElement>('.scheme-title');
		if (!titleEl) return 0;
		return titleEl.offsetHeight;
	}

	function computeBoardSize(): { width: number; height: number } | null {
		if (!boardEl) return null;
		const titleHeight = getTitleHeight();
		const fallbackWidth = Math.floor(boardEl.clientWidth || 320);
		const fallbackHeight = Math.floor(boardEl.clientHeight || 250);

		if (isFullscreen) {
			const viewportWidth = Math.floor(window.visualViewport?.width ?? window.innerWidth);
			const viewportHeight = Math.floor(window.visualViewport?.height ?? window.innerHeight);
			return {
				width: Math.max(320, viewportWidth),
				height: Math.max(220, viewportHeight - titleHeight)
			};
		}

		return {
			width: Math.max(240, fallbackWidth),
			height: Math.max(220, fallbackHeight)
		};
	}

	const COLOR = {
		base: 'var(--text-primary)',
		support: 'var(--text-secondary)',
		load: 'var(--text-secondary)',
		kinematic: 'var(--text-secondary)',
		result: 'var(--text-muted)',
		muted: 'var(--text-muted)',
		text: 'var(--text-secondary)'
	} as const;
	const EPURE_CURVE_STROKE_WIDTH = 1.6;
	const EPURE_BEAM_STROKE_WIDTH = EPURE_CURVE_STROKE_WIDTH + 0.8;

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function isFiniteNumber(value: unknown): value is number {
		return typeof value === 'number' && Number.isFinite(value);
	}

	function isPoint(value: unknown): value is SchemaPoint {
		return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
	}

	function normalizeStructureKind(
		value: unknown
	): 'beam' | 'planar_frame' | 'spatial_frame' | 'planar_mechanism' | 'spatial_mechanism' {
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

	function normalizeProjectionPreset(value: unknown): 'auto_isometric' | 'xy' | 'xz' | 'yz' {
		if (typeof value !== 'string') return 'auto_isometric';
		const normalized = value.trim().toLowerCase();
		if (normalized === 'xy' || normalized === 'xz' || normalized === 'yz' || normalized === 'auto_isometric') {
			return normalized;
		}
		return 'auto_isometric';
	}

	function projectSpatialPoint(
		point: { x: number; y: number; z?: number },
		preset: 'auto_isometric' | 'xy' | 'xz' | 'yz'
	): SchemaPoint {
		const z = isFiniteNumber(point.z) ? point.z : 0;
		if (preset === 'xy') return { x: point.x, y: point.y };
		if (preset === 'xz') return { x: point.x, y: z };
		if (preset === 'yz') return { x: point.y, y: z };
		const cos30 = 0.8660254038;
		return {
			x: (point.x - point.y) * cos30,
			y: z + (point.x + point.y) * 0.5
		};
	}

	function projectNode(schema: SchemaDataV2, node: NodeV2): SchemaPoint {
		const modelSpace = schema.coordinateSystem?.modelSpace === 'spatial' ? 'spatial' : 'planar';
		if (modelSpace !== 'spatial') return { x: node.x, y: node.y };
		const preset = normalizeProjectionPreset(schema.coordinateSystem?.projectionPreset);
		return projectSpatialPoint(node, preset);
	}

	function resolveStructureKind(
		schema: SchemaDataV2
	): 'beam' | 'planar_frame' | 'spatial_frame' | 'planar_mechanism' | 'spatial_mechanism' {
		const fromMeta = normalizeStructureKind(schema.meta?.structureKind);
		if (fromMeta !== 'beam') return fromMeta;
		if (schema.coordinateSystem?.modelSpace === 'spatial') return 'spatial_frame';
		return fromMeta;
	}

	function toPoint(value: unknown): SchemaPoint | null {
		if (isPoint(value)) return { x: value.x, y: value.y };
		if (
			Array.isArray(value) &&
			value.length === 2 &&
			isFiniteNumber(value[0]) &&
			isFiniteNumber(value[1])
		) {
			return { x: value[0], y: value[1] };
		}
		return null;
	}

	function toPoint3(value: unknown): { x: number; y: number; z: number } | null {
		if (isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)) {
			return {
				x: value.x,
				y: value.y,
				z: isFiniteNumber(value.z) ? value.z : 0
			};
		}
		if (
			Array.isArray(value) &&
			value.length >= 2 &&
			isFiniteNumber(value[0]) &&
			isFiniteNumber(value[1])
		) {
			return {
				x: value[0],
				y: value[1],
				z: isFiniteNumber(value[2]) ? value[2] : 0
			};
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
		const collapse = isFiniteNumber(metrics.coordCollapseRate)
			? metrics.coordCollapseRate.toFixed(3)
			: '-';
		const minSep = isFiniteNumber(metrics.minElementSeparation)
			? metrics.minElementSeparation.toFixed(3)
			: '-';
		const aspect = isFiniteNumber(metrics.aspectDistortion)
			? metrics.aspectDistortion.toFixed(3)
			: '-';
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
		const normalized = value
			.trim()
			.toLowerCase()
			.replace(/[\s_-]+/g, '');
		if (!normalized) return null;
		if (normalized === 'up' || normalized === 'u' || normalized === 'north' || normalized === '+y')
			return { x: 0, y: 1 };
		if (
			normalized === 'down' ||
			normalized === 'd' ||
			normalized === 'south' ||
			normalized === '-y'
		)
			return { x: 0, y: -1 };
		if (normalized === 'left' || normalized === 'l' || normalized === 'west' || normalized === '-x')
			return { x: -1, y: 0 };
		if (
			normalized === 'right' ||
			normalized === 'r' ||
			normalized === 'east' ||
			normalized === '+x'
		)
			return { x: 1, y: 0 };
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

		const angle = isFiniteNumber(geometry.directionAngle)
			? geometry.directionAngle
			: isFiniteNumber(geometry.angleDeg)
				? geometry.angleDeg
				: isFiniteNumber(geometry.angle)
					? geometry.angle
					: isFiniteNumber(geometry.thetaDeg)
						? geometry.thetaDeg
						: isFiniteNumber(geometry.theta)
							? geometry.theta
							: null;
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
		const points: SchemaPoint[] = schema.nodes.map((node) => projectNode(schema, node));

		for (const object of schema.objects) {
			if (object.type === 'trajectory' && Array.isArray(object.geometry.points)) {
				for (const rawPoint of object.geometry.points) {
					const point = toPoint3(rawPoint);
					if (!point) continue;
					points.push(
						schema.coordinateSystem?.modelSpace === 'spatial'
							? projectSpatialPoint(point, normalizeProjectionPreset(schema.coordinateSystem?.projectionPreset))
							: { x: point.x, y: point.y }
					);
				}
			}
		}

		for (const result of schema.results ?? []) {
			if (result.type === 'trajectory' && Array.isArray(result.geometry.points)) {
				for (const rawPoint of result.geometry.points) {
					const point = toPoint3(rawPoint);
					if (!point) continue;
					points.push(
						schema.coordinateSystem?.modelSpace === 'spatial'
							? projectSpatialPoint(point, normalizeProjectionPreset(schema.coordinateSystem?.projectionPreset))
							: { x: point.x, y: point.y }
					);
				}
			}
		}

		if (schema.coordinateSystem?.origin && isPoint(schema.coordinateSystem.origin)) {
			const originPoint = {
				x: schema.coordinateSystem.origin.x,
				y: schema.coordinateSystem.origin.y,
				z: 0
			};
			points.push(
				schema.coordinateSystem?.modelSpace === 'spatial'
					? projectSpatialPoint(
							originPoint,
							normalizeProjectionPreset(schema.coordinateSystem?.projectionPreset)
						)
					: schema.coordinateSystem.origin
			);
		}
		return points;
	}

	function createNodeMap(schema: SchemaDataV2): Map<string, NodeV2> {
		return new Map(
			schema.nodes.map((node) => {
				const projected = projectNode(schema, node);
				return [
					node.id,
					{
						...node,
						x: projected.x,
						y: projected.y
					}
				];
			})
		);
	}

	function getNode(nodeMap: Map<string, NodeV2>, id: string | undefined): NodeV2 | null {
		if (!id) return null;
		return nodeMap.get(id) ?? null;
	}

	function getPair(
		nodeMap: Map<string, NodeV2>,
		refs: string[] | undefined
	): [NodeV2, NodeV2] | null {
		if (!refs || refs.length < 2) return null;
		const a = getNode(nodeMap, refs[0]);
		const b = getNode(nodeMap, refs[1]);
		if (!a || !b) return null;
		return [a, b];
	}

	function labelText(object: ObjectV2 | ResultV2, fallback = ''): string {
		if (typeof object.label === 'string' && object.label.trim()) return object.label.trim();
		if (typeof object.geometry.label === 'string' && object.geometry.label.trim())
			return object.geometry.label.trim();
		if (typeof object.geometry.text === 'string' && object.geometry.text.trim())
			return object.geometry.text.trim();
		return fallback;
	}

	function drawLinearObjectLabel(object: ObjectV2, a: SchemaPoint, b: SchemaPoint): void {
		const label = labelText(object, '');
		if (!label) return;
		drawText(
			{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 0.14 },
			label,
			{ anchorX: 'middle', strokeColor: COLOR.text }
		);
	}

	function drawSegment(a: SchemaPoint, b: SchemaPoint, options: Record<string, unknown>): void {
		board.create(
			'segment',
			[
				[a.x, a.y],
				[b.x, b.y]
			],
			{
				fixed: true,
				highlight: false,
				...options
			}
		);
	}

	function drawArrow(a: SchemaPoint, b: SchemaPoint, options: Record<string, unknown>): void {
		const stroke =
			typeof options.strokeColor === 'string' && options.strokeColor.trim().length > 0
				? options.strokeColor
				: COLOR.base;
		board.create(
			'arrow',
			[
				[a.x, a.y],
				[b.x, b.y]
			],
			{
				fixed: true,
				highlight: false,
				lastArrow: true,
				strokeColor: stroke,
				fillColor: stroke,
				highlightStrokeColor: stroke,
				highlightFillColor: stroke,
				...options
			}
		);
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
			strokeWidth: isFiniteNumber(object.geometry.thickness)
				? Math.max(1, object.geometry.thickness)
				: 4,
			dash: object.geometry.lineType === 'dashed' ? 2 : 0
		});
		drawLinearObjectLabel(object, pair[0], pair[1]);
	}

	function drawCable(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [a, b] = pair;
		const sag = isFiniteNumber(object.geometry.sag) ? Math.max(0, object.geometry.sag) : 0.1;
		const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - sag };
		board.create(
			'curve',
			[
				[a.x, mid.x, b.x],
				[a.y, mid.y, b.y]
			],
			{
				fixed: true,
				highlight: false,
				strokeColor: COLOR.base,
				strokeWidth: 2
			}
		);
		drawLinearObjectLabel(object, a, b);
	}

	function drawSpring(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [a, b] = pair;
		const turns = isFiniteNumber(object.geometry.turns)
			? Math.max(3, Math.round(object.geometry.turns))
			: 6;
		const amplitude = isFiniteNumber(object.geometry.amplitude)
			? Math.max(0.05, object.geometry.amplitude)
			: 0.12;
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
		drawLinearObjectLabel(object, a, b);
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

		const bodyL = isFiniteNumber(object.geometry.bodyLength)
			? Math.min(0.6, Math.max(0.15, object.geometry.bodyLength))
			: 0.35;
		const halfW = 0.09;
		const center = { x: a.x + dx * 0.45, y: a.y + dy * 0.45 };
		const p1 = { x: center.x - tx * bodyL + nx * halfW, y: center.y - ty * bodyL + ny * halfW };
		const p2 = { x: center.x + tx * bodyL + nx * halfW, y: center.y + ty * bodyL + ny * halfW };
		const p3 = { x: center.x + tx * bodyL - nx * halfW, y: center.y + ty * bodyL - ny * halfW };
		const p4 = { x: center.x - tx * bodyL - nx * halfW, y: center.y - ty * bodyL - ny * halfW };

		drawSegment(
			a,
			{ x: center.x - tx * bodyL, y: center.y - ty * bodyL },
			{ strokeColor: COLOR.base, strokeWidth: 2 }
		);
		drawSegment({ x: center.x + tx * bodyL, y: center.y + ty * bodyL }, b, {
			strokeColor: COLOR.base,
			strokeWidth: 2
		});
		board.create(
			'polygon',
			[
				[p1.x, p1.y],
				[p2.x, p2.y],
				[p3.x, p3.y],
				[p4.x, p4.y]
			],
			{
				fixed: true,
				highlight: false,
				vertices: { visible: false, fixed: true, highlight: false, withLabel: false },
				fillColor: 'transparent',
				strokeColor: COLOR.base,
				strokeWidth: 1.5
			}
		);
		drawLinearObjectLabel(object, a, b);
	}

	function drawDisk(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const center = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!center) return;
		const radius = isFiniteNumber(object.geometry.radius)
			? Math.max(0.1, object.geometry.radius)
			: 0.5;
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
				(object.type === 'bar' ||
					object.type === 'cable' ||
					object.type === 'spring' ||
					object.type === 'damper') &&
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
			typeof object.geometry.wallSide === 'string'
				? object.geometry.wallSide.trim().toLowerCase()
				: '';
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
		board.create(
			'polygon',
			[
				[node.x - 0.3, node.y - 0.25],
				[node.x + 0.3, node.y - 0.25],
				[node.x, node.y]
			],
			{
				fixed: true,
				highlight: false,
				vertices: { visible: false, fixed: true, highlight: false, withLabel: false },
				fillColor: 'var(--bg-surface)',
				fillOpacity: 0.85,
				strokeColor: COLOR.support,
				strokeWidth: 1.5
			}
		);
		drawSegment(
			{ x: node.x - 0.36, y: node.y - 0.28 },
			{ x: node.x + 0.36, y: node.y - 0.28 },
			{ strokeColor: COLOR.support, strokeWidth: 1.2 }
		);
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
		drawSegment(
			{ x: node.x - 0.5, y: node.y - 0.56 },
			{ x: node.x + 0.5, y: node.y - 0.56 },
			{ strokeColor: COLOR.support, strokeWidth: 1.2 }
		);
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
		board.create(
			'polygon',
			[
				[node.x - 0.16, node.y - 0.12],
				[node.x + 0.16, node.y - 0.12],
				[node.x + 0.16, node.y + 0.12],
				[node.x - 0.16, node.y + 0.12]
			],
			{
				fixed: true,
				highlight: false,
				vertices: { visible: false, fixed: true, highlight: false, withLabel: false },
				fillColor: 'var(--bg-elevated)',
				strokeColor: COLOR.base,
				strokeWidth: 1.2
			}
		);
	}

	function drawRevolutePair(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		drawInternalHinge(object, nodeMap);
	}

	function drawPrismaticPair(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		drawSlider(object, nodeMap);
	}

	function drawSlotPair(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		const guideStart = getNode(nodeMap, object.nodeRefs?.[1]);
		const guideEnd = getNode(nodeMap, object.nodeRefs?.[2]);
		if (!node || !guideStart || !guideEnd) return;
		drawSegment(guideStart, guideEnd, { strokeColor: COLOR.muted, strokeWidth: 1.2, dash: 2 });
		board.create('circle', [[node.x, node.y], 0.075], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.base,
			fillColor: 'var(--bg-surface)',
			fillOpacity: 1
		});
	}

	function drawCam(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const center = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!center) return;
		const radius = isFiniteNumber(object.geometry.radius)
			? Math.max(0.1, object.geometry.radius)
			: 0.6;
		board.create('circle', [[center.x, center.y], radius], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.base,
			strokeWidth: 2,
			dash: 2,
			fillColor: 'transparent'
		});
	}

	function drawCamContact(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		drawSegment(pair[0], pair[1], { strokeColor: COLOR.kinematic, strokeWidth: 1.2, dash: 2 });
		board.create('circle', [[pair[1].x, pair[1].y], 0.06], {
			fixed: true,
			highlight: false,
			strokeColor: COLOR.kinematic,
			fillColor: 'var(--bg-surface)',
			fillOpacity: 1
		});
	}

	function drawGearPair(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		drawSegment(pair[0], pair[1], { strokeColor: COLOR.kinematic, strokeWidth: 1.2, dash: 1 });
	}

	function drawBeltPair(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [a, b] = pair;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy) || 1;
		const nx = -dy / len;
		const ny = dx / len;
		const offset = 0.08;
		drawSegment(
			{ x: a.x + nx * offset, y: a.y + ny * offset },
			{ x: b.x + nx * offset, y: b.y + ny * offset },
			{ strokeColor: COLOR.kinematic, strokeWidth: 1.2 }
		);
		drawSegment(
			{ x: a.x - nx * offset, y: a.y - ny * offset },
			{ x: b.x - nx * offset, y: b.y - ny * offset },
			{ strokeColor: COLOR.kinematic, strokeWidth: 1.2 }
		);
	}

	function drawVectorLike(
		object: ObjectV2,
		nodeMap: Map<string, NodeV2>,
		color: string,
		prefix: string
	): void {
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
		drawText({ x: start.x - direction.x * 0.12, y: start.y - direction.y * 0.12 }, label, {
			strokeColor: COLOR.text
		});
	}

	function drawMomentLike(
		object: ObjectV2,
		nodeMap: Map<string, NodeV2>,
		color: string,
		defaultLabel: string
	): void {
		const node = getNode(nodeMap, object.nodeRefs?.[0]);
		if (!node) return;
		const direction = object.geometry.direction === 'cw' ? 'cw' : 'ccw';
		const radius = isFiniteNumber(object.geometry.radius)
			? Math.max(0.2, Math.min(1.2, Math.abs(object.geometry.radius)))
			: 0.45;
		board.create('circle', [[node.x, node.y], radius], {
			fixed: true,
			highlight: false,
			strokeColor: color,
			strokeWidth: 1.6,
			dash: 2,
			fillColor: 'transparent'
		});
		const arrowFrom =
			direction === 'cw'
				? { x: node.x + radius, y: node.y + 0.05 }
				: { x: node.x - radius, y: node.y + 0.05 };
		const arrowTo =
			direction === 'cw'
				? { x: node.x + radius - 0.15, y: node.y - 0.16 }
				: { x: node.x - radius + 0.15, y: node.y - 0.16 };
		drawArrow(arrowFrom, arrowTo, { strokeColor: color, strokeWidth: 1.8 });
		const label = labelText(object, defaultLabel);
		drawText({ x: node.x + radius + 0.14, y: node.y + radius + 0.1 }, label, {
			strokeColor: COLOR.text
		});
	}

	function drawDistributed(object: ObjectV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		const [start, end] = pair;
		const direction = normalizeDirection(
			object.geometry,
			isFiniteNumber(object.geometry.directionAngle) ? object.geometry.directionAngle : -90
		);
		const count = isFiniteNumber(object.geometry.arrowCount)
			? Math.max(3, Math.min(16, Math.round(object.geometry.arrowCount)))
			: 7;
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
		const points = object.geometry.points
			.map((entry) => toPoint(entry))
			.filter((entry): entry is SchemaPoint => Boolean(entry));
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
		drawArrow(
			{ x: p1.x + 0.001, y: p1.y },
			{ x: p1.x + 0.15, y: p1.y },
			{ strokeColor: COLOR.muted, strokeWidth: 1 }
		);
		drawArrow(
			{ x: p2.x - 0.001, y: p2.y },
			{ x: p2.x - 0.15, y: p2.y },
			{ strokeColor: COLOR.muted, strokeWidth: 1 }
		);
		drawText({ x: (p1.x + p2.x) / 2, y: p1.y + 0.1 }, labelText(object, ''), { anchorX: 'middle' });
	}

	function drawAxis(object: ObjectV2 | ResultV2, nodeMap: Map<string, NodeV2>): void {
		const pair = getPair(nodeMap, object.nodeRefs);
		if (!pair) return;
		drawArrow(pair[0], pair[1], { strokeColor: COLOR.muted, strokeWidth: 1.2, dash: 2 });
		drawText({ x: pair[1].x, y: pair[1].y }, labelText(object, 'axis'), {
			strokeColor: COLOR.muted
		});
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
			drawSegment(
				{ x, y },
				{ x: x + 0.1, y: y - 0.12 },
				{ strokeColor: COLOR.muted, strokeWidth: 0.8 }
			);
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

	function drawNodeLabels(schema: SchemaDataV2, nodeMap: Map<string, NodeV2>): void {
		for (const node of schema.nodes) {
			if (typeof node.label !== 'string' || !node.label.trim()) continue;
			const projectedNode = getNode(nodeMap, node.id);
			if (!projectedNode) continue;
			drawText(
				{ x: projectedNode.x + 0.08, y: projectedNode.y + 0.08 },
				node.label.trim(),
				{ strokeColor: COLOR.text }
			);
		}
	}

	function drawDebugLayer(schema: SchemaDataV2, nodeMap: Map<string, NodeV2>): void {
		for (const node of schema.nodes) {
			const projectedNode = getNode(nodeMap, node.id) ?? node;
			board.create('point', [projectedNode.x, projectedNode.y], {
				name: node.id,
				withLabel: true,
				size: 2,
				face: 'o',
				strokeColor: COLOR.muted,
				fillColor: COLOR.muted,
				fixed: true,
				highlight: false,
				label: {
					offset: [5, 5],
					strokeColor: COLOR.muted,
					fontSize: 10
				}
			});
		}

		for (const object of schema.objects) {
			const pair = getPair(nodeMap, object.nodeRefs);
			if (!pair) continue;
			if (!isFiniteNumber(object.geometry.length) && !isFiniteNumber(object.geometry.L)) continue;
			const hintedLength = isFiniteNumber(object.geometry.length)
				? object.geometry.length
				: object.geometry.L;
			drawText(
				{ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 + 0.12 },
				`L=${hintedLength}`,
				{ strokeColor: COLOR.muted, fontSize: 10, anchorX: 'middle' }
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
				if (!isRecord(entry) || !isFiniteNumber(entry.s) || !isFiniteNumber(entry.value))
					return null;
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
		const kind = typeof result.geometry.kind === 'string' ? result.geometry.kind : 'epure';
		const compressedFiberSide =
			result.geometry.compressedFiberSide === '+n' || result.geometry.compressedFiberSide === '-n'
				? result.geometry.compressedFiberSide
				: undefined;
		const displayFactor = kind === 'M' && compressedFiberSide === '-n' ? -1 : 1;
		const maxAbs = Math.max(...values.map((entry) => Math.abs(entry.value)), 1);
		const scale = 0.8 / maxAbs;
		const minS = Math.min(...values.map((entry) => entry.s));
		const maxS = Math.max(...values.map((entry) => entry.s));
		const sSpan = Math.max(maxS - minS, 1);
		const usesNormalizedS = minS >= -1e-6 && maxS <= 1 + 1e-6;
		const localSamples = values.map((entry) => ({
			x: (usesNormalizedS ? entry.s : (entry.s - minS) / sSpan) * len,
			value: entry.value,
			displayValue: entry.value * scale * displayFactor
		}));
		const epureLayout = buildEpureLayout(localSamples);
		const basis = {
			origin: start,
			tangent: { x: tx, y: ty },
			normal: { x: nx, y: ny }
		};

		for (const region of epureLayout.regions) {
			board.create(
				'polygon',
				region.polygon.map((point) => {
					const world = transformEpurePoint(point, basis);
					return [world.x, world.y];
				}) as any,
				{
					fixed: true,
					highlight: false,
					vertices: { visible: false, fixed: true, highlight: false, withLabel: false },
					fillColor: COLOR.result,
					fillOpacity: result.geometry.fillHatch === false ? 0.18 : 0.06,
					withLines: false,
					borders: { visible: false }
				}
			);

			if (result.geometry.fillHatch !== false) {
				for (const hatch of region.hatchSegments) {
					const segment = transformEpureSegment(hatch, basis);
					drawSegment(segment.start, segment.end, {
						strokeColor: COLOR.result,
						strokeWidth: 0.9,
						opacity: 0.55
					});
				}
			}

			if (result.geometry.showSigns !== false && region.showSign) {
				drawText(transformEpurePoint(region.centroid, basis), region.sign > 0 ? '+' : '-', {
					strokeColor: COLOR.result,
					fontSize: 26,
					fontWeight: 'bold',
					anchorX: 'middle',
					anchorY: 'middle'
				});
			}
		}

		drawSegment(start, end, {
			strokeColor: COLOR.base,
			strokeWidth: EPURE_BEAM_STROKE_WIDTH,
			opacity: 0.95,
			layer: 3
		});

		const curveWorld = epureLayout.curvePoints.map((point) => transformEpurePoint(point, basis));
		if (curveWorld.length >= 2) {
			board.create('curve', [curveWorld.map((point) => point.x), curveWorld.map((point) => point.y)], {
				fixed: true,
				highlight: false,
				strokeColor: COLOR.result,
				strokeWidth: EPURE_CURVE_STROKE_WIDTH,
				layer: 4
			});
		}
	}

	type DrawFn = (object: ObjectV2, nodeMap: Map<string, NodeV2>) => void;
	const objectRenderers: Record<string, DrawFn> = {
		bar: drawBar,
		cable: drawCable,
		spring: drawSpring,
		damper: drawDamper,
		rigid_disk: drawDisk,
		cam: drawCam,
		fixed_wall: drawFixedWall,
		hinge_fixed: drawHingeFixed,
		hinge_roller: drawHingeRoller,
		internal_hinge: drawInternalHinge,
		slider: drawSlider,
		revolute_pair: drawRevolutePair,
		prismatic_pair: drawPrismaticPair,
		slot_pair: drawSlotPair,
		cam_contact: drawCamContact,
		gear_pair: drawGearPair,
		belt_pair: drawBeltPair,
		force: (o, m) => drawVectorLike(o, m, COLOR.load, 'F'),
		moment: (o, m) => drawMomentLike(o, m, COLOR.load, 'M'),
		distributed: drawDistributed,
		velocity: (o, m) => drawVectorLike(o, m, COLOR.kinematic, 'v'),
		acceleration: (o, m) => drawVectorLike(o, m, COLOR.kinematic, 'a'),
		angular_velocity: (o, m) => drawMomentLike(o, m, COLOR.kinematic, '?'),
		angular_acceleration: (o, m) => drawMomentLike(o, m, COLOR.kinematic, '?'),
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

	function renderResult(
		result: ResultV2,
		nodeMap: Map<string, NodeV2>,
		structureKind: 'beam' | 'planar_frame' | 'spatial_frame' | 'planar_mechanism' | 'spatial_mechanism'
	): void {
		if (result.type === 'epure') {
			if (structureKind === 'beam') {
				drawEpure(result, nodeMap);
			}
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
		const schema = normalizedSchema;
		if (!schema || schema.objects.length === 0 || board) return;
		const structureKind = resolveStructureKind(schema);

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

		applyBoardTheme();
		board.options.point.fixed = true;
		board.options.point.highlight = false;
		board.options.point.withLabel = false;
		board.options.circle.center = {
			...(board.options.circle.center ?? {}),
			fixed: true,
			highlight: false
		};
		board.options.polygon.vertices = {
			...(board.options.polygon.vertices ?? {}),
			fixed: true,
			highlight: false,
			withLabel: false
		};

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
				renderResult(result, nodeMap, structureKind);
			} catch (err) {
				console.warn('[SchemeView] Failed to render result:', result.id, err);
			}
		}
		drawNodeLabels(schema, nodeMap);

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
			{#if isFullscreen}
				<span class="scheme-fullscreen-hint">Shift + ЛКМ для перемещения</span>
			{/if}
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
					Auto corrected: {layoutDiagnostics.autoCorrected ? 'yes' : 'no'} | Corrections: {layoutDiagnostics
						.corrections.length}
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

	.scheme-fullscreen-hint {
		margin-left: auto;
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
		color: var(--text-muted);
		white-space: nowrap;
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
		display: flex;
		flex-direction: column;
		width: 100vw;
		height: 100dvh;
	}

	.scheme-wrapper:fullscreen {
		margin: 0;
		border-radius: 0;
		display: flex;
		flex-direction: column;
		width: 100vw;
		height: 100dvh;
	}

	.scheme-wrapper.fullscreen .scheme-title,
	.scheme-wrapper:fullscreen .scheme-title {
		padding-top: calc(0.5rem + env(safe-area-inset-top));
	}

	.scheme-wrapper.fullscreen .scheme-board,
	.scheme-wrapper:fullscreen .scheme-board {
		flex: 1;
		min-height: 0;
		height: auto;
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
