/**
 * A retirable unit as `grizzle migrate` installs it on PostgreSQL 19rc2, written as a direct writer and its two
 * functions (physical/ddl/retire.ts) would write it: Root, the header, with its retirement field; Step and Claim, its
 * bodies, grouped by root; and Claim's step contained in Step, carrying the group.
 *
 * - **A second implementation as the oracle:** the unit's lifecycle as a model: each group absent, open or retired, and
 *   the rows of each body in it. A header inserted is open; a body row commits only in an open group (the fence,
 *   23503 otherwise) at a key no row holds (23505 otherwise); a hold commits only when every group it states is open,
 *   and otherwise refuses on the fence of the unit's first body (23000, raised by the refusal function); a retirement
 *   commits always, retiring each open group it states and deleting every body row in it, and leaves an absent or a
 *   retired group as it was. After every transaction the three tables hold exactly the model's rows.
 *
 * The space: groups, steps and attempts 0 and 1, and up to eight transactions of one operation each, run in order as
 * the installation's owner.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { agree, exact } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import { pg, retirement } from "#compiler/public/fields.ts"
import { contained, on, relation, retirable, schema } from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Root = relation("Root", { id: pg.int4, retired: retirement }, ["id"])
const Step = relation("Step", { root: pg.int4, step: pg.int4 }, ["root", "step"])
const Claim = relation("Claim", { root: pg.int4, step: pg.int4, attempt: pg.int4 }, [
	"root",
	"step",
	"attempt"
])

const Units = schema(
	"retire_life",
	[Root, Step, Claim],
	[
		retirable(Root, [on(Step, "root"), on(Claim, "root")]),
		contained(on(Claim, "root", "step"), on(Step, "root", "step"))
	]
)

const RELATIONS = ["Root", "Step", "Claim"] as const

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** One transaction of the run: one row inserted, or one function called with the groups it states. */
type Op =
	| { readonly kind: "header"; readonly group: number }
	| { readonly kind: "step"; readonly group: number; readonly step: number }
	| {
			readonly kind: "claim"
			readonly group: number
			readonly step: number
			readonly attempt: number
	  }
	| { readonly kind: "hold" | "retire"; readonly groups: Arr.NonEmptyReadonlyArray<number> }

const bits = [0, 1] as const
const groupSets: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<number>> = [[0], [1], [0, 1]]

const opGen: Gen<Op> = (source) => {
	const kind = source.draw(element<Op["kind"]>(["header", "step", "claim", "hold", "retire"]))
	switch (kind) {
		case "header":
			return { kind, group: source.draw(element(bits)) }
		case "step":
			return { kind, group: source.draw(element(bits)), step: source.draw(element(bits)) }
		case "claim":
			return {
				kind,
				group: source.draw(element(bits)),
				step: source.draw(element(bits)),
				attempt: source.draw(element(bits))
			}
		case "hold":
		case "retire":
			return { kind, groups: source.draw(element(groupSets)) }
	}
}

const runGen: Gen<ReadonlyArray<Op>> = array(opGen, { min: 1, max: 8 })

/** The lifecycle's state: each group's header, and the rows of each body. */
interface Model {
	readonly headers: ReadonlyMap<number, "open" | "retired">
	readonly steps: ReadonlySet<string>
	readonly claims: ReadonlySet<string>
}

const empty: Model = { headers: new Map(), steps: new Set(), claims: new Set() }

/** What the model says one transaction comes to: committed with the state it leaves, or refused with this SQLSTATE. */
type Predicted =
	| { readonly kind: "committed"; readonly next: Model; readonly feature: LifeFeature }
	| { readonly kind: "refused"; readonly code: string; readonly feature: LifeFeature }

type LifeFeature =
	| "a header inserted"
	| "a header refused at its key"
	| "a body row inserted"
	| "a body row refused at its key"
	| "a body row refused in a retired group"
	| "a body row refused in an absent group"
	| "a claim refused with no step"
	| "a hold of open groups"
	| "a hold refused for a retired group"
	| "a hold refused for an absent group"
	| "a retirement of an open group"
	| "a retirement that changes nothing"

