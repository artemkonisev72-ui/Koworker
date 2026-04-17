export const SCHEME_INTENT_V1_VERSION = 'intent-1.0' as const;

export type IntentStructureKind = 'beam' | 'planar_frame' | 'spatial_frame';
export type IntentModelSpace = 'planar' | 'spatial';
export type IntentConfidence = 'high' | 'medium' | 'low';
export type IntentLanguage = 'ru' | 'en';
export type IntentJointRole =
	| 'start'
	| 'end'
	| 'corner'
	| 'free_end'
	| 'fixed_end'
	| 'generic';
export type IntentMemberKind = 'bar' | 'cable' | 'spring' | 'damper';
export type IntentMemberRelation = 'horizontal' | 'vertical' | 'inclined' | 'collinear_with_prev';
export type IntentSupportKind =
	| 'fixed_wall'
	| 'hinge_fixed'
	| 'hinge_roller'
	| 'internal_hinge'
	| 'slider';
export type IntentSupportSideHint = 'left' | 'right' | 'top' | 'bottom';
export type IntentSupportGuideHint = 'horizontal' | 'vertical' | 'member_local';
export type IntentLoadKind = 'force' | 'moment' | 'distributed';
export type IntentLoadDirectionHint =
	| 'up'
	| 'down'
	| 'left'
	| 'right'
	| '+x'
	| '-x'
	| '+y'
	| '-y'
	| 'cw'
	| 'ccw'
	| 'member_local_positive'
	| 'member_local_negative';
export type IntentDistributionKind = 'uniform' | 'linear' | 'trapezoid';
export type IntentResultKind = 'N' | 'Q' | 'M' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz';

export interface IntentJoint {
	key: string;
	role?: IntentJointRole;
	label?: string;
}

export interface IntentMember {
	key: string;
	kind: IntentMemberKind;
	startJoint: string;
	endJoint: string;
	relation?: IntentMemberRelation;
	lengthHint?: number | string;
	angleHintDeg?: number;
	groupHint?: string;
	label?: string;
}

export interface IntentSupport {
	key: string;
	kind: IntentSupportKind;
	jointKey?: string;
	memberKey?: string;
	s?: number;
	sideHint?: IntentSupportSideHint;
	guideHint?: IntentSupportGuideHint;
}

export type IntentLoadTarget =
	| { jointKey: string }
	| { memberKey: string; s: number }
	| { memberKey: string; fromS: number; toS: number };

export interface IntentLoad {
	key: string;
	kind: IntentLoadKind;
	target: IntentLoadTarget;
	directionHint?: IntentLoadDirectionHint;
	magnitudeHint?: number | string | { start: number | string; end: number | string };
	distributionKind?: IntentDistributionKind;
	label?: string;
}

export interface IntentRequestedResult {
	targetMemberKey?: string;
	kind: IntentResultKind;
}

export interface SchemeIntentV1 {
	version: typeof SCHEME_INTENT_V1_VERSION;
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
	supports: IntentSupport[];
	loads: IntentLoad[];
	requestedResults?: IntentRequestedResult[];
	assumptions: string[];
	ambiguities: string[];
}

export interface SchemeIntentNormalizeResult {
	value: SchemeIntentV1;
	warnings: string[];
}

export interface SchemeIntentValidationResult {
	ok: boolean;
	value?: SchemeIntentV1;
	errors: string[];
	warnings: string[];
}

export interface ParsedSchemeIntentResponse {
	intent: SchemeIntentV1;
	assumptions: string[];
	ambiguities: string[];
	warnings: string[];
}

export interface ParseSchemeIntentResponseOptions {
	baseIntent?: SchemeIntentV1;
}

const JOINT_ROLES = new Set<IntentJointRole>([
	'start',
	'end',
	'corner',
	'free_end',
	'fixed_end',
	'generic'
]);

