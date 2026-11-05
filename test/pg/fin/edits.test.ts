/**
 * Counted put and delete through grizzle's own apply, on PostgreSQL 19rc1 (rows-first §2, §3): a counted family's
 * members are rows, and grizzle plans every edit to them. A member put that changes its step value refills the fold
 * from its slot, and a member delete swaps the last member into the freed slot and refills from there, each one suffix
 * rewrite after the read flight of the stored suffix.
 *
 * - **Two implementations agreeing:** the families model (test/support/families/counted.ts `stepPut`, `swapWithLast`)
 *   and the reference fold (fold.ts) state what each edit leaves, every slot and every hidden accumulator, and what
 *   PostgreSQL holds after `db.apply` must be exactly that.
 * - **PostgreSQL as the judge:** every state the apply leaves holds every installed native, or the apply could not have
 *   committed.
 *
 * The box (doctrine rule 9): owner 0 with every counted family of one to four members over the int4 sum seat's five
 * values (folds.ts), stored as the reference writes it; each member's delete, and each member's put to every other value.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import {
	byMember,
	Disagreed,
	FOLD_SPECS,
	foldRead,
	foldSeatOf,
	foldStatementSql,
	foldWriteOf
} from "#test/pg/fin/folds.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { installed } from "#test/pg/reads/support.ts"
import { deepEquals, defined, nonEmpty } from "#test/support/assert.ts"
import { stepPut, swapWithLast } from "#test/support/families/counted.ts"
import { foldStoredOf } from "#test/support/families/fold.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Owner = relation("Owner", { id: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) }, [
	"id"
])
const Member = relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
const family = counted(on(Member, "g"), fin(Owner, "n"))

/** The int4 sum over a counted family, both relations mutable so a member's put and delete are planned. */
const Edited = schema("fin_edits", { Owner, Member }, [
	family,
	fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end")),
	mutable(Owner),
	mutable(Member)
])

/** The seat's specification: the counted int4 sum's, over this schema. */
const SPEC = {
	...defined(
		Arr.findFirst(FOLD_SPECS, (s) => s.label === "sum of int4 over a counted family").pipe(
			Option.getOrUndefined
		)
	),
	label: "a counted int4 sum, mutable",
	schema: Edited
}

/** An edit of owner 0's family: one member's delete, or its put to another of the five values. */
type Edit =
	| { readonly kind: "delete"; readonly at: number }
	| { readonly kind: "put"; readonly at: number; readonly to: number }

interface Sketch {
	readonly values: Arr.NonEmptyReadonlyArray<number>
	readonly edit: Edit
}

const sketchGen: Gen<Sketch> = (source) => {
	const n = source.draw(int(1, 4))
	const values = nonEmpty(
		Arr.map(Arr.range(1, n), () => source.draw(element([0, 1, 2, 3, 4] as const)))
	)
	const at = source.draw(int(0, n - 1))
	const from = Arr.getUnsafe(values, at)
	const edit: Edit =
		source.draw(element(["delete", "put"] as const)) === "delete"
			? { kind: "delete", at }
			: {
					kind: "put",
					at,
					to: source.draw(element(nonEmpty(Arr.filter([0, 1, 2, 3, 4], (v) => v !== from))))
				}
	return { values, edit }
}

const sketchCases = Arr.reduce(Arr.range(1, 4), 0, (sum, n) => sum + 5 ** n * n * (1 + 4))

type EditFeature =
	| `${"delete" | "put"} of ${"the last slot" | "a slot before the last"} applied as the model states`
	| "a put of the first slot refilled every slot"

layer(Substrate.layer, { excludeTestServices: true })(
	"counted put and delete through grizzle's apply on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"leave exactly the state the families model and the reference fold state after each member's put of a new step value and each member's delete",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(Edited, {}, { label: "edits", extensions: [] })
						const seat = yield* seatOfInstalled(o.installed, ["Owner", "Member"], "edits")
						const f = foldSeatOf(SPEC, seat)
						const m = SPEC.monoid
						const body = Effect.gen(function* () {
							const db = yield* Db.open(o.server.roles.app, {})
							return yield* exhaust(
								{
									suite: "fin/edits",
									generator: sketchGen,
									literal: Formatter.format,
									limit: sketchCases,
									box: "owner 0 with every counted family of one to four members over five int4 values, each member deleted and each put to every other value",
									oracle: {
										kind: "second-implementation",
										name: "the families model (test/support/families/counted.ts stepPut, swapWithLast) and the reference fold (fold.ts) of the families each edit leaves"
									},
									coverage: requiredInSpace<EditFeature>([
										"delete of the last slot applied as the model states",
										"delete of a slot before the last applied as the model states",
										"put of the last slot applied as the model states",
										"put of a slot before the last applied as the model states",
										"a put of the first slot refilled every slot"
									]),
									caseHang
								},
								(sketch, c) =>
									Effect.gen(function* () {
										const members = Arr.map(sketch.values, (i, member) => ({
											member,
											x: Arr.getUnsafe(SPEC.domain, i),
											selected: true
										}))
										const before = foldStoredOf(m, [{ owner: 0, members }])
										const written = yield* attempt(
											seat.session,
											Arr.map(foldWriteOf(before), (s) => foldStatementSql(f, s))
										)
										if (written.kind !== "committed") {
											return yield* new Disagreed({
												message: `the reference state ${Formatter.format(before)} was refused`
											})
										}
										const target = Arr.getUnsafe(members, sketch.edit.at)
										const fact = { member: target.member, g: 0, x: Number(target.x) }
										const changes =
											sketch.edit.kind === "delete"
												? ChangeSet.empty(o.schema).delete(Member, [fact])
												: ChangeSet.empty(o.schema).put(Member, [
														{ ...fact, x: Number(Arr.getUnsafe(SPEC.domain, sketch.edit.to)) }
													])
										yield* db.apply(changes, {})
										const read = yield* foldRead(f)
										yield* cleared(seat, ["Owner", "Member"])
										const after =
											sketch.edit.kind === "delete"
												? swapWithLast(m, before, 0, sketch.edit.at).after
												: stepPut(
														before,
														0,
														target.member,
														Arr.getUnsafe(SPEC.domain, sketch.edit.to)
													)
										const expected = foldStoredOf(m, after)
										if (!deepEquals(read, byMember(expected))) {
											return yield* new Disagreed({
												message: `${sketch.edit.kind} of slot ${sketch.edit.at} left ${Formatter.format(read)}, where the model states ${Formatter.format(byMember(expected))}, from ${Formatter.format(before)}`
											})
										}
										const position =
											sketch.edit.at === sketch.values.length - 1
												? "the last slot"
												: "a slot before the last"
										c.note(`${sketch.edit.kind} of ${position} applied as the model states`)
										if (
											sketch.edit.kind === "put" &&
											sketch.edit.at === 0 &&
											sketch.values.length > 1
										) {
											c.note("a put of the first slot refilled every slot")
										}
									})
							)
						})
						return yield* Effect.flatMap(Layer.build(o.layer), (context) =>
							Effect.provideContext(body, context)
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
