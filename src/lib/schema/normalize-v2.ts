import type { SchemaData } from './schema-data.js';
import type { CoordinateSystemV2, NodeV2, ObjectV2, ResultV2, SchemaDataV2, SchemaObjectTypeV2 } from './schema-v2.js';
import { SCHEMA_DATA_V2_VERSION, isSchemaDataV2, isSchemaDataV2Loose } from './schema-v2.js';
import { SCHEMA_OBJECT_TYPES_V2_SET, TYPE_ALIASES_V1_TO_V2 } from './object-catalog-v2.js';
import { adaptSchemaV1ToV2 } from './adapters-v2.js';

export interface SchemaNormalizeResultV2 {
	value: SchemaDataV2;
	warnings: string[];
}

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
		if (compact === 'cw' || compact === 'clockwise' || compact === 'почасовой' || compact === 'почасовойстрелке') {
			return 'cw';
		}
		if (compact === 'ccw' || compact === 'counterclockwise' || compact === 'anticlockwise' || compact === 'противчасовой' || compact === 'противчасовойстрелки') {
			return 'ccw';
		}
	}
	const num = toFiniteNumber(value);
	if (num !== null) return num < 0 ? 'cw' : 'ccw';
	return null;
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

	const fromKeys = ['nodeRef', 'nodeId', 'startNodeId', 'endNodeId', 'centerNodeId', 'applicationNodeId'];
	for (const key of fromKeys) {
		const entry = raw[key];
		if (typeof entry === 'string' && entry.trim()) refs.push(entry.trim());
	}

	return Array.from(new Set(refs));
}

function normalizeNode(raw: Record<string, unknown>, index: number): NodeV2 {
	const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `N${index + 1}`;
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

function normalizeObjectGeometry(type: SchemaObjectTypeV2, geometry: Record<string, unknown>): void {
	if (type === 'rigid_disk') {
		const radius = toFiniteNumber(geometry.radius);
		if (radius !== null) geometry.radius = radius;
	}

	if (type === 'distributed') {
		const kind = typeof geometry.kind === 'string' ? geometry.kind.trim().toLowerCase() : '';
		geometry.kind = kind === 'linear' || kind === 'trapezoid' ? kind : 'uniform';
		if (geometry.intensity === undefined) {
			const scalar = toFiniteNumber(geometry.q) ?? toFiniteNumber(geometry.w) ?? toFiniteNumber(geometry.value);
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
		const directionAngle = toFiniteNumber(geometry.directionAngle);
		if (directionAngle === null && geometry.directionAngle === undefined) {
			geometry.directionAngle = -90;
		} else if (directionAngle !== null) {
			geometry.directionAngle = directionAngle;
		}
	}

	if (type === 'force' || type === 'velocity' || type === 'acceleration') {
		normalizeDirectionGeometry(geometry);
		const directionAngle = toFiniteNumber(geometry.directionAngle);
		if (directionAngle !== null) geometry.directionAngle = directionAngle;
		const magnitude = toFiniteNumber(geometry.magnitude);
		if (magnitude !== null) geometry.magnitude = magnitude;
	}

	if (type === 'moment' || type === 'angular_velocity' || type === 'angular_acceleration') {
		const direction = normalizeMomentDirection(geometry.direction ?? geometry.rotation ?? geometry.sense);
		if (direction) geometry.direction = direction;
		const magnitude = toFiniteNumber(geometry.magnitude) ?? toFiniteNumber(geometry.value);
		if (magnitude !== null) {
			geometry.magnitude = Math.abs(magnitude);
			if (!geometry.direction) geometry.direction = magnitude < 0 ? 'cw' : 'ccw';
		}
	}

	if (type === 'trajectory') {
		if (Array.isArray(geometry.points)) {
			const points = geometry.points
				.map((entry) => {
					if (!isRecord(entry)) return null;
					const x = toFiniteNumber(entry.x);
					const y = toFiniteNumber(entry.y);
					if (x === null || y === null) return null;
					return { x, y };
				})
				.filter((entry): entry is { x: number; y: number } => Boolean(entry));
			geometry.points = points;
		}
	}

	if (type === 'epure') {
		if (!isRecord(geometry.baseLine) && isRecord(geometry.baseline)) {
			geometry.baseLine = geometry.baseline;
		}
		if (Array.isArray(geometry.values)) {
			const values = geometry.values
				.map((entry) => {
					if (!isRecord(entry)) return null;
					const s = toFiniteNumber(entry.s);
					const value = toFiniteNumber(entry.value);
					if (s === null || value === null) return null;
					return { s, value };
				})
				.filter((entry): entry is { s: number; value: number } => Boolean(entry));
			geometry.values = values;
		}
	}
}

function normalizeObject(
	raw: Record<string, unknown>,
	index: number,
	target: 'objects' | 'results',
	warnings: string[]
): ObjectV2 | ResultV2 {
	const type = normalizeType(raw.type);
	const idRaw = typeof raw.id === 'string' ? raw.id.trim() : '';
	const id = idRaw || `${target === 'objects' ? 'obj' : 'res'}_${index + 1}`;
	const nodeRefs = normalizeNodeRefs(raw);
	const geometry = isRecord(raw.geometry) ? { ...raw.geometry } : {};
	const style = isRecord(raw.style) ? raw.style : undefined;
	const meta = isRecord(raw.meta) ? raw.meta : undefined;
	const label = typeof raw.label === 'string' ? raw.label : undefined;

	if (!isRecord(raw.geometry)) {
		warnings.push(`${target}[${index}] geometry was missing/non-object and replaced with empty object`);
	}

	normalizeObjectGeometry(type, geometry);

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
					root.coordinateSystem.axisOrientation === 'left-handed' ? 'left-handed' : 'right-handed'
			}
		: {
				xUnit: 'm',
				yUnit: 'm',
				origin: { x: 0, y: 0 },
				axisOrientation: 'right-handed'
			};

	const nodesRaw = toObjectArray(root.nodes);
	const objectsRaw = toObjectArray(root.objects);
	const resultsRaw = toObjectArray(root.results);

	const nodes = nodesRaw.map((entry, index) => normalizeNode(entry, index));
	const objects = objectsRaw.map((entry, index) => normalizeObject(entry, index, 'objects', warnings));
	const results = resultsRaw.map((entry, index) => normalizeObject(entry, index, 'results', warnings) as ResultV2);

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

	return { value, warnings };
}
