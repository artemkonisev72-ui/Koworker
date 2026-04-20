import { randomUUID } from 'node:crypto';
import type { SolutionBlockV1, SolutionDocumentV1 } from '$lib/solution/document.js';

interface XmcdRegion {
	id: number;
	top: number;
	height: number;
	text: string;
}

interface XmcdBlockContext {
	sectionId: string;
	blockId: string;
	sectionIndex: number;
	blockIndex: number;
	kind: SolutionBlockV1['kind'];
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
		return `${graphTitle}${graphDetail ? ': ' + graphDetail : ''}${dataInfo}`;
	}
	if (block.kind === 'table') {
		const tableTitle = block.title ?? 'Table';
		const tableText = block.text ?? '';
		return tableTitle + (tableText ? ': ' + tableText : '');
	}
	const text = block.text ?? block.expression ?? '';
	if (!text.trim() && !title.trim()) {
		console.warn('[XMCD] empty_block_content', context);
	}
	return `${title}${text}`;
}

function buildRegions(solutionDoc: SolutionDocumentV1): XmcdRegion[] {
	const regions: XmcdRegion[] = [];
	let top = 96;
	let id = 1;

	const pushRegion = (text: string, height = 24) => {
		const normalized = text.trim();
		if (!normalized) return;
		regions.push({ id, top, height, text: normalized });
		id += 1;
		top += height + 14;
	};

	if (solutionDoc.summary) {
		pushRegion(solutionDoc.summary, 28);
	}

	for (const [sectionIndex, section] of solutionDoc.sections.entries()) {
		pushRegion(section.title, 26);
		if (section.blocks.length === 0) {
			pushRegion(solutionDoc.locale === 'ru' ? 'Раздел пуст.' : 'Section is empty.', 22);
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
				const lines = normalizeLineBreaks(blockToText(block, context));
				const text = lines.join('\n');
				const dynamicHeight = Math.min(180, Math.max(24, lines.length * 18));
				pushRegion(text, dynamicHeight);
			} catch (err) {
				console.error('[XMCD] block_serialization_failed', {
					...context,
					error: err instanceof Error ? err.message : String(err)
				});
				pushRegion(
					solutionDoc.locale === 'ru'
						? 'Шаг пропущен из-за ошибки сериализации.'
						: 'Step omitted due to serialization error.',
					24
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
			return `<p style="Normal"><f family="Arial" charset="0" size="11">${safeText}</f></p>`;
		})
		.join('');

	return `<region region-id="${region.id}" left="96" top="${region.top}" width="860" height="${region.height}" align-x="0" align-y="0" show-border="false" show-highlight="false" is-protected="false" z-order="0"><text use-page-width="false" push-down="false" lock-width="true">${paragraphs}</text></region>`;
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
	const parentVersionId = randomUUID();
	const generator = xmlEscape('Coworker XMCD Exporter 1.0');
	const author = xmlEscape(options?.author?.trim() || 'Coworker User');
	const title = xmlEscape(options?.title?.trim() || 'Detailed solution');
	const regionsXml = regions.map((region) => renderTextRegion(region)).join('');

	return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30" xmlns:u="http://schemas.mathsoft.com/units10" xmlns:p="http://schemas.mathsoft.com/provenance10">
  <metadata>
    <generator>${generator}</generator>
    <author>${author}</author>
    <title>${title}</title>
  </metadata>
  <identityInfo>
    <documentID>${documentId}</documentID>
    <versionID>${versionId}</versionID>
    <parentVersionID>${parentVersionId}</parentVersionID>
  </identityInfo>
  <settings>
    <mathRendering multiplication="narrow-dot" derivative="derivative" matrix="matrix" />
    <calculationBehavior local-assignment="MC11" />
    <editor />
  </settings>
  <regions>${regionsXml}</regions>
</worksheet>
`;
}
