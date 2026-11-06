import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { filter, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { apply } from "#adapter/apply/index.ts"
import { dbContext } from "#adapter/db/context.ts"
import { Db } from "#adapter/public/db.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import {
	buildFill,
	type FillSpec,
	type FollowUp,
	fillSpecGen,
	followUpGen,
	followUpMembers,
	followUpRows,
	type InstanceRow,
	insertedRelations,
	instanceFacts,
	instanceGen,
	mutableOrDrawn,
	relationName,
	sourceClassOf,
	verdictOf,
	writesVerdict,
	writtenRows
} from "#test/support/families/fill.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld, loginLayer } from "#test/support/worlds.ts"

/**
 * A drawn schema of families and copies that `grizzle generate` accepts installs through its first migration, and the
 * first insert of a drawn instance of it, one ChangeSet writing every relation a caller writes (a sequence's members
 * nested under their owners, a tree's nodes to any depth, a counted family's members by their group keys), is accepted
 * through db.apply and stores exactly the rows the reference writer fills (test/support/families/fill.ts
 * `writtenRows`): every field of every row, each count, index, interval, fold end and copy, a counted family's among
 * them, whatever its owner's standing, a top relation's row, a tree's node or a sequence's member.
 *
 * A drawn follow-up over the stored instance (fill.ts `followUpGen`), one ChangeSet that puts an owner's row with a new
 * `v`, inserts counted members under it and puts a member at the end of one of its ordered families, is then applied
 * wherever the reference finds it leaves no value stale (fill.ts `writesVerdict`; the unit suite judges the refusals),
 * and it too stores exactly the reference writer's rows of the instance it leaves: the owner's new values in its
 * members' copies, the new members' counts, folds and copies, the appended member's index and its siblings' last copy.
 *
 * The schemas are the unit suite's (test/unit/write/fill-order.test.ts), kept where the reference model admits them;
 * the unit suite holds the refusals. PostgreSQL proves every value grizzle wrote through the installation's natives,
 * so an accepted insert with the reference writer's rows is the property.
 */

type ClusterSituation =
	| "a tree owning an ordered family"
	| "a tree owning a counted family"
	| "a counted member's copy of a tree node's end"
	| "a counted family of nested owners"
	| "a copy along a counted family of a leaving column"
	| "a predecessor copy"
	| "a last copy"
	| "an owner copy along a sequence"
	| "a fold over a tree"
	| "a copy of a generated field"
	| "a follow-up written over the stored instance"
	| "an owner put in place beside an append to its family"

const situations: Arr.NonEmptyReadonlyArray<ClusterSituation> = [
	"a tree owning an ordered family",
	"a tree owning a counted family",
	"a counted member's copy of a tree node's end",
	"a counted family of nested owners",
	"a copy along a counted family of a leaving column",
	"a predecessor copy",
	"a last copy",
	"an owner copy along a sequence",
	"a fold over a tree",
	"a copy of a generated field",
	"a follow-up written over the stored instance",
	"an owner put in place beside an append to its family"
]

/** The shapes of an admitted specification its case reaches. */
const shapesOf = (spec: FillSpec): ReadonlyArray<ClusterSituation> => {
	const owned = (r: number, kind: FillSpec["families"][number]["kind"]): boolean =>
		Arr.some(spec.families, (f) => f.owner === r && f.kind === kind)
	const trees = Arr.filter(
		Arr.map(spec.relations, (_, r) => r),
		(r) => owned(r, "tree")
	)
	const copyShapes = Arr.flatMap(spec.copies, (copy, j): ReadonlyArray<ClusterSituation> => {
		const family = defined(spec.families[copy.family])
		return [
			...(copy.axis === "predecessor" ? (["a predecessor copy"] as const) : []),
			...(copy.axis === "last" ? (["a last copy"] as const) : []),
			...(copy.axis === "owner" && family.kind !== "counted"
				? (["an owner copy along a sequence"] as const)
				: []),
			...(family.kind === "counted" && sourceClassOf(spec, j) === "leaving"
				? (["a copy along a counted family of a leaving column"] as const)
				: []),
			...(family.kind === "counted" && copy.source.kind === "end"
				? (["a counted member's copy of a tree node's end"] as const)
				: []),
			...(copy.source.kind === "generated" ? (["a copy of a generated field"] as const) : [])
		]
	})
	return [
		...(Arr.some(trees, (r) => owned(r, "ordered"))
			? (["a tree owning an ordered family"] as const)
			: []),
		...(Arr.some(trees, (r) => owned(r, "counted"))
			? (["a tree owning a counted family"] as const)
			: []),
		...(Arr.some(
			spec.families,
			(f) =>
				f.kind === "counted" &&
				Arr.some(spec.families, (s) => s.kind !== "counted" && s.member === f.owner)
		)
			? (["a counted family of nested owners"] as const)
			: []),
		...(Arr.some(spec.families, (f) => f.kind === "tree" && f.fold !== "none")
			? (["a fold over a tree"] as const)
			: []),
		...copyShapes
	]
}

