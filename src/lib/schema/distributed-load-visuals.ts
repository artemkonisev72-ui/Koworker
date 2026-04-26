export interface DistributedLoadVisualMetrics {
	arrowCount: number;
	arrowLength: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function finitePositive(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function resolveDistributedLoadVisualMetrics(
	span: number,
	explicitArrowCount?: unknown
): DistributedLoadVisualMetrics {
	const readableSpan = finitePositive(span) ?? 1;
	const requestedCount = finitePositive(explicitArrowCount);
	const arrowCount =
		requestedCount !== null
			? Math.round(clamp(requestedCount, 3, 16))
			: Math.round(clamp(readableSpan / 0.7 + 1, 3, 12));
	const arrowLength = clamp(readableSpan * 0.14, 0.25, 0.75);
	return { arrowCount, arrowLength };
}