const stepKey = (g: number, s: number): string => `${g},${s}`
const claimKey = (g: number, s: number, a: number): string => `${g},${s},${a}`

/** A body row's verdict in the group `g`: refused by the fence unless the group is open. */
const fenced = (m: Model, g: number): Predicted | undefined => {
	const header = m.headers.get(g)
	return header === "open"
		? undefined
		: {
				kind: "refused",
				code: "23503",
				feature:
					header === "retired"
						? "a body row refused in a retired group"
						: "a body row refused in an absent group"
			}
}

const predict = (m: Model, op: Op): Predicted => {
	switch (op.kind) {
		case "header":
			return m.headers.has(op.group)
				? { kind: "refused", code: "23505", feature: "a header refused at its key" }
				: {
						kind: "committed",
						next: { ...m, headers: new Map([...m.headers, [op.group, "open"]]) },
						feature: "a header inserted"
					}
		case "step": {
			const key = stepKey(op.group, op.step)
			if (m.steps.has(key)) {
				return { kind: "refused", code: "23505", feature: "a body row refused at its key" }
			}
			return (
				fenced(m, op.group) ?? {
					kind: "committed",
					next: { ...m, steps: new Set([...m.steps, key]) },
					feature: "a body row inserted"
				}
			)
		}
		case "claim": {
			const key = claimKey(op.group, op.step, op.attempt)
			if (m.claims.has(key)) {
				return { kind: "refused", code: "23505", feature: "a body row refused at its key" }
			}
			const fence = fenced(m, op.group)
			if (fence !== undefined) {
				return fence
			}
			return m.steps.has(stepKey(op.group, op.step))
				? {
						kind: "committed",
						next: { ...m, claims: new Set([...m.claims, key]) },
						feature: "a body row inserted"
					}
				: { kind: "refused", code: "23503", feature: "a claim refused with no step" }
		}
		case "hold": {
			const closed = Arr.findFirst(op.groups, (g) => m.headers.get(g) !== "open")
			if (Option.isSome(closed)) {
				return {
					kind: "refused",
					code: "23000",
					feature:
						m.headers.get(closed.value) === "retired"
							? "a hold refused for a retired group"
							: "a hold refused for an absent group"
				}
			}
			return { kind: "committed", next: m, feature: "a hold of open groups" }
		}
		case "retire": {
			const retiring = Arr.filter(op.groups, (g) => m.headers.get(g) === "open")
			const inRetired = (key: string): boolean =>
				Arr.some(retiring, (g) => Str.startsWith(`${g},`)(key))
			return {
				kind: "committed",
				next: {
					headers: new Map(
						Arr.map(
							[...m.headers],
							([g, h]) => [g, Arr.contains(retiring, g) ? "retired" : h] as const
						)
					),
					steps: new Set(Arr.filter([...m.steps], (k) => !inRetired(k))),
					claims: new Set(Arr.filter([...m.claims], (k) => !inRetired(k)))
				},
				feature:
					retiring.length > 0
						? "a retirement of an open group"
						: "a retirement that changes nothing"
			}
		}
	}
}

/** The rows a model holds, as the three tables' readings spell them. */
const modelRows = (m: Model): ReadonlyArray<ReadonlyArray<string>> => [
	Arr.sort(
		Arr.map([...m.headers], ([g, h]) => `${g},${h === "retired" ? "true" : "false"}`),
		Str.Order
	),
	Arr.sort([...m.steps], Str.Order),
	Arr.sort([...m.claims], Str.Order)
]

