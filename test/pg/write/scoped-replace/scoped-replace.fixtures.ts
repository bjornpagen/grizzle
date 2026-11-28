/** What the property of scoped-replace.test.ts reads: its schema, its box, and each case's run. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { rowsScannedAndPaired } from "#bench/harness/explain.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull,
	type OpenedDb
} from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { writeAuditViolations } from "#test/support/write-audit.ts"

/** A fact of a scope: its scope `s`, its key `a` within it, and its payload `c`. */
const R = relation("R", { s: int8, a: int8, c: int8 }, ["s", "a"])

/** R in the unit of its scope, mutable, so a put of it is a pair or an upsert and a deletion of it is served. */
const build = (name: string) => schema(name, [R], [unit("Scope", { s: int8 }), mutable(R)])

type Schema = ReturnType<typeof build>

/** A fact of R as the ChangeSet states it. */
interface Fact {
	readonly s: bigint
	readonly a: bigint
	readonly c: bigint
}

/** The scope a case replaces, and the background scopes beside it, numbered from 2 up. */
const scope = 1n

/**
 * A case: the replaced scope's stored facts, `held`, at keys 1 up, each of payload 0; and the background, how many other
 * scopes stand beside it at the first measure, each of one fact, multiplied by four at each later measure. The replace
 * puts the scope's first fact as stored, its second with another payload and a fact at a key the scope does not hold,
 * and deletes the scope's every other fact.
 */
export interface ReplaceCase {
	readonly held: 2 | 8
	readonly background: 256 | 1024
}

export const replaceGen: Gen<ReplaceCase> = (s) => ({
	held: s.draw(element([2, 8] as const)),
	background: s.draw(element([256, 1024] as const))
})

export type ReplaceFeature = `${ReplaceCase["held"]} facts replaced`

/** The facts put: the scope's first fact as stored, its second changed, and one at a key past every stored one. */
const putFacts = (held: number): ReadonlyArray<Fact> => [
	{ s: scope, a: 1n, c: 0n },
	{ s: scope, a: 2n, c: 5n },
	{ s: scope, a: BigInt(held + 1), c: 0n }
]

/** The facts of a relation parameter `rows`, put as they are. */
const fromRows = (s: Schema) =>
	query(s).rule((r) => {
		const { s: at, a, c } = v(R, "row")
		return r.match(r.relation("rows", R), { s: at, a, c }).find({ s: at, a, c })
	})

/** Every stored fact of R in the scope `$scope` whose key the relation parameter `rows` lacks. */
const outsideRows = (s: Schema) =>
	query(s).rule((r) => {
		const { s: at, a, c } = v(R, "stored")
		return r
			.match(R, { s: at, a, c })
			.where(r.eq(at, r.param("scope", int8)))
			.where(r.not(r.relation("rows", R), { s: at, a }))
			.find({ s: at, a, c })
	})

/** The scoped replace: the put of `rows` beside the deletion of the scope's facts `rows` lacks, bound to the case. */
const replaceOf = (s: Schema, held: number) =>
	ChangeSet.empty(s)
		.put(R, fromRows(s))
		.delete(R, outsideRows(s))
		.bind({ rows: putFacts(held), scope })

/** The background scopes `from` to `to`, each of one fact. */
const backgroundOf = (s: Schema, from: number, to: number) =>
	ChangeSet.empty(s).insert(
		R,
		Arr.map(indices(to - from + 1), (i): Fact => ({ s: BigInt(from + i), a: 1n, c: 0n }))
	)

/** A ChangeSet applied, accepted. */
const applied = (db: OpenedDb, changes: unknown, what: string) =>
	Effect.gen(function* () {
		const observed = yield* observedChange(db, changes, attemptLabel, { kind: "none" })
		const outcome = yield* observed.apply({})
		assert.equal(outcome.value.kind, "accepted", `${what} is accepted`)
	})

/** The rows the replace's statements read and pair, each explained with ANALYZE in its place, rolled back. */
const replaceWork = (db: OpenedDb, s: Schema, held: number) =>
	Effect.map(explainedChange(db, replaceOf(s, held), {}), (plans) =>
		Arr.reduce(plans, 0, (sum, p) => sum + rowsScannedAndPaired(p.plan))
	)

/**
 * One case on a fresh installation: the replaced scope's facts and `background` other scopes stored, the replace's work
 * measured; the background multiplied by four and measured again, and again; each measure the same rows read and paired,
 * however many rows R holds beside the scope, at 1 + `held` + `background`, four times it and sixteen times it. Then the
 * replace applied, every statement of it through the structural audit, and the scope holding exactly the facts put,
 * every other scope as it stood.
 */
export const runReplace = (d: ReplaceCase, noteReached: (f: ReplaceFeature) => void) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("ScopedReplace"), "scopedreplace", {
				programs: {},
				logins: () => []
			})
			const S: Schema = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			yield* applied(
				db,
				ChangeSet.empty(S).insert(
					R,
					Arr.map(indices(d.held), (i): Fact => ({ s: scope, a: BigInt(i + 1), c: 0n }))
				),
				"the scope's facts"
			)
			const sizes = [d.background, 4 * d.background, 16 * d.background] as const
			const work: Array<{ readonly size: number; readonly rows: number }> = []
			let stood = 0
			for (const size of sizes) {
				yield* applied(db, backgroundOf(S, stood + 2, size + 1), `${size} background scopes`)
				stood = size
				const rows = yield* replaceWork(db, S, d.held)
				work.push({ size, rows })
			}
			const [first, ...later] = work
			if (first === undefined) {
				return assert.fail("a measure at the first size")
			}
			for (const w of later) {
				assert.equal(
					w.rows,
					first.rows,
					`replacing ${d.held} facts reads and pairs ${String(first.rows)} rows beside ${first.size} other scopes and ${String(w.rows)} beside ${w.size}: the scope's rows and the input's, whatever R holds beside them`
				)
			}
			const replace = replaceOf(S, d.held)
			const violations = yield* writeAuditViolations(db, replace)
			assert.deepEqual(violations, [], "every statement of the replace passes the structural audit")
			yield* applied(db, replace, "the replace")
			const substrate = yield* Substrate
			const rows = yield* substrate.admin.queryValues(
				`SELECT s::text, a::text, c::text FROM ${fx.table("R")} WHERE s = 1 ORDER BY a`,
				[]
			)
			assert.deepEqual(
				rows,
				Arr.map(putFacts(d.held), (f) => [String(f.s), String(f.a), String(f.c)]),
				"the scope holds exactly the facts put"
			)
			noteReached(`${d.held} facts replaced`)
		})
	)
