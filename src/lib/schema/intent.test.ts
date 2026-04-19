import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	parseSchemeIntentResponse,
	validateSchemeIntent,
	normalizeSchemeIntent
} from './intent.ts';
import type { SchemeIntentV1 } from './intent.ts';

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
    "assumptions": ["inside intent"],
    "ambiguities": []
  },
  "assumptions": ["outside intent"],
  "ambiguities": ["ambiguity"]
}
\`\`\``;
		const parsed = parseSchemeIntentResponse(raw);

		expect(parsed.intent.structureKind).toBe('beam');
		expect(parsed.intent.members).toHaveLength(1);
		expect(parsed.assumptions).toEqual(['inside intent', 'outside intent']);
		expect(parsed.ambiguities).toEqual(['ambiguity']);
	});

	it('recovers revision response by merging with base intent when joints/members are missing', () => {
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
			assumptions: ['base assumption'],
			ambiguities: []
		};

		const raw = `{
  "intent": {
    "version": "intent-1.0",
    "taskDomain": "mechanics",
    "structureKind": "planar_frame",
    "modelSpace": "planar",
    "supports": [],
    "loads": [],
    "assumptions": ["revision assumption"]
  }
}`;

		const parsed = parseSchemeIntentResponse(raw, { baseIntent });
		expect(parsed.intent.joints).toEqual(baseIntent.joints);
		expect(parsed.intent.members).toEqual(baseIntent.members);
		expect(parsed.intent.supports).toEqual([]);
		expect(parsed.intent.loads).toEqual([]);
		expect(parsed.assumptions).toContain('revision assumption');
		expect(parsed.warnings.some((warning) => warning.includes('merged with base intent'))).toBe(true);
	});
});

describe('scheme intent validation', () => {
	it('rejects supports that reference unknown joints', () => {
		const result = validateSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'A_end' }],
			supports: [{ key: 's1', kind: 'hinge_fixed', jointKey: 'MissingJoint' }],
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

	it('extends partial joints list from member endpoints', () => {
		const normalized = normalizeSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'node_bottom' }],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(normalized.value.joints.map((joint) => joint.key)).toEqual(['A', 'node_bottom']);
		expect(normalized.warnings.some((warning) => warning.includes('extended'))).toBe(true);

		const validated = validateSchemeIntent(normalized.value);
		expect(validated.ok).toBe(true);
	});

	it('accepts prismatic pairs anchored by member reference without jointKey', () => {
		const result = validateSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_mechanism',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'O' }, { key: 'A' }, { key: 'B' }],
			members: [
				{ key: 'OA', kind: 'bar', startJoint: 'O', endJoint: 'A' },
				{ key: 'AB', kind: 'bar', startJoint: 'A', endJoint: 'B' }
			],
			components: [],
			kinematicPairs: [{ key: 'sliderB', kind: 'prismatic_pair', memberKeys: ['AB'] }],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(result.ok).toBe(true);
	});

	it('infers cantilever fixed support position from sideHint when memberKey is used', () => {
		const normalized = normalizeSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [{ key: 's1', kind: 'fixed_wall', memberKey: 'm1', sideHint: 'left' }],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(normalized.value.supports[0]?.s).toBe(0);
		expect(validateSchemeIntent(normalized.value).ok).toBe(true);
		expect(
			normalized.warnings.some((warning) => warning.includes('member placement was inferred'))
		).toBe(true);
	});

	it('parses explicit support endpoint aliases into member position', () => {
		const normalized = normalizeSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [{ key: 's1', kind: 'fixed_wall', memberKey: 'm1', at: 'end' }],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(normalized.value.supports[0]?.s).toBe(1);
		expect(validateSchemeIntent(normalized.value).ok).toBe(true);
	});

	it('normalizes centerJoint alias for kinematic pairs', () => {
		const normalized = normalizeSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_mechanism',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'AB', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			kinematicPairs: [{ key: 'p1', kind: 'prismatic_pair', centerJoint: 'B' }],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(normalized.value.kinematicPairs[0]?.jointKey).toBe('B');
		expect(validateSchemeIntent(normalized.value).ok).toBe(true);
	});

	it('allows legacy Q/M requested results for planar_frame', () => {
		const result = validateSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_frame',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [],
			loads: [],
			requestedResults: [{ kind: 'N' }, { kind: 'Q' }, { kind: 'M' }],
			assumptions: [],
			ambiguities: []
		});

		expect(result.ok).toBe(true);
	});

	it('keeps rejecting legacy Q/M requested results for spatial_frame', () => {
		const result = validateSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'spatial_frame',
			modelSpace: 'spatial',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [],
			loads: [],
			requestedResults: [{ kind: 'Q' }, { kind: 'M' }],
			assumptions: [],
			ambiguities: []
		});

		expect(result.ok).toBe(false);
		expect(result.errors.some((error) => error.includes('requestedResults'))).toBe(true);
	});

	it('canonicalizes mechanism support aliases into kinematic pairs', () => {
		const normalized = normalizeSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_mechanism',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'O' }, { key: 'A' }, { key: 'B' }],
			members: [{ key: 'OA', kind: 'bar', startJoint: 'O', endJoint: 'A' }],
			supports: [
				{ key: 'h1', kind: 'internal_hinge', jointKey: 'A' },
				{ key: 'sl1', kind: 'slider', jointKey: 'B', guideHint: 'horizontal' }
			],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(normalized.value.kinematicPairs.some((pair) => pair.kind === 'revolute_pair')).toBe(true);
		expect(normalized.value.kinematicPairs.some((pair) => pair.kind === 'prismatic_pair')).toBe(true);
		expect(normalized.value.supports).toHaveLength(0);
		expect(
			normalized.warnings.some((warning) => warning.includes('canonicalized to kinematicPairs'))
		).toBe(true);
	});

	it('defaults missing joint and member labels to keys', () => {
		const normalized = normalizeSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(normalized.value.joints.map((joint) => joint.label)).toEqual(['A', 'B']);
		expect(normalized.value.members[0]?.label).toBe('m1');
		expect(normalized.warnings.some((warning) => warning.includes('label was missing'))).toBe(true);
	});

	it('normalizes distributed member+s target into interval and validates it', () => {
		const normalized = normalizeSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [],
			loads: [{ key: 'q1', kind: 'distributed', target: { memberKey: 'm1', s: 0.5 } }],
			assumptions: [],
			ambiguities: []
		});

		const target = normalized.value.loads[0]?.target;
		expect(target).toBeTruthy();
		if (!target || !('fromS' in target) || !('toS' in target)) return;
		expect(target.fromS).toBeCloseTo(0.4, 6);
		expect(target.toS).toBeCloseTo(0.6, 6);

		const validated = validateSchemeIntent(normalized.value);
		expect(validated.ok).toBe(true);
	});

	it('rejects distributed load that targets only a joint', () => {
		const result = validateSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [],
			loads: [{ key: 'q1', kind: 'distributed', target: { jointKey: 'A' } }],
			assumptions: [],
			ambiguities: []
		});

		expect(result.ok).toBe(false);
		expect(result.errors.some((error) => error.includes('distributed'))).toBe(true);
	});
});
