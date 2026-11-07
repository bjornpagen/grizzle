import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { accumulated, closedId, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import {
	check,
	closed,
	counted,
	fin,
	fold,
	Monoid,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

const kinds = ["sum", "tuple"] as const
type KindHandle = (typeof kinds)[number]

/** Each kind's shape: the fewest and most parts a cell of it holds, and the least total of their weights. */
const shapes: Readonly<
	Record<KindHandle, { readonly min: bigint; readonly max: bigint; readonly floor: bigint }>
> = {
	sum: { min: 1n, max: 9n, floor: -1n },
	tuple: { min: 0n, max: 2n, floor: 0n }
}

const Kind = closed("Kind", kinds)
const Shape = closed.relation(
	"Shape",
	{ kind: closedId(Kind), min: pg.bigint, max: pg.bigint, floor: pg.bigint },
	["kind"],
	Arr.map(kinds, (kind) => ({ kind, ...shapes[kind] }))
)

/** A cell's caller field `a`, its kind, and its parts, each a weight: `n` counts them, `total` sums them. */
const Cell = relation(
	"Cell",
	{
		id: pg.integer,
		a: pg.integer,
		kind: closedId(Kind),
		n: drawnField(natural),
		total: accumulated(pg.bigint, 0n)
	},
	["id"]
)
const Part = relation("Part", { cell: pg.integer, at: pg.integer, w: pg.bigint }, ["cell", "at"])
const cellParts = counted(on(Part, "cell"), fin(Cell, "n"))
const cellTotal = fold(cellParts, Monoid.sum, on(Part, "cell", "w"), on(Cell, "id", "total"))

/** A cell as a case draws it: `a` from -1 to 1, its kind, and none to three parts, each weighing -2 to 2. */
interface Row {
	readonly a: number
	readonly kind: KindHandle
	readonly parts: ReadonlyArray<number>
}

/** The four rules, in the order this suite lists them: one over a caller field, one over the count through closed
 * reads, one over the fold's end through a closed read, and one over the count and the end. */
const rules = ["a", "arity", "floor", "balance"] as const
type Rule = (typeof rules)[number]

/** Whether `row`, as its write fills it, breaks `rule`: the rules restated over the drawn values, the oracle. */
const breaks = (rule: Rule, row: Row): boolean => {
	const n = BigInt(row.parts.length)
	const total = Arr.reduce(row.parts, 0n, (sum, w) => sum + BigInt(w))
	const shape = shapes[row.kind]
	switch (rule) {
		case "a":
			return row.a < 0
		case "arity":
			return n < shape.min || n > shape.max
		case "floor":
			return total < shape.floor
		case "balance":
			return n <= total
	}
}

/** Two namings of the rules whose CHECK names sort in opposite orders, so PostgreSQL tries the CHECKs in each. */
const namings = {
	forward: { a: "AlphaA", arity: "BetaArity", floor: "GammaFloor", balance: "DeltaBalance" },
	backward: { a: "ZetaA", arity: "YotaArity", floor: "XiFloor", balance: "OmegaBalance" }
} as const satisfies Readonly<Record<string, Readonly<Record<Rule, string>>>>

type Naming = keyof typeof namings

const namingNames: Arr.NonEmptyReadonlyArray<Naming> = ["forward", "backward"]

/** Cell's four rules, each a row CHECK declared under the name `naming` gives it, in the order of `rules`, then the
 * family of its parts and their fold. */
const cellsNamed = (label: string, naming: Naming) =>
	schema(label, { Kind, Shape, Cell, Part }, [
		check(namings[naming].a, Cell, (x) => x.ge(x.a, 0)),
		check(namings[naming].arity, Cell, (x) =>
			x.and(
				x.ge(Compute.base(x.n), Shape.at("min", x.kind)),
				x.le(Compute.base(x.n), Shape.at("max", x.kind))
			)
		),
		check(namings[naming].floor, Cell, (x) => x.ge(x.total, Shape.at("floor", x.kind))),
		check(namings[naming].balance, Cell, (x) => x.gt(Compute.base(x.n), x.total)),
		cellParts,
		cellTotal
	])

const rowGen: Gen<Row> = (source) => ({
	a: source.draw(int(-1, 1)),
	kind: source.draw(element(kinds)),
	parts: source.draw(array(int(-2, 2), { min: 0, max: 3 }))
})

type Feature =
	| `${1 | 2 | 3} rules broken`
	| "accepted"
	| "the namings try the CHECKs in other orders"
	| "a count rule broken beside another"
	| "an end rule broken beside another"
	| "a rule over the count and the end broken beside another"
	| "a count rule an empty family breaks held beside a broken rule"
	| "an empty family beside a broken rule"

/** The situation of a cell breaking `count` rules, one to three: no cell breaks both the floor and the balance, its
 * total below 0 for one and at least its count for the other. */
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
 * A refused CHECK names every law its row breaks, as the write fills the row, against PostgreSQL 19.
 *
 * Cell holds four rules, each a row CHECK: a ≥ 0 over a caller field; its count `n` of parts within its kind's
 * [min, max], read through the closed relation Shape; its fold's end `total`, the sum of its parts' weights, at least
 * its kind's floor, through Shape; and n > total, over the count and the end, which an empty family breaks. Both n and total are grizzle's to fill:
 * an empty family's are 0, and each part the ChangeSet inserts beside the cell changes them, so a rule over them holds
 * or breaks at the values the write fills, never at the empty family's. The rules are installed twice, under two
 * namings whose CHECK names sort in opposite orders, so PostgreSQL, which tries a table's CHECKs in the order of their
 * names and reports the first that fails, reports another first under each. Each case inserts one cell with none to
 * three parts in one ChangeSet, through both installations. The oracle is the rules restated over the drawn values,
 * the count the parts' number and the end their sum: a cell that breaks none is accepted; any other is refused naming
 * `every` law it breaks, exactly those, each once, its witness the cell's key, under both namings, whichever CHECK
 * PostgreSQL tried first. Each installation lists the laws it names in one order across every case: a law named before
 * another is never named after it.
 *
 * Its kept cases are a downstream tier's shape, an operator of two operands whose count its arity holds beside a
 * broken rule (qti-pie's p21-sum-as-condition, refused naming the arity too when the count was judged at the empty
 * family's), and a count too low and too high beside a broken rule, each with the arity CHECK tried first under one
 * naming and after under the other. Planted in a scratch copy, a witness judging the row at its slot's starts, and one
 * reading a filled count as unknown while still naming every law, each fail the search.
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
								const named = Arr.map(Arr.zip(rules, o.schema.statements), ([rule, statement]) => ({
									rule,
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
										name: "the four rules restated over the drawn values, the count the parts' number and the end their sum"
									},
									kept: [
										{
											note: "qti-pie's p21-sum-as-condition: an operator of two operands, which its arity admits, beside a rule it breaks, once refused naming the arity too, judged at the empty family's count",
											sketch: { a: -1, kind: "sum", parts: [1, 0] },
											draws: "",
											reaches: ["a count rule an empty family breaks held beside a broken rule"]
										},
										{
											note: "an operator of no operands, fewer than its arity's least, beside a rule it breaks: the arity named too",
											sketch: { a: -1, kind: "sum", parts: [] },
											draws: "",
											reaches: [
												"a count rule broken beside another",
												"an empty family beside a broken rule"
											]
										},
										{
											note: "a tuple of three parts, more than its arity's most, beside a rule it breaks, which forward tries before the arity: once refused naming only that rule, judged at the empty family's count",
											sketch: { a: -1, kind: "tuple", parts: [0, 0, 0] },
											draws: "",
											reaches: ["a count rule broken beside another"]
										},
										{
											note: "a tuple of three parts beside a rule it breaks, which backward tries after the arity: once refused naming the arity first and no witness, the arity held at the empty family's count",
											sketch: { a: -1, kind: "tuple", parts: [2, 0, -1] },
											draws: "",
											reaches: ["a count rule broken beside another"]
										}
									],
									runs: 100,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<Feature>(
										[
											"accepted",
											"1 rules broken",
											"2 rules broken",
											"3 rules broken",
											"the namings try the CHECKs in other orders",
											"a count rule broken beside another",
											"an end rule broken beside another",
											"a rule over the count and the end broken beside another",
											"a count rule an empty family breaks held beside a broken rule",
											"an empty family beside a broken rule"
										],
										{ cases: 100, sense: notesOnly }
									),
									caseHang
								},
								(row, c) =>
									Effect.gen(function* () {
										const broken = Arr.filter(rules, (rule) => breaks(rule, row))
										if (differ) {
											c.note("the namings try the CHECKs in other orders")
										}
										if (broken.length > 1) {
											c.noteAll([
												...(broken.includes("arity")
													? ["a count rule broken beside another" as const]
													: []),
												...(broken.includes("floor")
													? ["an end rule broken beside another" as const]
													: []),
												...(broken.includes("balance")
													? ["a rule over the count and the end broken beside another" as const]
													: [])
											])
										}
										if (Arr.isReadonlyArrayNonEmpty(broken)) {
											if (Arr.isReadonlyArrayEmpty(row.parts)) {
												c.note("an empty family beside a broken rule")
											}
											if (!broken.includes("arity") && breaks("arity", { ...row, parts: [] })) {
												c.note("a count rule an empty family breaks held beside a broken rule")
											}
										}
										for (const naming of namingNames) {
											const o = installations[naming]
											yield* replaceRows(s.admin, installationGroup(namesOf(o.installed)), [])
											const outcome = yield* Effect.gen(function* () {
												const db = yield* Db.open(o.server.roles.app, {})
												const applied = yield* Effect.result(
													db.apply(
														ChangeSet.empty(o.schema)
															.insert(Cell, [{ id: 1, a: row.a, kind: row.kind }])
															.insert(
																Part,
																Arr.map(row.parts, (w, at) => ({ cell: 1, at, w: BigInt(w) }))
															),
														{}
													)
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
