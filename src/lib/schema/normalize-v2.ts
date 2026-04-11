import type { SchemaData } from './schema-data.js';
import type {
	CoordinateSystemV2,
	NodeV2,
	ObjectV2,
	ResultV2,
	SchemaDataV2,
	SchemaObjectTypeV2
} from './schema-v2.js';
import { SCHEMA_DATA_V2_VERSION, isSchemaDataV2, isSchemaDataV2Loose } from './schema-v2.js';
import {
	SCHEMA_OBJECT_CATALOG_V2,
	SCHEMA_OBJECT_TYPES_V2_SET,
	TYPE_ALIASES_V1_TO_V2
} from './object-catalog-v2.js';
import { adaptSchemaV1ToV2 } from './adapters-v2.js';
import { stabilizeSchemaLayoutV2 } from './layout-v2.js';

export interface SchemaNormalizeResultV2 {
	value: SchemaDataV2;
	warnings: string[];
}

interface Point {
	x: number;
	y: number;
}

interface NodeRefBounds {
	min: number;
	max: number | null;
}

type OriginPolicy = 'auto' | 'left_support' | 'fixed_support' | 'centroid';

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

		const xAlt = toFiniteNumber(value[0]);
		const yAlt = toFiniteNumber(value[1]);
		if (xAlt !== null && yAlt !== null) return { x: xAlt, y: yAlt };
	}
	if (Array.isArray(value) && value.length >= 2) {
		const x = toFiniteNumber(value[0]);
		const y = toFiniteNumber(value[1]);
		if (x !== null && y !== null) return { x, y };
	}
	return null;
}

function pointKey(point: Point): string {
	return `${point.x.toFixed(8)}:${point.y.toFixed(8)}`;
}

function pickPoint(record: Record<string, unknown>, keys: string[]): Point | null {
	for (const key of keys) {
		const point = toPoint(record[key]);
		if (point) return point;
	}
	return null;
}

