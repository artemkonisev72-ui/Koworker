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
	constraints: ConstraintBag;
}

interface ConstraintBag {
	collinearWith: string[];
	parallelTo: string[];
	perpendicularTo: string[];
	mirrorOf: string | null;
}

interface AttachSpec {
	memberId: string;
	s: number;
	side: '+n' | '-n' | '+t' | '-t' | 'center';
	offset: number;
}

type OriginPolicy = 'auto' | 'left_support' | 'fixed_support' | 'centroid';

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

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string') continue;
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function normalizeConstraintBag(value: unknown): ConstraintBag {
	const raw = isRecord(value) ? value : {};
	const collinearWith = normalizeStringArray(raw.collinearWith);
	const parallelTo = normalizeStringArray(raw.parallelTo);
	const perpendicularTo = normalizeStringArray(raw.perpendicularTo);
	const mirrorOf =
		typeof raw.mirrorOf === 'string' && raw.mirrorOf.trim() ? raw.mirrorOf.trim() : null;
	return {
		collinearWith,
		parallelTo,
		perpendicularTo,
		mirrorOf
	};
}

function parseAttachSpec(object: ObjectV2): AttachSpec | null {
	const geometry = object.geometry;
	if (!isRecord(geometry) || !isRecord(geometry.attach)) return null;
	const attach = geometry.attach;
	const memberId =
		typeof attach.memberId === 'string' && attach.memberId.trim() ? attach.memberId.trim() : null;
	if (!memberId) return null;
	const sRaw = toFiniteNumber(attach.s);
	const s = sRaw === null ? 0.5 : Math.max(0, Math.min(1, sRaw));
	const sideRaw =
		typeof attach.side === 'string' ? attach.side.trim().toLowerCase() : 'center';
	const side =
		sideRaw === '+n' || sideRaw === '-n' || sideRaw === '+t' || sideRaw === '-t'
			? (sideRaw as '+n' | '-n' | '+t' | '-t')
			: 'center';
	const offsetRaw = toFiniteNumber(attach.offset);
	const offset =
		offsetRaw !== null
			? offsetRaw
			: LOAD_TYPES.has(object.type)
				? 0.35
				: 0;
	return { memberId, s, side, offset };
}

function normalizeOriginPolicy(value: unknown): OriginPolicy {
	if (typeof value !== 'string') return 'auto';
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
	if (normalized === 'left_support' || normalized === 'fixed_support' || normalized === 'centroid') {
		return normalized;
	}
	return 'auto';
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

function getObjectConstraintBag(object: ObjectV2): ConstraintBag {
	const geometry = object.geometry;
	if (!isRecord(geometry)) {
		return { collinearWith: [], parallelTo: [], perpendicularTo: [], mirrorOf: null };
	}
	return normalizeConstraintBag(geometry.constraints);
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
			vectorAB: getObjectEdgeVector(object),
			constraints: getObjectConstraintBag(object)
		});
	}
	return edges;
}

