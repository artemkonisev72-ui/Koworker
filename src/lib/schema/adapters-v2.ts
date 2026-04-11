import type { SchemaData, SchemaPoint } from './schema-data.js';
import type { NodeV2, ObjectV2, SchemaDataV2, SchemaObjectTypeV2 } from './schema-v2.js';
import { SCHEMA_DATA_V2_VERSION } from './schema-v2.js';
import { TYPE_ALIASES_V1_TO_V2 } from './object-catalog-v2.js';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function toPoint(value: unknown): SchemaPoint | null {
	if (!isRecord(value)) return null;
	if (isFiniteNumber(value.x) && isFiniteNumber(value.y)) {
		return { x: value.x, y: value.y };
	}
	return null;
}

function stringifyPoint(point: SchemaPoint): string {
	return `${point.x.toFixed(8)}:${point.y.toFixed(8)}`;
}

function normalizeTypeV1ToV2(value: unknown): SchemaObjectTypeV2 {
	const raw = typeof value === 'string' ? value : 'label';
	const mapped = TYPE_ALIASES_V1_TO_V2[raw] ?? raw;

	switch (mapped) {
		case 'bar':
		case 'cable':
		case 'spring':
		case 'damper':
		case 'rigid_disk':
		case 'fixed_wall':
		case 'hinge_fixed':
		case 'hinge_roller':
		case 'internal_hinge':
		case 'slider':
		case 'force':
		case 'moment':
		case 'distributed':
		case 'velocity':
		case 'acceleration':
		case 'angular_velocity':
		case 'angular_acceleration':
		case 'trajectory':
		case 'epure':
		case 'label':
		case 'dimension':
		case 'axis':
		case 'ground':
			return mapped;
		default:
			return 'label';
	}
}

function ensureNode(
	point: SchemaPoint,
	nodes: NodeV2[],
	nodeByKey: Map<string, string>,
	fallbackPrefix: string
): string {
	const key = stringifyPoint(point);
	const existing = nodeByKey.get(key);
	if (existing) return existing;
	const id = `${fallbackPrefix}_${nodes.length + 1}`;
	nodes.push({ id, x: point.x, y: point.y });
	nodeByKey.set(key, id);
	return id;
}

export function adaptSchemaV1ToV2(schema: SchemaData): SchemaDataV2 {
	const nodes: NodeV2[] = [];
	const objects: ObjectV2[] = [];
	const nodeByKey = new Map<string, string>();

	const registerPoint = (point: SchemaPoint, prefix: string): string =>
		ensureNode(point, nodes, nodeByKey, prefix);

	for (const [index, element] of schema.elements.entries()) {
		const geometry = isRecord(element.geometry) ? { ...element.geometry } : {};
		const type = normalizeTypeV1ToV2(element.type);
		const id = typeof element.id === 'string' && element.id.trim() ? element.id.trim() : `obj_${index + 1}`;
		const nodeRefs: string[] = [];

		const point = toPoint(geometry.point) ?? toPoint(geometry.center);
		const start = toPoint(geometry.start);
		const end = toPoint(geometry.end);
		const from = toPoint(geometry.from);
		const to = toPoint(geometry.to);

		if (type === 'bar' || type === 'cable' || type === 'spring' || type === 'damper' || type === 'distributed' || type === 'axis' || type === 'dimension') {
			const s = start ?? from ?? point ?? { x: index, y: 0 };
			const e = end ?? to ?? { x: s.x + 1, y: s.y };
			nodeRefs.push(registerPoint(s, 'N'), registerPoint(e, 'N'));
		} else if (type === 'slider') {
			const p = point ?? start ?? { x: index, y: 0 };
			const g1 = start ?? { x: p.x - 1, y: p.y };
			const g2 = end ?? { x: p.x + 1, y: p.y };
			nodeRefs.push(registerPoint(p, 'N'), registerPoint(g1, 'N'), registerPoint(g2, 'N'));
		} else if (type === 'trajectory' || type === 'epure' || type === 'ground') {
			if (start && end) {
				nodeRefs.push(registerPoint(start, 'N'), registerPoint(end, 'N'));
			}
		} else {
			const p = point ?? start ?? end ?? { x: index, y: 0 };
			nodeRefs.push(registerPoint(p, 'N'));
		}

		if (type === 'distributed') {
			const intensity = geometry.intensity;
			const intensityStart = geometry.intensityStart;
			const intensityEnd = geometry.intensityEnd;
			geometry.kind = typeof geometry.kind === 'string' ? geometry.kind : 'uniform';
			if (intensity === undefined && isFiniteNumber(intensityStart) && isFiniteNumber(intensityEnd)) {
				geometry.intensity = { start: intensityStart, end: intensityEnd };
			}
		}

		if (type === 'moment') {
			if (geometry.direction !== 'cw' && geometry.direction !== 'ccw') {
				geometry.direction = 'ccw';
			}
		}

		objects.push({
			id,
			type,
			nodeRefs,
			geometry,
			style: isRecord(element.style) ? element.style : undefined,
			meta: isRecord(element.meta) ? element.meta : undefined
		});
	}

	return {
		version: SCHEMA_DATA_V2_VERSION,
		meta: {
			taskDomain: 'mechanics',
			catalogVersion: '2026-04-11'
		},
		coordinateSystem: schema.coordinateSystem ?? {
			xUnit: 'm',
			yUnit: 'm',
			origin: { x: 0, y: 0 },
			axisOrientation: 'right-handed',
			originPolicy: 'auto'
		},
		nodes,
		objects,
		results: [],
		annotations: schema.annotations,
		assumptions: schema.assumptions ?? [],
		ambiguities: []
	};
}
