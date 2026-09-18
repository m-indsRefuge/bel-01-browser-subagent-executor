export const MAX_DRAFT_CHARACTERS: number

export function validateComposerDraft(text: unknown): string

export function buildComposerDraftWriteExpression(text: string): string

export function buildComposerDraftClearExpression(expectedText: string): string
