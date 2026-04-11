import type { SchemaPoint } from './schema-data.js';

export const SCHEMA_DATA_V2_VERSION = '2.0';

export const SCHEMA_OBJECT_TYPES_V2 = [
	'bar',
	'cable',
	'spring',
	'damper',
	'rigid_disk',
	'fixed_wall',
	'hinge_fixed',
	'hinge_roller',
	'internal_hinge',
	'slider',
	'force',
	'moment',
	'distributed',
	'velocity',
	'acceleration',
	'angular_velocity',
	'angular_acceleration',
	'trajectory',
	'epure',
	'label',
	'dimension',
	'axis',
	'ground'
] as const;

export type SchemaObjectTypeV2 = (typeof SCHEMA_OBJECT_TYPES_V2)[number];

export interface SchemaMetaV2 {
	taskDomain?: string;
	catalogVersion?: string;
	language?: string;
}

export interface CoordinateSystemV2 {
	xUnit?: string;
	yUnit?: string;
	origin?: SchemaPoint;
	axisOrientation?: 'right-handed' | 'left-handed';
}

export interface NodeV2 {
	id: string;
	x: number;
	y: number;
	label?: string;
	visible?: boolean;
	meta?: Record<string, unknown>;
}

export interface ObjectV2 {
	id: string;
	type: SchemaObjectTypeV2;
	nodeRefs?: string[];
	geometry: Record<string, unknown>;
	style?: Record<string, unknown>;
	label?: string;
	meta?: Record<string, unknown>;
}

export interface ResultV2 extends Omit<ObjectV2, 'type'> {
	type: 'epure' | 'trajectory' | 'label' | 'dimension' | 'axis';
}

export interface SchemaDataV2 {
	version: string;
	meta?: SchemaMetaV2;
	coordinateSystem?: CoordinateSystemV2;
	nodes: NodeV2[];
	objects: ObjectV2[];
	results?: ResultV2[];
	annotations?: Array<string | Record<string, unknown>>;
	assumptions?: string[];
	ambiguities?: string[];
}

export interface SchemaValidationResultV2 {
	ok: boolean;
	errors: string[];
	value?: SchemaDataV2;
	warnings?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSchemaDataV2(value: unknown): value is SchemaDataV2 {
	if (!isRecord(value)) return false;
	if (!Array.isArray(value.nodes) || !Array.isArray(value.objects)) return false;
	return true;
}

export function isSchemaDataV2Loose(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	return Array.isArray(value.nodes) || Array.isArray(value.objects) || value.version === SCHEMA_DATA_V2_VERSION;
}