const MEMBER_KINDS = new Set<IntentMemberKind>(['bar', 'cable', 'spring', 'damper']);
const MEMBER_RELATIONS = new Set<IntentMemberRelation>([
	'horizontal',
	'vertical',
	'inclined',
	'collinear_with_prev'
]);
const SUPPORT_KINDS = new Set<IntentSupportKind>([
	'fixed_wall',
	'hinge_fixed',
	'hinge_roller',
	'internal_hinge',
	'slider'
]);
const SUPPORT_SIDE_HINTS = new Set<IntentSupportSideHint>(['left', 'right', 'top', 'bottom']);
const SUPPORT_GUIDE_HINTS = new Set<IntentSupportGuideHint>(['horizontal', 'vertical', 'member_local']);
const LOAD_KINDS = new Set<IntentLoadKind>(['force', 'moment', 'distributed']);
const LOAD_DIRECTION_HINTS = new Set<IntentLoadDirectionHint>([
	'up',
	'down',
	'left',
	'right',
	'+x',
	'-x',
	'+y',
	'-y',
	'cw',
	'ccw',
	'member_local_positive',
	'member_local_negative'
]);
const DISTRIBUTION_KINDS = new Set<IntentDistributionKind>(['uniform', 'linear', 'trapezoid']);
const RESULT_KINDS = new Set<IntentResultKind>(['N', 'Q', 'M', 'Vy', 'Vz', 'T', 'My', 'Mz']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return uniqueStrings(
		value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
	);
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string') return null;
	const compact = value.replace(',', '.').trim();
	if (!compact) return null;
	const match = compact.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
	if (!match) return null;
	const parsed = Number.parseFloat(match[0]);
	return Number.isFinite(parsed) ? parsed : null;
}

function normalizeConfidence(value: unknown): IntentConfidence {
	if (typeof value !== 'string') return 'medium';
	const normalized = value.trim().toLowerCase();
	if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized;
	return 'medium';
}

function normalizeLanguage(value: unknown): IntentLanguage {
	if (typeof value !== 'string') return 'ru';
	const normalized = value.trim().toLowerCase();
	return normalized === 'en' ? 'en' : 'ru';
}

function normalizeStructureKind(value: unknown): IntentStructureKind | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
	if (
		normalized === 'beam' ||
		normalized === 'planar_frame' ||
		normalized === 'spatial_frame'
	) {
		return normalized;
	}
	return null;
}

function normalizeModelSpace(value: unknown): IntentModelSpace | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'planar' || normalized === 'spatial') return normalized;
	return null;
}

function normalizeJointRole(value: unknown): IntentJointRole | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_') as IntentJointRole;
	return JOINT_ROLES.has(normalized) ? normalized : undefined;
}

function normalizeMemberKind(value: unknown): IntentMemberKind | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase() as IntentMemberKind;
	return MEMBER_KINDS.has(normalized) ? normalized : null;
}

function normalizeMemberRelation(value: unknown): IntentMemberRelation | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_') as IntentMemberRelation;
	return MEMBER_RELATIONS.has(normalized) ? normalized : undefined;
}

function normalizeSupportKind(value: unknown): IntentSupportKind | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
	if (normalized === 'support_fixed') return 'fixed_wall';
	if (normalized === 'support_pin') return 'hinge_fixed';
	if (normalized === 'support_roller') return 'hinge_roller';
	if (normalized === 'hinge') return 'internal_hinge';
	return SUPPORT_KINDS.has(normalized as IntentSupportKind)
		? (normalized as IntentSupportKind)
		: null;
}

function normalizeSupportSideHint(value: unknown): IntentSupportSideHint | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase() as IntentSupportSideHint;
	return SUPPORT_SIDE_HINTS.has(normalized) ? normalized : undefined;
}

function normalizeSupportGuideHint(value: unknown): IntentSupportGuideHint | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_') as IntentSupportGuideHint;
	return SUPPORT_GUIDE_HINTS.has(normalized) ? normalized : undefined;
}

function normalizeLoadKind(value: unknown): IntentLoadKind | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
	if (normalized === 'point_load') return 'force';
	if (normalized === 'distributed_load') return 'distributed';
	return LOAD_KINDS.has(normalized as IntentLoadKind) ? (normalized as IntentLoadKind) : null;
}

