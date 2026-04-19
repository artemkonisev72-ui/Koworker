import type { SchemeIntentV1 } from '$lib/schema/intent.js';
import type { SchemaAny } from '$lib/schema/schema-any.js';
import type { GeminiHistory } from '$lib/server/ai/gemini.js';
import { generateSchemeDescriptionFromFacts } from '$lib/server/ai/gemini.js';
import type { SchemeUnderstandingV1 } from '$lib/schema/understanding.js';
import { schemeUnderstandingToIntent } from '$lib/schema/understanding.js';

export type SchemeDescriptionLanguage = 'ru' | 'en';

type StructureKindExtended =
	| 'beam'
	| 'planar_frame'
	| 'spatial_frame'
	| 'planar_mechanism'
	| 'spatial_mechanism';
type ModelSpace = 'planar' | 'spatial';

export interface SchemeDescriptionFacts {
	structureKind: StructureKindExtended;
	modelSpace: ModelSpace;
	hasImageSource: boolean;
	joints: string[];
	members: string[];
	supports: string[];
	loads: string[];
	requestedResults: string[];
	assumptions: string[];
}

export interface AdaptiveSchemeDescriptionParams {
	schema: SchemaAny;
	language: SchemeDescriptionLanguage;
	history?: GeminiHistory[];
	intent?: SchemeIntentV1 | null;
	understanding?: SchemeUnderstandingV1 | null;
	assumptions?: string[];
	forcedModel?: string | null;
	fastMode?: boolean;
}

export interface AdaptiveSchemeDescriptionResult {
	description: string;
	source: 'llm' | 'fallback';
	model?: string;
	tokens?: number;
	facts: SchemeDescriptionFacts;
}

interface BuildFactsParams {
	schema: SchemaAny;
	intent?: SchemeIntentV1 | null;
	assumptions?: string[];
}

const MEMBER_TYPES = new Set(['bar', 'cable', 'spring', 'damper']);
const COMPONENT_TYPES = new Set(['rigid_disk', 'cam']);
const KINEMATIC_PAIR_TYPES = new Set([
	'revolute_pair',
	'prismatic_pair',
	'slot_pair',
	'cam_contact',
	'gear_pair',
	'belt_pair'
]);
const SUPPORT_TYPES = new Set([
	'fixed_wall',
	'hinge_fixed',
	'hinge_roller',
	'internal_hinge',
	'slider',
	'revolute_pair',
	'prismatic_pair',
	'slot_pair',
	'cam_contact',
	'gear_pair',
	'belt_pair'
]);
const LOAD_TYPES = new Set([
	'force',
	'moment',
	'distributed',
	'velocity',
	'acceleration',
	'angular_velocity',
	'angular_acceleration'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		const normalized = normalizeString(entry);
		if (normalized) out.push(normalized);
	}
	return out;
}

