import type {
	IntentConfidence,
	IntentJoint,
	IntentLanguage,
	IntentLoad,
	IntentMember,
	IntentModelSpace,
	IntentRequestedResult,
	IntentStructureKind,
	SchemeIntentV1
} from './intent.js';
import {
	SCHEME_INTENT_V1_VERSION,
	normalizeSchemeIntent,
	parseSchemeIntentResponse,
	type ParsedSchemeIntentResponse,
	type SchemeIntentNormalizeResult,
	type SchemeIntentValidationResult,
	validateSchemeIntent
} from './intent.js';

export const SCHEME_UNDERSTANDING_V1_VERSION = 'understanding-1.0' as const;

export interface SchemeUnderstandingV1 {
	version: typeof SCHEME_UNDERSTANDING_V1_VERSION;
	taskDomain: 'mechanics';
	structureKind: IntentStructureKind;
	modelSpace: IntentModelSpace;
	confidence: IntentConfidence;
	source: {
		hasImage: boolean;
		language: IntentLanguage;
	};
	joints: IntentJoint[];
	members: IntentMember[];
	supports: SchemeIntentV1['supports'];
	loads: IntentLoad[];
	requestedResults?: IntentRequestedResult[];
	assumptions: string[];
	ambiguities: string[];
}

export interface SchemeUnderstandingNormalizeResult {
	value: SchemeUnderstandingV1;
	warnings: string[];
}

export interface SchemeUnderstandingValidationResult {
	ok: boolean;
	value?: SchemeUnderstandingV1;
	errors: string[];
	warnings: string[];
}

export interface ParsedSchemeUnderstandingResponse {
	understanding: SchemeUnderstandingV1;
	assumptions: string[];
	ambiguities: string[];
	warnings: string[];
}

