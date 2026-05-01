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

	it('keeps three bars connected to the same T-joint', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			meta: { structureKind: 'planar_frame' },
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 2, y: 0 },
				{ id: 'C', x: 4, y: 0 },
				{ id: 'D', x: 2, y: 2 }
			],
			objects: [
				{ id: 'bar_ab', type: 'bar', nodeRefs: ['A', 'B'], geometry: { length: 2, angleDeg: 0 } },
				{ id: 'bar_bc', type: 'bar', nodeRefs: ['B', 'C'], geometry: { length: 2, angleDeg: 0 } },
				{ id: 'bar_bd', type: 'bar', nodeRefs: ['B', 'D'], geometry: { length: 2, angleDeg: 90 } }
			],
			results: [],
			annotations: [],
			assumptions: [],
			ambiguities: []
		};

		const stabilized = stabilizeSchemaLayoutV2(schema);
		const bRefCount = stabilized.schema.objects
			.filter((object) => object.type === 'bar')
			.flatMap((object) => object.nodeRefs ?? [])
			.filter((nodeRef) => nodeRef === 'B').length;
		expect(bRefCount).toBe(3);

		const nodeById = new Map(stabilized.schema.nodes.map((node) => [node.id, node]));
		const b = nodeById.get('B');
		const d = nodeById.get('D');
		expect(b && d).toBeTruthy();
		if (!b || !d) return;
		expect(Math.hypot(d.x - b.x, d.y - b.y)).toBeGreaterThan(0.5);
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
		expect(displaySpan).toBeGreaterThan(5);

		const bar = stabilized.schema.objects.find((object) => object.id === 'bar_1');
		expect(bar).toBeTruthy();
		expect(bar?.geometry.length).toBe(5);
	});

	it('uses readable display scale for tiny physical member lengths', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			coordinateSystem: {
				originPolicy: 'fixed_support'
			},
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 0.35, y: 0 },
				{ id: 'F', x: 0, y: 0 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 0.35, angleDeg: 0 }
				},
				{
					id: 'fixed_1',
					type: 'fixed_wall',
					nodeRefs: ['A'],
					geometry: { wallSide: 'left' }
				},
				{
					id: 'force_1',
					type: 'force',
					nodeRefs: ['F'],
					geometry: {
						directionAngle: -90,
						attach: { memberId: 'bar_1', s: 0.5, side: '+n', offset: 0.35 }
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

		const displaySpan = Math.hypot(b.x - a.x, b.y - a.y);
		expect(displaySpan).toBeGreaterThan(5);

		const bar = stabilized.schema.objects.find((object) => object.id === 'bar_1');
		expect(bar?.geometry.length).toBe(0.35);

		const abx = b.x - a.x;
		const aby = b.y - a.y;
		const afx = f.x - a.x;
		const afy = f.y - a.y;
		const s = (afx * abx + afy * aby) / (abx * abx + aby * aby);
		expect(s).toBeGreaterThan(0.4);
		expect(s).toBeLessThan(0.6);
		expect(Math.abs(abx * afy - aby * afx)).toBeGreaterThan(0.1);
	});

	it('keeps mixed physical lengths readable without collapsing short members', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 0.35, y: 0 },
				{ id: 'C', x: 4.35, y: 0 }
			],
			objects: [
				{
					id: 'bar_short',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 0.35, angleDeg: 0 }
				},
				{
					id: 'bar_long',
					type: 'bar',
					nodeRefs: ['B', 'C'],
					geometry: { length: 4, angleDeg: 0 }
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
		const c = nodeById.get('C');
		expect(a && b && c).toBeTruthy();
		if (!a || !b || !c) return;

		const shortSpan = Math.hypot(b.x - a.x, b.y - a.y);
		const longSpan = Math.hypot(c.x - b.x, c.y - b.y);
		expect(shortSpan).toBeGreaterThan(1.2);
		expect(longSpan).toBeGreaterThan(shortSpan);
		expect(longSpan / shortSpan).toBeLessThan(4);

		const short = stabilized.schema.objects.find((object) => object.id === 'bar_short');
		const long = stabilized.schema.objects.find((object) => object.id === 'bar_long');
		expect(short?.geometry.length).toBe(0.35);
		expect(long?.geometry.length).toBe(4);
	});

	it('anchors full-span distributed load endpoints to the member ends', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 5, y: 0 },
				{ id: 'Q1', x: 1, y: -1 },
				{ id: 'Q2', x: 6, y: -1 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 5, angleDeg: 0 }
				},
				{
					id: 'load_1',
					type: 'distributed',
					nodeRefs: ['Q1', 'Q2'],
					geometry: { kind: 'uniform', intensity: 2, directionAngle: 90 },
					meta: { memberId: 'bar_1', fromS: 0, toS: 1 }
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
		const q1 = nodeById.get('Q1');
		const q2 = nodeById.get('Q2');
		expect(a && b && q1 && q2).toBeTruthy();
		if (!a || !b || !q1 || !q2) return;

		expect(q1.x).toBeCloseTo(a.x, 6);
		expect(q1.y).toBeCloseTo(a.y, 6);
		expect(q2.x).toBeCloseTo(b.x, 6);
		expect(q2.y).toBeCloseTo(b.y, 6);
		expect(stabilized.corrections).toEqual(
			expect.arrayContaining([expect.stringContaining('distributed_interval:load_1')])
		);
	});

	it('does not collapse distributed interval endpoints to midpoint attach', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 5, y: 0 },
				{ id: 'Q1', x: 0, y: -1 },
				{ id: 'Q2', x: 5, y: -1 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 5, angleDeg: 0 }
				},
				{
					id: 'load_1',
					type: 'distributed',
					nodeRefs: ['Q1', 'Q2'],
					geometry: {
						kind: 'uniform',
						intensity: 2,
						directionAngle: 90,
						attach: { memberId: 'bar_1', s: 0.5, side: 'center' }
					},
					meta: { memberId: 'bar_1', fromS: 0.2, toS: 0.8 }
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
		const q1 = nodeById.get('Q1');
		const q2 = nodeById.get('Q2');
		expect(a && b && q1 && q2).toBeTruthy();
		if (!a || !b || !q1 || !q2) return;

		const abx = b.x - a.x;
		const aby = b.y - a.y;
		const ab2 = abx * abx + aby * aby;
		const s1 = ((q1.x - a.x) * abx + (q1.y - a.y) * aby) / ab2;
		const s2 = ((q2.x - a.x) * abx + (q2.y - a.y) * aby) / ab2;
		expect(s1).toBeCloseTo(0.2, 6);
		expect(s2).toBeCloseTo(0.8, 6);
		expect(s1).not.toBeCloseTo(0.5, 2);
		expect(s2).not.toBeCloseTo(0.5, 2);
	});

	it('uses eccentricity label as slider-crank guide offset when pair has no explicit offset', () => {
		const schema: SchemaDataV2 = {
			version: '2.0',
			meta: { structureKind: 'planar_mechanism' },
			nodes: [
				{ id: 'O', x: 0, y: 0, label: 'O' },
				{ id: 'A', x: 0.3, y: 0.18, label: 'A' },
				{ id: 'B', x: 1.0, y: 0, label: 'B' },
				{ id: 'G1', x: 0.5, y: 0, visible: false, meta: { synthetic: true } },
				{ id: 'G2', x: 1.5, y: 0, visible: false, meta: { synthetic: true } },
				{ id: 'E1', x: 0.2, y: 0.1 },
				{ id: 'E2', x: 1.6, y: 0.1 }
			],
			objects: [
				{
					id: 'bar_oa',
					type: 'bar',
					nodeRefs: ['O', 'A'],
					geometry: { length: 0.35, angleDeg: 30 },
					label: 'OA'
				},
				{
					id: 'bar_ab',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 0.7, angleDeg: -20 },
					label: 'AB'
				},
				{ id: 'pin_o', type: 'revolute_pair', nodeRefs: ['O'], geometry: {}, label: 'O' },
				{ id: 'pin_a', type: 'revolute_pair', nodeRefs: ['A'], geometry: {}, label: 'A' },
				{
					id: 'slider_b',
					type: 'prismatic_pair',
					nodeRefs: ['B', 'G1', 'G2'],
					geometry: { guideHint: 'horizontal', grounded: true },
					label: 'B'
				},
				{
					id: 'ecc_axis',
					type: 'axis',
					nodeRefs: ['E1', 'E2'],
					geometry: { length: 1.4, angleDeg: 0 },
					label: 'e=0.1m'
				}
			],
			results: [],
			annotations: [],
			assumptions: [],
			ambiguities: []
		};

		const stabilized = stabilizeSchemaLayoutV2(schema);
		const nodeById = new Map(stabilized.schema.nodes.map((node) => [node.id, node]));
		const o = nodeById.get('O');
		const b = nodeById.get('B');
		const guideStart = nodeById.get('G1');
		const guideEnd = nodeById.get('G2');
		expect(o && b && guideStart && guideEnd).toBeTruthy();
		if (!o || !b || !guideStart || !guideEnd) return;

		expect(b.y).toBeGreaterThan(o.y);
		expect(guideStart.y).toBeCloseTo(b.y, 6);
		expect(guideEnd.y).toBeCloseTo(b.y, 6);
		expect(stabilized.corrections).toEqual(
			expect.arrayContaining([expect.stringContaining('slider-crank')])
		);
	});
});
