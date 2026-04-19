/**
 * pipeline.ts
 * Стейт-машина пайплайна решения задачи.
 *
 * Архитектура (строго по спецификации):
 *   Complexity → Router (Flash) → CodeGen (Pro) → Sandbox (Pyodide) → [Retry ≤2] → Assembler (Flash)
 *
 * Модель выбирается автоматически на основе оценки сложности (1-4 tier).
 * При недоступности модели — автоматический откат на модель ниже.
 */
import {
	routeQuestion,
	generatePythonCode,
	assembleFinalAnswer,
	answerGeneralQuestion,
	analyzeImage,
	type GeminiHistory
} from './gemini.js';
import { workerPool, SandboxError } from '../sandbox/worker-pool.js';
import { validateSchemaAny, type SchemaAny, type SchemaVersionTag } from '$lib/schema/schema-any.js';
import { applySchemaPatchToApprovedSchema, extractSchemaPatchFromOutput } from './schema-patch.js';
import {
	normalizeGraphEpure,
	type GraphData,
	type GraphPoint
} from '$lib/graphs/types.js';
import type { SolverModelV1 } from '$lib/solver/model.js';

export type PipelineStatus =
	| { type: 'ping' }
	| { type: 'ack'; userMessageId: string }
	| { type: 'status'; message: string }
	| {
			type: 'result';
			messageId?: string;
			content: string;
			generatedCode?: string;
			executionLogs?: string;
			graphData?: GraphData[];
			schemaData?: SchemaAny;
			schemaDescription?: string;
			schemaVersion?: SchemaVersionTag;
			usedModels?: string[];
	  }
	| { type: 'error'; message: string };

interface SandboxOutput {
	result?: unknown;
	graph_points?: GraphPoint[]; // Для обратной совместимости
	graphs?: GraphData[];        // Массив нескольких графиков
	schemaData?: unknown;
	schemaPatch?: unknown;
	schemaVersion?: unknown;
	[key: string]: unknown;
}

interface GraphNormalizationResult {
	graphs: GraphData[];
	issues: string[];
	warnings: string[];
}

interface SchemaNormalizationResult {
	schemaData?: SchemaAny;
	schemaVersion?: SchemaVersionTag;
	issues: string[];
}

const MAX_RETRIES = 2;
const APPROVED_SCHEME_DESCRIPTION_MARKER = '\n\n[APPROVED_SCHEME_DESCRIPTION]\n';
const APPROVED_SCHEMA_MARKER = '\n\n[APPROVED_SCHEMA_JSON]\n';
const SOLVER_MODEL_MARKER = '\n\n[SOLVER_MODEL_JSON]\n';

type FinalizerPayloadMode = 'normal' | 'compact' | 'minimal';

const FINALIZER_HISTORY_LIMIT = readIntEnv('FINALIZER_HISTORY_LIMIT', 2, 0, 6);
const FINALIZER_HISTORY_ENTRY_MAX_CHARS = readIntEnv('FINALIZER_HISTORY_ENTRY_MAX_CHARS', 1200, 200, 6000);
const FINALIZER_TASK_MAX_CHARS = readIntEnv('FINALIZER_TASK_MAX_CHARS', 3000, 400, 20000);
const FINALIZER_MAX_INPUT_CHARS = readIntEnv('FINALIZER_MAX_INPUT_CHARS', 12000, 2000, 120000);

const FINALIZER_PAYLOAD_CONFIG: Record<
	FinalizerPayloadMode,
	{
		maxGraphSamples: number;
		includeGraphSamples: boolean;
		includeExtras: boolean;
		maxDepth: number;
		maxArray: number;
		maxObjectKeys: number;
		maxString: number;
		stdoutChars: number;
	}
> = {
	normal: {
		maxGraphSamples: 12,
		includeGraphSamples: true,
		includeExtras: true,
		maxDepth: 4,
		maxArray: 24,
		maxObjectKeys: 24,
		maxString: 1200,
		stdoutChars: 2000
	},
	compact: {
		maxGraphSamples: 6,
		includeGraphSamples: true,
		includeExtras: false,
		maxDepth: 3,
		maxArray: 12,
		maxObjectKeys: 12,
		maxString: 700,
		stdoutChars: 1000
	},
	minimal: {
		maxGraphSamples: 0,
		includeGraphSamples: false,
		includeExtras: false,
		maxDepth: 2,
		maxArray: 8,
		maxObjectKeys: 8,
		maxString: 320,
		stdoutChars: 600
	}
};

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
	const raw = Number(process.env[name]);
	if (!Number.isFinite(raw)) return fallback;
	const rounded = Math.floor(raw);
	return Math.max(min, Math.min(max, rounded));
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeGraphType(value: unknown): 'function' | 'diagram' {
	if (typeof value !== 'string') return 'function';
	const normalized = value.trim().toLowerCase();
	if (normalized === 'diagram' || normalized === 'epure' || normalized === 'moment' || normalized === 'shear') {
		return 'diagram';
	}
	return 'function';
}

