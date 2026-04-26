import type { SchemaData } from './schema-data.js';
import type {
	CoordinateSystemV2,
	NodeV2,
	ObjectV2,
	ResultV2,
	SchemaDataV2,
	SchemaObjectTypeV2,
	Vector3V2
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
type StructureKind =
	| 'beam'
	| 'planar_frame'
	| 'spatial_frame'
	| 'planar_mechanism'
	| 'spatial_mechanism';
type ModelSpace = 'planar' | 'spatial';
type EpureAxisOrigin = 'auto' | 'free_end' | 'fixed_end' | 'member_start' | 'member_end';
type FrameComponent = 'N' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz';
type ProjectionPreset = 'auto_isometric' | 'xy' | 'xz' | 'yz';
const CANTILEVER_END_SUPPORT_TYPES = new Set<SchemaObjectTypeV2>(['fixed_wall', 'hinge_fixed', 'hinge_roller']);
const LINEAR_LOCAL_FRAME_TYPES = new Set<SchemaObjectTypeV2>(['bar', 'cable', 'spring', 'damper']);
const DEFAULT_REFERENCE_UP: Vector3V2 = { x: 0, y: 0, z: 1 };
const DEFAULT_SECONDARY_REFERENCE: Vector3V2 = { x: 1, y: 0, z: 0 };
const DEFAULT_PLANE_NORMAL: Vector3V2 = { x: 0, y: 0, z: 1 };

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

function normalizeStructureKind(value: unknown): StructureKind | null {
	if (typeof value !== 'string') return null;
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
	return null;
}

function normalizeModelSpace(value: unknown): ModelSpace | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'planar' || normalized === 'spatial') return normalized;
	return null;
}

function normalizeProjectionPreset(value: unknown): ProjectionPreset | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'auto_isometric' || normalized === 'xy' || normalized === 'xz' || normalized === 'yz') {
		return normalized;
	}
	return null;
}

function toVector3(value: unknown): Vector3V2 | null {
	if (isRecord(value)) {
		const x = toFiniteNumber(value.x);
		const y = toFiniteNumber(value.y);
		const z = toFiniteNumber(value.z);
		if (x !== null && y !== null && z !== null) return { x, y, z };
	}
	if (Array.isArray(value) && value.length >= 3) {
		const x = toFiniteNumber(value[0]);
		const y = toFiniteNumber(value[1]);
		const z = toFiniteNumber(value[2]);
		if (x !== null && y !== null && z !== null) return { x, y, z };
	}
	return null;
}

function isFiniteVector3(value: unknown): value is Vector3V2 {
	return (
		isRecord(value) &&
		isFiniteNumber(value.x) &&
		isFiniteNumber(value.y) &&
		isFiniteNumber(value.z)
	);
}

function vector3Dot(a: Vector3V2, b: Vector3V2): number {
	return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vector3Cross(a: Vector3V2, b: Vector3V2): Vector3V2 {
	return {
		x: a.y * b.z - a.z * b.y,
		y: a.z * b.x - a.x * b.z,
		z: a.x * b.y - a.y * b.x
	};
}

function vector3Scale(v: Vector3V2, scalar: number): Vector3V2 {
	return { x: v.x * scalar, y: v.y * scalar, z: v.z * scalar };
}

function vector3Sub(a: Vector3V2, b: Vector3V2): Vector3V2 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vector3Length(v: Vector3V2): number {
	return Math.hypot(v.x, v.y, v.z);
}

function normalizeVector3(v: Vector3V2, epsilon = 1e-9): Vector3V2 | null {
	const length = vector3Length(v);
	if (length <= epsilon) return null;
	return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function projectOntoPlane(vector: Vector3V2, normal: Vector3V2): Vector3V2 {
	const scale = vector3Dot(vector, normal);
	return vector3Sub(vector, vector3Scale(normal, scale));
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

function normalizeCompressedFiberSide(value: unknown): '+n' | '-n' | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === '+n' || normalized === '-n') return normalized;
	return null;
}

function normalizeEpureAxisOrigin(value: unknown): EpureAxisOrigin | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === 'auto' ||
		normalized === 'free_end' ||
		normalized === 'fixed_end' ||
		normalized === 'member_start' ||
		normalized === 'member_end'
	) {
		return normalized;
	}
	return null;
}

