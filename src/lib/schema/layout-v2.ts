import type { NodeV2, ObjectV2, SchemaDataV2 } from './schema-v2.js';

interface Point {
	x: number;
	y: number;
}

interface BBox {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	width: number;
	height: number;
}

interface LayoutEdge {
	objectId: string;
	type: string;
	a: string;
	b: string;
	length: number;
	vectorAB: Point | null;
}

export interface LayoutQualityMetricsV2 {
	nodeCount: number;
	objectCount: number;
	edgeCount: number;
	outsideViewportRate: number;
	aspectDistortion: number;
	minElementSeparation: number;
	supportOnMemberRate: number;
	loadOnMemberRate: number;
	coordCollapseRate: number;
	bbox: BBox;
}

export interface LayoutStabilizeResultV2 {
	schema: SchemaDataV2;
	corrected: boolean;
	corrections: string[];
	metricsBefore: LayoutQualityMetricsV2;
	metricsAfter: LayoutQualityMetricsV2;
}

export interface StabilizeLayoutOptionsV2 {
	targetHalfSize?: number;
}

const EPS = 1e-6;
const MEMBER_TYPES = new Set(['bar', 'cable', 'spring', 'damper']);
const LAYOUT_EDGE_TYPES = new Set([
	'bar',
	'cable',
	'spring',
	'damper',
	'distributed',
	'dimension',
	'axis',
	'ground'
]);
const SUPPORT_TYPES = new Set(['fixed_wall', 'hinge_fixed', 'hinge_roller', 'internal_hinge']);
const LOAD_TYPES = new Set(['force', 'moment', 'distributed', 'velocity', 'acceleration']);
const ANGLE_PALETTE: Point[] = [
	{ x: 1, y: 0 },
	{ x: 0.9, y: 0.45 },
	{ x: 0.9, y: -0.45 },
	{ x: 0, y: 1 },
	{ x: 0, y: -1 },
	{ x: -1, y: 0 }
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function toFiniteNumber(value: unknown): number | null {
	if (isFiniteNumber(value)) return value;
	if (typeof value !== 'string') return null;
	const normalized = value.replace(',', '.');
	const match = normalized.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
	if (!match) return null;
	const parsed = Number.parseFloat(match[0]);
	return Number.isFinite(parsed) ? parsed : null;
}

function toPoint(value: unknown): Point | null {
	if (isRecord(value)) {
		const x = toFiniteNumber(value.x);
		const y = toFiniteNumber(value.y);
		if (x !== null && y !== null) return { x, y };
	}
	if (Array.isArray(value) && value.length >= 2) {
		const x = toFiniteNumber(value[0]);
		const y = toFiniteNumber(value[1]);
		if (x !== null && y !== null) return { x, y };
	}
	return null;
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeVector(vector: Point | null, fallback: Point): Point {
	if (!vector) return fallback;
	const length = Math.hypot(vector.x, vector.y);
	if (length < EPS) return fallback;
	return { x: vector.x / length, y: vector.y / length };
}

function negate(point: Point): Point {
	return { x: -point.x, y: -point.y };
}

function bboxFromPoints(points: Point[]): BBox {
	if (points.length === 0) {
		return {
			minX: -1,
			maxX: 1,
			minY: -1,
			maxY: 1,
			width: 2,
			height: 2
		};
	}

	let minX = points[0].x;
	let maxX = points[0].x;
	let minY = points[0].y;
	let maxY = points[0].y;
	for (const point of points) {
		minX = Math.min(minX, point.x);
		maxX = Math.max(maxX, point.x);
		minY = Math.min(minY, point.y);
		maxY = Math.max(maxY, point.y);
	}
	return {
		minX,
		maxX,
		minY,
		maxY,
		width: maxX - minX,
		height: maxY - minY
	};
}

function getNodeMap(nodes: NodeV2[]): Map<string, Point> {
	return new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
}

function getObjectEdgeVector(object: ObjectV2): Point | null {
	const geometry = object.geometry;
	if (!isRecord(geometry)) return null;
	const start = toPoint(geometry.start) ?? toPoint(geometry.from);
	const end = toPoint(geometry.end) ?? toPoint(geometry.to);
	if (start && end) {
		const vector = { x: end.x - start.x, y: end.y - start.y };
		if (Math.hypot(vector.x, vector.y) > EPS) return vector;
	}

	const angle =
		toFiniteNumber(geometry.angleDeg) ??
		toFiniteNumber(geometry.angle) ??
		toFiniteNumber(geometry.thetaDeg);
	if (angle !== null) {
		const radians = (angle * Math.PI) / 180;
		return { x: Math.cos(radians), y: Math.sin(radians) };
	}
	return null;
}

function getObjectEdgeLengthHint(object: ObjectV2, nodeMap: Map<string, Point>): number {
	const geometry = object.geometry;
	if (isRecord(geometry)) {
		const fromGeometry =
			toFiniteNumber(geometry.length) ??
			toFiniteNumber(geometry.L) ??
			toFiniteNumber(geometry.span) ??
			toFiniteNumber(geometry.distance);
		if (fromGeometry !== null && fromGeometry > EPS) return Math.abs(fromGeometry);
	}

	const refs = object.nodeRefs ?? [];
	if (refs.length >= 2) {
		const a = nodeMap.get(refs[0]);
		const b = nodeMap.get(refs[1]);
		if (a && b) {
			const len = distance(a, b);
			if (len > EPS) return len;
		}
	}
	return 1;
}

function extractLayoutEdges(schema: SchemaDataV2, nodeMap: Map<string, Point>): LayoutEdge[] {
	const edges: LayoutEdge[] = [];
	for (const object of schema.objects) {
		if (!LAYOUT_EDGE_TYPES.has(object.type)) continue;
		const refs = object.nodeRefs ?? [];
		if (refs.length < 2) continue;
		const a = refs[0];
		const b = refs[1];
		if (!a || !b || a === b) continue;
		if (!nodeMap.has(a) || !nodeMap.has(b)) continue;
		edges.push({
			objectId: object.id,
			type: object.type,
			a,
			b,
			length: getObjectEdgeLengthHint(object, nodeMap),
			vectorAB: getObjectEdgeVector(object)
		});
	}
	return edges;
}

function nodeRefsBelongToMember(object: ObjectV2, memberNodes: Set<string>): boolean {
	const refs = object.nodeRefs ?? [];
	if (object.type === 'distributed') {
		if (refs.length < 2) return false;
		return memberNodes.has(refs[0]) && memberNodes.has(refs[1]);
	}
	if (refs.length < 1) return false;
	return memberNodes.has(refs[0]);
}

function minPairDistance(points: Point[]): number {
	if (points.length < 2) return 0;
	let minDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < points.length - 1; i += 1) {
		for (let j = i + 1; j < points.length; j += 1) {
			const d = distance(points[i], points[j]);
			if (d < minDistance) minDistance = d;
		}
	}
	return Number.isFinite(minDistance) ? minDistance : 0;
}

export function analyzeSchemaLayoutV2(schema: SchemaDataV2): LayoutQualityMetricsV2 {
	const nodeMap = getNodeMap(schema.nodes);
	const points = Array.from(nodeMap.values());
	const bbox = bboxFromPoints(points);
	const edges = extractLayoutEdges(schema, nodeMap);
	const edgeLengths = edges
		.map((edge) => {
			const a = nodeMap.get(edge.a);
			const b = nodeMap.get(edge.b);
			return a && b ? distance(a, b) : 0;
		})
		.filter((len) => len > EPS);

	const shortest = edgeLengths.length > 0 ? Math.min(...edgeLengths) : 1;
	const longest = edgeLengths.length > 0 ? Math.max(...edgeLengths) : 1;
	const aspectDistortion = shortest > EPS ? longest / shortest : 1;

	const halfViewport = 10;
	const outsideCount = points.filter((point) => Math.abs(point.x) > halfViewport || Math.abs(point.y) > halfViewport).length;
	const outsideViewportRate = points.length > 0 ? outsideCount / points.length : 0;

	const center =
		points.length > 0
			? {
					x: points.reduce((acc, point) => acc + point.x, 0) / points.length,
					y: points.reduce((acc, point) => acc + point.y, 0) / points.length
				}
			: { x: 0, y: 0 };
	const diag = Math.max(Math.hypot(bbox.width, bbox.height), EPS);
	const collapseRadius = Math.max(diag * 0.02, 0.05);
	const collapsedCount = points.filter((point) => distance(point, center) <= collapseRadius).length;
	const coordCollapseRate = points.length > 0 ? collapsedCount / points.length : 0;

	const memberNodeRefs = new Set<string>();
	for (const object of schema.objects) {
		if (!MEMBER_TYPES.has(object.type)) continue;
		for (const ref of object.nodeRefs ?? []) {
			memberNodeRefs.add(ref);
		}
	}

	const supports = schema.objects.filter((object) => SUPPORT_TYPES.has(object.type));
	const loads = schema.objects.filter((object) => LOAD_TYPES.has(object.type));

	const supportHits = supports.filter((object) => nodeRefsBelongToMember(object, memberNodeRefs)).length;
	const loadHits = loads.filter((object) => nodeRefsBelongToMember(object, memberNodeRefs)).length;

	return {
		nodeCount: schema.nodes.length,
		objectCount: schema.objects.length,
		edgeCount: edges.length,
		outsideViewportRate,
		aspectDistortion,
		minElementSeparation: minPairDistance(points),
		supportOnMemberRate: supports.length > 0 ? supportHits / supports.length : 1,
		loadOnMemberRate: loads.length > 0 ? loadHits / loads.length : 1,
		coordCollapseRate,
		bbox
	};
}

function shouldRebuildLayout(metrics: LayoutQualityMetricsV2): boolean {
	const maxSpan = Math.max(metrics.bbox.width, metrics.bbox.height);
	return (
		metrics.nodeCount >= 2 &&
		(
			maxSpan < 0.75 ||
			metrics.coordCollapseRate >= 0.55 ||
			metrics.minElementSeparation < 0.05 ||
			metrics.outsideViewportRate > 0.35 ||
			metrics.aspectDistortion > 45
		)
	);
}

function connectedComponents(nodeIds: string[], edges: LayoutEdge[]): string[][] {
	const adjacency = new Map<string, string[]>();
	for (const nodeId of nodeIds) adjacency.set(nodeId, []);
	for (const edge of edges) {
		adjacency.get(edge.a)?.push(edge.b);
		adjacency.get(edge.b)?.push(edge.a);
	}

	const visited = new Set<string>();
	const components: string[][] = [];
	for (const nodeId of nodeIds) {
		if (visited.has(nodeId)) continue;
		const stack = [nodeId];
		const component: string[] = [];
		visited.add(nodeId);
		while (stack.length > 0) {
			const current = stack.pop() as string;
			component.push(current);
			for (const next of adjacency.get(current) ?? []) {
				if (visited.has(next)) continue;
				visited.add(next);
				stack.push(next);
			}
		}
		components.push(component);
	}
	return components;
}

function edgeDirectionForPlacement(
	edge: LayoutEdge,
	fromId: string,
	original: Map<string, Point>,
	paletteIndex: number
): Point {
	const preferred = edge.vectorAB
		? (fromId === edge.a ? edge.vectorAB : negate(edge.vectorAB))
		: null;
	if (preferred) return normalizeVector(preferred, ANGLE_PALETTE[paletteIndex % ANGLE_PALETTE.length]);

	const from = original.get(fromId);
	const to = original.get(fromId === edge.a ? edge.b : edge.a);
	if (from && to) {
		return normalizeVector(
			{
				x: to.x - from.x,
				y: to.y - from.y
			},
			ANGLE_PALETTE[paletteIndex % ANGLE_PALETTE.length]
		);
	}
	return ANGLE_PALETTE[paletteIndex % ANGLE_PALETTE.length];
}

function buildStableNodePositions(schema: SchemaDataV2): Map<string, Point> {
	const original = getNodeMap(schema.nodes);
	const edges = extractLayoutEdges(schema, original);
	const nodePositions = new Map<string, Point>();
	if (schema.nodes.length === 0) return nodePositions;

	const edgeByNode = new Map<string, LayoutEdge[]>();
	for (const node of schema.nodes) edgeByNode.set(node.id, []);
	for (const edge of edges) {
		edgeByNode.get(edge.a)?.push(edge);
		edgeByNode.get(edge.b)?.push(edge);
	}

	const componentNodeIds = connectedComponents(
		schema.nodes
			.filter((node) => (edgeByNode.get(node.id)?.length ?? 0) > 0)
			.map((node) => node.id),
		edges
	);

	let offsetX = 0;
	for (const component of componentNodeIds) {
		const ordered = component
			.map((id) => ({ id, point: original.get(id) ?? { x: 0, y: 0 } }))
			.sort((a, b) => (a.point.x - b.point.x) || (a.point.y - b.point.y) || a.id.localeCompare(b.id));
		const rootId = ordered[0]?.id;
		if (!rootId) continue;

		nodePositions.set(rootId, { x: offsetX, y: 0 });
		const queue = [rootId];
		const visited = new Set([rootId]);

		while (queue.length > 0) {
			const current = queue.shift() as string;
			const currentPos = nodePositions.get(current) as Point;
			const relatedEdges = (edgeByNode.get(current) ?? []).slice().sort((a, b) => a.objectId.localeCompare(b.objectId));

			let localIndex = 0;
			for (const edge of relatedEdges) {
				const next = edge.a === current ? edge.b : edge.a;
				if (visited.has(next)) continue;
				const direction = edgeDirectionForPlacement(edge, current, original, localIndex);
				const length = Math.max(0.5, edge.length);
				nodePositions.set(next, {
					x: currentPos.x + direction.x * length,
					y: currentPos.y + direction.y * length
				});
				visited.add(next);
				queue.push(next);
				localIndex += 1;
			}
		}

		const componentPoints = component
			.map((nodeId) => nodePositions.get(nodeId))
			.filter((point): point is Point => Boolean(point));
		const componentBox = bboxFromPoints(componentPoints);
		offsetX += Math.max(componentBox.width, 1) + 2;
	}

	let detachedIndex = 0;
	for (const node of schema.nodes) {
		if (nodePositions.has(node.id)) continue;
		const old = original.get(node.id);
		if (old) {
			nodePositions.set(node.id, { x: old.x, y: old.y });
		} else {
			nodePositions.set(node.id, {
				x: offsetX + detachedIndex * 1.5,
				y: -2 - Math.floor(detachedIndex / 4) * 1.2
			});
		}
		detachedIndex += 1;
	}

	return nodePositions;
}

function projectPointToSegment(point: Point, a: Point, b: Point): { projected: Point; distance: number; t: number } {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const ab2 = abx * abx + aby * aby;
	if (ab2 < EPS) return { projected: { ...a }, distance: distance(point, a), t: 0 };
	const apx = point.x - a.x;
	const apy = point.y - a.y;
	const tRaw = (apx * abx + apy * aby) / ab2;
	const t = Math.max(0, Math.min(1, tRaw));
	const projected = { x: a.x + abx * t, y: a.y + aby * t };
	return { projected, distance: distance(point, projected), t };
}

function anchorSupportsAndLoadsToMembers(
	schema: SchemaDataV2,
	nodePositions: Map<string, Point>,
	corrections: string[]
): void {
	const memberSegments = schema.objects
		.filter((object) => MEMBER_TYPES.has(object.type) && (object.nodeRefs?.length ?? 0) >= 2)
		.map((object) => {
			const refs = object.nodeRefs as string[];
			const a = nodePositions.get(refs[0]);
			const b = nodePositions.get(refs[1]);
			if (!a || !b) return null;
			return {
				objectId: object.id,
				start: a,
				end: b,
				length: distance(a, b)
			};
		})
		.filter(
			(segment): segment is { objectId: string; start: Point; end: Point; length: number } =>
				Boolean(segment && segment.length > EPS)
		);
	if (memberSegments.length === 0) return;

	const avgLength =
		memberSegments.reduce((acc, segment) => acc + segment.length, 0) / Math.max(memberSegments.length, 1);
	const snapThreshold = Math.max(0.25, avgLength * 0.45);

	for (const object of schema.objects) {
		if (!SUPPORT_TYPES.has(object.type) && !LOAD_TYPES.has(object.type)) continue;
		const refs = object.nodeRefs ?? [];
		const targets = object.type === 'distributed' ? refs.slice(0, 2) : refs.slice(0, 1);
		for (const nodeRef of targets) {
			const point = nodePositions.get(nodeRef);
			if (!point) continue;

			let best:
				| { projected: Point; distance: number; objectId: string }
				| null = null;
			for (const segment of memberSegments) {
				const projection = projectPointToSegment(point, segment.start, segment.end);
				if (!best || projection.distance < best.distance) {
					best = {
						projected: projection.projected,
						distance: projection.distance,
						objectId: segment.objectId
					};
				}
			}
			if (!best || best.distance <= 0.01 || best.distance > snapThreshold) continue;
			nodePositions.set(nodeRef, best.projected);
			corrections.push(`anchor:${object.id}:${nodeRef}->${best.objectId}`);
		}
	}
}

function fitToView(nodePositions: Map<string, Point>, targetHalfSize: number): boolean {
	if (nodePositions.size === 0) return false;
	const before = Array.from(nodePositions.values());
	const box = bboxFromPoints(before);
	const width = Math.max(box.width, EPS);
	const height = Math.max(box.height, EPS);

	const currentSpan = Math.max(width, height);
	const minSpan = 6;
	const desiredSpan = Math.max(minSpan, currentSpan);
	const scale = (targetHalfSize * 2) / desiredSpan;

	const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
	let moved = false;
	for (const [nodeId, point] of nodePositions.entries()) {
		const next = {
			x: (point.x - center.x) * scale,
			y: (point.y - center.y) * scale
		};
		if (Math.abs(next.x - point.x) > 1e-5 || Math.abs(next.y - point.y) > 1e-5) {
			moved = true;
		}
		nodePositions.set(nodeId, next);
	}
	return moved;
}

function withNodePositions(schema: SchemaDataV2, nodePositions: Map<string, Point>): SchemaDataV2 {
	const nodes = schema.nodes.map((node) => {
		const point = nodePositions.get(node.id);
		if (!point) return node;
		return { ...node, x: point.x, y: point.y };
	});
	return { ...schema, nodes };
}

export function stabilizeSchemaLayoutV2(
	schema: SchemaDataV2,
	options: StabilizeLayoutOptionsV2 = {}
): LayoutStabilizeResultV2 {
	const corrections: string[] = [];
	const metricsBefore = analyzeSchemaLayoutV2(schema);
	let nodePositions = getNodeMap(schema.nodes);

	if (shouldRebuildLayout(metricsBefore)) {
		nodePositions = buildStableNodePositions(schema);
		corrections.push('rebuild_layout_graph');
	}

	anchorSupportsAndLoadsToMembers(schema, nodePositions, corrections);
	const fitChanged = fitToView(nodePositions, options.targetHalfSize ?? 6);
	if (fitChanged) {
		corrections.push('fit_to_view');
	}

	const stabilizedSchema = withNodePositions(schema, nodePositions);
	const metricsAfter = analyzeSchemaLayoutV2(stabilizedSchema);

	return {
		schema: stabilizedSchema,
		corrected: corrections.length > 0,
		corrections,
		metricsBefore,
		metricsAfter
	};
}
