/**
 * Counted put and delete through grizzle's own apply, on PostgreSQL 19rc1 (rows-first §2, §3): a counted family's
 * members are rows, and grizzle plans every edit to them. A member put that changes its step value refills the fold
 * from its slot, and a member delete swaps the last member into the freed slot and refills from there, each one suffix
 * rewrite after the read flight of the stored suffix.
 *
 * - **Two implementations agreeing:** the families model (test/support/families/counted.ts `stepPut`, `swapWithLast`)
 *   and the reference fold (fold.ts) state what each edit leaves, every slot and every hidden accumulator, and what
 *   PostgreSQL holds after the served member's apply must be exactly that.
 * - **PostgreSQL as the judge:** every state the apply leaves holds every installed native, or the apply could not have
 *   committed.
 *
 * The box (doctrine rule 9): owner 0 with every counted family of one to four members over the int4 sum seat's five
 * values (folds.ts), stored as the reference writes it by one transaction that replaces the seat's rows; each member's
 * delete, and each member's put to every other value.
 *
 * An owner keyed by an id and a span WITHOUT OVERLAPS is put in place: its row updated, never deleted and inserted
 * again, which its members' foreign key and its drawn count and fold end would refuse. Drawn span-keyed owners
 * (test/support/families/generate.ts `spanOwnersGen`), owners sharing an id over disjoint spans among them, are
 * inserted with their counted members through a served member, one is put with a new label, and PostgreSQL then holds
 * every owner with its label, count and fold end, and every member, exactly as the families model states them.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/fin-fold-check-after-equals-before.patch, a fold's CHECK holding each
 * after to its before, refuses a lawful edit and must turn both properties red.
 */
import { layer } from "@effect/vitest"
import { drawn as drawnCase, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg, span } from "#compiler/public/fields.ts"
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
	attemptedText,
	byMember,
	Disagreed,
	FOLD_SPECS,
	foldRead,
	foldSeatOf,
	foldStatementSql,
	foldWriteOf
} from "#test/pg/fin/folds.ts"
import { cleared, replaced, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, deepEquals, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { stepPut, swapWithLast } from "#test/support/families/counted.ts"
import { foldStoredOf } from "#test/support/families/fold.ts"
import { type SpanKeyedOwner, spanOwnersGen } from "#test/support/families/generate.ts"
import { caseHang } from "#test/support/limits.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

const Owner = relation("Owner", { id: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) }, [
	"id"
])
const Member = relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
const family = counted(on(Member, "g"), fin(Owner, "n"))

/** The int4 sum over a counted family, both relations mutable so a member's put and delete are planned. */
const Edited = schema(
	"fin_edits",
	[Owner, Member],
	[
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end")),
		mutable(Owner),
		mutable(Member)
	]
)

/** The seat's specification: the counted int4 sum's, over this schema. */
const SPEC = Object.freeze({
	...defined(
		Arr.findFirst(FOLD_SPECS, (s) => s.label === "sum of int4 over a counted family").pipe(
			Option.getOrUndefined
		)
	),
	label: "a counted int4 sum, mutable",
	schema: Edited
})

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
		Arr.map(
			upTo(n, (i) => i + 1),
			() => source.draw(element([0, 1, 2, 3, 4] as const))
		)
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

const SpanOwner = relation(
	"SpanOwner",
	{
		id: pg.int4,
		during: span(pg.integer),
		label: pg.int4,
		n: drawn(natural),
		end: accumulated(pg.int4, 0)
	},
	["id", "during"]
)
const SpanMember = relation(
	"SpanMember",
	{ member: pg.int4, g: pg.int4, gd: span(pg.integer), x: pg.int4 },
	["member"]
)
const spanFamily = counted(on(SpanMember, "g", "gd"), fin(SpanOwner, "n"))

