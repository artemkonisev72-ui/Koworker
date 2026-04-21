import { randomUUID } from 'node:crypto';
import { mathAstToText, type MathNodeV1, type SolutionBlockV1, type SolutionDocumentV1 } from '$lib/solution/document.js';

type XmcdRegion = XmcdTextRegion | XmcdMathRegion;

interface XmcdBaseRegion {
	id: number;
	left: number;
	top: number;
	width: number;
	height: number;
	alignX: number;
	alignY: number;
	lockWidth: boolean;
}

interface XmcdTextRegion extends XmcdBaseRegion {
	type: 'text';
	text: string;
}

interface XmcdMathRegion extends XmcdBaseRegion {
	type: 'math';
	mathAst: MathNodeV1;
}

interface XmcdBlockContext {
	sectionId: string;
	blockId: string;
	sectionIndex: number;
	blockIndex: number;
	kind: SolutionBlockV1['kind'];
}

type XmcdOperatorFoldDirection = 'left' | 'right';

interface XmcdOperatorSpec {
	tag: string;
	minArgs: number;
	maxArgs: number;
	foldDirection?: XmcdOperatorFoldDirection;
}

interface XmcdMathNodeValidation {
	ok: boolean;
	reason?: string;
}

type XmcdNumericLiteral =
	| { kind: 'real'; value: string }
	| { kind: 'fraction'; numerator: string; denominator: string };