function looksLikeDiagramTitle(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return false;
	return (
		normalized.includes('epure') ||
		normalized.includes('эпюр') ||
		normalized.includes('m(x)') ||
		normalized.includes('q(x)') ||
		normalized.includes('n(x)') ||
		normalized.includes('shear') ||
		normalized.includes('moment') ||
		normalized.includes('axial')
	);
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeMemberId(raw: Record<string, unknown>): string | null {
	const meta = isRecord(raw.meta) ? raw.meta : null;
	const candidates = [
		raw.memberId,
		raw.member,
		raw.member_id,
		raw.barId,
		raw.bar_id,
		raw.elementId,
		raw.element_id,
		raw.rodId,
		raw.rod_id,
		meta?.memberId,
		meta?.member
	];
	for (const candidate of candidates) {
		const normalized = normalizeString(candidate);
		if (normalized) return normalized;
	}
	return null;
}

function normalizeDiagramType(raw: Record<string, unknown>): string | null {
	const candidates = [raw.diagramType, raw.diagram_type, raw.kind, raw.epureType, raw.resultType];
	for (const candidate of candidates) {
		const normalized = normalizeString(candidate);
		if (normalized) return normalized;
	}
	return null;
}

function extractPointMemberId(point: unknown): string | null {
	if (!isRecord(point)) return null;
	return normalizeString(point.memberId ?? point.member ?? point.member_id ?? point.barId ?? point.elementId);
}

function normalizeGraphPoints(pointsRaw: unknown): GraphPoint[] {
	if (!Array.isArray(pointsRaw)) return [];
	const points: GraphPoint[] = [];
	for (const entry of pointsRaw) {
		if (isRecord(entry) && typeof entry.x === 'number' && Number.isFinite(entry.x) && typeof entry.y === 'number' && Number.isFinite(entry.y)) {
			points.push({ x: entry.x, y: entry.y });
			continue;
		}
		if (Array.isArray(entry) && entry.length >= 2) {
			const x = Number(entry[0]);
			const y = Number(entry[1]);
			if (Number.isFinite(x) && Number.isFinite(y)) {
				points.push({ x, y });
			}
		}
	}
	return points;
}

function normalizeGraphTitle(raw: Record<string, unknown>, fallback: string): string {
	const title = normalizeString(raw.title) ?? normalizeString(raw.name) ?? normalizeString(raw.label);
	return title ?? fallback;
}

function normalizeGraphEpureMeta(raw: unknown): GraphData['epure'] | undefined {
	if (!isRecord(raw)) return undefined;

	const epure = {
		...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
		...(typeof raw.component === 'string' ? { component: raw.component } : {}),
		...(typeof raw.fillHatch === 'boolean' ? { fillHatch: raw.fillHatch } : {}),
		...(typeof raw.showSigns === 'boolean' ? { showSigns: raw.showSigns } : {}),
		...(typeof raw.axisOrigin === 'string' ? { axisOrigin: raw.axisOrigin } : {}),
		...(typeof raw.compressedFiberSide === 'string'
			? { compressedFiberSide: raw.compressedFiberSide }
			: {})
	};

	return Object.keys(epure).length > 0 ? (epure as GraphData['epure']) : undefined;
}

function normalizeAndValidateGraphs(output: SandboxOutput | null): GraphNormalizationResult {
	if (!output) return { graphs: [], issues: [], warnings: [] };

	const rawGraphs: unknown[] = Array.isArray(output.graphs)
		? (output.graphs as unknown[])
		: Array.isArray(output.graph_points)
			? [{ title: 'График решения', type: 'function', points: output.graph_points }]
			: [];
	if (rawGraphs.length === 0) return { graphs: [], issues: [], warnings: [] };

	const normalizedGraphs: GraphData[] = [];
	const issues: string[] = [];
	const warnings: string[] = [];

	for (let index = 0; index < rawGraphs.length; index++) {
		const rawGraph = rawGraphs[index];
		if (!isRecord(rawGraph)) {
			issues.push(`graphs[${index}] must be an object`);
			continue;
		}

		const diagramType = normalizeDiagramType(rawGraph) ?? undefined;
		const epureMeta = normalizeGraphEpureMeta(rawGraph.epure);
		let type = normalizeGraphType(rawGraph.type ?? rawGraph.graphType ?? rawGraph.kind);
		if (
			type === 'function' &&
			(diagramType || epureMeta || looksLikeDiagramTitle(rawGraph.title ?? rawGraph.name ?? rawGraph.label))
		) {
			type = 'diagram';
		}
		const points = normalizeGraphPoints(rawGraph.points ?? rawGraph.data ?? rawGraph.values);
		if (points.length < 2) {
			issues.push(`graphs[${index}] must contain at least 2 points`);
			continue;
		}

		const pointMemberIds = Array.isArray(rawGraph.points)
			? Array.from(new Set(rawGraph.points.map(extractPointMemberId).filter((item): item is string => Boolean(item))))
			: [];
		const declaredMemberIds = Array.isArray(rawGraph.memberIds)
			? Array.from(new Set(rawGraph.memberIds.map(normalizeString).filter((item): item is string => Boolean(item))))
			: [];

		let memberId = normalizeMemberId(rawGraph);
		if (!memberId && pointMemberIds.length === 1) memberId = pointMemberIds[0];
		if (!memberId && declaredMemberIds.length === 1) memberId = declaredMemberIds[0];

		if (pointMemberIds.length > 1) {
			issues.push(`graphs[${index}] mixes multiple members in points: ${pointMemberIds.join(', ')}`);
		}
		if (declaredMemberIds.length > 1) {
			issues.push(`graphs[${index}] declares multiple memberIds: ${declaredMemberIds.join(', ')}`);
		}
		if (type === 'diagram' && !memberId) {
			issues.push(`graphs[${index}] type "diagram" requires memberId (one graph per member)`);
		}
		if (memberId && /[,+;|]/.test(memberId)) {
			issues.push(`graphs[${index}] memberId looks composite ("${memberId}"); use one member per graph`);
		}

		const epureNormalized = normalizeGraphEpure({
			title: normalizeGraphTitle(rawGraph, `Graph ${index + 1}`),
			type,
			memberId: memberId ?? undefined,
			diagramType,
			epure: epureMeta,
			points
		});
		warnings.push(...epureNormalized.warnings.map((warning) => `graphs[${index}]: ${warning}`));
		normalizedGraphs.push(epureNormalized.graph);
	}

	return { graphs: normalizedGraphs, issues, warnings };
}

function extractSchemaCandidate(output: SandboxOutput | null): unknown {
	if (!output || !isRecord(output)) return null;
	return (
		output.schemaData ??
		output.schema ??
		output.scheme ??
		output.diagram ??
		output.jsxgraphSchema ??
		null
	);
}

function normalizeSchemaFromOutput(output: SandboxOutput | null): SchemaNormalizationResult {
	const candidate = extractSchemaCandidate(output);
	if (!candidate) return { issues: [] };

	const validation = validateSchemaAny(candidate);
	if (!validation.ok || !validation.value) {
		return { issues: validation.errors };
	}

	return {
		issues: [],
		schemaData: validation.value,
		schemaVersion: validation.version ?? '2.0'
	};
}

function normalizeSchemaForApprovedContext(
	output: SandboxOutput | null,
	approvedSchema: SchemaAny
): SchemaNormalizationResult {
	const patchExtraction = extractSchemaPatchFromOutput(output);
	if (patchExtraction.hasPatch) {
		if (!patchExtraction.patch || patchExtraction.issues.length > 0) {
			return {
				issues:
					patchExtraction.issues.length > 0
						? patchExtraction.issues
						: ['schemaPatch payload is missing']
			};
		}

		const patchApplied = applySchemaPatchToApprovedSchema(approvedSchema, patchExtraction.patch);
		if (!patchApplied.ok || !patchApplied.value) {
			return { issues: patchApplied.issues };
		}

		return {
			issues: [],
			schemaData: patchApplied.value,
			schemaVersion: patchApplied.version ?? '2.0'
		};
	}

	const candidate = extractSchemaCandidate(output);
	if (candidate) {
		return {
			issues: [
				'schema_check solve must return schemaPatch (delete+add) for schema visuals; full schemaData is not allowed'
			]
		};
	}

	return { issues: [] };
}

function summarizeSchemaCandidate(output: SandboxOutput | null): Record<string, unknown> | null {
	const candidate = extractSchemaCandidate(output);
	if (!isRecord(candidate)) return null;
	return {
		version: typeof candidate.version === 'string' ? candidate.version : undefined,
		nodes: Array.isArray(candidate.nodes) ? candidate.nodes.length : undefined,
		objects: Array.isArray(candidate.objects) ? candidate.objects.length : undefined,
		results: Array.isArray(candidate.results) ? candidate.results.length : undefined
	};
}

function summarizeSchemaPatch(output: SandboxOutput | null): Record<string, unknown> | null {
	if (!output || !isRecord(output)) return null;
	const candidate = output.schemaPatch ?? output.schema_patch;
	if (!isRecord(candidate)) return null;
	return {
		deleteObjectIds: Array.isArray(candidate.deleteObjectIds) ? candidate.deleteObjectIds.length : 0,
		deleteResultIds: Array.isArray(candidate.deleteResultIds) ? candidate.deleteResultIds.length : 0,
		addNodes: Array.isArray(candidate.addNodes) ? candidate.addNodes.length : 0,
		addObjects: Array.isArray(candidate.addObjects) ? candidate.addObjects.length : 0,
		addResults: Array.isArray(candidate.addResults) ? candidate.addResults.length : 0
	};
}

function isFiniteGraphPoint(value: unknown): value is GraphPoint {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const maybe = value as Record<string, unknown>;
	return (
		typeof maybe.x === 'number' &&
		Number.isFinite(maybe.x) &&
		typeof maybe.y === 'number' &&
		Number.isFinite(maybe.y)
	);
}

function sampleGraphPoints(points: GraphPoint[], maxSamples: number): GraphPoint[] {
	if (maxSamples <= 0) return [];
	if (points.length <= maxSamples) return points;
	if (maxSamples === 1) return [points[0]];

	const sampled: GraphPoint[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < maxSamples; i++) {
		const index = Math.round((i * (points.length - 1)) / (maxSamples - 1));
		const point = points[index];
		const key = `${point.x}:${point.y}`;
		if (seen.has(key)) continue;
		seen.add(key);
		sampled.push(point);
	}
	return sampled;
}

function summarizeGraph(pointsRaw: unknown, maxSamples: number, includeSamples: boolean): Record<string, unknown> {
	const points = Array.isArray(pointsRaw) ? pointsRaw.filter(isFiniteGraphPoint) : [];
	const summary: Record<string, unknown> = { pointCount: points.length };

	if (points.length > 0) {
		let xMin = points[0].x;
		let xMax = points[0].x;
		let yMin = points[0].y;
		let yMax = points[0].y;
		for (const point of points) {
			if (point.x < xMin) xMin = point.x;
			if (point.x > xMax) xMax = point.x;
			if (point.y < yMin) yMin = point.y;
			if (point.y > yMax) yMax = point.y;
		}
		summary.bounds = { xMin, xMax, yMin, yMax };
	}

	if (includeSamples && points.length > 0) {
		summary.samplePoints = sampleGraphPoints(points, maxSamples);
	}

	return summary;
}

function compactUnknownValue(
	value: unknown,
	cfg: {
		maxDepth: number;
		maxArray: number;
		maxObjectKeys: number;
		maxString: number;
	},
	depth = 0
): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'string') return truncateText(value, cfg.maxString);
	if (depth >= cfg.maxDepth) {
		if (Array.isArray(value)) return `[array(${value.length})]`;
		if (typeof value === 'object') return '[object]';
		return String(value);
	}
	if (Array.isArray(value)) {
		if (value.length <= cfg.maxArray) {
			return value.map((entry) => compactUnknownValue(entry, cfg, depth + 1));
		}
		return {
			length: value.length,
			sample: value.slice(0, cfg.maxArray).map((entry) => compactUnknownValue(entry, cfg, depth + 1))
		};
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		const compacted: Record<string, unknown> = {};
		for (const key of keys.slice(0, cfg.maxObjectKeys)) {
			compacted[key] = compactUnknownValue(record[key], cfg, depth + 1);
		}
		if (keys.length > cfg.maxObjectKeys) {
			compacted._truncatedKeys = keys.length - cfg.maxObjectKeys;
		}
		return compacted;
	}
	return String(value);
}

