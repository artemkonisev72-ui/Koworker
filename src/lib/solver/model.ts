import { validateSchemaAny } from '$lib/schema/schema-any.js';
import type { SchemaAny } from '$lib/schema/schema-any.js';
import type { CoordinateSystemV2, NodeV2, ObjectV2, ResultV2, SchemaDataV2 } from '$lib/schema/schema-v2.js';

type StructureKind =
	| 'beam'
	| 'planar_frame'
	| 'spatial_frame'
	| 'planar_mechanism'
	| 'spatial_mechanism';
type ModelSpace = 'planar' | 'spatial';
type SolverResultComponent = 'N' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz';

interface SolverVector3 {
	x: number;
	y: number;
	z: number;
}

export interface SolverMember {
	id: string;
	kind: string;
	startNodeId: string;
	endNodeId: string;
	length: number | null;
	localFrame: {
		x: SolverVector3;
		y: SolverVector3;
		z: SolverVector3;
	};
	axisOrigin: 'member_start' | 'free_end';
}

export interface SolverSupport {
	id: string;
	type: string;
	nodeId?: string;
	memberId?: string;
	s?: number;
	side?: string;
}

export interface SolverLoad {
	id: string;
	kind: 'force' | 'moment' | 'distributed';
	nodeId?: string;
	nodeIds?: string[];
	memberId?: string;
	s?: number;
	direction?:
		| { angleDeg: number }
		| { vector: { x: number; y: number } }
		| { rotation: 'cw' | 'ccw' };
	magnitude?: unknown;
}

export interface SolverRequestedResult {
	memberId?: string;
	component: SolverResultComponent;
}

export interface SolverSignConvention {
	beam: {
		cantileverAxisOrigin: 'free_end';
		momentCompressedFiberRule: 'epure.compressedFiberSide';
	};
	planarFrame: {
		legacyKindMapping: {
			N: 'N';
			Q: 'Vy';
			M: 'Mz';
		};
	};
	spatialFrame: {
		components: SolverResultComponent[];
	};
}

export interface SolverModelV1 {
	version: 'solver-1.0';
	structureKind: StructureKind;
	modelSpace: ModelSpace;
	members: SolverMember[];
	supports: SolverSupport[];
	loads: SolverLoad[];
	requestedResults: SolverRequestedResult[];
	signConvention: SolverSignConvention;
}

export interface BuildSolverModelResult {
	solverModel: SolverModelV1;
	warnings: string[];
}

export class SolverModelBuildError extends Error {
	readonly issues: string[];
	readonly warnings: string[];

	constructor(message: string, issues: string[], warnings: string[] = []) {
		super(message);
		this.name = 'SolverModelBuildError';
		this.issues = issues;
		this.warnings = warnings;
	}
}

interface Vec3 {
	x: number;
	y: number;
	z: number;
}

const MEMBER_TYPES = new Set(['bar', 'cable', 'spring', 'damper']);
const SUPPORT_TYPES = new Set(['fixed_wall', 'hinge_fixed', 'hinge_roller', 'internal_hinge', 'slider']);
const COMPONENT_ORDER: SolverResultComponent[] = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'];
const SUPPORTS_AT_CANTILEVER_END = new Set(['fixed_wall', 'hinge_fixed', 'hinge_roller']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string') return null;
	const compact = value.replace(',', '.').trim();
	if (!compact) return null;
	const parsed = Number.parseFloat(compact);
	return Number.isFinite(parsed) ? parsed : null;
}

function toVec3(node: NodeV2): Vec3 {
	return { x: node.x, y: node.y, z: node.z ?? 0 };
}

