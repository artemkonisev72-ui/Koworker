/**
 * gemini.ts
 * Thin wrapper around Gemini API.
 */
import { GEMINI_API_KEY } from '$env/static/private';
import { GoogleGenAI } from '@google/genai';
import type { SchemaData } from '$lib/schema/schema-data.js';
import type { SchemaDataV2 } from '$lib/schema/schema-v2.js';
import type { SchemeIntentV1 } from '$lib/schema/intent.js';
import { parseSchemeIntentResponse } from '$lib/schema/intent.js';
import type { SchemeUnderstandingV1 } from '$lib/schema/understanding.js';
import { parseSchemeUnderstandingResponse } from '$lib/schema/understanding.js';
import { detectPromptLanguage } from '$lib/server/schema/language.js';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

export type GeminiModel =
	| 'gemini-3.1-flash-preview'
	| 'gemini-3.1-pro-preview'
	| 'gemini-3-pro-preview'
	| 'gemini-3-flash-preview'
	| 'gemini-3.1-flash-lite-preview'
	| 'gemini-2.5-pro'
	| 'gemini-2.5-flash'
	| 'gemini-2.5-flash-lite';

const GEMINI_MODEL_SET = new Set<GeminiModel>([
	'gemini-3.1-flash-preview',
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-3-flash-preview',
	'gemini-3.1-flash-lite-preview',
	'gemini-2.5-pro',
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite'
]);

const FLASH_CHAIN: GeminiModel[] = [
	'gemini-3.1-flash-preview',
	'gemini-3-flash-preview',
	'gemini-2.5-flash',
	'gemini-3.1-flash-lite-preview',
	'gemini-2.5-flash-lite'
];

const PRO_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-2.5-pro',
	'gemini-3.1-flash-preview',
	'gemini-2.5-flash'
];

const VISION_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-2.5-pro',
	'gemini-3.1-flash-preview',
	'gemini-2.5-flash'
];

const FAST_SCHEMA_CHAIN: GeminiModel[] = [
	'gemini-2.5-flash-lite',
	'gemini-2.5-flash',
	'gemini-3.1-flash-lite-preview'
];

const FAST_VISION_CHAIN: GeminiModel[] = [
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite',
	'gemini-3.1-flash-preview'
];

export interface GeminiHistory {
	role: 'USER' | 'ASSISTANT';
	content: string;
	imageData?: { base64: string; mimeType: string };
}

interface GeminiMessage {
	role: 'user' | 'model';
	parts: Array<{
		text?: string;
		inlineData?: {
			mimeType: string;
			data: string;
		};
	}>;
}

export interface SchemaGenerationResult {
	schemaData: SchemaData | SchemaDataV2;
	assumptions: string[];
	ambiguities: string[];
	model: GeminiModel;
	tokens: number;
	usedModels: string[];
}

export interface IntentGenerationResult {
	intent: SchemeIntentV1;
	assumptions: string[];
	ambiguities: string[];
	model: GeminiModel;
	tokens: number;
	usedModels: string[];
}

export interface SchemeUnderstandingGenerationResult {
	understanding: SchemeUnderstandingV1;
	assumptions: string[];
	ambiguities: string[];
	model: GeminiModel;
	tokens: number;
	usedModels: string[];
}

export interface SchemeDescriptionGenerationResult {
	description: string;
	model: GeminiModel;
	tokens: number;
}

function buildContext(history: GeminiHistory[], systemPrompt: string, currentQuestion: string): GeminiMessage[] {
	const messages: GeminiMessage[] = history
		.filter((entry) => entry.content)
		.map((entry) => {
			const parts: GeminiMessage['parts'] = [{ text: entry.content }];
			if (entry.imageData) {
				parts.push({ inlineData: { mimeType: entry.imageData.mimeType, data: entry.imageData.base64 } });
			}
			return {
				role: entry.role === 'USER' ? 'user' : 'model',
				parts
			};
		});

	const finalPromptText = currentQuestion ? `${systemPrompt}\n\n${currentQuestion}` : systemPrompt;
	messages.push({ role: 'user', parts: [{ text: finalPromptText }] });
	return messages;
}

const DEFAULT_GEMINI_TIMEOUT_MS = 60_000;
const MIN_GEMINI_TIMEOUT_MS = 5_000;
const MAX_GEMINI_TIMEOUT_MS = 60_000;

function getGeminiTimeoutMs(): number {
	const raw = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS);
	if (!Number.isFinite(raw)) return DEFAULT_GEMINI_TIMEOUT_MS;
	return Math.min(MAX_GEMINI_TIMEOUT_MS, Math.max(MIN_GEMINI_TIMEOUT_MS, Math.floor(raw)));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

async function generate(model: GeminiModel, messages: GeminiMessage[]): Promise<{ text: string; tokens: number }> {
	const timeoutMs = getGeminiTimeoutMs();
	const response = await withTimeout(
		ai.models.generateContent({ model, contents: messages }),
		timeoutMs,
		`Gemini request timeout (${timeoutMs}ms) for model ${model}`
	);
	if (!response.text) {
		throw new Error(`Gemini API returned empty text (model: ${model})`);
	}
	return { text: response.text, tokens: response.usageMetadata?.totalTokenCount || 0 };
}

async function generateWithFallback(
	startModel: GeminiModel,
	chain: GeminiModel[],
	messages: GeminiMessage[],
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const normalizedForcedModel =
		typeof forcedModel === 'string' && GEMINI_MODEL_SET.has(forcedModel as GeminiModel)
			? (forcedModel as GeminiModel)
			: null;

	const effectiveChain =
		normalizedForcedModel
			? [normalizedForcedModel]
			: chain.indexOf(startModel) >= 0
				? chain.slice(chain.indexOf(startModel))
				: chain;
	console.log('[ModelPreference:Gemini] fallback chain resolved', {
		startModel,
		forcedModel,
		normalizedForcedModel,
		effectiveChain
	});

	for (let i = 0; i < effectiveChain.length; i++) {
		const model = effectiveChain[i];
		try {
			const { text, tokens } = await generate(model, messages);
			console.log(`[Gemini] Using: ${model}${normalizedForcedModel ? ' (FORCED)' : ''}`);
			return { text, model, tokens };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isRetryable = ['400', '404', '429', '503', 'not found', 'NOT_FOUND', 'Model not supported'].some((token) =>
				msg.includes(token)
			);
			if (isRetryable && i < effectiveChain.length - 1) {
				console.warn(`[Gemini] Model ${model} unavailable, falling back...`);
				continue;
			}
			throw err;
		}
	}

	throw new Error(`[Gemini] All models exhausted for ${forcedModel || 'chain'}`);
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
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') {
			depth++;
			continue;
		}
		if (ch === '}') {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}

	return null;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function isLikelySchemaDataObject(value: unknown): value is SchemaData | SchemaDataV2 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const maybe = value as Record<string, unknown>;
	return Array.isArray(maybe.elements) || (Array.isArray(maybe.nodes) && Array.isArray(maybe.objects));
}

