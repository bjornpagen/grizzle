/**
 * A set compared with a set value in a row check, on PostgreSQL 19rc1: `Compute.disjoint` and `Compute.subset` take a
 * set value of the first operand's roster (Bits.of) as their second operand, a literal that takes the set's type, so its
 * bits are its handles' codes, and the installed CHECK holds a row exactly when the set algebra over its handles does.
 *
 * The box: every set over a roster of three handles, written as one row of R, whose checks hold its flags apart from
 * {a}, within {a, b}, and within one side, {a, b} or {b, c}, so a and c together break all three. The model restates
 * the checks over plain Sets: a row is accepted exactly when its flags hold every one; otherwise the write is refused naming `every` check the flags break, each once, in the schema's canonical order
 * of its laws, whichever CHECK PostgreSQL tried first, its witness the row's key. A query reads an accepted row back
 * through the same algebra against set values, whether its flags miss b and their union with {c}, which the model
 * computes over plain Sets.
 *
 * Planted in a scratch copy, a refusal naming only the CHECK PostgreSQL reported, as one did before a refused CHECK
 * named every law its row breaks, and one naming the broken checks against the canonical order, each fail the box.
 *
 * Plants: fields-set-subset-reversed (subset lowers as b ⊆ a).
 *
 * Features: a row accepted, and a row breaking each check alone and with others.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Bits, bits, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

const handles = ["a", "b", "c"] as const
type Handle = (typeof handles)[number]
const Flag = closed("Flag", handles)
const R = relation("R", { id: pg.integer, flags: bits(Flag) }, ["id"])

/** The set value Apart holds R's flags apart from, the one Within holds them within, and Split's other side. */
const apartFrom: ReadonlyArray<Handle> = ["a"]
const withinOf: ReadonlyArray<Handle> = ["a", "b"]
const otherSide: ReadonlyArray<Handle> = ["b", "c"]
const apart = check("Apart", R, (r) =>
	r.eq(Compute.disjoint(r.flags, Bits.of(Flag, apartFrom)), true)
)
const within = check("Within", R, (r) =>
	r.eq(Compute.subset(r.flags, Bits.of(Flag, withinOf)), true)
)
const split = check("Split", R, (r) =>
	r.or(
		r.eq(Compute.subset(r.flags, Bits.of(Flag, withinOf)), true),
		r.eq(Compute.subset(r.flags, Bits.of(Flag, otherSide)), true)
	)
)
const Sets = schema("SetChecks", [Flag, R], [apart, within, split])

/**
 * The full world's workload: a row of R written with the flags each call gives, and R's rows read back, whether the
 * flags miss b and their union with {c}, each against a set value.
 */
const programs = Object.freeze({
	write: ChangeSet.empty(Sets).insert(R, []),
	readBack: query(Sets).rule((r) => {
		const { id, flags } = v(R, "r")
		return r.match(R, { id, flags }).find({
			id,
			apart: Compute.disjoint(flags, Bits.of(Flag, ["b"])),
			joined: Compute.union(flags, Bits.of(Flag, ["c"]))
		})
	})
})

/** Every set over Flag's handles. */
const allSets = nonEmpty(
	upTo(2 ** handles.length, (mask) => Arr.filter(handles, (_, i) => (mask & (1 << i)) !== 0)),
	"every set over the handles, the empty one first"
)

/**
 * R's checks restated over plain Sets, the oracle: each check's statement beside whether a row's flags hold it, and the
 * situation of a row that breaks it alone.
 */
const restated = [
	{
		statement: apart,
		holds: (flags: ReadonlySet<Handle>) => Arr.every(apartFrom, (h) => !flags.has(h)),
		alone: "refused by Apart"
	},
	{
		statement: within,
		holds: (flags: ReadonlySet<Handle>) =>
			Arr.every(Arr.fromIterable(flags), (h) => withinOf.includes(h)),
		alone: "refused by Within"
	},
	{
		statement: split,
		holds: (flags: ReadonlySet<Handle>) =>
			Arr.every(Arr.fromIterable(flags), (h) => withinOf.includes(h)) ||
			Arr.every(Arr.fromIterable(flags), (h) => otherSide.includes(h)),
		alone: "refused by Split"
	}
] as const

type Restated = (typeof restated)[number]

type Situation = "accepted" | Restated["alone"] | "refused by several checks"

/** The situation of a row breaking `broken`, R's checks its flags break. */
const situationOf = (broken: ReadonlyArray<Restated>): Situation => {
	const [only, ...others] = broken
	if (only === undefined) {
		return "accepted"
	}
	return Arr.isReadonlyArrayEmpty(others) ? only.alone : "refused by several checks"
}

layer(Substrate.layer, { excludeTestServices: true })(
	"a row check over a set and a set value",
	(it) => {
		it.effect(
			"holds a row exactly when its flags are disjoint from and a subset of the set values, and a refusal names every check they break, all three at once included, for every set over the roster",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(Sets, {}, { label: "setchecks", programs })
						const s = yield* Substrate
						const names = namesOf(o.installed)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* exhaust(
								{
									box: "every set over the roster's three handles",
									suite: "pg/fields/set-checks",
									generator: element(allSets),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "the checks' set algebra restated over each set of the roster's handles"
									},
									coverage: requiredInSpace<Situation>([
										"accepted",
										"refused by Apart",
										"refused by Within",
										"refused by several checks"
									]),
									caseHang
								},
								(flags, c) =>
									Effect.gen(function* () {
										yield* replaceRows(s.admin, installationGroup(names), [])
										const outcome = yield* answered(
											db.workload.write.once({
												params: {},
												facts: { insert: { R: [{ id: 1, flags: Bits.of(Flag, flags) }] } }
											})
										)
										const held = new Set(flags)
										const broken = Arr.filter(restated, (r) => !r.holds(held))
										const brokenLaws = new Set(Arr.map(broken, (r) => names.lawOf(r.statement)))
										const named = Arr.flatMap(names.model.theory.laws, (law) =>
											brokenLaws.has(law.id) ? [names.described(law.id)] : []
										)
										if (!Arr.isReadonlyArrayNonEmpty(named)) {
											assert.equal(
												outcome.kind,
												"accepted",
												`${Formatter.format(flags)} is accepted`
											)
											const read = yield* rowsOf(
												db.workload.readBack.once({ params: {}, facts: {} })
											)
											assert.deepEqual(
												Arr.map(read, (row) => ({
													apart: row.apart,
													joined: Arr.sort(Arr.fromIterable(row.joined), Order.String)
												})),
												[
													{
														apart: !flags.includes("b"),
														joined: Arr.sort(Arr.dedupe([...flags, "c" as const]), Order.String)
													}
												],
												"the query's set algebra against set values agrees with the model's"
											)
											c.note(situationOf(broken))
											return
										}
										const refusal = `${Formatter.format(flags)} is refused naming every check it breaks, each once, in canonical order`
										assert.ok(outcome.kind === "refused", refusal)
										assert.equal(outcome.refused.kind, "every", refusal)
										assert.deepEqual(refusedLaws(outcome.refused), named, refusal)
										assert.deepEqual(
											outcome.witness,
											{ kind: "key", relation: "R", values: { id: 1 } },
											refusal
										)
										c.note(situationOf(broken))
									})
							)
						}).pipe(
							(body) =>
								Effect.flatMap(Layer.build(o.served.layer), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
