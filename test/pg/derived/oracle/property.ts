import type { Case } from "@grizzle/testing/explore"
import { multiset } from "@grizzle/testing/oracle"
import { Array as Arr, Effect, Option, Record, Schema } from "effect"
import type { DbContext } from "#adapter/db/context.ts"
import {
	type ApplyError,
	type OpenError,
	type ReadError,
	ReadFailure
} from "#adapter/errors/execution.ts"
import { refreshReport } from "#adapter/refresh/index.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type AggregateKey,
	buildSchema,
	type CaseSketch,
	changedFacts,
	downwardClosed,
	type FactsByRelation,
	type GenSchema,
	initialFacts,
	namedIn,
	restoredDerivedFacts
} from "#test/pg/derived/oracle/gen.ts"

import {
	installDerived,
	type Opened,
	OracleFixtureFailed,
	openCaseDb,
	readAll,
	readOf,
	reload,
	snapshotOf
} from "#test/pg/derived/oracle/harness.ts"
import { assert, failureOf, unorderedEqual } from "#test/support/assert.ts"
import { exactValue, identicalValue } from "#test/support/equivalence.ts"
import { CurrentRestorage } from "#test/support/oracle/gen/restorage.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

/** What a case reached, so the population shows it exercised each construct: each definition form, a second and a
 * third level, a negation, each aggregate over each kind it takes, both kinds of refresh statement, a view holding
 * rows, a call whose unchanged definitions wrote nothing after no base change and after a change elsewhere, a call
 * publishing several views in one commit, a read of an unpopulated view, both reloads of the same facts, a base
 * change, and a second reading over a value respelled.
 *
 * The generated refresh oracle's property.
 *
 * For each generated case the oracle installs the schema with its base facts, opens a Db as the refresher,
 * and runs a sequence of db.refresh calls, each after a base change, after no change, or after the same facts are
 * reloaded (in their order or reversed), checking after every call:
 *
 * - the call refreshed exactly the relations it named, once each, in level order and then declared order, whatever
 *   order it named them in and however often; a view not populated before the call took a plain
 *   REFRESH MATERIALIZED VIEW and every other one CONCURRENTLY;
 * - every named view equals its definition evaluated by the conservative lowering on one snapshot after the commit,
 *   as raw text multisets, so a duplicate row would show; a level-n view is compared with its
 *   definition over the lower views as they are stored, which the same call refreshed when it named them;
 * - a view the call did not name keeps every tuple: separate calls are separate transactions;
 * - every row the call wrote, across all the views it named, carries one xmin: one call publishes in one commit;
 * - a call after no base change wrote nothing, even when every base row was rewritten with the same facts, in the
 *   same or another physical order: the case's values have one spelling and its doubles
 *   are exact, so no aggregate here depends on the order PostgreSQL meets its inputs in; allowance.`covers`
 *   the exceptions;
 * - before a view's first refresh a read of it through the Db is ReadError, and after it the Db reads
 *   exactly the rows the view stores.
 *
 * Each case ends with a call naming every derived relation, after which every view equals its definition, and then a
 * second reading by the twin-spelling and plan relations: the facts reloaded with one value in its next spelling, in
 * the order they are stored (gen.ts restoredDerivedFacts: the oracle reads every view's tuples, which that order
 * decides), every view refreshed under the complement of the case's plan, every check above holding, and the Db
 * reading every view exactly as it read it before, value for value. */
export type DerivedFeature =
	| `form ${GenSchema["derived"][number]["form"]}`
	| "level 2"
	| "level 3"
	| "negation"
	| AggregateKey
	| "plain statements"
	| "concurrent statements"
	| "nonempty views"
	| "no-change checks"
	| "unaffected-view checks"
	| "multi-view commits"
	| "unpopulated reads"
	| "identical reloads"
	| "reordered reloads"
	| "base changes"
	| "a fact respelled on a second reading"

const reversed = (facts: FactsByRelation): FactsByRelation =>
	Record.fromEntries(Arr.map(Record.toEntries(facts), ([r, fs]) => [r, Arr.reverse([...fs])]))