/** The int4 sum over a counted family whose owner is keyed by an id and a span WITHOUT OVERLAPS, both mutable. */
const SpanEdited = schema(
	"fin_span_edits",
	[SpanOwner, SpanMember],
	[
		spanFamily,
		fold(
			spanFamily,
			Monoid.sum,
			on(SpanMember, "g", "gd", "x"),
			on(SpanOwner, "id", "during", "end")
		),
		mutable(SpanOwner),
		mutable(SpanMember)
	]
)

/** The counted family's workload: a member's delete and a member's put, each from its call's facts. */
const editPrograms = Object.freeze({
	deleteMember: ChangeSet.empty(Edited).delete(Member, []),
	putMember: ChangeSet.empty(Edited).put(Member, [])
})

/** The span-keyed owners' workload: their insert with their members, and an owner's put, each from its call's facts. */
const spanPrograms = Object.freeze({
	insertOwners: ChangeSet.empty(SpanEdited).insert(SpanOwner, []).insert(SpanMember, []),
	putOwner: ChangeSet.empty(SpanEdited).put(SpanOwner, [])
})

/** Span-keyed owners with their families, each owner's label, each member's step value, and the put: one owner's
 * new label, another than its own. */
interface SpanSketch {
	readonly owners: Arr.NonEmptyReadonlyArray<SpanKeyedOwner>
	readonly labels: ReadonlyArray<number>
	readonly xs: ReadonlyArray<number>
	readonly put: { readonly at: number; readonly label: number }
}

const spanSketchGen: Gen<SpanSketch> = (source) => {
	const owners = nonEmpty(
		source.draw(spanOwnersGen({ owners: { min: 1, max: 3 }, long: { min: 3, max: 4 } }))
	)
	const labels = source.draw(array(int(0, 4), { min: owners.length, max: owners.length }))
	const total = Arr.reduce(owners, 0, (sum, owner) => sum + owner.members.length)
	const xs = source.draw(array(int(0, 4), { min: total, max: total }))
	const at = source.draw(int(0, owners.length - 1))
	const from = defined(labels[at], "the put owner's label")
	const label = source.draw(element(nonEmpty(Arr.filter([0, 1, 2, 3, 4], (l) => l !== from))))
	return { owners, labels, xs, put: { at, label } }
}