function tryParseJsonString(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function extractSchemaCandidate(payload: Record<string, unknown>): unknown {
	const direct =
		payload.schemaData ??
		payload.schema ??
		payload.scheme ??
		payload.diagram ??
		payload.jsxgraphSchema ??
		payload.jsxGraphSchema;
	if (direct !== undefined) return tryParseJsonString(direct);

	const data = payload.data;
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		return extractSchemaCandidate(data as Record<string, unknown>);
	}
	return undefined;
}

function parseSchemaResult(rawText: string): {
	schemaData: SchemaData | SchemaDataV2;
	assumptions: string[];
	ambiguities: string[];
} {
	const fencedMatch = rawText.match(/```json\s*([\s\S]*?)```/i);
	const candidate = fencedMatch?.[1] ?? extractFirstJsonObject(rawText);
	if (!candidate) {
		throw new Error('Schema response is not valid JSON');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		throw new Error('Schema response JSON parsing failed');
	}

	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Schema response JSON must be an object');
	}

	// Fallback #1: model returned schema object directly as root.
	if (isLikelySchemaDataObject(parsed)) {
		const direct = parsed as unknown as Record<string, unknown>;
		return {
			schemaData: parsed,
			assumptions: normalizeStringArray(direct.assumptions),
			ambiguities: normalizeStringArray(direct.ambiguities)
		};
	}

	const payload = parsed as Record<string, unknown>;
	const schemaCandidate = extractSchemaCandidate(payload);
	if (!isLikelySchemaDataObject(schemaCandidate)) {
		const knownKeys = Object.keys(payload).slice(0, 12).join(', ');
		throw new Error(
			`Schema response is missing schemaData object (keys: ${knownKeys || 'none'})`
		);
	}

	return {
		schemaData: schemaCandidate,
		assumptions: normalizeStringArray(payload.assumptions),
		ambiguities: normalizeStringArray(payload.ambiguities)
	};
}

function parseIntentResult(
	rawText: string,
	options?: { baseIntent?: SchemeIntentV1 }
): {
	intent: SchemeIntentV1;
	assumptions: string[];
	ambiguities: string[];
} {
	const parsed = parseSchemeIntentResponse(rawText, {
		baseIntent: options?.baseIntent
	});
	return {
		intent: parsed.intent,
		assumptions: parsed.assumptions,
		ambiguities: parsed.ambiguities
	};
}

function parseUnderstandingResult(
	rawText: string,
	options?: { baseUnderstanding?: SchemeUnderstandingV1 }
): {
	understanding: SchemeUnderstandingV1;
	assumptions: string[];
	ambiguities: string[];
} {
	const parsed = parseSchemeUnderstandingResponse(rawText, {
		baseUnderstanding: options?.baseUnderstanding
	});
	return {
		understanding: parsed.understanding,
		assumptions: parsed.assumptions,
		ambiguities: parsed.ambiguities
	};
}

function attachInlineImage(
	messages: GeminiMessage[],
	imageData?: { base64: string; mimeType: string }
): GeminiMessage[] {
	if (!imageData || messages.length === 0) return messages;
	const next = messages.map((message) => ({
		...message,
		parts: [...message.parts]
	}));
	next[next.length - 1].parts.push({
		inlineData: { mimeType: imageData.mimeType, data: imageData.base64 }
	});
	return next;
}

async function generateSchemaStage(
	history: GeminiHistory[],
	systemPrompt: string,
	question: string,
	forcedModel?: string | null,
	options?: { useFlashChain?: boolean }
): Promise<{ parsed: { schemaData: SchemaData | SchemaDataV2; assumptions: string[]; ambiguities: string[] }; model: GeminiModel; tokens: number }> {
	const messages = buildContext(history, systemPrompt, question);
	const chain = options?.useFlashChain ? FLASH_CHAIN : PRO_CHAIN;
	const generation = await generateWithFallback(chain[0], chain, messages, forcedModel);
	return { parsed: parseSchemaResult(generation.text), model: generation.model, tokens: generation.tokens };
}

async function generateIntentStage(
	history: GeminiHistory[],
	systemPrompt: string,
	question: string,
	forcedModel?: string | null,
	options?: { useFlashChain?: boolean; baseIntent?: SchemeIntentV1 }
): Promise<{
	parsed: { intent: SchemeIntentV1; assumptions: string[]; ambiguities: string[] };
	model: GeminiModel;
	tokens: number;
}> {
	const messages = buildContext(history, systemPrompt, question);
	const chain = options?.useFlashChain ? FLASH_CHAIN : PRO_CHAIN;
	const generation = await generateWithFallback(chain[0], chain, messages, forcedModel);
	return {
		parsed: parseIntentResult(generation.text, {
			baseIntent: options?.baseIntent
		}),
		model: generation.model,
		tokens: generation.tokens
	};
}

function formatTokenAttribution(model: GeminiModel, stage: string, tokens: number): string {
	return `${model} (${stage}): ${tokens.toLocaleString('ru-RU')} tokens`;
}

function languagePolicy(userText: string): string {
	const detected = detectPromptLanguage(userText);
	if (detected === 'ru') {
		return 'Language policy: respond ONLY in Russian. Keep all explanations, assumptions, ambiguities, labels and any natural-language text in Russian.';
	}
	return 'Language policy: respond ONLY in English. Keep all explanations, assumptions, ambiguities, labels and any natural-language text in English.';
}

export async function routeQuestion(
	history: GeminiHistory[],
	userMessage: string,
	forcedModel?: string | null
): Promise<{ result: boolean; model: GeminiModel; tokens: number }> {
	const prompt =
		'Determine if the request requires mathematical/engineering computation. Reply with YES or NO only.';
	const messages = buildContext(history, prompt, `Question: ${userMessage}`);
	const { text, model, tokens } = await generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, messages, forcedModel);
	return { result: text.trim().toUpperCase().startsWith('YES'), model, tokens };
}