/**
 * A drawn specification the reference model admits with a family that is no tree, its relations all mutable or as
 * drawn, an instance of it, and a follow-up over the stored instance where one is drawn and the reference finds it
 * written.
 */
const caseGen: Gen<{
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
	readonly followUp: Option.Option<FollowUp>
}> = (source) => {
	const spec = source.draw(
		filter(
			mutableOrDrawn(fillSpecGen({ relations: 4, families: 4, copies: 3 })),
			(s) => verdictOf(s).kind === "admitted" && Arr.some(s.families, (f) => f.kind !== "tree"),
			16
		)
	)
	const rows = source.draw(instanceGen(spec))
	const followUp = Option.filter(
		source.draw(followUpGen(spec, rows)),
		(f) =>
			writesVerdict(
				spec,
				Arr.map(followUpMembers(rows, f), (m) => ({ relation: m.relation, op: m.op }))
			).kind === "written"
	)
	return { spec, rows, followUp }
}

layer(Substrate.layer, { excludeTestServices: true })("the fill order on the cluster", (it) => {
	it.effect(
		"an admitted schema installs, and its instance's first insert stores the reference writer's rows",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/write/fill-order",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<ClusterSituation>(situations, { cases: 60, sense: notesOnly }),
						kept: [],
						runs: 16,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 8,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "the reference writer (test/support/families/fill.ts writtenRows)"
						}
					},
					({ spec, rows, followUp }, c) =>
						Effect.gen(function* () {
							const built = buildFill(spec)
							const declared = built.rename("Fill")
							const done = yield* installMigrated(declared, {
								ambient: ordinarySession,
								label: "fill",
								logins: [fullWorld(declared).server],
								extensions: []
							})
							const value = built.rename(done.schema)
							const world = fullWorld(value)
							const facts = instanceFacts(spec, rows)
							const changes = Arr.reduce(insertedRelations(spec), ChangeSet.empty(value), (cs, r) =>
								cs.insert(defined(built.relations[relationName(r)]), facts.get(r) ?? [])
							)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(world.server.roles.app, {})
								const ctx = dbContext(db)
								if (ctx === undefined) {
									return yield* Effect.die(new Error("Db.open registered no context"))
								}
								const outcome = yield* apply(ctx, changes, changes.reads, {})
								assert.equal(
									outcome.kind,
									rows.length === 0 ? "no-change" : "accepted",
									`the instance's first insert of ${Formatter.format(spec)}`
								)
								const stores = (instance: ReadonlyArray<InstanceRow>, after: string) =>
									Effect.gen(function* () {
										const expected = writtenRows(spec, instance)
										for (const [r] of spec.relations.entries()) {
											const relation = defined(built.relations[relationName(r)])
											const stored = yield* tableState(done, relation)
											unorderedEqual(
												stored,
												Arr.flatMap(instance, (row) =>
													row.relation === r ? [defined(expected.get(row.id))] : []
												),
												`${relationName(r)}'s rows after ${after}, as the reference writer fills them`
											)
										}
									})
								yield* stores(rows, "the first insert")
								c.noteAll(shapesOf(spec))
								if (Option.isNone(followUp)) {
									return
								}
								const members = followUpMembers(rows, followUp.value)
								const next = Arr.reduce(members, ChangeSet.empty(value), (cs, m) => {
									const relation = defined(built.relations[relationName(m.relation)])
									return m.op === "put" ? cs.put(relation, m.facts) : cs.insert(relation, m.facts)
								})
								const second = yield* apply(ctx, next, next.reads, {})
								assert.equal(
									second.kind,
									"accepted",
									`the follow-up ${Formatter.format(members)} of ${Formatter.format(spec)}`
								)
								yield* stores(followUpRows(rows, followUp.value), "the follow-up")
								c.note("a follow-up written over the stored instance")
								if (
									Option.isSome(followUp.value.put) &&
									(Arr.isReadonlyArrayNonEmpty(followUp.value.inserted) ||
										Option.isSome(followUp.value.appended))
								) {
									c.note("an owner put in place beside an append to its family")
								}
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(loginLayer(done, world.server)), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
						}).pipe(Effect.scoped)
				)
			)
	)
})
