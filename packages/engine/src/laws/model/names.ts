import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"

/** Two literals are one value exactly when their canonical encodings are equal. */
export const literalKey = (literal: TypedLiteral): string => canonicalTextOf(literal)

/**
 * A key of its parts spelled apart: each text after its length, each list after its count, so no two lists of parts
 * spell one key.
 */
export const keyOf = (...parts: ReadonlyArray<string | ReadonlyArray<string>>): string =>
	parts
		.map((p) =>
			typeof p === "string"
				? `${p.length}:${p}`
				: `${p.length}[${p.map((x) => `${x.length}:${x}`).join("")}`
		)
		.join("")
