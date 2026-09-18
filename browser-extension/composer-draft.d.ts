export const MAX_DRAFT_CHARACTERS: number
export const DRAFT_STABILIZATION_MS: number

export function validateComposerDraft(text: unknown): string

export function buildComposerDraftPrepareWriteExpression(): string

export function buildComposerDraftPrepareClearExpression(expectedText: string): string

export function buildComposerDraftCompareExpression(expectedText: string): string