function subVec(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dotVec(a: Vec3, b: Vec3): number {
	return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossVec(a: Vec3, b: Vec3): Vec3 {
	return {
		x: a.y * b.z - a.z * b.y,
		y: a.z * b.x - a.x * b.z,
		z: a.x * b.y - a.y * b.x
	};
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

function projectOntoPlane(vector: Vec3, normal: Vec3): Vec3 {
	const scale = dotVec(vector, normal);
	return subVec(vector, scaleVec(normal, scale));
}

function normalizeStructureKind(value: unknown): StructureKind {
	if (typeof value !== 'string') return 'beam';
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
	if (
		normalized === 'beam' ||
		normalized === 'planar_frame' ||
		normalized === 'spatial_frame' ||
		normalized === 'planar_mechanism' ||
		normalized === 'spatial_mechanism'
	) {
		return normalized;
	}
	return 'beam';
}

function normalizeModelSpace(value: unknown, structureKind: StructureKind): ModelSpace {
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (normalized === 'planar' || normalized === 'spatial') return normalized;
	}
	return structureKind === 'spatial_frame' || structureKind === 'spatial_mechanism'
		? 'spatial'
		: 'planar';
}

function getVector(
	value: unknown,
	fallback: Vec3
): Vec3 {
	if (!isRecord(value)) return fallback;
	const x = toFiniteNumber(value.x);
	const y = toFiniteNumber(value.y);
	const z = toFiniteNumber(value.z);
	if (x === null || y === null || z === null) return fallback;
	return { x, y, z };
}

function deriveLocalFrame(
	start: NodeV2,
	end: NodeV2,
	coordinateSystem: CoordinateSystemV2 | undefined,
	modelSpace: ModelSpace
): { x: SolverVector3; y: SolverVector3; z: SolverVector3 } | null {
	const startVec = toVec3(start);
	const endVec = toVec3(end);
	const ex = normalizeVec(subVec(endVec, startVec));
	if (!ex) return null;

	const referenceUp =
		modelSpace === 'spatial'
			? getVector(coordinateSystem?.referenceUp, { x: 0, y: 0, z: 1 })
			: getVector(coordinateSystem?.planeNormal, { x: 0, y: 0, z: 1 });
	const secondaryReference = getVector(coordinateSystem?.secondaryReference, { x: 1, y: 0, z: 0 });

	let ez = normalizeVec(projectOntoPlane(referenceUp, ex));
	if (!ez) ez = normalizeVec(projectOntoPlane(secondaryReference, ex));
	if (!ez) {
		const fallbackAxis = Math.abs(ex.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
		ez = normalizeVec(projectOntoPlane(fallbackAxis, ex));
	}
	if (!ez) return null;

	const ey = normalizeVec(crossVec(ez, ex));
	if (!ey) return null;
	const ezOrtho = normalizeVec(crossVec(ex, ey));
	if (!ezOrtho) return null;

	return {
		x: ex,
		y: ey,
		z: ezOrtho
	};
}

function detectSimpleCantilever(schema: SchemaDataV2): {
	memberId: string;
	fixedNodeId: string;
	freeNodeId: string;
} | null {
	const members = schema.objects.filter((object) => object.type === 'bar');
	if (members.length !== 1) return null;
	const member = members[0];
	if (!Array.isArray(member.nodeRefs) || member.nodeRefs.length < 2) return null;
	const [startNodeId, endNodeId] = member.nodeRefs;

	const fixedWalls = schema.objects.filter((object) => object.type === 'fixed_wall');
	if (fixedWalls.length !== 1) return null;
	const fixedNodeId = fixedWalls[0]?.nodeRefs?.[0];
	if (fixedNodeId !== startNodeId && fixedNodeId !== endNodeId) return null;

	const freeNodeId = fixedNodeId === startNodeId ? endNodeId : startNodeId;
	const freeEndSupportCount = schema.objects.filter(
		(object) => SUPPORTS_AT_CANTILEVER_END.has(object.type) && object.nodeRefs?.[0] === freeNodeId
	).length;
	if (freeEndSupportCount > 0) return null;

	return {
		memberId: member.id,
		fixedNodeId,
		freeNodeId
	};
}

function mapLegacyKindToComponent(
	kind: unknown,
	structureKind: StructureKind
): SolverResultComponent | null {
	if (typeof kind !== 'string') return null;
	const normalized = kind.trim().toUpperCase();
	if (normalized === 'N') return 'N';
	if (normalized === 'Q') return structureKind === 'planar_frame' ? 'Vy' : null;
	if (normalized === 'M') return structureKind === 'planar_frame' ? 'Mz' : null;
	return null;
}

function normalizeComponent(value: unknown): SolverResultComponent | null {
	if (typeof value !== 'string') return null;
	const compact = value.trim();
	if ((COMPONENT_ORDER as string[]).includes(compact)) {
		return compact as SolverResultComponent;
	}
	return null;
}

function extractBaseObjectId(result: ResultV2): string | undefined {
	if (!isRecord(result.meta)) return undefined;
	const candidate = result.meta.baseObjectId;
	return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function extractAttach(geometry: Record<string, unknown>): {
	memberId?: string;
	s?: number;
	side?: string;
} | null {
	const attach = isRecord(geometry.attach) ? geometry.attach : null;
	if (!attach) return null;
	const memberId = typeof attach.memberId === 'string' && attach.memberId.trim() ? attach.memberId.trim() : undefined;
	const s = toFiniteNumber(attach.s);
	const side = typeof attach.side === 'string' && attach.side.trim() ? attach.side.trim() : undefined;
	return {
		...(memberId ? { memberId } : {}),
		...(s !== null ? { s: Math.max(0, Math.min(1, s)) } : {}),
		...(side ? { side } : {})
	};
}

function directionFromGeometry(geometry: Record<string, unknown>, kind: SolverLoad['kind']): SolverLoad['direction'] | undefined {
	if (kind === 'moment') {
		if (geometry.direction === 'cw' || geometry.direction === 'ccw') {
			return { rotation: geometry.direction };
		}
		return undefined;
	}

	const angle = toFiniteNumber(geometry.directionAngle);
	if (angle !== null) return { angleDeg: angle };
	if (isRecord(geometry.direction)) {
		const x = toFiniteNumber(geometry.direction.x);
		const y = toFiniteNumber(geometry.direction.y);
		if (x !== null && y !== null) return { vector: { x, y } };
	}
	return undefined;
}

function componentRank(component: SolverResultComponent): number {
	const index = COMPONENT_ORDER.indexOf(component);
	return index >= 0 ? index : COMPONENT_ORDER.length;
}

export function buildSolverModelFromSchema(input: SchemaAny | unknown): BuildSolverModelResult {
	const validation = validateSchemaAny(input);
	if (!validation.ok || !validation.value) {
		throw new SolverModelBuildError('Input schema is invalid', validation.errors, validation.warnings ?? []);
	}

	const schema = validation.value as SchemaDataV2;
	const warnings = [...(validation.warnings ?? [])];
	const structureKind = normalizeStructureKind(schema.meta?.structureKind);
	const modelSpace = normalizeModelSpace(schema.coordinateSystem?.modelSpace, structureKind);
	const nodeById = new Map(schema.nodes.map((node) => [node.id, node]));
	const cantilever = structureKind === 'beam' ? detectSimpleCantilever(schema) : null;

	const members: SolverMember[] = [];
	for (const object of schema.objects) {
		if (!MEMBER_TYPES.has(object.type)) continue;
		const startId = object.nodeRefs?.[0];
		const endId = object.nodeRefs?.[1];
		if (typeof startId !== 'string' || typeof endId !== 'string') {
			warnings.push(`member "${object.id}" skipped in solverModel: nodeRefs are incomplete`);
			continue;
		}

		const startNode = nodeById.get(startId);
		const endNode = nodeById.get(endId);
		if (!startNode || !endNode) {
			warnings.push(`member "${object.id}" skipped in solverModel: nodes are missing`);
			continue;
		}

		let memberStartId = startId;
		let memberEndId = endId;
		let memberStartNode = startNode;
		let memberEndNode = endNode;
		let axisOrigin: 'member_start' | 'free_end' = 'member_start';

		if (cantilever && object.id === cantilever.memberId) {
			axisOrigin = 'free_end';
			if (startId === cantilever.fixedNodeId) {
				memberStartId = endId;
				memberEndId = startId;
				memberStartNode = endNode;
				memberEndNode = startNode;
			}
		}

		const localFrame = deriveLocalFrame(
			memberStartNode,
			memberEndNode,
			schema.coordinateSystem,
			modelSpace
		);
		if (!localFrame) {
			warnings.push(`member "${object.id}" has degenerate geometry for local frame`);
			continue;
		}

		const explicitLength = isRecord(object.geometry) ? toFiniteNumber(object.geometry.length) : null;
		const length =
			explicitLength !== null && explicitLength > 1e-9
				? explicitLength
				: vecLength(subVec(toVec3(memberEndNode), toVec3(memberStartNode)));

		members.push({
			id: object.id,
			kind: object.type,
			startNodeId: memberStartId,
			endNodeId: memberEndId,
			length: Number.isFinite(length) && length > 1e-9 ? length : null,
			localFrame,
			axisOrigin
		});
	}

	const supports: SolverSupport[] = [];
	for (const object of schema.objects) {
		if (!SUPPORT_TYPES.has(object.type)) continue;
		const geometry = isRecord(object.geometry) ? object.geometry : {};
		const attach = extractAttach(geometry);
		const nodeId =
			Array.isArray(object.nodeRefs) && typeof object.nodeRefs[0] === 'string'
				? object.nodeRefs[0]
				: undefined;
		supports.push({
			id: object.id,
			type: object.type,
			...(nodeId ? { nodeId } : {}),
			...(attach?.memberId ? { memberId: attach.memberId } : {}),
			...(typeof attach?.s === 'number' ? { s: attach.s } : {}),
			...(attach?.side ? { side: attach.side } : {})
		});
	}

	const loads: SolverLoad[] = [];
	for (const object of schema.objects) {
		if (object.type !== 'force' && object.type !== 'moment' && object.type !== 'distributed') continue;
		const geometry = isRecord(object.geometry) ? object.geometry : {};
		const attach = extractAttach(geometry);
		const kind = object.type;
		const nodeId =
			Array.isArray(object.nodeRefs) && typeof object.nodeRefs[0] === 'string'
				? object.nodeRefs[0]
				: undefined;
		const nodeIds =
			kind === 'distributed' && Array.isArray(object.nodeRefs)
				? object.nodeRefs.filter((ref): ref is string => typeof ref === 'string')
				: undefined;
		const magnitude =
			kind === 'distributed'
				? geometry.intensity ?? geometry.magnitude
				: geometry.magnitude;

		loads.push({
			id: object.id,
			kind,
			...(nodeId ? { nodeId } : {}),
			...(nodeIds && nodeIds.length > 0 ? { nodeIds } : {}),
			...(attach?.memberId ? { memberId: attach.memberId } : {}),
			...(typeof attach?.s === 'number' ? { s: attach.s } : {}),
			...(directionFromGeometry(geometry, kind) ? { direction: directionFromGeometry(geometry, kind) } : {}),
			...(magnitude !== undefined ? { magnitude } : {})
		});
	}

	const requestedResults: SolverRequestedResult[] = [];
	for (const result of schema.results ?? []) {
		if (result.type !== 'epure' || !isRecord(result.geometry)) continue;
		const component =
			normalizeComponent(result.geometry.component) ??
			mapLegacyKindToComponent(result.geometry.kind, structureKind);
		if (!component) {
			warnings.push(`result "${result.id}" epure skipped in solverModel: missing component`);
			continue;
		}
		requestedResults.push({
			component,
			...(extractBaseObjectId(result) ? { memberId: extractBaseObjectId(result) } : {})
		});
	}

	requestedResults.sort((a, b) => {
		const componentDelta = componentRank(a.component) - componentRank(b.component);
		if (componentDelta !== 0) return componentDelta;
		const aMember = a.memberId ?? '';
		const bMember = b.memberId ?? '';
		return aMember.localeCompare(bMember);
	});

	const solverModel: SolverModelV1 = {
		version: 'solver-1.0',
		structureKind,
		modelSpace,
		members,
		supports,
		loads,
		requestedResults,
		signConvention: {
			beam: {
				cantileverAxisOrigin: 'free_end',
				momentCompressedFiberRule: 'epure.compressedFiberSide'
			},
			planarFrame: {
				legacyKindMapping: {
					N: 'N',
					Q: 'Vy',
					M: 'Mz'
				}
			},
			spatialFrame: {
				components: [...COMPONENT_ORDER]
			}
		}
	};

	return { solverModel, warnings };
}