export async function generatePythonCode(
	history: GeminiHistory[],
	userMessage: string,
	retryContext?: string,
	forcedModel?: string | null,
	options?: { detailedSolution?: boolean }
): Promise<{ code: string; model: GeminiModel; tokens: number }> {
	const detailedSolution = options?.detailedSolution === true;
	const isSchemaCheckSolve = userMessage.includes('[APPROVED_SCHEMA_JSON]');
	const hasApprovedSchemeDescription = userMessage.includes('[APPROVED_SCHEME_DESCRIPTION]');
	const hasSolverModelContext = userMessage.includes('[SOLVER_MODEL_JSON]');
	const visualContract = isSchemaCheckSolve
		? `9. When approved schema context is present, choose ONE visual mode:
   - Graph mode: return "graphs" as described above.
   - Schema mode: return ONLY "schemaPatch" with keys:
     {"deleteObjectIds":[],"deleteResultIds":[],"addNodes":[],"addObjects":[],"addResults":[]}
10. For schemaPatch mode use delete+add operations only:
   - Never mutate existing objects/results inline.
   - Reusing an existing object/result id is allowed only if that id is listed in deleteObjectIds/deleteResultIds in the same output.
   - Do not output full schemaData in schema_check solve mode.`
		: `9. Choose visual output format by task:
   - For classic numeric plots/curves return "graphs".
   - For object-based engineering schemes/epures return "schemaData" (v2).
10. If "schemaData" is used, keep version "2.0" and use finite numbers only.`;
	const solverModelContract = hasSolverModelContext
		? `When [SOLVER_MODEL_JSON] is present, treat it as canonical mechanics semantics:
- member local axes/signs must come from solverModel, not inferred from screen projection.
- for cantilever beam members with axisOrigin="free_end", use x=0 at free end and increase toward fixed support.
- for frame tasks use requested component semantics (N,Vy,Vz,T,My,Mz) from solverModel.`
		: '';
	const schemeDescriptionContract = hasApprovedSchemeDescription
		? `When [APPROVED_SCHEME_DESCRIPTION] is present, treat it as the primary textual description of the approved scheme.
- Build equations and sign interpretation from this approved description first.
- Do not reinterpret topology from visual projection.
- If a detail is missing in the description, use [SOLVER_MODEL_JSON] and [APPROVED_SCHEMA_JSON] as canonical guardrails.`
		: '';
	const solverModelSection = solverModelContract ? `${solverModelContract}\n` : '';
	const schemeDescriptionSection = schemeDescriptionContract ? `${schemeDescriptionContract}\n` : '';
	const detailedSolutionContract = detailedSolution
		? `DETAILED-SOLUTION MODE IS ON. Critical rules:
The runtime provides a pre-defined "trace" object (class _SolutionTrace). Do NOT redefine or re-create it.
You MUST use trace calls for EVERY computation step:
- trace.section("Section title") — start a new logical section
- trace.note("explanation text") — explain reasoning or assumptions
- trace.define("variable_name", "expression_string", value=computed_value) — define a variable
- trace.equation("lhs", "rhs") or trace.equation("full_equation_string") — state an equation
- trace.solve("what we're solving for", "variable", computed_result) — show solution of equation
- trace.result("label", value) — declare a final or intermediate result

Workflow requirements:
1. Start with trace.section("Исходные данные") and use trace.define/trace.note for all given values.
2. Create a new trace.section for each major solution phase (e.g. "Реакции опор", "Эпюры", "Проверка").
3. Every symbolic/numeric computation MUST be preceded by trace.equation or trace.define.
4. Every final answer MUST use trace.result("Answer label", value).
5. In the final JSON output, ALWAYS include "solutionDoc": trace.export().
6. Never build manual AST dictionaries (no objects like {"type":"apply","op":"plus"...}).
7. Do not serialize tree nodes by hand.
8. trace.code() — use ONLY if user explicitly asks to see code.`
		: '';

	const systemPrompt = `You generate Python code for exact scientific computation.
Rules:
1. Use only: math, sympy, numpy, json.
2. Always print JSON using print(json.dumps({...})).
3. Do not draw text/ASCII graphs.
4. For plots/diagrams output graph points in key "graphs":
   "graphs": [{"title":"...","type":"function"|"diagram","memberId":"...", "diagramType":"N|Q|M|Vy|Vz|T|My|Mz|...", "epure":{"kind":"N|Q|M|custom","component":"N|Vy|Vz|T|My|Mz","fillHatch":true,"showSigns":true,"compressedFiberSide":"+n|-n","axisOrigin":"auto|free_end|fixed_end|member_start|member_end"}, "points":[{"x":...,"y":...}, ...]}]
5. For frame/truss/beam-system diagrams (epures), STRICT RULE: one graph object = one member (memberId). Never mix points from different members inside one graph.
6. For type="diagram", always provide non-empty memberId.
7. For epures always sort points by x ascending. If sign changes between neighboring samples, include a zero point at the crossing or sample densely enough that the renderer can reconstruct the crossing.
8. For diagrams representing epures, set epure.fillHatch=true and epure.showSigns=true by default.
9. For frame epures, ALWAYS provide epure.component from N|Vy|Vz|T|My|Mz and set epure.axisOrigin="member_start". For spatial frames do not use legacy Q/M as the primary component contract.
10. For moment epures in beam mode (diagramType/epure.kind = "M"), ALWAYS provide epure.compressedFiberSide as "+n" or "-n". Positive ordinates must correspond to the declared compressed-fiber side.
11. For a simple cantilever beam with exactly one fixed support, epure x=0 must be at the free end, increase toward the fixed support, and epure.axisOrigin must be "free_end".
12. Put primary numeric/text result in key "result".
13. Prefer sympy for exact math and numpy arrays for sampling points.
${detailedSolutionContract}
${visualContract}
${schemeDescriptionSection}${solverModelSection}${languagePolicy(userMessage)}`;

	let userContent = `Task: ${userMessage}`;
	if (retryContext) userContent += `\n\nFix this error context:\n${retryContext}`;

	const messages = buildContext(history, systemPrompt, userContent);
	const { text, model, tokens } = await generateWithFallback(PRO_CHAIN[0], PRO_CHAIN, messages, forcedModel);
	const codeMatch = text.match(/```python\n([\s\S]*?)```/);
	return { code: codeMatch ? codeMatch[1].trim() : text.trim(), model, tokens };
}

export async function assembleFinalAnswer(
	history: GeminiHistory[],
	params: { userMessage: string; executionResult: string },
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const prompt = `Provide the final solution in this structure: Given / Solution / Answer.
Use only these computed data: ${params.executionResult}
Use LaTeX for formulas. Do not include Python code.
Keep the answer concise and avoid repeating long condition text verbatim.
${languagePolicy(params.userMessage)}`;
	const messages = buildContext(history, prompt, `Task: ${params.userMessage}`);
	return generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, messages, forcedModel);
}

export async function answerGeneralQuestion(
	history: GeminiHistory[],
	userMessage: string,
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const prompt = `Answer clearly and academically. Use LaTeX where formulas are needed.
${languagePolicy(userMessage)}`;
	const messages = buildContext(history, prompt, `Question: ${userMessage}`);
	return generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, messages, forcedModel);
}

export async function analyzeImage(
	history: GeminiHistory[],
	base64Data: string,
	mimeType: string,
	forcedModel?: string | null,
	options?: { fastMode?: boolean }
): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const prompt =
		'Analyze the attached image. Extract the engineering/math task condition and describe the scheme relevant for solving. Return plain text only.';
	const messages = buildContext(history, prompt, '');
	messages[messages.length - 1].parts.push({ inlineData: { mimeType, data: base64Data } });
	const chain = options?.fastMode ? FAST_VISION_CHAIN : VISION_CHAIN;
	return generateWithFallback(chain[0], chain, messages, forcedModel);
}

