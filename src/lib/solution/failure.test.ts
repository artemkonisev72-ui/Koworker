import { describe, expect, it } from 'vitest';
import { normalizeSolutionDocument } from './document.js';
import { buildDiagnosticDetailedContent, buildDiagnosticDetailedSolutionDoc } from './failure.js';

describe('buildDiagnosticDetailedSolutionDoc', () => {
	it('builds valid solution-doc-2.0 with failure metadata and human-readable sections', () => {
		const doc = buildDiagnosticDetailedSolutionDoc({
			userMessage: 'Реши задачу',
			errorMessage: 'fetch failed: ECONNRESET',
			stage: 'pipeline'
		});

		const normalized = normalizeSolutionDocument(doc);
		expect(normalized).not.toBeNull();
		expect(doc.version).toBe('solution-doc-2.0');
		expect(doc.sections.length).toBeGreaterThanOrEqual(1);
		expect(doc.summary).toBeTruthy();
		expect((doc.meta as Record<string, unknown>).failure).toBe(true);
	});

	it('generates locale-aware diagnostics text', () => {
		const ruText = buildDiagnosticDetailedContent({
			userMessage: 'Найди реакции опор',
			errorMessage: 'ECONNRESET',
			stage: 'pipeline'
		});
		const enText = buildDiagnosticDetailedContent({
			userMessage: 'Find support reactions',
			errorMessage: 'ECONNRESET',
			stage: 'pipeline'
		});

		expect(ruText.toLowerCase()).toContain('ошиб');
		expect(enText.toLowerCase()).toContain('error');
	});
});