function normalizeDirectionHint(value: unknown): IntentLoadDirectionHint | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase().replace(/\s+/g, '_') as IntentLoadDirectionHint;
	return LOAD_DIRECTION_HINTS.has(normalized) ? normalized : undefined;
}

function normalizeDistributionKind(value: unknown): IntentDistributionKind | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase() as IntentDistributionKind;
	return DISTRIBUTION_KINDS.has(normalized) ? normalized : undefined;
}

function normalizeResultKind(value: unknown): IntentResultKind | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (RESULT_KINDS.has(trimmed as IntentResultKind)) return trimmed as IntentResultKind;
	const upper = trimmed.toUpperCase();
	if (upper === 'N' || upper === 'Q' || upper === 'M') return upper;
	const normalized = upper[0] + upper.slice(1).toLowerCase();
	return RESULT_KINDS.has(normalized as IntentResultKind) ? (normalized as IntentResultKind) : null;
}

function normalizeKey(value: unknown, fallback: string): string {
	const raw = typeof value === 'string' ? value.trim() : '';
	return raw || fallback;
}

function ensureUniqueKey(key: string, used: Set<string>, fallbackPrefix: string): string {
	let next = key.trim();
	if (!next) next = `${fallbackPrefix}_${used.size + 1}`;
	if (!used.has(next)) {
		used.add(next);
		return next;
	}
	let suffix = 2;
	let candidate = `${next}_${suffix}`;
	while (used.has(candidate)) {
		suffix += 1;
		candidate = `${next}_${suffix}`;
	}
	used.add(candidate);
	return candidate;
}

function normalizeJointCandidate(raw: unknown, index: number): IntentJoint | null {
	if (typeof raw === 'string') {
		const key = raw.trim();
		if (!key) return null;
		return { key };
	}
	if (!isRecord(raw)) return null;
	const key = normalizeKey(raw.key ?? raw.id ?? raw.name ?? raw.label, `J${index + 1}`);
	const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
	const role = normalizeJointRole(raw.role ?? raw.kind ?? raw.type);
	return { key, ...(role ? { role } : {}), ...(label ? { label } : {}) };
}

function normalizeMemberCandidate(raw: unknown, index: number): IntentMember | null {
	if (!isRecord(raw)) return null;
	const kind = normalizeMemberKind(raw.kind ?? raw.type ?? raw.memberType) ?? 'bar';
	const startJoint = normalizeKey(
		raw.startJoint ?? raw.start ?? raw.fromJoint ?? raw.jointA ?? raw.from,
		''
	);
	const endJoint = normalizeKey(raw.endJoint ?? raw.end ?? raw.toJoint ?? raw.jointB ?? raw.to, '');
	if (!startJoint || !endJoint) return null;
	const key = normalizeKey(raw.key ?? raw.id ?? raw.name, `m${index + 1}`);
	const relation = normalizeMemberRelation(raw.relation ?? raw.orientation);
	const lengthHintNumber = toFiniteNumber(raw.lengthHint ?? raw.length ?? raw.span);
	const lengthHintString =
		typeof raw.lengthHint === 'string' && raw.lengthHint.trim() ? raw.lengthHint.trim() : undefined;
	const angleHintDeg = toFiniteNumber(raw.angleHintDeg ?? raw.angleDeg ?? raw.angle) ?? undefined;
	const groupHint =
		typeof raw.groupHint === 'string' && raw.groupHint.trim() ? raw.groupHint.trim() : undefined;
	const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;

	return {
		key,
		kind,
		startJoint,
		endJoint,
		...(relation ? { relation } : {}),
		...(lengthHintNumber !== null ? { lengthHint: lengthHintNumber } : lengthHintString ? { lengthHint: lengthHintString } : {}),
		...(angleHintDeg !== undefined ? { angleHintDeg } : {}),
		...(groupHint ? { groupHint } : {}),
		...(label ? { label } : {})
	};
}