function sanitizeFinalizerTaskContext(rawUserMessage: string): string {
	const markerIndexes = [
		rawUserMessage.indexOf(APPROVED_SCHEME_DESCRIPTION_MARKER.trim()),
		rawUserMessage.indexOf('[ACCEPTED_SCHEMA_REVISIONS]'),
		rawUserMessage.indexOf(SOLVER_MODEL_MARKER.trim()),
		rawUserMessage.indexOf(APPROVED_SCHEMA_MARKER.trim())
	].filter((index) => index >= 0);

	const markerIndex = markerIndexes.length > 0 ? Math.min(...markerIndexes) : -1;
	const task = markerIndex >= 0 ? rawUserMessage.slice(0, markerIndex) : rawUserMessage;
	return task.trim();
}

function trimHistoryForFinalizer(history: GeminiHistory[]): GeminiHistory[] {
	if (FINALIZER_HISTORY_LIMIT <= 0) return [];
	return history
		.slice(-FINALIZER_HISTORY_LIMIT)
		.map((entry) => ({
			role: entry.role,
			content: truncateText(entry.content || '', FINALIZER_HISTORY_ENTRY_MAX_CHARS)
		}))
		.filter((entry) => entry.content.trim().length > 0);
}

function getHistoryChars(history: GeminiHistory[]): number {
	return history.reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0);
}

