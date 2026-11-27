/** What the properties of fill-order.test.ts read: its spaces, models and helpers. */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { boolean, constant, element, type Gen, oneOf, type Steered } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, type Result } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { rowEvaluator } from "#adapter/public/host.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { previewOver } from "#compiler/program/preview.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { insertableNamesOf } from "#compiler/schema/world.ts"
import type { Unevaluated } from "#compiler/types/schema/evaluation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import {
	admittedFillSpecGen,
	appendGen,
	besides,
	buildFill,
	chainOf,
	familyAt,
	type FillSpec,
	type FollowUp,
	followUpGen,
	type FollowUpMember,
	followUpMembers,
	followUpRows,
	fullInstance,
	generationDrawn,
	generationOfV,
	holdsGenerated,
	insertedRelations,
	instanceFacts,
	instanceGen,
	type InstanceRow,
	movingGen,
	mutableOrDrawn,
	noGeneration,
	ownerPutGen,
	type Planted,
	plantedGen,
	relationAt,
	relationName,
	replacingGen,
	sourceClassOf,
	writesVerdict,
	writtenFollowUpGen,
	writtenRows
} from "#test/support/families/fill.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A drawn schema of families and copies that `grizzle generate` accepts installs through its first migration, and the
 * first insert of a drawn instance of it, one ChangeSet writing every relation a caller writes (a sequence's members
 * nested under their owners, a tree's nodes to any depth, a counted family's members by their group keys), is accepted
 * through a served member and stores exactly the rows the reference writer fills (test/support/families/fill.ts
 * `writtenRows`): every field of every row, each count, index, interval, fold end and copy, a counted family's among
 * them, whatever its owner's standing, a top relation's row, a tree's node or a sequence's member, and whatever its
 * member's: a counted member may itself be an ordered family's member, a tree's node or a sequence's owner, its row
 * filled by the nested walk and completed by its counted families' fill.
 *
 * A drawn follow-up over the stored instance (fill.ts `followUpGen`), one ChangeSet that puts an owner's row with a new
 * `v`, inserts counted members under it, deletes a member of one of its ordered families and puts a member, new or
 * moved from another owner's group, at the end of one, is then applied, every value it leaves stale refilled
 * (analysis/theory/refill.ts), wherever its refills write only mutable relations (fill.ts `writesVerdict`, which
 * refuses a refill of an immutable relation's rows or of a tree's values; the unit suite judges those refusals), and it
 * too stores exactly the reference writer's rows of the instance it leaves: the owner's new values in its members'
 * copies, every predecessor copy, last copy and fold drawn from them again, the new members' counts, folds and copies,
 * the appended member's index and its siblings' last copy, and every member re-placed after a deleted or moved one, its
 * own members' copies of it drawn again (a re-placed row is deleted and inserted again, which no cascade follows). A
 * fold that steps a copy of the owner's `v` is judged by its member row's own CHECK at every statement, so the refill
 * that rewrites its members ahead of the owner's put is what lets the put land.
 *
 * The schemas are the unit suite's (test/unit/write/fill-order.test.ts), drawn admitted by the reference model by
 * construction (fill.ts `admittedFillSpecGen`), each follow-up made one it writes (`writtenFollowUpGen`);
 * the unit suite holds the refusals. PostgreSQL proves every value grizzle wrote through the installation's natives,
 * so an accepted insert with the reference writer's rows is the property.
 */

export type ClusterSituation =
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
	| "a generated field reading a field grizzle draws or accumulates"
	| "a copy of a generated field reading a field grizzle draws or accumulates"
	| "a fold stepping a generated field that reads a column its family draws"
	| "an owner's put refilling a value over a copy of its generated field that reads a field grizzle accumulates"
	| "a follow-up written over the stored instance"
	| "an owner put in place beside an append to its family"
	| "a follow-up that refills a value it leaves stale"
	| "a follow-up that refills a fold stepping a copy"
	| "a follow-up that draws a stored counted group whole"
	| "a follow-up that re-places an owner of counted members"
	| "a follow-up that moves an owner of counted members to another owner's group"
	| "a follow-up that moves an owner whose counted members copy its index"
	| "a chain along a predecessor axis"
	| "a chain along a tree's owner axis"
	| "a follow-up over a chain along a predecessor axis"

export const situations: Arr.NonEmptyReadonlyArray<ClusterSituation> = [
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
	"a follow-up that re-places an owner of counted members",
	"a follow-up that moves an owner of counted members to another owner's group",
	"a follow-up that moves an owner whose counted members copy its index",
	"a chain along a predecessor axis",
	"a chain along a tree's owner axis",
	"a follow-up over a chain along a predecessor axis"
]

