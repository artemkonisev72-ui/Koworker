import type { SolutionBlockKind, SolutionBlockV1, SolutionDocumentV1 } from './document.js';
import { mathAstToText } from './document.js';

export interface PresentSolutionDocumentOptions {
	source?: 'trace' | 'fallback' | 'legacy';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.replace(/\s+/g, ' ').trim();
	return trimmed.length > 0 ? trimmed : null;
}

function rawText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}...`;
}

function choose(locale: 'ru' | 'en', ru: string, en: string): string {
	return locale === 'ru' ? ru : en;
}

function defaultTitle(kind: SolutionBlockKind, locale: 'ru' | 'en'): string {
	switch (kind) {
		case 'note':
			return choose(locale, 'Step note', 'Note');
		case 'definition':
			return choose(locale, 'Definition', 'Definition');
		case 'equation':
			return choose(locale, 'Equation', 'Equation');
		case 'solve':
			return choose(locale, 'Solve step', 'Solve');
		case 'evaluation':
		case 'math':
			return choose(locale, 'Math step', 'Math step');
		case 'result':
			return choose(locale, 'Answer', 'Answer');
		case 'graph':
		case 'plot':
			return choose(locale, 'Graph', 'Graph');
		case 'table':
			return choose(locale, 'Table', 'Table');
		case 'code':
			return choose(locale, 'Technical details', 'Technical details');
		default:
			return choose(locale, 'Step', 'Step');
	}
}

function defaultText(kind: SolutionBlockKind, locale: 'ru' | 'en'): string {
	switch (kind) {
		case 'definition':
			return choose(locale, 'Define notation and base relations.', 'Define notation and base relations.');
		case 'equation':
			return choose(locale, 'Apply the governing relation.', 'Apply the governing relation.');
		case 'solve':
			return choose(locale, 'Solve for the target quantity.', 'Solve for the target quantity.');
		case 'result':
			return choose(locale, 'Final computed value.', 'Final computed value.');
		case 'graph':
		case 'plot':
			return choose(locale, 'Computed data for visualization.', 'Computed data for visualization.');
		case 'table':
			return choose(locale, 'Tabular data for this step.', 'Tabular data for this step.');
		default:
			return choose(locale, 'Intermediate computation step.', 'Intermediate computation step.');
	}
}

function mergeDebugData(block: SolutionBlockV1): Record<string, unknown> | undefined {
	const data: Record<string, unknown> = isRecord(block.data) ? { ...block.data } : {};
	const code = rawText(block.code);
	if (code) data.debugCode = truncate(code, 12_000);
	return Object.keys(data).length > 0 ? data : undefined;
}

function presentBlock(block: SolutionBlockV1, locale: 'ru' | 'en'): SolutionBlockV1 | null {
	const title = rawText(block.title);
	const text = rawText(block.text);
	const expression = rawText(block.expression);
	const value = rawText(block.value);
	const mathExpression = mathAstToText(block.mathAst);
	const data = mergeDebugData(block);

	if (block.kind === 'code') {
		return {
			id: block.id,
			kind: 'note',
			title: title ?? defaultTitle('code', locale),
			text: choose(
				locale,
				'Low-level Python code is hidden in the main detailed view.',
				'Low-level Python code is hidden in the main detailed view.'
			),
			...(data ? { data } : {})
		};
	}

	const normalized: SolutionBlockV1 = {
		id: block.id,
		kind: block.kind
	};

	normalized.title = title ?? defaultTitle(block.kind, locale);
	if (expression) normalized.expression = expression;
	if (text) normalized.text = text;
	if (value) normalized.value = value;
	if (data) normalized.data = data;
	if (block.mathAst) normalized.mathAst = block.mathAst;

	if (!normalized.expression && mathExpression) {
		normalized.expression = mathExpression;
	}

	if (!normalized.text) {
		normalized.text = defaultText(block.kind, locale);
	}

	if (!normalized.expression && !normalized.value && (block.kind === 'equation' || block.kind === 'definition' || block.kind === 'solve' || block.kind === 'evaluation' || block.kind === 'math')) {
		const fallbackExpression = compactText(block.text);
		if (fallbackExpression) normalized.expression = fallbackExpression;
	}

	if (block.kind === 'result' && !normalized.value && normalized.expression) {
		normalized.value = normalized.expression;
		delete normalized.expression;
	}

	return normalized;
}

function sectionTitle(title: string, locale: 'ru' | 'en', index: number): string {
	const normalized = rawText(title);
	if (normalized) return normalized;
	return choose(locale, `Section ${index + 1}`, `Section ${index + 1}`);
}

export function presentSolutionDocument(
	solutionDoc: SolutionDocumentV1,
	options?: PresentSolutionDocumentOptions
): SolutionDocumentV1 {
	const locale = solutionDoc.locale === 'en' ? 'en' : 'ru';
	let hasDebugPayload = false;

	const sections = solutionDoc.sections.map((section, sectionIndex) => {
		const blocks = section.blocks
			.map((block) => presentBlock(block, locale))
			.filter((block): block is SolutionBlockV1 => Boolean(block));
		if (blocks.some((block) => isRecord(block.data) && Object.keys(block.data).length > 0)) {
			hasDebugPayload = true;
		}
		return {
			id: section.id,
			title: sectionTitle(section.title, locale, sectionIndex),
			blocks
		};
	});

	const nonEmptySections = sections.filter((section) => section.blocks.length > 0);
	const fallbackSections =
		nonEmptySections.length > 0
			? nonEmptySections
			: [
					{
						id: 'solution',
						title: choose(locale, 'Solution', 'Solution'),
						blocks: [
							{
								id: 'solution-note',
								kind: 'note' as const,
								title: choose(locale, 'Note', 'Note'),
								text: choose(
									locale,
									'Detailed steps were not provided by the solver.',
									'Detailed steps were not provided by the solver.'
								)
							}
						]
					}
				];

	const meta: Record<string, unknown> = isRecord(solutionDoc.meta) ? { ...solutionDoc.meta } : {};
	meta.presentation = 'human-readable-v1';
	if (options?.source) meta.source = options.source;
	if (hasDebugPayload) meta.hasDebugPayload = true;

	const summary =
		rawText(solutionDoc.summary) ??
		choose(
			locale,
			'Detailed solution is prepared in human-readable format.',
			'Detailed solution is prepared in human-readable format.'
		);

	return {
		version: solutionDoc.version,
		locale,
		summary,
		sections: fallbackSections,
		meta
	};
}
