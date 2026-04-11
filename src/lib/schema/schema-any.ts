import type { SchemaData } from './schema-data.js';
import type { SchemaDataV2 } from './schema-v2.js';
import { isSchemaDataV2, isSchemaDataV2Loose, SCHEMA_DATA_V2_VERSION } from './schema-v2.js';
import { validateSchemaData, type SchemaValidationResult } from './schema-data.js';
import { validateSchemaDataV2 } from './validate-v2.js';
import { adaptSchemaV1ToV2 } from './adapters-v2.js';

export type SchemaAny = SchemaData | SchemaDataV2;
export type SchemaVersionTag = '1.0' | '2.0';

export interface SchemaAnyValidationResult {
	ok: boolean;
	errors: string[];
	value?: SchemaAny;
	version?: SchemaVersionTag;
	warnings?: string[];
}

export function detectSchemaVersion(input: unknown): SchemaVersionTag {
	if (isSchemaDataV2(input)) return '2.0';
	if (isSchemaDataV2Loose(input)) return '2.0';
	return '1.0';
}

export function validateSchemaAny(input: unknown): SchemaAnyValidationResult {
	if (detectSchemaVersion(input) === '2.0') {
		const v2 = validateSchemaDataV2(input);
		return {
			ok: v2.ok,
			errors: v2.errors,
			value: v2.value,
			version: '2.0',
			warnings: v2.warnings
		};
	}

	const v1: SchemaValidationResult = validateSchemaData(input);
	if (!v1.ok || !v1.value) {
		return {
			ok: false,
			errors: v1.errors,
			version: '1.0'
		};
	}

	// Normalize old schemas into v2 so downstream pipeline/rendering can be uniform.
	const asV2 = adaptSchemaV1ToV2(v1.value);
	const v2Validation = validateSchemaDataV2(asV2);
	if (!v2Validation.ok || !v2Validation.value) {
		return {
			ok: false,
			errors: v2Validation.errors,
			version: '2.0',
			warnings: [
				...(v2Validation.warnings ?? []),
				'Schema v1 validated, but adapter v1->v2 produced invalid schema'
			]
		};
	}

	return {
		ok: true,
		errors: [],
		value: v2Validation.value,
		version: '2.0',
		warnings: ['Schema v1 was adapted to schema v2']
	};
}

export function ensureSchemaV2(input: unknown): SchemaDataV2 | null {
	const result = validateSchemaAny(input);
	if (!result.ok || !result.value) return null;
	if (detectSchemaVersion(result.value) === SCHEMA_DATA_V2_VERSION) {
		return result.value as SchemaDataV2;
	}
	return null;
}
