import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { normalizeGraphEpure, getEpureDisplayFactor } from './types.ts';

describe('graph epure normalization', () => {
	it('maps diagramType to epure.kind and applies readable defaults', () => {
		const normalized = normalizeGraphEpure({
			diagramType: 'Q',
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 }
			]
		});

		expect(normalized.graph.type).toBe('diagram');
		expect(normalized.graph.epure?.kind).toBe('Q');
		expect(normalized.graph.epure?.fillHatch).toBe(true);
		expect(normalized.graph.epure?.showSigns).toBe(true);
	});

	it('warns when explicit moment epure is missing compressedFiberSide', () => {
		const normalized = normalizeGraphEpure({
			type: 'diagram',
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 2 }
			],
			epure: {
				kind: 'M',
				fillHatch: true,
				showSigns: true
			}
		});

		expect(normalized.graph.epure?.kind).toBe('M');
		expect(normalized.warnings.length).toBeGreaterThan(0);
	});

	it('keeps legacy diagrams compatible and derives display factor from compressed fiber side', () => {
		const normalized = normalizeGraphEpure({
			type: 'diagram',
			diagramType: 'M',
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 2 }
			],
			epure: {
				kind: 'M',
				compressedFiberSide: '-n'
			}
		});

		expect(normalized.graph.epure?.kind).toBe('M');
		expect(normalized.graph.epure?.fillHatch).toBe(true);
		expect(normalized.graph.epure?.showSigns).toBe(true);
		expect(getEpureDisplayFactor(normalized.graph.epure)).toBe(-1);
	});
});
