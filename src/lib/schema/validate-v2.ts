import { SCHEMA_OBJECT_CATALOG_V2, SCHEMA_OBJECT_TYPES_V2_SET } from './object-catalog-v2.js';
import type { NodeV2, ObjectV2, ResultV2, SchemaDataV2, SchemaValidationResultV2 } from './schema-v2.js';
import { SCHEMA_DATA_V2_VERSION } from './schema-v2.js';
import { normalizeSchemaDataV2 } from './normalize-v2.js';

export const MAX_SCHEMA_V2_NODES = 500;
export const MAX_SCHEMA_V2_OBJECTS = 800;
export const MAX_SCHEMA_V2_RESULTS = 300;
export const MAX_SCHEMA_V2_TEXT_ITEMS = 128;
export const MAX_SCHEMA_V2_TEXT_LENGTH = 1_500;
export const MAX_SCHEMA_V2_COORD_ABS = 100_000;
const CONSTRAINT_REQUIRED_TYPES = new Set(['bar', 'cable', 'spring', 'damper']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function pushError(errors: string[], message: string): void {
	if (errors.length < 256) errors.push(message);
}

function validateNode(node: NodeV2, index: number, errors: string[]): void {
	if (!node.id || typeof node.id !== 'string') {
		pushError(errors, `nodes[${index}].id must be a non-empty string`);
	}
	if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) {
		pushError(errors, `nodes[${index}] coordinates must be finite numbers`);
		return;
	}
	if (Math.abs(node.x) > MAX_SCHEMA_V2_COORD_ABS || Math.abs(node.y) > MAX_SCHEMA_V2_COORD_ABS) {
		pushError(errors, `nodes[${index}] is outside coordinate bounds`);
	}
}

function validateNodeRefs(object: ObjectV2 | ResultV2, index: number, nodeIds: Set<string>, errors: string[], section: 'objects' | 'results'): void {
	if (!Array.isArray(object.nodeRefs)) return;
	for (const [refIndex, nodeRef] of object.nodeRefs.entries()) {
		if (!nodeIds.has(nodeRef)) {
			pushError(errors, `${section}[${index}].nodeRefs[${refIndex}] references unknown node "${nodeRef}"`);
		}
	}
}

function validateRequiredNodeRefCount(
	object: ObjectV2 | ResultV2,
	index: number,
	errors: string[],
	section: 'objects' | 'results'
): void {
	const rule = SCHEMA_OBJECT_CATALOG_V2[object.type];
	const count = object.nodeRefs?.length ?? 0;
	if (!rule?.requiredNodeRefs) return;

	if (typeof rule.requiredNodeRefs === 'number') {
		if (count !== rule.requiredNodeRefs) {
			pushError(errors, `${section}[${index}] type "${object.type}" requires ${rule.requiredNodeRefs} nodeRefs`);
		}
		return;
	}

	if (count < rule.requiredNodeRefs.min) {
		pushError(errors, `${section}[${index}] type "${object.type}" requires at least ${rule.requiredNodeRefs.min} nodeRefs`);
		return;
	}
	if (typeof rule.requiredNodeRefs.max === 'number' && count > rule.requiredNodeRefs.max) {
		pushError(errors, `${section}[${index}] type "${object.type}" allows at most ${rule.requiredNodeRefs.max} nodeRefs`);
	}
}

function validateRequiredGeometryKeys(object: ObjectV2 | ResultV2, index: number, errors: string[], section: 'objects' | 'results'): void {
	const rule = SCHEMA_OBJECT_CATALOG_V2[object.type];
	if (!rule?.requiredGeometryKeys || rule.requiredGeometryKeys.length === 0) return;
	for (const key of rule.requiredGeometryKeys) {
		if (object.geometry[key] === undefined) {
			pushError(errors, `${section}[${index}] type "${object.type}" requires geometry.${key}`);
		}
	}
}

function hasDirection(geometry: Record<string, unknown>): boolean {
	if (isRecord(geometry.direction) && isFiniteNumber(geometry.direction.x) && isFiniteNumber(geometry.direction.y)) {
		return true;
	}
	return typeof geometry.directionAngle === 'number' || typeof geometry.cardinal === 'string';
}