/** A call's facts: under each op of a change member's array members, the rows of each, under its relation's name. */
type CallFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

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
		const chain = chainOf(spec, j)
		const family = defined(spec.families[copy.family])
		return [
			...(copy.axis === "predecessor" ? (["a predecessor copy"] as const) : []),
			...(chain === "predecessor" ? (["a chain along a predecessor axis"] as const) : []),
			...(chain === "owner" ? (["a chain along a tree's owner axis"] as const) : []),
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
			...(copy.source.kind === "generated" ? (["a copy of a generated field"] as const) : []),
			...(copy.source.kind === "generated" &&
			relationAt(spec, copy.axis === "owner" ? family.owner : family.member).generated.kind ===
				"row"
				? (["a copy of a generated field reading a field grizzle draws or accumulates"] as const)
				: [])
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
		...copyShapes,
		...(Arr.some(spec.relations, (r) => r.generated.kind === "row")
			? (["a generated field reading a field grizzle draws or accumulates"] as const)
			: []),
		...(Arr.some(spec.steps, (step) => step.kind === "generated")
			? (["a fold stepping a generated field that reads a column its family draws"] as const)
			: [])
	]
}

/**
 * A specification the reference model admits by construction (fill.ts `admittedFillSpecGen`), its relations all
 * mutable or as drawn, an instance of it, and a follow-up over the stored instance the reference writes, or none.
 */
export const caseGen: Gen<ClusterCase> = (source) =>
	source.draw(
		caseOver(
			mutableOrDrawn(admittedFillSpecGen({ relations: 4, families: 4, copies: 3 })),
			instanceGen,
			followUpGen
		)
	)

/** An admitted drawn specification beside a planted one (fill.ts `besides`, `plantedGen`). */
const plantedBeside =
	(planted: Planted): Gen<FillSpec> =>
	(source) =>
		besides(
			source.draw(mutableOrDrawn(admittedFillSpecGen({ relations: 3, families: 3, copies: 2 }))),
			source.draw(plantedGen(planted))
		)

/** A case of the suite: an admitted specification, an instance of it, and a written follow-up over it or none. */
export interface ClusterCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
	readonly followUp: Option.Option<FollowUp>
}

/**
 * A case over a specification `specs` draws, its instance as `instances` draws it, and its follow-up as `followUps`
 * draws it over them, made one the reference writes (fill.ts `writtenFollowUpGen`).
 */
const caseOver =
	(
		specs: Gen<FillSpec>,
		instances: (spec: FillSpec) => Gen<ReadonlyArray<InstanceRow>>,
		followUps: (spec: FillSpec, rows: ReadonlyArray<InstanceRow>) => Gen<Option.Option<FollowUp>>
	): Gen<ClusterCase> =>
	(source) => {
		const spec = source.draw(specs)
		const rows = source.draw(instances(spec))
		const followUp = source.draw(writtenFollowUpGen(spec, rows, followUps(spec, rows)))
		return { spec, rows, followUp }
	}

/** A case over a planted shape beside a drawn one, its follow-up drawn as any case's. */
const plantedCase = (planted: Planted): Gen<ClusterCase> =>
	caseOver(plantedBeside(planted), instanceGen, followUpGen)

/**
 * The situations a drawn specification reaches only now and then, each with the cases a witness draws to reach it while
 * it is pending: a planted shape beside a drawn one (fill.ts `plantedGen`, admitted by the reference as planted); or,
 * where a follow-up must change what the planted relations hold, the shape alone with a follow-up aimed at it: a put of
 * the owner whose copy a fold steps (fill.ts `ownerPutGen`), a deletion or a move re-placing an ordered member that
 * owns a counted member (`replacingGen`), or a move of such a member to another owner's group (`movingGen`), its counted
 * members copying its index or not, over the instance of every count at its most (`fullInstance`), whose last member of
 * each group owns every counted member.
 */
