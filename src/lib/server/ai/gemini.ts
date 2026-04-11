/**
 * gemini.ts
 * Thin wrapper around Gemini API.
 */
import { GEMINI_API_KEY } from '$env/static/private';
import { GoogleGenAI } from '@google/genai';
import type { SchemaData } from '$lib/schema/schema-data.js';

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
	schemaData: SchemaData;
	assumptions: string[];
	ambiguities: string[];
	model: GeminiModel;
	tokens: number;
	usedModels: string[];
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

async function generate(model: GeminiModel, messages: GeminiMessage[]): Promise<{ text: string; tokens: number }> {
	const response = await ai.models.generateContent({ model, contents: messages });
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
	const effectiveChain =
		forcedModel && forcedModel !== 'auto'
			? [forcedModel as GeminiModel]
			: chain.indexOf(startModel) >= 0
				? chain.slice(chain.indexOf(startModel))
				: chain;

	for (let i = 0; i < effectiveChain.length; i++) {
		const model = effectiveChain[i];
		try {
			const { text, tokens } = await generate(model, messages);
			console.log(`[Gemini] Using: ${model}${forcedModel && forcedModel !== 'auto' ? ' (FORCED)' : ''}`);
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

function parseSchemaResult(rawText: string): { schemaData: SchemaData; assumptions: string[]; ambiguities: string[] } {
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

	const payload = parsed as { schemaData?: SchemaData; assumptions?: unknown; ambiguities?: unknown };
	if (!payload.schemaData || typeof payload.schemaData !== 'object') {
		throw new Error('Schema response is missing schemaData object');
	}

	return {
		schemaData: payload.schemaData,
		assumptions: normalizeStringArray(payload.assumptions),
		ambiguities: normalizeStringArray(payload.ambiguities)
	};
}

function formatTokenAttribution(model: GeminiModel, stage: string, tokens: number): string {
	return `${model} (${stage}): ${tokens.toLocaleString('ru-RU')} tokens`;
}

function extractLanguageSignalText(userText: string): string {
	const approvedSchemaMarker = '[APPROVED_SCHEMA_JSON]';
	const approvedSchemaIndex = userText.indexOf(approvedSchemaMarker);
	if (approvedSchemaIndex >= 0) {
		return userText.slice(0, approvedSchemaIndex).trim();
	}

	const userTaskMarker = '[USER_TASK]';
	const userTaskIndex = userText.indexOf(userTaskMarker);
	if (userTaskIndex >= 0) {
		return userText.slice(userTaskIndex + userTaskMarker.length).trim();
	}

	return userText;
}

function detectPromptLanguage(userText: string): 'ru' | 'en' {
	const signalText = extractLanguageSignalText(userText);
	const cyrillicCount = (signalText.match(/[А-Яа-яЁё]/g) ?? []).length;
	const latinCount = (signalText.match(/[A-Za-z]/g) ?? []).length;

	if (cyrillicCount === 0 && latinCount === 0) return 'en';
	return cyrillicCount >= latinCount * 0.6 ? 'ru' : 'en';
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
	forcedModel?: string | null
): Promise<{ code: string; model: GeminiModel; tokens: number }> {
	const systemPrompt = `You generate Python code for exact scientific computation.
Rules:
1. Use only: math, sympy, numpy, json.
2. Always print JSON using print(json.dumps({...})).
3. Do not draw text/ASCII graphs.
4. For plots/diagrams output graph points in key "graphs":
   "graphs": [{"title":"...","type":"function"|"diagram","points":[{"x":...,"y":...}, ...]}]
5. Put primary numeric/text result in key "result".
6. Prefer sympy for exact math and numpy arrays for sampling points.
7. ${languagePolicy(userMessage)}`;

	let userContent = `Task: ${userMessage}`;
	if (retryContext) userContent += `\n\nFix this error context:\n${retryContext}`;

	const messages = buildContext(history, systemPrompt, userContent);
	const { text, model, tokens } = await generateWithFallback(PRO_CHAIN[0], PRO_CHAIN, messages, forcedModel);
	const codeMatch = text.match(/```python\n([\s\S]*?)```/);
	return { code: codeMatch ? codeMatch[1].trim() : text.trim(), model, tokens };
}

export async function assembleFinalAnswer(
	history: GeminiHistory[],
	params: { userMessage: string; pythonCode: string; executionResult: string },
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const prompt = `Provide the final solution in this structure: Given / Solution / Answer.
Use only these computed data: ${params.executionResult}
Use LaTeX for formulas. Do not include Python code.
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
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const prompt =
		'Analyze the attached image. Extract the engineering/math task condition and describe the scheme relevant for solving. Return plain text only.';
	const messages = buildContext(history, prompt, '');
	messages[messages.length - 1].parts.push({ inlineData: { mimeType, data: base64Data } });
	return generateWithFallback(VISION_CHAIN[0], VISION_CHAIN, messages, forcedModel);
}

export async function generateInitialSchema(
	history: GeminiHistory[],
	userMessage: string,
	params?: {
		imageData?: { base64: string; mimeType: string };
		forcedModel?: string | null;
	}
): Promise<SchemaGenerationResult> {
	let contextMessage = userMessage;
	const usedModels: string[] = [];

	if (params?.imageData) {
		const vision = await analyzeImage(history, params.imageData.base64, params.imageData.mimeType, params.forcedModel);
		usedModels.push(formatTokenAttribution(vision.model, 'Vision', vision.tokens));
		contextMessage = `[IMAGE_DESCRIPTION]\n${vision.text}\n\n[USER_TASK]\n${userMessage}`;
	}

	const prompt = `You build ONLY the initial engineering scheme and must not solve the task.
Return strict JSON object with keys:
{
  "schemaData": {
    "version": "1.0",
    "coordinateSystem": {"xUnit":"m","yUnit":"m","origin":{"x":0,"y":0}},
    "elements": [],
    "annotations": [],
    "assumptions": []
  },
  "assumptions": [],
  "ambiguities": []
}
Allowed element types: beam_segment, support_pin, support_roller, support_fixed, point_load, distributed_load, moment, hinge, joint, axis, dimension, label.
Use finite numeric values only and include all supports/loads/moments from the condition.
${languagePolicy(userMessage)}`;

	const messages = buildContext(history, prompt, `Task for scheme generation:\n${contextMessage}`);
	const generation = await generateWithFallback(PRO_CHAIN[0], PRO_CHAIN, messages, params?.forcedModel);
	const parsed = parseSchemaResult(generation.text);
	usedModels.push(formatTokenAttribution(generation.model, 'SchemaGen', generation.tokens));

	return {
		...parsed,
		model: generation.model,
		tokens: generation.tokens,
		usedModels
	};
}

export async function reviseSchema(
	history: GeminiHistory[],
	params: {
		originalPrompt: string;
		currentSchema: SchemaData;
		revisionNotes: string;
		forcedModel?: string | null;
	}
): Promise<SchemaGenerationResult> {
	const languageSeed = `${params.originalPrompt}\n${params.revisionNotes}`;
	const prompt = `You revise ONLY the engineering scheme and must not solve the task.
Return strict JSON object with keys: schemaData, assumptions, ambiguities.
Preserve correct existing elements and update only what is needed per revision notes.
Keep schemaData.version = "1.0" and finite numbers.
${languagePolicy(languageSeed)}`;

	const currentSchemaJson = JSON.stringify(params.currentSchema, null, 2);
	const question = `Original task:\n${params.originalPrompt}\n\nCurrent schema JSON:\n${currentSchemaJson}\n\nUser revision notes:\n${params.revisionNotes}`;
	const messages = buildContext(history, prompt, question);

	const generation = await generateWithFallback(PRO_CHAIN[0], PRO_CHAIN, messages, params.forcedModel);
	const parsed = parseSchemaResult(generation.text);

	return {
		...parsed,
		model: generation.model,
		tokens: generation.tokens,
		usedModels: [formatTokenAttribution(generation.model, 'SchemaRevision', generation.tokens)]
	};
}
