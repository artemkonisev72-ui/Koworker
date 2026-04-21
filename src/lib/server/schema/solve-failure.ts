import {
	buildDiagnosticDetailedContent,
	buildDiagnosticDetailedSolutionDoc
} from '$lib/solution/failure.js';

export interface PersistSchemaSolveFailureParams {
	db: {
		taskDraft: {
			update: (args: unknown) => Promise<unknown>;
		};
		message: {
			create: (args: unknown) => Promise<unknown>;
		};
	};
	draftId: string;
	chatId: string;
	schemaVersion: string;
	userMessage: string;
	errorMessage: string;
	detailedSolution: boolean;
}

export async function persistSchemaSolveFailure(params: PersistSchemaSolveFailureParams): Promise<void> {
	const content = params.detailedSolution
		? buildDiagnosticDetailedContent({
				userMessage: params.userMessage,
				errorMessage: params.errorMessage,
				stage: 'schema_confirm'
			})
		: `Schema-confirmed solve failed: ${params.errorMessage}`;

	const solutionDoc = params.detailedSolution
		? buildDiagnosticDetailedSolutionDoc({
				userMessage: params.userMessage,
				errorMessage: params.errorMessage,
				stage: 'schema_confirm'
			})
		: undefined;

	await params.db.taskDraft
		.update({
			where: { id: params.draftId },
			data: { status: 'FAILED' }
		})
		.catch(() => undefined);

	await params.db.message
		.create({
			data: {
				chatId: params.chatId,
				draftId: params.draftId,
				role: 'ASSISTANT',
				content,
				solutionDoc: solutionDoc ?? undefined,
				schemaVersion: params.schemaVersion
			}
		})
		.catch(() => undefined);
}
