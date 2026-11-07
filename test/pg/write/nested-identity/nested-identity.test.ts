import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn as drawnField, natural, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A nested write whose texts sum past the longest string V8 holds (core/limits.ts maxStringLength) is accepted by
 * PostgreSQL and reads back as written, on PostgreSQL 19rc1: its identities are structural (write/family/nesting.ts
 * NestedSet), so the host never joins its rows' texts into one, where it once died with `RangeError: Invalid string
 * length` before any SQL.
 *
 * The schema is the downstream case's: an owner whose ordered family of members each holds a body of a's, keyed by
 * their owner and slot. A case is one owner inserted with its members nested, each body a's to its drawn length; the
 * downstream case, seven bodies of 80,000,000 units, is kept, run once, and the drawn cases stay small.
 *
 * The oracle is PostgreSQL as the judge, and the round trip: every lawful write is accepted, adding the owner and each
 * member once, and reading the members back through the reader gives each body at its slot exactly as written, and the
 * owner's count its members'.
 */
const Owner = relation("Owner", { id: uuid, members: drawnField(natural) }, ["id"])
const Member = relation(
	"Member",
	{ at: drawnField(natural), body: str.regex("^a*$"), owner: uuid },
	["owner", "at"]
)
const Bodies = schema("NestedBodies", { Owner, Member }, [
	ordered(on(Member, "owner", "at"), fin(Owner, "members"))
])

/** `n` a's: the empty text, or an a and the rest, as the body's pattern types its texts. */
const aOf = (n: number): "" | `a${string}` => (n === 0 ? "" : `a${Str.repeat(n - 1)("a")}`)

/** A case: each member's body length, in slot order. */
interface BodiesCase {
	readonly lengths: ReadonlyArray<number>
}

const caseGen: Gen<BodiesCase> = (source) => ({
	lengths: source.draw(array(element([0, 1, 2 ** 10, 2 ** 16] as const), { min: 0, max: 4 }))
})

/** The downstream case: seven bodies of 80,000,000 units, which sum past maxStringLength. */
const downstream: BodiesCase = { lengths: Arr.replicate(80_000_000, 7) }

type BodiesFeature =
	| "an owner with no members"
	| "accepted and read back with members"
	| "members of two lengths"
	| "bodies summing past the longest string"

const situations: Arr.NonEmptyReadonlyArray<BodiesFeature> = [
	"an owner with no members",
	"accepted and read back with members",
	"members of two lengths"
]

layer(Substrate.layer, { excludeTestServices: true })(
	"a nested write whose texts sum past the longest string",
	(it) => {
		it.effect(
			"is accepted by PostgreSQL and reads back as written, its identities never joined into one text",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(Bodies, {}, { label: "nestedbodies", extensions: [] })
						const s = yield* Substrate
						const names = namesOf(o.installed)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.server.roles.app, {})
							const empty = ChangeSet.empty(o.schema)
							const members = query(o.schema).rule((r) => {
								const { owner, at, body } = v(Member, "member")
								return r.match(Member, { owner, at, body }).find({ owner, at, body })
							})
							const owners = query(o.schema).rule((r) => {
								const { id, members: count } = v(Owner, "owner")
								return r.match(Owner, { id, members: count }).find({ id, members: count })
							})
							return yield* explore(
								{
									suite: "pg/write/nested-identity",
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "postgresql",
										name: "PostgreSQL accepts every lawful nested write, and the reader gives back each body at its slot as written"
									},
									coverage: required<BodiesFeature>(situations, { cases: 8, sense: notesOnly }),
									kept: [
										{
											note: "downstream: one owner inserted with seven members nested, each body 80,000,000 a's, 560,000,000 units in all",
											sketch: downstream,
											draws: "",
											reaches: [
												"accepted and read back with members",
												"bodies summing past the longest string"
											]
										}
									],
									runs: 8,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 4,
									caseHang
								},
								(c, cx) =>
									Effect.gen(function* () {
										yield* replaceRows(s.admin, installationGroup(names), [])
										/** One body per length, shared by every member of that length. */
										const bodies = new Map(
											Arr.map(Arr.dedupe(c.lengths), (n) => [n, aOf(n)] as const)
										)
										const bodyOf = (n: number): "" | `a${string}` =>
											defined(bodies.get(n), "a body's length")
										const id = uuidOf(1)
										const outcome = yield* db.apply(
											empty.insert(Owner, [
												{ id, members: Arr.map(c.lengths, (n) => ({ body: bodyOf(n) })) }
											]),
											{}
										)
										if (outcome.kind !== "accepted") {
											return assert.fail(`a lawful nested write is accepted, not ${outcome.kind}`)
										}
										const added = (name: string): bigint | undefined =>
											Option.getOrUndefined(
												Arr.findFirst(outcome.counts, (n) => n.relation === name)
											)?.added
										assert.equal(added("Owner"), 1n, "the owner is added once")
										if (c.lengths.length > 0) {
											assert.equal(
												added("Member"),
												BigInt(c.lengths.length),
												"each member is added once"
											)
										}
										const read = yield* Effect.flatMap(db.execute(members, {}), (r) => r.collect)
										assert.equal(read.length, c.lengths.length, "every member reads back")
										for (const row of read) {
											const at = Number(row.at)
											const length = defined(c.lengths[at], "a member at a slot the write drew")
											assert.equal(row.owner, id, "a member reads back under its owner")
											assert.equal(row.body.length, length, "a body reads back at its length")
											assert.ok(row.body === bodyOf(length), "a body reads back as written")
										}
										const [owner] = yield* Effect.flatMap(db.execute(owners, {}), (r) => r.collect)
										assert.equal(
											defined(owner, "the owner reads back").members,
											BigInt(c.lengths.length),
											"the owner's count is its members'"
										)
										if (c.lengths.length === 0) {
											cx.note("an owner with no members")
										} else {
											cx.note("accepted and read back with members")
										}
										if (Arr.dedupe(c.lengths).length > 1) {
											cx.note("members of two lengths")
										}
										if (Arr.reduce(c.lengths, 0, (n, l) => n + l) > maxStringLength.value) {
											cx.note("bodies summing past the longest string")
										}
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
