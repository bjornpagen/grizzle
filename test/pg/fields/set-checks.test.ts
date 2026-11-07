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
import {
	check,
	closed,
	relation,
	type Schema,
	schema,
	type StatementsByName
} from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, containsEqual, deepEquals } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A set compared with a set value in a row check, on PostgreSQL 19rc1: `Compute.disjoint` and `Compute.subset` take a
 * set value of the first operand's roster (Bits.of) as their second operand, a literal that takes the set's type, so its
 * bits are its handles' codes, and the installed CHECK holds a row exactly when the set algebra over its handles does.
 *
 * The box: every set over a roster of three handles, written as one row of R, whose checks hold its flags apart from
 * {a} and within {a, b}. The model: a row is accepted exactly when its flags miss a and lie within {a, b}; otherwise the
 * write is refused by a check it breaks, and only by one: PostgreSQL reports the first CHECK that fails. A query reads
 * an accepted row back through the same algebra against set values, whether its flags miss b and their union with
 * {c}, which the model computes over plain Sets.
 */
const Flag = closed("Flag", ["a", "b", "c"])
const R = relation("R", { id: pg.integer, flags: bits(Flag) }, ["id"])
const apart = check("Apart", R, (r) => r.eq(Compute.disjoint(r.flags, Bits.of(Flag, ["a"])), true))
const within = check("Within", R, (r) =>
	r.eq(Compute.subset(r.flags, Bits.of(Flag, ["a", "b"])), true)
)
const Sets = schema("SetChecks", { Flag, R }, [apart, within])

/** Sets as installed under its schema's own name. */
type SetsInstalled = Schema<
	string,
	(typeof Sets)["relations"],
	StatementsByName<(typeof Sets)["statements"], (typeof Sets)["relations"]>
>

/** R's rows read back: whether the flags miss b, and their union with {c}, each against a set value. */
const readBack = (s: SetsInstalled) =>
	query(s).rule((r) => {
		const { id, flags } = v(R, "r")
		return r.match(R, { id, flags }).find({
			id,
			apart: Compute.disjoint(flags, Bits.of(Flag, ["b"])),
			joined: Compute.union(flags, Bits.of(Flag, ["c"]))
		})
	})

/** Every set over Flag's handles. */
const handles = ["a", "b", "c"] as const
const allSets = Arr.map(Arr.range(0, 2 ** handles.length - 1), (mask) =>
	Arr.filter(handles, (_, i) => (mask & (1 << i)) !== 0)
)

type Situation = "accepted" | "refused by Apart" | "refused by Within"

layer(Substrate.layer, { excludeTestServices: true })(
	"a row check over a set and a set value",
	(it) => {
		it.effect(
			"holds a row exactly when its flags are disjoint from and a subset of the set values, for every set over the roster",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(Sets, {}, { label: "setchecks", extensions: [] })
						const s = yield* Substrate
						const names = namesOf(o.installed)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.server.roles.app, {})
							return yield* exhaust(
								{
									box: { kind: "unstated" },
									suite: "pg/fields/set-checks",
									generator: element(allSets),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "the checks' set algebra restated over each set of the roster's handles"
									},
									limit: allSets.length,
									coverage: requiredInSpace<Situation>([
										"accepted",
										"refused by Apart",
										"refused by Within"
									]),
									caseHang
								},
								(flags, c) =>
									Effect.gen(function* () {
										yield* replaceRows(s.admin, installationGroup(names), [])
										const outcome = yield* db.apply(
											ChangeSet.empty(o.schema).insert(R, [{ id: 1, flags: Bits.of(Flag, flags) }]),
											{}
										)
										const apartLaw = names.described(names.lawOf(apart))
										const withinLaw = names.described(names.lawOf(within))
										const broken = [
											...(flags.includes("a") ? [apartLaw] : []),
											...(flags.includes("c") ? [withinLaw] : [])
										]
										if (broken.length === 0) {
											assert.equal(
												outcome.kind,
												"accepted",
												`${Formatter.format(flags)} is accepted`
											)
											const read = yield* (yield* db.execute(readBack(o.schema), {})).collect
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
											c.note("accepted")
											return
										}
										if (outcome.kind !== "invariant-rejected") {
											return assert.fail(`a refusal by a check, not ${outcome.kind}`)
										}
										assert.equal(
											outcome.refused.laws.length,
											1,
											"one CHECK fails, and its law is named"
										)
										const [law] = outcome.refused.laws
										containsEqual(broken, law, "the refusing check is one the set breaks")
										assert.deepEqual(outcome.witness, {
											kind: "key",
											relation: "R",
											values: { id: 1 }
										})
										c.note(deepEquals(law, apartLaw) ? "refused by Apart" : "refused by Within")
									})
							)
						}).pipe(
							(body) =>
								Effect.flatMap(Layer.build(o.layer), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
