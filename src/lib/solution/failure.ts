import { normalizeSolutionDocument, type SolutionDocumentV1, type SolutionLocale } from './document.js';
import { presentSolutionDocument } from './presenter.js';

export interface DiagnosticSolutionParams {
	userMessage?: string;
	errorMessage: string;
	stage?: string;
	locale?: SolutionLocale;
}

function choose(locale: SolutionLocale, ru: string, en: string): string {
	return locale === 'ru' ? ru : en;
}

function detectLocale(text: string): SolutionLocale {
	const cyrillicCount = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
	const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
	return cyrillicCount >= latinCount ? 'ru' : 'en';
}

function trimAndLimit(text: string, maxChars = 1_800): string {
	const normalized = text.replace(/\s+/g, ' ').trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}...`;
}

function resolveLocale(params: DiagnosticSolutionParams): SolutionLocale {
	if (params.locale === 'ru' || params.locale === 'en') return params.locale;
	const joined = `${params.userMessage ?? ''}\n${params.errorMessage}`;
	return detectLocale(joined);
}

export function buildDiagnosticDetailedContent(params: DiagnosticSolutionParams): string {
	const locale = resolveLocale(params);
	const stage = trimAndLimit(params.stage ?? choose(locale, 'pipeline', 'pipeline'), 120);
	const errorText = trimAndLimit(params.errorMessage, 1_200);

	if (locale === 'ru') {
		return `Подробное решение прервано из-за системной ошибки на этапе "${stage}". ${errorText}`;
	}
	return `Detailed solution was interrupted by a system error at stage "${stage}". ${errorText}`;
}

export function buildDiagnosticDetailedSolutionDoc(params: DiagnosticSolutionParams): SolutionDocumentV1 {
	const locale = resolveLocale(params);
	const stage = trimAndLimit(params.stage ?? choose(locale, 'pipeline', 'pipeline'), 120);
	const errorText = trimAndLimit(params.errorMessage, 3_000);
	const taskText = trimAndLimit(params.userMessage ?? '', 2_000);

	const rawDoc: SolutionDocumentV1 = {
		version: 'solution-doc-2.0',
		locale,
		summary: choose(
			locale,
			'Подробное решение временно недоступно. Сформирован диагностический отчёт.',
			'Detailed solution is temporarily unavailable. A diagnostic report was generated.'
		),
		meta: {
			failure: true,
			failureStage: stage,
			source: 'diagnostic'
		},
		sections: [
			{
				id: 'status',
				title: choose(locale, 'Статус', 'Status'),
				blocks: [
					{
						id: 'status-note',
						kind: 'note',
						title: choose(locale, 'Состояние выполнения', 'Execution state'),
						text: choose(
							locale,
							'Вычисления остановлены из-за внешней/временной ошибки. Основной результат не рассчитан.',
							'Computation stopped due to an external/transient error. Primary result is not available.'
						)
					}
				]
			},
			{
				id: 'diagnostics',
				title: choose(locale, 'Диагностика', 'Diagnostics'),
				blocks: [
					{
						id: 'diag-stage',
						kind: 'result',
						text: choose(locale, 'Этап', 'Stage'),
						value: stage
					},
					{
						id: 'diag-error',
						kind: 'result',
						text: choose(locale, 'Сообщение об ошибке', 'Error message'),
						value: errorText
					},
					...(taskText
						? [
								{
									id: 'diag-task',
									kind: 'note' as const,
									title: choose(locale, 'Исходный запрос', 'Original request'),
									text: taskText
								}
							]
						: [])
				]
			}
		]
	};

	const normalized = normalizeSolutionDocument(rawDoc);
	const safeDoc =
		normalized ??
		({
			version: 'solution-doc-2.0',
			locale,
			summary: choose(
				locale,
				'Подробное решение недоступно. Диагностика сохранена.',
				'Detailed solution is unavailable. Diagnostics were saved.'
			),
			meta: { failure: true, failureStage: stage, source: 'diagnostic' },
			sections: [
				{
					id: 'diagnostics',
					title: choose(locale, 'Диагностика', 'Diagnostics'),
					blocks: [
						{
							id: 'diag-error',
							kind: 'result',
							text: choose(locale, 'Сообщение об ошибке', 'Error message'),
							value: errorText
						}
					]
				}
			]
		} satisfies SolutionDocumentV1);

	return presentSolutionDocument(safeDoc, { source: 'fallback' });
}
