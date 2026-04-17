import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { buildSolverModelFromSchema } from './model.ts';

describe('solver model builder', () => {
	it('canonicalizes cantilever member axis origin to free_end', () => {
		const built = buildSolverModelFromSchema({
			version: '2.0',
			meta: { structureKind: 'beam' },
			coordinateSystem: { modelSpace: 'planar' },
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 4, y: 0 }
			],
			objects: [
				{ id: 'bar_1', type: 'bar', nodeRefs: ['A', 'B'], geometry: { length: 4, angleDeg: 0 } },
				{ id: 'fixed_1', type: 'fixed_wall', nodeRefs: ['A'], geometry: { wallSide: 'left' } }
			],
			results: []
		});

		expect(built.solverModel.members).toHaveLength(1);
		const member = built.solverModel.members[0];
		expect(member.axisOrigin).toBe('free_end');
		expect(member.startNodeId).toBe('B');
		expect(member.endNodeId).toBe('A');
	});

	it('maps planar frame legacy epure kind Q to component Vy', () => {
		const built = buildSolverModelFromSchema({
			version: '2.0',
			meta: { structureKind: 'planar_frame' },
			coordinateSystem: { modelSpace: 'planar', planeNormal: { x: 0, y: 0, z: 1 } },
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 3, y: 0 }
			],
			objects: [{ id: 'bar_1', type: 'bar', nodeRefs: ['A', 'B'], geometry: { length: 3, angleDeg: 0 } }],
			results: [
				{
					id: 'ep_q',
					type: 'epure',
					meta: { baseObjectId: 'bar_1' },
					geometry: {
						kind: 'Q',
						baseLine: { startNodeId: 'A', endNodeId: 'B' },
						values: [
							{ s: 0, value: 0 },
							{ s: 1, value: 2 }
						]
					}
				}
			]
		});

		expect(built.solverModel.requestedResults).toEqual([{ memberId: 'bar_1', component: 'Vy' }]);
	});

	it('extracts supports and loads with attach semantics', () => {
		const built = buildSolverModelFromSchema({
			version: '2.0',
			meta: { structureKind: 'beam' },
			coordinateSystem: { modelSpace: 'planar' },
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 5, y: 0 },
				{ id: 'F', x: 2.5, y: 0.3 }
			],
			objects: [
				{ id: 'bar_1', type: 'bar', nodeRefs: ['A', 'B'], geometry: { length: 5, angleDeg: 0 } },
				{
					id: 'support_1',
					type: 'hinge_roller',
					nodeRefs: ['F'],
					geometry: { attach: { memberId: 'bar_1', s: 0.5, side: '+n' } }
				},
				{
					id: 'load_1',
					type: 'force',
					nodeRefs: ['F'],
					geometry: { directionAngle: -90, magnitude: 10, attach: { memberId: 'bar_1', s: 0.5 } }
				}
			],
			results: []
		});

		expect(built.solverModel.supports).toHaveLength(1);
		expect(built.solverModel.supports[0]).toMatchObject({ memberId: 'bar_1', s: 0.5 });
		expect(built.solverModel.loads).toHaveLength(1);
		expect(built.solverModel.loads[0]).toMatchObject({
			kind: 'force',
			memberId: 'bar_1',
			s: 0.5
		});
	});
});