export async function generateSchemeDescriptionFromFacts(
	history: GeminiHistory[],
	params: {
		factsJson: string;
		language: 'ru' | 'en';
		forcedModel?: string | null;
		fastMode?: boolean;
	}
): Promise<SchemeDescriptionGenerationResult> {
	const languageSeed = params.language === 'ru' ? 'Русский' : 'English';
	const prompt = `You are a scheme verbalizer.
You receive canonical scheme facts as JSON.
Return plain text only (no JSON, no code fences).
Do not invent new members, supports, loads, axes, signs, or results.
Produce concise structured text using short section headings and bullet points.
Allowed section pool:
- Scheme type
- Members and joints
- Supports and constraints
- Loads
- Requested results
- Assumptions
Rules:
- Include only sections that have meaningful data in the provided facts.
- Skip empty/placeholder sections; never print "not specified"/"none" stubs.
- Keep terms and labels consistent with the facts JSON.
- Keep assumptions concise and include them only if assumptions are non-empty.
Use the exact language requested: ${languageSeed}.`;

	const question = `[SCHEME_FACTS_JSON]\n${params.factsJson}`;
	const messages = buildContext(history, prompt, question);
	const chain = params.fastMode ? FAST_SCHEMA_CHAIN : FLASH_CHAIN;
	const generation = await generateWithFallback(chain[0], chain, messages, params.forcedModel);
	const description = generation.text.trim();
	if (!description) {
		throw new Error('Scheme description response is empty');
	}
	return {
		description,
		model: generation.model,
		tokens: generation.tokens
	};
}

export async function generateInitialSchemeUnderstanding(
	history: GeminiHistory[],
	userMessage: string,
	params?: {
		imageData?: { base64: string; mimeType: string };
		forcedModel?: string | null;
		fastMode?: boolean;
	}
): Promise<SchemeUnderstandingGenerationResult> {
	const useFastMode = params?.fastMode === true;
	const basePrompt = `You extract canonical scheme understanding for engineering mechanics.
Return STRICT JSON with keys: understanding, assumptions, ambiguities.
Do NOT return schemaData and do NOT solve the task.
understanding contract:
{
  "version": "understanding-1.0",
  "taskDomain": "mechanics",
  "structureKind": "beam|planar_frame|spatial_frame|planar_mechanism|spatial_mechanism",
  "modelSpace": "planar|spatial",
  "confidence": "high|medium|low",
  "source": { "hasImage": boolean, "language": "ru|en" },
  "joints": [{ "key": "...", "role": "start|end|corner|free_end|fixed_end|generic", "label": "..." }],
  "members": [{ "key": "...", "kind": "bar|cable|spring|damper", "startJoint": "...", "endJoint": "...", "relation": "horizontal|vertical|inclined|collinear_with_prev", "lengthHint": 3.5, "angleHintDeg": 30 }],
  "components": [{ "key": "...", "kind": "rigid_disk|cam", "centerJoint": "...", "radiusHint": 1.0, "profileHint": "...", "label": "..." }],
  "kinematicPairs": [{ "key": "...", "kind": "revolute_pair|prismatic_pair|slot_pair|cam_contact|gear_pair|belt_pair", "jointKey": "...", "memberKeys": ["..."], "componentKeys": ["..."], "guideHint": "horizontal|vertical|member_local", "meshType": "external|internal", "beltKind": "belt|chain", "crossed": false, "followerType": "knife|roller|flat", "label": "..." }],
  "supports": [{ "key": "...", "kind": "fixed_wall|hinge_fixed|hinge_roller|internal_hinge|slider", "jointKey": "...", "memberKey": "...", "s": 0.5, "sideHint": "left|right|top|bottom", "guideHint": "horizontal|vertical|member_local" }],
  "loads": [{ "key": "...", "kind": "force|moment|distributed", "target": {"jointKey":"..."} | {"memberKey":"...","s":0.5} | {"memberKey":"...","fromS":0.2,"toS":0.8}, "directionHint": "up|down|left|right|+x|-x|+y|-y|cw|ccw|member_local_positive|member_local_negative", "magnitudeHint": 10, "distributionKind": "uniform|linear|trapezoid" }],
  "requestedResults": [{ "targetMemberKey": "...", "kind": "N|Q|M|Vy|Vz|T|My|Mz" }],
  "assumptions": [],
  "ambiguities": []
}
Rules:
1) Extract semantics from user task and attached image jointly in one pass.
2) If uncertain, preserve ambiguity explicitly instead of inventing detail.
3) Keep keys stable and concise.
4) Keep language of assumptions/ambiguities consistent with user task.
5) Every joint/member/component/kinematic pair must have a non-empty label. If the task uses names like A, B, OA, AB, preserve them in labels.
6) For slider-crank, connect crank and rod with revolute_pair and connect slider with prismatic_pair.
7) If a support is attached by memberKey, always provide s in [0,1]. For end supports on a beam, use s=0 or s=1 instead of omitting it.
${languagePolicy(userMessage)}`;

	const question = `Task:\n${userMessage}`;
	const baseMessages = buildContext(history, basePrompt, question);
	const messages = attachInlineImage(baseMessages, params?.imageData);
	const chain = params?.imageData
		? useFastMode
			? FAST_VISION_CHAIN
			: VISION_CHAIN
		: useFastMode
			? FAST_SCHEMA_CHAIN
			: FLASH_CHAIN;
	const generation = await generateWithFallback(chain[0], chain, messages, params?.forcedModel);
	const parsed = parseUnderstandingResult(generation.text);
	return {
		...parsed,
		model: generation.model,
		tokens: generation.tokens,
		usedModels: [formatTokenAttribution(generation.model, 'UnderstandingGen', generation.tokens)]
	};
}

export async function reviseSchemeUnderstanding(
	history: GeminiHistory[],
	params: {
		originalPrompt: string;
		currentUnderstanding: SchemeUnderstandingV1;
		revisionNotes: string;
		forcedModel?: string | null;
		fastMode?: boolean;
	}
): Promise<SchemeUnderstandingGenerationResult> {
	const languageSeed = `${params.originalPrompt}\n${params.revisionNotes}`;
	const prompt = `You revise canonical scheme understanding for engineering mechanics.
Return STRICT JSON with keys: understanding, assumptions, ambiguities.
Do NOT return schemaData and do NOT solve the task.
Apply revision notes precisely and preserve valid unchanged semantics.
If a revision note is ambiguous, keep previous meaning and add ambiguity entry.
${languagePolicy(languageSeed)}`;

	const question = `Original task:\n${params.originalPrompt}\n\nCurrent understanding JSON:\n${JSON.stringify(
		params.currentUnderstanding,
		null,
		2
	)}\n\nRevision notes:\n${params.revisionNotes}`;

	const messages = buildContext(history, prompt, question);
	const chain = params.fastMode ? FLASH_CHAIN : PRO_CHAIN;
	const generation = await generateWithFallback(chain[0], chain, messages, params.forcedModel);
	const parsed = parseUnderstandingResult(generation.text, {
		baseUnderstanding: params.currentUnderstanding
	});
	return {
		...parsed,
		model: generation.model,
		tokens: generation.tokens,
		usedModels: [formatTokenAttribution(generation.model, 'UnderstandingRevision', generation.tokens)]
	};
}

