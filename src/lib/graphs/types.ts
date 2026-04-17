export interface GraphPoint {
	x: number;
	y: number;
}

export type GraphType = 'function' | 'diagram';
export type GraphEpureKind = 'N' | 'Q' | 'M' | 'custom';
export type GraphCompressedFiberSide = '+n' | '-n';
export type GraphFrameComponent = 'N' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz';
export type GraphAxisOrigin =
	| 'auto'
	| 'free_end'
	| 'fixed_end'
	| 'member_start'
	| 'member_end';

export interface GraphEpureMeta {
	kind?: GraphEpureKind;
	component?: GraphFrameComponent;
	fillHatch?: boolean;
	showSigns?: boolean;
	compressedFiberSide?: GraphCompressedFiberSide;
	axisOrigin?: GraphAxisOrigin;
}

export interface GraphData {
	title?: string;
	type?: GraphType;
	memberId?: string;
	diagramType?: string;
	epure?: GraphEpureMeta;
	points: GraphPoint[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEpureKind(value: unknown): GraphEpureKind | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toUpperCase();
	if (normalized === 'N' || normalized === 'Q' || normalized === 'M') return normalized;
	if (normalized === 'CUSTOM') return 'custom';
	return undefined;
}

function normalizeCompressedFiberSide(value: unknown): GraphCompressedFiberSide | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === '+n' || normalized === '-n') return normalized;
	return undefined;
}

function normalizeAxisOrigin(value: unknown): GraphAxisOrigin | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === 'auto' ||
		normalized === 'free_end' ||
		normalized === 'fixed_end' ||
		normalized === 'member_start' ||
		normalized === 'member_end'
	) {
		return normalized;
	}
	return undefined;
}

function normalizeFrameComponent(value: unknown): GraphFrameComponent | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'n') return 'N';
	if (normalized === 'vy') return 'Vy';
	if (normalized === 'vz') return 'Vz';
	if (normalized === 't') return 'T';
	if (normalized === 'my') return 'My';
	if (normalized === 'mz') return 'Mz';
	return undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function reverseGraphPointsToFreeEnd(points: GraphPoint[]): GraphPoint[] {
	if (points.length === 0) return [];
	const xMax = Math.max(...points.map((point) => point.x));
	return points
		.map((point) => ({
			x: xMax - point.x,
			y: point.y
		}))
		.sort((a, b) => a.x - b.x);
}

function extractMemberCore(rawMemberId: string): string {
	const trimmed = rawMemberId.trim();
	if (!trimmed) return '';
	const withoutPrefix = trimmed.replace(/^\s*(member|bar|beam|rod|стержень)\s*[:_-]?\s*/iu, '');
	const normalized = withoutPrefix.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	return normalized || trimmed;
}

function extractMemberIdFromTitle(title: string): string | null {
	const trimmed = title.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/^\s*(member|bar|beam|rod|стержень)\s*[:_-]?\s*(.+)\s*$/iu);
	if (!match?.[2]) return null;
	return match[2].trim() || null;
}

export function formatGraphMemberLabel(memberId?: string | null): string | null {
	if (typeof memberId !== 'string' || !memberId.trim()) return null;
	return `Стержень ${extractMemberCore(memberId)}`;
}

export function formatGraphDisplayTitle(graph: GraphData, fallback = 'Solution graph'): string {
	const memberLabel = formatGraphMemberLabel(graph.memberId);
	const rawTitle = typeof graph.title === 'string' ? graph.title.trim() : '';
	if (rawTitle) {
		const titleMemberId = extractMemberIdFromTitle(rawTitle);
		if (titleMemberId) {
			const localizedTitle = formatGraphMemberLabel(titleMemberId);
			if (graph.diagramType && localizedTitle) return `${graph.diagramType} - ${localizedTitle}`;
			return localizedTitle ?? rawTitle;
		}
		if (memberLabel && typeof graph.memberId === 'string' && rawTitle === graph.memberId.trim()) {
			return graph.diagramType ? `${graph.diagramType} - ${memberLabel}` : memberLabel;
		}
		return rawTitle;
	}
	if (graph.diagramType && memberLabel) return `${graph.diagramType} - ${memberLabel}`;
	if (memberLabel) return memberLabel;
	return fallback;
}

export function normalizeGraphEpure(graph: GraphData): {
	graph: GraphData;
	warnings: string[];
} {
	const rawEpure = isRecord(graph.epure) ? graph.epure : null;
	const kind =
		normalizeEpureKind(rawEpure?.kind) ??
		normalizeEpureKind(graph.diagramType) ??
		undefined;
	const normalizedType: GraphType =
		graph.type === 'diagram' || kind || rawEpure !== null ? 'diagram' : (graph.type ?? 'function');

	if (normalizedType !== 'diagram') {
		return {
			graph: {
				...graph,
				type: normalizedType
			},
			warnings: []
		};
	}

	const warnings: string[] = [];
	const fillHatch = normalizeBoolean(rawEpure?.fillHatch) ?? true;
	const showSigns = normalizeBoolean(rawEpure?.showSigns) ?? true;
	const compressedFiberSide = normalizeCompressedFiberSide(rawEpure?.compressedFiberSide);
	const axisOrigin = normalizeAxisOrigin(rawEpure?.axisOrigin);
	const component = normalizeFrameComponent(rawEpure?.component);
	const hasExplicitEpure = rawEpure !== null || typeof graph.diagramType === 'string';
	const canonicalAxisOrigin =
		axisOrigin === 'fixed_end' ? 'free_end'
			: axisOrigin === 'member_end' ? 'member_start'
			: axisOrigin;
	let points = graph.points;

	if (kind === 'M' && !compressedFiberSide && hasExplicitEpure) {
		warnings.push('Moment epure is missing epure.compressedFiberSide; legacy display fallback will be used.');
	}
	if (rawEpure?.axisOrigin !== undefined && !axisOrigin) {
		warnings.push('Graph epure.axisOrigin was invalid and ignored.');
	}
	if (axisOrigin === 'fixed_end') {
		points = reverseGraphPointsToFreeEnd(graph.points);
		warnings.push('Graph epure axis was canonicalized from fixed_end to free_end.');
	}
	if (axisOrigin === 'member_end') {
		points = reverseGraphPointsToFreeEnd(graph.points);
		warnings.push('Graph epure axis was canonicalized from member_end to member_start.');
	}

	return {
		graph: {
			...graph,
			type: normalizedType,
			diagramType: graph.diagramType ?? component ?? kind,
			epure: {
				...(kind ? { kind } : {}),
				...(component ? { component } : {}),
				fillHatch,
				showSigns,
				...(compressedFiberSide ? { compressedFiberSide } : {}),
				...(canonicalAxisOrigin ? { axisOrigin: canonicalAxisOrigin } : {})
			},
			points
		},
		warnings
	};
}

export function getEpureDisplayFactor(epure?: GraphEpureMeta): number {
	if (epure?.kind !== 'M') return 1;
	if (epure.compressedFiberSide === '-n') return -1;
	return 1;
}