function normalizeFrameComponent(value: unknown): FrameComponent | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'n') return 'N';
	if (normalized === 'vy') return 'Vy';
	if (normalized === 'vz') return 'Vz';
	if (normalized === 't') return 'T';
	if (normalized === 'my') return 'My';
	if (normalized === 'mz') return 'Mz';
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
	const lowered = raw.toLowerCase();
	const mapped = TYPE_ALIASES_V1_TO_V2[raw] ?? TYPE_ALIASES_V1_TO_V2[lowered] ?? lowered;
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
	const z = toFiniteNumber(raw.z) ?? 0;
	const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
	const visible = typeof raw.visible === 'boolean' ? raw.visible : undefined;
	const meta = isRecord(raw.meta) ? raw.meta : undefined;
	return { id, x, y, z, label, visible, meta };
}

function cardinalDirectionToVector(value: string): Point | null {
	const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
	if (!normalized) return null;

	if (
		normalized === 'up' ||
		normalized === 'u' ||
		normalized === 'north' ||
		normalized === '+y'
	) {
		return { x: 0, y: 1 };
	}
	if (
		normalized === 'down' ||
		normalized === 'd' ||
		normalized === 'south' ||
		normalized === '-y'
	) {
		return { x: 0, y: -1 };
	}
	if (
		normalized === 'left' ||
		normalized === 'l' ||
		normalized === 'west' ||
		normalized === '-x'
	) {
		return { x: -1, y: 0 };
	}
	if (
		normalized === 'right' ||
		normalized === 'r' ||
		normalized === 'east' ||
		normalized === '+x'
	) {
		return { x: 1, y: 0 };
	}
	if (normalized === 'upright' || normalized === 'northeast' || normalized === '+x+y') {
		return { x: 1, y: 1 };
	}
	if (normalized === 'upleft' || normalized === 'northwest' || normalized === '-x+y') {
		return { x: -1, y: 1 };
	}
	if (normalized === 'downright' || normalized === 'southeast' || normalized === '+x-y') {
		return { x: 1, y: -1 };
	}
	if (normalized === 'downleft' || normalized === 'southwest' || normalized === '-x-y') {
		return { x: -1, y: -1 };
	}

	return null;
}

function normalizeDirectionAngleAliases(geometry: Record<string, unknown>): void {
	const angleCandidate =
		toFiniteNumber(geometry.directionAngle) ??
		toFiniteNumber(geometry.angleDeg) ??
		toFiniteNumber(geometry.angle) ??
		toFiniteNumber(geometry.thetaDeg) ??
		toFiniteNumber(geometry.theta) ??
		toFiniteNumber(geometry.headingDeg) ??
		toFiniteNumber(geometry.orientationDeg);
	if (angleCandidate !== null) {
		geometry.directionAngle = angleCandidate;
	}
}

function normalizeDirectionGeometry(geometry: Record<string, unknown>): void {
	const rawDirection = geometry.direction;
	if (isRecord(rawDirection)) {
		const x = toFiniteNumber(rawDirection.x) ?? toFiniteNumber(rawDirection.dx);
		const y = toFiniteNumber(rawDirection.y) ?? toFiniteNumber(rawDirection.dy);
		if (x !== null && y !== null) {
			geometry.direction = { x, y };
		}
	}
	if (Array.isArray(rawDirection) && rawDirection.length >= 2) {
		const x = toFiniteNumber(rawDirection[0]);
		const y = toFiniteNumber(rawDirection[1]);
		if (x !== null && y !== null) {
			geometry.direction = { x, y };
		}
	}
	if (typeof rawDirection === 'string') {
		const fromCardinal = cardinalDirectionToVector(rawDirection);
		if (fromCardinal) {
			geometry.direction = fromCardinal;
		} else {
			const angle = toFiniteNumber(rawDirection);
			if (angle !== null) {
				geometry.directionAngle = angle;
			}
		}
	}

	const dirX = toFiniteNumber(geometry.dx) ?? toFiniteNumber(geometry.x);
	const dirY = toFiniteNumber(geometry.dy) ?? toFiniteNumber(geometry.y);
	if (dirX !== null && dirY !== null) {
		geometry.direction = { x: dirX, y: dirY };
	}

	const cardinalCandidates = [
		geometry.cardinal,
		geometry.orientation,
		geometry.bearing,
		geometry.dir,
		geometry.side
	];
	for (const candidate of cardinalCandidates) {
		if (typeof candidate !== 'string') continue;
		const vector = cardinalDirectionToVector(candidate);
		if (vector) {
			geometry.direction = vector;
			break;
		}
	}

	normalizeDirectionAngleAliases(geometry);
}