export async function generateInitialIntent(
	history: GeminiHistory[],
	userMessage: string,
	params?: {
		imageData?: { base64: string; mimeType: string };
		forcedModel?: string | null;
		fastMode?: boolean;
	}
): Promise<IntentGenerationResult> {
	let contextMessage = userMessage;
	const usedModels: string[] = [];
	const useFastMode = params?.fastMode === true;

	if (params?.imageData) {
		const vision = await analyzeImage(
			history,
			params.imageData.base64,
			params.imageData.mimeType,
			params.forcedModel,
			{ fastMode: useFastMode }
		);
		usedModels.push(formatTokenAttribution(vision.model, 'Vision', vision.tokens));
		contextMessage = `[IMAGE_DESCRIPTION]\n${vision.text}\n\n[USER_TASK]\n${userMessage}`;
	}

	const basePrompt = `You extract semantic intent for an engineering mechanics scheme.
Return STRICT JSON with keys: intent, assumptions, ambiguities.
Do NOT return schemaData.
Do NOT return nodeRefs, node ids, render coordinates, geometry.baseLine.startNodeId/endNodeId, JSXGraph data, or final object ids.
intent contract:
{
  "version": "intent-1.0",
  "taskDomain": "mechanics",
  "structureKind": "beam|planar_frame|spatial_frame|planar_mechanism|spatial_mechanism",
  "modelSpace": "planar|spatial",
  "confidence": "high|medium|low",
  "source": { "hasImage": boolean, "language": "ru|en" },
  "joints": [{ "key": "...", "role": "start|end|corner|free_end|fixed_end|generic", "label": "..." }],
  "members": [{ "key": "...", "kind": "bar|cable|spring|damper", "startJoint": "...", "endJoint": "...", "relation": "horizontal|vertical|inclined|collinear_with_prev", "lengthHint": 3.5, "angleHintDeg": 30 }],
  "components": [{ "key": "...", "kind": "rigid_disk|cam", "centerJoint": "...", "radiusHint": 1.0, "profileHint": "...", "label": "..." }],
  "kinematicPairs": [{ "key": "...", "kind": "revolute_pair|prismatic_pair|slot_pair|cam_contact|gear_pair|belt_pair", "jointKey": "...", "memberKeys": ["..."], "componentKeys": ["..."], "guideHint": "horizontal|vertical|member_local", "meshType": "external|internal", "beltKind": "belt|chain", "crossed": false, "followerType": "knife|roller|flat", "label": "..." }],
  "supports": [{ "key": "...", "kind": "fixed_wall|hinge_fixed|hinge_roller|internal_hinge|slider", "jointKey": "...", "memberKey": "...", "s": 0.5, "sideHint": "left|right|top|bottom", "guideHint": "horizontal|vertical|member_local" }],
  "loads": [{ "key": "...", "kind": "force|moment|distributed", "target": {"jointKey":"..."} | {"memberKey":"...","s":0.5} | {"memberKey":"...","fromS":0.2,"toS":0.8}, "directionHint": "up|down|left|right|+x|-x|+y|-y|cw|ccw|member_local_positive|member_local_negative", "magnitudeHint": 10, "distributionKind": "uniform|linear|trapezoid" }],
  "requestedResults": [{ "targetMemberKey": "...", "kind": "N|Q|M|Vy|Vz|T|My|Mz" }],
  "assumptions": [],
  "ambiguities": []
}
Rules:
1) Keep joint/member/support/load keys stable and semantic.
2) If uncertain, put uncertainty into ambiguities instead of guessing.
3) Keep assumptions/ambiguities concise and language-consistent with the user.
4) Beam default result set is N/Q/M, planar frame N/Vy/Mz, spatial frame N/Vy/Vz/T/My/Mz.
5) Spatial frame/mechanism must set modelSpace="spatial"; beam/planar frame/mechanism must set modelSpace="planar".
6) Every joint/member/component/kinematic pair must include label.
7) For slider-crank, always use revolute_pair between crank and rod.
8) If a support is attached by memberKey, always provide s in [0,1]. For end supports on a beam, use s=0 or s=1 instead of omitting it.
${languagePolicy(userMessage)}`;

	if (useFastMode) {
		const question = `Extract initial scheme intent for this task:\n${contextMessage}`;
		const messages = buildContext(history, `${basePrompt}\nFast mode: answer in one pass.`, question);
		const generation = await generateWithFallback(
			FAST_SCHEMA_CHAIN[0],
			FAST_SCHEMA_CHAIN,
			messages,
			params?.forcedModel
		);
		const parsed = parseIntentResult(generation.text);
		usedModels.push(formatTokenAttribution(generation.model, 'IntentGen-Fast', generation.tokens));
		return {
			...parsed,
			model: generation.model,
			tokens: generation.tokens,
			usedModels
		};
	}

	const stageA = await generateIntentStage(
		history,
		`${basePrompt}\nStage A objective: extract only semantic structure and topology assumptions.`,
		`Task:\n${contextMessage}`,
		params?.forcedModel
	);
	usedModels.push(formatTokenAttribution(stageA.model, 'IntentGen-A', stageA.tokens));

	const stageB = await generateIntentStage(
		history,
		`${basePrompt}\nStage B objective: self-check and correct only contract violations in intent.`,
		`Task:\n${contextMessage}\n\nCandidate intent:\n${JSON.stringify(stageA.parsed.intent, null, 2)}`,
		params?.forcedModel
	);
	usedModels.push(formatTokenAttribution(stageB.model, 'IntentGen-B', stageB.tokens));

	return {
		...stageB.parsed,
		model: stageB.model,
		tokens: stageA.tokens + stageB.tokens,
		usedModels
	};
}

export async function reviseIntent(
	history: GeminiHistory[],
	params: {
		originalPrompt: string;
		currentIntent: SchemeIntentV1;
		revisionNotes: string;
		forcedModel?: string | null;
		fastMode?: boolean;
	}
): Promise<IntentGenerationResult> {
	const languageSeed = `${params.originalPrompt}\n${params.revisionNotes}`;
	const useFlashChain = params.fastMode === true;

	const prompt = `You revise semantic SchemeIntent only.
Return STRICT JSON with keys: intent, assumptions, ambiguities.
Do NOT generate schemaData, nodeRefs, ids for render objects, or coordinates.
Keep valid semantic keys and structure where possible.
Apply revision notes precisely.
If a revision note is ambiguous, keep previous intent and add ambiguity entry.
${languagePolicy(languageSeed)}`;

	const question = `Original task:\n${params.originalPrompt}\n\nCurrent intent JSON:\n${JSON.stringify(
		params.currentIntent,
		null,
		2
	)}\n\nUser revision notes:\n${params.revisionNotes}`;
	const messages = buildContext(history, prompt, question);
	const chain = useFlashChain ? FLASH_CHAIN : PRO_CHAIN;
	const generation = await generateWithFallback(chain[0], chain, messages, params.forcedModel);
	const parsedRevision = parseIntentResult(generation.text, {
		baseIntent: params.currentIntent
	});

	if (params.fastMode) {
		return {
			...parsedRevision,
			model: generation.model,
			tokens: generation.tokens,
			usedModels: [formatTokenAttribution(generation.model, 'IntentRevision-Fast', generation.tokens)]
		};
	}

	const stage2 = await generateIntentStage(
		history,
		`You perform final intent self-check.
Return STRICT JSON with keys: intent, assumptions, ambiguities.
Fix only intent-contract violations and keep semantics stable.
${languagePolicy(languageSeed)}`,
		`Original task:\n${params.originalPrompt}\n\nRevision notes:\n${params.revisionNotes}\n\nCandidate revised intent:\n${JSON.stringify(
			parsedRevision.intent,
			null,
			2
		)}`,
		params.forcedModel,
		{ useFlashChain, baseIntent: params.currentIntent }
	);

	return {
		...stage2.parsed,
		model: stage2.model,
		tokens: generation.tokens + stage2.tokens,
		usedModels: [
			formatTokenAttribution(generation.model, 'IntentRevision', generation.tokens),
			formatTokenAttribution(stage2.model, 'IntentRevision-SelfCheck', stage2.tokens)
		]
	};
}

