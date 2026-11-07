import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
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
	besides,
	buildFill,
	type FillSpec,
	type FollowUp,
	fillSpecGen,
	followUpGen,
	followUpMembers,
	followUpRows,
	ownerPutGen,
	type InstanceRow,
	insertedRelations,
	instanceFacts,
	instanceGen,
	mutableOrDrawn,
	type Planted,
	plantedGen,
	relationName,
	replacingGen,
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
 * them, whatever its owner's standing, a top relation's row, a tree's node or a sequence's member, and whatever its
 * member's: a counted member may itself be an ordered family's member, a tree's node or a sequence's owner, its row
 * filled by the nested walk and completed by its counted families' fill.
 *
 * A drawn follow-up over the stored instance (fill.ts `followUpGen`), one ChangeSet that puts an owner's row with a new
 * `v`, inserts counted members under it, deletes a member of one of its ordered families and puts a member, new or
 * moved from another owner's group, at the end of one, is then applied,
 * every value it leaves stale refilled (analysis/theory/refill.ts), wherever its refills write only mutable relations
 * (fill.ts `writesVerdict`, which refuses only a refill of an immutable relation's rows; the unit suite judges that
 * refusal), and it too stores exactly the reference writer's rows of the instance it leaves: the owner's new values in
 * its members' copies, every predecessor copy, last copy, tree copy and fold drawn from them again, the new members'
 * counts, folds and copies, the appended member's index and its siblings' last copy, and every member re-placed after a
 * deleted or moved one, its own members' copies of it drawn again (a re-placed row is deleted and inserted again, which
 * no cascade follows). A fold that steps a copy of the
 * owner's `v` is judged by its member row's own CHECK at every statement, so the refill that rewrites its members
 * ahead of the owner's put is what lets the put land.
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
	| "a counted member that is an ordered family's"
	| "a counted member that is a tree's node"
	| "a counted member that owns a sequence"
	| "a copy along a counted family of a column after a sequence"
	| "a copy of a sibling sequence's end"
	| "a predecessor copy"
	| "a last copy"
	| "an owner copy along a sequence"
	| "a fold over a tree"
	| "a copy of a generated field"
	| "a follow-up written over the stored instance"
	| "an owner put in place beside an append to its family"
	| "a follow-up that refills a value it leaves stale"
	| "a follow-up that refills a fold stepping a copy"
	| "a follow-up that re-places an owner of counted members"

const situations: Arr.NonEmptyReadonlyArray<ClusterSituation> = [
	"a tree owning an ordered family",
	"a tree owning a counted family",
	"a counted member's copy of a tree node's end",
	"a counted family of nested owners",
	"a counted member that is an ordered family's",
	"a counted member that is a tree's node",
	"a counted member that owns a sequence",
	"a copy along a counted family of a column after a sequence",
	"a copy of a sibling sequence's end",
	"a predecessor copy",
	"a last copy",
	"an owner copy along a sequence",
	"a fold over a tree",
	"a copy of a generated field",
	"a follow-up written over the stored instance",
	"an owner put in place beside an append to its family",
	"a follow-up that refills a value it leaves stale",
	"a follow-up that refills a fold stepping a copy",
	"a follow-up that re-places an owner of counted members"
]

/** Whether a follow-up re-places a stored row, `was` before it and `now` after: it moves the row to another slot or
 * another owner's group of an ordered family, deleting it and inserting it again. */
const replaced = (spec: FillSpec, was: InstanceRow, now: InstanceRow): boolean =>
	Arr.some(
		now.memberOf,
		(m) =>
			spec.families[m.family]?.kind === "ordered" &&
			!Arr.some(
				was.memberOf,
				(w) => w.family === m.family && w.owner === m.owner && w.slot === m.slot
			)
	)

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
			...(family.kind === "counted" && sourceClassOf(spec, j) === "after another family"
				? (["a copy along a counted family of a column after a sequence"] as const)
				: []),
			...(family.kind !== "counted" &&
			copy.axis === "owner" &&
			sourceClassOf(spec, j) === "after another family"
				? (["a copy of a sibling sequence's end"] as const)
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
		...Arr.flatMap(spec.families, (c): ReadonlyArray<ClusterSituation> =>
			c.kind !== "counted"
				? []
				: Arr.flatMap(spec.families, (s): ReadonlyArray<ClusterSituation> => [
						...(s.kind === "ordered" && s.member === c.member
							? (["a counted member that is an ordered family's"] as const)
							: []),
						...(s.kind === "tree" && s.member === c.member
							? (["a counted member that is a tree's node"] as const)
							: []),
						...(s.kind !== "counted" && s.owner === c.member
							? (["a counted member that owns a sequence"] as const)
							: [])
					])
		),
		...copyShapes
	]
}

/**
 * A drawn specification the reference model admits with a family that is no tree, its relations all mutable or as
 * drawn, an instance of it, and a follow-up over the stored instance where one is drawn and the reference finds it
 * written.
 */
