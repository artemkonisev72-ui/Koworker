import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { buildEpureLayout } from './layout.ts';

function pointInPolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;
		const intersects =
			yi > point.y !== yj > point.y &&
			point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || Number.EPSILON) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

describe('epure layout helper', () => {
	it('inserts a zero crossing and splits regions by sign', () => {
		const layout = buildEpureLayout([
			{ x: 0, value: 2 },
			{ x: 1, value: -2 }
		]);

		expect(layout.curvePoints).toEqual([
			{ x: 0, y: 2 },
			{ x: 0.5, y: 0 },
			{ x: 1, y: -2 }
		]);
		expect(layout.regions).toHaveLength(2);
		expect(layout.regions[0]?.sign).toBe(1);
		expect(layout.regions[1]?.sign).toBe(-1);
	});

	it('keeps hatch segments inside the region polygon', () => {
		const layout = buildEpureLayout([
			{ x: 0, value: 0 },
			{ x: 1, value: 3 },
			{ x: 2, value: 0 }
		]);

		expect(layout.regions).toHaveLength(1);
		const region = layout.regions[0];
		expect(region.hatchSegments.length).toBeGreaterThan(0);

		for (const hatch of region.hatchSegments) {
			const midpoint = {
				x: (hatch.start.x + hatch.end.x) / 2,
				y: (hatch.start.y + hatch.end.y) / 2
			};
			expect(pointInPolygon(midpoint, region.polygon)).toBe(true);
		}
	});

	it('places sign anchor near the geometric center of the region', () => {
		const layout = buildEpureLayout([
			{ x: 0, value: 0 },
			{ x: 2, value: 4 },
			{ x: 4, value: 0 }
		]);

		const region = layout.regions[0];
		expect(region.showSign).toBe(true);
		expect(region.centroid.x).toBeCloseTo(2, 6);
		expect(region.centroid.y).toBeGreaterThan(0);
		expect(region.centroid.y).toBeLessThan(2);
	});

	it('can suppress signs for tiny regions when thresholds demand it', () => {
		const layout = buildEpureLayout(
			[
				{ x: 0, value: 0 },
				{ x: 0.5, value: 0.5 },
				{ x: 1, value: 0 }
			],
			{ minSignAreaRatio: 0.6, minSignWidthRatio: 0.8, minSignHeightRatio: 0.8 }
		);

		expect(layout.regions).toHaveLength(1);
		expect(layout.regions[0]?.showSign).toBe(false);
	});

	it('uses compressed-fiber orientation without changing the logical sign', () => {
		const positiveOrientation = buildEpureLayout([
			{ x: 0, value: 0 },
			{ x: 1, value: 2, displayValue: 2 },
			{ x: 2, value: 0 }
		]);
		const negativeOrientation = buildEpureLayout([
			{ x: 0, value: 0 },
			{ x: 1, value: 2, displayValue: -2 },
			{ x: 2, value: 0 }
		]);

		expect(positiveOrientation.regions[0]?.sign).toBe(1);
		expect(negativeOrientation.regions[0]?.sign).toBe(1);
		expect(positiveOrientation.regions[0]?.centroid.y).toBeGreaterThan(0);
		expect(negativeOrientation.regions[0]?.centroid.y).toBeLessThan(0);
	});
});
