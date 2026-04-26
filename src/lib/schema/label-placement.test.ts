import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { chooseLabelPlacement, type LabelBox } from './label-placement.ts';

describe('label placement', () => {
	it('chooses separate offsets for overlapping anchors', () => {
		const occupiedBoxes: LabelBox[] = [];
		const first = chooseLabelPlacement({
			anchor: { x: 0, y: 0 },
			text: 'A',
			occupiedBoxes,
			boardBox: { minX: -2, maxX: 2, minY: -2, maxY: 2 }
		});
		occupiedBoxes.push(first.box);

		const second = chooseLabelPlacement({
			anchor: { x: 0, y: 0 },
			text: 'B',
			occupiedBoxes,
			boardBox: { minX: -2, maxX: 2, minY: -2, maxY: 2 }
		});

		expect(second.offset.x !== first.offset.x || second.offset.y !== first.offset.y).toBe(true);
		expect(second.point.x !== first.point.x || second.point.y !== first.point.y).toBe(true);
	});

	it('keeps labels inside the board box when possible', () => {
		const placement = chooseLabelPlacement({
			anchor: { x: 1.95, y: 1.95 },
			text: 'edge label',
			occupiedBoxes: [],
			boardBox: { minX: -2, maxX: 2, minY: -2, maxY: 2 }
		});

		expect(placement.box.maxX).toBeLessThanOrEqual(2);
		expect(placement.box.maxY).toBeLessThanOrEqual(2);
		expect(placement.box.minX).toBeGreaterThanOrEqual(-2);
		expect(placement.box.minY).toBeGreaterThanOrEqual(-2);
	});
});
