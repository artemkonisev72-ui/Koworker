import { randomUUID } from 'node:crypto';
import type { SolutionBlockV1, SolutionDocumentV1 } from '$lib/solution/document.js';

interface XmcdRegion {
	id: number;
	left: number;
	top: number;
	width: number;
	height: number;
	alignX: number;
	alignY: number;
	lockWidth: boolean;
	text: string;
}

interface XmcdBlockContext {
	sectionId: string;
	blockId: string;
	sectionIndex: number;
	blockIndex: number;
	kind: SolutionBlockV1['kind'];
}

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
const MAX_REGION_HEIGHT = 240;
const ESTIMATED_CHAR_WIDTH = 5.8;

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

function estimateRegionHeight(text: string, minHeight = TEXT_LINE_HEIGHT): number {
	const wrappedLineCount = estimateWrappedLineCount(text, CONTENT_WIDTH);
	return Math.min(MAX_REGION_HEIGHT, Math.max(minHeight, wrappedLineCount * TEXT_LINE_HEIGHT));
}

function blockToText(block: SolutionBlockV1, context: XmcdBlockContext): string {
	const title = block.title ? `${block.title}: ` : '';

	if (block.kind === 'code') {
		console.warn('[XMCD] code_block_degraded_to_text', context);
		return `${title}${block.code ?? ''}`;
	}

	if (block.kind === 'definition' || block.kind === 'equation' || block.kind === 'solve') {
		const expression = block.expression ?? block.text ?? '';
		const valueSuffix = block.value ? ` = ${block.value}` : '';
		return `${title}${expression}${valueSuffix}`;
	}

	if (block.kind === 'result') {
		const label = block.text ?? title.trimEnd();
		const value = block.value ?? '';
		return label ? `${label}${value ? `: ${value}` : ''}` : value;
	}

	if (block.kind === 'graph') {
		const graphTitle = block.title ?? 'Graph';
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

	const text = block.text ?? block.expression ?? '';
	if (!text.trim() && !title.trim()) {
		console.warn('[XMCD] empty_block_content', context);
	}

	return `${title}${text}`;
}

function buildRegions(solutionDoc: SolutionDocumentV1): XmcdRegion[] {
	const regions: XmcdRegion[] = [];
	let top = CONTENT_TOP;
	let id = 1;

	const pushRegion = (text: string, minHeight = TEXT_LINE_HEIGHT, lockWidth = true) => {
		const normalized = text.trim();
		if (!normalized) return;

		const height = estimateRegionHeight(normalized, minHeight);
		regions.push({
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

	if (solutionDoc.summary) {
		pushRegion(solutionDoc.summary, 24);
	}

	for (const [sectionIndex, section] of solutionDoc.sections.entries()) {
		pushRegion(section.title, 18);
		if (section.blocks.length === 0) {
			pushRegion(solutionDoc.locale === 'ru' ? 'Раздел пуст.' : 'Section is empty.');
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
				const text = normalizeLineBreaks(blockToText(block, context)).join('\n');
				pushRegion(text);
			} catch (err) {
				console.error('[XMCD] block_serialization_failed', {
					...context,
					error: err instanceof Error ? err.message : String(err)
				});
				pushRegion(
					solutionDoc.locale === 'ru'
						? 'Шаг пропущен из-за ошибки сериализации.'
						: 'Step omitted due to serialization error.'
				);
			}
		}
	}

	return regions;
}

function renderTextRegion(region: XmcdRegion): string {
	const paragraphs = normalizeLineBreaks(region.text)
		.map((line) => {
			const safeText = xmlEscape(line.length > 0 ? line : ' ');
			return `<p style="Normal" margin-left="inherit" margin-right="inherit" text-indent="inherit" text-align="inherit" list-style-type="inherit" tabs="inherit">${safeText}</p>`;
		})
		.join('');

	return `<region region-id="${region.id}" left="${region.left}" top="${region.top}" width="${region.width}" height="${region.height}" align-x="${region.alignX}" align-y="${region.alignY}" show-border="false" show-highlight="false" is-protected="true" z-order="0" background-color="inherit" tag=""><text use-page-width="false" push-down="false" lock-width="${region.lockWidth ? 'true' : 'false'}">${paragraphs}</text></region>`;
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
	const generator = xmlEscape('Coworker XMCD Exporter 1.0');
	const author = xmlEscape(options?.author?.trim() || 'Coworker User');
	const title = xmlEscape(options?.title?.trim() || 'Detailed solution');
	const company = xmlEscape('Coworker');
	const regionsXml = regions.map((region) => renderTextRegion(region)).join('');
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