function nodeRefsBelongToMember(
	object: ObjectV2,
	memberNodes: Set<string>,
	memberObjectIds: Set<string>
): boolean {
	if (isRecord(object.geometry.attach)) {
		const memberId = object.geometry.attach.memberId;
		if (typeof memberId === 'string' && memberObjectIds.has(memberId.trim())) {
			return true;
		}
	}
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
	const memberObjectIds = new Set<string>();
	for (const object of schema.objects) {
		if (!MEMBER_TYPES.has(object.type)) continue;
		memberObjectIds.add(object.id);
		for (const ref of object.nodeRefs ?? []) {
			memberNodeRefs.add(ref);
		}
	}

	const supports = schema.objects.filter((object) => SUPPORT_TYPES.has(object.type));
	const loads = schema.objects.filter((object) => LOAD_TYPES.has(object.type));

	const supportHits = supports.filter((object) => nodeRefsBelongToMember(object, memberNodeRefs, memberObjectIds)).length;
	const loadHits = loads.filter((object) => nodeRefsBelongToMember(object, memberNodeRefs, memberObjectIds)).length;

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

function rotateLeft(vector: Point): Point {
	return { x: -vector.y, y: vector.x };
}

function getConstraintVector(
	edge: LayoutEdge,
	resolvedEdgeVectors: Map<string, Point>,
	fromId: string
): Point | null {
	const fromConstraint = (refId: string): Point | null => {
		const vector = resolvedEdgeVectors.get(refId);
		if (!vector) return null;
		return fromId === edge.a ? vector : negate(vector);
	};

	for (const refId of edge.constraints.collinearWith) {
		const vector = fromConstraint(refId);
		if (vector) return vector;
	}
	for (const refId of edge.constraints.parallelTo) {
		const vector = fromConstraint(refId);
		if (vector) return vector;
	}
	for (const refId of edge.constraints.perpendicularTo) {
		const vector = fromConstraint(refId);
		if (vector) return rotateLeft(vector);
	}
	if (edge.constraints.mirrorOf) {
		const vector = fromConstraint(edge.constraints.mirrorOf);
		if (vector) return negate(vector);
	}
	return null;
}

function edgeDirectionForPlacement(
	edge: LayoutEdge,
	fromId: string,
	original: Map<string, Point>,
	paletteIndex: number,
	resolvedEdgeVectors: Map<string, Point>
): Point {
	const constrained = getConstraintVector(edge, resolvedEdgeVectors, fromId);
	if (constrained) {
		return normalizeVector(constrained, ANGLE_PALETTE[paletteIndex % ANGLE_PALETTE.length]);
	}

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
	const edgeById = new Map(edges.map((edge) => [edge.objectId, edge]));
	const resolvedEdgeVectors = new Map<string, Point>();
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
				const direction = edgeDirectionForPlacement(
					edge,
					current,
					original,
					localIndex,
					resolvedEdgeVectors
				);
				const length = Math.max(0.5, edge.length);
				nodePositions.set(next, {
					x: currentPos.x + direction.x * length,
					y: currentPos.y + direction.y * length
				});
				if (current === edge.a) {
					resolvedEdgeVectors.set(edge.objectId, direction);
				} else {
					resolvedEdgeVectors.set(edge.objectId, negate(direction));
				}
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

	// Resolve vectors for edges not traversed from BFS root order.
	for (const [objectId, edge] of edgeById.entries()) {
		if (resolvedEdgeVectors.has(objectId)) continue;
		const a = nodePositions.get(edge.a);
		const b = nodePositions.get(edge.b);
		if (!a || !b) continue;
		const vector = { x: b.x - a.x, y: b.y - a.y };
		const length = Math.hypot(vector.x, vector.y);
		if (length > EPS) {
			resolvedEdgeVectors.set(objectId, { x: vector.x / length, y: vector.y / length });
		}
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

interface MemberSegment {
	objectId: string;
	startRef: string;
	endRef: string;
	start: Point;
	end: Point;
	length: number;
}

function getMemberSegments(schema: SchemaDataV2, nodePositions: Map<string, Point>): MemberSegment[] {
	return schema.objects
		.filter((object) => MEMBER_TYPES.has(object.type) && (object.nodeRefs?.length ?? 0) >= 2)
		.map((object) => {
			const refs = object.nodeRefs as string[];
			const startRef = refs[0];
			const endRef = refs[1];
			const start = nodePositions.get(startRef);
			const end = nodePositions.get(endRef);
			if (!start || !end) return null;
			return {
				objectId: object.id,
				startRef,
				endRef,
				start,
				end,
				length: distance(start, end)
			};
		})
		.filter((segment): segment is MemberSegment => Boolean(segment && segment.length > EPS));
}

function anchorSupportsAndLoadsToMembers(
	schema: SchemaDataV2,
	nodePositions: Map<string, Point>,
	corrections: string[]
): void {
	const memberSegments = getMemberSegments(schema, nodePositions);
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

function applyAttachSpecs(
	schema: SchemaDataV2,
	nodePositions: Map<string, Point>,
	corrections: string[]
): void {
	const segments = getMemberSegments(schema, nodePositions);
	if (segments.length === 0) return;
	const segmentById = new Map(segments.map((segment) => [segment.objectId, segment]));

	for (const object of schema.objects) {
		const attach = parseAttachSpec(object);
		if (!attach) continue;
		const targetNodeRef = object.nodeRefs?.[0];
		if (!targetNodeRef) continue;
		const segment = segmentById.get(attach.memberId);
		if (!segment) continue;

		const tangent = normalizeVector(
			{ x: segment.end.x - segment.start.x, y: segment.end.y - segment.start.y },
			{ x: 1, y: 0 }
		);
		const normal = { x: -tangent.y, y: tangent.x };
		const base = {
			x: segment.start.x + (segment.end.x - segment.start.x) * attach.s,
			y: segment.start.y + (segment.end.y - segment.start.y) * attach.s
		};

		let offsetVector: Point = { x: 0, y: 0 };
		if (attach.side === '+n') offsetVector = { x: normal.x, y: normal.y };
		if (attach.side === '-n') offsetVector = { x: -normal.x, y: -normal.y };
		if (attach.side === '+t') offsetVector = { x: tangent.x, y: tangent.y };
		if (attach.side === '-t') offsetVector = { x: -tangent.x, y: -tangent.y };

		const next = {
			x: base.x + offsetVector.x * attach.offset,
			y: base.y + offsetVector.y * attach.offset
		};
		nodePositions.set(targetNodeRef, next);
		corrections.push(`attach:${object.id}:${targetNodeRef}@${attach.memberId}:${attach.s.toFixed(2)}`);
	}
}

function wallSideToDirection(
	wallSide: string,
	tangent: Point,
	normal: Point
): Point {
	if (wallSide === 'left') return { x: -tangent.x, y: -tangent.y };
	if (wallSide === 'right') return { x: tangent.x, y: tangent.y };
	if (wallSide === 'top') return { x: normal.x, y: normal.y };
	if (wallSide === 'bottom') return { x: -normal.x, y: -normal.y };
	return { x: normal.x, y: normal.y };
}

function applyFixedWallSideSemantics(
	schema: SchemaDataV2,
	nodePositions: Map<string, Point>,
	corrections: string[]
): void {
	const segments = getMemberSegments(schema, nodePositions);
	if (segments.length === 0) return;

	for (const object of schema.objects) {
		if (object.type !== 'fixed_wall') continue;
		const geometry = object.geometry;
		if (!isRecord(geometry)) continue;
		const wallSide = typeof geometry.wallSide === 'string' ? geometry.wallSide.trim().toLowerCase() : '';
		if (!wallSide) continue;
		const anchorRef = object.nodeRefs?.[0];
		if (!anchorRef) continue;

		let bestSegment: MemberSegment | null = null;
		for (const segment of segments) {
			if (segment.startRef === anchorRef || segment.endRef === anchorRef) {
				bestSegment = segment;
				break;
			}
		}
		if (!bestSegment) continue;

		const fromStart = bestSegment.startRef === anchorRef;
		const tangent = normalizeVector(
			fromStart
				? { x: bestSegment.end.x - bestSegment.start.x, y: bestSegment.end.y - bestSegment.start.y }
				: { x: bestSegment.start.x - bestSegment.end.x, y: bestSegment.start.y - bestSegment.end.y },
			{ x: 1, y: 0 }
		);
		const normal = { x: -tangent.y, y: tangent.x };
		const desiredHatchDirection = wallSideToDirection(wallSide, tangent, normal);
		const wallDirection = { x: desiredHatchDirection.y, y: -desiredHatchDirection.x };
		const angleDeg = (Math.atan2(wallDirection.y, wallDirection.x) * 180) / Math.PI;

		geometry.angle = angleDeg;
		corrections.push(`fixed_wall_side:${object.id}:${wallSide}`);
	}
}

function enrichLinearConstraints(schema: SchemaDataV2, nodePositions: Map<string, Point>): void {
	for (const object of schema.objects) {
		if (!LAYOUT_EDGE_TYPES.has(object.type)) continue;
		const refs = object.nodeRefs ?? [];
		if (refs.length < 2) continue;
		const a = nodePositions.get(refs[0]);
		const b = nodePositions.get(refs[1]);
		if (!a || !b) continue;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		if (!Number.isFinite(len) || len < EPS) continue;

		const geometry = object.geometry;
		geometry.length = len;
		geometry.angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

		const constraints = normalizeConstraintBag(geometry.constraints);
		geometry.constraints = {
			...(constraints.collinearWith.length > 0 ? { collinearWith: constraints.collinearWith } : {}),
			...(constraints.parallelTo.length > 0 ? { parallelTo: constraints.parallelTo } : {}),
			...(constraints.perpendicularTo.length > 0 ? { perpendicularTo: constraints.perpendicularTo } : {}),
			...(constraints.mirrorOf ? { mirrorOf: constraints.mirrorOf } : {})
		};
	}
}

function inferSupportNodeIds(schema: SchemaDataV2): string[] {
	const out = new Set<string>();
	for (const object of schema.objects) {
		if (!SUPPORT_TYPES.has(object.type)) continue;
		const nodeRef = object.nodeRefs?.[0];
		if (nodeRef) out.add(nodeRef);
	}
	return Array.from(out);
}

function chooseOriginPoint(
	schema: SchemaDataV2,
	nodePositions: Map<string, Point>
): { point: Point; policy: OriginPolicy } {
	const rawPolicy =
		(isRecord(schema.coordinateSystem) ? schema.coordinateSystem.originPolicy : undefined) ??
		(isRecord(schema.meta) ? schema.meta.originPolicy : undefined);
	const policy = normalizeOriginPolicy(rawPolicy);
	const supportNodeIds = inferSupportNodeIds(schema);
	const pointsFromNodeIds = (ids: string[]): Point[] =>
		ids.map((id) => nodePositions.get(id)).filter((point): point is Point => Boolean(point));

	if (policy === 'fixed_support' || policy === 'auto') {
		for (const object of schema.objects) {
			if (object.type !== 'fixed_wall') continue;
			const nodeRef = object.nodeRefs?.[0];
			const point = nodeRef ? nodePositions.get(nodeRef) : null;
			if (point) return { point, policy: 'fixed_support' };
		}
	}

	if (policy === 'left_support' || policy === 'auto') {
		const supportPoints = pointsFromNodeIds(supportNodeIds);
		if (supportPoints.length > 0) {
			const leftMost = supportPoints.reduce((best, point) => (point.x < best.x ? point : best), supportPoints[0]);
			return { point: leftMost, policy: 'left_support' };
		}
	}

	if (policy === 'centroid' || policy === 'auto') {
		const all = Array.from(nodePositions.values());
		if (all.length > 0) {
			const centroid = {
				x: all.reduce((acc, point) => acc + point.x, 0) / all.length,
				y: all.reduce((acc, point) => acc + point.y, 0) / all.length
			};
			return { point: centroid, policy: 'centroid' };
		}
	}

	return { point: { x: 0, y: 0 }, policy: 'auto' };
}

function applyOriginPolicy(
	schema: SchemaDataV2,
	nodePositions: Map<string, Point>,
	corrections: string[]
): OriginPolicy {
	const { point, policy } = chooseOriginPoint(schema, nodePositions);
	if (Math.abs(point.x) < EPS && Math.abs(point.y) < EPS) return policy;
	for (const [nodeId, current] of nodePositions.entries()) {
		nodePositions.set(nodeId, {
			x: current.x - point.x,
			y: current.y - point.y
		});
	}
	corrections.push(`origin_policy:${policy}`);
	return policy;
}

function fitToView(nodePositions: Map<string, Point>, targetHalfSize: number): boolean {
	if (nodePositions.size === 0) return false;
	const before = Array.from(nodePositions.values());
	const maxAbs = before.reduce((acc, point) => Math.max(acc, Math.abs(point.x), Math.abs(point.y)), 0);
	const currentSpan = Math.max(maxAbs * 2, EPS);
	const minSpan = 6;
	const desiredSpan = Math.max(minSpan, currentSpan);
	const scale = (targetHalfSize * 2) / desiredSpan;

	let moved = false;
	for (const [nodeId, point] of nodePositions.entries()) {
		const next = {
			x: point.x * scale,
			y: point.y * scale
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
	const existingEdges = extractLayoutEdges(schema, nodePositions);
	const layoutMode =
		isRecord(schema.meta) && typeof schema.meta.layoutMode === 'string'
			? schema.meta.layoutMode.trim().toLowerCase()
			: 'topology-first';
	const topologyFirst = layoutMode !== 'raw-coordinates';
	const shouldRebuild = shouldRebuildLayout(metricsBefore) || (topologyFirst && existingEdges.length > 0);

	if (shouldRebuild) {
		nodePositions = buildStableNodePositions(schema);
		corrections.push(topologyFirst ? 'rebuild_layout_topology' : 'rebuild_layout_graph');
	}

	anchorSupportsAndLoadsToMembers(schema, nodePositions, corrections);
	applyAttachSpecs(schema, nodePositions, corrections);
	applyFixedWallSideSemantics(schema, nodePositions, corrections);
	const appliedOriginPolicy = applyOriginPolicy(schema, nodePositions, corrections);
	const fitChanged = fitToView(nodePositions, options.targetHalfSize ?? 6);
	if (fitChanged) {
		corrections.push('fit_to_view');
	}
	enrichLinearConstraints(schema, nodePositions);

	const stabilizedSchema = withNodePositions(
		{
			...schema,
			coordinateSystem: {
				...(schema.coordinateSystem ?? {}),
				origin: { x: 0, y: 0 },
				originPolicy: appliedOriginPolicy
			}
		},
		nodePositions
	);
	const metricsAfter = analyzeSchemaLayoutV2(stabilizedSchema);

	return {
		schema: stabilizedSchema,
		corrected: corrections.length > 0,
		corrections,
		metricsBefore,
		metricsAfter
	};
}