export async function repairIntentByIssues(
	history: GeminiHistory[],
	params: {
		originalPrompt: string;
		currentIntent: SchemeIntentV1;
		issues: string[];
		forcedModel?: string | null;
		fastMode?: boolean;
		skipSelfCheck?: boolean;
	}
): Promise<IntentGenerationResult> {
	const issuesText = params.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n');
	const languageSeed = `${params.originalPrompt}\n${issuesText}`;
	const useFlashChain = params.fastMode === true;

	const prompt = `You are a SchemeIntent repair worker.
Return STRICT JSON with keys: intent, assumptions, ambiguities.
Repair ONLY the listed issues, preserve valid semantic intent, do not invent unrelated changes.
Never output schemaData or render-level fields.
${languagePolicy(languageSeed)}`;

	const question = `Original task:\n${params.originalPrompt}\n\nIssues to fix:\n${issuesText}\n\nCurrent intent JSON:\n${JSON.stringify(
		params.currentIntent,
		null,
		2
	)}`;
	const messages = buildContext(history, prompt, question);
	const chain = useFlashChain ? FLASH_CHAIN : PRO_CHAIN;
	const stage1 = await generateWithFallback(chain[0], chain, messages, params.forcedModel);
	const parsedStage1 = parseIntentResult(stage1.text, {
		baseIntent: params.currentIntent
	});

	if (params.skipSelfCheck) {
		return {
			...parsedStage1,
			model: stage1.model,
			tokens: stage1.tokens,
			usedModels: [formatTokenAttribution(stage1.model, 'IntentRepair-Fast', stage1.tokens)]
		};
	}

	const stage2 = await generateIntentStage(
		history,
		`You perform final targeted self-check for SchemeIntent.
Return STRICT JSON with keys: intent, assumptions, ambiguities.
Keep only issue-driven changes.
${languagePolicy(languageSeed)}`,
		`Issues:\n${issuesText}\n\nCandidate intent:\n${JSON.stringify(parsedStage1.intent, null, 2)}`,
		params.forcedModel,
		{ useFlashChain, baseIntent: params.currentIntent }
	);

	return {
		...stage2.parsed,
		model: stage2.model,
		tokens: stage1.tokens + stage2.tokens,
		usedModels: [
			formatTokenAttribution(stage1.model, 'IntentRepair', stage1.tokens),
			formatTokenAttribution(stage2.model, 'IntentRepair-SelfCheck', stage2.tokens)
		]
	};
}

