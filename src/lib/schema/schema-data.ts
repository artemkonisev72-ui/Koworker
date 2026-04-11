export const SCHEMA_DATA_VERSION = '1.0';
export const MAX_SCHEMA_ELEMENTS = 200;
export const MAX_COORD_ABS = 100_000;
export const MAX_TEXT_FIELD_LENGTH = 1_000;
export const MAX_ARRAY_TEXT_ITEMS = 64;

export const SCHEMA_ELEMENT_TYPES = [
	'beam_segment',
	'support_pin',
	'support_roller',
	'support_fixed',
	'point_load',
	'distributed_load',
	'moment',
	'hinge',
	'joint',
	'axis',
	'dimension',
	'label'
] as const;

export type SchemaElementType = (typeof SCHEMA_ELEMENT_TYPES)[number];

export interface SchemaPoint {
	x: number;
	y: number;
}

export interface SchemaElement {
	id: string;
	type: SchemaElementType;
	geometry: Record<string, unknown>;
	style?: Record<string, unknown>;
	meta?: Record<string, unknown>;
}

export interface SchemaCoordinateSystem {
	xUnit?: string;
	yUnit?: string;
	origin?: SchemaPoint;
}

export interface SchemaData {
	version: string;
	coordinateSystem?: SchemaCoordinateSystem;
	elements: SchemaElement[];
	annotations?: Array<string | Record<string, unknown>>;
	assumptions?: string[];
}

export interface SchemaValidationResult {
	ok: boolean;
	errors: string[];
	value?: SchemaData;
}

