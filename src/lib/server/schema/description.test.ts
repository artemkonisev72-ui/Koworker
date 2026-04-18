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
});
