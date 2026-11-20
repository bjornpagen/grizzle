/** What immutable-update.test.ts reads: its space over rule-whole.fixtures.ts's whole judges, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Data, Effect, Formatter, Option } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import {
	type ShapeKey,
	shapeKeys,
	statementsOf,
	tablesOf
} from "#test/pg/laws/rule-whole.fixtures.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * A field of a stored document's row an UPDATE sets: a node's kind or parent, the two fields beside its key, its start
 * or its doc, two fields of its key, or an expression's type. Every one is a field the caller writes, which no write of
 * grizzle's changes in place: Node and Expr are immutable and no family's.
 */
const targets = ["node kind", "node parent", "node start", "node doc", "expr type"] as const
type Target = (typeof targets)[number]

const starts = [0, 1, 2] as const
type Start = (typeof starts)[number]
const values = [0, 1, 2] as const
type Value = (typeof values)[number]
const types = [0, 1] as const
type Type = (typeof types)[number]

/**
 * A case: the shape of the whole judge it runs on, the type of its document's expressions, and the UPDATE the table's
 * owner runs over the stored document, of `target` at the row at start `at`, to `value`.
 */
export interface Rewrite {
	readonly shape: ShapeKey
	readonly type: Type
	readonly target: Target
	readonly at: Start
	readonly value: Value
}

export const rewriteGen: Gen<Rewrite> = (s) => ({
	shape: s.draw(element(shapeKeys)),
	type: s.draw(element(types)),
	target: s.draw(element(targets)),
	at: s.draw(element(starts)),
	value: s.draw(element(values))
})

export type RewriteFeature =
	| "an UPDATE of a field beside the key refused"
	| "an UPDATE of a key field refused"
	| "an UPDATE of an expression refused"
	| "an UPDATE that changes no row runs"

/**
 * The value the row at start `at` of document 1, written whole (rule-whole.fixtures.ts statementsOf `unit`), holds at
 * `target`: its nodes at starts 0, 1 and 2 of kinds 2, 1 and 0, each its parent 0, and its expressions of the
 * document's type but the one at start 1, of type 1.
 */
const stored = (r: Rewrite): number => {
	switch (r.target) {
		case "node kind":
			return 2 - r.at
		case "node parent":
			return 0
		case "node start":
			return r.at
		case "node doc":
			return 1
		case "expr type":
			return r.at === 1 ? 1 : r.type
	}
}

/** The relation and the column each target is of. */
const updated = {
	"node kind": { relation: "Node", column: "kind" },
	"node parent": { relation: "Node", column: "parent" },
	"node start": { relation: "Node", column: "start" },
	"node doc": { relation: "Node", column: "doc" },
	"expr type": { relation: "Expr", column: "type" }
} as const satisfies {
	readonly [T in Target]: { readonly relation: "Node" | "Expr"; readonly column: string }
}

/** What a refused UPDATE shows of its target. */
const shown = {
	"node kind": "an UPDATE of a field beside the key refused",
	"node parent": "an UPDATE of a field beside the key refused",
	"node start": "an UPDATE of a key field refused",
	"node doc": "an UPDATE of a key field refused",
	"expr type": "an UPDATE of an expression refused"
} as const satisfies { readonly [T in Target]: RewriteFeature }

class Unguarded extends Data.TaggedError("Unguarded")<{ readonly message: string }> {}

/**
 * Stores document 1 whole as the owner, then runs the case's UPDATE as the owner in a transaction of its own: refused
 * with insufficient_privilege naming the updated table where it changes the row, and run where it sets the value the row
 * holds; either way every stored row is as it was.
 */
export const runRewrite = (
	installed: Installed,
	session: RawSession,
	r: Rewrite,
	c: Case<RewriteFeature>
) =>
	Effect.gen(function* () {
		const tables = tablesOf(installed, r.shape)
		yield* session.begin
		for (const sql of statementsOf(tables, { kind: "unit", doc: 1, type: r.type })) {
			yield* session.query(sql, [])
		}
		yield* session.commit
		const rows = Effect.map(
			Effect.all([
				session.values(
					`SELECT doc, start, parent, kind FROM ${tables.node} ORDER BY doc, start`,
					[]
				),
				session.values(`SELECT doc, start, type FROM ${tables.expr} ORDER BY doc, start`, [])
			]),
			(found) => Formatter.format(found)
		)
		const before = yield* rows
		const { relation, column } = updated[r.target]
		const table = relation === "Expr" ? tables.expr : tables.node
		const update = `UPDATE ${table} SET ${column} = ${r.value} WHERE doc = 1 AND start = ${r.at}`
		yield* session.begin
		const refused = yield* refusalOf(session.query(update, []))
		yield* Option.isNone(refused) ? session.commit : session.rollback
		const changes = r.value !== stored(r)
		const where = `${update} over ${Formatter.format(r)}`
		const named = installed.installation.names.relation(relation).name
		if (!changes) {
			if (Option.isSome(refused)) {
				return yield* new Unguarded({
					message: `an UPDATE that changes no row was refused under ${refused.value.code}: ${refused.value.message}, ${where}`
				})
			}
			c.note("an UPDATE that changes no row runs")
		} else if (
			Option.isNone(refused) ||
			refused.value.code !== sqlstates.insufficientPrivilege ||
			!Option.contains(refused.value.table, named)
		) {
			return yield* new Unguarded({
				message: `the owner's UPDATE of an immutable relation's row ${Option.match(refused, {
					onNone: () => "committed",
					onSome: (e) =>
						`was refused under ${e.code} naming ${Option.getOrElse(e.table, () => "no table")}`
				})}, where it is refused under ${sqlstates.insufficientPrivilege} naming ${named}, ${where}`
			})
		} else {
			c.note(shown[r.target])
		}
		const after = yield* rows
		if (after !== before) {
			return yield* new Unguarded({
				message: `the stored rows changed from ${before} to ${after}, ${where}`
			})
		}
	})
