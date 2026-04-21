import { describe, expect, it } from 'vitest';
import type { SolutionDocumentV1 } from '$lib/solution/document.js';
import { buildXmcdFromSolutionDocument } from './export.js';

const sampleSolutionDoc: SolutionDocumentV1 = {
	version: 'solution-doc-1.0',
	locale: 'ru',
	summary: 'Summary line.',
	sections: [
		{
			id: 'section_1',
			title: 'Solution',
			blocks: [
				{
					id: 'block_1',
					kind: 'note',
					text: 'First step of the solution.'
				},
				{
					id: 'block_2',
					kind: 'result',
					text: 'Answer',
					value: '42'
				}
			]
		}
	]
};

describe('buildXmcdFromSolutionDocument', () => {
	it('renders a worksheet root with the required version and namespaces', () => {
		const xmcd = buildXmcdFromSolutionDocument(sampleSolutionDoc, {
			author: 'Test Author',
			title: 'Test Title'
		});

		expect(xmcd).toContain('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
		expect(xmcd).toContain('<worksheet version="3.0.3"');
		expect(xmcd).toContain('xmlns="http://schemas.mathsoft.com/worksheet30"');
		expect(xmcd).toContain('xmlns:ml="http://schemas.mathsoft.com/math30"');
		expect(xmcd).toContain('<pointReleaseData/>');
	});

	it('writes Mathcad-like settings and page geometry', () => {
		const xmcd = buildXmcdFromSolutionDocument(sampleSolutionDoc, {
			author: 'Test Author',
			title: 'Test Title'
		});

		expect(xmcd).toContain('<metadata>');
		expect(xmcd).toContain('<userData>');
		expect(xmcd).toContain('<identityInfo>');
		expect(xmcd).toContain('<revision>3</revision>');
		expect(xmcd).toContain('<branchID>00000000-0000-0000-0000-000000000000</branchID>');
		expect(xmcd).toContain('<settings>');
		expect(xmcd).toContain('<presentation>');
		expect(xmcd).toContain('<calculation>');
		expect(xmcd).toContain('paper-code="1"');
		expect(xmcd).toContain('page-width="612"');
		expect(xmcd).toContain('page-height="792"');
		expect(xmcd).toContain('<margins left="72" right="72" top="72" bottom="72"/>');
		expect(xmcd).toContain('<language math="ru" UI="ru"/>');
	});

	it('renders text regions inside page bounds with non-zero alignment', () => {
		const xmcd = buildXmcdFromSolutionDocument(sampleSolutionDoc, {
			author: 'Test Author',
			title: 'Test Title'
		});

		expect(xmcd).toContain('<regions>');
		expect(xmcd).toContain('<region region-id="1" left="72" top="72" width="468"');
		expect(xmcd).toContain('align-x="72"');
		expect(xmcd).toContain('align-y="81.75"');
		expect(xmcd).toContain('background-color="inherit"');
		expect(xmcd).toContain('is-protected="true"');
		expect(xmcd).toContain('<text use-page-width="false" push-down="false" lock-width="true">');
		expect(xmcd).toContain('<p style="Normal"');
		expect(xmcd).toContain('Answer: 42');
	});
});