function estimateTokensByChars(chars: number): number {
	return Math.ceil(chars / 4);
}

function countGraphPoints(output: SandboxOutput | null): number {
	if (!output) return 0;
	let total = 0;
	if (Array.isArray(output.graph_points)) {
		total += output.graph_points.filter(isFiniteGraphPoint).length;
	}
	if (Array.isArray(output.graphs)) {
		for (const graph of output.graphs) {
			if (!graph || typeof graph !== 'object') continue;
			total += Array.isArray(graph.points) ? graph.points.filter(isFiniteGraphPoint).length : 0;
		}
	}
	return total;
}

function buildFinalizerExecutionPayload(
	output: SandboxOutput | null,
	rawStdout: string,
	mode: FinalizerPayloadMode
): Record<string, unknown> {
	const cfg = FINALIZER_PAYLOAD_CONFIG[mode];
	const payload: Record<string, unknown> = {};

	if (output) {
		if (output.result !== undefined) {
			payload.result = compactUnknownValue(output.result, cfg);
		}

		if (Array.isArray(output.graphs) && output.graphs.length > 0) {
			payload.graphs = output.graphs.map((graph, index) => {
				const summary = summarizeGraph(graph?.points, cfg.maxGraphSamples, cfg.includeGraphSamples);
				return {
					id: `graph_${index + 1}`,
					title: typeof graph?.title === 'string' ? graph.title : undefined,
					type: typeof graph?.type === 'string' ? graph.type : undefined,
					memberId: typeof graph?.memberId === 'string' ? graph.memberId : undefined,
					diagramType: typeof graph?.diagramType === 'string' ? graph.diagramType : undefined,
					...summary
				};
			});
		} else if (Array.isArray(output.graph_points) && output.graph_points.length > 0) {
			payload.graph_points_summary = summarizeGraph(
				output.graph_points,
				cfg.maxGraphSamples,
				cfg.includeGraphSamples
			);
		}

		const schemaSummary = summarizeSchemaCandidate(output);
		if (schemaSummary) {
			payload.schema = schemaSummary;
		}

		const schemaPatchSummary = summarizeSchemaPatch(output);
		if (schemaPatchSummary) {
			payload.schemaPatch = schemaPatchSummary;
		}

		if (cfg.includeExtras) {
			let extrasAdded = 0;
			for (const [key, value] of Object.entries(output)) {
				if (
					key === 'result' ||
					key === 'graphs' ||
					key === 'graph_points' ||
					key === 'schemaData' ||
					key === 'schema' ||
					key === 'scheme' ||
					key === 'diagram' ||
					key === 'jsxgraphSchema' ||
					key === 'schemaPatch' ||
					key === 'schema_patch' ||
					key === 'schemaVersion'
				) {
					continue;
				}
				payload[key] = compactUnknownValue(value, cfg);
				extrasAdded += 1;
				if (extrasAdded >= 6) break;
			}
		}
	}

	if (Object.keys(payload).length === 0) {
		payload.stdout_excerpt = truncateText(rawStdout, cfg.stdoutChars);
	}

	return payload;
}

