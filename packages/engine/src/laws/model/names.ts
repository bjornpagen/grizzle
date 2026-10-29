import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"

/** Two literals are one value exactly when their canonical encodings are equal. */
export const literalKey = (literal: TypedLiteral): string => canonicalTextOf(literal)
