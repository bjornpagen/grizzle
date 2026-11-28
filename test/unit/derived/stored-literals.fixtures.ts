/** What stored-literals.test.ts reads: a box of unions whose arms deliver a column by a term and by a bare literal. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, type FiniteSpace, finite } from "@bjornpagen/testing/gen"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { natural, int8 } from "#compiler/public/fields.ts"
import { relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder } from "#compiler/schema/relation.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * The column the term arm delivers and the literal the other arm delivers it by: a natural beside 0n, which natural's
 * check admits, or beside -1n, which it refuses; a text of the pattern `^[a-z]{1,8}$` beside "abc", which the pattern
 * admits; and a bigint beside 7n, a literal of its own type. A literal a pattern refuses joins it at the text of no
 * byte bound, which no table's key holds, so its union is read live, stored or not.
 */
export type Column =
	| { readonly kind: "natural"; readonly literal: 0n | -1n }
	| { readonly kind: "pattern"; readonly literal: "abc" }
	| { readonly kind: "bigint"; readonly literal: 7n }

/**
 * A case: the column, whether the literal's arm is the union's first or second, and whether the term arm reads its
 * rows beside a negation, as metis's Withdrawn reads an invalidation unreinstated.
 */
export interface Shape {
	readonly column: Column
	readonly literalFirst: boolean
	readonly negated: boolean
}

const columns: readonly [Column, ...Array<Column>] = [
	{ kind: "natural", literal: 0n },
	{ kind: "natural", literal: -1n },
	{ kind: "pattern", literal: "abc" },
	{ kind: "bigint", literal: 7n }
]

export const shapeGen: FiniteSpace<Shape> = finite((source) => ({
	column: source.draw(element(columns)),
	literalFirst: source.draw(element([false, true])),
	negated: source.draw(element([false, true]))
}))

/** The descriptor of the column the term arm reads: its relation's. */
const fieldOf = (column: Column) => {
	switch (column.kind) {
		case "natural":
			return natural
		case "pattern":
			return str.regex("^[a-z]{1,8}$")
		case "bigint":
			return int8
	}
}

/**
 * The installation of a schema whose derived relation W is the case's union: Change's rows at their `change` beside
 * Held's rows at the case's literal, Change's read where no Lifted row of the same key stands where the case negates;
 * every relation keyed by its child and a number, the child a unit the schema declares where `stored`, so W is unit-local
 * there, a key wider than its unit's, and
 * the installation stores it (analysis/derived/storage.ts), its upkeep restricting it to the units a transaction wrote
 * (analysis/theory/unit.ts storedUpkeep), and reads it live otherwise.
 */
export const installationOf = (
	shape: Shape,
	stored: boolean
): Result.Result<Installation, CompileError> => {
	const field = fieldOf(shape.column)
	const Change = relation("Change", { child: int8, number: int8, change: field }, [
		"child",
		"number",
		"change"
	])
	const Lifted = relation("Lifted", { child: int8, number: int8, change: field }, [
		"child",
		"number",
		"change"
	])
	const Held = relation("Held", { child: int8, number: int8 }, ["child", "number"])
	const Kid = unit("Kid", { child: int8 })
	const base = schema("Base", [Change, Lifted, Held], stored ? [Kid] : [])
	const literal = shape.column.literal
	const termArm = (r: RuleValue) => {
		const { child, number, change } = varsOver(Change, "c")
		const matched = r.match(Change, { child, number, change })
		return (shape.negated ? matched.where(r.not(Lifted, { child, number, change })) : matched).find(
			{ child, number, change }
		)
	}
	const literalArm = (r: RuleValue) => {
		const { child, number } = varsOver(Held, "h")
		return r.match(Held, { child, number }).find({ child, number, change: literal })
	}
	const [first, second] = shape.literalFirst ? [literalArm, termArm] : [termArm, literalArm]
	const union = queryOver(base).rule(first).rule(second)
	const top = schema.extend([base], "Top", [derivedBuilder("W", union, [])], [])
	return Result.flatMap(ownedInput(top), (owned) =>
		compileInstallation(owned, installOptions(owned))
	)
}
