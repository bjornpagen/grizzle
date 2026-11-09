import { firstIndex } from "#compiler/core/array.ts"
import { defined } from "#compiler/core/invariant.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * The column `name` found in a heading, or in a column map the lowering built over one, that holds it: the one site of
 * the fact that every column a node of the valid DAG names (a binding, a correlation, an order, a key, a carried or
 * bound column) is a column of the heading it names it in (valid DAG). The DAG is data built before any lowering, and
 * each lowering mints its own SQL expression per column under its own fresh aliases, so a reference can never hold what
 * it is resolved to: it names a column, and what it reads is a runtime map from names to expressions. No TypeScript
 * type ties a runtime name to the key set of a runtime map, so an absent one is a defect.
 */
export const namedColumn = <V>(found: V | undefined, name: string): V =>
	defined(found, `a column ${name} of the heading the valid DAG names it in`)

/** The type of the column `name` of `heading`, a column the valid DAG names in that heading (namedColumn). */
export const columnType = (heading: Heading, name: string): ScalarType =>
	namedColumn(
		heading.find((h) => h.name === name),
		name
	).type

/** The position of the column `name` in `heading`, a column the valid DAG names in that heading (namedColumn). */
export const columnPosition = (heading: Heading, name: string): number =>
	namedColumn(
		firstIndex(heading, (h) => h.name === name),
		name
	)
