export interface GraphPoint {
	x: number;
	y: number;
}

export type GraphType = 'function' | 'diagram';
export type GraphEpureKind = 'N' | 'Q' | 'M' | 'custom';
export type GraphCompressedFiberSide = '+n' | '-n';

export interface GraphEpureMeta {
	kind?: GraphEpureKind;
	fillHatch?: boolean;
	showSigns?: boolean;
	compressedFiberSide?: GraphCompressedFiberSide;
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

function normalizeBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
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
	const hasExplicitEpure = rawEpure !== null || typeof graph.diagramType === 'string';

	if (kind === 'M' && !compressedFiberSide && hasExplicitEpure) {
		warnings.push('Moment epure is missing epure.compressedFiberSide; legacy display fallback will be used.');
	}

	return {
		graph: {
			...graph,
			type: normalizedType,
			diagramType: kind ?? graph.diagramType,
			epure: {
				...(kind ? { kind } : {}),
				fillHatch,
				showSigns,
				...(compressedFiberSide ? { compressedFiberSide } : {})
			}
		},
		warnings
	};
}

export function getEpureDisplayFactor(epure?: GraphEpureMeta): number {
	if (epure?.kind !== 'M') return 1;
	if (epure.compressedFiberSide === '-n') return -1;
	return 1;
}