interface Call {
	readonly label: string
	readonly named: ReadonlyArray<string>
	/** Whether the base facts are what they were at the previous call. */
	readonly unchanged: boolean
}

/** One db.refresh call and every check of it. */
const checkCall = (
	g: GenSchema,
	o: Opened,
	ctx: DbContext,
	populated: Set<string>,
	call: Call,
	c: Case<DerivedFeature>
) =>
	Effect.gen(function* () {
		const before = yield* snapshotOf(o, [...populated], [])
		const values = new Map(Arr.map(g.derived, (d) => [d.name, d.value]))
		const named = Arr.map(call.named, (n) => values.get(n))
		const report = Arr.isReadonlyArrayNonEmpty(named)
			? yield* refreshReport(ctx, named)
			: { statements: [] }
		const expected = Arr.filter(g.refreshOrder, (n) => call.named.includes(n))
		assert.deepEqual(
			Arr.map(report.statements, (s) => [s.relation, s.concurrently]),
			Arr.map(expected, (n) => [n, populated.has(n)]),
			`${call.label}: one statement per named relation, in level then declared order, plain before the first population`
		)
		for (const s of report.statements) {
			c.note(s.concurrently ? "concurrent statements" : "plain statements")
		}
		const wasPopulated = new Set(populated)
		for (const n of expected) {
			populated.add(n)
		}
		const after = yield* snapshotOf(o, [...populated], expected)
		const written = new Set<string>()
		for (const relation of populated) {
			const now = readOf(after.stored, relation)
			/** A view the call populates held no tuple before it. */
			const thenRows = wasPopulated.has(relation) ? readOf(before.stored, relation) : []
			const tupleOf = (r: (typeof now)[number]): string => `${r.text} @ ${r.tuple}`
			const then = new Set(Arr.map(thenRows, tupleOf))
			if (!expected.includes(relation)) {
				unorderedEqual(
					Arr.map(now, tupleOf),
					Arr.map(thenRows, tupleOf),
					`${call.label}: ${relation}, not named, keeps every tuple`
				)
				continue
			}
			const defined = readOf(after.defined, relation)
			const stored: ReadonlyArray<string> = Arr.map(now, (r) => r.text)
			assert.deepEqual(
				stored,
				defined,
				`${call.label}: ${relation} equals its definition evaluated by the conservative lowering on the same snapshot`
			)
			if (defined.length > 0) {
				c.note("nonempty views")
			}
			const fresh = Arr.filter(now, (r) => !then.has(`${r.text} @ ${r.tuple}`))
			for (const r of fresh) {
				written.add(r.xmin)
			}
			/** A view that already held its definition's result has no row to change: whether the base is untouched,
			 * rewritten with the same facts, or changed where this definition does not look. */
			const held = Arr.map(thenRows, (r) => r.text)
			if (
				wasPopulated.has(relation) &&
				held.length === defined.length &&
				Arr.every(held, (text, i) => text === defined[i])
			) {
				assert.equal(
					fresh.length,
					0,
					`${call.label}: ${relation}, whose definition did not change, is not written`
				)
				c.note(call.unchanged ? "no-change checks" : "unaffected-view checks")
			}
		}
		assert.ok(
			written.size <= 1,
			`${call.label}: every row the call wrote carries one xmin, one commit; saw ${Arr.join([...written], ", ")}`
		)
		if (expected.length > 1 && written.size === 1) {
			c.note("multi-view commits")
		}
	})

/** The whole case.
 *
 * Finally every view is brought to its definition in one call. */