function normalizeSupportCandidate(raw: unknown, index: number): IntentSupport | null {
	if (!isRecord(raw)) return null;
	const kind = normalizeSupportKind(raw.kind ?? raw.type ?? raw.supportType);
	if (!kind) return null;
	const key = normalizeKey(raw.key ?? raw.id ?? raw.name, `support_${index + 1}`);
	const jointKeyRaw = normalizeKey(raw.jointKey ?? raw.joint ?? raw.nodeKey ?? raw.node, '');
	const memberKeyRaw = normalizeKey(raw.memberKey ?? raw.member ?? raw.bar ?? raw.memberId, '');
	const sRaw = toFiniteNumber(raw.s ?? raw.t ?? raw.lambda ?? raw.position);
	const s =
		typeof sRaw === 'number' && Number.isFinite(sRaw)
			? Math.max(0, Math.min(1, sRaw))
			: undefined;
	const sideHint = normalizeSupportSideHint(raw.sideHint ?? raw.side);
	const guideHint = normalizeSupportGuideHint(raw.guideHint ?? raw.guide ?? raw.orientation);

	const support: IntentSupport = { key, kind };
	if (jointKeyRaw) support.jointKey = jointKeyRaw;
	if (memberKeyRaw) support.memberKey = memberKeyRaw;
	if (s !== undefined) support.s = s;
	if (sideHint) support.sideHint = sideHint;
	if (guideHint) support.guideHint = guideHint;
	return support;
}

function normalizeMagnitudeHint(value: unknown): IntentLoad['magnitudeHint'] | undefined {
	if (value === undefined || value === null) return undefined;
	const numberValue = toFiniteNumber(value);
	if (numberValue !== null) return numberValue;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed ? trimmed : undefined;
	}
	if (isRecord(value)) {
		const startNum = toFiniteNumber(value.start);
		const endNum = toFiniteNumber(value.end);
		const start =
			startNum ?? (typeof value.start === 'string' && value.start.trim() ? value.start.trim() : null);
		const end =
			endNum ?? (typeof value.end === 'string' && value.end.trim() ? value.end.trim() : null);
		if (start !== null && end !== null) {
			return { start, end };
		}
	}
	return undefined;
}

function normalizeLoadTarget(value: unknown): IntentLoadTarget | null {
	if (!isRecord(value)) return null;
	const jointKey = normalizeKey(value.jointKey ?? value.joint ?? value.nodeKey ?? value.node, '');
	if (jointKey) return { jointKey };

	const memberKey = normalizeKey(value.memberKey ?? value.member ?? value.bar ?? value.memberId, '');
	if (!memberKey) return null;

	const s = toFiniteNumber(value.s ?? value.t ?? value.lambda ?? value.position);
	if (s !== null) {
		return { memberKey, s: Math.max(0, Math.min(1, s)) };
	}
	const fromS = toFiniteNumber(value.fromS ?? value.from ?? value.startS ?? value.start);
	const toS = toFiniteNumber(value.toS ?? value.to ?? value.endS ?? value.end);
	if (fromS !== null && toS !== null) {
		return {
			memberKey,
			fromS: Math.max(0, Math.min(1, fromS)),
			toS: Math.max(0, Math.min(1, toS))
		};
	}
	return { memberKey, s: 0.5 };
}

function normalizeLoadCandidate(raw: unknown, index: number): IntentLoad | null {
	if (!isRecord(raw)) return null;
	const kind = normalizeLoadKind(raw.kind ?? raw.type ?? raw.loadType);
	if (!kind) return null;
	const key = normalizeKey(raw.key ?? raw.id ?? raw.name, `load_${index + 1}`);
	const target =
		normalizeLoadTarget(raw.target) ??
		normalizeLoadTarget(raw) ??
		(kind === 'distributed' ? null : normalizeLoadTarget({ jointKey: raw.jointKey ?? raw.joint }));
	if (!target) return null;
	const normalizedTarget: IntentLoadTarget =
		kind === 'distributed' && 'memberKey' in target && 's' in target
			? {
				memberKey: target.memberKey,
				fromS: Math.max(0, Math.min(1, target.s - 0.1)),
				toS: Math.max(0, Math.min(1, target.s + 0.1))
			}
			: target;
	const directionHint = normalizeDirectionHint(raw.directionHint ?? raw.direction ?? raw.cardinal);
	const magnitudeHint = normalizeMagnitudeHint(raw.magnitudeHint ?? raw.magnitude ?? raw.intensity);
	const distributionKind = normalizeDistributionKind(raw.distributionKind ?? raw.kindHint ?? raw.shape);
	const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;

	const load: IntentLoad = { key, kind, target: normalizedTarget };
	if (directionHint) load.directionHint = directionHint;
	if (magnitudeHint !== undefined) load.magnitudeHint = magnitudeHint;
	if (distributionKind) load.distributionKind = distributionKind;
	if (label) load.label = label;
	return load;
}

