import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	formatGraphDisplayTitle,
	formatGraphMemberLabel,
	getEpureDisplayFactor,
	normalizeGraphEpure
} from './types.ts';

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

	it('formats localized member labels from common member ids', () => {
		expect(formatGraphMemberLabel('bar_1')).toBe('Стержень 1');
		expect(formatGraphMemberLabel('BAR_AB')).toBe('Стержень AB');
		expect(formatGraphMemberLabel('member-2')).toBe('Стержень 2');
		expect(formatGraphMemberLabel('main girder')).toBe('Стержень main girder');
	});

	it('localizes member-like titles and canonicalizes graph axis orientation when explicitly fixed_end', () => {
		const normalized = normalizeGraphEpure({
			type: 'diagram',
			title: 'MEMBER: BAR_AB',
			memberId: 'BAR_AB',
			points: [
				{ x: 0, y: 4 },
				{ x: 2, y: 1 }
			],
			epure: {
				kind: 'Q',
				axisOrigin: 'fixed_end'
			}
		});

		expect(normalized.graph.epure?.axisOrigin).toBe('free_end');
		expect(normalized.graph.points).toEqual([
			{ x: 0, y: 1 },
			{ x: 2, y: 4 }
		]);
		expect(formatGraphDisplayTitle(normalized.graph)).toBe('Q - Стержень AB');
	});
	it('canonicalizes frame graph axis orientation from member_end to member_start', () => {
		const normalized = normalizeGraphEpure({
			type: 'diagram',
			memberId: 'bar_3',
			diagramType: 'Vy',
			points: [
				{ x: 0, y: 6 },
				{ x: 2, y: 1 }
			],
			epure: {
				component: 'Vy',
				axisOrigin: 'member_end'
			}
		});

		expect(normalized.graph.epure?.axisOrigin).toBe('member_start');
		expect(normalized.graph.points).toEqual([
			{ x: 0, y: 1 },
			{ x: 2, y: 6 }
		]);
	});
});
