import { describe, expect, it } from 'vitest';
import type { SchemaDataV2 } from '$lib/schema/schema-v2.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	applySchemaPatchToApprovedSchema,
	extractSchemaPatchFromOutput,
	type SchemaPatch
} from './schema-patch.ts';

function makeApprovedSchema(): SchemaDataV2 {
	return {
		version: '2.0',
		nodes: [
			{ id: 'A', x: 0, y: 0 },
			{ id: 'B', x: 4, y: 0 }
		],
		objects: [
			{
				id: 'bar_1',
				type: 'bar',
				nodeRefs: ['A', 'B'],
				geometry: { length: 4, angleDeg: 0 }
			}
		],
		results: [],
		assumptions: [],
		ambiguities: [],
		annotations: []
	};
}

describe('schema patch extraction', () => {
	it('extracts canonical schemaPatch payload', () => {
		const extraction = extractSchemaPatchFromOutput({
			schemaPatch: {
				deleteObjectIds: ['bar_1'],
				deleteResultIds: [],
				addNodes: [{ id: 'C', x: 8, y: 0 }],
				addObjects: [],
				addResults: []
			}
		});

		expect(extraction.hasPatch).toBe(true);
		expect(extraction.issues).toEqual([]);
		expect(extraction.patch?.deleteObjectIds).toEqual(['bar_1']);
		expect(extraction.patch?.addNodes.length).toBe(1);
	});
});

describe('schema patch apply', () => {
	it('applies delete+add patch and keeps schema valid', () => {
		const patch: SchemaPatch = {
			deleteObjectIds: ['bar_1'],
			deleteResultIds: [],
			addNodes: [{ id: 'C', x: 8, y: 0 }],
			addObjects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['B', 'C'],
					geometry: { length: 4, angleDeg: 0 }
				}
			],
			addResults: []
		};

		const result = applySchemaPatchToApprovedSchema(makeApprovedSchema(), patch);
		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.version).toBe('2.0');
		const value = result.value as SchemaDataV2 | undefined;
		expect(value?.nodes.some((node) => node.id === 'C')).toBe(true);
		expect(value?.objects.some((object) => object.id === 'bar_1' && object.nodeRefs?.includes('C'))).toBe(
			true
		);
	});

	it('rejects object mutation without explicit delete', () => {
		const patch: SchemaPatch = {
			deleteObjectIds: [],
			deleteResultIds: [],
			addNodes: [{ id: 'C', x: 8, y: 0 }],
			addObjects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['B', 'C'],
					geometry: { length: 4, angleDeg: 0 }
				}
			],
			addResults: []
		};

		const result = applySchemaPatchToApprovedSchema(makeApprovedSchema(), patch);
		expect(result.ok).toBe(false);
		expect(result.issues.some((issue) => issue.includes('without explicit delete'))).toBe(true);
	});

	it('rejects unknown object deletion', () => {
		const patch: SchemaPatch = {
			deleteObjectIds: ['missing_object'],
			deleteResultIds: [],
			addNodes: [],
			addObjects: [],
			addResults: []
		};

		const result = applySchemaPatchToApprovedSchema(makeApprovedSchema(), patch);
		expect(result.ok).toBe(false);
		expect(result.issues.some((issue) => issue.includes('unknown object id'))).toBe(true);
	});

	it('rejects unknown result deletion', () => {
		const patch: SchemaPatch = {
			deleteObjectIds: [],
			deleteResultIds: ['missing_result'],
			addNodes: [],
			addObjects: [],
			addResults: []
		};

		const result = applySchemaPatchToApprovedSchema(makeApprovedSchema(), patch);
		expect(result.ok).toBe(false);
		expect(result.issues.some((issue) => issue.includes('unknown result id'))).toBe(true);
	});
});
