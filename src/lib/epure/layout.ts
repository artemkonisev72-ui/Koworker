export interface EpureSample {
	x: number;
	value: number;
	displayValue?: number;
}

export interface EpurePoint {
	x: number;
	y: number;
}

export interface EpureSegment {
	start: EpurePoint;
	end: EpurePoint;
}

export interface EpureRegion {
	sign: 1 | -1;
	area: number;
	width: number;
	height: number;
	polygon: EpurePoint[];
	centroid: EpurePoint;
	hatchSegments: EpureSegment[];
	showSign: boolean;
}

export interface EpureLayout {
	curvePoints: EpurePoint[];
	regions: EpureRegion[];
	xMin: number;
	xMax: number;
	yAbsMax: number;
}

export interface EpureTransform {
	origin: EpurePoint;
	tangent: EpurePoint;
	normal: EpurePoint;
}

export interface BuildEpureLayoutOptions {
	zeroEpsilon?: number;
	hatchSpacing?: number;
	hatchAngleDeg?: number;
	minSignAreaRatio?: number;
	minSignWidthRatio?: number;
	minSignHeightRatio?: number;
}

interface NormalizedEpureSample {
	x: number;
	value: number;
	displayValue: number;
}

const DEFAULT_ZERO_EPSILON = 1e-9;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function signOf(value: number, epsilon: number): 1 | -1 | 0 {
	if (value > epsilon) return 1;
	if (value < -epsilon) return -1;
	return 0;
}

function almostEqual(a: number, b: number, epsilon: number): boolean {
	return Math.abs(a - b) <= epsilon;
}

function pointsEqual(a: EpurePoint, b: EpurePoint, epsilon: number): boolean {
	return almostEqual(a.x, b.x, epsilon) && almostEqual(a.y, b.y, epsilon);
}

function pushUniquePoint(points: EpurePoint[], point: EpurePoint, epsilon: number): void {
	if (points.length === 0 || !pointsEqual(points[points.length - 1], point, epsilon)) {
		points.push(point);
	}
}

function sanitizeSamples(samples: EpureSample[], epsilon: number): NormalizedEpureSample[] {
	const normalized = samples
		.filter(
			(sample) =>
				isFiniteNumber(sample.x) &&
				isFiniteNumber(sample.value) &&
				(sample.displayValue === undefined || isFiniteNumber(sample.displayValue))
		)
		.map((sample) => ({
			x: sample.x,
			value: sample.value,
			displayValue: sample.displayValue ?? sample.value
		}))
		.sort((a, b) => a.x - b.x);

	const deduped: NormalizedEpureSample[] = [];
	for (const sample of normalized) {
		if (
			deduped.length > 0 &&
			almostEqual(deduped[deduped.length - 1].x, sample.x, epsilon) &&
			almostEqual(deduped[deduped.length - 1].value, sample.value, epsilon) &&
			almostEqual(deduped[deduped.length - 1].displayValue, sample.displayValue, epsilon)
		) {
			continue;
		}
		deduped.push(sample);
	}
	return deduped;
}

function insertZeroCrossings(
	samples: NormalizedEpureSample[],
	epsilon: number
): NormalizedEpureSample[] {
	if (samples.length < 2) return samples.slice();

	const withZeroes: NormalizedEpureSample[] = [];
	for (let index = 0; index < samples.length; index += 1) {
		const current = samples[index];
		if (
			withZeroes.length === 0 ||
			!almostEqual(withZeroes[withZeroes.length - 1].x, current.x, epsilon) ||
			!almostEqual(withZeroes[withZeroes.length - 1].value, current.value, epsilon)
		) {
			withZeroes.push(current);
		}
		if (index === samples.length - 1) continue;

		const next = samples[index + 1];
		const currentSign = signOf(current.value, epsilon);
		const nextSign = signOf(next.value, epsilon);
		if (currentSign === 0 || nextSign === 0 || currentSign === nextSign) continue;

		const t = current.value / (current.value - next.value);
		const zeroPoint: NormalizedEpureSample = {
			x: current.x + (next.x - current.x) * t,
			value: 0,
			displayValue: current.displayValue + (next.displayValue - current.displayValue) * t
		};
		zeroPoint.displayValue = 0;

		if (
			!almostEqual(withZeroes[withZeroes.length - 1].x, zeroPoint.x, epsilon) ||
			!almostEqual(withZeroes[withZeroes.length - 1].value, zeroPoint.value, epsilon)
		) {
			withZeroes.push(zeroPoint);
		}
	}
	return withZeroes;
}

