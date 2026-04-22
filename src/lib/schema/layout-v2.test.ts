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

	it('applies origin policy and enriches linear constraints', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			coordinateSystem: {
				originPolicy: 'fixed_support'
			},
			nodes: [
				{ id: 'A', x: 7, y: 2 },
				{ id: 'B', x: 12, y: 2 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: {}
				},
				{
					id: 'fixed_1',
					type: 'fixed_wall',
					nodeRefs: ['A'],
					geometry: { wallSide: 'left' }
				}
			],
			results: [],
			annotations: [],
			assumptions: [],
			ambiguities: []
		};

		const stabilized = stabilizeSchemaLayoutV2(schema);
		const byId = new Map(stabilized.schema.nodes.map((node) => [node.id, node]));
		const anchor = byId.get('A');
		expect(anchor).toBeTruthy();
		expect(Math.abs((anchor as { x: number }).x)).toBeLessThan(1e-6);
		expect(Math.abs((anchor as { y: number }).y)).toBeLessThan(1e-6);

		const bar = stabilized.schema.objects.find((object) => object.id === 'bar_1');
		expect(bar).toBeTruthy();
		expect(typeof bar?.geometry.length).toBe('number');
		expect((bar?.geometry.length as number) > 0).toBe(true);
		expect(typeof bar?.geometry.angleDeg).toBe('number');

		const fixed = stabilized.schema.objects.find((object) => object.id === 'fixed_1');
		expect(typeof fixed?.geometry.angle).toBe('number');
	});

	it('honors attach parameterization for load placement on member', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 4, y: 0 },
				{ id: 'F', x: 0, y: 0 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 4, angleDeg: 0 }
				},
				{
					id: 'force_1',
					type: 'force',
					nodeRefs: ['F'],
					geometry: {
						directionAngle: -90,
						attach: {
							memberId: 'bar_1',
							s: 0.25,
							side: '+n',
							offset: 0.5
						}
					}
				}
			],
			results: [],
			annotations: [],
			assumptions: [],
			ambiguities: []
		};

		const stabilized = stabilizeSchemaLayoutV2(schema);
		const nodeById = new Map(stabilized.schema.nodes.map((node) => [node.id, node]));
		const a = nodeById.get('A');
		const b = nodeById.get('B');
		const f = nodeById.get('F');
		expect(a && b && f).toBeTruthy();
		if (!a || !b || !f) return;

		const abx = b.x - a.x;
		const aby = b.y - a.y;
		const ab2 = abx * abx + aby * aby;
		expect(ab2).toBeGreaterThan(0);

		const afx = f.x - a.x;
		const afy = f.y - a.y;
		const s = (afx * abx + afy * aby) / ab2;
		expect(s).toBeGreaterThan(0.15);
		expect(s).toBeLessThan(0.35);

		const cross = abx * afy - aby * afx;
		expect(cross).toBeGreaterThan(0);
	});

	it('preserves explicit member length after fit-to-view scaling', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			coordinateSystem: {
				originPolicy: 'fixed_support'
			},
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 5, y: 0 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 5, angleDeg: 0 }
				},
				{
					id: 'fixed_1',
					type: 'fixed_wall',
					nodeRefs: ['A'],
					geometry: { wallSide: 'left' }
				}
			],
			results: [],
			annotations: [],
			assumptions: [],
			ambiguities: []
		};

		const stabilized = stabilizeSchemaLayoutV2(schema);
		const nodeById = new Map(stabilized.schema.nodes.map((node) => [node.id, node]));
		const a = nodeById.get('A');
		const b = nodeById.get('B');
		expect(a && b).toBeTruthy();
		if (!a || !b) return;

		const displaySpan = Math.hypot(b.x - a.x, b.y - a.y);
		expect(displaySpan).toBeCloseTo(6, 6);

		const bar = stabilized.schema.objects.find((object) => object.id === 'bar_1');
		expect(bar).toBeTruthy();
		expect(bar?.geometry.length).toBe(5);
	});
});
