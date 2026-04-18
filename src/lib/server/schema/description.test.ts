import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	buildSchemeDescriptionFacts,
	buildSchemeDescriptionFallback
} from './description.ts';
import type { SchemeIntentV1 } from '$lib/schema/intent.js';

describe('scheme description helper', () => {
	it('builds facts from intent and assumptions', () => {
		const intent: SchemeIntentV1 = {
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'high',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B', relation: 'horizontal' }],
			components: [],
			kinematicPairs: [],
			supports: [{ key: 's1', kind: 'fixed_wall', jointKey: 'A', sideHint: 'left' }],
			loads: [{ key: 'q1', kind: 'distributed', target: { memberKey: 'm1', fromS: 0, toS: 1 }, directionHint: 'down' }],
			requestedResults: [{ targetMemberKey: 'm1', kind: 'Q' }],
			assumptions: ['inside'],
			ambiguities: []
		};

		const facts = buildSchemeDescriptionFacts({
			schema: {
				version: '2.0',
				nodes: [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 1, y: 0 }],
				objects: [{ id: 'bar_1', type: 'bar', nodeRefs: ['A', 'B'], geometry: { length: 1, angleDeg: 0 } }],
				results: []
			},
			intent,
			assumptions: ['outside']
		});

		expect(facts.structureKind).toBe('beam');
		expect(facts.modelSpace).toBe('planar');
		expect(facts.members.some((line) => line.includes('m1'))).toBe(true);
		expect(facts.supports.some((line) => line.includes('fixed_wall'))).toBe(true);
		expect(facts.loads.some((line) => line.includes('distributed'))).toBe(true);
		expect(facts.requestedResults).toEqual(['Q on m1']);
		expect(facts.assumptions).toEqual(['outside']);
	});

	it('falls back to schema inference and returns readable text', () => {
		const facts = buildSchemeDescriptionFacts({
			schema: {
				version: '2.0',
				meta: { structureKind: 'spatial_frame' },
				coordinateSystem: { modelSpace: 'spatial' },
				nodes: [
					{ id: 'A', x: 0, y: 0, z: 0 },
					{ id: 'B', x: 1, y: 1, z: 1 }
				],
				objects: [
					{ id: 'bar_1', type: 'bar', nodeRefs: ['A', 'B'], geometry: { length: 1.73, angleDeg: 45 } },
					{
						id: 'f_1',
						type: 'force',
						nodeRefs: ['B'],
						geometry: { directionAngle: -90, attach: { memberId: 'bar_1', s: 1 } }
					}
				],
				results: []
			}
		});

		const descriptionRu = buildSchemeDescriptionFallback(facts, 'ru');
		expect(facts.structureKind).toBe('spatial_frame');
		expect(descriptionRu).toContain('Тип схемы');
		expect(descriptionRu).toContain('Пространственная рама');
		expect(descriptionRu).toContain('Нагрузки');
	});

	it('prefers labels from intent for joints and members', () => {
		const facts = buildSchemeDescriptionFacts({
			schema: {
				version: '2.0',
				nodes: [
					{ id: 'n1', x: 0, y: 0, label: 'A' },
					{ id: 'n2', x: 1, y: 0, label: 'B' }
				],
				objects: [{ id: 'bar_1', type: 'bar', nodeRefs: ['n1', 'n2'], geometry: { length: 1, angleDeg: 0 } }],
				results: []
			},
			intent: {
				version: 'intent-1.0',
				taskDomain: 'mechanics',
				structureKind: 'beam',
				modelSpace: 'planar',
				confidence: 'high',
				source: { hasImage: false, language: 'ru' },
				joints: [{ key: 'J1', label: 'A' }, { key: 'J2', label: 'B' }],
				members: [{ key: 'm1', label: 'AB', kind: 'bar', startJoint: 'J1', endJoint: 'J2' }],
				components: [],
				kinematicPairs: [],
				supports: [],
				loads: [],
				assumptions: [],
				ambiguities: []
			}
		});

		expect(facts.joints).toEqual(['A', 'B']);
		expect(facts.members.some((line) => line.includes('AB: A -> B'))).toBe(true);
	});
});