export async function generateInitialSchema(
	history: GeminiHistory[],
	userMessage: string,
	params?: {
		imageData?: { base64: string; mimeType: string };
		forcedModel?: string | null;
		fastMode?: boolean;
	}
): Promise<SchemaGenerationResult> {
	let contextMessage = userMessage;
	const usedModels: string[] = [];
	const useFastMode = params?.fastMode === true;

	if (params?.imageData) {
		const vision = await analyzeImage(history, params.imageData.base64, params.imageData.mimeType, params.forcedModel, {
			fastMode: useFastMode
		});
		usedModels.push(formatTokenAttribution(vision.model, 'Vision', vision.tokens));
		contextMessage = `[IMAGE_DESCRIPTION]\n${vision.text}\n\n[USER_TASK]\n${userMessage}`;
	}

const baseInstruction = `You build ONLY engineering schema data and must not solve the task.
Return strict JSON object with keys: schemaData, assumptions, ambiguities.
schemaData MUST be version "2.0" with root keys:
{
  "version":"2.0",
  "meta":{"taskDomain":"mechanics","catalogVersion":"2026-04-11","layoutPipeline":"topology-first","structureKind":"beam|planar_frame|spatial_frame|planar_mechanism|spatial_mechanism"},
  "coordinateSystem":{"xUnit":"m","yUnit":"m","zUnit":"m","origin":{"x":0,"y":0},"modelSpace":"planar|spatial","axisOrientation":"right-handed","originPolicy":"auto|left_support|fixed_support|centroid","planeNormal":{"x":0,"y":0,"z":1},"referenceUp":{"x":0,"y":0,"z":1},"secondaryReference":{"x":1,"y":0,"z":0},"projectionPreset":"auto_isometric|xy|xz|yz"},
  "nodes": [],
  "objects": [],
  "results": [],
  "annotations": [],
  "assumptions": [],
  "ambiguities": []
}
Allowed object types for schemaData.objects: bar, cable, spring, damper, rigid_disk, cam, fixed_wall, hinge_fixed, hinge_roller, internal_hinge, slider, revolute_pair, prismatic_pair, slot_pair, cam_contact, gear_pair, belt_pair, force, moment, distributed, velocity, acceleration, angular_velocity, angular_acceleration, trajectory, label, dimension, axis, ground.
Result types for schemaData.results: epure, trajectory, label, dimension, axis.
Do NOT place epure into schemaData.objects; epure must be in schemaData.results only.
Every object MUST contain non-empty id, type, geometry object.
Use nodeRefs to reference node ids from nodes array.
Topology-first policy: your primary responsibility is structure and constraints, not final absolute coordinates.
Coordinates are only a coarse scaffold and may be overridden by deterministic backend layout.
For linear members (bar/cable/spring/damper/axis/ground), include geometry.length and geometry.angleDeg or geometry.constraints.
geometry.constraints object may include: collinearWith[], parallelTo[], perpendicularTo[], mirrorOf.
For frame/mechanism problems, set meta.structureKind and coordinateSystem.modelSpace explicitly:
- beam -> structureKind="beam", modelSpace="planar"
- planar frame -> structureKind="planar_frame", modelSpace="planar", include planeNormal
- spatial frame -> structureKind="spatial_frame", modelSpace="spatial", include referenceUp (and secondaryReference fallback)
- planar mechanism -> structureKind="planar_mechanism", modelSpace="planar"
- spatial mechanism -> structureKind="spatial_mechanism", modelSpace="spatial", include referenceUp
For spatial frame nodes include z coordinates where needed.
For supports and loads, always bind to existing member nodes via nodeRefs (never default to origin).
For mechanism kinematic pairs, use canonical objects: revolute_pair, prismatic_pair, slot_pair, cam_contact, gear_pair, belt_pair.
For force/distributed/velocity/acceleration ALWAYS provide explicit direction:
- prefer geometry.directionAngle in degrees
- or geometry.direction vector {x,y}
- or geometry.cardinal (up/down/left/right)
Never omit load direction fields.
For support/load/moment placement on members, prefer geometry.attach: {memberId, s, side, offset}.
For fixed_wall use geometry.wallSide = left|right|top|bottom when side semantics matter.
If exact dimensions are unknown, keep consistent relative lengths and positions.
For distributed, include geometry.kind and geometry.intensity.
For moment/angular types, geometry.direction MUST be exactly "cw" or "ccw".
For epure results, include geometry.fillHatch=true and geometry.showSigns=true.
Beam epures: include geometry.kind and geometry.axisOrigin when the reference end is known.
Frame epures: ALWAYS include geometry.component from N|Vy|Vz|T|My|Mz and geometry.axisOrigin="member_start".
For moment epure kind "M", ALWAYS include geometry.compressedFiberSide as "+n" or "-n".
For planar_frame legacy mapping is allowed only as fallback: N->N, Q->Vy, M->Mz.
For spatial_frame do not use legacy Q/M as the primary contract; provide explicit component.
For a simple cantilever beam with one fixed_wall at one bar end, epure geometry.axisOrigin MUST be "free_end" and geometry.values/baseLine must run from the free end toward the fixed support.
Do NOT place all supports/loads at (0,0) by default.
Preserve language of assumptions/ambiguities according to user request.
If a joint/member/component/pair is mentioned in textual description, it must have visible label in schema.
${languagePolicy(userMessage)}`;

	if (useFastMode) {
		const fastPrompt = `${baseInstruction}
Fast mode objective: produce a valid schema in a single pass.
Prioritize contract validity (ids, nodeRefs, geometry object, required fields) and structural correctness.
Do not run multi-stage refinement; output the best valid result immediately.`;
		const fastQuestion = `Task for scheme generation:\n${contextMessage}`;
		const fastMessages = buildContext(history, fastPrompt, fastQuestion);
		const fastStage = await generateWithFallback(
			FAST_SCHEMA_CHAIN[0],
			FAST_SCHEMA_CHAIN,
			fastMessages,
			params?.forcedModel
		);
		const fastParsed = parseSchemaResult(fastStage.text);
		usedModels.push(formatTokenAttribution(fastStage.model, 'SchemaGen-Fast', fastStage.tokens));
		return {
			...fastParsed,
			model: fastStage.model,
			tokens: fastStage.tokens,
			usedModels
		};
	}

	const stageAPrompt = `${baseInstruction}
Stage A objective: create topology and constraints first.
At this stage, prioritize node connectivity, object-node linkage, and member constraints.
Avoid spending effort on decorative absolute coordinates.`;
	const stageAQuestion = `Task for scheme generation (Stage A):\n${contextMessage}`;
	const stageA = await generateSchemaStage(history, stageAPrompt, stageAQuestion, params?.forcedModel);
	usedModels.push(formatTokenAttribution(stageA.model, 'SchemaGen-A', stageA.tokens));

	const stageASchemaJson = JSON.stringify(stageA.parsed.schemaData, null, 2);
	const stageBPrompt = `${baseInstruction}
Stage B objective: refine geometry/style/details using prepared skeleton.
Keep existing node ids and object ids stable where possible.
Do not remove valid supports/loads/moments detected in task.
Treat node coordinates as a coarse scaffold, not as decorative absolute values.
Prefer structural constraints in geometry/meta (length, angleDeg, constraints, attach) over arbitrary coordinates.
Fill canonical geometry per type:
- bar/cable/spring/damper/axis/dimension/ground: use nodeRefs [start,end]
- fixed_wall/hinge_fixed/hinge_roller/internal_hinge/label: use nodeRefs [node]
- fixed_wall may include wallSide left|right|top|bottom
- slider: nodeRefs [node, guideStart, guideEnd]
- revolute_pair: nodeRefs [node]
- prismatic_pair/slot_pair: nodeRefs [node, guideStart, guideEnd]
- rigid_disk/cam: nodeRefs [center] + radius
- cam_contact/gear_pair/belt_pair: nodeRefs [firstRefNode, secondRefNode]
- force/velocity/acceleration: nodeRefs [node] + direction (+ attach for member-relative placement)
- moment: nodeRefs [node] + direction cw|ccw (+ optional magnitude or label)
- distributed: nodeRefs [start,end] + kind + intensity + direction
- trajectory: geometry.points array
- epure (if present): put into results with baseLine + values + fillHatch + showSigns
- beam epure: include kind + axisOrigin (+ compressedFiberSide for kind "M")
- frame epure: include component (N|Vy|Vz|T|My|Mz) + axisOrigin="member_start"
- if textual description names points/members/components/pairs, preserve matching labels in nodes/objects`;
	const stageBQuestion = `Task context:\n${contextMessage}\n\nStage A schema JSON:\n${stageASchemaJson}\n\nNow return finalized schemaData v2.`;
	const stageB = await generateSchemaStage(history, stageBPrompt, stageBQuestion, params?.forcedModel);
	usedModels.push(formatTokenAttribution(stageB.model, 'SchemaGen-B', stageB.tokens));

	const stageBSchemaJson = JSON.stringify(stageB.parsed.schemaData, null, 2);
	const stageCPrompt = `${baseInstruction}
Stage C objective: perform self-check and return corrected schema.
Self-check rules:
1) all nodeRefs must reference existing nodes
2) object ids must be unique and non-empty
3) no unsupported type names
4) avoid coordinate collapse unless explicitly requested
5) keep physical meaning from task and keep prior valid details`;
	const stageCQuestion = `Task context:\n${contextMessage}\n\nCandidate schema JSON:\n${stageBSchemaJson}\n\nReturn corrected final schemaData v2.`;
	const stageC = await generateSchemaStage(history, stageCPrompt, stageCQuestion, params?.forcedModel);
	usedModels.push(formatTokenAttribution(stageC.model, 'SchemaGen-C', stageC.tokens));

	const parsed = stageC.parsed;
	const totalTokens = stageA.tokens + stageB.tokens + stageC.tokens;
	const finalModel = stageC.model;

	return {
		...parsed,
		model: finalModel,
		tokens: totalTokens,
		usedModels
	};
}

