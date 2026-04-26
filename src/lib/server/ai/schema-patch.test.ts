import { describe, expect, it } from 'vitest';
import type { SchemaDataV2 } from '$lib/schema/schema-v2.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	applySchemaPatchToApprovedSchema,
	extractSchemaPatchFromOutput,
	prepareResultOverlayPatch,
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

describe('result overlay patch preparation', () => {
	it('allows additive velocity, acceleration, and label overlays without changing topology', () => {
		const patch: SchemaPatch = {
			deleteObjectIds: [],
			deleteResultIds: [],
			addNodes: [{ id: 'result_mid', x: 2, y: 0, visible: false }],
			addObjects: [
				{
					id: 'result_v_B',
					type: 'velocity',
					nodeRefs: ['B'],
					geometry: { direction: { x: 1, y: 0 }, magnitude: 2 },
					label: 'v_B'
				},
				{
					id: 'result_a_mid',
					type: 'acceleration',
					nodeRefs: ['result_mid'],
					geometry: { directionAngle: 90, magnitude: 4 },
					label: 'a'
				},
				{
					id: 'result_label',
					type: 'label',
					nodeRefs: ['result_mid'],
					geometry: { text: 'max a' }
				}
			],
			addResults: []
		};

		const prepared = prepareResultOverlayPatch(patch);
		expect(prepared.ok).toBe(true);
		expect(prepared.issues).toEqual([]);
		expect(prepared.patch).toBeTruthy();
		const result = applySchemaPatchToApprovedSchema(makeApprovedSchema(), prepared.patch!);
		expect(result.ok).toBe(true);
		const value = result.value as SchemaDataV2 | undefined;
		expect(value?.objects.map((object) => object.id)).toEqual([
			'bar_1',
			'result_v_B',
			'result_a_mid',
			'result_label'
		]);
		expect(value?.objects.find((object) => object.id === 'bar_1')?.type).toBe('bar');
	});

	it('rejects topology object additions for result overlays', () => {
		const patch: SchemaPatch = {
			deleteObjectIds: [],
			deleteResultIds: [],
			addNodes: [],
			addObjects: [
				{
					id: 'result_bar',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 4, angleDeg: 0 }
				}
			],
			addResults: []
		};

		const prepared = prepareResultOverlayPatch(patch);
		expect(prepared.ok).toBe(false);
		expect(prepared.issues.some((issue) => issue.includes('not allowed for result overlays'))).toBe(
			true
		);
		expect(prepared.patch).toBeUndefined();
	});

	it('ignores delete operations for result overlays', () => {
		const patch: SchemaPatch = {
			deleteObjectIds: ['bar_1'],
			deleteResultIds: [],
			addNodes: [],
			addObjects: [
				{
					id: 'result_v_B',
					type: 'velocity',
					nodeRefs: ['B'],
					geometry: { direction: { x: 1, y: 0 }, magnitude: 2 }
				}
			],
			addResults: []
		};

		const prepared = prepareResultOverlayPatch(patch);
		expect(prepared.ok).toBe(true);
		expect(prepared.warnings).toContain('schemaPatch.deleteObjectIds ignored for result overlays');
		expect(prepared.patch?.deleteObjectIds).toEqual([]);
		const result = applySchemaPatchToApprovedSchema(makeApprovedSchema(), prepared.patch!);
		expect(result.ok).toBe(true);
		const value = result.value as SchemaDataV2 | undefined;
		expect(value?.objects.some((object) => object.id === 'bar_1')).toBe(true);
		expect(value?.objects.some((object) => object.id === 'result_v_B')).toBe(true);
	});
});
