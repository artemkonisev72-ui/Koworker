export type SolutionDocVersion = 'solution-doc-1.0' | 'solution-doc-2.0';
export type SolutionLocale = 'ru' | 'en';

export type SolutionBlockKind =
	| 'note'
	| 'definition'
	| 'equation'
	| 'solve'
	| 'evaluation'
	| 'math'
	| 'code'
	| 'result'
	| 'graph'
	| 'plot'
	| 'table';

export type MathNodeV1 =
	| {
			type: 'id';
			name: string;
			subscript?: string;
	  }
	| {
			type: 'num';
			value: string;
	  }
	| {
			type: 'text';
			value: string;
	  }
	| {
			type: 'apply';
			op: string;
			args: MathNodeV1[];
	  }
	| {
			type: 'define';
			lhs: MathNodeV1;
			rhs: MathNodeV1;
	  }
	| {
			type: 'function_def';
			name: MathNodeV1;
			params: MathNodeV1[];
			body: MathNodeV1;
	  }
	| {
			type: 'call';
			fn: MathNodeV1;
			args: MathNodeV1[];
	  }
	| {
			type: 'integral';
			variable: MathNodeV1;
			lower: MathNodeV1;
			upper: MathNodeV1;
			body: MathNodeV1;
	  }
	| {
			type: 'matrix';
			rows: number;
			cols: number;
			values: MathNodeV1[];
	  }
	| {
			type: 'program';
			branches: Array<{ condition: MathNodeV1; value: MathNodeV1 }>;
			otherwise?: MathNodeV1;
	  }
	| {
			type: 'eval';
			expr: MathNodeV1;
	  }
	| {
			type: 'lambda';
			params: MathNodeV1[];
			body: MathNodeV1;
	  };

export interface SolutionBlockV1 {
	id: string;
	kind: SolutionBlockKind;
	title?: string;
	text?: string;
	expression?: string;
	value?: string;
	code?: string;
	data?: Record<string, unknown>;
	mathAst?: MathNodeV1;
}

export interface SolutionSectionV1 {
	id: string;
	title: string;
	blocks: SolutionBlockV1[];
}