const caseGen: Gen<ClusterCase> = (source) =>
	source.draw(
		caseOver(
			filter(
				mutableOrDrawn(fillSpecGen({ relations: 4, families: 4, copies: 3 })),
				(s) => verdictOf(s).kind === "admitted" && Arr.some(s.families, (f) => f.kind !== "tree"),
				16
			),
			followUpGen
		)
	)

/** An admitted drawn specification beside a planted one (fill.ts `besides`, `plantedGen`). */
const plantedBeside =
	(planted: Planted): Gen<FillSpec> =>
	(source) =>
		besides(
			source.draw(
				filter(
					mutableOrDrawn(fillSpecGen({ relations: 3, families: 3, copies: 2 })),
					(s) => verdictOf(s).kind === "admitted",
					16
				)
			),
			source.draw(plantedGen(planted))
		)

/** A case of the suite: an admitted specification, an instance of it, and a written follow-up over it or none. */
interface ClusterCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
	readonly followUp: Option.Option<FollowUp>
}

/**
 * A case over a specification `specs` draws, its instance drawn, and its follow-up as `followUps` draws it over them,
 * where the reference writes it.
 */
const caseOver =
	(
		specs: Gen<FillSpec>,
		followUps: (spec: FillSpec, rows: ReadonlyArray<InstanceRow>) => Gen<Option.Option<FollowUp>>
	): Gen<ClusterCase> =>
	(source) => {
		const spec = source.draw(specs)
		const rows = source.draw(instanceGen(spec))
		const followUp = Option.filter(
			source.draw(followUps(spec, rows)),
			(f) =>
				writesVerdict(
					spec,
					Arr.map(followUpMembers(spec, rows, f), (m) => ({ relation: m.relation, op: m.op }))
				).kind === "written"
		)
		return { spec, rows, followUp }
	}

/** A case over a planted shape beside a drawn one, its follow-up drawn as any case's. */
const plantedCase = (planted: Planted): Gen<ClusterCase> =>
	caseOver(plantedBeside(planted), followUpGen)

/**
 * The situations a drawn specification reaches only now and then, each with the cases a witness draws to reach it
 * while it is pending: a planted shape beside a drawn one (fill.ts `plantedGen`, admitted by the reference as planted);
 * or, where a follow-up must change what the planted relations hold, the shape alone with a follow-up aimed at it: a put
 * of the owner whose copy a fold steps (fill.ts `ownerPutGen`), or a deletion or a move re-placing an ordered member that
 * owns a counted member (`replacingGen`).
 */
const aims: ReadonlyArray<readonly [ClusterSituation, Gen<ClusterCase>]> = [
	["a tree owning an ordered family", plantedCase("tree with an ordered family")],
	["a tree owning a counted family", plantedCase("tree with a counted family")],
	["a counted member's copy of a tree node's end", plantedCase("counted copy of a tree's end")],
	["a counted family of nested owners", plantedCase("counted family of a nested owner")],
	["a counted member that is an ordered family's", plantedCase("counted ordered member")],
	["a counted member that is a tree's node", plantedCase("counted tree node")],
	["a counted member that owns a sequence", plantedCase("counted sequence owner")],
	[
		"a copy along a counted family of a column after a sequence",
		plantedCase("counted copy of an end")
	],
	["a copy of a sibling sequence's end", plantedCase("sibling's end")],
	["an owner put in place beside an append to its family", plantedCase("mutable owner")],
	[
		"a follow-up that refills a value it leaves stale",
		caseOver(plantedGen("stepped copy"), (_, rows) => ownerPutGen(rows, 0))
	],
	[
		"a follow-up that refills a fold stepping a copy",
		caseOver(plantedGen("stepped copy"), (_, rows) => ownerPutGen(rows, 0))
	],
	["a copy of a generated field", plantedCase("generated copy")],
	[
		"a follow-up that re-places an owner of counted members",
		caseOver(plantedGen("re-placed owner"), (spec, rows) => replacingGen(spec, rows, 0))
	]
]

/**
 * The shape a delete once broke: R1, the member of R0's ordered family, owns a counted family of R2 whose members copy
 * R1's index. Deleting R0's first member re-places the second, deleting it and inserting it again a slot down beneath
 * its counted member, which references it along an owner axis no cascade follows: the axis waits for the commit, and
 * the member's copy of the new index is drawn again ahead of the re-placement.
 */
