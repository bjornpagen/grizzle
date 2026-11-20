import { stripUnsafeText } from "#model/brands.ts"

/**
 * The docs fields of a normalized body or parameter.
 */
export interface Docs {
	description?: string
	summary?: string
}

/**
 * The sanitized docs fields that are present.
 */
export const docsOf = (description: string | undefined, summary: string | undefined): Docs => {
	const docs: Docs = {}
	if (description !== undefined) {
		docs.description = stripUnsafeText(description)
	}

	if (summary !== undefined) {
		docs.summary = stripUnsafeText(summary)
	}

	return docs
}