layer(Substrate.layer)("a retirable unit installed on PostgreSQL 19rc2", (it) => {
	it.effect(
		"admits rows only into open groups, holds only open groups, and retires a group whole, keeping its header for good",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seat = yield* seatOf(Units, RELATIONS, "retire_life")
					const unitFunction = (named: Identity<"hold" | "retire">) =>
						printObjectName({
							schema: seat.installed.names.relation("Root").schema,
							name: identifierOf(named)
						})
					const col = (r: string, f: string) => seat.column(r, f)
					const groupsArray = (groups: ReadonlyArray<number>) =>
						`ARRAY[${Arr.join(Arr.map(groups, String), ", ")}]::int4[]`
					const sqlOf = (op: Op): string => {
						switch (op.kind) {
							case "header":
								return `INSERT INTO ${seat.table("Root")} (${col("Root", "id")}) VALUES (${op.group})`
							case "step":
								return `INSERT INTO ${seat.table("Step")} (${col("Step", "root")}, ${col("Step", "step")}) VALUES (${op.group}, ${op.step})`
							case "claim":
								return `INSERT INTO ${seat.table("Claim")} (${col("Claim", "root")}, ${col("Claim", "step")}, ${col("Claim", "attempt")}) VALUES (${op.group}, ${op.step}, ${op.attempt})`
							case "hold":
								return `SELECT ${unitFunction(identity.hold("Root"))}(${groupsArray(op.groups)})`
							case "retire":
								return `SELECT ${unitFunction(identity.retire("Root"))}(${groupsArray(op.groups)})`
						}
					}
					const readRows = Effect.gen(function* () {
						const rows = (sql: string) =>
							Effect.map(seat.session.values(sql, []), (rs) =>
								Arr.map(rs, (r) => Arr.join(Arr.map(r, String), ","))
							)
						return [
							yield* rows(
								`SELECT ${col("Root", "id")}, ${col("Root", "retired")} FROM ${seat.table("Root")} ORDER BY 1`
							),
							yield* rows(
								`SELECT ${col("Step", "root")}, ${col("Step", "step")} FROM ${seat.table("Step")} ORDER BY 1, 2`
							),
							yield* rows(
								`SELECT ${col("Claim", "root")}, ${col("Claim", "step")}, ${col("Claim", "attempt")} FROM ${seat.table("Claim")} ORDER BY 1, 2, 3`
							)
						]
					})
					return yield* explore(
						{
							suite: "laws/retirable",
							draw: drawn(runGen),
							literal: Formatter.format,
							coverage: required<LifeFeature>(
								[
									"a header inserted",
									"a header refused at its key",
									"a body row inserted",
									"a body row refused at its key",
									"a body row refused in a retired group",
									"a body row refused in an absent group",
									"a claim refused with no step",
									"a hold of open groups",
									"a hold refused for a retired group",
									"a hold refused for an absent group",
									"a retirement of an open group",
									"a retirement that changes nothing"
								],
								{ cases: 300, sense: notesOnly }
							),
							kept: [],
							runs: 150,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
							oracle: {
								kind: "second-implementation",
								name: "the unit's lifecycle as a model: each group absent, open or retired, and each body's rows in it"
							}
						},
						(run, c) =>
							Effect.gen(function* () {
								yield* cleared(seat, RELATIONS)
								let model = empty
								for (const [at, op] of run.entries()) {
									const predicted = predict(model, op)
									const real = yield* attempt(seat.session, [sqlOf(op)])
									const said = `transaction ${at} (${Formatter.format(op)}) of ${Formatter.format(run)}`
									if (predicted.kind === "committed") {
										if (real.kind !== "committed") {
											return yield* new Disagreed({
												message: `${said} was refused by ${refusalText(real.fields)}; the model commits it`
											})
										}
										model = predicted.next
									} else if (real.kind === "committed" || real.fields.code !== predicted.code) {
										return yield* new Disagreed({
											message: `${said} ${real.kind === "committed" ? "committed" : `was refused by ${refusalText(real.fields)}`}; the model refuses it with ${predicted.code}`
										})
									}
									c.note(predicted.feature)
									const rows = yield* readRows
									yield* agree(
										[
											[`the tables after ${said}`, rows],
											["the model", modelRows(model)]
										],
										exact
									)
								}
							})
					)
				})
			)
	)
})