export const aims: ReadonlyArray<readonly [ClusterSituation, Gen<ClusterCase>]> = [
	["a tree owning an ordered family", plantedCase("tree with an ordered family")],
	["a chain along a predecessor axis", plantedCase("predecessor chain")],
	["a chain along a tree's owner axis", plantedCase("tree chain")],
	["a follow-up over a chain along a predecessor axis", plantedCase("predecessor chain")],
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
		caseOver(plantedGen("stepped copy"), instanceGen, (_, rows) => ownerPutGen(rows, 0))
	],
	[
		"a follow-up that refills a fold stepping a copy",
		caseOver(plantedGen("stepped copy"), instanceGen, (_, rows) => ownerPutGen(rows, 0))
	],
	["a copy of a generated field", plantedCase("generated copy")],
	[
		"a follow-up that re-places an owner of counted members",
		caseOver(
			plantedGen("re-placed owner"),
			(spec) => constant(fullInstance(spec)),
			(spec, rows) => replacingGen(spec, rows, 0)
		)
	],
	[
		"a follow-up that moves an owner of counted members to another owner's group",
		caseOver(
			plantedGen("re-placed owner"),
			(spec) => constant(fullInstance(spec)),
			(spec, rows) => movingGen(spec, rows, 0)
		)
	],
	[
		"a follow-up that moves an owner whose counted members copy its index",
		caseOver(
			(source) => ({
				...source.draw(plantedGen("re-placed owner")),
				copies: [{ family: 1, axis: "owner", source: { kind: "index", family: 0 } }]
			}),
			(spec) => constant(fullInstance(spec)),
			(spec, rows) => movingGen(spec, rows, 0)
		)
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
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true }
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
 * replacedOwner beside an append under the owner it re-places: the stored member copies both the owner's index, which
 * the delete's re-placement redraws, and its count, which the append recounts.
 */
const replacedOwnerAppended: ClusterCase = {
	spec: {
		relations: [
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true }
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
		inserted: [{ relation: 2, id: 5, v: 5n, memberOf: [{ family: 1, owner: 3, slot: 0 }] }],
		removed: Option.some({ id: 2, family: 0 }),
		appended: Option.none(),
		moved: Option.none()
	})
}

/**
 * The shape a delete once broke with no copy at all: R1, the member of R0's ordered family, owns a counted family of
 * R2. Deleting R0's first member re-places the second, deleting it and inserting it again beneath its counted member,
 * which references it along the counted family's owner axis: that axis waits for the commit, the re-placed row
 * keeping its key and its count.
 */
const replacedOwnerBare: ClusterCase = {
	...replacedOwner,
	spec: { ...replacedOwner.spec, copies: [] }
}

/**
 * The case the search found re-inserting a counted member with its old count: R4 is a member of R2's ordered family
 * and of R3's counted one. A delete of one R4 row and a move of another to a second R2 group re-place R4 rows, deleting
 * them before the counted family's count statement and inserting them after it, which no cascade reaches, while the
 * delete lowers R3's count; each re-placed member is drawn whole, its ‹n› the new count.
 */
const replacedCountedMember: ClusterCase = {
	spec: {
		relations: [
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: generationOfV, mutable: true }
		],
		families: [
			{ kind: "tree", owner: 0, member: 0, fold: "none" },
			{ kind: "ordered", owner: 2, member: 4, fold: "count" },
			{ kind: "counted", owner: 3, member: 4, fold: "count" }
		],
		copies: [
			{ family: 0, axis: "owner", source: { kind: "caller" } },
			{ family: 0, axis: "owner", source: { kind: "index", family: 0 } }
		],
		steps: []
	},
	rows: [
		{ relation: 0, id: 1, v: -2n, memberOf: [] },
		{ relation: 0, id: 2, v: -1n, memberOf: [] },
		{ relation: 0, id: 3, v: -2n, memberOf: [{ family: 0, owner: 2, slot: 0 }] },
		{ relation: 0, id: 4, v: -2n, memberOf: [{ family: 0, owner: 3, slot: 0 }] },
		{ relation: 0, id: 5, v: 1n, memberOf: [{ family: 0, owner: 4, slot: 0 }] },
		{ relation: 0, id: 6, v: 2n, memberOf: [{ family: 0, owner: 4, slot: 1 }] },
		{ relation: 0, id: 7, v: 3n, memberOf: [{ family: 0, owner: 3, slot: 1 }] },
		{ relation: 1, id: 8, v: -1n, memberOf: [] },
		{ relation: 2, id: 9, v: 3n, memberOf: [] },
		{
			relation: 4,
			id: 10,
			v: 3n,
			memberOf: [
				{ family: 1, owner: 9, slot: 0 },
				{ family: 2, owner: 14, slot: 0 }
			]
		},
		{
			relation: 4,
			id: 11,
			v: -2n,
			memberOf: [
				{ family: 1, owner: 9, slot: 1 },
				{ family: 2, owner: 14, slot: 0 }
			]
		},
		{ relation: 2, id: 12, v: -1n, memberOf: [] },
		{
			relation: 4,
			id: 13,
			v: -1n,
			memberOf: [
				{ family: 1, owner: 12, slot: 0 },
				{ family: 2, owner: 14, slot: 0 }
			]
		},
		{ relation: 3, id: 14, v: 1n, memberOf: [] }
	],
	followUp: Option.some({
		owner: 2,
		row: 12,
		put: Option.some(-3n),
		inserted: [],
		removed: Option.some({ id: 13, family: 1 }),
		appended: Option.none(),
		moved: Option.some({ id: 10, family: 1 })
	})
}

