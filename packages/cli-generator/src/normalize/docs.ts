import { stripUnsafeText } from "#model/brands.ts"
import type { Docs } from "#model/entities.ts"

/**
 * The sanitized docs fields that are present.
 */
export const docsOf = (description: string | undefined, summary: string | undefined): Docs => ({
	...(description === undefined ? {} : { description: stripUnsafeText(description) }),
	...(summary === undefined ? {} : { summary: stripUnsafeText(summary) })
})
