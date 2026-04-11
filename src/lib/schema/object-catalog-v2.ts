import type { SchemaObjectTypeV2 } from './schema-v2.js';

export interface ObjectCatalogRuleV2 {
	requiredNodeRefs?: number | { min: number; max?: number };
	allowNodeRefs?: boolean;
	requiredGeometryKeys?: string[];
	description: string;
}

export const TYPE_ALIASES_V1_TO_V2: Record<string, SchemaObjectTypeV2> = {
	beam_segment: 'bar',
	point_load: 'force',
	distributed_load: 'distributed',
	support_fixed: 'fixed_wall',
	support_pin: 'hinge_fixed',
	support_roller: 'hinge_roller',
	hinge: 'internal_hinge',
	joint: 'internal_hinge'
};

export const SCHEMA_OBJECT_CATALOG_V2: Record<SchemaObjectTypeV2, ObjectCatalogRuleV2> = {
	bar: {
		requiredNodeRefs: 2,
		description: 'Straight rigid member between two nodes.'
	},
	cable: {
		requiredNodeRefs: 2,
		description: 'Flexible cable between two nodes.'
	},
	spring: {
		requiredNodeRefs: 2,
		description: 'Spring element between two nodes.'
	},
	damper: {
		requiredNodeRefs: 2,
		description: 'Damper element between two nodes.'
	},
	rigid_disk: {
		requiredNodeRefs: 1,
		requiredGeometryKeys: ['radius'],
		description: 'Rigid disk/wheel around center node.'
	},
	fixed_wall: {
		requiredNodeRefs: 1,
		description: 'Fixed support with wall hatch.'
	},
	hinge_fixed: {
		requiredNodeRefs: 1,
		description: 'Pinned fixed support.'
	},
	hinge_roller: {
		requiredNodeRefs: 1,
		description: 'Roller support on surface.'
	},
	internal_hinge: {
		requiredNodeRefs: 1,
		description: 'Internal hinge at node.'
	},
	slider: {
		requiredNodeRefs: { min: 3, max: 3 },
		description: 'Slider on a guide line.'
	},
	force: {
		requiredNodeRefs: 1,
		description: 'Concentrated force.'
	},
	moment: {
		requiredNodeRefs: 1,
		requiredGeometryKeys: ['direction'],
		description: 'Concentrated moment.'
	},
	distributed: {
		requiredNodeRefs: 2,
		requiredGeometryKeys: ['kind'],
		description: 'Distributed load.'
	},
	velocity: {
		requiredNodeRefs: 1,
		description: 'Velocity vector.'
	},
	acceleration: {
		requiredNodeRefs: 1,
		description: 'Acceleration vector.'
	},
	angular_velocity: {
		requiredNodeRefs: { min: 0, max: 1 },
		requiredGeometryKeys: ['direction'],
		description: 'Angular velocity.'
	},
	angular_acceleration: {
		requiredNodeRefs: { min: 0, max: 1 },
		requiredGeometryKeys: ['direction'],
		description: 'Angular acceleration.'
	},
	trajectory: {
		requiredNodeRefs: { min: 0, max: 1 },
		requiredGeometryKeys: ['points'],
		description: 'Path represented by points.'
	},
	epure: {
		requiredNodeRefs: { min: 0, max: 2 },
		requiredGeometryKeys: ['baseLine', 'values'],
		description: 'Resulting effort diagram.'
	},
	label: {
		requiredNodeRefs: { min: 0, max: 1 },
		description: 'Text label.'
	},
	dimension: {
		requiredNodeRefs: { min: 0, max: 2 },
		description: 'Dimension marker.'
	},
	axis: {
		requiredNodeRefs: { min: 0, max: 2 },
		description: 'Reference axis.'
	},
	ground: {
		requiredNodeRefs: { min: 0, max: 2 },
		description: 'Ground/surface helper.'
	}
};

export const SCHEMA_OBJECT_TYPES_V2_SET = new Set<SchemaObjectTypeV2>(
	Object.keys(SCHEMA_OBJECT_CATALOG_V2) as SchemaObjectTypeV2[]
);