export interface ParseSchemeUnderstandingResponseOptions {
	baseUnderstanding?: SchemeUnderstandingV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') continue;
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function extractRootUnderstandingCandidate(input: unknown): Record<string, unknown> {
	if (!isRecord(input)) return {};
	const direct = input;
	const wrapped =
		(isRecord(direct.understanding) ? direct.understanding : null) ??
		(isRecord(direct.schemeUnderstanding) ? direct.schemeUnderstanding : null) ??
		(isRecord(direct.scheme_understanding) ? direct.scheme_understanding : null) ??
		(isRecord(direct.intent) ? direct.intent : null) ??
		(isRecord(direct.data) && isRecord(direct.data.understanding)
			? (direct.data.understanding as Record<string, unknown>)
			: null);
	return wrapped ?? direct;
}

function toIntentPayloadFromUnderstanding(
	input: unknown,
	options?: { assumeIntentVersion?: boolean }
): Record<string, unknown> {
	const root = extractRootUnderstandingCandidate(input);
	const payload: Record<string, unknown> = { ...root };

	const version = payload.version;
	if (version === SCHEME_UNDERSTANDING_V1_VERSION || options?.assumeIntentVersion === true) {
		payload.version = SCHEME_INTENT_V1_VERSION;
	}
	if (typeof payload.version !== 'string' || payload.version.trim().length === 0) {
		payload.version = SCHEME_INTENT_V1_VERSION;
	}

	const inputRecord = isRecord(input) ? input : {};
	const rootAssumptions = normalizeStringArray(inputRecord.assumptions);
	const rootAmbiguities = normalizeStringArray(inputRecord.ambiguities);

	if (!Array.isArray(payload.assumptions) && rootAssumptions.length > 0) {
		payload.assumptions = rootAssumptions;
	}
	if (!Array.isArray(payload.ambiguities) && rootAmbiguities.length > 0) {
		payload.ambiguities = rootAmbiguities;
	}

	return payload;
}

function understandingFromIntent(intent: SchemeIntentV1): SchemeUnderstandingV1 {
	return {
		version: SCHEME_UNDERSTANDING_V1_VERSION,
		taskDomain: 'mechanics',
		structureKind: intent.structureKind,
		modelSpace: intent.modelSpace,
		confidence: intent.confidence,
		source: intent.source,
		joints: intent.joints,
		members: intent.members,
		supports: intent.supports,
		loads: intent.loads,
		...(intent.requestedResults && intent.requestedResults.length > 0
			? { requestedResults: intent.requestedResults }
			: {}),
		assumptions: intent.assumptions,
		ambiguities: intent.ambiguities
	};
}

function toParsedUnderstanding(parsed: ParsedSchemeIntentResponse): ParsedSchemeUnderstandingResponse {
	return {
		understanding: understandingFromIntent(parsed.intent),
		assumptions: parsed.assumptions,
		ambiguities: parsed.ambiguities,
		warnings: parsed.warnings
	};
}

function extractFirstJsonObject(text: string): string | null {
	const start = text.indexOf('{');
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i += 1) {
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

function extractJsonPayload(rawText: string): unknown {
	const fencedMatch = rawText.match(/```json\s*([\s\S]*?)```/i);
	const candidate = fencedMatch?.[1] ?? extractFirstJsonObject(rawText);
	if (!candidate) throw new Error('Scheme understanding response is not valid JSON');
	try {
		return JSON.parse(candidate);
	} catch {
		throw new Error('Scheme understanding response JSON parsing failed');
	}
}

function toIntentResponseEnvelope(input: unknown): Record<string, unknown> {
	const root = extractRootUnderstandingCandidate(input);
	const payload = toIntentPayloadFromUnderstanding(root, { assumeIntentVersion: true });
	const inputRecord = isRecord(input) ? input : {};
	const assumptions = normalizeStringArray(inputRecord.assumptions);
	const ambiguities = normalizeStringArray(inputRecord.ambiguities);

	const envelope: Record<string, unknown> = {
		intent: payload
	};
	if (assumptions.length > 0) envelope.assumptions = assumptions;
	if (ambiguities.length > 0) envelope.ambiguities = ambiguities;
	return envelope;
}

function toValidationResult(validation: SchemeIntentValidationResult): SchemeUnderstandingValidationResult {
	if (!validation.ok || !validation.value) {
		return {
			ok: false,
			errors: validation.errors,
			warnings: validation.warnings
		};
	}
	return {
		ok: true,
		value: understandingFromIntent(validation.value),
		errors: [],
		warnings: validation.warnings
	};
}

export function schemeUnderstandingToIntent(understanding: SchemeUnderstandingV1): SchemeIntentV1 {
	return {
		version: SCHEME_INTENT_V1_VERSION,
		taskDomain: 'mechanics',
		structureKind: understanding.structureKind,
		modelSpace: understanding.modelSpace,
		confidence: understanding.confidence,
		source: understanding.source,
		joints: understanding.joints,
		members: understanding.members,
		supports: understanding.supports,
		loads: understanding.loads,
		...(understanding.requestedResults && understanding.requestedResults.length > 0
			? { requestedResults: understanding.requestedResults }
			: {}),
		assumptions: understanding.assumptions,
		ambiguities: understanding.ambiguities
	};
}

export function schemeUnderstandingFromIntent(intent: SchemeIntentV1): SchemeUnderstandingV1 {
	return understandingFromIntent(intent);
}

export function normalizeSchemeUnderstanding(input: unknown): SchemeUnderstandingNormalizeResult {
	const payload = toIntentPayloadFromUnderstanding(input);
	const normalized: SchemeIntentNormalizeResult = normalizeSchemeIntent(payload);
	return {
		value: understandingFromIntent(normalized.value),
		warnings: normalized.warnings
	};
}

export function validateSchemeUnderstanding(input: unknown): SchemeUnderstandingValidationResult {
	const payload = toIntentPayloadFromUnderstanding(input);
	const validation = validateSchemeIntent(payload);
	return toValidationResult(validation);
}

export function parseSchemeUnderstandingResponse(
	rawText: string,
	options?: ParseSchemeUnderstandingResponseOptions
): ParsedSchemeUnderstandingResponse {
	const payload = extractJsonPayload(rawText);
	const envelope = toIntentResponseEnvelope(payload);
	const intentRaw = JSON.stringify(envelope);
	const parsed = parseSchemeIntentResponse(intentRaw, {
		baseIntent: options?.baseUnderstanding
			? schemeUnderstandingToIntent(options.baseUnderstanding)
			: undefined
	});
	return toParsedUnderstanding(parsed);
}

function describeTarget(load: IntentLoad): string {
	if ('jointKey' in load.target) return `joint=${load.target.jointKey}`;
	if ('memberKey' in load.target && 's' in load.target) return `member=${load.target.memberKey}@s=${load.target.s}`;
	return `member=${load.target.memberKey}@s=[${load.target.fromS}, ${load.target.toS}]`;
}

function describeMember(member: IntentMember): string {
	const parts: string[] = [`${member.key}: ${member.startJoint} -> ${member.endJoint}`, member.kind];
	if (member.relation) parts.push(`relation=${member.relation}`);
	if (member.lengthHint !== undefined) parts.push(`L~${member.lengthHint}`);
	if (typeof member.angleHintDeg === 'number' && Number.isFinite(member.angleHintDeg)) {
		parts.push(`angle~${member.angleHintDeg}deg`);
	}
	return parts.join(', ');
}

function describeSupport(support: SchemeIntentV1['supports'][number]): string {
	const target =
		(support.jointKey && `joint=${support.jointKey}`) ||
		(support.memberKey && typeof support.s === 'number' ? `member=${support.memberKey}@s=${support.s}` : null) ||
		(support.memberKey ? `member=${support.memberKey}` : null) ||
		'target=unknown';
	const parts: string[] = [`${support.key}: ${support.kind}`, target];
	if (support.sideHint) parts.push(`side=${support.sideHint}`);
	if (support.guideHint) parts.push(`guide=${support.guideHint}`);
	return parts.join(', ');
}

function unique(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function sectionTitle(
	key: 'type' | 'members' | 'supports' | 'loads' | 'results' | 'assumptions',
	language: IntentLanguage
): string {
	if (language === 'ru') {
		if (key === 'type') return 'Тип схемы';
		if (key === 'members') return 'Стержни и узлы';
		if (key === 'supports') return 'Опоры и связи';
		if (key === 'loads') return 'Нагрузки';
		if (key === 'results') return 'Что требуется построить';
		return 'Принятые допущения';
	}
	if (key === 'type') return 'Scheme type';
	if (key === 'members') return 'Members and joints';
	if (key === 'supports') return 'Supports and constraints';
	if (key === 'loads') return 'Loads';
	if (key === 'results') return 'Requested results';
	return 'Assumptions';
}

function structureLabel(kind: IntentStructureKind, language: IntentLanguage): string {
	if (language === 'ru') {
		if (kind === 'beam') return 'Балка';
		if (kind === 'planar_frame') return 'Плоская рама';
		return 'Пространственная рама';
	}
	if (kind === 'beam') return 'Beam';
	if (kind === 'planar_frame') return 'Planar frame';
	return 'Spatial frame';
}

function modelSpaceLabel(space: IntentModelSpace, language: IntentLanguage): string {
	if (language === 'ru') return space === 'spatial' ? 'Пространственная модель' : 'Плоская модель';
	return space === 'spatial' ? 'Spatial model' : 'Planar model';
}

function pushList(lines: string[], title: string, values: string[], emptyText: string): void {
	lines.push(`${title}:`);
	if (values.length === 0) {
		lines.push(`- ${emptyText}`);
		return;
	}
	for (const value of values) lines.push(`- ${value}`);
}

export function buildSchemeUnderstandingDescription(
	understanding: SchemeUnderstandingV1,
	language: IntentLanguage
): string {
	const lines: string[] = [];
	lines.push(`${sectionTitle('type', language)}:`);
	lines.push(`- ${structureLabel(understanding.structureKind, language)}`);
	lines.push(`- ${modelSpaceLabel(understanding.modelSpace, language)}`);
	if (language === 'ru') {
		lines.push(`- Источник: ${understanding.source.hasImage ? 'текст + изображение' : 'только текст'}`);
	} else {
		lines.push(`- Source: ${understanding.source.hasImage ? 'text + image' : 'text only'}`);
	}
	lines.push('');

	pushList(
		lines,
		sectionTitle('members', language),
		unique(understanding.members.map(describeMember)),
		language === 'ru' ? 'Не указаны' : 'Not specified'
	);
	lines.push('');

	pushList(
		lines,
		sectionTitle('supports', language),
		unique(understanding.supports.map(describeSupport)),
		language === 'ru' ? 'Не указаны' : 'Not specified'
	);
	lines.push('');

	pushList(
		lines,
		sectionTitle('loads', language),
		unique(
			understanding.loads.map((load) => {
				const parts = [`${load.key}: ${load.kind}`, describeTarget(load)];
				if (load.directionHint) parts.push(`dir=${load.directionHint}`);
				if (load.magnitudeHint !== undefined) parts.push(`mag~${typeof load.magnitudeHint === 'object' ? JSON.stringify(load.magnitudeHint) : load.magnitudeHint}`);
				if (load.distributionKind) parts.push(`dist=${load.distributionKind}`);
				return parts.join(', ');
			})
		),
		language === 'ru' ? 'Не указаны' : 'Not specified'
	);
	lines.push('');

	pushList(
		lines,
		sectionTitle('results', language),
		unique(
			(understanding.requestedResults ?? []).map((result) =>
				result.targetMemberKey ? `${result.kind} on ${result.targetMemberKey}` : result.kind
			)
		),
		language === 'ru' ? 'Не указано' : 'Not specified'
	);

	if (understanding.assumptions.length > 0) {
		lines.push('');
		pushList(
			lines,
			sectionTitle('assumptions', language),
			unique(understanding.assumptions),
			language === 'ru' ? 'Нет' : 'None'
		);
	}

	return lines.join('\n').trim();
}