export async function runPipelineWithApprovedSchema(
	params: {
		userMessage: string;
		approvedSchema: SchemaAny;
		approvedSchemeDescription?: string | null;
		revisionNotes?: string[];
		solverModel?: SolverModelV1;
	},
	history: GeminiHistory[],
	onStatus: (event: PipelineStatus) => void,
	imageData?: { base64: string; mimeType: string },
	forcedModel?: string | null
): Promise<void> {
	if (!params.approvedSchema) {
		throw new Error('Approved schema is required for schema-check solving');
	}
	console.log('[SchemaCheck] pipeline.start', {
		messageLength: params.userMessage.length,
		revisionNotes: params.revisionNotes?.length ?? 0
	});

	const schemaJson = JSON.stringify(params.approvedSchema, null, 2);
	const approvedSchemeDescription = typeof params.approvedSchemeDescription === 'string'
		? params.approvedSchemeDescription.trim()
		: '';
	const descriptionBlock = approvedSchemeDescription
		? `${APPROVED_SCHEME_DESCRIPTION_MARKER}${approvedSchemeDescription}`
		: '';
	const solverModelJson = params.solverModel ? JSON.stringify(params.solverModel, null, 2) : null;
	const notesBlock =
		params.revisionNotes && params.revisionNotes.length > 0
			? `\n\n[ACCEPTED_SCHEMA_REVISIONS]\n${params.revisionNotes.map((note, i) => `${i + 1}. ${note}`).join('\n')}`
			: '';
	const solverBlock = solverModelJson ? `${SOLVER_MODEL_MARKER}${solverModelJson}` : '';
	const messageWithSchemaContext = `${params.userMessage}${descriptionBlock}${notesBlock}${solverBlock}${APPROVED_SCHEMA_MARKER}${schemaJson}\n\n${approvedSchemeDescription ? 'Use approved scheme description as primary narrative context for solving.' : ''} Use approved schema as canonical structural context.${solverModelJson ? ' Use solver model as canonical semantics for member local axes, signs, and axis origins.' : ''}`;

	return runPipeline(messageWithSchemaContext, [], onStatus, undefined, forcedModel, {
		approvedSchema: params.approvedSchema
	})
		.finally(() => {
			console.log('[SchemaCheck] pipeline.finished');
		});
}