type SpanFeature =
	| "a span-keyed owner put in place"
	| "a span-keyed owner put in place over its family's members"
	| "a span-keyed owner put in place beside an owner of its id over another span"

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
						const o = yield* installed(Edited, {}, { label: "edits", programs: editPrograms })
						const seat = yield* seatOfInstalled(o.installed, ["Owner", "Member"], "edits")
						const f = foldSeatOf(SPEC, seat)
						const m = SPEC.monoid
						const body = Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* exhaust(
								{
									suite: "fin/edits",
									generator: sketchGen,
									literal: Formatter.format,
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
										const written = yield* replaced(
											seat,
											["Owner", "Member"],
											Arr.map(foldWriteOf(before), (s) => foldStatementSql(f, s))
										)
										if (written.kind !== "committed") {
											return yield* new Disagreed({
												message: `the reference state ${Formatter.format(before)} met ${attemptedText(written)}`
											})
										}
										const target = Arr.getUnsafe(members, sketch.edit.at)
										const fact = { member: target.member, g: 0, x: Number(target.x) }
										if (sketch.edit.kind === "delete") {
											yield* answered(
												db.workload.deleteMember.once({
													params: {},
													facts: { delete: { Member: [fact] } }
												})
											)
										} else {
											const put = { ...fact, x: Number(Arr.getUnsafe(SPEC.domain, sketch.edit.to)) }
											yield* answered(
												db.workload.putMember.once({
													params: {},
													facts: { put: { Member: [put] } }
												})
											)
										}
										const read = yield* foldRead(f)
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
						return yield* Effect.flatMap(Layer.build(o.served.layer), (context) =>
							Effect.provideContext(body, context)
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"put a span-keyed owner in place, leaving every owner's label, count and fold end and every member as the families model states them",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(
							SpanEdited,
							{},
							{ label: "span_edits", programs: spanPrograms }
						)
						const seat = yield* seatOfInstalled(
							o.installed,
							["SpanOwner", "SpanMember"],
							"span_edits"
						)
						const body = Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* explore(
								{
									suite: "fin/span-owner-put",
									draw: drawnCase(spanSketchGen),
									literal: Formatter.format,
									coverage: required<SpanFeature>(
										[
											"a span-keyed owner put in place",
											"a span-keyed owner put in place over its family's members",
											"a span-keyed owner put in place beside an owner of its id over another span"
										],
										{ cases: 40, sense: notesOnly }
									),
									kept: [
										{
											note: "an owner of one member put in place: its count and end, its member's, differ from the starts its put's slot carries them at, which no comparison of the put reads",
											sketch: {
												owners: [{ id: 0, during: { start: 0, end: 1 }, members: [0] }],
												labels: [0],
												xs: [3],
												put: { at: 0, label: 1 }
											},
											draws: "",
											reaches: [
												"a span-keyed owner put in place",
												"a span-keyed owner put in place over its family's members"
											]
										}
									],
									runs: 24,
									shrink: boundedShrink(40),
									concurrency: 1,
									steerEvery: 8,
									caseHang,
									oracle: {
										kind: "second-implementation",
										name: "the families model of span-keyed owners (test/support/families/generate.ts spanOwnersGen) and each family's sum of its step values"
									}
								},
								(sketch, c) =>
									Effect.gen(function* () {
										yield* cleared(seat, ["SpanOwner", "SpanMember"])
										const xOf = (member: number): number =>
											defined(sketch.xs[member], "a member's step value")
										const labelOf = (i: number): number =>
											defined(sketch.labels[i], "an owner's label")
										const members = Arr.flatMap(sketch.owners, (owner) =>
											Arr.map(owner.members, (member) => ({
												member,
												g: owner.id,
												gd: owner.during,
												x: xOf(member)
											}))
										)
										const owned = Arr.map(sketch.owners, (owner, i) => ({
											id: owner.id,
											during: owner.during,
											label: labelOf(i)
										}))
										const first = yield* answered(
											db.workload.insertOwners.once({
												params: {},
												facts: { insert: { SpanOwner: owned, SpanMember: members } }
											})
										)
										const target = defined(sketch.owners[sketch.put.at], "the put owner")
										const put = { id: target.id, during: target.during, label: sketch.put.label }
										const outcome = yield* answered(
											db.workload.putOwner.once({
												params: {},
												facts: { put: { SpanOwner: [put] } }
											})
										)
										const owners = yield* tableState(o.installed, SpanOwner)
										const stored = yield* tableState(o.installed, SpanMember)
										assert.equal(first.kind, "accepted", "the owners' and members' insert")
										assert.equal(outcome.kind, "accepted", "the owner's put")
										unorderedEqual(
											owners,
											Arr.map(sketch.owners, (owner, i) => ({
												id: owner.id,
												during: owner.during,
												label: i === sketch.put.at ? sketch.put.label : labelOf(i),
												n: BigInt(owner.members.length),
												end: Arr.reduce(owner.members, 0, (sum, member) => sum + xOf(member))
											})),
											"every owner, the put one with its new label"
										)
										unorderedEqual(stored, members, "every member, as it was inserted")
										c.note("a span-keyed owner put in place")
										if (Arr.isReadonlyArrayNonEmpty(target.members)) {
											c.note("a span-keyed owner put in place over its family's members")
										}
										if (
											Arr.some(
												sketch.owners,
												(owner, i) => i !== sketch.put.at && owner.id === target.id
											)
										) {
											c.note(
												"a span-keyed owner put in place beside an owner of its id over another span"
											)
										}
									})
							)
						})
						return yield* Effect.flatMap(Layer.build(o.served.layer), (context) =>
							Effect.provideContext(body, context)
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
