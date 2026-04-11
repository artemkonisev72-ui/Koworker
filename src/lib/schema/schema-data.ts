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

function isValidPoint(value: unknown): value is SchemaPoint {
	if (!isRecord(value)) return false;
	return isFiniteNumber(value.x) && isFiniteNumber(value.y);
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
	if (direction !== 'cw' && direction !== 'ccw') {
		pushError(errors, `${element.id}: moment.direction must be "cw" or "ccw"`);
	}
	if (!isFiniteNumber(magnitude)) {
		pushError(errors, `${element.id}: moment.magnitude must be a finite number`);
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
	if (isRecord(element.geometry)) return element;

	const normalized: Record<string, unknown> = { ...element };

	if (
		Array.isArray(element.geometry) &&
		element.geometry.length === 2 &&
		isValidPoint(element.geometry[0]) &&
		isValidPoint(element.geometry[1])
	) {
		normalized.geometry = { start: element.geometry[0], end: element.geometry[1] };
		return normalized;
	}

	const geometryEntries = Object.entries(element).filter(([key]) => !ELEMENT_NON_GEOMETRY_KEYS.has(key));
	const geometry: Record<string, unknown> = {};
	for (const [key, value] of geometryEntries) {
		geometry[key] = value;
		delete normalized[key];
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
		normalized.elements = normalized.elements.map((entry) =>
			isRecord(entry) ? normalizeElementShape(entry) : entry
		);
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