function normalizeRequestedResultCandidate(raw: unknown): IntentRequestedResult | null {
	if (typeof raw === 'string') {
		const kind = normalizeResultKind(raw);
		return kind ? { kind } : null;
	}
	if (!isRecord(raw)) return null;
	const kind = normalizeResultKind(raw.kind ?? raw.component ?? raw.type);
	if (!kind) return null;
	const targetMemberKey = normalizeKey(raw.targetMemberKey ?? raw.memberKey ?? raw.member, '');
	return targetMemberKey ? { kind, targetMemberKey } : { kind };
}

function sortByAppearance<T extends { key: string }>(items: T[]): T[] {
	return [...items];
}

function extractRootIntentCandidate(input: unknown): Record<string, unknown> {
	if (!isRecord(input)) return {};
	const direct = input;
	const wrapped =
		(isRecord(direct.intent) ? direct.intent : null) ??
		(isRecord(direct.schemeIntent) ? direct.schemeIntent : null) ??
		(isRecord(direct.scheme_intent) ? direct.scheme_intent : null) ??
		(isRecord(direct.data) && isRecord(direct.data.intent)
			? (direct.data.intent as Record<string, unknown>)
			: null);
	return wrapped ?? direct;
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function mergeIntentWithBase(
	candidatePayload: Record<string, unknown>,
	normalizedCandidate: SchemeIntentV1,
	baseIntent: SchemeIntentV1
): SchemeIntentV1 {
	const usesCandidateStructureKind = hasOwnKey(candidatePayload, 'structureKind');
	const usesCandidateModelSpace = hasOwnKey(candidatePayload, 'modelSpace');

	const structureKind = usesCandidateStructureKind
		? normalizedCandidate.structureKind
		: baseIntent.structureKind;
	const modelSpace = usesCandidateModelSpace
		? normalizedCandidate.modelSpace
		: usesCandidateStructureKind
			? (structureKind === 'spatial_frame' ? 'spatial' : 'planar')
			: baseIntent.modelSpace;

	const confidence = hasOwnKey(candidatePayload, 'confidence')
		? normalizedCandidate.confidence
		: baseIntent.confidence;
	const source = hasOwnKey(candidatePayload, 'source')
		? normalizedCandidate.source
		: baseIntent.source;

	const joints =
		normalizedCandidate.joints.length > 0
			? normalizedCandidate.joints
			: baseIntent.joints;
	const members =
		normalizedCandidate.members.length > 0
			? normalizedCandidate.members
			: baseIntent.members;
	const supports = hasOwnKey(candidatePayload, 'supports')
		? normalizedCandidate.supports
		: baseIntent.supports;
	const loads = hasOwnKey(candidatePayload, 'loads')
		? normalizedCandidate.loads
		: baseIntent.loads;
	const requestedResults = hasOwnKey(candidatePayload, 'requestedResults')
		? normalizedCandidate.requestedResults
		: baseIntent.requestedResults;
	const assumptions = hasOwnKey(candidatePayload, 'assumptions')
		? normalizedCandidate.assumptions
		: baseIntent.assumptions;
	const ambiguities = hasOwnKey(candidatePayload, 'ambiguities')
		? normalizedCandidate.ambiguities
		: baseIntent.ambiguities;

	return {
		version: SCHEME_INTENT_V1_VERSION,
		taskDomain: 'mechanics',
		structureKind,
		modelSpace,
		confidence,
		source,
		joints,
		members,
		supports,
		loads,
		...(requestedResults && requestedResults.length > 0 ? { requestedResults } : {}),
		assumptions,
		ambiguities
	};
}

function extractJsonPayload(rawText: string): unknown {
	const fencedMatch = rawText.match(/```json\s*([\s\S]*?)```/i);
	const candidate = fencedMatch?.[1] ?? extractFirstJsonObject(rawText);
	if (!candidate) {
		throw new Error('Intent response is not valid JSON');
	}
	try {
		return JSON.parse(candidate);
	} catch {
		throw new Error('Intent response JSON parsing failed');
	}
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

export function normalizeSchemeIntent(input: unknown): SchemeIntentNormalizeResult {
	const warnings: string[] = [];
	const rootPayload = extractRootIntentCandidate(input);
	const rootAssumptions = normalizeStringArray((input as Record<string, unknown> | null)?.assumptions);
	const rootAmbiguities = normalizeStringArray((input as Record<string, unknown> | null)?.ambiguities);

	const structureKind = normalizeStructureKind(rootPayload.structureKind) ?? 'beam';
	const modelSpace =
		normalizeModelSpace(rootPayload.modelSpace) ??
		(structureKind === 'spatial_frame' ? 'spatial' : 'planar');
	const confidence = normalizeConfidence(rootPayload.confidence);
	const sourceRecord = isRecord(rootPayload.source) ? rootPayload.source : {};
	const source = {
		hasImage: Boolean(sourceRecord.hasImage),
		language: normalizeLanguage(sourceRecord.language)
	};

	const jointsRaw = Array.isArray(rootPayload.joints) ? rootPayload.joints : [];
	const membersRaw = Array.isArray(rootPayload.members) ? rootPayload.members : [];
	const supportsRaw = Array.isArray(rootPayload.supports) ? rootPayload.supports : [];
	const loadsRaw = Array.isArray(rootPayload.loads) ? rootPayload.loads : [];
	const requestedRaw = Array.isArray(rootPayload.requestedResults) ? rootPayload.requestedResults : [];

	const usedJointKeys = new Set<string>();
	const joints: IntentJoint[] = [];
	for (const [index, rawJoint] of jointsRaw.entries()) {
		const normalized = normalizeJointCandidate(rawJoint, index);
		if (!normalized) continue;
		const key = ensureUniqueKey(normalized.key, usedJointKeys, 'J');
		joints.push({ ...normalized, key });
	}

	const usedMemberKeys = new Set<string>();
	const members: IntentMember[] = [];
	for (const [index, rawMember] of membersRaw.entries()) {
		const normalized = normalizeMemberCandidate(rawMember, index);
		if (!normalized) continue;
		const key = ensureUniqueKey(normalized.key, usedMemberKeys, 'm');
		members.push({ ...normalized, key });
	}

	if (joints.length === 0 && members.length > 0) {
		const autoJointKeys = uniqueStrings(
			members.flatMap((member) => [member.startJoint, member.endJoint])
		);
		for (const key of autoJointKeys) {
			const unique = ensureUniqueKey(key, usedJointKeys, 'J');
			joints.push({ key: unique });
		}
		warnings.push('Intent joints were inferred from member endpoints.');
	}

	const usedSupportKeys = new Set<string>();
	const supports: IntentSupport[] = [];
	for (const [index, rawSupport] of supportsRaw.entries()) {
		const normalized = normalizeSupportCandidate(rawSupport, index);
		if (!normalized) continue;
		const key = ensureUniqueKey(normalized.key, usedSupportKeys, 'support');
		supports.push({ ...normalized, key });
	}

	const usedLoadKeys = new Set<string>();
	const loads: IntentLoad[] = [];
	for (const [index, rawLoad] of loadsRaw.entries()) {
		const normalized = normalizeLoadCandidate(rawLoad, index);
		if (!normalized) continue;
		const key = ensureUniqueKey(normalized.key, usedLoadKeys, 'load');
		loads.push({ ...normalized, key });
	}

	const requestedResults = requestedRaw
		.map((raw) => normalizeRequestedResultCandidate(raw))
		.filter((entry): entry is IntentRequestedResult => Boolean(entry));

	const assumptions = uniqueStrings([
		...normalizeStringArray(rootPayload.assumptions),
		...rootAssumptions
	]);
	const ambiguities = uniqueStrings([
		...normalizeStringArray(rootPayload.ambiguities),
		...rootAmbiguities
	]);

	if (modelSpace === 'spatial' && structureKind !== 'spatial_frame') {
		warnings.push('Intent modelSpace="spatial" was paired with non-spatial structure kind.');
	}

	return {
		value: {
			version: SCHEME_INTENT_V1_VERSION,
			taskDomain: 'mechanics',
			structureKind,
			modelSpace,
			confidence,
			source,
			joints: sortByAppearance(joints),
			members: sortByAppearance(members),
			supports: sortByAppearance(supports),
			loads: sortByAppearance(loads),
			...(requestedResults.length > 0 ? { requestedResults } : {}),
			assumptions,
			ambiguities
		},
		warnings
	};
}

function validateRequestedResults(
	intent: SchemeIntentV1,
	errors: string[]
): void {
	if (!intent.requestedResults || intent.requestedResults.length === 0) return;
	const allowedBeam = new Set<IntentResultKind>(['N', 'Q', 'M']);
	// Backward compatibility: allow legacy Q/M for planar frames.
	const allowedPlanarFrame = new Set<IntentResultKind>(['N', 'Vy', 'Mz', 'Q', 'M']);
	const allowedSpatialFrame = new Set<IntentResultKind>(['N', 'Vy', 'Vz', 'T', 'My', 'Mz']);

	for (const [index, result] of intent.requestedResults.entries()) {
		const allowed =
			intent.structureKind === 'beam'
				? allowedBeam
				: intent.structureKind === 'planar_frame'
					? allowedPlanarFrame
					: allowedSpatialFrame;
		if (!allowed.has(result.kind)) {
			errors.push(
				`requestedResults[${index}].kind "${result.kind}" is not valid for structureKind="${intent.structureKind}"`
			);
		}
	}
}

export function validateSchemeIntent(input: unknown): SchemeIntentValidationResult {
	const normalized = normalizeSchemeIntent(input);
	const intent = normalized.value;
	const errors: string[] = [];

	if (intent.version !== SCHEME_INTENT_V1_VERSION) {
		errors.push(`intent.version must be "${SCHEME_INTENT_V1_VERSION}"`);
	}
	if (intent.taskDomain !== 'mechanics') {
		errors.push('intent.taskDomain must be "mechanics"');
	}
	if (intent.structureKind === 'spatial_frame' && intent.modelSpace !== 'spatial') {
		errors.push('structureKind="spatial_frame" requires modelSpace="spatial"');
	}
	if (intent.structureKind !== 'spatial_frame' && intent.modelSpace === 'spatial') {
		errors.push('modelSpace="spatial" is allowed only for structureKind="spatial_frame"');
	}

	if (!Array.isArray(intent.joints) || intent.joints.length === 0) {
		errors.push('Intent must contain at least one joint');
	}
	if (!Array.isArray(intent.members) || intent.members.length === 0) {
		errors.push('Intent must contain at least one member');
	}

	const jointKeys = new Set(intent.joints.map((joint) => joint.key));
	const memberKeys = new Set(intent.members.map((member) => member.key));

	for (const [index, joint] of intent.joints.entries()) {
		if (!joint.key.trim()) errors.push(`joints[${index}].key must be non-empty`);
	}

	for (const [index, member] of intent.members.entries()) {
		if (!member.key.trim()) errors.push(`members[${index}].key must be non-empty`);
		if (!jointKeys.has(member.startJoint)) {
			errors.push(`members[${index}].startJoint "${member.startJoint}" is unknown`);
		}
		if (!jointKeys.has(member.endJoint)) {
			errors.push(`members[${index}].endJoint "${member.endJoint}" is unknown`);
		}
		if (member.startJoint === member.endJoint) {
			errors.push(`members[${index}] startJoint and endJoint must be different`);
		}
	}

	for (const [index, support] of intent.supports.entries()) {
		const hasJoint = typeof support.jointKey === 'string' && support.jointKey.trim().length > 0;
		const hasMember = typeof support.memberKey === 'string' && support.memberKey.trim().length > 0;
		if (!hasJoint && !hasMember) {
			errors.push(`supports[${index}] must define jointKey or memberKey`);
			continue;
		}
		if (hasJoint && support.jointKey && !jointKeys.has(support.jointKey)) {
			errors.push(`supports[${index}].jointKey "${support.jointKey}" is unknown`);
		}
		if (hasMember && support.memberKey && !memberKeys.has(support.memberKey)) {
			errors.push(`supports[${index}].memberKey "${support.memberKey}" is unknown`);
		}
		if (hasMember && typeof support.s !== 'number') {
			errors.push(`supports[${index}] with memberKey must define numeric s in [0,1]`);
		}
	}

	for (const [index, load] of intent.loads.entries()) {
		if (!load.key.trim()) errors.push(`loads[${index}].key must be non-empty`);
		if (load.kind === 'distributed') {
			if ('jointKey' in load.target) {
				errors.push(`loads[${index}] kind "distributed" cannot target jointKey; use member target`);
			} else if (!('memberKey' in load.target) || (!('fromS' in load.target) && !('s' in load.target))) {
				errors.push(
					`loads[${index}] kind "distributed" requires member target {memberKey,fromS,toS} (or member+s fallback)`
				);
			}
		} else if ('memberKey' in load.target && 'fromS' in load.target) {
			errors.push(`loads[${index}] kind "${load.kind}" cannot use interval target`);
		}

		if ('jointKey' in load.target) {
			if (!jointKeys.has(load.target.jointKey)) {
				errors.push(`loads[${index}] target.jointKey "${load.target.jointKey}" is unknown`);
			}
		} else if ('memberKey' in load.target) {
			if (!memberKeys.has(load.target.memberKey)) {
				errors.push(`loads[${index}] target.memberKey "${load.target.memberKey}" is unknown`);
			}
		}
	}

	validateRequestedResults(intent, errors);

	if (errors.length > 0) {
		return {
			ok: false,
			errors,
			warnings: normalized.warnings
		};
	}
	return {
		ok: true,
		value: intent,
		errors: [],
		warnings: normalized.warnings
	};
}

export function parseSchemeIntentResponse(
	rawText: string,
	options?: ParseSchemeIntentResponseOptions
): ParsedSchemeIntentResponse {
	const parsed = extractJsonPayload(rawText);
	if (!isRecord(parsed)) {
		throw new Error('Intent response JSON must be an object');
	}
	const payload = extractRootIntentCandidate(parsed);
	let validation = validateSchemeIntent(payload);
	const extraWarnings: string[] = [];
	if ((!validation.ok || !validation.value) && options?.baseIntent) {
		const normalizedCandidate = normalizeSchemeIntent(payload).value;
		const merged = mergeIntentWithBase(payload, normalizedCandidate, options.baseIntent);
		const mergedValidation = validateSchemeIntent(merged);
		if (mergedValidation.ok && mergedValidation.value) {
			extraWarnings.push(
				`Intent response was merged with base intent due validation errors: ${validation.errors.join('; ')}`
			);
			validation = mergedValidation;
		}
	}
	if (!validation.ok || !validation.value) {
		throw new Error(`Intent response validation failed: ${validation.errors.join('; ')}`);
	}

	const rootAssumptions = normalizeStringArray(parsed.assumptions);
	const rootAmbiguities = normalizeStringArray(parsed.ambiguities);
	const assumptions = uniqueStrings([...validation.value.assumptions, ...rootAssumptions]);
	const ambiguities = uniqueStrings([...validation.value.ambiguities, ...rootAmbiguities]);

	return {
		intent: {
			...validation.value,
			assumptions,
			ambiguities
		},
		assumptions,
		ambiguities,
		warnings: [...validation.warnings, ...extraWarnings]
	};
}