const replacedOwner: ClusterCase = {
	spec: {
		relations: [
			{ generated: false, mutable: true, key: false },
			{ generated: false, mutable: true, key: false },
			{ generated: false, mutable: true, key: false }
		],
		families: [
			{ kind: "ordered", owner: 0, member: 1, fold: "none" },
			{ kind: "counted", owner: 1, member: 2, fold: "none" }
		],
		copies: [{ family: 1, axis: "owner", source: { kind: "index", family: 0 } }],
		steps: []
	},
	rows: [
		{ relation: 0, id: 1, v: 1n, memberOf: [] },
		{ relation: 1, id: 2, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
		{ relation: 1, id: 3, v: 3n, memberOf: [{ family: 0, owner: 1, slot: 1 }] },
		{ relation: 2, id: 4, v: 4n, memberOf: [{ family: 1, owner: 3, slot: 0 }] }
	],
	followUp: Option.some({
		owner: 0,
		row: 1,
		put: Option.none(),
		inserted: [],
		removed: Option.some({ id: 2, family: 0 }),
		appended: Option.none(),
		moved: Option.none()
	})
}

/**
 * The case the search found binding a refill's read wrong: R2's put changes the `v` R3's counted members copy, which
 * their fold steps, beside an insert of two more members under it. The refill reads the put's rows by their keys alone,
 * and was bound an empty array of groups it never names.
 */
const ownerPutBesideAppend: ClusterCase = {
	spec: {
		relations: [
			{ generated: false, mutable: true, key: false },
			{ generated: false, mutable: true, key: false },
			{ generated: false, mutable: true, key: false },
			{ generated: false, mutable: true, key: false },
			{ generated: true, mutable: false, key: false }
		],
		families: [
			{ kind: "ordered", owner: 0, member: 1, fold: "none" },
			{ kind: "counted", owner: 2, member: 3, fold: "sum" }
		],
		copies: [{ family: 1, axis: "owner", source: { kind: "caller" } }],
		steps: [{ family: 1, copy: 0 }]
	},
	rows: [
		{ relation: 0, id: 1, v: 0n, memberOf: [] },
		{ relation: 2, id: 2, v: -1n, memberOf: [] },
		{ relation: 2, id: 3, v: 0n, memberOf: [] },
		{ relation: 3, id: 4, v: 1n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
		{ relation: 3, id: 5, v: -1n, memberOf: [{ family: 1, owner: 3, slot: 0 }] },
		{ relation: 4, id: 6, v: -2n, memberOf: [] },
		{ relation: 4, id: 7, v: -1n, memberOf: [] }
	],
	followUp: Option.some({
		owner: 2,
		row: 2,
		put: Option.some(1n),
		inserted: [
			{ relation: 3, id: 8, v: -1n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
			{ relation: 3, id: 9, v: 3n, memberOf: [{ family: 1, owner: 2, slot: 0 }] }
		],
		removed: Option.none(),
		appended: Option.none(),
		moved: Option.none()
	})
}

/** The case a witness runs: its drawn one, or, while a situation `aims` plants is pending, a planted one. */
const aimedCase = (drawnCase: ClusterCase, c: Case<ClusterSituation>): ClusterCase => {
	const pending = Option.getOrUndefined(c.steering)
	const aim = Arr.findFirst(aims, ([situation]) => pending?.has(situation) === true)
	return Option.isNone(aim) ? drawnCase : c.draw(aim.value[1])
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
						kept: [
							{
								note: "a delete of an ordered family's member re-places the next, which owns a counted member copying its index",
								sketch: replacedOwner,
								draws: "",
								reaches: [
									"a counted family of nested owners",
									"a follow-up written over the stored instance",
									"a follow-up that refills a value it leaves stale",
									"a follow-up that re-places an owner of counted members"
								]
							},
							{
								note: "an owner's put refilling its counted members' fold of its copy, beside an insert of two more under it",
								sketch: ownerPutBesideAppend,
								draws: "",
								reaches: [
									"a follow-up that refills a fold stepping a copy",
									"an owner put in place beside an append to its family"
								]
							}
						],
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
					(drawnCase, c) =>
						Effect.gen(function* () {
							const { spec, rows, followUp } = aimedCase(drawnCase, c)
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
								const members = followUpMembers(spec, rows, followUp.value)
								const next = Arr.reduce(members, ChangeSet.empty(value), (cs, m) => {
									const relation = defined(built.relations[relationName(m.relation)])
									switch (m.op) {
										case "insert":
											return cs.insert(relation, m.facts)
										case "put":
											return cs.put(relation, m.facts)
										case "delete":
											return cs.delete(relation, m.facts)
									}
								})
								const second = yield* apply(ctx, next, next.reads, {})
								assert.equal(
									second.kind,
									"accepted",
									`the follow-up ${Formatter.format(members)} of ${Formatter.format(spec)}`
								)
								const after = followUpRows(rows, followUp.value)
								yield* stores(after, "the follow-up")
								c.note("a follow-up written over the stored instance")
								const verdict = writesVerdict(
									spec,
									Arr.map(members, (m) => ({ relation: m.relation, op: m.op }))
								)
								if (Arr.isReadonlyArrayNonEmpty(verdict.stale)) {
									c.note("a follow-up that refills a value it leaves stale")
								}
								if (
									Arr.some(verdict.stale, (s) =>
										Arr.some(spec.steps, (step) => step.family === s.family)
									)
								) {
									c.note("a follow-up that refills a fold stepping a copy")
								}
								if (
									Arr.some(
										after,
										(x) =>
											Arr.some(rows, (was) => was.id === x.id && replaced(spec, was, x)) &&
											Arr.some(after, (y) => Arr.some(y.memberOf, (m) => m.owner === x.id))
									)
								) {
									c.note("a follow-up that re-places an owner of counted members")
								}
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