/**
 * The cases the search found reading a member's generated field a scan does not hold: R1's members copy their
 * predecessor's generated field, and R0 its last member's. A follow-up deletes R1's first member under R0, so the scan
 * redraws the rest from slot 0, each copying the generated field of the member before it, and the recount copies the
 * last one's, each computed by its generation.
 */
const generatedPredecessor: ClusterCase = {
	spec: {
		relations: [
			{ generated: noGeneration, mutable: true },
			{ generated: generationOfV, mutable: true }
		],
		families: [{ kind: "ordered", owner: 0, member: 1, fold: "none" }],
		copies: [
			{ family: 0, axis: "predecessor", source: { kind: "generated" } },
			{ family: 0, axis: "last", source: { kind: "generated" } }
		],
		steps: []
	},
	rows: [
		{ relation: 0, id: 1, v: 1n, memberOf: [] },
		{ relation: 1, id: 2, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
		{ relation: 1, id: 3, v: 3n, memberOf: [{ family: 0, owner: 1, slot: 1 }] },
		{ relation: 1, id: 4, v: 4n, memberOf: [{ family: 0, owner: 1, slot: 2 }] }
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
 * The case the search found leaving an owner's recount to an additions statement its stratum lacked: R1 owns R2's
 * ordered family, and copies its last member's v along the last axis. A follow-up puts R1 and deletes its first member,
 * re-placing the second at slot 0, and appends nothing: the removals leave R1's recount to the additions, after the
 * put, so the additions recount R1's count and its last copy.
 */
const ownerPutBesideRemoval: ClusterCase = {
	spec: {
		relations: [
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true }
		],
		families: [{ kind: "ordered", owner: 1, member: 2, fold: "none" }],
		copies: [{ family: 0, axis: "last", source: { kind: "caller" } }],
		steps: []
	},
	rows: [
		{ relation: 1, id: 1, v: 1n, memberOf: [] },
		{ relation: 2, id: 2, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
		{ relation: 2, id: 3, v: 3n, memberOf: [{ family: 0, owner: 1, slot: 1 }] }
	],
	followUp: Option.some({
		owner: 1,
		row: 1,
		put: Option.some(4n),
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
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: generationOfV, mutable: false }
		],
		families: [
			{ kind: "ordered", owner: 0, member: 1, fold: "none" },
			{ kind: "counted", owner: 2, member: 3, fold: "sum" }
		],
		copies: [{ family: 1, axis: "owner", source: { kind: "caller" } }],
		steps: [{ kind: "copy", family: 1, copy: 0 }]
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

/**
 * A counted fold stepping a sequence's copy, its member moved: R0 is a member of R2's ordered family, whose owner axis
 * copies R2's `v` into R0's c0, and of R1's counted family, whose sum fold steps c0. The follow-up moves R0's first row
 * under the other R2 row: the put re-places it with the new owner's `v`, and the counted family draws its fold from
 * that copy, as the ordered family's fill, run first, leaves it, where it once drew from the stored copy and the row's
 * own CHECK refused the re-placement.
 */
const movedSequenceCopy: ClusterCase = {
	spec: {
		relations: [
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true }
		],
		families: [
			{ kind: "ordered", owner: 2, member: 0, fold: "none" },
			{ kind: "counted", owner: 1, member: 0, fold: "sum" }
		],
		copies: [{ family: 0, axis: "owner", source: { kind: "caller" } }],
		steps: [{ kind: "copy", family: 1, copy: 0 }]
	},
	rows: [
		{ relation: 2, id: 1, v: 1n, memberOf: [] },
		{ relation: 2, id: 2, v: 10n, memberOf: [] },
		{ relation: 1, id: 3, v: 0n, memberOf: [] },
		{
			relation: 0,
			id: 4,
			v: 0n,
			memberOf: [
				{ family: 0, owner: 1, slot: 0 },
				{ family: 1, owner: 3, slot: 0 }
			]
		},
		{
			relation: 0,
			id: 5,
			v: 0n,
			memberOf: [
				{ family: 0, owner: 1, slot: 1 },
				{ family: 1, owner: 3, slot: 1 }
			]
		}
	],
	followUp: Option.some({
		owner: 2,
		row: 2,
		put: Option.none(),
		inserted: [],
		removed: Option.none(),
		appended: Option.none(),
		moved: Option.some({ id: 4, family: 0 })
	})
}

/**
 * The case the search found the served compile refusing (UnservedMember): R1 is a member of R0's ordered family and of
 * two counted families of R0, the first's owner axis copying R0's `v` into R1's c0. A follow-up puts an R0 row and
 * deletes R1's first member under it, re-placing the second: a re-placed counted member's copy of its owner's column is
 * a value the put leaves stale (analysis/theory/refill.ts), whose rows its own family's owner axis reaches, so R1's
 * removals statement draws it in the call's one flight, ahead of the put.
 */
const ownerPutBesideReplacedCountedMember: ClusterCase = {
	spec: {
		relations: [
			{ generated: noGeneration, mutable: true },
			{ generated: noGeneration, mutable: true }
		],
		families: [
			{ kind: "ordered", owner: 0, member: 1, fold: "count" },
			{ kind: "counted", owner: 0, member: 1, fold: "sum" },
			{ kind: "counted", owner: 0, member: 1, fold: "count" }
		],
		copies: [{ family: 1, axis: "owner", source: { kind: "caller" } }],
		steps: []
	},
	rows: [
		{ relation: 0, id: 1, v: 0n, memberOf: [] },
		{ relation: 0, id: 2, v: 0n, memberOf: [] },
		{
			relation: 1,
			id: 3,
			v: 0n,
			memberOf: [
				{ family: 0, owner: 2, slot: 0 },
				{ family: 1, owner: 1, slot: 0 },
				{ family: 2, owner: 1, slot: 0 }
			]
		},
		{
			relation: 1,
			id: 4,
			v: 0n,
			memberOf: [
				{ family: 0, owner: 2, slot: 1 },
				{ family: 1, owner: 1, slot: 0 },
				{ family: 2, owner: 1, slot: 0 }
			]
		}
	],
	followUp: Option.some({
		owner: 0,
		row: 2,
		put: Option.some(-1n),
		inserted: [],
		removed: Option.some({ id: 3, family: 0 }),
		appended: Option.none(),
		moved: Option.none()
	})
}

/**
 * A case whose specification's generated fields read fields grizzle draws or accumulates on their own row, admitted by
 * the reference by construction (fill.ts `generationDrawn`), with an instance and a written follow-up or none.
 */
export const generationCaseGen: Gen<ClusterCase> = caseOver(
	generationDrawn(
		mutableOrDrawn(admittedFillSpecGen({ relations: 4, families: 4, copies: 3 })),
		true
	),
	instanceGen,
	followUpGen
)

/**
 * A case aimed at an owner's put that refills a value over a copy of the owner's generated field reading a field
 * grizzle accumulates: R0's `g` the greater of its `v` and its ordered family's count or sum, R0's counted family's
 * owner axis copying `g` into R2's c0, which its sum fold steps, and a put of R0's first row (`ownerPutGen`), whose
 * refill reads `g` as the put leaves R0's row; R1 drawn as any relation.
 */
const ownerPutGeneratedGen: Gen<ClusterCase> = caseOver(
	(source) => ({
		relations: [
			{
				generated: {
					kind: "row",
					source: source.draw(boolean) ? { kind: "fold", family: 0 } : { kind: "count", family: 0 }
				},
				mutable: true
			},
			{
				generated: source.draw(boolean) ? generationOfV : noGeneration,
				mutable: source.draw(boolean)
			},
			{ generated: noGeneration, mutable: true }
		],
		families: [
			{ kind: "ordered", owner: 0, member: 1, fold: "sum" },
			{ kind: "counted", owner: 0, member: 2, fold: "sum" }
		],
		copies: [{ family: 1, axis: "owner", source: { kind: "generated" } }],
		steps: [{ kind: "copy", family: 1, copy: 0 }]
	}),
	instanceGen,
	(_, rows) => ownerPutGen(rows, 0)
)

/**
 * A case aimed at an append that draws a stored counted group whole (ir/fill.ts AppendStart `whole`): R0, mutable, owns a
 * counted family of R1, whose members copy along its owner axis R0's `g`, the greater of its `v` and its count of them,
 * and whose sum fold steps that copy; R1 mutable, holding `g` or not, as drawn. The follow-up appends to a stored R0
 * row's group and half the time puts that row (fill.ts `appendGen`): every member's copy changes with the count, so the
 * group's every fold plane and its end are drawn again over every member.
 */
const wholeAppendGen: Gen<ClusterCase> = caseOver(
	(source) => ({
		relations: [
			{ generated: { kind: "row", source: { kind: "count", family: 0 } }, mutable: true },
			{ generated: source.draw(boolean) ? generationOfV : noGeneration, mutable: true }
		],
		families: [{ kind: "counted", owner: 0, member: 1, fold: "sum" }],
		copies: [{ family: 0, axis: "owner", source: { kind: "generated" } }],
		steps: [{ kind: "copy", family: 0, copy: 0 }]
	}),
	(spec) => constant(fullInstance(spec)),
	(spec, rows) => appendGen(spec, rows, 0)
)

/**
 * A case aimed at a fold stepping a generated field that reads a column its family draws: R0 owning R1 in an ordered
 * or a counted family whose sum fold steps R1's `g`, the greater of R1's `v` and R1's index in the family, which the
 * family's own scan draws; R1 mutable or immutable as drawn. The reference admits and writes each (fill.ts verdictOf,
 * writesVerdict), as generationDrawn steps a generated field only where it does.
 */
const generatedStepGen: Gen<ClusterCase> = caseOver(
	(source) => ({
		relations: [
			{ generated: noGeneration, mutable: true },
			{
				generated: { kind: "row", source: { kind: "index", family: 0 } },
				mutable: source.draw(boolean)
			}
		],
		families: [
			{
				kind: source.draw(element(["ordered", "counted"] as const)),
				owner: 0,
				member: 1,
				fold: "sum"
			}
		],
		copies: [],
		steps: [{ kind: "generated", family: 0 }]
	}),
	instanceGen,
	followUpGen
)

/** What the generation suite must reach. */
export const generationSituations: Arr.NonEmptyReadonlyArray<ClusterSituation> = [
	"a generated field reading a field grizzle draws or accumulates",
	"a copy of a generated field reading a field grizzle draws or accumulates",
	"a fold stepping a generated field that reads a column its family draws",
	"a follow-up written over the stored instance",
	"an owner's put refilling a value over a copy of its generated field that reads a field grizzle accumulates",
	"a follow-up that draws a stored counted group whole"
]

/** The situations the generation suite reaches only now and then, each with the cases a witness draws while it is
 * pending. */
export const generationAims: ReadonlyArray<readonly [ClusterSituation, Gen<ClusterCase>]> = [
	["a fold stepping a generated field that reads a column its family draws", generatedStepGen],
	[
		"an owner's put refilling a value over a copy of its generated field that reads a field grizzle accumulates",
		ownerPutGeneratedGen
	],
	["a follow-up that draws a stored counted group whole", wholeAppendGen]
]

/**
 * The case a witness runs, drawn under its steering: while situations `aimed` reaches are pending, a case of one of
 * their aims, drawn among them, so no aim that seldom reaches its situation holds back the others; otherwise one of
 * `drawn`. The generator draws it, so it is the case the search runs, prints and keeps.
 */
export const steeredBy =
	(
		aimed: ReadonlyArray<readonly [ClusterSituation, Gen<ClusterCase>]>,
		drawn: Gen<ClusterCase>
	): Steered<ClusterCase, ClusterSituation>["under"] =>
	(steering) => {
		const open = Arr.filter(aimed, ([situation]) =>
			Option.exists(steering, (pending) => pending.has(situation))
		)
		return Arr.isReadonlyArrayNonEmpty(open) ? oneOf(Arr.map(open, ([, aim]) => aim)) : drawn
	}

/**
 * One case of the suite (see the module's header): the schema installed, the instance's first insert and then its
 * follow-up applied, each storing exactly the reference writer's rows, every generated field among them as rowEvaluator
 * computes it of the stored row, and the first insert's rows exactly those insertPreview gives.
 */
export const checkCase = (
	{ spec, rows, followUp }: ClusterCase,
	c: {
		readonly note: (situation: ClusterSituation) => void
		readonly noteAll: (situations: Iterable<ClusterSituation>) => void
	}
) =>
	Effect.gen(function* () {
		const built = buildFill(spec)
		const declared = built.rename("Fill")
		const done = yield* installFullWorld(declared, {}, { ambient: ordinarySession, label: "fill" })
		const value = built.rename(done.schema)
		const world = fullWorld(value, {})
		const relationAtName = (r: number) => defined(built.relations[relationName(r)])
		const facts = instanceFacts(spec, rows)
		/** The first insert: every relation a caller writes, each its own array member. */
		const first = Arr.reduce(insertedRelations(spec), ChangeSet.empty(value), (cs, r) =>
			cs.insert(relationAtName(r), [])
		)
		const firstInsert: Readonly<Record<string, ReadonlyArray<unknown>>> = Rec.fromEntries(
			Arr.map(insertedRelations(spec), (r): readonly [string, ReadonlyArray<unknown>] => [
				relationName(r),
				facts.get(r) ?? []
			])
		)
		const firstFacts: CallFacts = { insert: firstInsert }
		/**
		 * The follow-up, its members, and its served ChangeSet's array members: one per op and relation, at the
		 * first of its members, whose facts are every such member's in order, as its stratum's union holds them.
		 */
		const followed = Option.map(followUp, (f) => {
			const all = followUpMembers(spec, rows, f)
			return {
				followUp: f,
				members: all,
				slots: Arr.dedupeWith(all, (a, b) => a.op === b.op && a.relation === b.relation)
			}
		})
		const programs = Option.match(followed, {
			onNone: () => ({ first }),
			onSome: ({ slots }) => ({
				first,
				next: Arr.reduce(slots, ChangeSet.empty(value), (cs, m) => {
					const relation = relationAtName(m.relation)
					switch (m.op) {
						case "insert":
							return cs.insert(relation, [])
						case "put":
							return cs.put(relation, [])
						case "delete":
							return cs.delete(relation, [])
					}
				})
			})
		})
		/** The follow-up's call facts: under each op, each relation's facts. */
		const nextFacts = (
			all: ReadonlyArray<FollowUpMember>,
			held: ReadonlyArray<FollowUpMember>
		): CallFacts =>
			Rec.fromEntries(
				Arr.map(
					Arr.dedupe(Arr.map(held, (s) => s.op)),
					(op): readonly [string, Readonly<Record<string, ReadonlyArray<unknown>>>] => [
						op,
						Rec.fromEntries(
							Arr.map(
								Arr.filter(held, (s) => s.op === op),
								(s): readonly [string, ReadonlyArray<unknown>] => [
									relationName(s.relation),
									Arr.flatMap(
										Arr.filter(all, (x) => x.op === op && x.relation === s.relation),
										(x: FollowUpMember) => x.facts
									)
								]
							)
						)
					]
				)
			)
		yield* Effect.gen(function* () {
			const db = yield* openServedDb(done, world.server.roles.app, {})
			const flight = yield* oneFlight(db.ctx, done.as(world.server))
			const loaded = yield* db.load(programs)
			/** A member applied on the tapped context with its call's facts. */
			const applied = (name: string, callFacts: CallFacts) =>
				writeAnswerOf(
					writeOnce(memberCalls(flight.context, member(loaded, name)))({
						params: {},
						facts: callFacts
					})
				)
			const outcome = yield* flight.judged(
				"the instance's first insert",
				applied("first", firstFacts)
			)
			assert.equal(
				outcome.kind,
				rows.length === 0 ? "unchanged" : "accepted",
				`the instance's first insert of ${Formatter.format(spec)}`
			)
			const evaluate = succeeded(rowEvaluator<AnySchema>(value), "the case's schema evaluates")
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
						if (!holdsGenerated(spec, r)) {
							continue
						}
						for (const row of stored) {
							const admitted = succeeded(
								evaluate.admit(relation, Rec.remove(row, "g")),
								`a stored ${relationName(r)} row is admitted`
							)
							/** Its generated fields' items by name, which an AnyRelation's type cannot name. */
							const items: Readonly<Record<string, Result.Result<unknown, Unevaluated>>> = evaluate(
								relation,
								admitted
							).generated
							const g = succeeded(
								defined(items["g"], "the item of g"),
								`the host evaluates ${relationName(r)}.g`
							)
							assert.equal(
								g,
								row["g"],
								`${relationName(r)}.g after ${after}, as rowEvaluator computes it of the stored row`
							)
						}
					}
				})
			yield* stores(rows, "the first insert")
			const preview = succeeded(
				previewOver(value, inForce(bindFrame)),
				"the case's schema previews its insertions"
			)
			const previewed = preview(
				Rec.fromEntries(
					Arr.map(insertableNamesOf(value), (name) => [name, firstInsert[name] ?? []] as const)
				)
			)
			if (!previewed.ok) {
				return assert.fail(`the instance previews: ${Formatter.format(previewed.error)}`)
			}
			for (const [r] of spec.relations.entries()) {
				const relation = defined(built.relations[relationName(r)])
				const stored = yield* tableState(done, relation)
				unorderedEqual(
					defined(previewed.value[relationName(r)], `the preview's rows of ${relationName(r)}`),
					Arr.map(stored, (row) => Rec.remove(row, "g")),
					`${relationName(r)}'s rows the preview gives, as the first insert stores them`
				)
			}
			c.noteAll(shapesOf(spec))
			if (Option.isNone(followed)) {
				return
			}
			const { followUp: f, members, slots } = followed.value
			const second = yield* flight.judged(
				"the follow-up",
				applied("next", nextFacts(members, slots))
			)
			assert.equal(
				second.kind,
				"accepted",
				`the follow-up ${Formatter.format(members)} of ${Formatter.format(spec)}`
			)
			const after = followUpRows(rows, f)
			yield* stores(after, "the follow-up")
			c.note("a follow-up written over the stored instance")
			if (
				Arr.some(spec.copies, (copy, j) => {
					const family = familyAt(spec, copy.family)
					return (
						chainOf(spec, j) === "predecessor" &&
						Arr.some(members, (m) => m.relation === family.owner || m.relation === family.member)
					)
				})
			) {
				c.note("a follow-up over a chain along a predecessor axis")
			}
			const verdict = writesVerdict(
				spec,
				Arr.map(members, (m) => ({ relation: m.relation, op: m.op }))
			)
			if (Arr.isReadonlyArrayNonEmpty(verdict.stale)) {
				c.note("a follow-up that refills a value it leaves stale")
			}
			if (
				Arr.some(verdict.stale, (s) => Arr.some(spec.steps, (step) => step.family === s.family))
			) {
				c.note("a follow-up that refills a fold stepping a copy")
			}
			if (
				Arr.some(
					verdict.stale,
					(s) =>
						s.origin.op === "insert" &&
						s.reader.kind !== "owner" &&
						s.hops.length === 1 &&
						s.hops[0] === s.family
				)
			) {
				c.note("a follow-up that draws a stored counted group whole")
			}
			const replacedOwners = Arr.filter(
				after,
				(x) =>
					Arr.some(rows, (was) => was.id === x.id && replaced(spec, was, x)) &&
					Arr.some(after, (y) => Arr.some(y.memberOf, (m) => m.owner === x.id))
			)
			if (Arr.isReadonlyArrayNonEmpty(replacedOwners)) {
				c.note("a follow-up that re-places an owner of counted members")
			}
			if (
				Option.exists(f.moved, (moved) =>
					Arr.some(rows, (y) => Arr.some(y.memberOf, (m) => m.owner === moved.id))
				)
			) {
				c.note("a follow-up that moves an owner of counted members to another owner's group")
			}
			if (
				Option.exists(f.moved, (moved) =>
					Arr.some(
						spec.copies,
						(copy) =>
							copy.axis === "owner" &&
							copy.source.kind === "index" &&
							copy.source.family === moved.family &&
							Arr.some(rows, (y) =>
								Arr.some(y.memberOf, (m) => m.family === copy.family && m.owner === moved.id)
							)
					)
				)
			) {
				c.note("a follow-up that moves an owner whose counted members copy its index")
			}
			if (
				Option.isSome(f.put) &&
				(Arr.isReadonlyArrayNonEmpty(f.inserted) || Option.isSome(f.appended))
			) {
				c.note("an owner put in place beside an append to its family")
			}
			if (
				Option.isSome(f.put) &&
				relationAt(spec, f.owner).generated.kind === "row" &&
				Arr.some(
					verdict.stale,
					(s) =>
						s.changed.by === "put" &&
						Arr.some(
							spec.copies,
							(copy) =>
								copy.axis === "owner" &&
								copy.source.kind === "generated" &&
								familyAt(spec, copy.family).owner === f.owner &&
								Arr.some(
									s.passed,
									(passed) => passed === relationName(familyAt(spec, copy.family).member)
								)
						)
				)
			) {
				c.note(
					"an owner's put refilling a value over a copy of its generated field that reads a field grizzle accumulates"
				)
			}
		}).pipe(Effect.scoped)
	}).pipe(Effect.scoped)

/**
 * The planted cases the first-insert property kept by value, each a red it once caught, which the steered space reaches
 * beyond toolchain-test keep (717 s, all ten UNFOUND), recorded beside it (gen.ts recorded); a tenth, a delete
 * re-placing the members of an immutable relation, goes with the closed rule, under which no delete names a closed
 * relation's facts.
 */
export const recordedFirstInserts: Arr.NonEmptyReadonlyArray<ClusterCase> = [
	replacedOwner,
	replacedOwnerAppended,
	replacedOwnerBare,
	replacedCountedMember,
	ownerPutBesideAppend,
	generatedPredecessor,
	ownerPutBesideRemoval,
	movedSequenceCopy,
	ownerPutBesideReplacedCountedMember
]