function closedPolygon(points: EpurePoint[]): EpurePoint[] {
	if (points.length === 0) return [];
	const last = points[points.length - 1];
	if (pointsEqual(points[0], last, DEFAULT_ZERO_EPSILON)) return points.slice();
	return [...points, points[0]];
}

function polygonAreaAndCentroid(points: EpurePoint[]): {
	area: number;
	centroid: EpurePoint;
} {
	const polygon = closedPolygon(points);
	if (polygon.length < 4) {
		const xs = points.map((point) => point.x);
		const ys = points.map((point) => point.y);
		return {
			area: 0,
			centroid: {
				x: xs.reduce((sum, value) => sum + value, 0) / Math.max(xs.length, 1),
				y: ys.reduce((sum, value) => sum + value, 0) / Math.max(ys.length, 1)
			}
		};
	}

	let signedArea = 0;
	let cx = 0;
	let cy = 0;
	for (let index = 0; index < polygon.length - 1; index += 1) {
		const a = polygon[index];
		const b = polygon[index + 1];
		const cross = a.x * b.y - b.x * a.y;
		signedArea += cross;
		cx += (a.x + b.x) * cross;
		cy += (a.y + b.y) * cross;
	}

	signedArea /= 2;
	if (Math.abs(signedArea) <= DEFAULT_ZERO_EPSILON) {
		const xs = points.map((point) => point.x);
		const ys = points.map((point) => point.y);
		return {
			area: 0,
			centroid: {
				x: xs.reduce((sum, value) => sum + value, 0) / Math.max(xs.length, 1),
				y: ys.reduce((sum, value) => sum + value, 0) / Math.max(ys.length, 1)
			}
		};
	}

	return {
		area: Math.abs(signedArea),
		centroid: {
			x: cx / (6 * signedArea),
			y: cy / (6 * signedArea)
		}
	};
}

function lineIntersection(
	a: EpurePoint,
	b: EpurePoint,
	offset: number,
	normal: EpurePoint,
	epsilon: number
): EpurePoint | null {
	const fa = a.x * normal.x + a.y * normal.y - offset;
	const fb = b.x * normal.x + b.y * normal.y - offset;

	if (Math.abs(fa) <= epsilon && Math.abs(fb) <= epsilon) return null;
	if (fa * fb > 0 && Math.abs(fa) > epsilon && Math.abs(fb) > epsilon) return null;

	const denominator = fa - fb;
	if (Math.abs(denominator) <= epsilon) return null;
	const t = fa / denominator;
	if (t < -epsilon || t > 1 + epsilon) return null;

	return {
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t
	};
}

function dedupeIntersections(points: EpurePoint[], epsilon: number): EpurePoint[] {
	const deduped: EpurePoint[] = [];
	for (const point of points) {
		if (deduped.some((existing) => pointsEqual(existing, point, epsilon))) continue;
		deduped.push(point);
	}
	return deduped;
}

function buildHatchSegments(
	polygon: EpurePoint[],
	xSpan: number,
	ySpan: number,
	options: BuildEpureLayoutOptions,
	epsilon: number
): EpureSegment[] {
	if (polygon.length < 3) return [];

	// Default hatch direction is local +Y, i.e. perpendicular to the beam axis (+X).
	const hatchAngleDeg = options.hatchAngleDeg ?? 90;
	const angle = (hatchAngleDeg * Math.PI) / 180;
	const direction = { x: Math.cos(angle), y: Math.sin(angle) };
	const normal = { x: -direction.y, y: direction.x };
	const spacing =
		options.hatchSpacing ??
		Math.max(Math.min(xSpan / 10, Math.max(ySpan / 3, epsilon * 100)), Math.min(xSpan, ySpan) / 14);

	const projections = polygon.map((point) => point.x * normal.x + point.y * normal.y);
	const minProjection = Math.min(...projections);
	const maxProjection = Math.max(...projections);
	const closed = closedPolygon(polygon);
	const segments: EpureSegment[] = [];

	for (let offset = minProjection - spacing; offset <= maxProjection + spacing; offset += spacing) {
		const intersections: EpurePoint[] = [];
		for (let index = 0; index < closed.length - 1; index += 1) {
			const intersection = lineIntersection(closed[index], closed[index + 1], offset, normal, epsilon);
			if (intersection) intersections.push(intersection);
		}

		const clipped = dedupeIntersections(intersections, epsilon).sort(
			(a, b) => a.x * direction.x + a.y * direction.y - (b.x * direction.x + b.y * direction.y)
		);
		for (let index = 0; index + 1 < clipped.length; index += 2) {
			segments.push({ start: clipped[index], end: clipped[index + 1] });
		}
	}

	return segments;
}

