import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	parseSchemeIntentResponse,
	validateSchemeIntent,
	normalizeSchemeIntent
} from './intent.ts';

describe('scheme intent parser', () => {
	it('parses wrapped JSON response with intent payload', () => {
		const raw = `\`\`\`json
{
  "intent": {
    "version": "intent-1.0",
    "taskDomain": "mechanics",
    "structureKind": "beam",
    "modelSpace": "planar",
    "confidence": "high",
    "source": { "hasImage": false, "language": "ru" },
    "joints": [{ "key": "A" }, { "key": "B" }],
    "members": [{ "key": "m1", "kind": "bar", "startJoint": "A", "endJoint": "B" }],
    "supports": [],
    "loads": [],
    "assumptions": ["Допущение внутри intent"],
    "ambiguities": []
  },
  "assumptions": ["Допущение снаружи"],
  "ambiguities": ["Неоднозначность"]
}
\`\`\``;
		const parsed = parseSchemeIntentResponse(raw);

		expect(parsed.intent.structureKind).toBe('beam');
		expect(parsed.intent.members).toHaveLength(1);
		expect(parsed.assumptions).toEqual(['Допущение внутри intent', 'Допущение снаружи']);
		expect(parsed.ambiguities).toEqual(['Неоднозначность']);
	});
});

describe('scheme intent validation', () => {
	it('rejects member references to unknown joints', () => {
		const result = validateSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(result.ok).toBe(false);
		expect(result.errors.some((error) => error.includes('unknown'))).toBe(true);
	});

	it('infers joints from members when joints are omitted', () => {
		const normalized = normalizeSchemeIntent({
			structureKind: 'beam',
			modelSpace: 'planar',
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(normalized.value.joints.map((joint) => joint.key)).toEqual(['A', 'B']);
		expect(normalized.warnings.some((warning) => warning.includes('inferred'))).toBe(true);
	});
});
