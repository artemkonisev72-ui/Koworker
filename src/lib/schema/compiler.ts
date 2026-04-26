import type {
	IntentComponent,
	IntentKinematicPair,
	IntentLoad,
	IntentLoadDirectionHint,
	IntentLoadTarget,
	IntentMember,
	IntentResultKind,
	IntentStructureKind,
	SchemeIntentV1
} from './intent.js';
import { validateSchemeIntent } from './intent.js';
import type { CoordinateSystemV2, NodeV2, ObjectV2, SchemaDataV2 } from './schema-v2.js';
import { validateSchemaDataV2 } from './validate-v2.js';

interface Vec3 {
	x: number;
	y: number;
	z: number;
}

interface MemberPlacement {
	intentKey: string;
	objectId: string;
	startNodeId: string;
	endNodeId: string;
	start: Vec3;
	end: Vec3;
	length: number;
}

interface ComponentPlacement {
	intentKey: string;
	objectId: string;
	centerNodeId: string;
	center: Vec3;
}

interface MechanismLayoutCorrections {
	correctedMemberKeys: Set<string>;
	layoutCorrections: string[];
}

export interface CompileSchemaIntentResult {
	schemaData: SchemaDataV2;
	warnings: string[];
	compilerFacts: {
		templateUsed: string | null;
		generatedNodeIds: string[];
		generatedObjectIds: string[];
	};
}

export class SchemeIntentCompileError extends Error {
	readonly issues: string[];
	readonly warnings: string[];