const SCHEMA_TYPES = new Set<string>(SCHEMA_ELEMENT_TYPES);
const ELEMENT_NON_GEOMETRY_KEYS = new Set(['id', 'type', 'style', 'meta', 'geometry']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function toPoint(value: unknown): SchemaPoint | null {
	if (isValidPoint(value)) {
		return { x: value.x, y: value.y };
	}
	if (Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
		return { x: value[0], y: value[1] };
	}
	if (isRecord(value) && isFiniteNumber(value.X) && isFiniteNumber(value.Y)) {
		return { x: value.X, y: value.Y };
	}
	return null;
}

function isValidPoint(value: unknown): value is SchemaPoint {
	if (!isRecord(value)) return false;
	return isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function pickFirstPoint(source: Record<string, unknown>, keys: string[], includeSelf = false): SchemaPoint | null {
	for (const key of keys) {
		const point = toPoint(source[key]);
		if (point) return point;
	}
	if (includeSelf) {
		return toPoint(source);
	}
	return null;
}

function pushError(errors: string[], message: string): void {
	if (errors.length < 128) errors.push(message);
}

function validateTextArray(
	value: unknown,
	field: 'annotations' | 'assumptions',
	errors: string[]
): void {
	if (!Array.isArray(value)) {
		pushError(errors, `${field} must be an array`);
		return;
	}
	if (value.length > MAX_ARRAY_TEXT_ITEMS) {
		pushError(errors, `${field} has too many items`);
	}
	for (const [index, item] of value.entries()) {
		if (typeof item === 'string') {
			if (item.length > MAX_TEXT_FIELD_LENGTH) {
				pushError(errors, `${field}[${index}] is too long`);
			}
			continue;
		}
		if (field === 'annotations' && isRecord(item)) {
			const text = item.text;
			if (text !== undefined && typeof text !== 'string') {
				pushError(errors, `annotations[${index}].text must be a string`);
			}
			if (typeof text === 'string' && text.length > MAX_TEXT_FIELD_LENGTH) {
				pushError(errors, `annotations[${index}].text is too long`);
			}
			continue;
		}
		pushError(errors, `${field}[${index}] has unsupported value`);
	}
}

function walkNumbers(value: unknown, onNumber: (num: number, path: string) => void, path = '$'): void {
	if (typeof value === 'number') {
		onNumber(value, path);
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			walkNumbers(entry, onNumber, `${path}[${index}]`);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		walkNumbers(entry, onNumber, `${path}.${key}`);
	}
}

function walkPoints(value: unknown, onPoint: (point: SchemaPoint, path: string) => void, path = '$'): void {
	if (isValidPoint(value)) {
		onPoint(value, path);
	}
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			walkPoints(entry, onPoint, `${path}[${index}]`);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		walkPoints(entry, onPoint, `${path}.${key}`);
	}
}

function extractPoint(obj: Record<string, unknown>, key: string): SchemaPoint | null {
	const raw = obj[key];
	return isValidPoint(raw) ? raw : null;
}

function validateDistributedLoad(element: SchemaElement, errors: string[]): void {
	const geometry = element.geometry;
	const start = extractPoint(geometry, 'start');
	const end = extractPoint(geometry, 'end');
	if (!start || !end) {
		pushError(errors, `${element.id}: distributed_load requires geometry.start and geometry.end points`);
	}

	const intensity = geometry.intensity;
	const intensityStart = geometry.intensityStart;
	const intensityEnd = geometry.intensityEnd;
	const hasSimpleIntensity = isFiniteNumber(intensity);
	const hasRangeIntensity =
		isRecord(intensity) && isFiniteNumber(intensity.start) && isFiniteNumber(intensity.end);
	const hasLegacyRange = isFiniteNumber(intensityStart) && isFiniteNumber(intensityEnd);

	if (!hasSimpleIntensity && !hasRangeIntensity && !hasLegacyRange) {
		pushError(errors, `${element.id}: distributed_load requires intensity value(s)`);
	}
}

function validateMoment(element: SchemaElement, errors: string[]): void {
	const geometry = element.geometry;
	const direction = geometry.direction;
	const magnitude = geometry.magnitude;
	const center = extractPoint(geometry, 'center') ?? extractPoint(geometry, 'point');
	if (!center) {
		pushError(errors, `${element.id}: moment requires geometry.center or geometry.point`);
	}
	if (direction !== 'cw' && direction !== 'ccw') {
		pushError(errors, `${element.id}: moment.direction must be "cw" or "ccw"`);
	}
	if (!isFiniteNumber(magnitude)) {
		pushError(errors, `${element.id}: moment.magnitude must be a finite number`);
	}
}

function validateLinearElement(
	element: SchemaElement,
	errors: string[],
	typeLabel: 'beam_segment' | 'axis' | 'dimension'
): void {
	const geometry = element.geometry;
	const start = extractPoint(geometry, 'start');
	const end = extractPoint(geometry, 'end');
	if (!start || !end) {
		pushError(errors, `${element.id}: ${typeLabel} requires geometry.start and geometry.end points`);
	}
}

function validatePointAnchoredElement(
	element: SchemaElement,
	errors: string[],
	typeLabel:
		| 'support_pin'
		| 'support_roller'
		| 'support_fixed'
		| 'point_load'
		| 'hinge'
		| 'joint'
		| 'label'
): void {
	const geometry = element.geometry;
	if (!extractPoint(geometry, 'point')) {
		pushError(errors, `${element.id}: ${typeLabel} requires geometry.point`);
	}
}

export function parseSchemaData(input: unknown): unknown {
	if (typeof input === 'string') {
		try {
			return JSON.parse(input);
		} catch {
			return null;
		}
	}
	return input;
}

function normalizeElementShape(element: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = { ...element };
	let geometry: Record<string, unknown> = {};

	if (isRecord(element.geometry)) {
		geometry = { ...(element.geometry as Record<string, unknown>) };
	} else if (
		Array.isArray(element.geometry) &&
		element.geometry.length === 2 &&
		isValidPoint(element.geometry[0]) &&
		isValidPoint(element.geometry[1])
	) {
		geometry = { start: element.geometry[0], end: element.geometry[1] };
	} else {
		const geometryEntries = Object.entries(element).filter(([key]) => !ELEMENT_NON_GEOMETRY_KEYS.has(key));
		for (const [key, value] of geometryEntries) {
			geometry[key] = value;
			delete normalized[key];
		}
	}

	const elementType = typeof normalized.type === 'string' ? normalized.type : '';
	switch (elementType) {
		case 'support_pin':
		case 'support_roller':
		case 'support_fixed':
		case 'hinge':
		case 'joint':
		case 'label': {
			const point = pickFirstPoint(
				geometry,
				['point', 'at', 'position', 'location', 'center', 'anchor', 'node', 'p'],
				true
			);
			if (point) geometry.point = point;
			break;
		}
		case 'point_load': {
			const point = pickFirstPoint(
				geometry,
				['point', 'applicationPoint', 'at', 'position', 'location', 'center', 'to', 'end', 'start', 'from'],
				true
			);
			const from = pickFirstPoint(geometry, ['from', 'start']);
			const to = pickFirstPoint(geometry, ['to', 'end']);
			if (point) geometry.point = point;
			if (from) geometry.from = from;
			if (to) geometry.to = to;
			if (!isValidPoint(geometry.to) && point) geometry.to = point;
			break;
		}
		case 'moment': {
			const center = pickFirstPoint(
				geometry,
				['center', 'point', 'at', 'position', 'location', 'anchor'],
				true
			);
			if (center) {
				geometry.center = center;
				if (!isValidPoint(geometry.point)) {
					geometry.point = center;
				}
			}
			break;
		}
		case 'beam_segment':
		case 'distributed_load':
		case 'axis':
		case 'dimension': {
			const start = pickFirstPoint(
				geometry,
				['start', 'from', 'p1', 'pointA', 'a', 'left', 'begin']
			);
			const end = pickFirstPoint(
				geometry,
				['end', 'to', 'p2', 'pointB', 'b', 'right', 'finish']
			);
			if (start) geometry.start = start;
			if (end) geometry.end = end;
			break;
		}
		default:
			break;
	}

	normalized.geometry = geometry;
	return normalized;
}

function normalizeSchemaDataShape(parsed: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = { ...parsed };

	if (typeof normalized.version !== 'string') {
		normalized.version = SCHEMA_DATA_VERSION;
	}

	if (Array.isArray(normalized.elements)) {
		const usedIds = new Set<string>();
		normalized.elements = normalized.elements.map((entry, index) => {
			if (!isRecord(entry)) return entry;

			const normalizedElement = normalizeElementShape(entry);
			const rawId =
				typeof normalizedElement.id === 'string' ? normalizedElement.id.trim() : '';

			let safeId = rawId;
			if (!safeId || usedIds.has(safeId)) {
				let counter = 1;
				safeId = `el_${index + 1}`;
				while (usedIds.has(safeId)) {
					safeId = `el_${index + 1}_${counter++}`;
				}
			}

			normalizedElement.id = safeId;
			usedIds.add(safeId);
			return normalizedElement;
		});
	}

	return normalized;
}

export function validateSchemaData(input: unknown): SchemaValidationResult {
	const errors: string[] = [];
	const parsedRaw = parseSchemaData(input);

	if (!isRecord(parsedRaw)) {
		return { ok: false, errors: ['schemaData must be an object'] };
	}
	const parsed = normalizeSchemaDataShape(parsedRaw);

	const version = parsed.version;
	if (typeof version !== 'string') {
		pushError(errors, 'schemaData.version must be a string');
	}

	const elementsRaw = parsed.elements;
	if (!Array.isArray(elementsRaw)) {
		pushError(errors, 'schemaData.elements must be an array');
		return { ok: false, errors };
	}
	if (elementsRaw.length === 0) {
		pushError(errors, 'schemaData.elements must not be empty');
	}
	if (elementsRaw.length > MAX_SCHEMA_ELEMENTS) {
		pushError(errors, `schemaData.elements exceeds ${MAX_SCHEMA_ELEMENTS}`);
	}

	if (parsed.annotations !== undefined) {
		validateTextArray(parsed.annotations, 'annotations', errors);
	}
	if (parsed.assumptions !== undefined) {
		validateTextArray(parsed.assumptions, 'assumptions', errors);
	}

	const ids = new Set<string>();

	for (const [index, rawElement] of elementsRaw.entries()) {
		if (!isRecord(rawElement)) {
			pushError(errors, `elements[${index}] must be an object`);
			continue;
		}

		const id = rawElement.id;
		const type = rawElement.type;
		const geometry = rawElement.geometry;

		if (typeof id !== 'string' || id.length === 0) {
			pushError(errors, `elements[${index}].id must be a non-empty string`);
		} else {
			if (ids.has(id)) pushError(errors, `Duplicate element id: ${id}`);
			ids.add(id);
		}

		if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
			pushError(errors, `elements[${index}].type is not supported`);
		}

		if (!isRecord(geometry)) {
			pushError(errors, `elements[${index}].geometry must be an object`);
			continue;
		}

		walkNumbers(rawElement, (num, path) => {
			if (!Number.isFinite(num)) {
				pushError(errors, `${path} must be finite`);
			}
		}, `elements[${index}]`);

		walkPoints(geometry, (point, path) => {
			if (Math.abs(point.x) > MAX_COORD_ABS || Math.abs(point.y) > MAX_COORD_ABS) {
				pushError(errors, `${path} is outside coordinate bounds`);
			}
		}, `elements[${index}].geometry`);

		if (type === 'distributed_load') {
			validateDistributedLoad(
				{
					id: typeof id === 'string' ? id : `elements[${index}]`,
					type: 'distributed_load',
					geometry
				},
				errors
			);
		}
		if (type === 'beam_segment') {
			validateLinearElement(
				{
					id: typeof id === 'string' ? id : `elements[${index}]`,
					type: 'beam_segment',
					geometry
				},
				errors,
				'beam_segment'
			);
		}
		if (type === 'axis') {
			validateLinearElement(
				{
					id: typeof id === 'string' ? id : `elements[${index}]`,
					type: 'axis',
					geometry
				},
				errors,
				'axis'
			);
		}
		if (type === 'dimension') {
			validateLinearElement(
				{
					id: typeof id === 'string' ? id : `elements[${index}]`,
					type: 'dimension',
					geometry
				},
				errors,
				'dimension'
			);
		}
		if (type === 'moment') {
			validateMoment(
				{
					id: typeof id === 'string' ? id : `elements[${index}]`,
					type: 'moment',
					geometry
				},
				errors
			);
		}
		if (
			type === 'support_pin' ||
			type === 'support_roller' ||
			type === 'support_fixed' ||
			type === 'point_load' ||
			type === 'hinge' ||
			type === 'joint' ||
			type === 'label'
		) {
			validatePointAnchoredElement(
				{
					id: typeof id === 'string' ? id : `elements[${index}]`,
					type,
					geometry
				},
				errors,
				type
			);
		}
	}

	const coord = parsed.coordinateSystem;
	if (coord !== undefined && !isRecord(coord)) {
		pushError(errors, 'coordinateSystem must be an object');
	}

	if (isRecord(coord) && coord.origin !== undefined) {
		if (!isValidPoint(coord.origin)) {
			pushError(errors, 'coordinateSystem.origin must be a point');
		} else if (Math.abs(coord.origin.x) > MAX_COORD_ABS || Math.abs(coord.origin.y) > MAX_COORD_ABS) {
			pushError(errors, 'coordinateSystem.origin is outside coordinate bounds');
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, errors: [], value: parsed as unknown as SchemaData };
}