function uniqueStrings(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function toStringArray(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function toObjectArray(input: unknown): Record<string, unknown>[] {
	if (!Array.isArray(input)) return [];
	return input.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

function parseMaybeJson(input: unknown): unknown {
	if (typeof input !== 'string') return input;
	try {
		return JSON.parse(input);
	} catch {
		return input;
	}
}

function normalizeMomentDirection(value: unknown): 'cw' | 'ccw' | null {
	if (typeof value === 'string') {
		const compact = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
		if (compact === 'cw' || compact === 'clockwise') {
			return 'cw';
		}
		if (compact === 'ccw' || compact === 'counterclockwise' || compact === 'anticlockwise') {
			return 'ccw';
		}
	}
	const num = toFiniteNumber(value);
	if (num !== null) return num < 0 ? 'cw' : 'ccw';
	return null;
}

function normalizeOriginPolicy(value: unknown): OriginPolicy {
	if (typeof value !== 'string') return 'auto';
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
	if (normalized === 'left_support' || normalized === 'fixed_support' || normalized === 'centroid') {
		return normalized;
	}
	return 'auto';
}

function normalizeWallSide(value: unknown): 'left' | 'right' | 'top' | 'bottom' | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase().replace(/\s+/g, '');
	if (normalized === 'left' || normalized === 'l' || normalized === '-t') return 'left';
	if (normalized === 'right' || normalized === 'r' || normalized === '+t') return 'right';
	if (normalized === 'top' || normalized === 'up' || normalized === 'u' || normalized === '+n') return 'top';
	if (normalized === 'bottom' || normalized === 'down' || normalized === 'd' || normalized === '-n') return 'bottom';
	return null;
}

function normalizeAttachSide(value: unknown): '+n' | '-n' | '+t' | '-t' | 'center' | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase().replace(/\s+/g, '');
	if (normalized === '+n' || normalized === 'n+' || normalized === 'top' || normalized === 'up') return '+n';
	if (normalized === '-n' || normalized === 'n-' || normalized === 'bottom' || normalized === 'down') return '-n';
	if (normalized === '+t' || normalized === 't+' || normalized === 'right') return '+t';
	if (normalized === '-t' || normalized === 't-' || normalized === 'left') return '-t';
	if (normalized === 'center' || normalized === 'mid' || normalized === 'middle') return 'center';
	return null;
}

function normalizeStringRefArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function normalizeConstraintGeometry(geometry: Record<string, unknown>): void {
	const rawConstraints = isRecord(geometry.constraints) ? { ...geometry.constraints } : {};
	const collinearWith = uniqueStrings([
		...normalizeStringRefArray(rawConstraints.collinearWith),
		...normalizeStringRefArray(geometry.collinearWith),
		...(typeof rawConstraints.collinearWith === 'string' ? [rawConstraints.collinearWith] : []),
		...(typeof geometry.collinearWith === 'string' ? [geometry.collinearWith] : [])
	]);
	const parallelTo = uniqueStrings([
		...normalizeStringRefArray(rawConstraints.parallelTo),
		...normalizeStringRefArray(geometry.parallelTo),
		...(typeof rawConstraints.parallelTo === 'string' ? [rawConstraints.parallelTo] : []),
		...(typeof geometry.parallelTo === 'string' ? [geometry.parallelTo] : [])
	]);
	const perpendicularTo = uniqueStrings([
		...normalizeStringRefArray(rawConstraints.perpendicularTo),
		...normalizeStringRefArray(geometry.perpendicularTo),
		...(typeof rawConstraints.perpendicularTo === 'string' ? [rawConstraints.perpendicularTo] : []),
		...(typeof geometry.perpendicularTo === 'string' ? [geometry.perpendicularTo] : [])
	]);
	const mirrorCandidate = rawConstraints.mirrorOf ?? geometry.mirrorOf;
	const mirrorOf = typeof mirrorCandidate === 'string' && mirrorCandidate.trim() ? mirrorCandidate.trim() : null;

	const hasAny = collinearWith.length > 0 || parallelTo.length > 0 || perpendicularTo.length > 0 || Boolean(mirrorOf);
	if (!hasAny) return;

	geometry.constraints = {
		...(collinearWith.length > 0 ? { collinearWith } : {}),
		...(parallelTo.length > 0 ? { parallelTo } : {}),
		...(perpendicularTo.length > 0 ? { perpendicularTo } : {}),
		...(mirrorOf ? { mirrorOf } : {})
	};
}

function normalizeAttachGeometry(geometry: Record<string, unknown>): void {
	const rawAttach = isRecord(geometry.attach) ? { ...geometry.attach } : {};
	const memberIdCandidate =
		rawAttach.memberId ??
		rawAttach.member ??
		rawAttach.memberRef ??
		rawAttach.baseObjectId ??
		geometry.memberId ??
		geometry.memberRef ??
		geometry.baseObjectId;
	const memberId =
		typeof memberIdCandidate === 'string' && memberIdCandidate.trim()
			? memberIdCandidate.trim()
			: null;
	if (!memberId) return;

	const sCandidate = rawAttach.s ?? rawAttach.t ?? rawAttach.lambda ?? rawAttach.ratio ?? geometry.s ?? geometry.t;
	const sRaw = toFiniteNumber(sCandidate);
	const s = sRaw === null ? 0.5 : Math.max(0, Math.min(1, sRaw));
	const sideCandidate = rawAttach.side ?? rawAttach.normalSide ?? geometry.side ?? geometry.normalSide;
	const side = normalizeAttachSide(sideCandidate) ?? 'center';
	const offsetCandidate = rawAttach.offset ?? rawAttach.distance ?? geometry.offset;
	const offsetRaw = toFiniteNumber(offsetCandidate);
	const offset = offsetRaw !== null ? offsetRaw : undefined;

	geometry.attach = {
		memberId,
		s,
		side,
		...(offset !== undefined ? { offset } : {})
	};
}

function normalizeType(value: unknown): SchemaObjectTypeV2 {
	const raw = typeof value === 'string' ? value.trim() : 'label';
	const mapped = TYPE_ALIASES_V1_TO_V2[raw] ?? raw;
	if (SCHEMA_OBJECT_TYPES_V2_SET.has(mapped as SchemaObjectTypeV2)) {
		return mapped as SchemaObjectTypeV2;
	}
	return 'label';
}

function normalizeNodeRefs(raw: Record<string, unknown>): string[] {
	const refs: string[] = [];

	if (Array.isArray(raw.nodeRefs)) {
		for (const entry of raw.nodeRefs) {
			if (typeof entry === 'string' && entry.trim()) refs.push(entry.trim());
		}
	}

	const fromKeys = [
		'nodeRef',
		'nodeId',
		'startNodeId',
		'endNodeId',
		'centerNodeId',
		'applicationNodeId'
	];
	for (const key of fromKeys) {
		const entry = raw[key];
		if (typeof entry === 'string' && entry.trim()) refs.push(entry.trim());
	}

	return uniqueStrings(refs);
}

function normalizeNode(raw: Record<string, unknown>, index: number): NodeV2 {
	const idRaw =
		typeof raw.id === 'string'
			? raw.id.trim()
			: typeof raw.id === 'number' && Number.isFinite(raw.id)
				? String(raw.id)
				: '';
	const id = idRaw || `N${index + 1}`;
	const x = toFiniteNumber(raw.x) ?? 0;
	const y = toFiniteNumber(raw.y) ?? 0;
	const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
	const visible = typeof raw.visible === 'boolean' ? raw.visible : undefined;
	const meta = isRecord(raw.meta) ? raw.meta : undefined;
	return { id, x, y, label, visible, meta };
}

function normalizeDirectionGeometry(geometry: Record<string, unknown>): void {
	const dirX = toFiniteNumber(geometry.dx) ?? toFiniteNumber(geometry.x);
	const dirY = toFiniteNumber(geometry.dy) ?? toFiniteNumber(geometry.y);
	if (dirX !== null && dirY !== null) {
		geometry.direction = { x: dirX, y: dirY };
		return;
	}

	const cardinal = typeof geometry.cardinal === 'string' ? geometry.cardinal.trim().toLowerCase() : '';
	if (cardinal === 'up') geometry.direction = { x: 0, y: 1 };
	if (cardinal === 'down') geometry.direction = { x: 0, y: -1 };
	if (cardinal === 'left') geometry.direction = { x: -1, y: 0 };
	if (cardinal === 'right') geometry.direction = { x: 1, y: 0 };
}

function normalizeBaseLine(input: unknown): Record<string, unknown> | null {
	if (isRecord(input)) {
		const start = pickPoint(input, ['start', 'from', 'p1', 'a', 'pointA']);
		const end = pickPoint(input, ['end', 'to', 'p2', 'b', 'pointB']);
		if (start && end) return { start, end };

		const x1 = toFiniteNumber(input.x1);
		const y1 = toFiniteNumber(input.y1);
		const x2 = toFiniteNumber(input.x2);
		const y2 = toFiniteNumber(input.y2);
		if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
			return { start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
		}
		return input;
	}
	if (Array.isArray(input) && input.length >= 2) {
		const start = toPoint(input[0]);
		const end = toPoint(input[1]);
		if (start && end) return { start, end };
	}
	return null;
}

function normalizeObjectGeometry(
	type: SchemaObjectTypeV2,
	geometry: Record<string, unknown>,
	context: string,
	warnings: string[]
): void {
	if (
		type === 'bar' ||
		type === 'cable' ||
		type === 'spring' ||
		type === 'damper' ||
		type === 'axis' ||
		type === 'dimension' ||
		type === 'ground'
	) {
		const start = pickPoint(geometry, ['start', 'from', 'p1', 'a']);
		const end = pickPoint(geometry, ['end', 'to', 'p2', 'b']);
		const lengthRaw =
			toFiniteNumber(geometry.length) ??
			toFiniteNumber(geometry.L) ??
			toFiniteNumber(geometry.span) ??
			toFiniteNumber(geometry.distance);
		if (lengthRaw !== null) {
			geometry.length = Math.abs(lengthRaw);
		} else if (start && end) {
			geometry.length = Math.hypot(end.x - start.x, end.y - start.y);
		}

		const angleRaw =
			toFiniteNumber(geometry.angleDeg) ??
			toFiniteNumber(geometry.angle) ??
			toFiniteNumber(geometry.thetaDeg);
		if (angleRaw !== null) {
			geometry.angleDeg = angleRaw;
		} else if (start && end) {
			geometry.angleDeg = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
		}
	}

	if (type === 'rigid_disk') {
		const radius = toFiniteNumber(geometry.radius) ?? toFiniteNumber(geometry.r);
		if (radius !== null) geometry.radius = Math.abs(radius);
	}

	if (type === 'distributed') {
		const kind = typeof geometry.kind === 'string' ? geometry.kind.trim().toLowerCase() : '';
		geometry.kind = kind === 'linear' || kind === 'trapezoid' ? kind : 'uniform';
		if (geometry.intensity === undefined) {
			const scalar =
				toFiniteNumber(geometry.q) ??
				toFiniteNumber(geometry.w) ??
				toFiniteNumber(geometry.value) ??
				toFiniteNumber(geometry.magnitude);
			if (scalar !== null) geometry.intensity = scalar;
		}
		if (isRecord(geometry.intensity)) {
			const start = toFiniteNumber(geometry.intensity.start);
			const end = toFiniteNumber(geometry.intensity.end);
			if (start !== null && end !== null) {
				geometry.intensity = { start, end };
			}
		}
		if (Array.isArray(geometry.intensity) && geometry.intensity.length >= 2) {
			const start = toFiniteNumber(geometry.intensity[0]);
			const end = toFiniteNumber(geometry.intensity[1]);
			if (start !== null && end !== null) {
				geometry.intensity = { start, end };
			}
		}
		if (geometry.intensity === undefined) {
			const start = toFiniteNumber(geometry.intensityStart) ?? toFiniteNumber(geometry.startIntensity);
			const end = toFiniteNumber(geometry.intensityEnd) ?? toFiniteNumber(geometry.endIntensity);
			if (start !== null && end !== null) {
				geometry.intensity = { start, end };
			}
		}
		if (geometry.intensity === undefined) {
			geometry.intensity = 1;
			warnings.push(`${context} distributed intensity was missing and defaulted to 1`);
		}
		const directionAngle = toFiniteNumber(geometry.directionAngle);
		if (directionAngle === null && geometry.directionAngle === undefined) {
			geometry.directionAngle = -90;
		} else if (directionAngle !== null) {
			geometry.directionAngle = directionAngle;
		}
	}

	if (type === 'force' || type === 'velocity' || type === 'acceleration') {
		normalizeDirectionGeometry(geometry);
		const from = pickPoint(geometry, ['from', 'start']);
		const to = pickPoint(geometry, ['to', 'end']);
		if (!isRecord(geometry.direction) && from && to && (from.x !== to.x || from.y !== to.y)) {
			geometry.direction = { x: to.x - from.x, y: to.y - from.y };
		}
		const directionAngle = toFiniteNumber(geometry.directionAngle);
		if (directionAngle !== null) geometry.directionAngle = directionAngle;
		const magnitude = toFiniteNumber(geometry.magnitude) ?? toFiniteNumber(geometry.value);
		if (magnitude !== null) geometry.magnitude = magnitude;

		const hasDirectionVector =
			isRecord(geometry.direction) &&
			isFiniteNumber(geometry.direction.x) &&
			isFiniteNumber(geometry.direction.y);
		const hasDirectionAngle = isFiniteNumber(geometry.directionAngle);
		const hasCardinal = typeof geometry.cardinal === 'string' && geometry.cardinal.trim().length > 0;
		if (!hasDirectionVector && !hasDirectionAngle && !hasCardinal) {
			geometry.directionAngle = -90;
			warnings.push(`${context} ${type} direction was missing and defaulted to directionAngle=-90`);
		}
	}

	if (type === 'moment' || type === 'angular_velocity' || type === 'angular_acceleration') {
		const direction = normalizeMomentDirection(geometry.direction ?? geometry.rotation ?? geometry.sense);
		if (direction) geometry.direction = direction;
		const magnitude = toFiniteNumber(geometry.magnitude) ?? toFiniteNumber(geometry.value);
		if (magnitude !== null) {
			geometry.magnitude = Math.abs(magnitude);
			if (!geometry.direction) geometry.direction = magnitude < 0 ? 'cw' : 'ccw';
		}
		if (geometry.direction !== 'cw' && geometry.direction !== 'ccw') {
			geometry.direction = 'ccw';
			warnings.push(`${context} ${type}.direction was missing and defaulted to "ccw"`);
		}
	}

	if (type === 'fixed_wall') {
		const wallSide = normalizeWallSide(geometry.wallSide ?? geometry.side ?? geometry.wall);
		if (wallSide) {
			geometry.wallSide = wallSide;
		}
	}

	if (type === 'trajectory') {
		if (Array.isArray(geometry.points)) {
			const points = geometry.points
				.map((entry) => {
					const point = toPoint(entry);
					if (point) return point;
					if (!isRecord(entry)) return null;
					const x = toFiniteNumber(entry.x);
					const y = toFiniteNumber(entry.y);
					if (x === null || y === null) return null;
					return { x, y };
				})
				.filter((entry): entry is Point => Boolean(entry));
			geometry.points = points;
		}
	}

	if (type === 'epure') {
		if (!isRecord(geometry.baseLine) && geometry.baseline !== undefined) {
			geometry.baseLine = geometry.baseline;
		}
		const normalizedBaseLine = normalizeBaseLine(geometry.baseLine);
		if (normalizedBaseLine) {
			geometry.baseLine = normalizedBaseLine;
		}
		if (Array.isArray(geometry.values)) {
			const values = geometry.values
				.map((entry) => {
					if (Array.isArray(entry) && entry.length >= 2) {
						const s = toFiniteNumber(entry[0]);
						const value = toFiniteNumber(entry[1]);
						if (s === null || value === null) return null;
						return { s, value };
					}
					if (!isRecord(entry)) return null;
					const s =
						toFiniteNumber(entry.s) ??
						toFiniteNumber(entry.x) ??
						toFiniteNumber(entry.position) ??
						toFiniteNumber(entry.t);
					const value =
						toFiniteNumber(entry.value) ??
						toFiniteNumber(entry.y) ??
						toFiniteNumber(entry.v) ??
						toFiniteNumber(entry.m);
					if (s === null || value === null) return null;
					return { s, value };
				})
				.filter((entry): entry is { s: number; value: number } => Boolean(entry));
			geometry.values = values;
		}
	}

	normalizeConstraintGeometry(geometry);
	normalizeAttachGeometry(geometry);
}

function fallbackGeometryFromRaw(raw: Record<string, unknown>): Record<string, unknown> {
	const geometry: Record<string, unknown> = {};
	const candidateKeys = [
		'point',
		'center',
		'start',
		'end',
		'from',
		'to',
		'guideStart',
		'guideEnd',
		'attach',
		'memberId',
		'memberRef',
		's',
		't',
		'side',
		'offset',
		'length',
		'L',
		'angleDeg',
		'angle',
		'thetaDeg',
		'constraints',
		'collinearWith',
		'parallelTo',
		'perpendicularTo',
		'mirrorOf',
		'wallSide',
		'radius',
		'r',
		'kind',
		'intensity',
		'intensityStart',
		'intensityEnd',
		'q',
		'w',
		'value',
		'magnitude',
		'direction',
		'directionAngle',
		'cardinal',
		'baseLine',
		'baseline',
		'values',
		'points'
	];
	for (const key of candidateKeys) {
		if (raw[key] !== undefined) {
			geometry[key] = raw[key];
		}
	}
	return geometry;
}

function normalizeObject(
	raw: Record<string, unknown>,
	index: number,
	target: 'objects' | 'results',
	warnings: string[]
): ObjectV2 | ResultV2 {
	const type = normalizeType(raw.type);
	const idRaw =
		typeof raw.id === 'string'
			? raw.id.trim()
			: typeof raw.id === 'number' && Number.isFinite(raw.id)
				? String(raw.id)
				: '';
	const id = idRaw || `${target === 'objects' ? 'obj' : 'res'}_${index + 1}`;
	const nodeRefs = normalizeNodeRefs(raw);
	const geometry = isRecord(raw.geometry) ? { ...raw.geometry } : fallbackGeometryFromRaw(raw);
	const style = isRecord(raw.style) ? raw.style : undefined;
	const meta = isRecord(raw.meta) ? { ...raw.meta } : undefined;
	const label = typeof raw.label === 'string' ? raw.label : undefined;

	if (!isRecord(raw.geometry)) {
		warnings.push(`${target}[${index}] geometry was missing/non-object and synthesized from top-level fields`);
	}

	normalizeObjectGeometry(type, geometry, `${target}[${index}]`, warnings);

	return {
		id,
		type,
		nodeRefs,
		geometry,
		style,
		meta,
		label
	};
}

function normalizeRootShape(input: unknown): Record<string, unknown> {
	const parsed = parseMaybeJson(input);
	if (!isRecord(parsed)) return {};

	const payload = parsed as Record<string, unknown>;
	if (isRecord(payload.schemaData)) return payload.schemaData;
	if (isRecord(payload.schema)) return payload.schema;
	if (isRecord(payload.scheme)) return payload.scheme;
	if (isRecord(payload.diagram)) return payload.diagram;
	if (isSchemaDataV2Loose(payload)) return payload;
	return payload;
}

function toBounds(type: SchemaObjectTypeV2): NodeRefBounds {
	const rule = SCHEMA_OBJECT_CATALOG_V2[type];
	if (!rule?.requiredNodeRefs) return { min: 0, max: null };
	if (typeof rule.requiredNodeRefs === 'number') {
		return { min: rule.requiredNodeRefs, max: rule.requiredNodeRefs };
	}
	return {
		min: rule.requiredNodeRefs.min,
		max: typeof rule.requiredNodeRefs.max === 'number' ? rule.requiredNodeRefs.max : null
	};
}

const PAIR_TYPES = new Set<SchemaObjectTypeV2>([
	'bar',
	'cable',
	'spring',
	'damper',
	'distributed',
	'dimension',
	'axis',
	'ground'
]);

const SINGLE_TYPES = new Set<SchemaObjectTypeV2>([
	'fixed_wall',
	'hinge_fixed',
	'hinge_roller',
	'internal_hinge',
	'force',
	'moment',
	'velocity',
	'acceleration',
	'angular_velocity',
	'angular_acceleration',
	'rigid_disk',
	'label'
]);

function ensureUniqueNodeIds(nodes: NodeV2[], warnings: string[]): NodeV2[] {
	const used = new Set<string>();
	const normalized: NodeV2[] = [];

	for (const [index, node] of nodes.entries()) {
		const base = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : `N${index + 1}`;
		let id = base;
		let suffix = 2;
		while (used.has(id)) {
			id = `${base}_${suffix}`;
			suffix += 1;
		}
		if (id !== node.id) warnings.push(`nodes[${index}] id "${node.id}" renamed to "${id}" to keep uniqueness`);
		used.add(id);
		normalized.push({ ...node, id });
	}

	return normalized;
}

function buildNodeMaps(nodes: NodeV2[]): { nodeIds: Set<string>; nodeByPoint: Map<string, string> } {
	const nodeIds = new Set<string>();
	const nodeByPoint = new Map<string, string>();
	for (const node of nodes) {
		nodeIds.add(node.id);
		nodeByPoint.set(pointKey({ x: node.x, y: node.y }), node.id);
	}
	return { nodeIds, nodeByPoint };
}

function nextNodeId(nodeIds: Set<string>): string {
	let index = nodeIds.size + 1;
	let candidate = `N${index}`;
	while (nodeIds.has(candidate)) {
		index += 1;
		candidate = `N${index}`;
	}
	return candidate;
}

function ensureNodeForPoint(
	point: Point,
	nodes: NodeV2[],
	nodeIds: Set<string>,
	nodeByPoint: Map<string, string>,
	warnings: string[],
	context: string
): string {
	const key = pointKey(point);
	const existing = nodeByPoint.get(key);
	if (existing) return existing;

	const id = nextNodeId(nodeIds);
	nodes.push({ id, x: point.x, y: point.y });
	nodeIds.add(id);
	nodeByPoint.set(key, id);
	warnings.push(`${context} created node "${id}" from geometry point (${point.x}, ${point.y})`);
	return id;
}

function resolveKnownRefs(refs: string[], nodeIds: Set<string>, warnings: string[], context: string): string[] {
	const valid: string[] = [];
	for (const ref of uniqueStrings(refs)) {
		if (!nodeIds.has(ref)) {
			warnings.push(`${context} removed unknown nodeRef "${ref}"`);
			continue;
		}
		valid.push(ref);
	}
	return valid;
}

function baselinePointsFromGeometry(geometry: Record<string, unknown>): { start: Point | null; end: Point | null } {
	const baseLine = normalizeBaseLine(geometry.baseLine ?? geometry.baseline);
	if (!baseLine || !isRecord(baseLine)) return { start: null, end: null };
	const start = pickPoint(baseLine, ['start', 'from', 'p1', 'a', 'pointA']);
	const end = pickPoint(baseLine, ['end', 'to', 'p2', 'b', 'pointB']);
	return { start, end };
}

function candidatePointsForNodeRefs(type: SchemaObjectTypeV2, geometry: Record<string, unknown>): Point[] {
	const point = pickPoint(geometry, ['point', 'center', 'node', 'at', 'origin', 'position', 'applicationPoint']);
	const start = pickPoint(geometry, ['start', 'from', 'p1', 'a', 'startPoint']);
	const end = pickPoint(geometry, ['end', 'to', 'p2', 'b', 'endPoint']);
	const guideStart = pickPoint(geometry, ['guideStart', 'trackStart', 'railStart']);
	const guideEnd = pickPoint(geometry, ['guideEnd', 'trackEnd', 'railEnd']);

	if (type === 'slider') {
		return [point ?? start, guideStart ?? start ?? point, guideEnd ?? end]
			.filter((entry): entry is Point => Boolean(entry));
	}

	if (PAIR_TYPES.has(type)) {
		return [start ?? point, end ?? point].filter((entry): entry is Point => Boolean(entry));
	}

	if (type === 'epure') {
		const base = baselinePointsFromGeometry(geometry);
		return [base.start, base.end].filter((entry): entry is Point => Boolean(entry));
	}

	if (SINGLE_TYPES.has(type)) {
		return [point ?? start ?? end].filter((entry): entry is Point => Boolean(entry));
	}

	if (type === 'trajectory') {
		const pointsRaw = Array.isArray(geometry.points) ? geometry.points : [];
		const first = pointsRaw.length > 0 ? toPoint(pointsRaw[0]) : null;
		return first ? [first] : [];
	}

	return [point ?? start ?? end].filter((entry): entry is Point => Boolean(entry));
}

function pickFallbackNodeId(
	objectIndex: number,
	refs: string[],
	nodes: NodeV2[],
	nodeIds: Set<string>,
	allowReuse = false
): string | null {
	if (nodes.length === 0) return null;

	const startIndex = objectIndex % nodes.length;
	for (let offset = 0; offset < nodes.length; offset += 1) {
		const id = nodes[(startIndex + offset) % nodes.length]?.id;
		if (!id) continue;
		if (allowReuse || !refs.includes(id)) return id;
	}
	return allowReuse ? nodes[0]?.id ?? null : null;
}

function createSyntheticNodeNear(
	baseNodeId: string | null,
	nodes: NodeV2[],
	nodeIds: Set<string>,
	nodeByPoint: Map<string, string>,
	warnings: string[],
	context: string
): string {
	const baseNode = baseNodeId ? nodes.find((node) => node.id === baseNodeId) : null;
	const point = baseNode ? { x: baseNode.x + 1, y: baseNode.y } : { x: nodes.length, y: 0 };
	const id = ensureNodeForPoint(point, nodes, nodeIds, nodeByPoint, warnings, context);
	return id;
}

function fillNodeRefs(
	object: ObjectV2 | ResultV2,
	objectIndex: number,
	section: 'objects' | 'results',
	nodes: NodeV2[],
	nodeIds: Set<string>,
	nodeByPoint: Map<string, string>,
	warnings: string[]
): void {
	const context = `${section}[${objectIndex}]`;
	const bounds = toBounds(object.type);

	let refs = resolveKnownRefs(object.nodeRefs ?? [], nodeIds, warnings, context);
	const candidates = candidatePointsForNodeRefs(object.type, object.geometry);

	for (const point of candidates) {
		const nodeId = ensureNodeForPoint(point, nodes, nodeIds, nodeByPoint, warnings, context);
		if (!refs.includes(nodeId)) refs.push(nodeId);
	}

	const targetMin = bounds.min;
	const targetMax = bounds.max;

	while (refs.length < targetMin) {
		const fallback = pickFallbackNodeId(objectIndex, refs, nodes, nodeIds, false);
		if (fallback && !refs.includes(fallback)) {
			refs.push(fallback);
			continue;
		}
		const synthetic = createSyntheticNodeNear(refs[0] ?? null, nodes, nodeIds, nodeByPoint, warnings, context);
		if (!refs.includes(synthetic)) {
			refs.push(synthetic);
		} else {
			// Guaranteed progress in pathological cases.
			const forced = nextNodeId(nodeIds);
			const px = nodes.length;
			const py = 0;
			nodes.push({ id: forced, x: px, y: py });
			nodeIds.add(forced);
			nodeByPoint.set(pointKey({ x: px, y: py }), forced);
			refs.push(forced);
		}
	}

	if (typeof targetMax === 'number' && refs.length > targetMax) {
		refs = refs.slice(0, targetMax);
		warnings.push(`${context} nodeRefs trimmed to ${targetMax}`);
	}

	if (object.type === 'bar' && refs.length >= 2 && refs[0] === refs[1]) {
		const alternate = pickFallbackNodeId(objectIndex + 1, [refs[0]], nodes, nodeIds, false);
		if (alternate && alternate !== refs[0]) {
			refs[1] = alternate;
		} else {
			refs[1] = createSyntheticNodeNear(refs[0], nodes, nodeIds, nodeByPoint, warnings, context);
		}
	}

	object.nodeRefs = refs;
}

function pointFromNodeRef(nodeRef: string | undefined, nodeById: Map<string, NodeV2>): Point | null {
	if (!nodeRef) return null;
	const node = nodeById.get(nodeRef);
	if (!node) return null;
	return { x: node.x, y: node.y };
}

function ensureEpureCompleteness(
	result: ResultV2,
	resultIndex: number,
	objects: ObjectV2[],
	nodeById: Map<string, NodeV2>,
	warnings: string[]
): ResultV2 | null {
	if (result.type !== 'epure') return result;

	const context = `results[${resultIndex}]`;
	const geometry = result.geometry;
	const meta = isRecord(result.meta) ? { ...result.meta } : {};

	const barCandidateById = (id: unknown): ObjectV2 | null => {
		if (typeof id !== 'string' || !id.trim()) return null;
		const found = objects.find((obj) => obj.id === id.trim() && obj.type === 'bar');
		return found ?? null;
	};

	let baseObject = barCandidateById(meta.baseObjectId);
	if (!baseObject) {
		baseObject = objects.find((obj) => obj.type === 'bar') ?? null;
		if (baseObject) {
			meta.baseObjectId = baseObject.id;
			warnings.push(`${context} epure.meta.baseObjectId was missing and set to "${baseObject.id}"`);
		}
	}

	if (!isRecord(geometry.baseLine)) {
		const fromRefs =
			result.nodeRefs && result.nodeRefs.length >= 2
				? {
						start: pointFromNodeRef(result.nodeRefs[0], nodeById),
						end: pointFromNodeRef(result.nodeRefs[1], nodeById)
					}
				: null;
		if (fromRefs?.start && fromRefs.end) {
			geometry.baseLine = { start: fromRefs.start, end: fromRefs.end };
		} else if (baseObject?.nodeRefs && baseObject.nodeRefs.length >= 2) {
			const start = pointFromNodeRef(baseObject.nodeRefs[0], nodeById);
			const end = pointFromNodeRef(baseObject.nodeRefs[1], nodeById);
			if (start && end) {
				geometry.baseLine = { start, end };
				result.nodeRefs = [baseObject.nodeRefs[0], baseObject.nodeRefs[1]];
			}
		}
	}

	if (!Array.isArray(geometry.values) || geometry.values.length === 0) {
		const points = Array.isArray(geometry.points) ? geometry.points : [];
		if (points.length >= 2) {
			const mapped = points
				.map((entry) => {
					const point = toPoint(entry);
					if (!point) return null;
					return { s: point.x, value: point.y };
				})
				.filter((entry): entry is { s: number; value: number } => Boolean(entry));
			if (mapped.length > 0) {
				geometry.values = mapped;
			}
		}
	}

	result.meta = meta;

	const hasBaseLine = isRecord(geometry.baseLine);
	const hasValues = Array.isArray(geometry.values) && geometry.values.length > 0;
	if (!hasBaseLine || !hasValues) {
		warnings.push(`${context} epure removed because baseLine/values are incomplete`);
		return null;
	}

	return result;
}

export function normalizeSchemaDataV2(input: unknown): SchemaNormalizeResultV2 {
	const warnings: string[] = [];
	const root = normalizeRootShape(input);

	if (Array.isArray(root.elements) && !Array.isArray(root.objects)) {
		const adapted = adaptSchemaV1ToV2(root as unknown as SchemaData);
		warnings.push('Input looked like schema v1 and was adapted to schema v2');
		return { value: adapted, warnings };
	}

	if (isSchemaDataV2(root)) {
		// Continue through normalized pass to sanitize ids/numbers.
	}

	const version = typeof root.version === 'string' ? root.version : SCHEMA_DATA_V2_VERSION;
	const meta = isRecord(root.meta) ? root.meta : {};
	const originPolicy = normalizeOriginPolicy(
		(isRecord(root.coordinateSystem) ? root.coordinateSystem.originPolicy : undefined) ??
		root.originPolicy ??
		(isRecord(root.meta) ? root.meta.originPolicy : undefined)
	);
	const coordinateSystem: CoordinateSystemV2 = isRecord(root.coordinateSystem)
		? {
				xUnit: typeof root.coordinateSystem.xUnit === 'string' ? root.coordinateSystem.xUnit : 'm',
				yUnit: typeof root.coordinateSystem.yUnit === 'string' ? root.coordinateSystem.yUnit : 'm',
				origin:
					isRecord(root.coordinateSystem.origin) &&
					isFiniteNumber(root.coordinateSystem.origin.x) &&
					isFiniteNumber(root.coordinateSystem.origin.y)
						? { x: root.coordinateSystem.origin.x, y: root.coordinateSystem.origin.y }
						: { x: 0, y: 0 },
				axisOrientation:
					root.coordinateSystem.axisOrientation === 'left-handed' ? 'left-handed' : 'right-handed',
				originPolicy
			}
		: {
				xUnit: 'm',
				yUnit: 'm',
				origin: { x: 0, y: 0 },
				axisOrientation: 'right-handed',
				originPolicy
			};

	const nodesRaw = toObjectArray(root.nodes);
	const objectsRaw = toObjectArray(root.objects);
	const resultsRaw = toObjectArray(root.results);

	let nodes = ensureUniqueNodeIds(nodesRaw.map((entry, index) => normalizeNode(entry, index)), warnings);
	const objects = objectsRaw.map((entry, index) => normalizeObject(entry, index, 'objects', warnings));
	const resultsInitial = resultsRaw.map(
		(entry, index) => normalizeObject(entry, index, 'results', warnings) as ResultV2
	);

	const maps = buildNodeMaps(nodes);
	for (const [index, object] of objects.entries()) {
		fillNodeRefs(object, index, 'objects', nodes, maps.nodeIds, maps.nodeByPoint, warnings);
	}
	for (const [index, result] of resultsInitial.entries()) {
		fillNodeRefs(result, index, 'results', nodes, maps.nodeIds, maps.nodeByPoint, warnings);
	}

	nodes = ensureUniqueNodeIds(nodes, warnings);
	const nodeById = new Map(nodes.map((node) => [node.id, node]));

	const results = resultsInitial
		.map((result, index) => ensureEpureCompleteness(result, index, objects, nodeById, warnings))
		.filter((entry): entry is ResultV2 => Boolean(entry));

	const assumptions = toStringArray(root.assumptions);
	const ambiguities = toStringArray(root.ambiguities);
	const annotations = Array.isArray(root.annotations)
		? root.annotations.filter((entry) => typeof entry === 'string' || isRecord(entry))
		: [];

	const value: SchemaDataV2 = {
		version: version === SCHEMA_DATA_V2_VERSION ? version : SCHEMA_DATA_V2_VERSION,
		meta,
		coordinateSystem,
		nodes,
		objects,
		results,
		annotations,
		assumptions,
		ambiguities
	};

	const stabilized = stabilizeSchemaLayoutV2(value);
	if (stabilized.corrected) {
		for (const correction of stabilized.corrections) {
			warnings.push(`layout:${correction}`);
		}
	}

	const mergedMeta = {
		...(isRecord(stabilized.schema.meta) ? stabilized.schema.meta : {}),
		layoutPipeline: 'topology-first',
		originPolicy: stabilized.schema.coordinateSystem?.originPolicy ?? 'auto',
		layoutMetrics: {
			before: stabilized.metricsBefore,
			after: stabilized.metricsAfter
		},
		layoutCorrections: stabilized.corrections,
		layoutAutoCorrected: stabilized.corrected
	};

	return {
		value: {
			...stabilized.schema,
			meta: mergedMeta
		},
		warnings
	};
}