const XMCD_WORKSHEET_VERSION = '3.0.3';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 72;
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const CONTENT_TOP = PAGE_MARGIN;
const TEXT_LINE_HEIGHT = 12;
const REGION_VERTICAL_GAP = 6;
const TEXT_BASELINE_OFFSET = 9.75;
const MAX_REGION_HEIGHT = 260;
const ESTIMATED_CHAR_WIDTH = 5.8;
const XMCD_OPERATOR_SPECS: Record<string, XmcdOperatorSpec> = {
	plus: { tag: 'plus', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	minus: { tag: 'minus', minArgs: 1, maxArgs: 2, foldDirection: 'left' },
	mult: { tag: 'mult style="auto-select"', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	div: { tag: 'div', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	pow: { tag: 'pow', minArgs: 2, maxArgs: 2, foldDirection: 'right' },
	equal: { tag: 'equal', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	lessThan: { tag: 'lessThan', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	lessOrEqual: { tag: 'lessOrEqual', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	greaterThan: { tag: 'greaterThan', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	greaterOrEqual: { tag: 'greaterOrEqual', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	sqrt: { tag: 'sqrt', minArgs: 1, maxArgs: 1 },
	and: { tag: 'and', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	or: { tag: 'or', minArgs: 2, maxArgs: 2, foldDirection: 'left' },
	not: { tag: 'not', minArgs: 1, maxArgs: 1 }
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function xmlEscape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function normalizeLineBreaks(value: string): string[] {
	return value
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.split('\n');
}

function estimateWrappedLineCount(text: string, width: number): number {
	const maxCharsPerLine = Math.max(24, Math.floor(width / ESTIMATED_CHAR_WIDTH));
	return normalizeLineBreaks(text).reduce((total, line) => {
		const logicalLength = Math.max(1, line.trim().length || line.length);
		return total + Math.max(1, Math.ceil(logicalLength / maxCharsPerLine));
	}, 0);
}

function estimateTextRegionHeight(text: string, minHeight = TEXT_LINE_HEIGHT): number {
	const wrappedLineCount = estimateWrappedLineCount(text, CONTENT_WIDTH);
	return Math.min(MAX_REGION_HEIGHT, Math.max(minHeight, wrappedLineCount * TEXT_LINE_HEIGHT));
}

function estimateMathRegionSize(mathAst: MathNodeV1): { width: number; height: number } {
	const textual = mathAstToText(mathAst) ?? '[math]';
	const width = Math.max(220, Math.min(540, 120 + textual.length * 5));

	let height = 21;
	if (mathAst.type === 'matrix') {
		height = Math.max(24, 18 + mathAst.rows * 15);
	} else if (mathAst.type === 'program') {
		height = Math.max(36, 20 + mathAst.branches.length * 20 + (mathAst.otherwise ? 16 : 0));
	} else if (mathAst.type === 'integral' || mathAst.type === 'function_def' || mathAst.type === 'eval') {
		height = 30;
	}

	return {
		width,
		height: Math.min(MAX_REGION_HEIGHT, height)
	};
}

function parseNumericLiteral(value: string): XmcdNumericLiteral | null {
	const trimmed = value.trim();
	if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
		return { kind: 'real', value: trimmed };
	}

	const fractionMatch = trimmed.match(/^([+-]?\d+)\/([+-]?\d+)$/);
	if (!fractionMatch) return null;

	try {
		let numerator = BigInt(fractionMatch[1]);
		let denominator = BigInt(fractionMatch[2]);
		if (denominator === 0n) return null;
		if (denominator < 0n) {
			numerator = -numerator;
			denominator = -denominator;
		}
		return {
			kind: 'fraction',
			numerator: numerator.toString(),
			denominator: denominator.toString()
		};
	} catch {
		return null;
	}
}

function isSafeMathIdentifier(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;
	// Mathcad identifiers with spaces frequently break file opening; keep exported math ids strict.
	return !/\s/.test(trimmed);
}

function validateMathNodeForXmcd(node: MathNodeV1, depth = 0): XmcdMathNodeValidation {
	if (depth > 64) return { ok: false, reason: 'max_depth_exceeded' };

	if (node.type === 'id') {
		if (!isSafeMathIdentifier(node.name)) return { ok: false, reason: 'unsafe_id_name' };
		if (node.subscript && /\s/.test(node.subscript)) return { ok: false, reason: 'unsafe_id_subscript' };
		return { ok: true };
	}

	if (node.type === 'num') {
		return parseNumericLiteral(node.value) ? { ok: true } : { ok: false, reason: 'invalid_num_literal' };
	}

	if (node.type === 'text') {
		// Plain text AST nodes are better rendered as text regions, not math AST.
		return { ok: false, reason: 'text_node' };
	}

	if (node.type === 'apply') {
		if (node.op.trim().length === 0 || /\s/.test(node.op)) return { ok: false, reason: 'unsafe_apply_op' };
		for (const arg of node.args) {
			const validation = validateMathNodeForXmcd(arg, depth + 1);
			if (!validation.ok) return validation;
		}
		return { ok: true };
	}

	if (node.type === 'define') {
		const leftValidation = validateMathNodeForXmcd(node.lhs, depth + 1);
		if (!leftValidation.ok) return leftValidation;
		return validateMathNodeForXmcd(node.rhs, depth + 1);
	}

	if (node.type === 'function_def') {
		const nameValidation = validateMathNodeForXmcd(node.name, depth + 1);
		if (!nameValidation.ok) return nameValidation;
		for (const entry of node.params) {
			const paramValidation = validateMathNodeForXmcd(entry, depth + 1);
			if (!paramValidation.ok) return paramValidation;
		}
		return validateMathNodeForXmcd(node.body, depth + 1);
	}

	if (node.type === 'call') {
		const fnValidation = validateMathNodeForXmcd(node.fn, depth + 1);
		if (!fnValidation.ok) return fnValidation;
		for (const entry of node.args) {
			const argValidation = validateMathNodeForXmcd(entry, depth + 1);
			if (!argValidation.ok) return argValidation;
		}
		return { ok: true };
	}

	if (node.type === 'integral') {
		const variableValidation = validateMathNodeForXmcd(node.variable, depth + 1);
		if (!variableValidation.ok) return variableValidation;
		const lowerValidation = validateMathNodeForXmcd(node.lower, depth + 1);
		if (!lowerValidation.ok) return lowerValidation;
		const upperValidation = validateMathNodeForXmcd(node.upper, depth + 1);
		if (!upperValidation.ok) return upperValidation;
		return validateMathNodeForXmcd(node.body, depth + 1);
	}

	if (node.type === 'matrix') {
		if (node.rows <= 0 || node.cols <= 0) return { ok: false, reason: 'invalid_matrix_shape' };
		for (const entry of node.values) {
			const validation = validateMathNodeForXmcd(entry, depth + 1);
			if (!validation.ok) return validation;
		}
		return { ok: true };
	}

	if (node.type === 'program') {
		for (const branch of node.branches) {
			const conditionValidation = validateMathNodeForXmcd(branch.condition, depth + 1);
			if (!conditionValidation.ok) return conditionValidation;
			const valueValidation = validateMathNodeForXmcd(branch.value, depth + 1);
			if (!valueValidation.ok) return valueValidation;
		}
		if (node.otherwise) {
			return validateMathNodeForXmcd(node.otherwise, depth + 1);
		}
		return { ok: true };
	}

	if (node.type === 'eval') {
		return validateMathNodeForXmcd(node.expr, depth + 1);
	}

	if (node.type === 'lambda') {
		for (const entry of node.params) {
			const paramValidation = validateMathNodeForXmcd(entry, depth + 1);
			if (!paramValidation.ok) return paramValidation;
		}
		return validateMathNodeForXmcd(node.body, depth + 1);
	}

	return { ok: false, reason: 'unknown_node_type' };
}

function blockToText(block: SolutionBlockV1, context: XmcdBlockContext): string {
	const title = block.title ? `${block.title}: ` : '';

	if (block.kind === 'code') {
		console.warn('[XMCD] code_block_degraded_to_text', context);
		return `${title}${block.code ?? ''}`;
	}

	if (block.kind === 'plot' || block.kind === 'graph') {
		console.warn('[XMCD] plot_block_degraded_to_text', context);
		const graphTitle = block.title ?? 'Plot';
		const graphDetail = block.text ?? '';
		const dataInfo = block.data
			? ` (${typeof block.data.type === 'string' ? block.data.type : 'data'}${typeof block.data.points === 'number' ? `, ${block.data.points} points` : ''})`
			: '';
		return `${graphTitle}${graphDetail ? `: ${graphDetail}` : ''}${dataInfo}`;
	}

	if (block.kind === 'table') {
		const tableTitle = block.title ?? 'Table';
		const tableText = block.text ?? '';
		return `${tableTitle}${tableText ? `: ${tableText}` : ''}`;
	}

	if (block.kind === 'result') {
		const label = block.text ?? title.trimEnd();
		const value = block.value ?? '';
		return label ? `${label}${value ? `: ${value}` : ''}` : value;
	}

	const expression = block.expression ?? mathAstToText(block.mathAst) ?? block.text ?? '';
	const valueSuffix = block.value ? ` = ${block.value}` : '';
	return `${title}${expression}${valueSuffix}`;
}

function toScalarMathNode(value: string): MathNodeV1 {
	const trimmed = value.trim();
	if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
		return { type: 'num', value: trimmed };
	}
	return { type: 'text', value: trimmed };
}

function pickMathNodeFromBlock(block: SolutionBlockV1): MathNodeV1 | null {
	if (block.mathAst) return block.mathAst;

	if (block.kind === 'result' && typeof block.value === 'string' && block.value.trim().length > 0) {
		return toScalarMathNode(block.value);
	}
	if (
		(block.kind === 'equation' ||
			block.kind === 'definition' ||
			block.kind === 'solve' ||
			block.kind === 'evaluation' ||
			block.kind === 'math') &&
		typeof block.expression === 'string' &&
		block.expression.trim().length > 0
	) {
		return toScalarMathNode(block.expression);
	}
	return null;
}

function buildRegions(solutionDoc: SolutionDocumentV1): XmcdRegion[] {
	const regions: XmcdRegion[] = [];
	let top = CONTENT_TOP;
	let id = 1;

	const pushTextRegion = (text: string, minHeight = TEXT_LINE_HEIGHT, lockWidth = true) => {
		const normalized = text.trim();
		if (!normalized) return;

		const height = estimateTextRegionHeight(normalized, minHeight);
		regions.push({
			type: 'text',
			id,
			left: CONTENT_LEFT,
			top,
			width: CONTENT_WIDTH,
			height,
			alignX: CONTENT_LEFT,
			alignY: Number((top + TEXT_BASELINE_OFFSET).toFixed(2)),
			lockWidth,
			text: normalized
		});
		id += 1;
		top += height + REGION_VERTICAL_GAP;
	};

	const pushMathRegion = (mathAst: MathNodeV1) => {
		const { width, height } = estimateMathRegionSize(mathAst);
		regions.push({
			type: 'math',
			id,
			left: CONTENT_LEFT,
			top,
			width,
			height,
			alignX: CONTENT_LEFT,
			alignY: Number((top + TEXT_BASELINE_OFFSET).toFixed(2)),
			lockWidth: true,
			mathAst
		});
		id += 1;
		top += height + REGION_VERTICAL_GAP;
	};

	if (solutionDoc.summary) {
		pushTextRegion(solutionDoc.summary, 24);
	}

	for (const [sectionIndex, section] of solutionDoc.sections.entries()) {
		pushTextRegion(section.title, 18);
		if (section.blocks.length === 0) {
			pushTextRegion(solutionDoc.locale === 'ru' ? 'Раздел не содержит шагов.' : 'Section is empty.');
			continue;
		}

		for (const [blockIndex, block] of section.blocks.entries()) {
			const context: XmcdBlockContext = {
				sectionId: section.id,
				blockId: block.id,
				sectionIndex,
				blockIndex,
				kind: block.kind
			};

			try {
				const mathNode = pickMathNodeFromBlock(block);
				if (block.title && block.kind !== 'note') {
					pushTextRegion(block.title, TEXT_LINE_HEIGHT);
				}
				const validation = mathNode ? validateMathNodeForXmcd(mathNode) : null;
				const canRenderMath =
					Boolean(mathNode) &&
					block.kind !== 'note' &&
					block.kind !== 'table' &&
					block.kind !== 'code' &&
					Boolean(validation?.ok);
				if (canRenderMath && mathNode) {
					pushMathRegion(mathNode);
					if (block.text && block.kind === 'result') {
						pushTextRegion(block.text, TEXT_LINE_HEIGHT);
					}
				} else {
					if (mathNode && validation && !validation.ok) {
						console.warn('[XMCD] math_block_degraded_to_text', {
							...context,
							reason: validation.reason
						});
					}
					const text = normalizeLineBreaks(blockToText(block, context)).join('\n');
					pushTextRegion(text);
				}
			} catch (err) {
				console.error('[XMCD] block_serialization_failed', {
					...context,
					error: err instanceof Error ? err.message : String(err)
				});
				pushTextRegion(
					solutionDoc.locale === 'ru'
						? 'Шаг пропущен из-за ошибки сериализации.'
						: 'Step omitted due to serialization error.'
				);
			}
		}
	}

	return regions;
}

function renderOperatorApplyNode(tag: string, args: string[]): string {
	return `<ml:apply><ml:${tag}/>${args.join('')}</ml:apply>`;
}

function renderFunctionLikeApply(op: string, args: string[]): string {
	return `<ml:apply><ml:id xml:space="preserve">${xmlEscape(op)}</ml:id>${args.join('')}</ml:apply>`;
}

function foldOperatorApply(tag: string, args: string[], direction: XmcdOperatorFoldDirection): string {
	if (direction === 'right') {
		let acc = renderOperatorApplyNode(tag, [args[args.length - 2], args[args.length - 1]]);
		for (let index = args.length - 3; index >= 0; index -= 1) {
			acc = renderOperatorApplyNode(tag, [args[index], acc]);
		}
		return acc;
	}

	let acc = renderOperatorApplyNode(tag, [args[0], args[1]]);
	for (let index = 2; index < args.length; index += 1) {
		acc = renderOperatorApplyNode(tag, [acc, args[index]]);
	}
	return acc;
}

function renderOperatorApply(op: string, args: string[], context: XmcdBlockContext): string {
	const spec = XMCD_OPERATOR_SPECS[op];
	if (!spec) return renderFunctionLikeApply(op, args);

	if (args.length < spec.minArgs) {
		console.warn('[XMCD] operator_args_insufficient', {
			...context,
			op,
			argCount: args.length,
			minArgs: spec.minArgs
		});
		return renderFunctionLikeApply(op, args);
	}

	if (args.length <= spec.maxArgs) {
		return renderOperatorApplyNode(spec.tag, args);
	}

	if (!spec.foldDirection) {
		console.warn('[XMCD] operator_args_excess', {
			...context,
			op,
			argCount: args.length,
			maxArgs: spec.maxArgs
		});
		return renderFunctionLikeApply(op, args);
	}

	return foldOperatorApply(spec.tag, args, spec.foldDirection);
}

function renderMathNode(node: MathNodeV1, context: XmcdBlockContext): string {
	if (node.type === 'id') {
		const subscriptAttr = node.subscript ? ` subscript="${xmlEscape(node.subscript)}"` : '';
		return `<ml:id xml:space="preserve"${subscriptAttr}>${xmlEscape(node.name)}</ml:id>`;
	}

	if (node.type === 'num') {
		const numeric = parseNumericLiteral(node.value);
		if (!numeric) {
			console.warn('[XMCD] invalid_num_literal_fallback', {
				...context,
				value: node.value
			});
			return `<ml:id xml:space="preserve">${xmlEscape(node.value)}</ml:id>`;
		}
		if (numeric.kind === 'real') {
			return `<ml:real>${xmlEscape(numeric.value)}</ml:real>`;
		}
		return `<ml:apply><ml:div/><ml:real>${xmlEscape(numeric.numerator)}</ml:real><ml:real>${xmlEscape(numeric.denominator)}</ml:real></ml:apply>`;
	}

	if (node.type === 'text') {
		return `<ml:id xml:space="preserve">${xmlEscape(node.value)}</ml:id>`;
	}

	if (node.type === 'apply') {
		const op = node.op.trim();
		const args = node.args.map((arg) => renderMathNode(arg, context));
		return renderOperatorApply(op, args, context);
	}

	if (node.type === 'define') {
		return `<ml:define>${renderMathNode(node.lhs, context)}${renderMathNode(node.rhs, context)}</ml:define>`;
	}

	if (node.type === 'function_def') {
		const params = node.params.map((entry) => renderMathNode(entry, context)).join('');
		return `<ml:define><ml:function>${renderMathNode(node.name, context)}<ml:boundVars>${params}</ml:boundVars></ml:function>${renderMathNode(node.body, context)}</ml:define>`;
	}

	if (node.type === 'call') {
		let fn: string;
		if (node.fn.type === 'id') {
			fn = renderMathNode(node.fn, context);
		} else if (node.fn.type === 'text') {
			fn = `<ml:id xml:space="preserve">${xmlEscape(node.fn.value)}</ml:id>`;
		} else {
			// Mathcad apply requires the first child to be an operator/id, not nested apply.
			const fallbackFnText = mathAstToText(node.fn) ?? 'fn';
			console.warn('[XMCD] call_fn_degraded_to_id', {
				...context,
				callFnType: node.fn.type
			});
			fn = `<ml:id xml:space="preserve">${xmlEscape(fallbackFnText)}</ml:id>`;
		}
		const renderedArgs = node.args.map((entry) => renderMathNode(entry, context));
		if (renderedArgs.length <= 1) {
			return `<ml:apply>${fn}${renderedArgs.join('')}</ml:apply>`;
		}
		return `<ml:apply>${fn}<ml:sequence>${renderedArgs.join('')}</ml:sequence></ml:apply>`;
	}

	if (node.type === 'integral') {
		return `<ml:apply><ml:integral auto-algorithm="true" algorithm="adaptive"/><ml:lambda><ml:boundVars>${renderMathNode(node.variable, context)}</ml:boundVars>${renderMathNode(node.body, context)}</ml:lambda><ml:bounds>${renderMathNode(node.lower, context)}${renderMathNode(node.upper, context)}</ml:bounds></ml:apply>`;
	}

	if (node.type === 'matrix') {
		const values = node.values.map((entry) => renderMathNode(entry, context)).join('');
		return `<ml:matrix rows="${node.rows}" cols="${node.cols}">${values}</ml:matrix>`;
	}

	if (node.type === 'program') {
		const branches = node.branches
			.map(
				(branch) =>
					`<ml:ifThen>${renderMathNode(branch.condition, context)}${renderMathNode(branch.value, context)}</ml:ifThen>`
			)
			.join('');
		const otherwise = node.otherwise ? `<ml:otherwise>${renderMathNode(node.otherwise, context)}</ml:otherwise>` : '';
		return `<ml:program>${branches}${otherwise}</ml:program>`;
	}

	if (node.type === 'eval') {
		return `<ml:eval placeholderMultiplicationStyle="default">${renderMathNode(node.expr, context)}</ml:eval>`;
	}

	if (node.type === 'lambda') {
		const params = node.params.map((entry) => renderMathNode(entry, context)).join('');
		return `<ml:lambda><ml:boundVars>${params}</ml:boundVars>${renderMathNode(node.body, context)}</ml:lambda>`;
	}

	const unknownNodeType = (node as unknown as { type?: unknown }).type;
	console.error('[XMCD] unknown_math_node_type', {
		...context,
		node: typeof unknownNodeType === 'string' ? unknownNodeType : typeof node
	});
	return `<ml:id xml:space="preserve">unsupported_math_node</ml:id>`;
}

function renderTextRegion(region: XmcdTextRegion): string {
	const paragraphs = normalizeLineBreaks(region.text)
		.map((line) => {
			const safeText = xmlEscape(line.length > 0 ? line : ' ');
			return `<p style="Normal" margin-left="inherit" margin-right="inherit" text-indent="inherit" text-align="inherit" list-style-type="inherit" tabs="inherit">${safeText}</p>`;
		})
		.join('');

	return `<region region-id="${region.id}" left="${region.left}" top="${region.top}" width="${region.width}" height="${region.height}" align-x="${region.alignX}" align-y="${region.alignY}" show-border="false" show-highlight="false" is-protected="true" z-order="0" background-color="inherit" tag=""><text use-page-width="false" push-down="false" lock-width="${region.lockWidth ? 'true' : 'false'}">${paragraphs}</text></region>`;
}

function renderMathRegion(region: XmcdMathRegion, context: XmcdBlockContext): string {
	const mathXml = renderMathNode(region.mathAst, context);
	return `<region region-id="${region.id}" left="${region.left}" top="${region.top}" width="${region.width}" height="${region.height}" align-x="${region.alignX}" align-y="${region.alignY}" show-border="false" show-highlight="false" is-protected="true" z-order="0" background-color="inherit" tag=""><math optimize="false" disable-calc="false">${mathXml}</math></region>`;
}

function renderRegion(region: XmcdRegion): string {
	if (region.type === 'text') return renderTextRegion(region);
	return renderMathRegion(region, {
		sectionId: 'compiled',
		blockId: `region-${region.id}`,
		sectionIndex: -1,
		blockIndex: -1,
		kind: 'math'
	});
}

function renderSettingsXml(locale: SolutionDocumentV1['locale'], regionUpperBound: number): string {
	const language = locale === 'en' ? 'en' : 'ru';

	return `  <settings>
    <presentation>
      <textRendering>
        <textStyles>
          <textStyle name="Normal">
            <blockAttr margin-left="0" margin-right="0" text-indent="inherit" text-align="left" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Arial" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
          <textStyle name="Heading 1">
            <blockAttr margin-left="0" margin-right="0" text-indent="inherit" text-align="left" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Arial" font-charset="0" font-size="14" font-weight="bold" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
          <textStyle name="Heading 2">
            <blockAttr margin-left="0" margin-right="0" text-indent="inherit" text-align="left" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Arial" font-charset="0" font-size="12" font-weight="bold" font-style="italic" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
          <textStyle name="Heading 3">
            <blockAttr margin-left="0" margin-right="0" text-indent="inherit" text-align="left" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Arial" font-charset="0" font-size="12" font-weight="normal" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
          <textStyle name="Paragraph">
            <blockAttr margin-left="0" margin-right="0" text-indent="21" text-align="left" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Arial" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
          <textStyle name="List">
            <blockAttr margin-left="14.25" margin-right="0" text-indent="-14.25" text-align="left" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Arial" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
          <textStyle name="Indent">
            <blockAttr margin-left="108" margin-right="0" text-indent="inherit" text-align="left" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Arial" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
          <textStyle name="Title">
            <blockAttr margin-left="0" margin-right="0" text-indent="inherit" text-align="center" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Times New Roman" font-charset="0" font-size="24" font-weight="bold" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
          <textStyle name="Subtitle" base-style="Title">
            <blockAttr margin-left="0" margin-right="0" text-indent="inherit" text-align="center" list-style-type="inherit" tabs="inherit"/>
            <inlineAttr font-family="Times New Roman" font-charset="0" font-size="18" font-weight="normal" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/>
          </textStyle>
        </textStyles>
      </textRendering>
      <mathRendering equation-color="#000">
        <operators multiplication="narrow-dot" derivative="derivative" literal-subscript="large" definition="colon-equal" global-definition="triple-equal" local-definition="left-arrow" equality="bold-equal" symbolic-evaluation="right-arrow"/>
        <mathStyles>
          <mathStyle name="Variables" font-family="Times New Roman" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false"/>
          <mathStyle name="Constants" font-family="Times New Roman" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false"/>
          <mathStyle name="User 1" font-family="Arial" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false"/>
          <mathStyle name="User 2" font-family="Courier New" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false"/>
          <mathStyle name="User 3" font-family="Arial" font-charset="0" font-size="10" font-weight="bold" font-style="normal" underline="false"/>
          <mathStyle name="User 4" font-family="Times New Roman" font-charset="0" font-size="10" font-weight="normal" font-style="italic" underline="false"/>
          <mathStyle name="User 5" font-family="Times New Roman" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false"/>
          <mathStyle name="User 6" font-family="Arial" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false"/>
          <mathStyle name="User 7" font-family="Times New Roman" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false"/>
          <mathStyle name="Math Text Font" font-family="Times New Roman" font-charset="0" font-size="14" font-weight="normal" font-style="normal" underline="false"/>
        </mathStyles>
        <dimensionNames mass="mass" length="length" time="time" current="current" thermodynamic-temperature="temperature" luminous-intensity="luminosity" amount-of-substance="substance" display="false"/>
        <symbolics derivation-steps-style="vertical-insert" show-comments="false" evaluate-in-place="false"/>
        <results numeric-only="true">
          <general precision="3" show-trailing-zeros="false" radix="dec" complex-threshold="10" zero-threshold="15" imaginary-value="i" exponential-threshold="3"/>
          <matrix display-style="auto" expand-nested-arrays="false"/>
          <unit format-units="true" simplify-units="true" fractional-unit-exponent="false"/>
        </results>
      </mathRendering>
      <pageModel show-page-frame="false" show-header-frame="false" show-footer-frame="false" header-footer-start-page="1" paper-code="1" orientation="portrait" print-single-page-width="false" page-width="${PAGE_WIDTH}" page-height="${PAGE_HEIGHT}">
        <margins left="${PAGE_MARGIN}" right="${PAGE_MARGIN}" top="${PAGE_MARGIN}" bottom="${PAGE_MARGIN}"/>
        <header use-full-page-width="false"/>
        <footer use-full-page-width="false"/>
      </pageModel>
      <colorModel background-color="#fff" default-highlight-color="#ffff80"/>
      <language math="${language}" UI="${language}"/>
    </presentation>
    <calculation>
      <builtInVariables array-origin="0" convergence-tolerance="0.001" constraint-tolerance="0.001" random-seed="1" prn-precision="4" prn-col-width="8"/>
      <calculationBehavior automatic-recalculation="true" matrix-strict-singularity-check="false" optimize-expressions="false" exact-boolean="true" strings-use-origin="false" zero-over-zero="error">
        <compatibility multiple-assignment="MC12" local-assignment="MC11"/>
      </calculationBehavior>
      <units>
        <currentUnitSystem name="si" customized="false"/>
      </units>
    </calculation>
    <editor view-annotations="false" view-regions="false">
      <ruler is-visible="false" ruler-unit="in"/>
      <plotTemplate>
        <xy item-idref="1"/>
      </plotTemplate>
      <grid granularity-x="6" granularity-y="6"/>
    </editor>
    <fileFormat image-type="image/png" image-quality="75" save-numeric-results="true" exclude-large-results="true" save-text-images="false" screen-dpi="96"/>
    <miscellaneous>
      <handbook handbook-region-tag-ub="${regionUpperBound}" can-delete-original-handbook-regions="true" can-delete-user-regions="true" can-print="true" can-copy="true" can-save="true" file-permission-mask="4294967295"/>
    </miscellaneous>
  </settings>`;
}

export function buildXmcdFromSolutionDocument(
	solutionDoc: SolutionDocumentV1,
	options?: { author?: string; title?: string }
): string {
	let regions: XmcdRegion[];
	try {
		regions = buildRegions(solutionDoc);
	} catch (err) {
		console.error('[XMCD] build_regions_failed', {
			sections: solutionDoc.sections.length,
			error: err instanceof Error ? err.message : String(err)
		});
		throw err;
	}

	const documentId = randomUUID();
	const versionId = randomUUID();
	const parentVersionId = ZERO_GUID;
	const generator = xmlEscape('Coworker XMCD Exporter 1.1');
	const author = xmlEscape(options?.author?.trim() || 'Coworker User');
	const title = xmlEscape(options?.title?.trim() || 'Detailed solution');
	const company = xmlEscape('Coworker');
	const regionsXml = regions.map((region) => renderRegion(region)).join('');
	const regionUpperBound = Math.max(50, regions.at(-1)?.id ?? 0);
	const settingsXml = renderSettingsXml(solutionDoc.locale, regionUpperBound);

	return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<worksheet version="${XMCD_WORKSHEET_VERSION}" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ws="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30" xmlns:u="http://schemas.mathsoft.com/units10" xmlns:p="http://schemas.mathsoft.com/provenance10">
  <pointReleaseData/>
  <metadata>
    <generator>${generator}</generator>
    <userData>
      <title>${title}</title>
      <description/>
      <author>${author}</author>
      <company>${company}</company>
      <keywords/>
      <revisedBy>${author}</revisedBy>
    </userData>
    <identityInfo>
      <revision>3</revision>
      <documentID>${documentId}</documentID>
      <versionID>${versionId}</versionID>
      <parentVersionID>${parentVersionId}</parentVersionID>
      <branchID>${ZERO_GUID}</branchID>
    </identityInfo>
  </metadata>
${settingsXml}
  <regions>${regionsXml}</regions>
</worksheet>
`;
}
