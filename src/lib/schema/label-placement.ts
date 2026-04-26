export interface LabelPoint {
	x: number;
	y: number;
}

export interface LabelBox {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export interface LabelPlacement {
	point: LabelPoint;
	box: LabelBox;
	offset: LabelPoint;
}

export interface LabelPlacementOptions {
	anchor: LabelPoint;
	text: string;
	occupiedBoxes: LabelBox[];
	boardBox?: LabelBox;
	fontSize?: number;
	anchorX?: string;
	preferredOffset?: LabelPoint;
	padding?: number;
}

const DEFAULT_OFFSETS: LabelPoint[] = [
	{ x: 0, y: 0 },
	{ x: 0.12, y: 0.12 },
	{ x: 0.22, y: 0.28 },
	{ x: 0.22, y: -0.28 },
	{ x: -0.22, y: 0.28 },
	{ x: -0.22, y: -0.28 },
	{ x: 0, y: 0.42 },
	{ x: 0, y: -0.42 },
	{ x: 0.48, y: 0 },
	{ x: -0.48, y: 0 },
	{ x: 0.58, y: 0.34 },
	{ x: -0.58, y: 0.34 },
	{ x: 0.58, y: -0.34 },
	{ x: -0.58, y: -0.34 }
];

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function boxWidth(box: LabelBox): number {
	return box.maxX - box.minX;
}

function boxHeight(box: LabelBox): number {
	return box.maxY - box.minY;
}

function moveBox(box: LabelBox, dx: number, dy: number): LabelBox {
	return {
		minX: box.minX + dx,
		maxX: box.maxX + dx,
		minY: box.minY + dy,
		maxY: box.maxY + dy
	};
}

function expandBox(box: LabelBox, padding: number): LabelBox {
	return {
		minX: box.minX - padding,
		maxX: box.maxX + padding,
		minY: box.minY - padding,
		maxY: box.maxY + padding
	};
}

function overlapArea(a: LabelBox, b: LabelBox): number {
	const width = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
	const height = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
	return width * height;
}

function outsideArea(box: LabelBox, boardBox?: LabelBox): number {
	if (!boardBox) return 0;
	const width = boxWidth(box);
	const height = boxHeight(box);
	const clippedWidth = Math.max(0, Math.min(box.maxX, boardBox.maxX) - Math.max(box.minX, boardBox.minX));
	const clippedHeight = Math.max(0, Math.min(box.maxY, boardBox.maxY) - Math.max(box.minY, boardBox.minY));
	return width * height - clippedWidth * clippedHeight;
}

function fitBoxInsideBoard(point: LabelPoint, box: LabelBox, boardBox?: LabelBox): { point: LabelPoint; box: LabelBox } {
	if (!boardBox) return { point, box };
	if (boxWidth(box) > boxWidth(boardBox) || boxHeight(box) > boxHeight(boardBox)) {
		return { point, box };
	}

	let dx = 0;
	let dy = 0;
	if (box.minX < boardBox.minX) dx = boardBox.minX - box.minX;
	if (box.maxX + dx > boardBox.maxX) dx = boardBox.maxX - box.maxX;
	if (box.minY < boardBox.minY) dy = boardBox.minY - box.minY;
	if (box.maxY + dy > boardBox.maxY) dy = boardBox.maxY - box.maxY;

	return {
		point: { x: point.x + dx, y: point.y + dy },
		box: moveBox(box, dx, dy)
	};
}

function candidateOffsets(preferredOffset?: LabelPoint): LabelPoint[] {
	if (!preferredOffset) return DEFAULT_OFFSETS;
	const key = `${preferredOffset.x}:${preferredOffset.y}`;
	return [
		preferredOffset,
		...DEFAULT_OFFSETS.filter((offset) => `${offset.x}:${offset.y}` !== key)
	];
}

export function estimateLabelBox(
	point: LabelPoint,
	text: string,
	options: { fontSize?: number; anchorX?: string } = {}
): LabelBox {
	const fontScale = Math.max(0.75, Math.min(2, (options.fontSize ?? 12) / 12));
	const compactText = text.trim() || ' ';
	const width = Math.max(0.28, compactText.length * 0.075 * fontScale);
	const height = 0.24 * fontScale;
	const anchorX = typeof options.anchorX === 'string' ? options.anchorX : 'left';
	let minX = point.x;
	if (anchorX === 'middle' || anchorX === 'center') minX = point.x - width / 2;
	if (anchorX === 'right') minX = point.x - width;
	return {
		minX,
		maxX: minX + width,
		minY: point.y - height / 2,
		maxY: point.y + height / 2
	};
}

export function chooseLabelPlacement(options: LabelPlacementOptions): LabelPlacement {
	const padding = options.padding ?? 0.06;
	let best: LabelPlacement | null = null;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const offset of candidateOffsets(options.preferredOffset)) {
		const rawPoint = {
			x: options.anchor.x + offset.x,
			y: options.anchor.y + offset.y
		};
		const rawBox = estimateLabelBox(rawPoint, options.text, {
			fontSize: options.fontSize,
			anchorX: options.anchorX
		});
		const fitted = fitBoxInsideBoard(rawPoint, rawBox, options.boardBox);
		const paddedBox = expandBox(fitted.box, padding);
		const overlap = options.occupiedBoxes.reduce(
			(total, occupied) => total + overlapArea(paddedBox, expandBox(occupied, padding)),
			0
		);
		const outside = outsideArea(fitted.box, options.boardBox);
		const distance = Math.hypot(fitted.point.x - options.anchor.x, fitted.point.y - options.anchor.y);
		const score = overlap * 100 + outside * 1000 + distance * 0.01;
		const placement = {
			point: fitted.point,
			box: fitted.box,
			offset: {
				x: fitted.point.x - options.anchor.x,
				y: fitted.point.y - options.anchor.y
			}
		};
		if (overlap <= 0 && outside <= 0) return placement;
		if (score < bestScore) {
			best = placement;
			bestScore = score;
		}
	}

	return best ?? {
		point: options.anchor,
		box: estimateLabelBox(options.anchor, options.text, {
			fontSize: options.fontSize,
			anchorX: options.anchorX
		}),
		offset: { x: 0, y: 0 }
	};
}

export function clampLabelAnchorToBox(point: LabelPoint, boardBox: LabelBox, margin = 0): LabelPoint {
	return {
		x: clamp(point.x, boardBox.minX + margin, boardBox.maxX - margin),
		y: clamp(point.y, boardBox.minY + margin, boardBox.maxY - margin)
	};
}
