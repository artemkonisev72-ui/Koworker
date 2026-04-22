import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	buildSchemeUnderstandingDescription,
	parseSchemeUnderstandingResponse,
	schemeUnderstandingFromIntent,
	schemeUnderstandingToIntent,
	validateSchemeUnderstanding
} from './understanding.ts';
import type { SchemeIntentV1 } from './intent.ts';

describe('scheme understanding parser', () => {
	it('parses wrapped understanding JSON', () => {
		const raw = `\`\`\`json
{
  "understanding": {
    "version": "understanding-1.0",
    "taskDomain": "mechanics",
    "structureKind": "beam",
    "modelSpace": "planar",
    "confidence": "high",
    "source": { "hasImage": true, "language": "ru" },
    "joints": [{ "key": "A" }, { "key": "B" }],
    "members": [{ "key": "m1", "kind": "bar", "startJoint": "A", "endJoint": "B" }],
    "supports": [
      { "key": "s1", "kind": "fixed_wall", "jointKey": "A" },
      { "key": "s2", "kind": "hinge_roller", "memberKey": "m1" }
    ],
    "loads": [{ "key": "p1", "kind": "force", "target": { "jointKey": "B" }, "directionHint": "down" }],
    "requestedResults": [{ "kind": "M", "targetMemberKey": "m1" }],
    "assumptions": ["inside"],
    "ambiguities": []
  },
  "assumptions": ["outside"]
}
\`\`\``;

		const parsed = parseSchemeUnderstandingResponse(raw);
		expect(parsed.understanding.structureKind).toBe('beam');
		expect(parsed.understanding.members).toHaveLength(1);
		expect(parsed.understanding.supports[1]?.s).toBe(0.5);
		expect(parsed.assumptions).toContain('outside');
		expect(parsed.understanding.assumptions).toContain('outside');
	});

	it('merges sparse revision payload with base understanding', () => {
		const baseIntent: SchemeIntentV1 = {
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_frame',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A', label: 'A' }, { key: 'B', label: 'B' }],
			members: [{ key: 'm1', label: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			components: [],
			kinematicPairs: [],
			supports: [{ key: 's1', kind: 'hinge_fixed', jointKey: 'A' }],
			loads: [{ key: 'l1', kind: 'force', target: { jointKey: 'B' }, directionHint: 'down' }],
			assumptions: ['base'],
			ambiguities: []
		};
		const baseUnderstanding = schemeUnderstandingFromIntent(baseIntent);
		const raw = `{
  "understanding": {
    "version": "understanding-1.0",
    "taskDomain": "mechanics",
    "structureKind": "planar_frame",
    "modelSpace": "planar",
    "supports": [],
    "loads": [],
    "assumptions": ["revised"]
  }
}`;
		const parsed = parseSchemeUnderstandingResponse(raw, { baseUnderstanding });
		expect(parsed.understanding.joints).toEqual(baseUnderstanding.joints);
		expect(parsed.understanding.members).toEqual(baseUnderstanding.members);
		expect(parsed.understanding.supports).toEqual([]);
		expect(parsed.assumptions).toContain('revised');
	});
});

describe('scheme understanding helpers', () => {
	it('validates and converts understanding to intent', () => {
		const understanding = {
			version: 'understanding-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'high',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		};
		const validation = validateSchemeUnderstanding(understanding);
		expect(validation.ok).toBe(true);
		if (!validation.ok || !validation.value) return;
		const intent = schemeUnderstandingToIntent(validation.value);
		expect(intent.version).toBe('intent-1.0');
		expect(intent.members[0]?.key).toBe('m1');
	});

	it('builds readable ru description', () => {
		const understanding = schemeUnderstandingFromIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: true, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			components: [],
			kinematicPairs: [],
			supports: [{ key: 's1', kind: 'fixed_wall', jointKey: 'A', sideHint: 'left' }],
			loads: [{ key: 'q1', kind: 'distributed', target: { memberKey: 'm1', fromS: 0, toS: 1 }, directionHint: 'down' }],
			requestedResults: [{ kind: 'Q', targetMemberKey: 'm1' }],
			assumptions: ['линейная модель'],
			ambiguities: []
		});

		const description = buildSchemeUnderstandingDescription(understanding, 'ru');
		expect(description).toContain('Тип схемы');
		expect(description).toContain('Балка');
		expect(description).toContain('Стержни и узлы');
		expect(description).toContain('Что требуется построить');
	});
});
