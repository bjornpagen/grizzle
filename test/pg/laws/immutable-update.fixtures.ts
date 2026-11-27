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

/** The relations a DELETE removes a stored row of, and a TRUNCATE every row of: Node and Expr, both immutable. */
const deleted = ["Node", "Expr"] as const
type Deleted = (typeof deleted)[number]

/**
 * The write the table's owner runs over the stored document at the row at start `at`: an UPDATE of `target` to `value`,
 * a DELETE of the row of `of`, or a TRUNCATE of `of`, CASCADE, so no foreign key of another table refuses it before
 * its table's triggers fire.
 */
export type Write =
	| { readonly kind: "update"; readonly target: Target; readonly value: Value }
	| { readonly kind: "delete" | "truncate"; readonly of: Deleted }

/** A case: the shape of the whole judge it runs on, the row at start `at` of the stored document, and the write. */
export interface Rewrite {
	readonly shape: ShapeKey
	readonly at: Start
	readonly write: Write
}

const writeGen: Gen<Write> = (s) => {
	const kind = s.draw(element(["update", "delete", "truncate"] as const))
	return kind === "update"
		? { kind, target: s.draw(element(targets)), value: s.draw(element(values)) }
		: { kind, of: s.draw(element(deleted)) }
}

export const rewriteGen: Gen<Rewrite> = (s) => ({
	shape: s.draw(element(shapeKeys)),
	at: s.draw(element(starts)),
	write: s.draw(writeGen)
})

export type RewriteFeature =
	| "an UPDATE of a field beside the key refused"
	| "an UPDATE of a key field refused"
	| "an UPDATE of an expression refused"
	| "an UPDATE that changes no row runs"
	| "a DELETE of a node refused"
	| "a DELETE of an expression refused"
	| "a TRUNCATE of the nodes refused"
	| "a TRUNCATE of the expressions refused"

/**
 * The value the row at start `at` of document 1, written whole and lawful (rule-whole.fixtures.ts statementsOf `unit`
 * at type 1, which keeps every rule; at type 0 One type refuses it), holds at `target`: its nodes at starts 0, 1 and 2
 * of kinds 2, 1 and 0, each its parent 0, and its expressions each of type 1.
 */
const stored = (target: Target, at: Start): number => {
	switch (target) {
		case "node kind":
			return 2 - at
		case "node parent":
			return 0
		case "node start":
			return at
		case "node doc":
			return 1
		case "expr type":
			return 1
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

/** What a refused DELETE and a refused TRUNCATE show of their relation. */
const removed = {
	delete: { Node: "a DELETE of a node refused", Expr: "a DELETE of an expression refused" },
	truncate: {
		Node: "a TRUNCATE of the nodes refused",
		Expr: "a TRUNCATE of the expressions refused"
	}
} as const satisfies {
	readonly [K in "delete" | "truncate"]: { readonly [R in Deleted]: RewriteFeature }
}

/** What a refused UPDATE shows of its target. */
const shown = {
	"node kind": "an UPDATE of a field beside the key refused",
	"node parent": "an UPDATE of a field beside the key refused",
	"node start": "an UPDATE of a key field refused",
	"node doc": "an UPDATE of a key field refused",
	"expr type": "an UPDATE of an expression refused"
} as const satisfies { readonly [T in Target]: RewriteFeature }

/** The command each write runs. */
const commands = {
	update: "UPDATE",
	delete: "DELETE",
	truncate: "TRUNCATE"
} as const satisfies { readonly [K in Write["kind"]]: string }

/** The statement of the write `w` of `table`, an UPDATE or a DELETE at the row `at` selects. */
const statementOf = (w: Write, table: string, at: string): string => {
	switch (w.kind) {
		case "update":
			return `${commands[w.kind]} ${table} SET ${updated[w.target].column} = ${w.value} ${at}`
		case "delete":
			return `${commands[w.kind]} FROM ${table} ${at}`
		case "truncate":
			return `${commands[w.kind]} ${table} CASCADE`
	}
}

class Unguarded extends Data.TaggedError("Unguarded")<{ readonly message: string }> {}

/**
 * Stores document 1 whole as the owner, then runs the case's write as the owner in a transaction of its own: a DELETE
 * or a TRUNCATE refused with insufficient_privilege naming the table, a closed relation's facts never removed; an UPDATE
 * refused alike where it changes the row, and run where it sets the value the row holds; either way every stored row is
 * as it was.
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
		for (const sql of statementsOf(tables, { kind: "unit", doc: 1, type: 1 })) {
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
		const w = r.write
		const relation = w.kind === "update" ? updated[w.target].relation : w.of
		const table = relation === "Expr" ? tables.expr : tables.node
		const statement = statementOf(w, table, `WHERE doc = 1 AND start = ${r.at}`)
		yield* session.begin
		const refused = yield* refusalOf(session.query(statement, []))
		yield* Option.isNone(refused) ? session.commit : session.rollback
		const changes = w.kind !== "update" || w.value !== stored(w.target, r.at)
		const where = `${statement} over ${Formatter.format(r)}`
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
				message: `the owner's ${commands[w.kind]} of an immutable relation's rows ${Option.match(
					refused,
					{
						onNone: () => "committed",
						onSome: (e) =>
							`was refused under ${e.code} naming ${Option.getOrElse(e.table, () => "no table")}`
					}
				)}, where it is refused under ${sqlstates.insufficientPrivilege} naming ${named}, ${where}`
			})
		} else {
			c.note(w.kind === "update" ? shown[w.target] : removed[w.kind][w.of])
		}
		const after = yield* rows
		if (after !== before) {
			return yield* new Unguarded({
				message: `the stored rows changed from ${before} to ${after}, ${where}`
			})
		}
	})
