import { validateSchemaAny, type SchemaAny, type SchemaVersionTag } from '$lib/schema/schema-any.js';
import type { NodeV2, ObjectV2, ResultV2, SchemaDataV2 } from '$lib/schema/schema-v2.js';

export interface SchemaPatch {
	deleteObjectIds: string[];
	deleteResultIds: string[];
	addNodes: NodeV2[];
	addObjects: ObjectV2[];
	addResults: ResultV2[];
}

export interface SchemaPatchExtractionResult {
	hasPatch: boolean;
	patch?: SchemaPatch;
	issues: string[];
}

export interface SchemaPatchApplyResult {
	ok: boolean;
	issues: string[];
	value?: SchemaAny;
	version?: SchemaVersionTag;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeIdArray(
	raw: unknown,
	fieldName: 'deleteObjectIds' | 'deleteResultIds',
	issues: string[]
): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		issues.push(`schemaPatch.${fieldName} must be an array`);
		return [];
	}

	const values: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < raw.length; index++) {
		const item = raw[index];
		if (typeof item !== 'string' || item.trim().length === 0) {
			issues.push(`schemaPatch.${fieldName}[${index}] must be a non-empty string`);
			continue;
		}
		const id = item.trim();
		if (seen.has(id)) {
			issues.push(`schemaPatch.${fieldName} contains duplicate id "${id}"`);
			continue;
		}
		seen.add(id);
		values.push(id);
	}
	return values;
}

function normalizeObjectArray<T>(
	raw: unknown,
	fieldName: 'addNodes' | 'addObjects' | 'addResults',
	issues: string[]
): T[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		issues.push(`schemaPatch.${fieldName} must be an array`);
		return [];
	}

	const values: T[] = [];
	for (let index = 0; index < raw.length; index++) {
		const item = raw[index];
		if (!isRecord(item)) {
			issues.push(`schemaPatch.${fieldName}[${index}] must be an object`);
			continue;
		}
		values.push(item as T);
	}
	return values;
}

export function extractSchemaPatchFromOutput(output: unknown): SchemaPatchExtractionResult {
	if (!isRecord(output)) {
		return { hasPatch: false, issues: [] };
	}

	const candidate = output.schemaPatch ?? output.schema_patch;
	if (candidate === undefined || candidate === null) {
		return { hasPatch: false, issues: [] };
	}
	if (!isRecord(candidate)) {
		return { hasPatch: true, issues: ['schemaPatch must be an object'] };
	}

	const issues: string[] = [];
	const patch: SchemaPatch = {
		deleteObjectIds: normalizeIdArray(candidate.deleteObjectIds, 'deleteObjectIds', issues),
		deleteResultIds: normalizeIdArray(candidate.deleteResultIds, 'deleteResultIds', issues),
		addNodes: normalizeObjectArray<NodeV2>(candidate.addNodes, 'addNodes', issues),
		addObjects: normalizeObjectArray<ObjectV2>(candidate.addObjects, 'addObjects', issues),
		addResults: normalizeObjectArray<ResultV2>(candidate.addResults, 'addResults', issues)
	};

	return {
		hasPatch: true,
		patch,
		issues
	};
}

function cloneSchema<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function getId(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== 'string') return null;
	const normalized = value.id.trim();
	return normalized.length > 0 ? normalized : null;
}

export function applySchemaPatchToApprovedSchema(
	approvedSchema: unknown,
	patch: SchemaPatch
): SchemaPatchApplyResult {
	const baseValidation = validateSchemaAny(approvedSchema);
	if (!baseValidation.ok || !baseValidation.value) {
		return {
			ok: false,
			issues: [
				'Approved schema is invalid',
				...baseValidation.errors
			]
		};
	}

	const baseSchema = cloneSchema(baseValidation.value as SchemaDataV2);
	const issues: string[] = [];

	const objectDeleteSet = new Set(patch.deleteObjectIds);
	const resultDeleteSet = new Set(patch.deleteResultIds);

	const baseObjectIds = new Set(baseSchema.objects.map((object) => object.id));
	const baseResultIds = new Set((baseSchema.results ?? []).map((result) => result.id));
	const baseNodeIds = new Set(baseSchema.nodes.map((node) => node.id));

	for (const id of objectDeleteSet) {
		if (!baseObjectIds.has(id)) {
			issues.push(`schemaPatch.deleteObjectIds references unknown object id "${id}"`);
		}
	}
	for (const id of resultDeleteSet) {
		if (!baseResultIds.has(id)) {
			issues.push(`schemaPatch.deleteResultIds references unknown result id "${id}"`);
		}
	}

	const nextNodeIds = new Set(baseNodeIds);
	for (let index = 0; index < patch.addNodes.length; index++) {
		const id = getId(patch.addNodes[index]);
		if (!id) continue;
		if (nextNodeIds.has(id)) {
			issues.push(`schemaPatch.addNodes[${index}] reuses existing node id "${id}" (node deletion is not supported)`);
			continue;
		}
		nextNodeIds.add(id);
	}

	for (let index = 0; index < patch.addObjects.length; index++) {
		const id = getId(patch.addObjects[index]);
		if (!id) continue;
		if (baseObjectIds.has(id) && !objectDeleteSet.has(id)) {
			issues.push(
				`schemaPatch.addObjects[${index}] attempts to mutate existing object "${id}" without explicit delete`
			);
		}
	}

	for (let index = 0; index < patch.addResults.length; index++) {
		const id = getId(patch.addResults[index]);
		if (!id) continue;
		if (baseResultIds.has(id) && !resultDeleteSet.has(id)) {
			issues.push(
				`schemaPatch.addResults[${index}] attempts to mutate existing result "${id}" without explicit delete`
			);
		}
	}

	if (issues.length > 0) {
		return { ok: false, issues };
	}

	const nextSchema: SchemaDataV2 = {
		...baseSchema,
		nodes: [...baseSchema.nodes, ...patch.addNodes],
		objects: [...baseSchema.objects.filter((object) => !objectDeleteSet.has(object.id)), ...patch.addObjects],
		results: [...(baseSchema.results ?? []).filter((result) => !resultDeleteSet.has(result.id)), ...patch.addResults]
	};

	const mergedValidation = validateSchemaAny(nextSchema);
	if (!mergedValidation.ok || !mergedValidation.value) {
		return {
			ok: false,
			issues: mergedValidation.errors
		};
	}

	return {
		ok: true,
		issues: [],
		value: mergedValidation.value,
		version: mergedValidation.version ?? '2.0'
	};
}