function validateObjectSpecific(object: ObjectV2 | ResultV2, index: number, errors: string[], section: 'objects' | 'results'): void {
	const geometry = object.geometry;
	const nodeRefCount = object.nodeRefs?.length ?? 0;

	if (object.type === 'bar' && nodeRefCount === 2 && object.nodeRefs?.[0] === object.nodeRefs?.[1]) {
		pushError(errors, `${section}[${index}] bar must reference two distinct nodes`);
	}

	if (CONSTRAINT_REQUIRED_TYPES.has(object.type)) {
		const length = geometry.length;
		if (!isFiniteNumber(length) || length <= 0) {
			pushError(errors, `${section}[${index}] ${object.type} requires geometry.length > 0`);
		}
		const constraints = isRecord(geometry.constraints) ? geometry.constraints : null;
		const hasConstraint = Boolean(
			(constraints && Array.isArray(constraints.collinearWith) && constraints.collinearWith.length > 0) ||
			(constraints && Array.isArray(constraints.parallelTo) && constraints.parallelTo.length > 0) ||
			(constraints && Array.isArray(constraints.perpendicularTo) && constraints.perpendicularTo.length > 0) ||
			(constraints && typeof constraints.mirrorOf === 'string' && constraints.mirrorOf.trim().length > 0)
		);
		const hasAngle = isFiniteNumber(geometry.angleDeg);
		if (!hasAngle && !hasConstraint) {
			pushError(
				errors,
				`${section}[${index}] ${object.type} requires geometry.angleDeg or constraints (collinearWith/parallelTo/perpendicularTo/mirrorOf)`
			);
		}
	}

	if (object.type === 'rigid_disk') {
		const radius = geometry.radius;
		if (!isFiniteNumber(radius) || radius <= 0) {
			pushError(errors, `${section}[${index}] rigid_disk requires geometry.radius > 0`);
		}
	}

	if (object.type === 'fixed_wall' && geometry.wallSide !== undefined) {
		const wallSide = typeof geometry.wallSide === 'string' ? geometry.wallSide.trim().toLowerCase() : '';
		if (wallSide !== 'left' && wallSide !== 'right' && wallSide !== 'top' && wallSide !== 'bottom') {
			pushError(errors, `${section}[${index}] fixed_wall.wallSide must be left|right|top|bottom`);
		}
	}

	if (object.type === 'moment' || object.type === 'angular_velocity' || object.type === 'angular_acceleration') {
		if (geometry.direction !== 'cw' && geometry.direction !== 'ccw') {
			pushError(errors, `${section}[${index}] ${object.type}.direction must be "cw" or "ccw"`);
		}
		if (
			object.type !== 'moment' &&
			nodeRefCount === 0 &&
			(!isRecord(object.meta) || typeof object.meta.targetObjectId !== 'string' || !object.meta.targetObjectId.trim())
		) {
			pushError(errors, `${section}[${index}] ${object.type} requires nodeRefs[0] or meta.targetObjectId`);
		}
	}

	if (object.type === 'force' || object.type === 'velocity' || object.type === 'acceleration') {
		if (!hasDirection(geometry)) {
			pushError(errors, `${section}[${index}] ${object.type} requires direction (vector/angle/cardinal)`);
		}
	}

	if (isRecord(geometry.attach)) {
		if (typeof geometry.attach.memberId !== 'string' || !geometry.attach.memberId.trim()) {
			pushError(errors, `${section}[${index}] attach requires memberId`);
		}
		if (!isFiniteNumber(geometry.attach.s) || geometry.attach.s < 0 || geometry.attach.s > 1) {
			pushError(errors, `${section}[${index}] attach.s must be in [0,1]`);
		}
		if (
			geometry.attach.side !== undefined &&
			geometry.attach.side !== '+n' &&
			geometry.attach.side !== '-n' &&
			geometry.attach.side !== '+t' &&
			geometry.attach.side !== '-t' &&
			geometry.attach.side !== 'center'
		) {
			pushError(errors, `${section}[${index}] attach.side must be +n|-n|+t|-t|center`);
		}
	}

	if (object.type === 'distributed') {
		const kind = geometry.kind;
		if (kind !== 'uniform' && kind !== 'linear' && kind !== 'trapezoid') {
			pushError(errors, `${section}[${index}] distributed.geometry.kind must be "uniform" | "linear" | "trapezoid"`);
		}
		const intensity = geometry.intensity;
		const hasScalar = isFiniteNumber(intensity);
		const hasRange = isRecord(intensity) && isFiniteNumber(intensity.start) && isFiniteNumber(intensity.end);
		if (!hasScalar && !hasRange) {
			pushError(errors, `${section}[${index}] distributed requires intensity number or {start,end}`);
		}
	}

	if (object.type === 'trajectory') {
		if (!Array.isArray(geometry.points) || geometry.points.length < 2) {
			pushError(errors, `${section}[${index}] trajectory requires geometry.points with at least 2 points`);
		}
	}

	if (object.type === 'epure') {
		if (!isRecord(object.meta) || typeof object.meta.baseObjectId !== 'string' || !object.meta.baseObjectId.trim()) {
			pushError(errors, `${section}[${index}] epure requires meta.baseObjectId`);
		}
		if (!isRecord(geometry.baseLine)) {
			pushError(errors, `${section}[${index}] epure requires geometry.baseLine`);
		}
		if (!Array.isArray(geometry.values) || geometry.values.length === 0) {
			pushError(errors, `${section}[${index}] epure requires non-empty geometry.values`);
		}
	}
}

function walkNumbers(value: unknown, cb: (num: number, path: string) => void, path = '$'): void {
	if (typeof value === 'number') {
		cb(value, path);
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			walkNumbers(entry, cb, `${path}[${index}]`);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		walkNumbers(entry, cb, `${path}.${key}`);
	}
}