	constructor(message: string, issues: string[], warnings: string[] = []) {
		super(message);
		this.name = 'SchemeIntentCompileError';
		this.issues = issues;
		this.warnings = warnings;
	}
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

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function addVec(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subVec(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scaleVec(v: Vec3, scalar: number): Vec3 {
	return { x: v.x * scalar, y: v.y * scalar, z: v.z * scalar };
}

function vecLength(v: Vec3): number {
	return Math.hypot(v.x, v.y, v.z);
}

function normalizeVec(v: Vec3): Vec3 | null {
	const length = vecLength(v);
	if (length <= 1e-9) return null;
	return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
	return {
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
		z: a.z + (b.z - a.z) * t
	};
}

function inferLengthHint(member: IntentMember): number {
	const fromHint = toFiniteNumber(member.lengthHint);
	if (fromHint !== null && fromHint > 1e-6) return fromHint;
	return 4;
}

function inferComponentRadius(component: IntentComponent): number {
	const fromHint = toFiniteNumber(component.radiusHint);
	if (fromHint !== null && fromHint > 1e-6) return fromHint;
	return component.kind === 'cam' ? 0.7 : 0.6;
}

function directionFromRelation(
	member: IntentMember,
	structureKind: IntentStructureKind,
	previousDirection: Vec3
): Vec3 {
	const isPlanarKind = structureKind === 'planar_frame' || structureKind === 'planar_mechanism';
	if (structureKind === 'beam') return { x: 1, y: 0, z: 0 };

	if (member.relation === 'collinear_with_prev') {
		const normalized = normalizeVec(previousDirection);
		if (normalized) return normalized;
	}

	if (isPlanarKind) {
		if (member.relation === 'vertical') return { x: 0, y: 1, z: 0 };
		if (member.relation === 'inclined') {
			const angleRad = ((member.angleHintDeg ?? 45) * Math.PI) / 180;
			return { x: Math.cos(angleRad), y: Math.sin(angleRad), z: 0 };
		}
		return { x: 1, y: 0, z: 0 };
	}

	if (member.relation === 'vertical') return { x: 0, y: 0, z: 1 };
	if (member.relation === 'inclined') {
		const angleRad = ((member.angleHintDeg ?? 35) * Math.PI) / 180;
		return { x: Math.cos(angleRad), y: Math.sin(angleRad), z: 0 };
	}
	return { x: 1, y: 0, z: 0 };
}

function buildInitialJointCoords(intent: SchemeIntentV1): Map<string, Vec3> {
	const coords = new Map<string, Vec3>();
	let cursorX = 0;
	let previousDirection: Vec3 = { x: 1, y: 0, z: 0 };

	for (const member of intent.members) {
		const length = inferLengthHint(member);
		const direction = directionFromRelation(member, intent.structureKind, previousDirection);
		const delta = scaleVec(direction, length);
		const start = coords.get(member.startJoint);
		const end = coords.get(member.endJoint);

		if (start && !end) {
			coords.set(member.endJoint, addVec(start, delta));
		} else if (!start && end) {
			coords.set(member.startJoint, subVec(end, delta));
		} else if (!start && !end) {
			const startPoint: Vec3 = { x: cursorX, y: 0, z: 0 };
			coords.set(member.startJoint, startPoint);
			const endPoint = addVec(startPoint, delta);
			coords.set(member.endJoint, endPoint);
			cursorX = Math.max(cursorX, endPoint.x) + Math.max(1.5, length * 0.3);
		}
		previousDirection = delta;
	}

	for (const joint of intent.joints) {
		if (coords.has(joint.key)) continue;
		coords.set(joint.key, { x: cursorX, y: 0, z: 0 });
		cursorX += 3;
	}

	if (intent.structureKind === 'beam') {
		for (const [key, value] of coords.entries()) {
			coords.set(key, { x: value.x, y: 0, z: 0 });
		}
	} else if (intent.structureKind === 'planar_frame' || intent.structureKind === 'planar_mechanism') {
		for (const [key, value] of coords.entries()) {
			coords.set(key, { x: value.x, y: value.y, z: 0 });
		}
	}

	return coords;
}

function memberTouchesJoint(member: IntentMember, jointKey: string): boolean {
	return member.startJoint === jointKey || member.endJoint === jointKey;
}

function otherMemberJoint(member: IntentMember, jointKey: string): string | null {
	if (member.startJoint === jointKey) return member.endJoint;
	if (member.endJoint === jointKey) return member.startJoint;
	return null;
}

function memberJointDegree(intent: SchemeIntentV1): Map<string, number> {
	const degree = new Map<string, number>();
	for (const member of intent.members) {
		degree.set(member.startJoint, (degree.get(member.startJoint) ?? 0) + 1);
		degree.set(member.endJoint, (degree.get(member.endJoint) ?? 0) + 1);
	}
	return degree;
}

function inferTerminalJointFromMemberReference(
	intent: SchemeIntentV1,
	memberKey: string | undefined
): string | null {
	if (!memberKey) return null;
	const member = intent.members.find((candidate) => candidate.key === memberKey);
	if (!member) return null;
	const degree = memberJointDegree(intent);
	const startDegree = degree.get(member.startJoint) ?? 0;
	const endDegree = degree.get(member.endJoint) ?? 0;
	if (endDegree <= 1 && startDegree > 1) return member.endJoint;
	if (startDegree <= 1 && endDegree > 1) return member.startJoint;
	return member.endJoint;
}

function resolvePairJointKeyFromIntent(
	intent: SchemeIntentV1,
	pair: IntentKinematicPair
): string | null {
	if (pair.jointKey) return pair.jointKey;
	if (pair.kind === 'prismatic_pair' || pair.kind === 'slot_pair') {
		return inferTerminalJointFromMemberReference(intent, pair.memberKeys?.[0]);
	}
	return null;
}

function shouldUseHorizontalSliderGuide(pair: IntentKinematicPair): boolean {
	return pair.kind === 'prismatic_pair' && pair.guideHint !== 'vertical' && pair.guideHint !== 'member_local';
}

function guideOffsetFromHint(value: unknown, referenceLength: number): number {
	const numeric = toFiniteNumber(value);
	if (numeric !== null) return numeric;
	if (typeof value === 'string' && value.trim()) {
		return Math.max(0.25, referenceLength * 0.25);
	}
	return 0;
}

function preferCrankCandidate(
	intent: SchemeIntentV1,
	candidates: IntentMember[],
	couplerJoint: string
): { crank: IntentMember; pivotJoint: string } | null {
	if (candidates.length === 0) return null;
	const revoluteJointKeys = new Set(
		intent.kinematicPairs
			.filter((pair) => pair.kind === 'revolute_pair' && pair.jointKey)
			.map((pair) => pair.jointKey as string)
	);
	const scored = candidates
		.map((crank) => {
			const pivotJoint = otherMemberJoint(crank, couplerJoint);
			if (!pivotJoint) return null;
			const hasRevolutePivot = revoluteJointKeys.has(pivotJoint);
			const hasAngleHint = typeof crank.angleHintDeg === 'number' && Number.isFinite(crank.angleHintDeg);
			const labelLooksLikeGround =
				pivotJoint.toLowerCase() === 'o' || (crank.label ?? crank.key).toLowerCase().startsWith('o');
			const score = (hasRevolutePivot ? 4 : 0) + (hasAngleHint ? 2 : 0) + (labelLooksLikeGround ? 1 : 0);
			return { crank, pivotJoint, score };
		})
		.filter((entry): entry is { crank: IntentMember; pivotJoint: string; score: number } =>
			Boolean(entry)
		);
	if (scored.length === 0) return null;
	scored.sort((a, b) => b.score - a.score);
	return { crank: scored[0].crank, pivotJoint: scored[0].pivotJoint };
}

function recomputeCouplerFromCrank(
	coords: Map<string, Vec3>,
	crank: IntentMember,
	pivotJoint: string,
	couplerJoint: string
): Vec3 | null {
	const pivot = coords.get(pivotJoint);
	if (!pivot) return coords.get(couplerJoint) ?? null;
	if (typeof crank.angleHintDeg !== 'number' || !Number.isFinite(crank.angleHintDeg)) {
		return coords.get(couplerJoint) ?? null;
	}
	const crankLength = inferLengthHint(crank);
	const angleRad = (crank.angleHintDeg * Math.PI) / 180;
	const delta = { x: Math.cos(angleRad) * crankLength, y: Math.sin(angleRad) * crankLength, z: 0 };
	const coupler =
		crank.startJoint === pivotJoint && crank.endJoint === couplerJoint
			? addVec(pivot, delta)
			: crank.endJoint === pivotJoint && crank.startJoint === couplerJoint
				? subVec(pivot, delta)
				: (coords.get(couplerJoint) ?? null);
	if (coupler) coords.set(couplerJoint, coupler);
	return coupler;
}

function applyPlanarMechanismLayoutCorrections(
	intent: SchemeIntentV1,
	coords: Map<string, Vec3>
): MechanismLayoutCorrections {
	const correctedMemberKeys = new Set<string>();
	const layoutCorrections: string[] = [];
	if (intent.structureKind !== 'planar_mechanism') {
		return { correctedMemberKeys, layoutCorrections };
	}

	for (const pair of intent.kinematicPairs) {
		if (!shouldUseHorizontalSliderGuide(pair)) continue;
		const sliderJoint = resolvePairJointKeyFromIntent(intent, pair);
		if (!sliderJoint) continue;
		const rodCandidates = intent.members.filter((member) => memberTouchesJoint(member, sliderJoint));
		for (const rod of rodCandidates) {
			const couplerJoint = otherMemberJoint(rod, sliderJoint);
			if (!couplerJoint) continue;
			const crankCandidate = preferCrankCandidate(
				intent,
				intent.members.filter((member) => member.key !== rod.key && memberTouchesJoint(member, couplerJoint)),
				couplerJoint
			);
			if (!crankCandidate) continue;

			const { crank, pivotJoint } = crankCandidate;
			const pivot = coords.get(pivotJoint);
			if (!pivot) continue;
			const coupler = recomputeCouplerFromCrank(coords, crank, pivotJoint, couplerJoint);
			if (!coupler) continue;

			const rodLength = inferLengthHint(rod);
			const guideOffset = guideOffsetFromHint(pair.guideOffsetHint, inferLengthHint(crank));
			const guideY = pivot.y + guideOffset;
			const transverse = coupler.y - guideY;
			const axialDistance =
				Math.abs(transverse) < rodLength
					? Math.sqrt(Math.max(rodLength * rodLength - transverse * transverse, 0))
					: Math.max(rodLength * 0.85, Math.abs(transverse) * 0.5);
			const currentSlider = coords.get(sliderJoint);
			const sign =
				currentSlider && Math.abs(currentSlider.x - coupler.x) > 1e-9
					? Math.sign(currentSlider.x - coupler.x)
					: Math.sign(coupler.x - pivot.x) || 1;
			const slider: Vec3 = {
				x: coupler.x + (sign || 1) * Math.max(axialDistance, rodLength * 0.35),
				y: guideY,
				z: 0
			};
			coords.set(sliderJoint, slider);
			correctedMemberKeys.add(rod.key);
			layoutCorrections.push(
				guideOffset
					? `slider-crank pair "${pair.key}" placed joint "${sliderJoint}" on eccentric horizontal guide through "${pivotJoint}"+${guideOffset}`
					: `slider-crank pair "${pair.key}" placed joint "${sliderJoint}" on horizontal guide through "${pivotJoint}"`
			);
			break;
		}
	}

	return { correctedMemberKeys, layoutCorrections };
}

function angleDegFromPoints(start: Vec3, end: Vec3): number {
	return (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
}

function buildCoordinateSystem(intent: SchemeIntentV1): CoordinateSystemV2 {
	return {
		xUnit: 'm',
		yUnit: 'm',
		zUnit: 'm',
		origin: { x: 0, y: 0 },
		modelSpace: intent.modelSpace,
		axisOrientation: 'right-handed',
		originPolicy: 'auto',
		planeNormal: { x: 0, y: 0, z: 1 },
		referenceUp: { x: 0, y: 0, z: 1 },
		secondaryReference: { x: 1, y: 0, z: 0 },
		projectionPreset: intent.modelSpace === 'spatial' ? 'auto_isometric' : 'xy'
	};
}

function detectTemplate(intent: SchemeIntentV1): string | null {
	if (intent.structureKind === 'beam') {
		const fixedCount = intent.supports.filter((support) => support.kind === 'fixed_wall').length;
		const supportCount = intent.supports.length;
		if (fixedCount === 1 && supportCount === 1) return 'cantilever_beam';
		if (supportCount >= 2) return 'two_support_beam';
		return 'simple_beam';
	}
	if (intent.structureKind === 'planar_frame') {
		if (intent.members.length <= 2) return 'L-frame';
		return 'single-bay_planar_frame';
	}
	if (intent.structureKind === 'planar_mechanism') {
		return 'planar_mechanism';
	}
	if (intent.structureKind === 'spatial_mechanism') {
		return 'spatial_mechanism';
	}
	return 'simple_spatial_frame_skeleton';
}

function resolveMomentDirection(hint: IntentLoadDirectionHint | undefined): 'cw' | 'ccw' {
	if (hint === 'cw') return 'cw';
	return 'ccw';
}

function mapDirectionToAngle(
	hint: IntentLoadDirectionHint | undefined,
	warnings: string[],
	context: string
): number {
	if (!hint) return -90;
	if (hint === 'up' || hint === '+y') return 90;
	if (hint === 'down' || hint === '-y') return -90;
	if (hint === 'left' || hint === '-x') return 180;
	if (hint === 'right' || hint === '+x') return 0;
	if (hint === 'member_local_positive') return 90;
	if (hint === 'member_local_negative') return -90;
	if (hint === 'cw' || hint === 'ccw') {
		warnings.push(`${context} used rotational direction for non-moment load; defaulted to -90°`);
		return -90;
	}
	return -90;
}

function normalizeMagnitudeAsNumber(value: unknown): number | null {
	return toFiniteNumber(value);
}

function extractLoadIntensity(load: IntentLoad): number | { start: number; end: number } {
	if (typeof load.magnitudeHint === 'object' && load.magnitudeHint !== null) {
		const start = toFiniteNumber(load.magnitudeHint.start);
		const end = toFiniteNumber(load.magnitudeHint.end);
		if (start !== null && end !== null) return { start, end };
	}
	const scalar = normalizeMagnitudeAsNumber(load.magnitudeHint);
	return scalar ?? 1;
}

function normalizeRequestedResultKind(
	kind: IntentResultKind,
	structureKind: IntentStructureKind
): IntentResultKind {
	if (structureKind === 'planar_frame') {
		if (kind === 'Q') return 'Vy';
		if (kind === 'M') return 'Mz';
	}
	return kind;
}

function targetIsJoint(
	target: IntentLoadTarget
): target is Extract<IntentLoadTarget, { jointKey: string }> {
	return 'jointKey' in target;
}

function targetIsMemberPoint(
	target: IntentLoadTarget
): target is Extract<IntentLoadTarget, { memberKey: string; s: number }> {
	return 'memberKey' in target && 's' in target;
}

function targetIsMemberInterval(
	target: IntentLoadTarget
): target is Extract<IntentLoadTarget, { memberKey: string; fromS: number; toS: number }> {
	return 'memberKey' in target && 'fromS' in target && 'toS' in target;
}

export function compileSchemeIntent(input: unknown): CompileSchemaIntentResult {
	const validation = validateSchemeIntent(input);
	if (!validation.ok || !validation.value) {
		throw new SchemeIntentCompileError(
			'SchemeIntent validation failed',
			validation.errors,
			validation.warnings
		);
	}
	const intent = validation.value;
	const warnings = [...validation.warnings];
	const templateUsed = detectTemplate(intent);

	const jointCoords = buildInitialJointCoords(intent);
	const { correctedMemberKeys, layoutCorrections } = applyPlanarMechanismLayoutCorrections(
		intent,
		jointCoords
	);
	const jointToNodeId = new Map<string, string>();
	const nodes: NodeV2[] = intent.joints.map((joint, index) => {
		const coord = jointCoords.get(joint.key) ?? { x: index * 3, y: 0, z: 0 };
		const nodeId = `N${index + 1}`;
		jointToNodeId.set(joint.key, nodeId);
		return {
			id: nodeId,
			x: coord.x,
			y: coord.y,
			z: coord.z,
			label: joint.label ?? joint.key,
			meta: {
				intentKey: joint.key,
				...(joint.role ? { role: joint.role } : {})
			}
		};
	});

	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const objects: ObjectV2[] = [];
	const memberByIntentKey = new Map<string, MemberPlacement>();
	const componentByIntentKey = new Map<string, ComponentPlacement>();

	for (const [index, member] of intent.members.entries()) {
		const startNodeId = jointToNodeId.get(member.startJoint);
		const endNodeId = jointToNodeId.get(member.endJoint);
		if (!startNodeId || !endNodeId) {
			throw new SchemeIntentCompileError(
				'Cannot compile members with unresolved joints',
				[`members[${index}] references unresolved joints`],
				warnings
			);
		}

		const startNode = nodeById.get(startNodeId);
		const endNode = nodeById.get(endNodeId);
		if (!startNode || !endNode) {
			throw new SchemeIntentCompileError(
				'Internal compiler error: node map is inconsistent',
				[`members[${index}] node lookup failed`],
				warnings
			);
		}

		const objectId = `${member.kind}_${index + 1}`;
		const start: Vec3 = { x: startNode.x, y: startNode.y, z: startNode.z ?? 0 };
		const end: Vec3 = { x: endNode.x, y: endNode.y, z: endNode.z ?? 0 };
		const renderedLength = Math.max(1e-6, vecLength(subVec(end, start)));
		const length = inferLengthHint(member) || renderedLength;
		const angleDeg = correctedMemberKeys.has(member.key)
			? angleDegFromPoints(start, end)
			: (member.angleHintDeg ?? angleDegFromPoints(start, end));
		const geometry: Record<string, unknown> = {
			length,
			angleDeg
		};

		if (member.relation === 'collinear_with_prev' && index > 0) {
			const previousId = `${intent.members[index - 1].kind}_${index}`;
			geometry.constraints = { collinearWith: [previousId] };
		}

		objects.push({
			id: objectId,
			type: member.kind,
			nodeRefs: [startNodeId, endNodeId],
			geometry,
			label: member.label ?? member.key,
			meta: {
				intentKey: member.key,
				...(member.groupHint ? { groupHint: member.groupHint } : {})
			}
		});

		memberByIntentKey.set(member.key, {
			intentKey: member.key,
			objectId,
			startNodeId,
			endNodeId,
			start,
			end,
			length
		});
	}

	for (const [index, component] of intent.components.entries()) {
		const centerNodeId = jointToNodeId.get(component.centerJoint);
		if (!centerNodeId) {
			throw new SchemeIntentCompileError(
				'Cannot compile components with unresolved joints',
				[`components[${index}] references unknown centerJoint "${component.centerJoint}"`],
				warnings
			);
		}
		const centerNode = nodeById.get(centerNodeId);
		if (!centerNode) {
			throw new SchemeIntentCompileError(
				'Internal compiler error: node map is inconsistent',
				[`components[${index}] node lookup failed`],
				warnings
			);
		}
		const objectId = `${component.kind}_${index + 1}`;
		const geometry: Record<string, unknown> = {
			radius: inferComponentRadius(component)
		};
		if (component.profileHint) {
			geometry.profileHint = component.profileHint;
		}
		objects.push({
			id: objectId,
			type: component.kind,
			nodeRefs: [centerNodeId],
			geometry,
			label: component.label ?? component.key,
			meta: {
				intentKey: component.key
			}
		});
		componentByIntentKey.set(component.key, {
			intentKey: component.key,
			objectId,
			centerNodeId,
			center: { x: centerNode.x, y: centerNode.y, z: centerNode.z ?? 0 }
		});
	}

	let nextNodeIndex = nodes.length + 1;
	const attachNodeCache = new Map<string, string>();

	function createNode(
		coord: Vec3,
		label: string,
		meta: Record<string, unknown>,
		options: { visible?: boolean } = {}
	): string {
		const id = `N${nextNodeIndex}`;
		nextNodeIndex += 1;
		const node: NodeV2 = {
			id,
			x: coord.x,
			y: coord.y,
			z: coord.z,
			...(label.trim() ? { label } : {}),
			...(typeof options.visible === 'boolean' ? { visible: options.visible } : {}),
			meta
		};
		nodes.push(node);
		nodeById.set(id, nodes[nodes.length - 1]);
		return id;
	}

	function ensureMemberAttachmentNode(memberKey: string, sRaw: number, tag: string): string {
		const placement = memberByIntentKey.get(memberKey);
		if (!placement) {
			throw new SchemeIntentCompileError(
				'Failed to create attachment node',
				[`Unknown memberKey "${memberKey}" for attachment`],
				warnings
			);
		}
		const s = clamp01(sRaw);
		const cacheKey = `${placement.objectId}:${s.toFixed(6)}`;
		const cached = attachNodeCache.get(cacheKey);
		if (cached) return cached;
		const coord = lerpVec(placement.start, placement.end, s);
		const nodeId = createNode(coord, tag, {
			synthetic: true,
			memberId: placement.objectId,
			s
		});
		attachNodeCache.set(cacheKey, nodeId);
		return nodeId;
	}

	function resolveGuideDirection(
		guideHint: IntentKinematicPair['guideHint'] | undefined,
		memberHint: string | undefined
	): Vec3 {
		if (guideHint === 'vertical') return { x: 0, y: 1, z: 0 };
		if (guideHint === 'member_local' && memberHint) {
			const placement = memberByIntentKey.get(memberHint);
			if (placement) {
				const inferred = normalizeVec(subVec(placement.end, placement.start));
				if (inferred) return inferred;
			}
		}
		return { x: 1, y: 0, z: 0 };
	}

	function createGuideNodes(
		baseNodeId: string,
		tag: string,
		guideHint: IntentKinematicPair['guideHint'] | undefined,
		memberHint: string | undefined
	): [string, string] {
		const baseNode = nodeById.get(baseNodeId);
		if (!baseNode) {
			throw new SchemeIntentCompileError(
				'Failed to compile kinematic pair',
				[`base node "${baseNodeId}" does not exist`],
				warnings
			);
		}
		const baseCoord: Vec3 = { x: baseNode.x, y: baseNode.y, z: baseNode.z ?? 0 };
		const direction = resolveGuideDirection(guideHint, memberHint);
		const guideHalfLength = 0.9;
		const guideStart = createNode(
			subVec(baseCoord, scaleVec(direction, guideHalfLength)),
			'',
			{ synthetic: true, role: 'pair_guide', helperLabel: `${tag}a` },
			{ visible: false }
		);
		const guideEnd = createNode(
			addVec(baseCoord, scaleVec(direction, guideHalfLength)),
			'',
			{ synthetic: true, role: 'pair_guide', helperLabel: `${tag}b` },
			{ visible: false }
		);
		return [guideStart, guideEnd];
	}

	for (const [index, support] of intent.supports.entries()) {
		const objectId = `support_${index + 1}`;
		const geometry: Record<string, unknown> = {};
		let baseNodeId: string | null = null;
		let memberObjectId: string | null = null;
		let memberS: number | null = null;

		if (support.jointKey) {
			baseNodeId = jointToNodeId.get(support.jointKey) ?? null;
		}
		if (!baseNodeId && support.memberKey) {
			const s = support.s ?? 0.5;
			baseNodeId = ensureMemberAttachmentNode(support.memberKey, s, `S${index + 1}`);
			const placement = memberByIntentKey.get(support.memberKey);
			if (placement) {
				memberObjectId = placement.objectId;
				memberS = clamp01(s);
				geometry.attach = {
					memberId: placement.objectId,
					s: memberS,
					side: 'center'
				};
			}
		}

		if (!baseNodeId) {
			throw new SchemeIntentCompileError(
				'Failed to compile supports',
				[`supports[${index}] has unresolved placement`],
				warnings
			);
		}

		if (support.kind === 'fixed_wall' && support.sideHint) {
			geometry.wallSide = support.sideHint;
		}

		const supportObject: ObjectV2 = {
			id: objectId,
			type: support.kind,
			nodeRefs: [baseNodeId],
			geometry,
			meta: {
				intentKey: support.key,
				...(memberObjectId ? { memberId: memberObjectId } : {}),
				...(memberS !== null ? { s: memberS } : {})
			}
		};

		if (support.kind === 'slider') {
			const [guideStart, guideEnd] = createGuideNodes(
				baseNodeId,
				`G${index + 1}`,
				support.guideHint,
				support.memberKey
			);
			supportObject.nodeRefs = [baseNodeId, guideStart, guideEnd];
		}

		objects.push(supportObject);
	}

	for (const [index, pair] of intent.kinematicPairs.entries()) {
		const objectId = `${pair.kind}_${index + 1}`;
		const geometry: Record<string, unknown> = {};
		const nodeRefs: string[] = [];
		const memberHint = pair.memberKeys?.[0];

		let baseNodeId: string | null = null;
		const resolvedPairJointKey = resolvePairJointKeyFromIntent(intent, pair);
		if (resolvedPairJointKey) {
			baseNodeId = jointToNodeId.get(resolvedPairJointKey) ?? null;
		}
		if (!baseNodeId && memberHint) {
			const placement = memberByIntentKey.get(memberHint);
			if (placement) {
				baseNodeId = placement.startNodeId;
				geometry.attach = {
					memberId: placement.objectId,
					s: 0,
					side: 'center'
				};
			}
		}
		if (!baseNodeId && pair.componentKeys && pair.componentKeys.length > 0) {
			const componentPlacement = componentByIntentKey.get(pair.componentKeys[0]);
			if (componentPlacement) {
				baseNodeId = componentPlacement.centerNodeId;
			}
		}

		if (pair.kind === 'revolute_pair') {
			if (!baseNodeId) {
				throw new SchemeIntentCompileError(
					'Failed to compile kinematic pairs',
					[`kinematicPairs[${index}] revolute_pair has unresolved placement`],
					warnings
				);
			}
			nodeRefs.push(baseNodeId);
		} else if (pair.kind === 'prismatic_pair' || pair.kind === 'slot_pair') {
			if (!baseNodeId) {
				throw new SchemeIntentCompileError(
					'Failed to compile kinematic pairs',
					[`kinematicPairs[${index}] ${pair.kind} has unresolved placement`],
					warnings
				);
			}
			const [guideStart, guideEnd] = createGuideNodes(
				baseNodeId,
				`P${index + 1}`,
				pair.guideHint,
				memberHint
			);
			nodeRefs.push(baseNodeId, guideStart, guideEnd);
		} else {
			const candidates: string[] = [];
			if (pair.componentKeys && pair.componentKeys.length > 0) {
				for (const key of pair.componentKeys) {
					const placement = componentByIntentKey.get(key);
					if (placement && !candidates.includes(placement.centerNodeId)) {
						candidates.push(placement.centerNodeId);
					}
				}
			}
			if (pair.memberKeys && pair.memberKeys.length > 0) {
				for (const key of pair.memberKeys) {
					const placement = memberByIntentKey.get(key);
					if (placement && !candidates.includes(placement.startNodeId)) {
						candidates.push(placement.startNodeId);
					}
				}
			}
			if (baseNodeId && !candidates.includes(baseNodeId)) {
				candidates.unshift(baseNodeId);
			}
			if (candidates.length < 2) {
				throw new SchemeIntentCompileError(
					'Failed to compile kinematic pairs',
					[`kinematicPairs[${index}] ${pair.kind} requires two reference nodes`],
					warnings
				);
			}
			nodeRefs.push(candidates[0], candidates[1]);
		}

		if (pair.meshType) geometry.meshType = pair.meshType;
		if (pair.beltKind) geometry.beltKind = pair.beltKind;
		if (typeof pair.crossed === 'boolean') geometry.crossed = pair.crossed;
		if (pair.followerType) geometry.followerType = pair.followerType;
		if (pair.guideHint) geometry.guideHint = pair.guideHint;
		if (pair.guideOffsetHint !== undefined) geometry.guideOffset = pair.guideOffsetHint;
		if (pair.grounded !== undefined) geometry.grounded = pair.grounded;

		objects.push({
			id: objectId,
			type: pair.kind,
			nodeRefs,
			geometry,
			label: pair.label ?? pair.key,
			meta: {
				intentKey: pair.key,
				...(pair.grounded !== undefined ? { grounded: pair.grounded } : {}),
				...(pair.memberKeys && pair.memberKeys.length > 0 ? { memberKeys: pair.memberKeys } : {}),
				...(pair.componentKeys && pair.componentKeys.length > 0 ? { componentKeys: pair.componentKeys } : {})
			}
		});
	}

	for (const [index, load] of intent.loads.entries()) {
		const objectId = `load_${index + 1}`;
		if (load.kind === 'distributed') {
			let memberKey: string | null = null;
			let fromS = 0;
			let toS = 1;

			if (targetIsMemberInterval(load.target)) {
				memberKey = load.target.memberKey;
				fromS = clamp01(load.target.fromS);
				toS = clamp01(load.target.toS);
			} else if (targetIsMemberPoint(load.target)) {
				memberKey = load.target.memberKey;
				fromS = clamp01(load.target.s - 0.1);
				toS = clamp01(load.target.s + 0.1);
				warnings.push(
					`loads[${index}] distributed load had point target and was expanded to interval [${fromS.toFixed(2)}, ${toS.toFixed(2)}]`
				);
			}

			if (!memberKey) {
				throw new SchemeIntentCompileError(
					'Failed to compile distributed load',
					[`loads[${index}] distributed load requires member interval target`],
					warnings
				);
			}

			if (toS < fromS) {
				const temp = fromS;
				fromS = toS;
				toS = temp;
			}

			const placement = memberByIntentKey.get(memberKey);
			if (!placement) {
				throw new SchemeIntentCompileError(
					'Failed to compile distributed load',
					[`loads[${index}] references unknown member "${memberKey}"`],
					warnings
				);
			}

			const startNodeId = ensureMemberAttachmentNode(memberKey, fromS, `D${index + 1}a`);
			const endNodeId = ensureMemberAttachmentNode(memberKey, toS, `D${index + 1}b`);
			const intensity = extractLoadIntensity(load);
			const geometry: Record<string, unknown> = {
				kind: load.distributionKind ?? 'uniform',
				intensity,
				directionAngle: mapDirectionToAngle(
					load.directionHint,
					warnings,
					`loads[${index}]`
				)
			};

			objects.push({
				id: objectId,
				type: 'distributed',
				nodeRefs: [startNodeId, endNodeId],
				geometry,
				...(load.label ? { label: load.label } : {}),
				meta: {
					intentKey: load.key,
					memberId: placement.objectId,
					fromS,
					toS
				}
			});
			continue;
		}

		let nodeId: string | null = null;
		let attachMemberId: string | null = null;
		let attachS: number | null = null;

		if (targetIsJoint(load.target)) {
			nodeId = jointToNodeId.get(load.target.jointKey) ?? null;
		} else if (targetIsMemberPoint(load.target)) {
			nodeId = ensureMemberAttachmentNode(load.target.memberKey, load.target.s, `L${index + 1}`);
			const placement = memberByIntentKey.get(load.target.memberKey);
			if (placement) {
				attachMemberId = placement.objectId;
				attachS = clamp01(load.target.s);
			}
		} else if (targetIsMemberInterval(load.target)) {
			const midS = clamp01((load.target.fromS + load.target.toS) / 2);
			nodeId = ensureMemberAttachmentNode(load.target.memberKey, midS, `L${index + 1}`);
			const placement = memberByIntentKey.get(load.target.memberKey);
			if (placement) {
				attachMemberId = placement.objectId;
				attachS = midS;
			}
			warnings.push(
				`loads[${index}] ${load.kind} load had interval target and was anchored at midpoint s=${midS.toFixed(2)}`
			);
		}

		if (!nodeId) {
			throw new SchemeIntentCompileError(
				'Failed to compile loads',
				[`loads[${index}] has unresolved target`],
				warnings
			);
		}

		if (load.kind === 'moment') {
			const magnitude = normalizeMagnitudeAsNumber(load.magnitudeHint);
			const geometry: Record<string, unknown> = {
				direction: resolveMomentDirection(load.directionHint),
				...(magnitude !== null ? { magnitude } : {})
			};
			if (attachMemberId && attachS !== null) {
				geometry.attach = {
					memberId: attachMemberId,
					s: attachS,
					side: 'center'
				};
			}
			objects.push({
				id: objectId,
				type: 'moment',
				nodeRefs: [nodeId],
				geometry,
				...(load.label ? { label: load.label } : {}),
				meta: {
					intentKey: load.key,
					...(attachMemberId ? { memberId: attachMemberId } : {}),
					...(attachS !== null ? { s: attachS } : {})
				}
			});
			continue;
		}

		const magnitude = normalizeMagnitudeAsNumber(load.magnitudeHint);
		const geometry: Record<string, unknown> = {
			directionAngle: mapDirectionToAngle(load.directionHint, warnings, `loads[${index}]`),
			...(magnitude !== null ? { magnitude } : {})
		};
		if (attachMemberId && attachS !== null) {
			geometry.attach = {
				memberId: attachMemberId,
				s: attachS,
				side: 'center'
			};
		}

		objects.push({
			id: objectId,
			type: 'force',
			nodeRefs: [nodeId],
			geometry,
			...(load.label ? { label: load.label } : {}),
			meta: {
				intentKey: load.key,
				...(attachMemberId ? { memberId: attachMemberId } : {}),
				...(attachS !== null ? { s: attachS } : {})
			}
		});
	}

	const requestedResults =
		intent.requestedResults?.map((result) => ({
			...result,
			kind: normalizeRequestedResultKind(result.kind, intent.structureKind)
		})) ?? [];

	const schemaCandidate: SchemaDataV2 = {
		version: '2.0',
		meta: {
			taskDomain: 'mechanics',
			catalogVersion: '2026-04-17',
			layoutPipeline: 'topology-first',
			structureKind: intent.structureKind,
			intentVersion: intent.version,
			intentConfidence: intent.confidence,
			templateUsed,
			...(layoutCorrections.length > 0
				? { layoutAutoCorrected: true, layoutCorrections }
				: {}),
			...(requestedResults.length > 0 ? { requestedResults } : {})
		},
		coordinateSystem: buildCoordinateSystem(intent),
		nodes,
		objects,
		results: [],
		annotations: [],
		assumptions: intent.assumptions,
		ambiguities: intent.ambiguities
	};

	const schemaValidation = validateSchemaDataV2(schemaCandidate);
	if (!schemaValidation.ok || !schemaValidation.value) {
		throw new SchemeIntentCompileError(
			'Compiled schema is invalid',
			schemaValidation.errors,
			[...warnings, ...(schemaValidation.warnings ?? [])]
		);
	}

	const normalizedWarnings = [...warnings, ...(schemaValidation.warnings ?? [])];
	return {
		schemaData: schemaValidation.value,
		warnings: normalizedWarnings,
		compilerFacts: {
			templateUsed,
			generatedNodeIds: schemaValidation.value.nodes.map((node) => node.id),
			generatedObjectIds: schemaValidation.value.objects.map((object) => object.id)
		}
	};
}
