export type SolutionBlockKind =
	| 'note'
	| 'definition'
	| 'equation'
	| 'solve'
	| 'code'
	| 'result'
	| 'graph'
	| 'table';

export interface SolutionBlockV1 {
	id: string;
	kind: SolutionBlockKind;
	title?: string;
	text?: string;
	expression?: string;
	value?: string;
	code?: string;
	data?: Record<string, unknown>;
}

export interface SolutionSectionV1 {
	id: string;
	title: string;
	blocks: SolutionBlockV1[];
}

export interface SolutionDocumentV1 {
	version: 'solution-doc-1.0';
	locale: 'ru' | 'en';
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
		case 'code':
		case 'result':
		case 'graph':
		case 'table':
			return value;
		default:
			return null;
	}
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

	if (title) block.title = title;
	if (text) block.text = text;
	if (expression) block.expression = expression;
	if (code) block.code = code;
	if (val) block.value = val;
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
	if (value.version !== 'solution-doc-1.0') return null;

	const localeRaw = normalizeString(value.locale);
	const locale: 'ru' | 'en' = localeRaw === 'en' ? 'en' : 'ru';
	const rawSections = Array.isArray(value.sections) ? value.sections : [];
	const sections = rawSections
		.map((entry, index) => normalizeSection(entry, `section_${index + 1}`))
		.filter((entry): entry is SolutionSectionV1 => Boolean(entry));
	if (sections.length === 0) return null;

	const normalized: SolutionDocumentV1 = {
		version: 'solution-doc-1.0',
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

