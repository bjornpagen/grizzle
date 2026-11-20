/** What the property of literal-heads.test.ts reads: its uses of a literal-headed column, and each one's installation. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import type { CompileError } from "#compiler/core/errors.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, login, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationsOf, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, roleBuilder as role } from "#compiler/schema/world.ts"
import { owning } from "#test/support/policy.ts"

/**
 * Where a column a rule's head fixes at a literal is read after navigation substitutes the literal for it: a selection
 * comparing it first with a literal, by `<` or `<>`; a selection equating it with a column of its own type; a join of
 * it to a stored relation's column; or a check over the derived relation comparing it first.
 */
export const uses = [
	"a selection by lt against a literal",
	"a selection by ne against a literal",
	"a selection by eq against a column",
	"a join to a stored relation",
	"a check comparing it first"
] as const
export type Use = (typeof uses)[number]

const label = str.bytes(64, str.regex("^.*$", "su"))

const Item = relation("Item", { id: pg.integer, kind: pg.integer }, ["id"])

const Doc = relation("Doc", { id: pg.integer, start: pg.bigint, label }, ["id"])

const Base = schema("LiteralHeads", [Item, Doc], [])

/** A query whose one rule fixes `scope` at the literal 0n and `variable` at the literal "numAttempts". */
const fixed = query(Base).rule((r) => {
	const { id, kind } = v(Item, "item")
	return r.match(Item, { id, kind }).find({ id, scope: 0n, kind, variable: "numAttempts" })
})

/** The derived relation over `fixed` and Doc that reads `fixed`'s literal-headed columns as `use` reads them. */
const readOf = (use: Use) =>
	derived(
		"Read",
		query(Base).rule((r) => {
			const { id, scope, kind, variable } = v(fixed, "fixed")
			const { start, label: text } = v(Doc, "doc")
			const read = r.match(fixed, { id, scope, kind, variable })
			const joined = use === "a join to a stored relation"
			const bound = joined
				? read.match(Doc, { id, start: scope, label: text })
				: read.match(Doc, { id, start, label: text })
			const selected = (() => {
				switch (use) {
					case "a selection by lt against a literal":
						return bound.where(r.lt(scope, 5n))
					case "a selection by ne against a literal":
						return bound.where(r.ne(scope, 3n))
					case "a selection by eq against a column":
						return bound.where(r.eq(variable, text))
					case "a join to a stored relation":
					case "a check comparing it first":
						return bound
				}
			})()
			return selected.find({ id, start: joined ? scope : start, scope })
		})
	)

/**
 * The installation of the schema over Base whose derived relation reads `fixed` as `use` does, with a containment and
 * a check over it, which a writer of Item and Doc probes, so navigation inlines `fixed` into every probe: compiled, or
 * the refusal it meets.
 */
export const installed = (use: Use): Result.Result<unknown, CompileError> => {
	const Read = readOf(use)
	const top = schema.extend(
		[Base],
		"LiteralHeadsTop",
		[Read],
		[
			contained(on(Read, "id"), on(Item, "id")),
			use === "a check comparing it first"
				? check("Small", Read, (x) => x.lt(x.scope, 5n))
				: check("Unseven", Read, (x) => x.ne(x.start, 7n))
		]
	)
	const desk = login(top, "desk", [
		role(top, "writer", { Item, Doc }, { write: ["Item", "Doc"], refresh: [] })
	])
	const owned = owning(desk.base)
	return Result.flatMap(
		ownLogin(defined(loginDescOf(desk), "a login built by login(...)")),
		(own) =>
			compileInstallation(
				owned,
				completeInstallOptions(
					owned,
					installationsOf(owned),
					[own],
					[],
					firstCodebook(rostersOf(owned))
				)
			)
	)
}