function buildRegions(
	samples: NormalizedEpureSample[],
	xSpan: number,
	ySpan: number,
	options: BuildEpureLayoutOptions,
	epsilon: number
): EpureRegion[] {
	const regions: EpureRegion[] = [];
	let sign: 1 | -1 | null = null;
	let trace: EpurePoint[] = [];

	const finalizeRegion = () => {
		if (sign === null || trace.length < 3) {
			sign = null;
			trace = [];
			return;
		}

		const polygon = trace.slice();
		const xs = polygon.map((point) => point.x);
		const ys = polygon.map((point) => Math.abs(point.y));
		const width = Math.max(...xs) - Math.min(...xs);
		const height = Math.max(...ys, 0);
		const { area, centroid } = polygonAreaAndCentroid(polygon);
		const minArea = xSpan * ySpan * (options.minSignAreaRatio ?? 0.015);
		const minWidth = xSpan * (options.minSignWidthRatio ?? 0.06);
		const minHeight = ySpan * (options.minSignHeightRatio ?? 0.12);

		regions.push({
			sign,
			area,
			width,
			height,
			polygon,
			centroid,
			hatchSegments: buildHatchSegments(polygon, xSpan, ySpan, options, epsilon),
			showSign: area >= minArea && width >= minWidth && height >= minHeight
		});

		sign = null;
		trace = [];
	};

	for (let index = 0; index < samples.length - 1; index += 1) {
		const current = samples[index];
		const next = samples[index + 1];
		const currentSign = signOf(current.value, epsilon);
		const nextSign = signOf(next.value, epsilon);
		const segmentSign = currentSign !== 0 ? currentSign : nextSign;
		if (segmentSign === 0) continue;

		if (sign === null) {
			sign = segmentSign;
			trace = [{ x: current.x, y: 0 }];
		}
		if (sign !== segmentSign) {
			pushUniquePoint(trace, { x: current.x, y: 0 }, epsilon);
			finalizeRegion();
			sign = segmentSign;
			trace = [{ x: current.x, y: 0 }];
		}

		if (currentSign !== 0) {
			pushUniquePoint(trace, { x: current.x, y: current.displayValue }, epsilon);
		}

		if (nextSign !== 0) {
			pushUniquePoint(trace, { x: next.x, y: next.displayValue }, epsilon);
		}

		if (nextSign === 0) {
			pushUniquePoint(trace, { x: next.x, y: 0 }, epsilon);
			finalizeRegion();
		}
	}

	if (sign !== null && trace.length > 0) {
		const last = trace[trace.length - 1];
		pushUniquePoint(trace, { x: last.x, y: 0 }, epsilon);
		finalizeRegion();
	}

	return regions;
}

export function buildEpureLayout(
	samples: EpureSample[],
	options: BuildEpureLayoutOptions = {}
): EpureLayout {
	const epsilon = options.zeroEpsilon ?? DEFAULT_ZERO_EPSILON;
	const sanitized = sanitizeSamples(samples, epsilon);
	if (sanitized.length < 2) {
		return {
			curvePoints: [],
			regions: [],
			xMin: 0,
			xMax: 0,
			yAbsMax: 0
		};
	}

	const normalized = insertZeroCrossings(sanitized, epsilon);
	const curvePoints = normalized.map((sample) => ({ x: sample.x, y: sample.displayValue }));
	const xMin = Math.min(...curvePoints.map((point) => point.x));
	const xMax = Math.max(...curvePoints.map((point) => point.x));
	const yAbsMax = Math.max(...curvePoints.map((point) => Math.abs(point.y)), epsilon);
	const xSpan = Math.max(xMax - xMin, epsilon * 100);
	const ySpan = Math.max(yAbsMax, epsilon * 100);

	return {
		curvePoints,
		regions: buildRegions(normalized, xSpan, ySpan, options, epsilon),
		xMin,
		xMax,
		yAbsMax
	};
}

export function transformEpurePoint(point: EpurePoint, basis: EpureTransform): EpurePoint {
	return {
		x: basis.origin.x + basis.tangent.x * point.x + basis.normal.x * point.y,
		y: basis.origin.y + basis.tangent.y * point.x + basis.normal.y * point.y
	};
}

export function transformEpureSegment(segment: EpureSegment, basis: EpureTransform): EpureSegment {
	return {
		start: transformEpurePoint(segment.start, basis),
		end: transformEpurePoint(segment.end, basis)
	};
}
