import { layer } from "@effect/vitest"
import { type Case, drawn } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { refreshReport } from "#adapter/refresh/index.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { installDerived, type Opened, openCaseDb } from "#test/pg/derived/oracle/harness.ts"
import { assert } from "#test/support/assert.ts"
import { oracleCheck } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A derived relation narrows an exact sum into its field's type under a guard: the form the exactField refusal names.
 *
 * A sum over money is exact money, which no stored field holds (DerivedRefused, exactField), and an aggregate is a find
 * head's own column, never a Compute operand. So the definition sums each group's fees in an interior stage and narrows
 * the variable that matches the total into pg.money under Compute.when(Compute.within(total, least, greatest)), a
 * group whose total leaves money's range delivering zero. Each case installs Fee with generated fees, the extremes of
 * money's range among them, refreshes the derived relation, and checks that the stored view, its definition evaluated
 * by the conservative lowering and the host's exact sums agree, every amount compared by value.
 */

/** Money's range in minor units, a signed 64-bit integer. */
const least = -(2n ** 63n)
const greatest = 2n ** 63n - 1n

const Fee = relation("Fee", { id: pg.integer, grp: pg.integer, fee: pg.money }, ["id"])

/** The derived relation, its refresher and the login holding it, over a schema named `name`. */
const build = (name: string) => {
	const Base = schema(name, { Fee }, [])
	const narrowed = query(Base).rule((r) => {
		const totals = r.interior((s) => {
			const { id, grp, fee } = v(Fee, "fee")
			return s.match(Fee, { id, grp, fee }).find({ grp, total: s.sum(fee) })
		})
		const { grp, total } = v(totals, "totals")
		return r.match(totals, { grp, total }).find({
			grp,
			total: Compute.when(
				Compute.within(total, Money.of(least), Money.of(greatest)),
				(t) => Compute.cast(t, pg.money),
				Compute.literal(pg.money, Money.of(0n))
			)
		})
	})
	const Narrowed = derived.materialized("Narrowed", narrowed)
	const top = schema.extend(Base, `${name}_1`, { Narrowed }, [])
	const refresher = role(top, "refresher", { Fee, Narrowed }, { refresh: ["Narrowed"] })
	return { top, Narrowed, server: login(top, "server", [refresher]) }
}

/** Fees in minor units: small ones, either sign, and money's extremes, so two of a group can leave its range. */
const fees = [0n, 1n, -1n, 12_345n, -600n, greatest, least, 2n ** 62n, -(2n ** 62n)] as const

interface Sketch {
	readonly facts: ReadonlyArray<{ readonly grp: number; readonly fee: bigint }>
}

const sketchGen: Gen<Sketch> = (source) => ({
	facts: source.draw(
		array((fact) => ({ grp: fact.draw(int(0, 2)), fee: fact.draw(element(fees)) }), {
			min: 1,
			max: 8
		})
	)
})

/** Each group's narrowed total, by the host's exact sum: the sum where it lies in money's range, else zero. */
const expectedRows = (sketch: Sketch): ReadonlyArray<string> => {
	const sums = new Map<number, bigint>()
	for (const f of sketch.facts) {
		sums.set(f.grp, (sums.get(f.grp) ?? 0n) + f.fee)
	}
	return Arr.sort(
		Arr.map([...sums], ([grp, sum]) => {
			const narrowed = sum >= least && sum <= greatest ? sum : 0n
			return `${grp} ${Money.of(narrowed).toDecimal().toString()}`
		}),
		Order.String
	)
}

/** A relation's rows read as `<grp> <total as a decimal value>`, from its view or from its definition's lowering. */
const rowsOf = (o: Opened, from: "view" | "definition") =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const source =
			from === "view"
				? `${o.view("Narrowed")} AS "r1"`
				: `(${o.definition("Narrowed").sql}) AS "r1"`
		const column = (c: string) =>
			from === "view"
				? `"r1".${quoteIdent(o.installed.names.column("Narrowed", c))}`
				: `"r1".${quoteIdent(c)}`
		const result = yield* s.admin.query(
			`SELECT ${column("grp")}::text AS "grp", ${column("total")}::numeric::text AS "total" FROM ${source}`,
			[]
		)
		return Arr.sort(
			Arr.map(
				result.rows,
				(r) => `${String(r["grp"])} ${Decimal.fromOutput(String(r["total"])).toString()}`
			),
			Order.String
		)
	})

type NarrowedFeature = "a total within money" | "a total past money" | "a negative total"

const situations: Arr.NonEmptyReadonlyArray<NarrowedFeature> = [
	"a total within money",
	"a total past money",
	"a negative total"
]

const property = (sketch: Sketch, c: Case<NarrowedFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const declared = build("Nrw")
			const facts = {
				Fee: Arr.map(sketch.facts, (f, i) => ({ id: i + 1, grp: f.grp, fee: Money.of(f.fee) }))
			}
			const o = yield* installDerived(declared.top, facts, "dnarrow", [declared.server])
			const rebuilt = build(o.installed.declared)
			const { ctx } = yield* openCaseDb(o, rebuilt.server.roles.refresher)
			yield* refreshReport(ctx, [rebuilt.Narrowed])
			const expected = expectedRows(sketch)
			const stored: ReadonlyArray<string> = yield* rowsOf(o, "view")
			const defined: ReadonlyArray<string> = yield* rowsOf(o, "definition")
			assert.deepEqual(stored, expected, "the view holds the narrowed totals")
			assert.deepEqual(
				defined,
				expected,
				"the definition's conservative lowering delivers the narrowed totals"
			)
			const sums = new Map<number, bigint>()
			for (const f of sketch.facts) {
				sums.set(f.grp, (sums.get(f.grp) ?? 0n) + f.fee)
			}
			for (const sum of sums.values()) {
				c.note(sum >= least && sum <= greatest ? "a total within money" : "a total past money")
				if (sum < 0n) {
					c.note("a negative total")
				}
			}
		})
	)

const cases = 60

layer(Substrate.layer, { excludeTestServices: true })(
	"a derived relation narrows an exact sum into its field's type under a guard",
	(it) => {
		it.effect(
			`${cases} generated cases: the view, its definition and the host's exact sums agree`,
			(ctx) =>
				searched(
					ctx,
					oracleCheck(
						drawn(sketchGen),
						{
							suite: "derived/narrowed",
							literal: Formatter.format,
							coverage: required<NarrowedFeature>(situations, { cases, sense: notesOnly }),
							kept: [],
							runs: cases,
							shrink: { kind: "complete" },
							perturb: "planner"
						},
						property
					)
				)
		)
	}
)
