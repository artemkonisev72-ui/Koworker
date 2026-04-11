import { describe, expect, it } from 'vitest';
import type { SchemaDataV2 } from './schema-v2.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { analyzeSchemaLayoutV2, stabilizeSchemaLayoutV2 } from './layout-v2.ts';

describe('layout-v2', () => {
	it('detects collapsed coordinates and improves layout metrics', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 0, y: 0 },
				{ id: 'C', x: 0, y: 0 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 4 }
				},
				{
					id: 'bar_2',
					type: 'bar',
					nodeRefs: ['B', 'C'],
					geometry: { length: 3 }
				},
				{
					id: 'support_1',
					type: 'hinge_roller',
					nodeRefs: ['A'],
					geometry: {}
				},
				{
					id: 'force_1',
					type: 'force',
					nodeRefs: ['C'],
					geometry: { directionAngle: -90, magnitude: 10 }
				}
			],
			results: [],
			annotations: [],
			assumptions: [],
			ambiguities: []
		};

		const before = analyzeSchemaLayoutV2(schema);
		expect(before.coordCollapseRate).toBeGreaterThan(0.5);

		const stabilized = stabilizeSchemaLayoutV2(schema);
		const after = stabilized.metricsAfter;

		expect(stabilized.corrected).toBe(true);
		expect(stabilized.corrections.length).toBeGreaterThan(0);
		expect(after.coordCollapseRate).toBeLessThan(before.coordCollapseRate);
		expect(after.minElementSeparation).toBeGreaterThan(before.minElementSeparation);
	});
});