export async function reviseSchema(
	history: GeminiHistory[],
	params: {
		originalPrompt: string;
		currentSchema: SchemaData | SchemaDataV2;
		revisionNotes: string;
		forcedModel?: string | null;
		fastMode?: boolean;
	}
): Promise<SchemaGenerationResult> {
	const languageSeed = `${params.originalPrompt}\n${params.revisionNotes}`;
	const useFlashChain = params.fastMode === true;
const prompt = `You revise ONLY the engineering scheme and must not solve the task.
Return strict JSON object with keys: schemaData, assumptions, ambiguities.
Preserve correct existing elements and update only what is needed per revision notes.
Keep schemaData.version = "2.0" and finite numbers.
Use ONLY object types from catalog v2:
bar, cable, spring, damper, rigid_disk, cam, fixed_wall, hinge_fixed, hinge_roller, internal_hinge, slider, revolute_pair, prismatic_pair, slot_pair, cam_contact, gear_pair, belt_pair, force, moment, distributed, velocity, acceleration, angular_velocity, angular_acceleration, trajectory, epure, label, dimension, axis, ground.
Use nodeRefs to bind all objects to nodes.
If epure is needed, place it in schemaData.results, not in schemaData.objects.
For epure visuals, default to geometry.fillHatch=true and geometry.showSigns=true unless the task explicitly asks otherwise.
For frame tasks keep explicit structure metadata: meta.structureKind and coordinateSystem.modelSpace.
For planar_frame include coordinateSystem.planeNormal.
For spatial_frame include coordinateSystem.referenceUp (and secondaryReference fallback) and keep needed node z values.
For frame epures, use geometry.component (N|Vy|Vz|T|My|Mz) and geometry.axisOrigin="member_start".
For moment epure kind "M", ALWAYS include geometry.compressedFiberSide as "+n" or "-n".
For a simple cantilever beam with one fixed_wall at one bar end, keep epure geometry.axisOrigin="free_end" and orient the epure from the free end toward the fixed support.
For force/distributed/velocity/acceleration include explicit direction (directionAngle or direction vector or cardinal).
Keep physically meaningful scale/proportions; avoid coordinate collapse and avoid decorative coordinates.
Prefer coordinates in range [-10, 10] and preserve consistent relative lengths.
For linear members include geometry.length and geometry.angleDeg or geometry.constraints.
Use geometry.constraints (collinearWith, parallelTo, perpendicularTo, mirrorOf) when relation is known.
Use geometry.attach for member-relative placement when loads/supports should be attached by parameter s.
For fixed_wall side semantics use geometry.wallSide=left|right|top|bottom.
For supports/loads always attach to member nodes (nodeRefs) instead of origin defaults.
For distributed include kind + intensity + direction.
For moment/angular include direction "cw" | "ccw".
Preserve existing coordinates unless revision notes explicitly request moving elements.
Do NOT collapse supports/loads/moments to (0,0) unless the user explicitly requests coincidence at the origin.
Every object MUST include geometry object and non-empty unique id.
When textual description names points or members, keep corresponding node/object labels visible and consistent.
${languagePolicy(languageSeed)}`;

	const currentSchemaJson = JSON.stringify(params.currentSchema, null, 2);
	const question = `Original task:\n${params.originalPrompt}\n\nCurrent schema JSON:\n${currentSchemaJson}\n\nUser revision notes:\n${params.revisionNotes}`;
	const messages = buildContext(history, prompt, question);

	const generationChain = useFlashChain ? FLASH_CHAIN : PRO_CHAIN;
	const generation = await generateWithFallback(generationChain[0], generationChain, messages, params.forcedModel);
	const parsedRevision = parseSchemaResult(generation.text);
	if (params.fastMode) {
		return {
			...parsedRevision,
			model: generation.model,
			tokens: generation.tokens,
			usedModels: [formatTokenAttribution(generation.model, 'SchemaRevision-Fast', generation.tokens)]
		};
	}
	const stage2Prompt = `You perform final schema self-check for contract v2.
Return strict JSON object with keys: schemaData, assumptions, ambiguities.
Keep same physical meaning and ids where valid.
Fix only structural issues: invalid/missing nodeRefs, wrong type names, empty ids, malformed geometry.
${languagePolicy(languageSeed)}`;
	const stage2Question = `Original task:\n${params.originalPrompt}\n\nRevision notes:\n${params.revisionNotes}\n\nCandidate revised schema:\n${JSON.stringify(parsedRevision.schemaData, null, 2)}`;
	const stage2 = await generateSchemaStage(history, stage2Prompt, stage2Question, params.forcedModel, {
		useFlashChain
	});

	return {
		...stage2.parsed,
		model: stage2.model,
		tokens: generation.tokens + stage2.tokens,
		usedModels: [
			formatTokenAttribution(generation.model, 'SchemaRevision', generation.tokens),
			formatTokenAttribution(stage2.model, 'SchemaRevision-SelfCheck', stage2.tokens)
		]
	};
}

export async function repairSchemaByIssues(
	history: GeminiHistory[],
	params: {
		originalPrompt: string;
		currentSchema: SchemaData | SchemaDataV2;
		issues: string[];
		forcedModel?: string | null;
		fastMode?: boolean;
		skipSelfCheck?: boolean;
	}
): Promise<SchemaGenerationResult> {
	const languageSeed = `${params.originalPrompt}\n${params.issues.join('\n')}`;
	const issuesText = params.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n');
	const useFlashChain = params.fastMode === true;

	const prompt = `You are a schema repair worker for contract v2.
Return strict JSON object with keys: schemaData, assumptions, ambiguities.
Repair ONLY the listed issues while preserving valid ids, nodeRefs, and unaffected structure.
Do not solve the task. Do not rewrite the schema from scratch.
Focus on topology and constraints:
- linear members should have geometry.length and geometry.angleDeg or geometry.constraints
- supports/loads should be attached via nodeRefs and, when needed, geometry.attach
- force/distributed/velocity/acceleration must keep explicit direction fields
- fixed_wall may use geometry.wallSide
- keep meta.structureKind and coordinateSystem.modelSpace consistent with the task type
- frame epures should preserve geometry.component + geometry.axisOrigin="member_start"
- beam epures should preserve geometry.kind + geometry.axisOrigin, and for kind "M" geometry.compressedFiberSide
Keep schemaData.version = "2.0" and finite numbers.
Keep epure entries only in schemaData.results (never in schemaData.objects).
${languagePolicy(languageSeed)}`;

	const question = `Original task:\n${params.originalPrompt}\n\nIssues to fix:\n${issuesText}\n\nCurrent schema JSON:\n${JSON.stringify(params.currentSchema, null, 2)}`;
	const messages = buildContext(history, prompt, question);
	const chain = useFlashChain ? FLASH_CHAIN : PRO_CHAIN;
	const stage1 = await generateWithFallback(chain[0], chain, messages, params.forcedModel);
	const stage1Parsed = parseSchemaResult(stage1.text);
	if (params.skipSelfCheck) {
		return {
			...stage1Parsed,
			model: stage1.model,
			tokens: stage1.tokens,
			usedModels: [formatTokenAttribution(stage1.model, 'SchemaRepair-Fast', stage1.tokens)]
		};
	}

	const stage2Prompt = `You perform final targeted self-check for schema contract v2.
Return strict JSON object with keys: schemaData, assumptions, ambiguities.
Keep only issue-driven changes and preserve previously valid structure.
${languagePolicy(languageSeed)}`;
	const stage2Question = `Issues:\n${issuesText}\n\nCandidate schema:\n${JSON.stringify(stage1Parsed.schemaData, null, 2)}`;
	const stage2 = await generateSchemaStage(history, stage2Prompt, stage2Question, params.forcedModel, {
		useFlashChain
	});

	return {
		...stage2.parsed,
		model: stage2.model,
		tokens: stage1.tokens + stage2.tokens,
		usedModels: [
			formatTokenAttribution(stage1.model, 'SchemaRepair', stage1.tokens),
			formatTokenAttribution(stage2.model, 'SchemaRepair-SelfCheck', stage2.tokens)
		]
	};
}
