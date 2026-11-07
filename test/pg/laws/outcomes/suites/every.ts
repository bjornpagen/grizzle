import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { check, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A cell's three values, each from -1 to 1, so it breaks none to all three of the rules. */
interface Row {
	readonly a: number
	readonly b: number
	readonly c: number
}

const Cell = relation("Cell", { id: pg.integer, a: pg.integer, b: pg.integer, c: pg.integer }, [
	"id"
])

/** The three rules, in the order this suite lists them. */
const rules = ["a", "b", "sum"] as const
type Rule = (typeof rules)[number]

/** Whether `row` breaks `rule`: the rules restated over the drawn values, the oracle. */
const breaks = (rule: Rule, row: Row): boolean => {
	switch (rule) {
		case "a":
			return row.a < 0
		case "b":
			return row.b < 0
		case "sum":
			return row.a + row.b + row.c < 0
	}
}

/** Two namings of the rules whose CHECK names sort in opposite orders, so PostgreSQL tries the CHECKs in each. */
const namings = {
	forward: { a: "AlphaA", b: "BetaB", sum: "GammaSum" },
	backward: { a: "ZetaA", b: "YotaB", sum: "XiSum" }
} as const satisfies Readonly<Record<string, Readonly<Record<Rule, string>>>>

type Naming = keyof typeof namings

const namingNames: Arr.NonEmptyReadonlyArray<Naming> = ["forward", "backward"]

/** Cell's three rules, each a row CHECK declared under the name `naming` gives it. */
const cellsNamed = (label: string, naming: Naming) =>
	schema(label, { Cell }, [
		check(namings[naming].a, Cell, (x) => x.ge(x.a, 0)),
		check(namings[naming].b, Cell, (x) => x.ge(x.b, 0)),
		check(namings[naming].sum, Cell, (x) => x.ge(Compute.add(Compute.add(x.a, x.b), x.c), 0n))
	])

const rowGen: Gen<Row> = (source) => ({
	a: source.draw(int(-1, 1)),
	b: source.draw(int(-1, 1)),
	c: source.draw(int(-1, 1))
})

type Feature =
	| `${1 | 2 | 3} rules broken`
	| "accepted"
	| "the namings try the CHECKs in other orders"

/** The situation of a cell breaking `count` rules, one to three. */
const brokenFeature = (count: number): Feature =>
	count >= 3 ? "3 rules broken" : count === 2 ? "2 rules broken" : "1 rules broken"

/** The rule a law names under `naming`: the check carrying that rule's name there. */
const ruleOf = (naming: Naming, law: Law): Rule =>
	defined(
		law.kind === "check"
			? Option.getOrUndefined(Arr.findFirst(rules, (r) => namings[naming][r] === law.name))
			: undefined,
		`a check of Cell's rules, not ${Formatter.format(law)}`
	)

/**
 * A refused CHECK names every law its row breaks, against PostgreSQL 19.
 *
 * Cell holds three rules, each a row CHECK: a ≥ 0, b ≥ 0 and a + b + c ≥ 0, installed twice, under two namings whose
 * CHECK names sort in opposite orders, so PostgreSQL, which tries a table's CHECKs in the order of their names and
 * reports the first that fails, reports another first under each. Each case inserts one cell, its values drawn from
 * -1 to 1, through both installations. The oracle is the rules restated over the drawn values: a cell that breaks none
 * is accepted; any other is refused naming `every` law it breaks, exactly those, each once, its witness the cell's
 * key, under both namings, whichever CHECK PostgreSQL tried first. Each installation lists the laws it names in one
 * order across every case: a law named before another is never named after it.
 */
export const everyLawSuite = (): void => {
	layer(Substrate.layer)(
		"a refused CHECK names every law its row breaks, against PostgreSQL 19",
		(it) => {
			it.effect(
				"a cell breaking one to three rules is refused naming every rule it breaks, under any naming of its CHECKs",
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const s = yield* Substrate
							const forward = yield* installed(
								cellsNamed("Forward", "forward"),
								{},
								{
									label: "forward",
									extensions: []
								}
							)
							const backward = yield* installed(
								cellsNamed("Backward", "backward"),
								{},
								{
									label: "backward",
									extensions: []
								}
							)
							const installations = { forward, backward } as const
							/** An installation's rules in the order PostgreSQL tries their CHECKs: their installed names' order. */
							const tried = (naming: Naming): string => {
								const o = installations[naming]
								const names = namesOf(o.installed)
								const named = Arr.map(o.schema.statements, (statement, i) => ({
									rule: defined(rules[i], "a rule per statement"),
									constraint: names.constraintOf(names.lawOf(statement), "TableCheck")
								}))
								return Arr.join(
									Arr.map(
										Arr.sort(
											named,
											Order.mapInput(
												Order.String,
												(n: { readonly constraint: string }) => n.constraint
											)
										),
										(n) => n.rule
									),
									","
								)
							}
							const differ = tried("forward") !== tried("backward")
							/** Each installation's laws named before others, rule by rule, as cases observe them. */
							const before: Record<Naming, Map<Rule, Set<Rule>>> = {
								forward: new Map(),
								backward: new Map()
							}
							return yield* explore(
								{
									suite: "laws/witness/every",
									draw: drawn(rowGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "the three rules restated over the drawn values"
									},
									kept: [],
									runs: 60,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<Feature>(
										[
											"accepted",
											"1 rules broken",
											"2 rules broken",
											"3 rules broken",
											"the namings try the CHECKs in other orders"
										],
										{ cases: 60, sense: notesOnly }
									),
									caseHang
								},
								(row, c) =>
									Effect.gen(function* () {
										const broken = Arr.filter(rules, (rule) => breaks(rule, row))
										if (differ) {
											c.note("the namings try the CHECKs in other orders")
										}
										for (const naming of namingNames) {
											const o = installations[naming]
											yield* replaceRows(s.admin, installationGroup(namesOf(o.installed)), [])
											const outcome = yield* Effect.gen(function* () {
												const db = yield* Db.open(o.server.roles.app, {})
												const applied = yield* Effect.result(
													db.apply(ChangeSet.empty(o.schema).insert(Cell, [{ id: 1, ...row }]), {})
												)
												assert.ok(Result.isSuccess(applied), "the write is an outcome")
												return applied.success
											}).pipe(Effect.scoped, withLayer(o.layer))
											if (!Arr.isReadonlyArrayNonEmpty(broken)) {
												assert.equal(outcome.kind, "accepted")
												c.note("accepted")
												continue
											}
											if (outcome.kind !== "invariant-rejected") {
												return assert.fail(
													`a cell breaking ${Arr.join(broken, ", ")} is refused, not ${outcome.kind}`
												)
											}
											if (outcome.refused.kind !== "every") {
												return assert.fail("a stated cell's refusal names every law it breaks")
											}
											const named = Arr.map(outcome.refused.laws, (law) => ruleOf(naming, law))
											assert.deepEqual(
												Arr.filter(rules, (rule) => named.includes(rule)),
												broken,
												`${naming}: every rule the cell breaks`
											)
											assert.equal(named.length, broken.length, `${naming}: each rule once`)
											assert.deepEqual(outcome.witness, {
												kind: "key",
												relation: "Cell",
												values: { id: 1 }
											})
											const order = before[naming]
											for (const [i, x] of named.entries()) {
												for (const y of named.slice(i + 1)) {
													assert.ok(
														order.get(y)?.has(x) !== true,
														`${naming} names ${x} before ${y} here and after it in another case`
													)
													order.set(x, new Set([...(order.get(x) ?? []), y]))
												}
											}
											c.note(brokenFeature(broken.length))
										}
									})
							)
						}).pipe(Effect.scoped)
					)
			)
		}
	)
}