export interface SolutionDocumentV1 {
	version: SolutionDocVersion;
	locale: SolutionLocale;
	summary?: string;
	sections: SolutionSectionV1[];
	meta?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeKind(value: unknown): SolutionBlockKind | null {
	if (typeof value !== 'string') return null;
	switch (value) {
		case 'note':
		case 'definition':
		case 'equation':
		case 'solve':
		case 'evaluation':
		case 'math':
		case 'code':
		case 'result':
		case 'graph':
		case 'plot':
		case 'table':
			return value;
		default:
			return null;
	}
}

function normalizeVersion(value: unknown): SolutionDocVersion | null {
	if (value === 'solution-doc-1.0' || value === 'solution-doc-2.0') return value;
	return null;
}

function normalizeLocale(value: unknown): SolutionLocale {
	return value === 'en' ? 'en' : 'ru';
}

function normalizeMathNode(value: unknown, depth = 0): MathNodeV1 | null {
	if (!isRecord(value) || depth > 32) return null;
	const type = normalizeString(value.type);
	if (!type) return null;

	if (type === 'id') {
		const name = normalizeString(value.name);
		if (!name) return null;
		const node: MathNodeV1 = { type: 'id', name };
		const subscript = normalizeString(value.subscript);
		if (subscript) node.subscript = subscript;
		return node;
	}

	if (type === 'num') {
		const num = normalizeString(value.value);
		if (!num) return null;
		return { type: 'num', value: num };
	}

	if (type === 'text') {
		const text = normalizeString(value.value);
		if (!text) return null;
		return { type: 'text', value: text };
	}

	if (type === 'apply') {
		const op = normalizeString(value.op);
		const rawArgs = Array.isArray(value.args) ? value.args : [];
		if (!op) return null;
		const args = rawArgs
			.map((entry) => normalizeMathNode(entry, depth + 1))
			.filter((entry): entry is MathNodeV1 => Boolean(entry));
		if (args.length === 0) return null;
		return { type: 'apply', op, args };
	}

	if (type === 'define') {
		const lhs = normalizeMathNode(value.lhs, depth + 1);
		const rhs = normalizeMathNode(value.rhs, depth + 1);
		if (!lhs || !rhs) return null;
		return { type: 'define', lhs, rhs };
	}

	if (type === 'function_def') {
		const name = normalizeMathNode(value.name, depth + 1);
		const body = normalizeMathNode(value.body, depth + 1);
		const rawParams = Array.isArray(value.params) ? value.params : [];
		const params = rawParams
			.map((entry) => normalizeMathNode(entry, depth + 1))
			.filter((entry): entry is MathNodeV1 => Boolean(entry));
		if (!name || !body) return null;
		return { type: 'function_def', name, params, body };
	}

	if (type === 'call') {
		const fn = normalizeMathNode(value.fn, depth + 1);
		const rawArgs = Array.isArray(value.args) ? value.args : [];
		const args = rawArgs
			.map((entry) => normalizeMathNode(entry, depth + 1))
			.filter((entry): entry is MathNodeV1 => Boolean(entry));
		if (!fn || args.length === 0) return null;
		return { type: 'call', fn, args };
	}

	if (type === 'integral') {
		const variable = normalizeMathNode(value.variable, depth + 1);
		const lower = normalizeMathNode(value.lower, depth + 1);
		const upper = normalizeMathNode(value.upper, depth + 1);
		const body = normalizeMathNode(value.body, depth + 1);
		if (!variable || !lower || !upper || !body) return null;
		return { type: 'integral', variable, lower, upper, body };
	}

	if (type === 'matrix') {
		const rows = typeof value.rows === 'number' && Number.isFinite(value.rows) ? Math.floor(value.rows) : 0;
		const cols = typeof value.cols === 'number' && Number.isFinite(value.cols) ? Math.floor(value.cols) : 0;
		const rawValues = Array.isArray(value.values) ? value.values : [];
		const values = rawValues
			.map((entry) => normalizeMathNode(entry, depth + 1))
			.filter((entry): entry is MathNodeV1 => Boolean(entry));
		if (rows <= 0 || cols <= 0 || values.length !== rows * cols) return null;
		return { type: 'matrix', rows, cols, values };
	}

	if (type === 'program') {
		const rawBranches = Array.isArray(value.branches) ? value.branches : [];
		const branches = rawBranches
			.map((entry) => {
				if (!isRecord(entry)) return null;
				const condition = normalizeMathNode(entry.condition, depth + 1);
				const branchValue = normalizeMathNode(entry.value, depth + 1);
				if (!condition || !branchValue) return null;
				return { condition, value: branchValue };
			})
			.filter((entry): entry is { condition: MathNodeV1; value: MathNodeV1 } => Boolean(entry));
		if (branches.length === 0) return null;
		const otherwiseNode = normalizeMathNode(value.otherwise, depth + 1) ?? undefined;
		return { type: 'program', branches, ...(otherwiseNode ? { otherwise: otherwiseNode } : {}) };
	}

	if (type === 'eval') {
		const expr = normalizeMathNode(value.expr, depth + 1);
		if (!expr) return null;
		return { type: 'eval', expr };
	}

	if (type === 'lambda') {
		const rawParams = Array.isArray(value.params) ? value.params : [];
		const params = rawParams
			.map((entry) => normalizeMathNode(entry, depth + 1))
			.filter((entry): entry is MathNodeV1 => Boolean(entry));
		const body = normalizeMathNode(value.body, depth + 1);
		if (!body) return null;
		return { type: 'lambda', params, body };
	}

	return null;
}

function normalizeBlock(value: unknown, fallbackId: string): SolutionBlockV1 | null {
	if (!isRecord(value)) return null;

	const kind = normalizeKind(value.kind) ?? 'note';
	const id = normalizeString(value.id) ?? fallbackId;
	const block: SolutionBlockV1 = { id, kind };

	const title = normalizeString(value.title);
	const text = normalizeString(value.text);
	const expression = normalizeString(value.expression);
	const code = normalizeString(value.code);
	const val = normalizeString(value.value);
	const mathAst = normalizeMathNode(value.mathAst ?? value.math);

	if (title) block.title = title;
	if (text) block.text = text;
	if (expression) block.expression = expression;
	if (code) block.code = code;
	if (val) block.value = val;
	if (mathAst) block.mathAst = mathAst;
	if (isRecord(value.data)) block.data = value.data;

	return block;
}

function normalizeSection(value: unknown, fallbackId: string): SolutionSectionV1 | null {
	if (!isRecord(value)) return null;
	const title = normalizeString(value.title) ?? 'Section';
	const id = normalizeString(value.id) ?? fallbackId;
	const rawBlocks = Array.isArray(value.blocks) ? value.blocks : [];

	const blocks = rawBlocks
		.map((entry, index) => normalizeBlock(entry, `block_${index + 1}`))
		.filter((entry): entry is SolutionBlockV1 => Boolean(entry));

	return { id, title, blocks };
}

export function normalizeSolutionDocument(value: unknown): SolutionDocumentV1 | null {
	if (!isRecord(value)) return null;

	const version = normalizeVersion(value.version);
	if (!version) return null;

	const locale = normalizeLocale(value.locale);
	const rawSections = Array.isArray(value.sections) ? value.sections : [];
	const sections = rawSections
		.map((entry, index) => normalizeSection(entry, `section_${index + 1}`))
		.filter((entry): entry is SolutionSectionV1 => Boolean(entry));
	if (sections.length === 0) return null;

	const normalized: SolutionDocumentV1 = {
		version,
		locale,
		sections
	};

	const summary = normalizeString(value.summary);
	if (summary) normalized.summary = summary;
	if (isRecord(value.meta)) normalized.meta = value.meta;

	return normalized;
}

export function isSolutionDocumentV1(value: unknown): value is SolutionDocumentV1 {
	return normalizeSolutionDocument(value) !== null;
}

export function mathAstToText(node: MathNodeV1 | undefined): string | null {
	if (!node) return null;
	switch (node.type) {
		case 'id':
			return node.subscript ? `${node.name}_${node.subscript}` : node.name;
		case 'num':
			return node.value;
		case 'text':
			return node.value;
		case 'apply': {
			const args = node.args.map((arg) => mathAstToText(arg) ?? '?');
			switch (node.op) {
				case 'plus':
					return args.join(' + ');
				case 'minus':
					return args.length === 1 ? `-(${args[0]})` : `${args[0]} - ${args.slice(1).join(' - ')}`;
				case 'mult':
					return args.join(' * ');
				case 'div':
					return args.length >= 2 ? `${args[0]} / ${args[1]}` : args.join(' / ');
				case 'pow':
					return args.length >= 2 ? `${args[0]}^${args[1]}` : args.join('^');
				case 'equal':
					return args.length >= 2 ? `${args[0]} = ${args[1]}` : args.join(' = ');
				default:
					return `${node.op}(${args.join(', ')})`;
			}
		}
		case 'define':
			return `${mathAstToText(node.lhs) ?? '?'} := ${mathAstToText(node.rhs) ?? '?'}`;
		case 'function_def': {
			const fn = mathAstToText(node.name) ?? 'f';
			const params = node.params.map((param) => mathAstToText(param) ?? '?').join(', ');
			const body = mathAstToText(node.body) ?? '?';
			return `${fn}(${params}) := ${body}`;
		}
		case 'call': {
			const fn = mathAstToText(node.fn) ?? 'f';
			const args = node.args.map((arg) => mathAstToText(arg) ?? '?').join(', ');
			return `${fn}(${args})`;
		}
		case 'integral': {
			const body = mathAstToText(node.body) ?? '?';
			const variable = mathAstToText(node.variable) ?? '?';
			const lower = mathAstToText(node.lower) ?? '?';
			const upper = mathAstToText(node.upper) ?? '?';
			return `integral(${body}, ${variable}, ${lower}, ${upper})`;
		}
		case 'matrix':
			return `[${node.rows}x${node.cols} matrix]`;
		case 'program':
			return '[program]';
		case 'eval':
			return mathAstToText(node.expr);
		case 'lambda': {
			const params = node.params.map((param) => mathAstToText(param) ?? '?').join(', ');
			const body = mathAstToText(node.body) ?? '?';
			return `lambda(${params}) -> ${body}`;
		}
		default:
			return null;
	}
}
