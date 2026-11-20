import { Effect, Option, Record } from "effect"
import { isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { follow, nodeOption } from "#normalize/document-set.ts"
import type { CanonicalKey } from "#resolve/canonical.ts"
import type { Resolution } from "#resolve/index.ts"

/**
 * The marks a Header Object carries that the generator reads.
 */
export interface HeaderMarks {
	readonly deprecated: boolean
	readonly required: boolean
}

const unmarked: HeaderMarks = { deprecated: false, required: false }

/**
 * Whether a Header Object carries `mark` as `true`; a mark that is absent or not a boolean reads
 * as false without discarding its sibling.
 */
const isMarked = (header: JsonObject, mark: keyof HeaderMarks): boolean =>
	Option.exists(Record.get(header, mark), (value) => value === true)

/**
 * The `required` and `deprecated` marks of the Header Object at use site `site` (a response header
 * or an encoding part header), read where its `$ref` leads. An absent mark is false, and a site
 * that is no object has neither mark.
 */
export const headerMarks = (
	resolution: Resolution,
	site: CanonicalKey
): Effect.Effect<HeaderMarks> =>
	Effect.sync(() =>
		Option.match(Option.filter(nodeOption(resolution, follow(resolution, site)), isObject), {
			onNone: () => unmarked,
			onSome: (header) => ({
				deprecated: isMarked(header, "deprecated"),
				required: isMarked(header, "required")
			})
		})
	)