export const derivedCase = (
	sketch: CaseSketch,
	c: Case<DerivedFeature>
): Effect.Effect<
	void,
	| OracleFixtureFailed
	| CompileError
	| SqlError
	| TransactionRolledBack
	| OpenError
	| ApplyError
	| ReadError,
	Substrate
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const declared = buildSchema(sketch, { name: "Gen" })
			let facts = initialFacts(declared, sketch)
			const o = yield* installDerived(declared.value, facts, "doracle", [declared.server])
			const g = buildSchema(sketch, { name: o.installed.declared })
			const { db, ctx, again } = yield* openCaseDb(o, g.refresher)
			const order = g.refreshOrder
			const byName = new Map(Arr.map(g.derived, (d) => [d.name, d]))
			for (const d of g.derived) {
				c.note(`form ${d.form}`)
				if (d.level === 2 || d.level === 3) {
					c.note(`level ${d.level}`)
				}
				if (d.negation) {
					c.note("negation")
				}
				c.noteAll(d.aggregates)
			}
			const read = (name: string) => {
				const d = byName.get(name)
				if (d === undefined) {
					return Effect.die(OracleFixtureFailed.make({ message: `no derived relation ${name}` }))
				}
				return readAll(
					db,
					g.value,
					d.value,
					Arr.map(d.columns, (column) => column.name)
				)
			}
			/** Before the first refresh PostgreSQL refuses to read the view. */
			const [lowest] = order
			assert.ok(lowest !== undefined, "the case declares a derived relation")
			const early = yield* failureOf(read(lowest))
			assert.ok(
				Schema.is(ReadFailure)(early),
				`a read before the first refresh is ReadFailure, not ${String(early)}`
			)
			const populated = new Set<string>()
			/** The first call names a downward-closed subset, so no named definition reads an unpopulated view. */
			const firstNamed = downwardClosed(g, namedIn(order, sketch.first, sketch.first, false))
			yield* checkCall(
				g,
				o,
				ctx,
				populated,
				{ label: "call 0", named: firstNamed, unchanged: false },
				c
			)
			for (const name of order) {
				if (populated.has(name)) {
					const rows = yield* read(name)
					const stored = readOf((yield* snapshotOf(o, [name], [])).stored, name)
					assert.equal(rows.length, stored.length, `the Db reads every row ${name} stores`)
				} else {
					const refused = yield* failureOf(read(name))
					assert.ok(Schema.is(ReadFailure)(refused), `${name}, still unpopulated, is ReadFailure`)
					c.note("unpopulated reads")
				}
			}
			for (const [i, step] of sketch.steps.entries()) {
				const change = step.change % 5
				let unchanged = true
				if (change <= 1) {
					const next = changedFacts(g, facts, step)
					unchanged = Option.isNone(exactValue(next, facts))
					facts = next
					yield* reload(o, facts)
					c.note("base changes")
				} else if (change === 3) {
					yield* reload(o, facts)
					c.note("identical reloads")
				} else if (change === 4) {
					yield* reload(o, reversed(facts))
					c.note("reordered reloads")
				}
				/** The named relations and the unpopulated views they read, directly or not. */
				const named = namedIn(order, step.names, step.shuffle, step.repeat)
				const needed = Arr.filter(downwardClosed(g, named), (n) => !populated.has(n))
				const label = `call ${i + 1} (${["change", "change", "no change", "identical reload", "reordered reload"][change]})`
				yield* checkCall(
					g,
					o,
					ctx,
					populated,
					{ label, named: [...named, ...needed], unchanged },
					c
				)
			}
			yield* checkCall(
				g,
				o,
				ctx,
				populated,
				{ label: "final call", named: order, unchanged: false },
				c
			)
			const readEvery = Effect.forEach(order, (name) =>
				Effect.map(read(name), (rows) => [name, rows] as const)
			)
			const first = new Map(yield* readEvery)
			const restored = restoredDerivedFacts(g, facts, yield* CurrentRestorage)
			if (restored.respelled) {
				c.note("a fact respelled on a second reading")
			}
			yield* reload(o, restored.facts)
			yield* checkCall(
				g,
				o,
				again,
				populated,
				{ label: "the second reading", named: order, unchanged: true },
				c
			)
			const second = new Map(yield* readEvery)
			for (const name of order) {
				const difference = multiset(identicalValue)(readOf(second, name), readOf(first, name))
				if (Option.isSome(difference)) {
					return assert.fail(
						`the second reading: ${name}, refreshed over its facts with one value respelled under the complement plan, reads otherwise: ${difference.value}`
					)
				}
			}
		})
	)