function validateTextArray(value: unknown, field: 'assumptions' | 'ambiguities' | 'annotations', errors: string[]): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		pushError(errors, `${field} must be an array`);
		return;
	}
	if (value.length > MAX_SCHEMA_V2_TEXT_ITEMS) {
		pushError(errors, `${field} has too many items`);
	}
	for (const [index, item] of value.entries()) {
		if (typeof item === 'string') {
			if (item.length > MAX_SCHEMA_V2_TEXT_LENGTH) {
				pushError(errors, `${field}[${index}] is too long`);
			}
			continue;
		}
		if (field === 'annotations' && isRecord(item)) {
			const text = item.text;
			if (text !== undefined && typeof text !== 'string') {
				pushError(errors, `annotations[${index}].text must be a string`);
			}
			continue;
		}
		pushError(errors, `${field}[${index}] has unsupported value`);
	}
}

export function validateSchemaDataV2(input: unknown): SchemaValidationResultV2 {
	const normalized = normalizeSchemaDataV2(input);
	const schema = normalized.value;
	const errors: string[] = [];

	if (schema.version !== SCHEMA_DATA_V2_VERSION) {
		pushError(errors, `schema.version must be "${SCHEMA_DATA_V2_VERSION}"`);
	}

	if (!Array.isArray(schema.nodes)) pushError(errors, 'schema.nodes must be an array');
	if (!Array.isArray(schema.objects)) pushError(errors, 'schema.objects must be an array');
	if (!Array.isArray(schema.results)) pushError(errors, 'schema.results must be an array');

	if (schema.nodes.length > MAX_SCHEMA_V2_NODES) pushError(errors, `schema.nodes exceeds ${MAX_SCHEMA_V2_NODES}`);
	if (schema.objects.length > MAX_SCHEMA_V2_OBJECTS) pushError(errors, `schema.objects exceeds ${MAX_SCHEMA_V2_OBJECTS}`);
	if ((schema.results?.length ?? 0) > MAX_SCHEMA_V2_RESULTS) pushError(errors, `schema.results exceeds ${MAX_SCHEMA_V2_RESULTS}`);

	if (schema.objects.length === 0) {
		pushError(errors, 'schema.objects must not be empty');
	}

	const nodeIds = new Set<string>();
	for (const [index, node] of schema.nodes.entries()) {
		validateNode(node, index, errors);
		if (nodeIds.has(node.id)) pushError(errors, `Duplicate node id: ${node.id}`);
		nodeIds.add(node.id);
	}

	const objectIds = new Set<string>();
	const allObjectIds = new Set<string>();
	for (const [index, object] of schema.objects.entries()) {
		if (!object.id || typeof object.id !== 'string') {
			pushError(errors, `objects[${index}].id must be a non-empty string`);
		} else {
			if (objectIds.has(object.id)) pushError(errors, `Duplicate object id: ${object.id}`);
			objectIds.add(object.id);
			allObjectIds.add(object.id);
		}

		if (!SCHEMA_OBJECT_TYPES_V2_SET.has(object.type)) {
			pushError(errors, `objects[${index}].type "${String(object.type)}" is not supported`);
		}
		if (!isRecord(object.geometry)) {
			pushError(errors, `objects[${index}].geometry must be an object`);
			continue;
		}

		validateRequiredNodeRefCount(object, index, errors, 'objects');
		validateRequiredGeometryKeys(object, index, errors, 'objects');
		validateNodeRefs(object, index, nodeIds, errors, 'objects');
		validateObjectSpecific(object, index, errors, 'objects');

		walkNumbers(object, (num, path) => {
			if (!Number.isFinite(num)) pushError(errors, `${path} must be finite`);
		}, `objects[${index}]`);
	}

	const resultIds = new Set<string>();
	for (const [index, result] of (schema.results ?? []).entries()) {
		if (!result.id || typeof result.id !== 'string') {
			pushError(errors, `results[${index}].id must be a non-empty string`);
		} else {
			if (resultIds.has(result.id)) pushError(errors, `Duplicate result id: ${result.id}`);
			if (allObjectIds.has(result.id)) pushError(errors, `results[${index}].id duplicates an object id: ${result.id}`);
			resultIds.add(result.id);
		}

		if (!SCHEMA_OBJECT_TYPES_V2_SET.has(result.type)) {
			pushError(errors, `results[${index}].type "${String(result.type)}" is not supported`);
		}
		if (!isRecord(result.geometry)) {
			pushError(errors, `results[${index}].geometry must be an object`);
			continue;
		}

		validateRequiredNodeRefCount(result, index, errors, 'results');
		validateRequiredGeometryKeys(result, index, errors, 'results');
		validateNodeRefs(result, index, nodeIds, errors, 'results');
		validateObjectSpecific(result, index, errors, 'results');

		walkNumbers(result, (num, path) => {
			if (!Number.isFinite(num)) pushError(errors, `${path} must be finite`);
		}, `results[${index}]`);
	}

	validateTextArray(schema.assumptions, 'assumptions', errors);
	validateTextArray(schema.ambiguities, 'ambiguities', errors);
	validateTextArray(schema.annotations, 'annotations', errors);

	if (errors.length > 0) {
		return { ok: false, errors, warnings: normalized.warnings };
	}
	return { ok: true, errors: [], value: schema as SchemaDataV2, warnings: normalized.warnings };
}
