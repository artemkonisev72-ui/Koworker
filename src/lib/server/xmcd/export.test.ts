import { describe, expect, it } from 'vitest';
import type { SolutionDocumentV1 } from '$lib/solution/document.js';
import { buildXmcdFromSolutionDocument } from './export.js';

const sampleSolutionDoc: SolutionDocumentV1 = {
	version: 'solution-doc-2.0',
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
		expect(xmcd).toContain('Answer');
		expect(xmcd).toContain('<ml:real>42</ml:real>');
	});

	it('renders math AST constructs used in piecewise structural tasks', () => {
		const doc: SolutionDocumentV1 = {
			version: 'solution-doc-2.0',
			locale: 'ru',
			sections: [
				{
					id: 'section_1',
					title: 'Solution',
					blocks: [
						{
							id: 'block_1',
							kind: 'definition',
							mathAst: {
								type: 'function_def',
								name: { type: 'id', name: 'Q' },
								params: [{ type: 'id', name: 'z' }],
								body: {
									type: 'program',
									branches: [
										{
											condition: {
												type: 'apply',
												op: 'and',
												args: [
													{
														type: 'apply',
														op: 'lessOrEqual',
														args: [{ type: 'num', value: '0' }, { type: 'id', name: 'z' }]
													},
													{
														type: 'apply',
														op: 'lessThan',
														args: [{ type: 'id', name: 'z' }, { type: 'id', name: 'l' }]
													}
												]
											},
											value: { type: 'id', name: 'q', subscript: '1' }
										}
									],
									otherwise: { type: 'num', value: '0' }
								}
							}
						}
					]
				}
			]
		};

		const xmcd = buildXmcdFromSolutionDocument(doc);
		expect(xmcd).toContain('<ml:program>');
		expect(xmcd).toContain('<ml:ifThen>');
		expect(xmcd).toContain('<ml:otherwise>');
		expect(xmcd).toContain('<ml:and/>');
		expect(xmcd).toContain('subscript="1"');
	});

	it('does not render nested <ml:apply> as operator for call nodes', () => {
		const doc: SolutionDocumentV1 = {
			version: 'solution-doc-2.0',
			locale: 'ru',
			sections: [
				{
					id: 'section_1',
					title: 'Solution',
					blocks: [
						{
							id: 'block_1',
							kind: 'equation',
							mathAst: {
								type: 'call',
								fn: {
									type: 'apply',
									op: 'plus',
									args: [{ type: 'id', name: 'x' }, { type: 'id', name: 'y' }]
								},
								args: [{ type: 'id', name: 'z' }]
							}
						}
					]
				}
			]
		};

		const xmcd = buildXmcdFromSolutionDocument(doc);
		expect(xmcd).not.toMatch(/<ml:apply>\s*<ml:apply>/);
		expect(xmcd).toContain('<ml:id xml:space="preserve">x + y</ml:id>');
	});

	it('wraps multi-argument function calls into ml:sequence', () => {
		const doc: SolutionDocumentV1 = {
			version: 'solution-doc-2.0',
			locale: 'ru',
			sections: [
				{
					id: 'section_1',
					title: 'Solution',
					blocks: [
						{
							id: 'block_1',
							kind: 'equation',
							mathAst: {
								type: 'call',
								fn: { type: 'id', name: 'lsolve' },
								args: [
									{ type: 'id', name: 'M' },
									{ type: 'id', name: 'v' }
								]
							}
						}
					]
				}
			]
		};

		const xmcd = buildXmcdFromSolutionDocument(doc);
		expect(xmcd).toContain(
			'<ml:apply><ml:id xml:space="preserve">lsolve</ml:id><ml:sequence><ml:id xml:space="preserve">M</ml:id><ml:id xml:space="preserve">v</ml:id></ml:sequence></ml:apply>'
		);
		expect(xmcd).not.toContain(
			'<ml:apply><ml:id xml:space="preserve">lsolve</ml:id><ml:id xml:space="preserve">M</ml:id><ml:id xml:space="preserve">v</ml:id></ml:apply>'
		);
	});

	it('folds n-ary arithmetic operators into binary apply trees', () => {
		const doc: SolutionDocumentV1 = {
			version: 'solution-doc-2.0',
			locale: 'ru',
			sections: [
				{
					id: 'section_1',
					title: 'Solution',
					blocks: [
						{
							id: 'block_1',
							kind: 'equation',
							mathAst: {
								type: 'apply',
								op: 'plus',
								args: [
									{ type: 'num', value: '1' },
									{ type: 'num', value: '2' },
									{ type: 'num', value: '3' }
								]
							}
						}
					]
				}
			]
		};

		const xmcd = buildXmcdFromSolutionDocument(doc);
		expect(xmcd).toContain(
			'<ml:apply><ml:plus/><ml:apply><ml:plus/><ml:real>1</ml:real><ml:real>2</ml:real></ml:apply><ml:real>3</ml:real></ml:apply>'
		);
		expect(xmcd).not.toContain(
			'<ml:apply><ml:plus/><ml:real>1</ml:real><ml:real>2</ml:real><ml:real>3</ml:real></ml:apply>'
		);
	});

	it('keeps derivative-style call trees schema-safe for Mathcad', () => {
		const yOfX = {
			type: 'call' as const,
			fn: { type: 'id' as const, name: 'y' },
			args: [{ type: 'id' as const, name: 'x' }]
		};
		const firstDerivative = {
			type: 'call' as const,
			fn: { type: 'id' as const, name: 'Derivative' },
			args: [
				yOfX,
				{
					type: 'call' as const,
					fn: { type: 'id' as const, name: 'Tuple' },
					args: [{ type: 'id' as const, name: 'x' }, { type: 'num' as const, value: '1' }]
				}
			]
		};
		const secondDerivative = {
			type: 'call' as const,
			fn: { type: 'id' as const, name: 'Derivative' },
			args: [
				yOfX,
				{
					type: 'call' as const,
					fn: { type: 'id' as const, name: 'Tuple' },
					args: [{ type: 'id' as const, name: 'x' }, { type: 'num' as const, value: '2' }]
				}
			]
		};

		const doc: SolutionDocumentV1 = {
			version: 'solution-doc-2.0',
			locale: 'ru',
			sections: [
				{
					id: 'section_1',
					title: 'Solution',
					blocks: [
						{
							id: 'block_1',
							kind: 'definition',
							mathAst: {
								type: 'define',
								lhs: { type: 'id', name: 'ODE' },
								rhs: {
									type: 'apply',
									op: 'equal',
									args: [
										{
											type: 'apply',
											op: 'plus',
											args: [
												{
													type: 'apply',
													op: 'mult',
													args: [{ type: 'num', value: '-1' }, firstDerivative]
												},
												{
													type: 'apply',
													op: 'mult',
													args: [{ type: 'num', value: '-2' }, yOfX]
												},
												secondDerivative
											]
										},
										{ type: 'num', value: '4' }
									]
								}
							}
						}
					]
				}
			]
		};

		const xmcd = buildXmcdFromSolutionDocument(doc);
		expect((xmcd.match(/<ml:plus\/>/g) ?? []).length).toBe(2);
		expect(xmcd).toContain('<ml:id xml:space="preserve">Derivative</ml:id><ml:sequence>');
		expect(xmcd).not.toContain('<ml:id xml:space="preserve">Derivative</ml:id><ml:apply>');
		expect(xmcd).toContain('<ml:id xml:space="preserve">Tuple</ml:id><ml:sequence>');
		expect(xmcd).not.toContain('<ml:id xml:space="preserve">Tuple</ml:id><ml:id xml:space="preserve">x</ml:id>');
	});

	it('degrades unsafe math ids with spaces to text blocks', () => {
		const doc: SolutionDocumentV1 = {
			version: 'solution-doc-2.0',
			locale: 'ru',
			sections: [
				{
					id: 'section_1',
					title: 'Solution',
					blocks: [
						{
							id: 'block_1',
							kind: 'definition',
							title: 'Definition',
							expression: 'L := Длина балки',
							mathAst: {
								type: 'define',
								lhs: { type: 'id', name: 'L' },
								rhs: { type: 'id', name: 'Длина балки' }
							}
						}
					]
				}
			]
		};

		const xmcd = buildXmcdFromSolutionDocument(doc);
		expect(xmcd).toContain('L := Длина балки');
		expect(xmcd).not.toContain('<ml:define><ml:id xml:space="preserve">L</ml:id><ml:id xml:space="preserve">Длина балки</ml:id></ml:define>');
	});

	it('degrades text math nodes to text regions', () => {
		const doc: SolutionDocumentV1 = {
			version: 'solution-doc-2.0',
			locale: 'ru',
			sections: [
				{
					id: 'section_1',
					title: 'Solution',
					blocks: [
						{
							id: 'block_1',
							kind: 'solve',
							title: 'Solve',
							expression: 'Реакции в заделке',
							mathAst: {
								type: 'text',
								value: 'Реакции в заделке'
							}
						}
					]
				}
			]
		};

		const xmcd = buildXmcdFromSolutionDocument(doc);
		expect(xmcd).toContain('Реакции в заделке');
		expect(xmcd).not.toContain('<math optimize="false" disable-calc="false"><ml:id xml:space="preserve">Реакции в заделке</ml:id></math>');
	});

	it('serializes rational num literals as division apply nodes', () => {
		const doc: SolutionDocumentV1 = {
			version: 'solution-doc-2.0',
			locale: 'ru',
			sections: [
				{
					id: 'section_1',
					title: 'Solution',
					blocks: [
						{
							id: 'block_1',
							kind: 'equation',
							mathAst: {
								type: 'apply',
								op: 'plus',
								args: [
									{ type: 'num', value: '1/2' },
									{ type: 'num', value: '-1/2' }
								]
							}
						}
					]
				}
			]
		};

		const xmcd = buildXmcdFromSolutionDocument(doc);
		expect(xmcd).toContain('<ml:apply><ml:div/><ml:real>1</ml:real><ml:real>2</ml:real></ml:apply>');
		expect(xmcd).toContain('<ml:apply><ml:div/><ml:real>-1</ml:real><ml:real>2</ml:real></ml:apply>');
		expect(xmcd).not.toContain('<ml:real>1/2</ml:real>');
		expect(xmcd).not.toContain('<ml:real>-1/2</ml:real>');
	});
});