export async function runPipeline(
	userMessage: string,
	history: GeminiHistory[],
	onStatus: (event: PipelineStatus) => void,
	imageData?: { base64: string; mimeType: string },
	forcedModel?: string | null,
	options?: {
		approvedSchema?: SchemaAny | null;
	}
): Promise<void> {
	console.log('[Pipeline] START message:', userMessage.slice(0, 80), '| forcedModel:', forcedModel);
	let currentContext = userMessage;
	const usedModelsList: string[] = [];
	const approvedSchema = options?.approvedSchema ?? null;
	const effectiveHistory = approvedSchema ? [] : history;

	try {
		// ── Шаг 0: Анализ изображения (Vision) ──────────────────────────────
		if (imageData && !approvedSchema) {
			console.log('[Pipeline] Analyzing image...');
			onStatus({ type: 'status', message: 'Анализ изображения...' });
			const { text: visionDescription, model: visionModel, tokens: visionTokens } = await analyzeImage(
				effectiveHistory,
				imageData.base64,
				imageData.mimeType,
				forcedModel
			);
			usedModelsList.push(`${visionModel} (Vision): ${visionTokens.toLocaleString('ru-RU')} токенов`);
			console.log('[Pipeline] Vision description received from', visionModel);
			
			// Склеиваем описание картинки с текстом пользователя
			currentContext = `[ОПИСАНИЕ ИЗОБРАЖЕНИЯ]:\n${visionDescription}\n\n[ЗАПРОС ПОЛЬЗОВАТЕЛЯ]:\n${userMessage}`;
		}

		// ── Шаг 1: Маршрутизация (Flash) ─────────────────────────────────────
		console.log('[Pipeline] Step 1: routing...');
		onStatus({ type: 'status', message: 'Анализ задачи...' });
		const { result: needsComputation, model: routerModel, tokens: routerTokens } = await routeQuestion(
			effectiveHistory,
			currentContext,
			forcedModel
		);
		usedModelsList.push(`${routerModel} (Router): ${routerTokens.toLocaleString('ru-RU')} токенов`);
		console.log('[Pipeline] Step 1 done: needsComputation =', needsComputation);

		if (!needsComputation) {
			console.log('[Pipeline] General question — calling answerGeneralQuestion');
			onStatus({ type: 'status', message: 'Формирование ответа...' });
			const { text: answer, model: flashModel, tokens: textTokens } = await answerGeneralQuestion(
				effectiveHistory,
				currentContext,
				forcedModel
			);
			usedModelsList.push(`${flashModel} (Text): ${textTokens.toLocaleString('ru-RU')} токенов`);
			onStatus({ type: 'result', content: answer, usedModels: usedModelsList });
			return;
		}

		// ── Шаг 2: Генерация кода (Pro) ──────────────────────────────────────
		console.log('[Pipeline] Step 2: generating Python code...');
		onStatus({ type: 'status', message: 'Генерация кода решения...' });
		let { code: pythonCode, model: codeModel, tokens: codeTokens } = await generatePythonCode(
			effectiveHistory,
			currentContext,
			undefined,
			forcedModel
		);
		usedModelsList.push(`${codeModel} (CodeGen): ${codeTokens.toLocaleString('ru-RU')} токенов`);
		console.log('[Pipeline] Step 2 done, code length:', pythonCode.length);

		// ── Шаг 3: Выполнение в Sandbox + Retry ──────────────────────────────
		let lastError: string | null = null;
		let sandboxOutput: SandboxOutput | null = null;
		let rawStdout = '';
		let solvedSchemaData: SchemaAny | undefined;
		let solvedSchemaVersion: SchemaVersionTag | undefined;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				console.log(`[Pipeline] Retry ${attempt}/${MAX_RETRIES}, lastError:`, lastError?.slice(0, 200));
				onStatus({ type: 'status', message: `Исправление ошибки (попытка ${attempt}/${MAX_RETRIES})...` });
				const retryRes = await generatePythonCode(
					effectiveHistory,
					currentContext,
					`Предыдущий код:\n\`\`\`python\n${pythonCode}\n\`\`\`\n\nОшибка:\n${lastError}`,
					forcedModel
				);
				pythonCode = retryRes.code;
				usedModelsList.push(`${retryRes.model} (Fixer): ${retryRes.tokens.toLocaleString('ru-RU')} токенов`);
			}

			console.log(`[Pipeline] Step 3: sandbox execute, attempt ${attempt}`);
			onStatus({
				type: 'status',
				message: attempt === 0 ? 'Выполнение вычислений...' : `Выполнение исправленного кода...`
			});

			try {
				const result = await workerPool.execute(pythonCode);
				rawStdout = result.stdout;
				console.log('[Pipeline] Sandbox OK, stdout:', rawStdout.slice(0, 200));

				try {
					const jsonMatch = rawStdout.match(/\{[\s\S]*\}/);
					if (jsonMatch) {
						sandboxOutput = JSON.parse(jsonMatch[0]) as SandboxOutput;
					} else {
						sandboxOutput = { result: rawStdout };
					}
				} catch {
					sandboxOutput = { result: rawStdout };
				}

				const graphNormalization = normalizeAndValidateGraphs(sandboxOutput);
				if (graphNormalization.issues.length > 0) {
					lastError = `Graph contract violation: ${graphNormalization.issues.join('; ')}`;
					console.warn('[Pipeline] Graph contract violation:', graphNormalization.issues);
					if (attempt >= MAX_RETRIES) {
						onStatus({
							type: 'error',
							message:
								`Не удалось получить корректные эпюры по стержням после ${MAX_RETRIES + 1} попыток:\n` +
								graphNormalization.issues.join('\n')
						});
						return;
					}
					continue;
				}
				if (graphNormalization.warnings.length > 0) {
					console.warn('[Pipeline] Graph normalization warnings:', graphNormalization.warnings);
				}
				sandboxOutput = { ...sandboxOutput, graphs: graphNormalization.graphs };

				const schemaNormalization = approvedSchema
					? normalizeSchemaForApprovedContext(sandboxOutput, approvedSchema)
					: normalizeSchemaFromOutput(sandboxOutput);

				if (approvedSchema && schemaNormalization.issues.length > 0) {
					lastError = `Schema patch contract violation: ${schemaNormalization.issues.join('; ')}`;
					console.warn('[Pipeline] Schema patch contract violation:', schemaNormalization.issues);
					if (attempt >= MAX_RETRIES) {
						onStatus({
							type: 'error',
							message:
								`Не удалось получить корректный schemaPatch после ${MAX_RETRIES + 1} попыток:\n` +
								schemaNormalization.issues.join('\n')
						});
						return;
					}
					continue;
				}

				if (!approvedSchema && schemaNormalization.issues.length > 0) {
					console.warn('[Pipeline] Ignoring invalid schemaData from solver output:', schemaNormalization.issues);
				}

				solvedSchemaData = schemaNormalization.schemaData;
				solvedSchemaVersion = schemaNormalization.schemaVersion;

				lastError = null;
				break;

			} catch (err) {
				console.error(`[Pipeline] Sandbox error (attempt ${attempt}):`, err);
				if (err instanceof SandboxError) {
					lastError = err.message;
					if (attempt >= MAX_RETRIES) {
						onStatus({
							type: 'error',
							message: `Не удалось выполнить вычисления после ${MAX_RETRIES + 1} попыток:\n${lastError}`
						});
						return;
					}
				} else {
					throw err;
				}
			}
		}

		// ── Шаг 4: Сборка ответа (Flash/Pro по tier) ─────────────────────────
		console.log('[Pipeline] Step 4: assembling final answer...');
		onStatus({ type: 'status', message: 'Формирование ответа...' });

		const finalizerHistory = trimHistoryForFinalizer(effectiveHistory);
		const finalizerTask = truncateText(
			sanitizeFinalizerTaskContext(userMessage) || sanitizeFinalizerTaskContext(currentContext) || userMessage,
			FINALIZER_TASK_MAX_CHARS
		);
		const historyChars = getHistoryChars(finalizerHistory);

		let finalizerMode: FinalizerPayloadMode = 'normal';
		let executionSummary = JSON.stringify(buildFinalizerExecutionPayload(sandboxOutput, rawStdout, finalizerMode));
		let totalInputChars = historyChars + finalizerTask.length + executionSummary.length;

		if (totalInputChars > FINALIZER_MAX_INPUT_CHARS) {
			finalizerMode = 'compact';
			executionSummary = JSON.stringify(buildFinalizerExecutionPayload(sandboxOutput, rawStdout, finalizerMode));
			totalInputChars = historyChars + finalizerTask.length + executionSummary.length;
		}
		if (totalInputChars > FINALIZER_MAX_INPUT_CHARS) {
			finalizerMode = 'minimal';
			executionSummary = JSON.stringify(buildFinalizerExecutionPayload(sandboxOutput, rawStdout, finalizerMode));
			totalInputChars = historyChars + finalizerTask.length + executionSummary.length;
		}
		if (totalInputChars > FINALIZER_MAX_INPUT_CHARS) {
			const budgetForExecution = Math.max(
				600,
				FINALIZER_MAX_INPUT_CHARS - historyChars - finalizerTask.length
			);
			executionSummary = truncateText(executionSummary, budgetForExecution);
			totalInputChars = historyChars + finalizerTask.length + executionSummary.length;
		}

		console.log('[Pipeline] Finalizer input metrics:', {
			mode: finalizerMode,
			historyEntries: finalizerHistory.length,
			historyChars,
			taskChars: finalizerTask.length,
			executionChars: executionSummary.length,
			totalChars: totalInputChars,
			estimatedTokens: estimateTokensByChars(totalInputChars),
			graphPointsTotal: countGraphPoints(sandboxOutput)
		});

		const { text: finalAnswer, model: assembleModel, tokens: assembleTokens } = await assembleFinalAnswer(
			finalizerHistory,
			{ userMessage: finalizerTask, executionResult: executionSummary },
			forcedModel
		);
		usedModelsList.push(`${assembleModel} (Finalizer): ${assembleTokens.toLocaleString('ru-RU')} токенов`);
		console.log('[Pipeline] Step 4 done, answer length:', finalAnswer.length);

		const graphData: GraphData[] | undefined =
			Array.isArray(sandboxOutput?.graphs) && sandboxOutput.graphs.length > 0
				? sandboxOutput.graphs
				: undefined;

		onStatus({
			type: 'result',
			content: finalAnswer,
			generatedCode: pythonCode,
			executionLogs: rawStdout,
			graphData,
			schemaData: solvedSchemaData,
			schemaVersion: solvedSchemaVersion,
			usedModels: usedModelsList
		});
		console.log('[Pipeline] DONE');

	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[Pipeline] UNCAUGHT ERROR:', err);
		onStatus({ type: 'error', message: `Внутренняя ошибка: ${message}` });
	}
}