function normalizeBaseLine(input: unknown): Record<string, unknown> | null {
	if (isRecord(input)) {
		const startNodeId =
			typeof input.startNodeId === 'string' && input.startNodeId.trim()
				? input.startNodeId.trim()
				: null;
		const endNodeId =
			typeof input.endNodeId === 'string' && input.endNodeId.trim()
				? input.endNodeId.trim()
				: null;
		const start = pickPoint(input, ['start', 'from', 'p1', 'a', 'pointA']);
		const end = pickPoint(input, ['end', 'to', 'p2', 'b', 'pointB']);
		if (start || end || startNodeId || endNodeId) {
			return {
				...(startNodeId ? { startNodeId } : {}),
				...(endNodeId ? { endNodeId } : {}),
				...(start ? { start } : {}),
				...(end ? { end } : {})
			};
		}

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

	if (type === 'rigid_disk' || type === 'cam') {
		const radius = toFiniteNumber(geometry.radius) ?? toFiniteNumber(geometry.r);
		if (radius !== null) geometry.radius = Math.abs(radius);
	}

	if (type === 'cam_contact') {
		const followerTypeCandidate =
			typeof geometry.followerType === 'string' ? geometry.followerType.trim().toLowerCase() : '';
		if (
			followerTypeCandidate === 'knife' ||
			followerTypeCandidate === 'roller' ||
			followerTypeCandidate === 'flat'
		) {
			geometry.followerType = followerTypeCandidate;
		}
	}

	if (type === 'gear_pair') {
		const meshTypeCandidate =
			typeof geometry.meshType === 'string' ? geometry.meshType.trim().toLowerCase() : '';
		if (meshTypeCandidate === 'external' || meshTypeCandidate === 'internal') {
			geometry.meshType = meshTypeCandidate;
		}
	}

	if (type === 'belt_pair') {
		const beltKindCandidate =
			typeof geometry.beltKind === 'string' ? geometry.beltKind.trim().toLowerCase() : '';
		if (beltKindCandidate === 'belt' || beltKindCandidate === 'chain') {
			geometry.beltKind = beltKindCandidate;
		}
		if (typeof geometry.crossed === 'string') {
			const compact = geometry.crossed.trim().toLowerCase();
			if (compact === 'true' || compact === 'yes' || compact === '1') geometry.crossed = true;
			if (compact === 'false' || compact === 'no' || compact === '0') geometry.crossed = false;
		}
	}

	if (type === 'distributed') {
		normalizeDirectionGeometry(geometry);
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
		const hasDirectionVector =
			isRecord(geometry.direction) &&
			isFiniteNumber(geometry.direction.x) &&
			isFiniteNumber(geometry.direction.y);
		const hasDirectionAngle = isFiniteNumber(geometry.directionAngle);
		if (!hasDirectionVector && !hasDirectionAngle) {
			geometry.directionAngle = -90;
		} else if (hasDirectionAngle) {
			geometry.directionAngle = toFiniteNumber(geometry.directionAngle);
		}
	}

	if (type === 'force' || type === 'velocity' || type === 'acceleration') {
		normalizeDirectionGeometry(geometry);
		const from = pickPoint(geometry, ['from', 'start']);
		const to = pickPoint(geometry, ['to', 'end']);
		if (!isRecord(geometry.direction) && from && to && (from.x !== to.x || from.y !== to.y)) {
			geometry.direction = { x: to.x - from.x, y: to.y - from.y };
		}
		normalizeDirectionAngleAliases(geometry);
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
		const kind = typeof geometry.kind === 'string' ? geometry.kind.trim().toUpperCase() : '';
		if (kind === 'N' || kind === 'Q' || kind === 'M') {
			geometry.kind = kind;
		} else if (kind === 'CUSTOM') {
			geometry.kind = 'custom';
		}
		const component = normalizeFrameComponent(geometry.component);
		if (component) {
			geometry.component = component;
		} else if (geometry.component !== undefined) {
			delete geometry.component;
			warnings.push(`${context} epure.component was invalid and removed`);
		}
		if (typeof geometry.fillHatch !== 'boolean') {
			geometry.fillHatch = true;
		}
		if (typeof geometry.showSigns !== 'boolean') {
			geometry.showSigns = true;
		}
		const axisOrigin = normalizeEpureAxisOrigin(geometry.axisOrigin);
		if (axisOrigin) {
			geometry.axisOrigin = axisOrigin;
		} else if (geometry.axisOrigin !== undefined) {
			delete geometry.axisOrigin;
			warnings.push(`${context} epure.axisOrigin was invalid and removed`);
		}
		const compressedFiberSide = normalizeCompressedFiberSide(geometry.compressedFiberSide);
		if (compressedFiberSide) {
			geometry.compressedFiberSide = compressedFiberSide;
		} else if (geometry.compressedFiberSide !== undefined) {
			delete geometry.compressedFiberSide;
			warnings.push(`${context} epure.compressedFiberSide was invalid and removed`);
		}
		if (geometry.kind === 'M' && geometry.compressedFiberSide === undefined) {
			warnings.push(`${context} moment epure is missing geometry.compressedFiberSide`);
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
		'guideOffset',
		'guideOffsetHint',
		'eccentricity',
		'eccentricityHint',
		'e',
		'attach',
		'memberId',
		'memberRef',
		's',
		't',
		'fromS',
		'toS',
		'startS',
		'endS',
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
		'component',
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
	'cam_contact',
	'gear_pair',
	'belt_pair',
	'dimension',
	'axis',
	'ground'
]);

const SINGLE_TYPES = new Set<SchemaObjectTypeV2>([
	'fixed_wall',
	'hinge_fixed',
	'hinge_roller',
	'internal_hinge',
	'revolute_pair',
	'force',
	'moment',
	'velocity',
	'acceleration',
	'angular_velocity',
	'angular_acceleration',
	'rigid_disk',
	'cam',
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
	nodes.push({ id, x: point.x, y: point.y, z: 0 });
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

	if (type === 'slider' || type === 'prismatic_pair' || type === 'slot_pair') {
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
			nodes.push({ id: forced, x: px, y: py, z: 0 });
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

function nodeToVector3(node: NodeV2): Vector3V2 {
	return {
		x: node.x,
		y: node.y,
		z: isFiniteNumber(node.z) ? node.z : 0
	};
}

function fallbackOrthogonal(reference: Vector3V2): Vector3V2 {
	return Math.abs(reference.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
}

function derivePlanarLocalFrame(
	ex: Vector3V2,
	planeNormal: Vector3V2 | null
): { x: Vector3V2; y: Vector3V2; z: Vector3V2 } | null {
	const ezSeed = normalizeVector3(planeNormal ?? DEFAULT_PLANE_NORMAL);
	if (!ezSeed) return null;
	let ey = normalizeVector3(vector3Cross(ezSeed, ex));
	if (!ey) {
		ey = normalizeVector3(vector3Cross(DEFAULT_REFERENCE_UP, ex));
	}
	if (!ey) return null;
	const ez = normalizeVector3(vector3Cross(ex, ey));
	if (!ez) return null;
	return { x: ex, y: ey, z: ez };
}

function deriveSpatialLocalFrame(
	ex: Vector3V2,
	referenceUp: Vector3V2 | null,
	secondaryReference: Vector3V2 | null
): { x: Vector3V2; y: Vector3V2; z: Vector3V2 } | null {
	const up = normalizeVector3(referenceUp ?? DEFAULT_REFERENCE_UP) ?? DEFAULT_REFERENCE_UP;
	const secondary =
		normalizeVector3(secondaryReference ?? DEFAULT_SECONDARY_REFERENCE) ?? DEFAULT_SECONDARY_REFERENCE;

	let ez = normalizeVector3(projectOntoPlane(up, ex));
	if (!ez) {
		ez = normalizeVector3(projectOntoPlane(secondary, ex));
	}
	if (!ez) {
		ez = normalizeVector3(projectOntoPlane(fallbackOrthogonal(ex), ex));
	}
	if (!ez) return null;

	let ey = normalizeVector3(vector3Cross(ez, ex));
	if (!ey) {
		ey = normalizeVector3(vector3Cross(fallbackOrthogonal(ez), ex));
	}
	if (!ey) return null;

	ez = normalizeVector3(vector3Cross(ex, ey));
	if (!ez) return null;
	return { x: ex, y: ey, z: ez };
}

function deriveMemberLocalFrame(
	start: NodeV2,
	end: NodeV2,
	structureKind: StructureKind,
	coordinateSystem: CoordinateSystemV2
): { x: Vector3V2; y: Vector3V2; z: Vector3V2 } | null {
	const start3 = nodeToVector3(start);
	const end3 = nodeToVector3(end);
	const ex = normalizeVector3({
		x: end3.x - start3.x,
		y: end3.y - start3.y,
		z: end3.z - start3.z
	});
	if (!ex) return null;

	if (structureKind === 'spatial_frame' || structureKind === 'spatial_mechanism') {
		return deriveSpatialLocalFrame(
			ex,
			isFiniteVector3(coordinateSystem.referenceUp) ? coordinateSystem.referenceUp : null,
			isFiniteVector3(coordinateSystem.secondaryReference) ? coordinateSystem.secondaryReference : null
		);
	}

	return derivePlanarLocalFrame(
		ex,
		isFiniteVector3(coordinateSystem.planeNormal) ? coordinateSystem.planeNormal : DEFAULT_PLANE_NORMAL
	);
}

function deriveMemberLocalFrames(
	objects: ObjectV2[],
	nodeById: Map<string, NodeV2>,
	structureKind: StructureKind,
	coordinateSystem: CoordinateSystemV2,
	warnings: string[]
): void {
	for (const object of objects) {
		if (!LINEAR_LOCAL_FRAME_TYPES.has(object.type)) continue;
		if (!Array.isArray(object.nodeRefs) || object.nodeRefs.length < 2) continue;
		const startNode = nodeById.get(object.nodeRefs[0]);
		const endNode = nodeById.get(object.nodeRefs[1]);
		if (!startNode || !endNode) continue;

		const localFrame = deriveMemberLocalFrame(startNode, endNode, structureKind, coordinateSystem);
		if (!localFrame) {
			warnings.push(`objects["${object.id}"] localFrame could not be derived`);
			continue;
		}

		const meta = isRecord(object.meta) ? { ...object.meta } : {};
		meta.localFrame = {
			x: localFrame.x,
			y: localFrame.y,
			z: localFrame.z,
			fromNodeId: object.nodeRefs[0],
			toNodeId: object.nodeRefs[1]
		};
		object.meta = meta;
	}
}

function pointsAlmostEqual(a: Point | null, b: Point | null, epsilon = 1e-6): boolean {
	if (!a || !b) return false;
	return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function resolveBaseLineNodeIds(
	result: ResultV2,
	baseObject: ObjectV2 | null,
	nodeById: Map<string, NodeV2>
): { startNodeId: string | null; endNodeId: string | null } {
	const baseLine = isRecord(result.geometry.baseLine) ? result.geometry.baseLine : null;
	const explicitStart =
		typeof baseLine?.startNodeId === 'string' && baseLine.startNodeId.trim()
			? baseLine.startNodeId.trim()
			: null;
	const explicitEnd =
		typeof baseLine?.endNodeId === 'string' && baseLine.endNodeId.trim()
			? baseLine.endNodeId.trim()
			: null;
	if (explicitStart && explicitEnd) {
		return { startNodeId: explicitStart, endNodeId: explicitEnd };
	}

	if (!baseObject?.nodeRefs || baseObject.nodeRefs.length < 2 || !baseLine) {
		return {
			startNodeId:
				explicitStart ??
				(typeof result.nodeRefs?.[0] === 'string' && result.nodeRefs[0].trim()
					? result.nodeRefs[0].trim()
					: null),
			endNodeId:
				explicitEnd ??
				(typeof result.nodeRefs?.[1] === 'string' && result.nodeRefs[1].trim()
					? result.nodeRefs[1].trim()
					: null)
		};
	}

	const [barStartId, barEndId] = baseObject.nodeRefs;
	const barStart = pointFromNodeRef(barStartId, nodeById);
	const barEnd = pointFromNodeRef(barEndId, nodeById);
	const baseStart = toPoint(baseLine.start) ?? toPoint(baseLine.from);
	const baseEnd = toPoint(baseLine.end) ?? toPoint(baseLine.to);

	const startNodeId =
		explicitStart ??
		(pointsAlmostEqual(baseStart, barStart) ? barStartId
			: pointsAlmostEqual(baseStart, barEnd) ? barEndId
			: typeof result.nodeRefs?.[0] === 'string' && result.nodeRefs[0].trim()
				? result.nodeRefs[0].trim()
				: null);
	const endNodeId =
		explicitEnd ??
		(pointsAlmostEqual(baseEnd, barStart) ? barStartId
			: pointsAlmostEqual(baseEnd, barEnd) ? barEndId
			: typeof result.nodeRefs?.[1] === 'string' && result.nodeRefs[1].trim()
				? result.nodeRefs[1].trim()
				: null);

	return { startNodeId, endNodeId };
}

function detectSimpleCantileverBar(
	baseObject: ObjectV2 | null,
	objects: ObjectV2[]
): { fixedNodeId: string; freeNodeId: string } | null {
	if (!baseObject || baseObject.type !== 'bar' || !baseObject.nodeRefs || baseObject.nodeRefs.length < 2) {
		return null;
	}
	const bars = objects.filter((object) => object.type === 'bar');
	if (bars.length !== 1) return null;
	const fixedWalls = objects.filter((object) => object.type === 'fixed_wall');
	if (fixedWalls.length !== 1) return null;

	const [barStartId, barEndId] = baseObject.nodeRefs;
	const fixedNodeId = fixedWalls[0]?.nodeRefs?.[0];
	if (fixedNodeId !== barStartId && fixedNodeId !== barEndId) return null;

	const freeNodeId = fixedNodeId === barStartId ? barEndId : barStartId;
	const freeNodeSupportCount = objects.filter(
		(object) => CANTILEVER_END_SUPPORT_TYPES.has(object.type) && object.nodeRefs?.[0] === freeNodeId
	).length;
	if (freeNodeSupportCount > 0) return null;

	return { fixedNodeId, freeNodeId };
}

function swapBaseLineOrientation(baseLine: Record<string, unknown>): void {
	const startNodeId = baseLine.startNodeId;
	baseLine.startNodeId = baseLine.endNodeId;
	baseLine.endNodeId = startNodeId;

	const start = baseLine.start;
	baseLine.start = baseLine.end;
	baseLine.end = start;

	const from = baseLine.from;
	baseLine.from = baseLine.to;
	baseLine.to = from;
}

function reverseEpureAxisValues(values: Array<{ s: number; value: number }>, length: number | null): Array<{ s: number; value: number }> {
	const minS = Math.min(...values.map((entry) => entry.s));
	const maxS = Math.max(...values.map((entry) => entry.s));
	const usesNormalizedAxis = minS >= -1e-6 && maxS <= 1 + 1e-6;
	const axisLength = usesNormalizedAxis ? 1 : length ?? maxS;
	return values
		.map((entry) => ({
			s: axisLength - entry.s,
			value: entry.value
		}))
		.sort((a, b) => a.s - b.s);
}

function mapLegacyFrameKindToComponent(
	kind: unknown,
	structureKind: StructureKind,
	context: string,
	warnings: string[]
): FrameComponent | null {
	if (typeof kind !== 'string') return null;
	const normalized = kind.trim().toUpperCase();
	if (normalized === 'N') return 'N';
	if (normalized === 'Q') {
		if (structureKind === 'planar_frame') return 'Vy';
		warnings.push(`${context} spatial frame epure cannot use legacy kind "Q"; provide geometry.component.`);
		return null;
	}
	if (normalized === 'M') {
		if (structureKind === 'planar_frame') return 'Mz';
		warnings.push(`${context} spatial frame epure cannot use legacy kind "M"; provide geometry.component.`);
		return null;
	}
	return null;
}

function maybeCanonicalizeFrameEpure(
	result: ResultV2,
	resultIndex: number,
	baseObject: ObjectV2 | null,
	nodeById: Map<string, NodeV2>,
	structureKind: StructureKind,
	warnings: string[]
): void {
	if (structureKind !== 'planar_frame' && structureKind !== 'spatial_frame') return;
	const geometry = result.geometry;
	const context = `results[${resultIndex}]`;
	const component =
		normalizeFrameComponent(geometry.component) ??
		mapLegacyFrameKindToComponent(geometry.kind, structureKind, context, warnings);
	if (component) {
		geometry.component = component;
		if (geometry.kind === undefined && component === 'N') {
			geometry.kind = 'N';
		}
	} else {
		warnings.push(`${context} frame epure is missing geometry.component`);
	}

	if (geometry.axisOrigin === 'free_end' || geometry.axisOrigin === 'fixed_end') {
		warnings.push(`${context} frame epure axisOrigin was converted to member-local convention`);
	}

	const values = Array.isArray(geometry.values)
		? geometry.values.filter(
				(entry): entry is { s: number; value: number } =>
					isRecord(entry) && isFiniteNumber(entry.s) && isFiniteNumber(entry.value)
		  )
		: [];
	const baseLine = isRecord(geometry.baseLine) ? geometry.baseLine : null;
	if (!baseLine || values.length === 0) {
		geometry.axisOrigin = 'member_start';
		return;
	}

	const axisOrigin = normalizeEpureAxisOrigin(geometry.axisOrigin);
	const { startNodeId, endNodeId } = resolveBaseLineNodeIds(result, baseObject, nodeById);
	const memberStart = baseObject?.nodeRefs?.[0] ?? result.nodeRefs?.[0] ?? startNodeId;
	const memberEnd = baseObject?.nodeRefs?.[1] ?? result.nodeRefs?.[1] ?? endNodeId;
	const pointsFromEndToStart =
		(startNodeId === memberEnd && endNodeId === memberStart) ||
		(result.nodeRefs?.[0] === memberEnd && result.nodeRefs?.[1] === memberStart);
	const shouldReverse = axisOrigin === 'member_end' || pointsFromEndToStart;

	if (shouldReverse) {
		swapBaseLineOrientation(baseLine);
		const memberLength =
			baseObject && isRecord(baseObject.geometry)
				? toFiniteNumber(baseObject.geometry.length) ?? null
				: null;
		geometry.values = reverseEpureAxisValues(values, memberLength);
		if (Array.isArray(result.nodeRefs) && result.nodeRefs.length >= 2) {
			result.nodeRefs = [result.nodeRefs[1], result.nodeRefs[0]];
		}
		warnings.push(`${context} frame epure axis canonicalized from member_end to member_start`);
	}

	if (memberStart && memberEnd) {
		baseLine.startNodeId = memberStart;
		baseLine.endNodeId = memberEnd;
		result.nodeRefs = [memberStart, memberEnd];
	}
	geometry.axisOrigin = 'member_start';
}

function maybeCanonicalizeCantileverEpure(
	result: ResultV2,
	resultIndex: number,
	baseObject: ObjectV2 | null,
	objects: ObjectV2[],
	nodeById: Map<string, NodeV2>,
	warnings: string[]
): void {
	const cantilever = detectSimpleCantileverBar(baseObject, objects);
	if (!cantilever) return;

	const geometry = result.geometry;
	const baseLine = isRecord(geometry.baseLine) ? geometry.baseLine : null;
	const values = Array.isArray(geometry.values)
		? geometry.values.filter(
				(entry): entry is { s: number; value: number } =>
					isRecord(entry) && isFiniteNumber(entry.s) && isFiniteNumber(entry.value)
		  )
		: [];
	if (!baseLine || values.length === 0) return;

	const axisOrigin = normalizeEpureAxisOrigin(geometry.axisOrigin);
	const { startNodeId, endNodeId } = resolveBaseLineNodeIds(result, baseObject, nodeById);
	const shouldReverse =
		axisOrigin === 'fixed_end' ||
		(startNodeId === cantilever.fixedNodeId && endNodeId === cantilever.freeNodeId);

	if (shouldReverse) {
		swapBaseLineOrientation(baseLine);
		const barLength =
			baseObject && isRecord(baseObject.geometry)
				? toFiniteNumber(baseObject.geometry.length) ?? null
				: null;
		geometry.values = reverseEpureAxisValues(values, barLength);
		if (Array.isArray(result.nodeRefs) && result.nodeRefs.length >= 2) {
			result.nodeRefs = [result.nodeRefs[1], result.nodeRefs[0]];
		}
		warnings.push(
			`results[${resultIndex}] epure axis canonicalized to free_end for simple cantilever`
		);
	}

	geometry.axisOrigin = 'free_end';
}

function ensureEpureCompleteness(
	result: ResultV2,
	resultIndex: number,
	objects: ObjectV2[],
	nodeById: Map<string, NodeV2>,
	structureKind: StructureKind,
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

	maybeCanonicalizeFrameEpure(result, resultIndex, baseObject, nodeById, structureKind, warnings);
	if (structureKind === 'beam') {
		maybeCanonicalizeCantileverEpure(result, resultIndex, baseObject, objects, nodeById, warnings);
	}

	return result;
}

function moveEpureObjectsToResults(
	objects: ObjectV2[],
	warnings: string[]
): { objects: ObjectV2[]; movedResults: ResultV2[] } {
	const keptObjects: ObjectV2[] = [];
	const movedResults: ResultV2[] = [];

	for (const [index, object] of objects.entries()) {
		if (object.type !== 'epure') {
			keptObjects.push(object);
			continue;
		}

		movedResults.push({
			...object,
			type: 'epure'
		});
		warnings.push(`objects[${index}] type "epure" moved to results`);
	}

	return { objects: keptObjects, movedResults };
}

function ensureUniqueResultIds(results: ResultV2[], objects: ObjectV2[], warnings: string[]): ResultV2[] {
	const usedIds = new Set<string>(objects.map((object) => object.id));
	const uniqueResults: ResultV2[] = [];

	for (const [index, result] of results.entries()) {
		const baseId = typeof result.id === 'string' && result.id.trim() ? result.id.trim() : `res_${index + 1}`;
		let nextId = baseId;
		let suffix = 2;
		while (usedIds.has(nextId)) {
			nextId = `${baseId}_${suffix}`;
			suffix += 1;
		}

		if (nextId !== result.id) {
			warnings.push(`results[${index}] id "${result.id}" renamed to "${nextId}" to keep uniqueness`);
		}
		usedIds.add(nextId);
		uniqueResults.push({ ...result, id: nextId });
	}

	return uniqueResults;
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
	const rawMeta = isRecord(root.meta) ? { ...root.meta } : {};
	const rawCoordinateSystem = isRecord(root.coordinateSystem) ? root.coordinateSystem : {};
	const structureKindFromMeta = normalizeStructureKind(rawMeta.structureKind ?? root.structureKind);
	const requestedModelSpace = normalizeModelSpace(rawCoordinateSystem.modelSpace ?? root.modelSpace);
	const structureKind: StructureKind =
		structureKindFromMeta ??
		(requestedModelSpace === 'spatial' ? 'spatial_frame' : requestedModelSpace === 'planar' ? 'planar_frame' : 'beam');
	const modelSpace: ModelSpace =
		requestedModelSpace ??
		(structureKind === 'spatial_frame' || structureKind === 'spatial_mechanism' ? 'spatial' : 'planar');
	const meta = {
		...rawMeta,
		structureKind
	};
	const originPolicy = normalizeOriginPolicy(
		rawCoordinateSystem.originPolicy ??
		root.originPolicy ??
		(isRecord(root.meta) ? root.meta.originPolicy : undefined)
	);
	const referenceUp = normalizeVector3(toVector3(rawCoordinateSystem.referenceUp) ?? DEFAULT_REFERENCE_UP) ?? DEFAULT_REFERENCE_UP;
	const secondaryReference =
		normalizeVector3(toVector3(rawCoordinateSystem.secondaryReference) ?? DEFAULT_SECONDARY_REFERENCE) ??
		DEFAULT_SECONDARY_REFERENCE;
	const planeNormal =
		normalizeVector3(toVector3(rawCoordinateSystem.planeNormal) ?? DEFAULT_PLANE_NORMAL) ?? DEFAULT_PLANE_NORMAL;
	const projectionPreset =
		normalizeProjectionPreset(rawCoordinateSystem.projectionPreset) ??
		(modelSpace === 'spatial' ? 'auto_isometric' : 'xy');
	const coordinateSystem: CoordinateSystemV2 = isRecord(root.coordinateSystem)
		? {
				xUnit: typeof root.coordinateSystem.xUnit === 'string' ? root.coordinateSystem.xUnit : 'm',
				yUnit: typeof root.coordinateSystem.yUnit === 'string' ? root.coordinateSystem.yUnit : 'm',
				zUnit: typeof root.coordinateSystem.zUnit === 'string' ? root.coordinateSystem.zUnit : 'm',
				origin:
					isRecord(root.coordinateSystem.origin) &&
					isFiniteNumber(root.coordinateSystem.origin.x) &&
					isFiniteNumber(root.coordinateSystem.origin.y)
						? { x: root.coordinateSystem.origin.x, y: root.coordinateSystem.origin.y }
						: { x: 0, y: 0 },
				modelSpace,
				axisOrientation:
					root.coordinateSystem.axisOrientation === 'left-handed' ? 'left-handed' : 'right-handed',
				originPolicy,
				referenceUp,
				secondaryReference,
				planeNormal,
				projectionPreset
			}
		: {
				xUnit: 'm',
				yUnit: 'm',
				zUnit: 'm',
				origin: { x: 0, y: 0 },
				modelSpace,
				axisOrientation: 'right-handed',
				originPolicy,
				referenceUp,
				secondaryReference,
				planeNormal,
				projectionPreset
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

	const epureMigrated = moveEpureObjectsToResults(objects, warnings);
	const canonicalObjects = epureMigrated.objects;
	const canonicalResultsInitial = ensureUniqueResultIds(
		[...resultsInitial, ...epureMigrated.movedResults],
		canonicalObjects,
		warnings
	);

	nodes = ensureUniqueNodeIds(nodes, warnings);
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	deriveMemberLocalFrames(canonicalObjects, nodeById, structureKind, coordinateSystem, warnings);

	const results = canonicalResultsInitial
		.map((result, index) =>
			ensureEpureCompleteness(result, index, canonicalObjects, nodeById, structureKind, warnings)
		)
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
		objects: canonicalObjects,
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