function unique(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

function normalizeStructureKind(value: unknown): StructureKindExtended | null {
	const normalized = normalizeString(value)?.toLowerCase().replace(/[\s-]+/g, '_');
	if (
		normalized === 'beam' ||
		normalized === 'planar_frame' ||
		normalized === 'spatial_frame' ||
		normalized === 'planar_mechanism' ||
		normalized === 'spatial_mechanism'
	) {
		return normalized;
	}
	return null;
}

function normalizeModelSpace(value: unknown): ModelSpace | null {
	const normalized = normalizeString(value)?.toLowerCase();
	if (normalized === 'planar' || normalized === 'spatial') return normalized;
	return null;
}

function formatHintValue(value: unknown): string | null {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

function displayLabel(label: string | undefined, key: string): string {
	const normalized = typeof label === 'string' ? label.trim() : '';
	return normalized || key;
}

function formatIntentMember(
	member: SchemeIntentV1['members'][number],
	jointLabelByKey: Map<string, string>
): string {
	const memberLabel = displayLabel(member.label, member.key);
	const startLabel = jointLabelByKey.get(member.startJoint) ?? member.startJoint;
	const endLabel = jointLabelByKey.get(member.endJoint) ?? member.endJoint;
	const parts: string[] = [`${memberLabel}: ${startLabel} -> ${endLabel}`, member.kind];
	if (member.relation) parts.push(`relation=${member.relation}`);
	const lengthHint = formatHintValue(member.lengthHint);
	if (lengthHint) parts.push(`L~${lengthHint}`);
	if (typeof member.angleHintDeg === 'number' && Number.isFinite(member.angleHintDeg)) {
		parts.push(`angle~${member.angleHintDeg}deg`);
	}
	return parts.join(', ');
}

function formatIntentComponent(
	component: SchemeIntentV1['components'][number],
	jointLabelByKey: Map<string, string>
): string {
	const componentLabel = displayLabel(component.label, component.key);
	const centerLabel = jointLabelByKey.get(component.centerJoint) ?? component.centerJoint;
	const parts: string[] = [`${componentLabel}: center=${centerLabel}`, component.kind];
	const radiusHint = formatHintValue(component.radiusHint);
	if (radiusHint) parts.push(`R~${radiusHint}`);
	if (component.profileHint) parts.push(`profile=${component.profileHint}`);
	return parts.join(', ');
}

function formatIntentKinematicPair(
	pair: SchemeIntentV1['kinematicPairs'][number],
	jointLabelByKey: Map<string, string>
): string {
	const pairLabel = displayLabel(pair.label, pair.key);
	const parts: string[] = [`${pairLabel}: ${pair.kind}`];
	if (pair.jointKey) parts.push(`joint=${jointLabelByKey.get(pair.jointKey) ?? pair.jointKey}`);
	if (pair.memberKeys && pair.memberKeys.length > 0) parts.push(`members=${pair.memberKeys.join('+')}`);
	if (pair.componentKeys && pair.componentKeys.length > 0) {
		parts.push(`components=${pair.componentKeys.join('+')}`);
	}
	if (pair.guideHint) parts.push(`guide=${pair.guideHint}`);
	if (pair.meshType) parts.push(`mesh=${pair.meshType}`);
	if (pair.beltKind) parts.push(`belt=${pair.beltKind}`);
	if (typeof pair.crossed === 'boolean') parts.push(`crossed=${pair.crossed}`);
	if (pair.followerType) parts.push(`follower=${pair.followerType}`);
	return parts.join(', ');
}

function formatIntentSupport(support: SchemeIntentV1['supports'][number]): string {
	const target =
		(support.jointKey && `joint=${support.jointKey}`) ||
		(support.memberKey && typeof support.s === 'number' && Number.isFinite(support.s)
			? `member=${support.memberKey}@s=${support.s}`
			: support.memberKey
				? `member=${support.memberKey}`
				: 'target=unknown');
	const parts: string[] = [`${support.key}: ${support.kind}`, target];
	if (support.sideHint) parts.push(`side=${support.sideHint}`);
	if (support.guideHint) parts.push(`guide=${support.guideHint}`);
	return parts.join(', ');
}

function formatIntentLoad(load: SchemeIntentV1['loads'][number]): string {
	let target = 'target=unknown';
	if ('jointKey' in load.target) {
		target = `joint=${load.target.jointKey}`;
	} else if ('memberKey' in load.target && 's' in load.target) {
		target = `member=${load.target.memberKey}@s=${load.target.s}`;
	} else if ('memberKey' in load.target && 'fromS' in load.target && 'toS' in load.target) {
		target = `member=${load.target.memberKey}@s=[${load.target.fromS}, ${load.target.toS}]`;
	}

	const parts: string[] = [`${load.key}: ${load.kind}`, target];
	if (load.directionHint) parts.push(`dir=${load.directionHint}`);

	if (typeof load.magnitudeHint === 'number' || typeof load.magnitudeHint === 'string') {
		parts.push(`mag~${load.magnitudeHint}`);
	} else if (isRecord(load.magnitudeHint)) {
		const start = formatHintValue(load.magnitudeHint.start);
		const end = formatHintValue(load.magnitudeHint.end);
		if (start || end) {
			parts.push(`mag~[${start ?? '?'}, ${end ?? '?'}]`);
		}
	}

	if (load.distributionKind) parts.push(`dist=${load.distributionKind}`);
	return parts.join(', ');
}

function inferFromSchema(schema: SchemaAny): Pick<
	SchemeDescriptionFacts,
	'structureKind' | 'modelSpace' | 'joints' | 'members' | 'supports' | 'loads' | 'requestedResults'
> {
	const root: Record<string, unknown> = isRecord(schema) ? schema : {};
	const meta = isRecord(root.meta) ? root.meta : null;
	const coordinateSystem = isRecord(root.coordinateSystem) ? root.coordinateSystem : null;

	const modelSpace = normalizeModelSpace(coordinateSystem?.modelSpace) ?? 'planar';
	const structureKind =
		normalizeStructureKind(meta?.structureKind) ?? (modelSpace === 'spatial' ? 'spatial_frame' : 'beam');

	const nodes = Array.isArray(root.nodes) ? (root.nodes as unknown[]) : [];
	const joints = nodes.length > 0
		? unique(
			nodes
				.map((entry: unknown) => {
					if (!isRecord(entry)) return null;
					return normalizeString(entry.label) ?? normalizeString(entry.id);
				})
				.filter((entry): entry is string => Boolean(entry))
		)
		: [];

	const members: string[] = [];
	const supports: string[] = [];
	const loads: string[] = [];

	const objects = Array.isArray(root.objects) ? (root.objects as unknown[]) : [];
	for (const entry of objects) {
		if (!isRecord(entry)) continue;
		const id = normalizeString(entry.label) ?? normalizeString(entry.id) ?? 'object';
		const type = normalizeString(entry.type) ?? 'unknown';
		const nodeRefs = Array.isArray(entry.nodeRefs)
			? entry.nodeRefs
				.map((item) => normalizeString(item))
				.filter((item): item is string => Boolean(item))
			: [];
		const geometry = isRecord(entry.geometry) ? entry.geometry : null;
		const attach = geometry && isRecord(geometry.attach) ? geometry.attach : null;
		const memberId = normalizeString(attach?.memberId);
		const s = typeof attach?.s === 'number' && Number.isFinite(attach.s) ? attach.s : null;

		if (MEMBER_TYPES.has(type)) {
			const jointText = nodeRefs.length >= 2 ? `${nodeRefs[0]} -> ${nodeRefs[1]}` : nodeRefs.join(', ');
			members.push(`${id}: ${type}${jointText ? `, ${jointText}` : ''}`);
			continue;
		}

		if (COMPONENT_TYPES.has(type) || KINEMATIC_PAIR_TYPES.has(type)) {
			const jointText = nodeRefs.length > 0 ? nodeRefs.join(', ') : '';
			members.push(`${id}: ${type}${jointText ? `, ${jointText}` : ''}`);
			continue;
		}

		if (SUPPORT_TYPES.has(type)) {
			const target = memberId ? `${memberId}${s !== null ? `@s=${s}` : ''}` : nodeRefs.join(', ');
			supports.push(`${id}: ${type}${target ? `, ${target}` : ''}`);
			continue;
		}

		if (LOAD_TYPES.has(type)) {
			const direction =
				(typeof geometry?.directionAngle === 'number' && Number.isFinite(geometry.directionAngle)
					? `dir=${geometry.directionAngle}deg`
					: normalizeString(geometry?.direction) || normalizeString(geometry?.cardinal) || null);
			const target = memberId ? `${memberId}${s !== null ? `@s=${s}` : ''}` : nodeRefs.join(', ');
			const parts = [`${id}: ${type}`];
			if (target) parts.push(target);
			if (direction) parts.push(direction);
			loads.push(parts.join(', '));
		}
	}

	const requestedResults: string[] = [];
	const results = Array.isArray(root.results) ? (root.results as unknown[]) : [];
	for (const entry of results) {
		if (!isRecord(entry) || normalizeString(entry.type) !== 'epure') continue;
		const geometry = isRecord(entry.geometry) ? entry.geometry : null;
		const metaRecord = isRecord(entry.meta) ? entry.meta : null;
		const memberId = normalizeString(metaRecord?.baseObjectId) ?? normalizeString(metaRecord?.memberId);
		const component =
			normalizeString(geometry?.component) ??
			normalizeString(geometry?.kind) ??
			normalizeString(geometry?.diagramType) ??
			'epure';
		requestedResults.push(memberId ? `${component} on ${memberId}` : component);
	}

	return {
		structureKind,
		modelSpace,
		joints,
		members: unique(members),
		supports: unique(supports),
		loads: unique(loads),
		requestedResults: unique(requestedResults)
	};
}

export function buildSchemeDescriptionFacts(params: BuildFactsParams): SchemeDescriptionFacts {
	const fallback = inferFromSchema(params.schema);
	const assumptions = unique(normalizeStringList(params.assumptions ?? []));

	if (!params.intent) {
		return {
			...fallback,
			hasImageSource: false,
			assumptions
		};
	}

	const intent = params.intent;
	const jointLabelByKey = new Map(
		intent.joints.map((joint) => [joint.key, displayLabel(joint.label, joint.key)])
	);
	const joints = unique(intent.joints.map((joint) => displayLabel(joint.label, joint.key)).filter(Boolean));
	const members = unique([
		...intent.members.map((member) => formatIntentMember(member, jointLabelByKey)),
		...(intent.components ?? []).map((component) => formatIntentComponent(component, jointLabelByKey)),
		...(intent.kinematicPairs ?? []).map((pair) => formatIntentKinematicPair(pair, jointLabelByKey))
	]);
	const supports = unique(intent.supports.map(formatIntentSupport));
	const loads = unique(intent.loads.map(formatIntentLoad));
	const requestedResults = unique(
		(intent.requestedResults ?? []).map((result) =>
			result.targetMemberKey ? `${result.kind} on ${result.targetMemberKey}` : result.kind
		)
	);

	return {
		structureKind: intent.structureKind,
		modelSpace: intent.modelSpace,
		hasImageSource: intent.source.hasImage,
		joints: joints.length > 0 ? joints : fallback.joints,
		members: members.length > 0 ? members : fallback.members,
		supports: supports.length > 0 ? supports : fallback.supports,
		loads: loads.length > 0 ? loads : fallback.loads,
		requestedResults: requestedResults.length > 0 ? requestedResults : fallback.requestedResults,
		assumptions
	};
}

export function serializeSchemeDescriptionFacts(facts: SchemeDescriptionFacts): string {
	return JSON.stringify(facts, null, 2);
}

const EMPTY_SECTION_MARKERS = new Set([
	'not specified',
	'none',
	'n/a',
	'unknown',
	'не указаны',
	'не указано',
	'не задано',
	'нет'
]);

function isEmptySectionItem(line: string): boolean {
	const normalized = line.replace(/^[-*]\s*/, '').trim().toLowerCase();
	if (!normalized) return true;
	return EMPTY_SECTION_MARKERS.has(normalized);
}

function normalizeGeneratedDescription(text: string): string {
	const unfenced = text
		.replace(/```(?:json|text|markdown)?/gi, '')
		.replace(/```/g, '')
		.trim();
	if (!unfenced) return '';

	const blocks = unfenced
		.split(/\n\s*\n/g)
		.map((block) =>
			block
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean)
		)
		.filter((lines) => lines.length > 0);

	const keptBlocks: string[] = [];
	for (const lines of blocks) {
		const [heading, ...rest] = lines;
		const isSection = /:\s*$/.test(heading);
		if (!isSection) {
			keptBlocks.push(lines.join('\n'));
			continue;
		}
		if (rest.length === 0) continue;
		const hasMeaningfulContent = rest.some((line) => !isEmptySectionItem(line));
		if (!hasMeaningfulContent) continue;
		keptBlocks.push([heading, ...rest].join('\n'));
	}

	return keptBlocks.join('\n\n').trim();
}

function structureKindLabel(kind: StructureKindExtended, language: SchemeDescriptionLanguage): string {
	if (language === 'ru') {
		if (kind === 'beam') return 'Балка';
		if (kind === 'planar_frame') return 'Плоская рама';
		if (kind === 'planar_mechanism') return 'Плоский механизм';
		if (kind === 'spatial_mechanism') return 'Пространственный механизм';
		return 'Пространственная рама';
	}
	if (kind === 'beam') return 'Beam';
	if (kind === 'planar_frame') return 'Planar frame';
	if (kind === 'planar_mechanism') return 'Planar mechanism';
	if (kind === 'spatial_mechanism') return 'Spatial mechanism';
	return 'Spatial frame';
}

function modelSpaceLabel(space: ModelSpace, language: SchemeDescriptionLanguage): string {
	if (language === 'ru') return space === 'spatial' ? 'Пространственная модель' : 'Плоская модель';
	return space === 'spatial' ? 'Spatial model' : 'Planar model';
}

function sectionTitle(key: 'type' | 'members' | 'supports' | 'loads' | 'results' | 'assumptions', language: SchemeDescriptionLanguage): string {
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

function pushList(lines: string[], title: string, values: string[], emptyText: string): void {
	lines.push(`${title}:`);
	if (values.length === 0) {
		lines.push(`- ${emptyText}`);
		return;
	}
	for (const item of values) {
		lines.push(`- ${item}`);
	}
}

export function buildSchemeDescriptionFallback(
	facts: SchemeDescriptionFacts,
	language: SchemeDescriptionLanguage
): string {
	const lines: string[] = [];

	lines.push(`${sectionTitle('type', language)}:`);
	lines.push(`- ${structureKindLabel(facts.structureKind, language)}`);
	lines.push(`- ${modelSpaceLabel(facts.modelSpace, language)}`);
	if (language === 'ru') {
		lines.push(`- Источник: ${facts.hasImageSource ? 'текст + изображение' : 'только текст'}`);
	} else {
		lines.push(`- Source: ${facts.hasImageSource ? 'text + image' : 'text only'}`);
	}
	lines.push('');

	pushList(
		lines,
		sectionTitle('members', language),
		facts.members.length > 0 ? facts.members : facts.joints.map((joint) => `joint ${joint}`),
		language === 'ru' ? 'Не указаны' : 'Not specified'
	);
	lines.push('');

	pushList(
		lines,
		sectionTitle('supports', language),
		facts.supports,
		language === 'ru' ? 'Не указаны' : 'Not specified'
	);
	lines.push('');

	pushList(
		lines,
		sectionTitle('loads', language),
		facts.loads,
		language === 'ru' ? 'Не указаны' : 'Not specified'
	);
	lines.push('');

	pushList(
		lines,
		sectionTitle('results', language),
		facts.requestedResults,
		language === 'ru' ? 'Не указано' : 'Not specified'
	);

	if (facts.assumptions.length > 0) {
		lines.push('');
		pushList(
			lines,
			sectionTitle('assumptions', language),
			facts.assumptions,
			language === 'ru' ? 'Нет' : 'None'
		);
	}

	return lines.join('\n').trim();
}

export async function buildAdaptiveSchemeDescription(
	params: AdaptiveSchemeDescriptionParams
): Promise<AdaptiveSchemeDescriptionResult> {
	const intent =
		params.intent ??
		(params.understanding ? schemeUnderstandingToIntent(params.understanding) : null);
	const assumptions =
		params.assumptions ??
		params.understanding?.assumptions ??
		intent?.assumptions ??
		[];
	const facts = buildSchemeDescriptionFacts({
		schema: params.schema,
		intent,
		assumptions
	});
	const fallbackDescription = buildSchemeDescriptionFallback(facts, params.language);

	try {
		const llmDescription = await generateSchemeDescriptionFromFacts(params.history ?? [], {
			factsJson: serializeSchemeDescriptionFacts(facts),
			language: params.language,
			forcedModel: params.forcedModel,
			fastMode: params.fastMode
		});
		const normalized = normalizeGeneratedDescription(llmDescription.description);
		if (normalized) {
			return {
				description: normalized,
				source: 'llm',
				model: llmDescription.model,
				tokens: llmDescription.tokens,
				facts
			};
		}
	} catch (err) {
		console.warn(
			'[SchemaCheck] adaptive description fallback due to LLM error:',
			err instanceof Error ? err.message : String(err)
		);
	}

	return {
		description: fallbackDescription,
		source: 'fallback',
		facts
	};
}
