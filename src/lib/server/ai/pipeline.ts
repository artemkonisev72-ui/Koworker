/**
 * pipeline.ts
 * Solver pipeline:
 *   Router -> CodeGen -> Sandbox -> Retry -> Finalizer
 *
 * Updated contract:
 *   CodeGen must return SolveArtifactsV1 with exactAnswers + graphData.
 *   Finalizer receives canonical task context + exact answers and writes full narrative solution.
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
import {
	normalizeGraphEpure,
	type GraphData,
	type GraphPoint
} from '$lib/graphs/types.js';
import type { SolverModelV1 } from '$lib/solver/model.js';

export interface ExactAnswerLocation {
	memberId?: string;
	x?: number;
	s?: number;
	note?: string;
}

export interface ExactAnswer {
	id: string;
	label: string;
	valueText: string;
	numericValue: number;
	unit?: string;
	targetKind?: 'global' | 'support' | 'member' | 'section';
	targetId?: string;
	component?: string;
	location?: ExactAnswerLocation;
}

interface SolveArtifactsV1 {
	version: 'solve-artifacts-1.0';
	exactAnswers: ExactAnswer[];
	graphData: GraphData[];
}

interface CanonicalSolveInput {
	source: 'approved_schema' | 'raw_prompt';
	originalTask: string;
	imageDescription?: string;
	approvedSchema?: SchemaAny;
	approvedSchemeDescription?: string;
	solverModel?: SolverModelV1;
	revisionNotes?: string[];
}

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
			exactAnswers?: ExactAnswer[];
			schemaData?: SchemaAny;
			schemaDescription?: string;
			schemaVersion?: SchemaVersionTag;
			usedModels?: string[];
	  }
	| { type: 'error'; message: string };

interface GraphNormalizationResult {
	graphs: GraphData[];
	issues: string[];
	warnings: string[];
}

interface SolveArtifactsNormalizationResult {
	artifacts?: SolveArtifactsV1;
	issues: string[];
}

const MAX_RETRIES = 2;

const FINALIZER_TASK_MAX_CHARS = readIntEnv('FINALIZER_TASK_MAX_CHARS', 3000, 400, 20000);
const FINALIZER_MAX_INPUT_CHARS = readIntEnv('FINALIZER_MAX_INPUT_CHARS', 12000, 2000, 120000);
const FINALIZER_GRAPH_SAMPLE_POINTS = readIntEnv('FINALIZER_GRAPH_SAMPLE_POINTS', 8, 2, 24);

const STATUS_ANALYZE_IMAGE = '\u0410\u043d\u0430\u043b\u0438\u0437 \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u044f...';
const STATUS_ANALYZE_TASK = '\u0410\u043d\u0430\u043b\u0438\u0437 \u0437\u0430\u0434\u0430\u0447\u0438...';
const STATUS_GENERATE_CODE = '\u0413\u0435\u043d\u0435\u0440\u0430\u0446\u0438\u044f \u043a\u043e\u0434\u0430 \u0440\u0435\u0448\u0435\u043d\u0438\u044f...';
const STATUS_FIX_ERROR = '\u0418\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435 \u043e\u0448\u0438\u0431\u043a\u0438';
const STATUS_RUN = '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0435 \u0432\u044b\u0447\u0438\u0441\u043b\u0435\u043d\u0438\u0439...';
const STATUS_RUN_FIXED = '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0435 \u0438\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043d\u043e\u0433\u043e \u043a\u043e\u0434\u0430...';
const STATUS_FORM_ANSWER = '\u0424\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435 \u043e\u0442\u0432\u0435\u0442\u0430...';

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

function normalizeString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
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
		if (
			isRecord(entry) &&
			typeof entry.x === 'number' &&
			Number.isFinite(entry.x) &&
			typeof entry.y === 'number' &&
			Number.isFinite(entry.y)
		) {
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

function normalizeAndValidateGraphs(graphsRaw: unknown): GraphNormalizationResult {
	const rawGraphs: unknown[] = Array.isArray(graphsRaw)
		? graphsRaw
		: Array.isArray((graphsRaw as { graph_points?: unknown })?.graph_points)
			? [{ title: 'График решения', type: 'function', points: (graphsRaw as { graph_points: unknown[] }).graph_points }]
			: [];
	if (rawGraphs.length === 0) return { graphs: [], issues: [], warnings: [] };

	const normalizedGraphs: GraphData[] = [];
	const issues: string[] = [];
	const warnings: string[] = [];

	for (let index = 0; index < rawGraphs.length; index++) {
		const rawGraph = rawGraphs[index];
		if (!isRecord(rawGraph)) {
			issues.push(`graphData[${index}] must be an object`);
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
			issues.push(`graphData[${index}] must contain at least 2 points`);
			continue;
		}

		const pointMemberIds = Array.isArray(rawGraph.points)
			? Array.from(
					new Set(
						rawGraph.points
							.map(extractPointMemberId)
							.filter((item): item is string => Boolean(item))
					)
				)
			: [];
		const declaredMemberIds = Array.isArray(rawGraph.memberIds)
			? Array.from(
					new Set(
						rawGraph.memberIds
							.map(normalizeString)
							.filter((item): item is string => Boolean(item))
					)
				)
			: [];

		let memberId = normalizeMemberId(rawGraph);
		if (!memberId && pointMemberIds.length === 1) memberId = pointMemberIds[0];
		if (!memberId && declaredMemberIds.length === 1) memberId = declaredMemberIds[0];

		if (pointMemberIds.length > 1) {
			issues.push(`graphData[${index}] mixes multiple members in points: ${pointMemberIds.join(', ')}`);
		}
		if (declaredMemberIds.length > 1) {
			issues.push(`graphData[${index}] declares multiple memberIds: ${declaredMemberIds.join(', ')}`);
		}
		if (type === 'diagram' && !memberId) {
			issues.push(`graphData[${index}] type "diagram" requires memberId`);
		}
		if (memberId && /[,+;|]/.test(memberId)) {
			issues.push(`graphData[${index}] memberId looks composite ("${memberId}")`);
		}

		const epureNormalized = normalizeGraphEpure({
			title: normalizeGraphTitle(rawGraph, `Graph ${index + 1}`),
			type,
			memberId: memberId ?? undefined,
			diagramType,
			epure: epureMeta,
			points
		});
		warnings.push(...epureNormalized.warnings.map((warning) => `graphData[${index}]: ${warning}`));
		normalizedGraphs.push(epureNormalized.graph);
	}

	return { graphs: normalizedGraphs, issues, warnings };
}

function extractFirstJsonObject(text: string): string | null {
	const start = text.indexOf('{');
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') {
			depth += 1;
			continue;
		}
		if (ch === '}') {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function normalizeExactAnswer(raw: unknown, index: number, issues: string[]): ExactAnswer | null {
	if (!isRecord(raw)) {
		issues.push(`exactAnswers[${index}] must be an object`);
		return null;
	}

	const numericCandidate =
		typeof raw.numericValue === 'number'
			? raw.numericValue
			: typeof raw.value === 'number'
				? raw.value
				: Number.NaN;
	if (!Number.isFinite(numericCandidate)) {
		issues.push(`exactAnswers[${index}].numericValue must be a finite number`);
		return null;
	}

	const id = normalizeString(raw.id) ?? `answer_${index + 1}`;
	const label = normalizeString(raw.label) ?? `Answer ${index + 1}`;
	const valueText =
		normalizeString(raw.valueText) ??
		normalizeString(raw.value_label) ??
		String(numericCandidate);

	const answer: ExactAnswer = {
		id,
		label,
		valueText,
		numericValue: numericCandidate
	};

	const unit = normalizeString(raw.unit);
	if (unit) answer.unit = unit;
	const targetKind = normalizeString(raw.targetKind);
	if (
		targetKind === 'global' ||
		targetKind === 'support' ||
		targetKind === 'member' ||
		targetKind === 'section'
	) {
		answer.targetKind = targetKind;
	}
	const targetId = normalizeString(raw.targetId);
	if (targetId) answer.targetId = targetId;
	const component = normalizeString(raw.component);
	if (component) answer.component = component;

	const locationRaw = isRecord(raw.location) ? raw.location : null;
	if (locationRaw) {
		const location: ExactAnswerLocation = {};
		const memberId = normalizeString(locationRaw.memberId);
		if (memberId) location.memberId = memberId;
		if (typeof locationRaw.x === 'number' && Number.isFinite(locationRaw.x)) location.x = locationRaw.x;
		if (typeof locationRaw.s === 'number' && Number.isFinite(locationRaw.s)) location.s = locationRaw.s;
		const note = normalizeString(locationRaw.note);
		if (note) location.note = note;
		if (Object.keys(location).length > 0) answer.location = location;
	}

	return answer;
}

function normalizeSolveArtifacts(rawStdout: string): SolveArtifactsNormalizationResult {
	const jsonCandidate = extractFirstJsonObject(rawStdout);
	if (!jsonCandidate) {
		return { issues: ['Sandbox stdout does not contain JSON object'] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonCandidate);
	} catch {
		return { issues: ['Sandbox JSON parsing failed'] };
	}

	if (!isRecord(parsed)) {
		return { issues: ['Sandbox JSON root must be an object'] };
	}

	const issues: string[] = [];
	const version = normalizeString(parsed.version);
	if (version !== 'solve-artifacts-1.0') {
		issues.push(`version must be "solve-artifacts-1.0" (got "${version ?? 'missing'}")`);
	}

	const exactAnswersRaw = Array.isArray(parsed.exactAnswers)
		? parsed.exactAnswers
		: Array.isArray(parsed.answers)
			? parsed.answers
			: [];

	const exactAnswers: ExactAnswer[] = [];
	for (let index = 0; index < exactAnswersRaw.length; index++) {
		const normalized = normalizeExactAnswer(exactAnswersRaw[index], index, issues);
		if (normalized) exactAnswers.push(normalized);
	}
	if (exactAnswers.length === 0) {
		issues.push('exactAnswers must contain at least one answer');
	}

	const graphRaw = Array.isArray(parsed.graphData)
		? parsed.graphData
		: Array.isArray(parsed.graphs)
			? parsed.graphs
			: Array.isArray(parsed.graph_points)
				? [{ title: 'Graph', type: 'function', points: parsed.graph_points }]
				: [];
	const graphNormalization = normalizeAndValidateGraphs(graphRaw);
	issues.push(...graphNormalization.issues);

	if (issues.length > 0) {
		return { issues };
	}

	return {
		issues: [],
		artifacts: {
			version: 'solve-artifacts-1.0',
			exactAnswers,
			graphData: graphNormalization.graphs
		}
	};
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

function summarizeGraphsForFinalizer(graphs: GraphData[], maxSamples: number): Array<Record<string, unknown>> {
	return graphs.map((graph, index) => {
		const points = Array.isArray(graph.points) ? graph.points : [];
		return {
			id: `graph_${index + 1}`,
			title: typeof graph.title === 'string' ? graph.title : undefined,
			type: typeof graph.type === 'string' ? graph.type : undefined,
			memberId: typeof graph.memberId === 'string' ? graph.memberId : undefined,
			diagramType: typeof graph.diagramType === 'string' ? graph.diagramType : undefined,
			pointCount: points.length,
			samplePoints: sampleGraphPoints(points, maxSamples)
		};
	});
}

function countGraphPoints(graphs: GraphData[]): number {
	let total = 0;
	for (const graph of graphs) {
		if (!graph || !Array.isArray(graph.points)) continue;
		total += graph.points.length;
	}
	return total;
}

function summarizeSchemaShape(schema: SchemaAny): {
	nodeCount: number;
	objectCount: number;
	resultCount: number;
} {
	if (!isRecord(schema)) {
		return { nodeCount: 0, objectCount: 0, resultCount: 0 };
	}

	const maybeNodes = Array.isArray(schema.nodes) ? schema.nodes.length : 0;
	const maybeObjects = Array.isArray(schema.objects) ? schema.objects.length : 0;
	const maybeResults = Array.isArray(schema.results) ? schema.results.length : 0;
	if (maybeNodes > 0 || maybeObjects > 0 || maybeResults > 0) {
		return {
			nodeCount: maybeNodes,
			objectCount: maybeObjects,
			resultCount: maybeResults
		};
	}

	const maybeElements = Array.isArray(schema.elements) ? schema.elements.length : 0;
	return {
		nodeCount: 0,
		objectCount: maybeElements,
		resultCount: 0
	};
}

function buildSolverContextMessage(input: CanonicalSolveInput): string {
	const chunks: string[] = [];
	chunks.push(`[CANONICAL_SOLVE_SOURCE]\n${input.source}`);
	chunks.push(`[TASK]\n${input.originalTask}`);
	if (input.imageDescription) {
		chunks.push(`[IMAGE_DESCRIPTION]\n${input.imageDescription}`);
	}
	if (input.source === 'approved_schema') {
		if (input.approvedSchemeDescription) {
			chunks.push(`[APPROVED_SCHEME_DESCRIPTION]\n${input.approvedSchemeDescription}`);
		}
		if (input.revisionNotes && input.revisionNotes.length > 0) {
			chunks.push(
				`[ACCEPTED_SCHEMA_REVISIONS]\n${input.revisionNotes.map((note, index) => `${index + 1}. ${note}`).join('\n')}`
			);
		}
		if (input.solverModel) {
			chunks.push(`[SOLVER_MODEL_JSON]\n${JSON.stringify(input.solverModel, null, 2)}`);
		}
		if (input.approvedSchema) {
			chunks.push(`[APPROVED_SCHEMA_JSON]\n${JSON.stringify(input.approvedSchema, null, 2)}`);
		}
	}
	return chunks.join('\n\n');
}

function buildFinalizerContextPayload(
	input: CanonicalSolveInput,
	exactAnswers: ExactAnswer[],
	graphs: GraphData[]
): { solveContextJson: string; exactAnswersJson: string; graphSummaryJson: string } {
	const contextPayload: Record<string, unknown> = {
		source: input.source,
		task: truncateText(input.originalTask, FINALIZER_TASK_MAX_CHARS),
		...(input.imageDescription ? { imageDescription: input.imageDescription } : {})
	};
	if (input.source === 'approved_schema') {
		contextPayload.approvedSchemeDescription = input.approvedSchemeDescription ?? '';
		contextPayload.revisionNotes = input.revisionNotes ?? [];
		if (input.solverModel) {
			contextPayload.solverModel = input.solverModel;
		}
		if (input.approvedSchema) {
			const schemaValidation = validateSchemaAny(input.approvedSchema);
			contextPayload.approvedSchemaSummary =
				schemaValidation.ok && schemaValidation.value
					? {
							version: schemaValidation.version ?? '2.0',
							...summarizeSchemaShape(schemaValidation.value)
						}
					: { issue: 'invalid approved schema in context' };
		}
	}

	const exactAnswersJson = JSON.stringify({ exactAnswers });
	let graphSummaryJson = JSON.stringify({
		graphs: summarizeGraphsForFinalizer(graphs, FINALIZER_GRAPH_SAMPLE_POINTS)
	});
	let solveContextJson = JSON.stringify(contextPayload);

	const totalChars = solveContextJson.length + exactAnswersJson.length + graphSummaryJson.length;
	if (totalChars > FINALIZER_MAX_INPUT_CHARS) {
		graphSummaryJson = JSON.stringify({
			graphs: summarizeGraphsForFinalizer(graphs, 3)
		});
	}

	const reducedTotal = solveContextJson.length + exactAnswersJson.length + graphSummaryJson.length;
	if (reducedTotal > FINALIZER_MAX_INPUT_CHARS) {
		solveContextJson = truncateText(
			solveContextJson,
			Math.max(1200, FINALIZER_MAX_INPUT_CHARS - exactAnswersJson.length - graphSummaryJson.length)
		);
	}

	return { solveContextJson, exactAnswersJson, graphSummaryJson };
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
	onStatus: (event: PipelineStatus) => void | Promise<void>,
	imageData?: { base64: string; mimeType: string },
	forcedModel?: string | null
): Promise<void> {
	if (!params.approvedSchema) {
		throw new Error('Approved schema is required for schema-check solving');
	}

	const canonicalInput: CanonicalSolveInput = {
		source: 'approved_schema',
		originalTask: params.userMessage,
		approvedSchema: params.approvedSchema,
		approvedSchemeDescription:
			typeof params.approvedSchemeDescription === 'string'
				? params.approvedSchemeDescription.trim()
				: '',
		solverModel: params.solverModel,
		revisionNotes: params.revisionNotes ?? []
	};

	return runPipeline(params.userMessage, history, onStatus, imageData, forcedModel, {
		canonicalSolveInput: canonicalInput,
		bypassRouting: true
	});
}

export async function runPipeline(
	userMessage: string,
	history: GeminiHistory[],
	onStatus: (event: PipelineStatus) => void | Promise<void>,
	imageData?: { base64: string; mimeType: string },
	forcedModel?: string | null,
	options?: {
		canonicalSolveInput?: CanonicalSolveInput | null;
		bypassRouting?: boolean;
	}
): Promise<void> {
	console.log('[Pipeline] START message:', userMessage.slice(0, 80), '| forcedModel:', forcedModel);
	let currentContext = userMessage;
	let imageDescription = '';
	const usedModelsList: string[] = [];
	const emitStatus = (event: PipelineStatus) => Promise.resolve(onStatus(event));

	try {
		if (imageData && !options?.canonicalSolveInput) {
			console.log('[Pipeline] Analyzing image...');
			await emitStatus({ type: 'status', message: STATUS_ANALYZE_IMAGE });
			const { text: visionText, model: visionModel, tokens: visionTokens } = await analyzeImage(
				history,
				imageData.base64,
				imageData.mimeType,
				forcedModel
			);
			imageDescription = visionText;
			usedModelsList.push(`${visionModel} (Vision): ${visionTokens.toLocaleString('ru-RU')} токенов`);
			currentContext = `[IMAGE_DESCRIPTION]\n${visionText}\n\n[USER_TASK]\n${userMessage}`;
		}

		let needsComputation = true;
		if (!options?.bypassRouting) {
			console.log('[Pipeline] Step 1: routing...');
			await emitStatus({ type: 'status', message: STATUS_ANALYZE_TASK });
			const routing = await routeQuestion(history, currentContext, forcedModel);
			needsComputation = routing.result;
			usedModelsList.push(`${routing.model} (Router): ${routing.tokens.toLocaleString('ru-RU')} токенов`);
			console.log('[Pipeline] Step 1 done: needsComputation =', needsComputation);
		}

		if (!needsComputation) {
			console.log('[Pipeline] General question — calling answerGeneralQuestion');
			await emitStatus({ type: 'status', message: STATUS_FORM_ANSWER });
			const { text: answer, model: textModel, tokens: textTokens } = await answerGeneralQuestion(
				history,
				currentContext,
				forcedModel
			);
			usedModelsList.push(`${textModel} (Text): ${textTokens.toLocaleString('ru-RU')} токенов`);
			await emitStatus({ type: 'result', content: answer, usedModels: usedModelsList });
			return;
		}

		const canonicalInput: CanonicalSolveInput =
			options?.canonicalSolveInput ?? {
				source: 'raw_prompt',
				originalTask: userMessage,
				...(imageDescription ? { imageDescription } : {})
			};
		const solverContextMessage = buildSolverContextMessage(canonicalInput);
		const solverHistory: GeminiHistory[] = [];
		let pythonCode = '';
		let rawStdout = '';
		let solveArtifacts: SolveArtifactsV1 | null = null;
		let lastError: string | null = null;

		await emitStatus({ type: 'status', message: STATUS_GENERATE_CODE });
		const codeGen = await generatePythonCode(solverHistory, solverContextMessage, undefined, forcedModel);
		pythonCode = codeGen.code;
		usedModelsList.push(`${codeGen.model} (CodeGen): ${codeGen.tokens.toLocaleString('ru-RU')} токенов`);

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				await emitStatus({
					type: 'status',
					message: `${STATUS_FIX_ERROR} (попытка ${attempt}/${MAX_RETRIES})...`
				});
				const retryRes = await generatePythonCode(
					solverHistory,
					solverContextMessage,
					`Previous code:\n\`\`\`python\n${pythonCode}\n\`\`\`\n\nError:\n${lastError ?? 'Unknown error'}`,
					forcedModel
				);
				pythonCode = retryRes.code;
				usedModelsList.push(`${retryRes.model} (Fixer): ${retryRes.tokens.toLocaleString('ru-RU')} токенов`);
			}

			await emitStatus({
				type: 'status',
				message: attempt === 0 ? STATUS_RUN : STATUS_RUN_FIXED
			});

			try {
				const execution = await workerPool.execute(pythonCode);
				rawStdout = execution.stdout;
				const artifactsNormalization = normalizeSolveArtifacts(rawStdout);
				if (artifactsNormalization.issues.length > 0 || !artifactsNormalization.artifacts) {
					lastError = `SolveArtifacts contract violation: ${artifactsNormalization.issues.join('; ')}`;
					if (attempt >= MAX_RETRIES) {
						await emitStatus({
							type: 'error',
							message:
								`Не удалось получить корректный SolveArtifactsV1 после ${MAX_RETRIES + 1} попыток:\n` +
								artifactsNormalization.issues.join('\n')
						});
						return;
					}
					continue;
				}
				solveArtifacts = artifactsNormalization.artifacts;
				lastError = null;
				break;
			} catch (err) {
				if (err instanceof SandboxError) {
					lastError = err.message;
					if (attempt >= MAX_RETRIES) {
						await emitStatus({
							type: 'error',
							message: `Не удалось выполнить вычисления после ${MAX_RETRIES + 1} попыток:\n${lastError}`
						});
						return;
					}
					continue;
				}
				throw err;
			}
		}

		if (!solveArtifacts) {
			await emitStatus({ type: 'error', message: 'Solver did not return valid artifacts' });
			return;
		}

		console.log('[Pipeline] Step 4: finalizer...');
		await emitStatus({ type: 'status', message: STATUS_FORM_ANSWER });
		const finalizerPayload = buildFinalizerContextPayload(
			canonicalInput,
			solveArtifacts.exactAnswers,
			solveArtifacts.graphData
		);
		console.log('[Pipeline] Finalizer input metrics:', {
			taskChars: canonicalInput.originalTask.length,
			exactAnswers: solveArtifacts.exactAnswers.length,
			graphs: solveArtifacts.graphData.length,
			graphPointsTotal: countGraphPoints(solveArtifacts.graphData),
			contextChars: finalizerPayload.solveContextJson.length,
			answersChars: finalizerPayload.exactAnswersJson.length,
			graphSummaryChars: finalizerPayload.graphSummaryJson.length
		});

		const finalizerHistory: GeminiHistory[] = [];
		const finalizerTaskText = truncateText(canonicalInput.originalTask, FINALIZER_TASK_MAX_CHARS);
		const finalizer = await assembleFinalAnswer(
			finalizerHistory,
			{
				taskContext: finalizerTaskText,
				solveContextJson: finalizerPayload.solveContextJson,
				exactAnswersJson: finalizerPayload.exactAnswersJson,
				graphSummaryJson: finalizerPayload.graphSummaryJson
			},
			forcedModel
		);
		usedModelsList.push(`${finalizer.model} (Finalizer): ${finalizer.tokens.toLocaleString('ru-RU')} токенов`);

		let solvedSchemaData: SchemaAny | undefined;
		let solvedSchemaVersion: SchemaVersionTag | undefined;
		let solvedSchemaDescription: string | undefined;
		if (canonicalInput.source === 'approved_schema' && canonicalInput.approvedSchema) {
			solvedSchemaData = canonicalInput.approvedSchema;
			solvedSchemaDescription = canonicalInput.approvedSchemeDescription;
			const schemaValidation = validateSchemaAny(canonicalInput.approvedSchema);
			solvedSchemaVersion = schemaValidation.version ?? '2.0';
		}

		await emitStatus({
			type: 'result',
			content: finalizer.text,
			generatedCode: pythonCode,
			executionLogs: rawStdout,
			graphData: solveArtifacts.graphData,
			exactAnswers: solveArtifacts.exactAnswers,
			schemaData: solvedSchemaData,
			schemaDescription: solvedSchemaDescription,
			schemaVersion: solvedSchemaVersion,
			usedModels: usedModelsList
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[Pipeline] UNCAUGHT ERROR:', err);
		await emitStatus({ type: 'error', message: `Внутренняя ошибка: ${message}` });
	}
}
