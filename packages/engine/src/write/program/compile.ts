import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { CheckedSchema, DerivedAnalysis } from "#compiler/analysis/schema.ts"
import { canonicalEquals, catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import { CompileError } from "#compiler/core/errors.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { type Certificate, localCertificate } from "#compiler/ir/certificate.ts"
import type { ClockBinding, ClockSource } from "#compiler/ir/clock.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import type { ChangeSetDesc } from "#compiler/ir/desc.ts"
import { isSequence, isTreeOf } from "#compiler/ir/family.ts"
import { appendStartOf, familyDrawn } from "#compiler/ir/fill.ts"
import { columnKeyOf, familyKey, type RelationInfo } from "#compiler/ir/law.ts"
import { type PhysicalNames, sessionTypeRef } from "#compiler/ir/physical.ts"
import {
	type CallerParamDecl,
	type ClockParamDecl,
	callerParams,
	clockedParams,
	type ProgramArtifacts,
	type StatementSpec
} from "#compiler/ir/products.ts"
import {
	boundParamsRead,
	type DeltaSide,
	edgesOf,
	type NodeOf,
	type RelDag,
	type RelNode
} from "#compiler/ir/rel.ts"
import type { ReadBack } from "#compiler/ir/write.ts"
import { type CatalogSchema, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { generations } from "#compiler/laws/model/generation.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { UniqueObject } from "#compiler/laws/model/uniques.ts"
import { evaluationWidth, readsOnlyParameters } from "#compiler/lower/conservative/call/index.ts"
import { type LowerContext, WriteParams } from "#compiler/lower/conservative/context.ts"
import type {
	BoundCarrier,
	BoundCarrierOf,
	DeclaredParamSlot,
	WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import { isPlainQuery } from "#compiler/lower/delivery.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import { partQuery, type TaggedPart } from "#compiler/lower/parts.ts"
import { keyedGroup } from "#compiler/lower/shapes/aggregate/index.ts"
import {
	type OptimizedDeliveryProgram,
	optimizedDispatch,
	type RelationChoice,
	type SentStatement,
	ShapeState
} from "#compiler/lower/shapes/index.ts"
import { noKeys } from "#compiler/lower/shapes/share/keyed.ts"
import { keySetReads } from "#compiler/lower/shapes/share/keys.ts"
import { type ShapeFacts, shapeFactsFromPlan } from "#compiler/lower/shapes/share/physical.ts"
import {
	type CarriedShare,
	noneHeld,
	planStatementShares,
	ShareIndex,
	StatementSharing
} from "#compiler/lower/shapes/share/statements.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { keyedUnion } from "#compiler/lower/shapes/union/index.ts"
import { sentHeading, sentSpec, specifiedProgram } from "#compiler/lower/template.ts"
import { oneForm } from "#compiler/runtime/lower/forms.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { EmittedText, Select, SqlStatement } from "#compiler/sql/ast.ts"
import {
	type CarrierScope,
	freshNames as startNames,
	type NameMap,
	NameSupply,
	type NameSupplyStart,
	namesPast
} from "#compiler/sql/naming.ts"
import {
	buildEmptyCarrier,
	buildFillCarrier,
	type CarrierDeclaring,
	type CarrierTyping,
	type WriteCarrier,
	carrierColumns,
	carrierRows,
	memberRows
} from "#compiler/write/carriers/carriers.ts"
import { relationUniques } from "#compiler/write/insert/unique.ts"

import {
	buildAnchoredDelete,
	buildDisplacingDelete,
	buildExactDelete
} from "#compiler/write/delete/exact.ts"

import {
	buildEntryCheck,
	type EntryCheck,
	type WriteWorld
} from "#compiler/write/entry/precheck.ts"

import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type { Binding } from "#compiler/runtime/write/binding.ts"
import { noExclusion, type StandUp, type WriteExclusion } from "#compiler/runtime/write/flight.ts"
import { sentLayout } from "#compiler/runtime/write/nesting.ts"
import type { FamilyWriteStep } from "#compiler/runtime/write/steps.ts"
import type { UniqueAbort, WriteStep } from "#compiler/runtime/write/steps.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { buildAdmission } from "#compiler/write/admission/statement.ts"
import { type AddedRows, unitSql } from "#compiler/write/delete/unit.ts"
import {
	type AppendedMember,
	additionsSql,
	type OwnerRows,
	type PutOwner,
	type RowSource
} from "#compiler/write/family/additions.ts"
import {
	type Deferring,
	type EditedMember,
	familyInputs,
	type RefillRoot,
	removalsSql
} from "#compiler/write/family/removals.ts"
import { memberFamilies, type RowLayout, rowLayout } from "#compiler/write/family/statements.ts"
import type { FamilyWriteSql } from "#compiler/write/family/written.ts"
import {
	compileChangeSet,
	type EditSlot,
	type EnumeratedInput,
	type MemberSlot,
	type SlotGroup,
	stratumLayouts,
	type WriteFrontend,
	type WrittenRelation
} from "#compiler/write/frontend/compile.ts"
import type { EntryClaims } from "#compiler/write/frontend/entry.ts"
import type { PlainRefill } from "#compiler/write/frontend/refill.ts"
import { type FamilyNode, sameNode } from "#compiler/write/frontend/schedule.ts"
import { distinctByEvidence, type WriteInput } from "#compiler/write/insert/input.ts"
import { buildInsert } from "#compiler/write/insert/protocol.ts"
import {
	type AdmissionResult,
	type DeleteResult,
	type InsertResult,
	type ModifyingStatement,
	ownStatement,
	StatementShare,
	type WriteContext,
	type WriteNames,
	type WriteStatement,
	writeContext
} from "#compiler/write/insert/statement.ts"
import { castsNothing, settledArtifact } from "#compiler/write/program/artifact.ts"
import {
	type ArtifactForms,
	DependencyTracker,
	type FormText,
	type PlacedStatement,
	type RidingReadBack,
	resultHeading,
	singleStatementSpec,
	type SentForm,
	type WriteArtifact,
	wholeText,
	writeStatementSpec
} from "#compiler/write/program/artifact.ts"
import { decideBinding, freshLayoutOf } from "#compiler/write/program/decide.ts"
import { insertOnly } from "#compiler/write/program/insert-only.ts"
import {
	freshNames,
	noRiding,
	type ReadBackPart,
	type Riding,
	ridingFamilyStatement,
	type SharedPart,
	type SingleStatement,
	singleStatement
} from "#compiler/write/program/single.ts"
import { withStagedSlots } from "#compiler/write/program/slot-carriers.ts"
import { writeStandUps } from "#compiler/write/program/stand-up.ts"
import {
	choosePutTargets,
	type ChosenTargets,
	chosenIn,
	type PutChoice
} from "#compiler/write/put/choose.ts"
import {
	buildMerge,
	buildUpdateFrom,
	buildUpsert,
	type PutStatement
} from "#compiler/write/put/statement.ts"
import {
	carriedFill,
	type DeltaCteName,
	type DeltaHeld,
	deltaAfter,
	deltaCte,
	deltaCteName,
	deltaIn,
	deltaTarget,
	emptyDelta,
	familyAddedCte
} from "#compiler/write/readback/deltas.ts"
import { type DeltasOf, deltaSourceIn, lowerReadBack } from "#compiler/write/readback/lower.ts"
import {
	type CarriedSide,
	type FormLack,
	type PlanAction,
	type PlannedWrite,
	type PlanStep,
	planWrite,
	readCommittedLack,
	type WritePlan
} from "#compiler/write/schedule/plan.ts"

/**
 * What a write's compile reads before its isolation level: every option but the level (`CompileWriteOptions`). The
 * prepared write (`PreparedWrite`) is made under these alone, so no step of it can read a level.
 */
export interface PrepareWriteOptions {
	/** The installed names the statements write (`InstallNames`, `schemaArtifacts`). */
	readonly names: WriteNames
	/** The names the members and read-backs read their relations under: reality's own, or a role's views
	 * (`SchemaArtifacts.reads`). */
	readonly reads: PhysicalNames
	/** Which contexts the Db holds a fact of. */
	readonly claims: EntryClaims
	/** What the compilation writes as: reality, or a role, whose filter functions its query entries' prechecks call. */
	readonly world: WriteWorld
	/** The schema's law model and its base's derived analysis (`SchemaArtifacts.laws`, `.derived`). */
	readonly laws: LawModel
	readonly derived: DerivedAnalysis
	/** Each parameter bound to the database's clock (write/frontend/compile.ts FrontendOptions `clock`), whose statements
	 * print it as the reading itself. */
	readonly clock: ClockBinding
	/** Where its readings of the clock count from (write/frontend/compile.ts FrontendOptions `source`). */
	readonly source: ClockSource
	/** Whose session tables its carriers are: the role it runs as, or reality (sql/naming.ts CarrierScope). */
	readonly carrierScope: CarrierScope
}

export interface CompileWriteOptions extends PrepareWriteOptions {
	/** The isolation the write runs at, which decides how its inserts meet stored rows (insert/protocol.ts
	 * Arbitration): a role's level, SERIALIZABLE wherever none is proved. */
	readonly level: Isolation
}

export interface CompiledWrite extends ProgramArtifacts<WriteParamSlot> {
	/** The isolation its statements were built for (CompileWriteOptions `level`), the one it is served and run at. */
	readonly level: Isolation
	/**
	 * What its transaction locks before its snapshot: nothing where it compiles; the relations its login fences that it
	 * writes once certification fences them (program/isolation/certification.ts).
	 */
	readonly exclusion: WriteExclusion
	readonly frontend: WriteFrontend
	readonly choices: ReadonlyArray<PutChoice>
	readonly plan: WritePlan
	/** The optimized artifact, the one an application runs. */
	readonly artifact: WriteArtifact
	/** The session objects its artifact's flight reads and writes, which its session stands up before its first call
	 * (write/program/stand-up.ts writeStandUps). */
	readonly standUps: ReadonlyArray<StandUp<EmittedText>>
	/** Where each family statement is placed in its stratum's schedule, which every realization places it by. */
	readonly placements: ReadonlyArray<FamilyPlacement>
	/**
	 * The admission of its caller parameters (write/admission/statement.ts), which every realization places first, before
	 * every stratum; none where no caller parameter has a check.
	 */
	readonly admission: WriteStatement<AdmissionResult> | undefined
	/**
	 * The parameters the members and read-backs declare that a call supplies, every one but those its member binds to the
	 * database's clock, and the enumerated member slots binding fills.
	 */
	readonly params: ReadonlyArray<CallerParamDecl>
	/** The parameters its member binds to the database's clock, which its statements print as the reading. */
	readonly clocked: ReadonlyArray<ClockParamDecl>
	readonly slots: ReadonlyArray<SlotGroup>
	/** What binding one application reads besides its values, decided here (decide.ts decideBinding). */
	readonly binding: Binding
}

/** What decides which of a write op's unique violations abort the apply: a MERGE; any other probed statement; or
 * none. */
type AbortKind =
	| { readonly kind: "merge" }
	| { readonly kind: "probed" }
	| { readonly kind: "other" }

/** The 23505 and 23P01 violations at a statement into `relation` that abort the apply: a MERGE insert at the primary
 * key its put targets, or at a unique object besides it, which compares every field of that key (`uniqueBesideKey`),
 * so it is the same concurrent commit; and a probed insert's, at every unique object besides its arbiter, which after
 * the probe only an occupant its snapshot did not see raises. */
export const uniqueAbortsOf = (
	relation: WrittenRelation,
	kind: AbortKind
): ReadonlyArray<UniqueAbort> => {
	const aborts = (
		objects: ReadonlyArray<UniqueObject>,
		reason: UniqueAbort["reason"]
	): ReadonlyArray<UniqueAbort> =>
		objects.map((u) => ({ constraint: u.name, relation: relation.name, reason }))
	const { arbiter, others } = relation.uniques
	switch (kind.kind) {
		case "other":
			return []
		case "probed":
			return aborts(others, "UnseenOccupant")
		case "merge":
			return aborts([arbiter, ...others], "PutTargetConflict")
	}
}

/** What a statement's input reads: the carriers it scans and the stored relations a described member reads. */
const inputReads = (inputs: ReadonlyArray<WriteInput>): ReadonlyArray<string> =>
	inputs.flatMap((input) =>
		input.kind === "carrier"
			? [`carrier:${input.carrier.name}`]
			: input.kind === "described"
				? input.node.meta.reads.map((r) => `relation:${r}`)
				: []
	)

/**
 * The carriers of the bound relation parameters a statement rooted at `roots` reads (ir/rel.ts boundParamsRead): the
 * carrier `bound` holds each in, filled first among its stratum's steps (write/schedule/plan.ts step `bound`); none
 * where the write carries none, as almost every write does.
 */
const boundReads = (
	bound: ReadonlyMap<ParamId, WriteCarrier>,
	roots: ReadonlyArray<RelNode>
): ReadonlyArray<string> =>
	bound.size === 0
		? []
		: [...boundParamsRead(roots)].map(
				(param) => `carrier:${defined(bound.get(param), "a carried bound input's carrier").name}`
			)

/** The nodes a planned write lowers: its described input, its exception's, and the region a deletion is anchored on. */
const plannedNodes = (planned: PlannedWrite): ReadonlyArray<RelNode> => {
	const inputs = [planned.input, ...(planned.op === "exactDelete" ? planned.except : [])]
	return [
		...inputs.flatMap((input) => (input.kind === "described" ? [input.node] : [])),
		...(planned.op === "anchoredDelete" ? [planned.anchor.region] : [])
	]
}

/**
 * The certificate of a share held at its keys (CarriedShare restriction, share.restricted): its copies, held as their
 * rows at the key set every read of theirs reads them at, the proof reading the copies and the nodes the key set reads
 * (keys.ts KeyAnalysis reads); none for a share that holds every row.
 */
const certifyRestriction = (facts: ShapeFacts, share: CarriedShare): void => {
	const restriction = share.restriction
	switch (restriction.kind) {
		case "whole":
			return
		case "keys": {
			const reads = [...new Set(keySetReads(restriction.keys).map((n) => n.id))]
			const copies = share.copies.map((c) => c.id)
			facts.certify(
				localCertificate(
					"share.restricted",
					[...copies, ...reads],
					copies,
					[...reads, ...copies],
					share.node.heading.map((c) => c.name)
				)
			)
		}
	}
}

/**
 * The evaluation key of `node` where a single statement holds its call's evaluation as a part of its own: a read of a
 * call's field that reads only parameters (readsOnlyParameters), by its evaluation key (lower/conservative/call/keys.ts
 * EvaluationKeys); undefined for every other node.
 */
const heldEvaluationKey = (cx: LowerContext, node: RelNode): string | undefined =>
	node.kind === "Call" && node.function.kind === "field" && readsOnlyParameters(cx, node)
		? cx.evaluationKey(node)
		: undefined

/**
 * The evaluations a single statement holds once each as a part of its own, which every part reads
 * (lower/shapes/share/statements.ts carryEvaluation): one per evaluation key (lower/conservative/call/keys.ts EvaluationKeys) of
 * the calls the field reads under `roots` read, each that reads only parameters (readsOnlyParameters), with the first
 * read of it, in the order the reads are met.
 */
const heldEvaluations = (
	cx: LowerContext,
	roots: ReadonlyArray<RelNode>
): ReadonlyArray<{ readonly read: NodeOf<"Call">; readonly key: string }> => {
	const seen = new Set<RelNode>()
	const keys = new Set<string>()
	const held: Array<{ readonly read: NodeOf<"Call">; readonly key: string }> = []
	const queue = [...roots]
	for (const node of queue) {
		if (seen.has(node)) {
			continue
		}
		seen.add(node)
		for (const input of edgesOf(node)) {
			queue.push(input)
		}
		const key = heldEvaluationKey(cx, node)
		if (key !== undefined && node.kind === "Call" && !keys.has(key)) {
			keys.add(key)
			held.push({ read: node, key })
		}
	}
	return held
}

/**
 * The parts a single statement holds before its writes, each read by the parts after it: the evaluations it holds
 * once each (heldEvaluations) and its shared sub-queries (`shares`), lowest first (ShareIndex height). A part reads
 * another only through a node below its own root, a call's read or a copy of a share, which stands strictly lower, so
 * each part follows every part it reads: an evaluation whose arguments hold a shared sub-query reads its CTE, and a
 * shared sub-query that reads a call's field reads its evaluation's. A share restricted by partners (CarriedShare
 * restriction) reads their parts too, so it stands past them (its height) and leads the parts of its height; a part
 * placed before it lowers its copies where they stand.
 */
const heldParts = (
	index: ShareIndex,
	cx: LowerContext,
	shares: ReadonlyArray<CarriedShare>,
	writes: ReadonlyArray<PlannedWrite>
): ReadonlyArray<
	| { readonly kind: "evaluation"; readonly read: NodeOf<"Call">; readonly key: string }
	| { readonly kind: "share"; readonly share: CarriedShare }
> =>
	[
		...heldEvaluations(cx, [
			...shares.map((share) => share.node),
			...writes.flatMap(plannedNodes)
		]).map(
			(held) =>
				({ kind: "evaluation", ...held, height: index.height(held.read), first: false }) as const
		),
		...shares.map(
			(share) =>
				({
					kind: "share",
					share,
					height: share.height,
					first: share.restriction.kind === "keys"
				}) as const
		)
	].toSorted((a, b) => a.height - b.height || Number(b.first) - Number(a.first))

export interface ArtifactBuilder {
	/** Each statement placed so far, a read-back's naming its read-back, with its audited AST for the carriers'
	 * analysis; its length is the position the next statement placed takes. */
	readonly statements: Array<PlacedStatement>
	/** The installation's codes, which a read-back's placeholders' encoders write a closed id's and a set's values by. */
	readonly codes: Codebook
}

export const newBuilder = (codes: Codebook): ArtifactBuilder => ({ statements: [], codes })

/** The member slots of an enumerated input whose facts a stratum inserts whole: a nested insert's own rows and a plain
 * insertion's. */
const insertingSlots = (input: EnumeratedInput): ReadonlyArray<MemberSlot> => {
	switch (input.kind) {
		case "nested":
			return [input.slot]
		case "single":
			return input.act.op === "insert" ? [input.slot] : []
	}
}

/** One family statement of a stratum, built once over the installed names (`familyProgram`), which the plan's step of
 * its node places where the stratum's schedule runs it. */
export interface FamilyPlacement {
	readonly stratum: StratumAt
	readonly node: FamilyNode
	readonly step: FamilyWriteStep
	readonly sql: FamilyWriteSql
}

/** The member slot `slot` names among the front end's slot groups: every edit's slot is one of them. */
const memberSlotOf = (frontend: WriteFrontend, slot: ParamId): MemberSlot =>
	defined(frontend.slotsById.get(slot), `the member slot ${slot}, an edit's`).slot

/** The relations a family placement reads and writes, which orders it against the artifact's other statements. */
const placementRelations = (placement: FamilyPlacement): ReadonlyArray<string> => [
	...new Set(placement.step.parts.map((p) => p.relation))
]

/**
 * A program's family statements (write/family/additions.ts, removals.ts, write/delete/unit.ts), built once over the
 * installed names: each family statement the schedule placed among a stratum's writes (frontend/schedule.ts
 * FamilyNode).
 */
const familyProgram = (
	frontend: WriteFrontend,
	w: WriteContext
): ReadonlyArray<FamilyPlacement> => {
	const all = frontend.laws.families
	/** Every stored relation of the schema, beyond the role's world: a family's statement names its owner, which a
	 * member's writer reads and counts through exactly the columns its installation grants it (the owner's key, count,
	 * ends and copies), whether or not its world holds the owner. */
	const stored: ReadonlyMap<string, RelationInfo> = new Map(
		[...frontend.laws.relations].map(([name, laws]) => [name, laws.relation] as const)
	)
	const info = (name: string) => defined(stored.get(name), `the family relation ${name}`)
	/** A family relation's row layout, read off the schema's own relation, which a role writes whole or scoped. */
	const layoutOf = (name: string): RowLayout => rowLayout(info(name), all)
	return strataAt(frontend.ir.strata).flatMap(([s, stratum]) =>
		stratum.family.map(({ node }): FamilyPlacement => {
			if (node.kind === "unit") {
				/** The rows the stratum adds of a unit's relation, which a doomed row is kept as: the rows its nested writes
				 * fill, where its one nesting lays it out (frontend/compile.ts stratumLayouts), else the facts of each slot that
				 * inserts it. */
				const addedOf = (relation: RelationInfo): ReadonlyArray<AddedRows> => {
					const at = stratumLayouts(frontend.nested, s).get(relation.name)
					if (at !== undefined) {
						return [{ kind: "nestedRows", stratum: s, layout: sentLayout(at.layout) }]
					}
					return frontend.slots.flatMap((group) =>
						group.stratum === s && group.relation.name === relation.name
							? group.inputs.flatMap((input): ReadonlyArray<AddedRows> =>
									insertingSlots(input).map((slot) => ({ kind: "slot", slot }))
								)
							: []
					)
				}
				const sql = unitSql({ ...w, start: ownStatement }, node.units, node.below, addedOf)
				const step: FamilyWriteStep = {
					kind: "familyWrite",
					stratum: s,
					statement: "unit",
					parts: sql.parts
				}
				return Object.freeze({ stratum: s, node, step: Object.freeze(step), sql })
			}
			const stratumEdits = frontend.edits.filter((edit) => edit.stratum === s)
			/** The families a family write draws its rows of `relation` by: every one it is a member of but its own tree,
			 * whose nodes the host's walk draws (write/family/nesting.ts). */
			const familiesOf = (relation: RelationInfo) =>
				memberFamilies(relation.name, all)
					.filter((f) => !isTreeOf(f, relation.name))
					.map((family) => ({
						family,
						drawn: familyDrawn(frontend.laws.theory.fill, relation.name, family),
						inputs: familyInputs(family, relation)
					}))
			/** The stratum's refills its family statements draw, by member relation (frontend/refill.ts StratumRefill). */
			const refilled: ReadonlyMap<string, ReadonlyArray<PlainRefill>> = frontend.refills.find(
				(r) => r.stratum === s
			)?.refill.members ?? new Map()
			/** The families a removals statement redraws its rows of `relation` by, at least one, each with the ways the
			 * stratum's puts of plain relations reach its members. */
			const removedFamilies = (relation: RelationInfo) => {
				const ways = refilled.get(relation.name) ?? []
				const own = familiesOf(relation).map((f) => ({
					...f,
					refills: (
						ways.find((r) => familyKey(r.family.id) === familyKey(f.family.id))?.ways ?? []
					).flatMap((way) =>
						way.root.kind === "recount" ? [] : [{ root: way.root, hops: way.hops }]
					)
				}))
				if (!isNonEmpty(own)) {
					throw defect(
						`the families of ${relation.name}, which a family removals statement redraws`
					)
				}
				return own
			}
			const slotOf = (slot: ParamId | undefined): MemberSlot | undefined =>
				slot === undefined ? undefined : memberSlotOf(frontend, slot)
			const ownerSlots = (op: "put" | "delete") =>
				frontend.slots.flatMap((group) =>
					group.stratum === s
						? group.inputs.flatMap((input) =>
								input.kind === "single" && input.act.op === op
									? [{ relation: group.relation.name, slot: input.slot }]
									: []
							)
						: []
				)
			const w0 = { ...w, start: ownStatement }
			/** The slots of the stratum that leave a group's recount to its additions (removals.ts Deferring). */
			const deferring: ReadonlyArray<Deferring> = [
				...stratumEdits.flatMap((edit) =>
					edit.slots.flatMap((e): ReadonlyArray<Deferring> =>
						e.as === "deletes"
							? []
							: [{ relation: edit.relation.name, slot: memberSlotOf(frontend, e.slot), as: e.as }]
					)
				),
				...[...ownerSlots("put"), ...ownerSlots("delete")].map((o) => ({
					...o,
					as: "owners" as const
				}))
			]
			/** The members an edit's refills rewrite in the statement (FamilyRemovals and FamilyAdditions `riders`). */
			const ridersOf = (names: ReadonlyArray<string>) =>
				names.map((name): EditedMember => {
					const rider = info(name)
					return {
						relation: rider,
						layout: layoutOf(name),
						puts: undefined,
						deletes: undefined,
						families: removedFamilies(rider)
					}
				})
			/**
			 * The members an additions statement of `appended` refills (FamilyAdditions `riders`), each from the rows it
			 * appends of it alone: the ways its edit's refills take into the rider, and a way along each counted family it
			 * owns whose member the rider is, which carries a moved row's counts and ends into its members' copies of them
			 * as the row is inserted again. Every such way starts at the append scan of a family `appended` is a member of,
			 * which holds every appended row whole.
			 */
			const appendRidersOf = (appended: RelationInfo, names: ReadonlyArray<string>) => {
				const root = memberFamilies(appended.name, all).find((f) => !isTreeOf(f, appended.name))
				return names.map((name): EditedMember => {
					const rider = info(name)
					return {
						relation: rider,
						layout: layoutOf(name),
						puts: undefined,
						deletes: undefined,
						families: mapNonEmpty(removedFamilies(rider), (f) => {
							const editWays = f.refills.filter(
								(way) => way.root.kind === "edit" && way.root.relation === appended.name
							)
							const owned =
								root !== undefined && f.family.owner.name === appended.name && !isSequence(f.family)
							return {
								...f,
								refills: owned
									? [
											...editWays.filter((way) =>
												way.hops.some((hop) => familyKey(hop.id) !== familyKey(f.family.id))
											),
											{
												root: { kind: "edit" as const, relation: appended.name, family: root },
												hops: [f.family] as const
											}
										]
									: editWays
							}
						})
					}
				})
			}
			if (node.kind === "additions") {
				/** The rows the stratum's nested writes fill, by relation, as the one nesting that lays each out sends them
				 * (frontend/compile.ts stratumLayouts, nesting.ts sentLayout), with the columns of them the walk fills, which
				 * they state. */
				const nestedRows = new Map(
					[...stratumLayouts(frontend.nested, s)].map(([relation, { nesting, layout: at }]) => {
						const stamps = nesting.stamps.get(relation) ?? []
						const stamped = new Set(stamps.map((st) => columnKeyOf(st.field.name)))
						const source: Extract<RowSource, { readonly kind: "nestedRows" }> = {
							kind: "nestedRows",
							stratum: s,
							layout: sentLayout({
								layout: at.layout,
								pending: new Set([...at.pending].filter((k) => !stamped.has(k)))
							}),
							walked: at.walked,
							stamps
						}
						return [relation, source] as const
					})
				)
				/** The member relations the statement appends, or, appending none, the one whose owners it recounts. */
				const members = node.appends === "rows" ? node.members : [node.member]
				/** Each appended relation's row sources: its slots, then its nested rows. */
				const sourced = new Map<string, [RowSource, ...Array<RowSource>]>()
				for (const edit of stratumEdits) {
					const slots = edit.slots.flatMap((e) => {
						if (e.as === "deletes") {
							return []
						}
						return [{ as: e.as, slot: memberSlotOf(frontend, e.slot), stamps: e.stamps }]
					})
					if (isNonEmpty(slots)) {
						sourced.set(edit.relation.name, [{ kind: "slots", slots }])
					}
				}
				for (const [name, source] of nestedRows) {
					const known = sourced.get(name)
					if (known === undefined) {
						sourced.set(name, [source])
					} else {
						known.push(source)
					}
				}
				const appended = [...sourced].flatMap(([name, sources]): ReadonlyArray<AppendedMember> => {
					if (!members.includes(name)) {
						return []
					}
					const relation = info(name)
					return [
						{
							relation,
							uniques: relationUniques(
								defined(frontend.laws.relations.get(name), `the laws of ${name}`)
							),
							layout: layoutOf(name),
							sources,
							families: familiesOf(relation).map((f) => ({
								family: f.family,
								drawn: f.drawn,
								start: appendStartOf(frontend.laws.theory.fill, relation.name, f.family),
								fresh: isSequence(f.family)
									? ({ kind: "none" } as const)
									: ({
											kind: "drawn",
											stratum: s,
											layout: freshLayoutOf(frontend, f.family, s),
											stamps:
												defined(frontend.fresh.get(s), `the fresh fill of stratum ${s}`).stamps.get(
													relation.name
												) ?? []
										} as const)
							})),
							owns: all.filter((f) => f.owner.name === name && !isSequence(f)),
							riders: appendRidersOf(
								relation,
								node.appends === "rows" ? node.riders.map((r) => r.relation) : []
							)
						}
					]
				})
				const putOwners = ownerSlots("put").flatMap(
					({ relation, slot }): ReadonlyArray<PutOwner> => {
						const recounted = all.filter(
							(f) =>
								f.owner.name === relation &&
								f.shape.kind !== "tree" &&
								members.includes(f.member.name)
						)
						const owner = info(relation)
						return isNonEmpty(recounted) && owner.mutable
							? [{ owner, slot, families: recounted }]
							: []
					}
				)
				const ownerCopies = node.appends === "rows" ? node.ownerCopies : []
				/** The rows of each owner whose copies the statement reads from its parameters (schedule.ts CopySource
				 * `held`), each source its frontend names (schedule.ts HeldOwner): a slot's facts or the stratum's nested
				 * rows. */
				const ownerRows = new Map(
					(node.appends === "rows" ? node.held : []).map(
						({ owner, rows }) =>
							[
								owner,
								mapNonEmpty(rows, (r): OwnerRows =>
									r.kind === "slot"
										? { kind: "slot", slot: memberSlotOf(frontend, r.slot) }
										: defined(
												nestedRows.get(owner),
												`the nested rows of ${owner} a held copy reads`
											)
								)
							] as const
					)
				)
				const sql = additionsSql(w0, appended, putOwners, ownerCopies, ownerRows, deferring, stored)
				const step: FamilyWriteStep = {
					kind: "familyWrite",
					stratum: s,
					statement: "additions",
					parts: sql.parts
				}
				return Object.freeze({ stratum: s, node, step: Object.freeze(step), sql })
			}
			const relation = info(node.member)
			const memberSlots = stratumEdits.find((e) => e.relation.name === node.member)?.slots ?? []
			/** The member's slot of `as`, none where the stratum edits it so in no slot. */
			const editSlotOf = (as: EditSlot["as"]): MemberSlot | undefined =>
				slotOf(memberSlots.find((e) => e.as === as)?.slot)
			const removing: EditedMember = {
				relation,
				layout: layoutOf(relation.name),
				puts: editSlotOf("puts"),
				deletes: editSlotOf("deletes"),
				families: removedFamilies(relation)
			}
			const roots = node.refilledFrom.map((root): RefillRoot => ({
				relation: info(root),
				slot: defined(
					ownerSlots("put").find((o) => o.relation === root),
					`the put of ${root} a refill reads`
				).slot
			}))
			const sql = removalsSql(
				w0,
				[removing, ...ridersOf(node.riders.map((r) => r.relation))],
				roots,
				deferring,
				stored
			)
			const step: FamilyWriteStep = {
				kind: "familyWrite",
				stratum: s,
				statement: "removals",
				parts: sql.parts
			}
			return Object.freeze({ stratum: s, node, step: Object.freeze(step), sql })
		})
	)
}

/**
 * The read-backs riding a family statement: `none`, or `riding`, its read-backs with what lowers them (`ridingFamily`).
 */
export type FamilyRiders =
	| { readonly kind: "none" }
	| {
			readonly kind: "riding"
			readonly readBacks: ReadonlyArray<ReadBack>
			readonly carries: ReadonlyArray<CarriedSide>
			readonly context: RidingContext
	  }

/**
 * Places the family statement of `node` in `stratum`, after the statements placed so far and those `deps` gives it,
 * with the read-backs `riders` riding it, each evaluated in it, and the sides it carries filled in it (`ridingFamily`).
 */
export const placeFamily = (
	b: ArtifactBuilder,
	placements: ReadonlyArray<FamilyPlacement>,
	stratum: StratumAt,
	node: FamilyNode,
	deps: (placement: FamilyPlacement) => ReadonlyArray<number>,
	riders: FamilyRiders
): void => {
	const placement = defined(
		placements.find((p) => p.stratum === stratum && sameNode(p.node, node)),
		"a family statement the schedule placed, built once"
	)
	const { step, sql } = placement
	const ridden =
		riders.kind === "riding"
			? ridingFamily(sql, riders.readBacks, riders.carries, riders.context)
			: { ast: sql.ast, sql: sql.sql, params: sql.params, width: sql.width, riders: [] }
	placeSpec(
		b,
		step,
		Object.freeze({
			sql: ridden.sql.text,
			paramSlots: ridden.params,
			heading: [
				{ name: "tag", type: plainType("int4") },
				...indices(ridden.width).map((i) => ({ name: `column ${i + 1}`, type: wildcardText }))
			],
			role: "member",
			dependsOn: Object.freeze([...deps(placement)])
		}),
		ridden.ast,
		ridden.sql.nameMap,
		wholeText,
		oneForm,
		ridden.riders
	)
}

/**
 * The family statement `sql` with the read-backs `readBacks` riding it and the sides `carries` carried out of it
 * (write/schedule/plan.ts placeReadBacks), and each riding read-back with where its rows stand among the statement's. A
 * relation's added side the statement inserts is one CTE over the rows its insert's RETURNING returns, every field in
 * heading order (write/readback/deltas.ts deltaCteName), and every other side of a relation it writes is the empty
 * relation: an additions statement removes nothing, and the root it inserts for a read-back is a stamped nesting's,
 * whose stamped rows meet no stored one. Each carried side is filled into its carrier from its CTE by a data-modifying
 * CTE after them (write/readback/deltas.ts carriedFill), a carried side of no CTE left empty. Each read-back is lowered
 * over those deltas, named past them and past every earlier read-back's, and is one part of the statement after the
 * family's parts, its rows behind its tag, every arm padded to the widest, as a single statement's riders are
 * (write/program/single.ts singleStatement). A read-back's statement rides in its first form.
 */
const ridingFamily = (
	sql: FamilyWriteSql,
	readBacks: ReadonlyArray<ReadBack>,
	carries: ReadonlyArray<CarriedSide>,
	context: RidingContext
): ReturnType<typeof ridingFamilyStatement> & {
	readonly riders: ReadonlyArray<RidingReadBack>
} => {
	const { frontend } = context
	const start = namesPast(sql.sql.nameMap, ownStatement)
	const named = new Map(
		frontend.deltas.flatMap((d) => (d.kind === "relation" ? [[d.relation.name, d] as const] : []))
	)
	const targetOf = (relation: string): string => deltaTarget(frontend.deltaEntries, relation)
	const supply = new NameSupply(start)
	const written = new Set<string>(sql.returnings.map((r) => r.relation))
	/** Each inserted relation's added side the read-backs name, a CTE over its insert's RETURNING. */
	const added = new Map<string, DeltaCteName>()
	const deltaCtes = sql.returnings.flatMap((r) => {
		const delta = named.get(r.relation)
		const read =
			readBacks.some((x) =>
				x.deltas.some((d) => targetOf(d.relation) === r.relation && d.side === "added")
			) || carries.some((c) => c.relation === r.relation && c.side === "added")
		if (delta === undefined || !read || r.result.kind !== "insert" || r.rows !== "facts") {
			return []
		}
		const cte = deltaCteName(delta.relation, "added", supply)
		added.set(r.relation, cte)
		return [familyAddedCte(r, cte)]
	})
	const fills = carries.flatMap((c) => {
		const cte = c.side === "added" ? added.get(c.relation) : undefined
		return cte === undefined ? [] : [carriedFill(supply.relation(carriedOrigin(c)), cte, c.carrier)]
	})
	const deltaNames: NameMap = supply.map()
	const held = (target: string, side: DeltaSide): DeltaHeld | undefined => {
		const cte = side === "added" ? added.get(target) : undefined
		if (cte !== undefined) {
			return { kind: "cte", cte: cte.cte, heading: cte.heading }
		}
		return written.has(target) ? { kind: "empty" } : emptyDelta(context.made, target, side)
	}
	const deltas: DeltasOf = (relation, side) =>
		deltaSourceIn(relation, frontend.deltaEntries, (target) => held(target, side))
	let cursor = namesPast(deltaNames, start)
	const placed = readBacks.map((read, at) => {
		const program = context.lower(read, deltas, cursor)
		const statement = program.statement
		cursor = namesPast(statement.sql.nameMap, cursor)
		const width = sentHeading(program.parts, program.roots).length
		const own = ridingPartOf(statement, width, new NameSupply(cursor))
		cursor = namesPast(own.part.nameMap, cursor)
		const tag = sql.parts.length + at
		const rider: RidingReadBack = Object.freeze({
			name: read.name,
			query: read.query,
			run: Object.freeze({
				delivery: program.delivery,
				parts: program.parts,
				roots: program.roots
			}),
			tag,
			part: own.shape
		})
		return { rider, part: own.part, tag }
	})
	return {
		...ridingFamilyStatement(sql, [...deltaCtes, ...fills], deltaNames, placed, cursor),
		riders: placed.map((p) => p.rider)
	}
}

/** What the statement filling a carried side's carrier writes, for the dependency tracker. */
const carriedAccess = (carried: CarriedSide): string => `carrier:${carried.carrier.name}`

/** What a carried side's fill CTE is named for (write/readback/deltas.ts carriedFill). */
const carriedOrigin = (carried: CarriedSide) =>
	({ kind: "internal", purpose: `carried ${carried.side} of ${carried.relation}` }) as const

/** A statement placed at the next position: its step, its spec, its audited AST, its forms and the read-backs riding
 * it. */
const placeSpec = (
	b: ArtifactBuilder,
	step: Extract<
		WriteStep,
		{
			readonly kind: "write" | "carrier" | "single" | "check" | "familyWrite" | "admission"
		}
	>,
	spec: StatementSpec<WriteParamSlot>,
	ast: SqlStatement,
	nameMap: WriteStatement["sql"]["nameMap"],
	text: FormText,
	forms: ArtifactForms,
	riders: ReadonlyArray<RidingReadBack>
): number => {
	const position = b.statements.length
	b.statements.push({
		kind: "own",
		step: Object.freeze(step),
		spec,
		ast,
		text,
		forms,
		riders,
		names: nameMap
	})
	return position
}

/** A statement of one form placed at the next position. */
export const placeStatement = (
	b: ArtifactBuilder,
	statement: WriteStatement | PutStatement,
	step: Extract<WriteStep, { readonly kind: "write" | "carrier" | "check" }>,
	dependsOn: ReadonlyArray<number>
): number =>
	placeSpec(
		b,
		step,
		writeStatementSpec(statement, dependsOn),
		statement.ast,
		statement.sql.nameMap,
		wholeText,
		oneForm,
		[]
	)

/** The form of a built statement as an execution sends it: its text, sent whole, its placeholders and its AST. */
const sentOf = (statement: {
	readonly sql: { readonly text: EmittedText }
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly ast: SqlStatement
}): SentForm =>
	Object.freeze({
		sql: statement.sql.text,
		params: statement.params,
		ast: statement.ast,
		text: wholeText
	})

/** A single statement's form as an execution sends it: its text, sent by its units, its placeholders and its AST. */
const partedSentOf = (single: SingleStatement): SentForm =>
	Object.freeze({
		sql: single.sql.text,
		params: single.params,
		ast: single.ast,
		text: partedText(single)
	})

/** A single statement's text, sent by its units. */
const partedText = (single: SingleStatement): FormText =>
	Object.freeze({ kind: "parted", units: single.units })

/**
 * The statement of the read-back `read`, lowered as `program`, placed after the artifact's statements so far, naming
 * its read-back and holding the statement it was lowered as, in its forms: its whole-relation variant its large form
 * when the read-back's optimized lowering made a per-execution choice in it.
 */
export const placeReadBack = (
	b: ArtifactBuilder,
	read: ReadBack,
	program: OptimizedDeliveryProgram<RelationChoice>,
	dependsOn: ReadonlyArray<number>
): void => {
	const run = specifiedProgram(program, b.codes)
	const spec = sentSpec(
		program.statement,
		program.parts,
		program.roots,
		(slot: DeclaredParamSlot) => slot
	)
	b.statements.push({
		kind: "readBack",
		of: Object.freeze({ name: read.name, query: read.query, run }),
		run: program.statement,
		spec: Object.freeze({
			...spec,
			role: "readBack",
			dependsOn: Object.freeze([...new Set(dependsOn)].toSorted((x, y) => x - y))
		}),
		ast: program.statement.ast,
		names: program.statement.sql.nameMap
	})
}

/** The admission `admission` placed first in `b`, before every stratum, after no statement: none where there is none. */
export const placeAdmission = (
	b: ArtifactBuilder,
	admission: WriteStatement<AdmissionResult> | undefined
): void => {
	if (admission !== undefined) {
		placeSpec(
			b,
			{ kind: "admission" },
			writeStatementSpec(admission, []),
			admission.ast,
			admission.sql.nameMap,
			wholeText,
			oneForm,
			[]
		)
	}
}

/**
 * The typing of a program's carriers (write/carriers/carriers.ts CarrierTyping): each column its value's session type
 * under `names` (ir/physical.ts sessionTypeRef). It holds `names` alone, never the compile that made it, which the
 * compiled write's plan, holding it, would keep alive.
 */
const sessionTyping =
	(names: PhysicalNames): CarrierTyping =>
	(t) =>
		sessionTypeRef(names, t)

/** The artifact of the statements built and their carriers. */
export const finish = (
	b: ArtifactBuilder,
	carriers: ReadonlyArray<WriteCarrier>,
	declaring: CarrierDeclaring
): WriteArtifact => settledArtifact(b.statements, Object.freeze([...carriers]), declaring)

/** How the optimized artifact's described members lower: its shape state, whose log holds the choices the statement
 * being lowered made in the per-execution mode it is lowered in, the sharing of sub-queries across its statements, and
 * the context its statements are built in. */
interface Lowering {
	readonly state: ShapeState<RelationInput>
	readonly sharing: StatementSharing
	readonly w: WriteContext
	/** The carrier each carried bound input's InputSets read, the read-backs' as the members' (WriteLowering `bound`). */
	readonly bound: BoundCarrierOf
}

/** The optimized artifact: the scheduled statements, each lowered in the small per-execution mode and, when its
 * lowering made a per-execution choice, lowered again in the large mode, its whole-relation form beside its LATERAL form
 * (`StatementForms`), as a query's statements carry their forms: both forms are one placement's, with its step and
 * result. Each member slot two or more statements read is staged once into a carrier (slot-carriers.ts), which those
 * statements read; the conservative realization, the write oracle's baseline, reads every slot's arrays itself. */
const optimizedArtifact = (
	frontend: WriteFrontend,
	plan: WritePlan,
	lowering: Lowering,
	admission: WriteStatement<AdmissionResult> | undefined,
	options: CompileWriteOptions
): WriteArtifact => {
	const staged = withStagedSlots(
		optimizedPlacement(frontend, plan, lowering, admission, options).statements,
		plan.carriers,
		plan.declaring
	)
	return settledArtifact(staged.statements, staged.carriers, plan.declaring)
}

/** The optimized artifact's statements, each with its forms.
 *
 * Every later statement reads the shared sub-query from the carrier just filled.
 *
 * Every later part reads the shared sub-query from its CTE.
 *
 * The read-back's other statements read what its first one reads. */
const optimizedPlacement = (
	frontend: WriteFrontend,
	plan: WritePlan,
	lowering: Lowering,
	admission: WriteStatement<AdmissionResult> | undefined,
	options: CompileWriteOptions
): ArtifactBuilder => {
	const { w, sharing, state } = lowering
	const b = newBuilder(w.cx.names.codes)
	placeAdmission(b, admission)
	/**
	 * A statement in its forms: built by `build` in the small per-execution mode, and, when that build made choices,
	 * built again in the large mode, whose sent form (`sent`) is its large form. Each build begins its statement
	 * afresh, with names and placeholders of its own; both forms are the one placement's.
	 */
	const formed = <S>(
		build: () => S,
		sent: (large: S) => SentForm
	): { readonly statement: S; readonly forms: ArtifactForms } => {
		state.begin("small")
		const statement = build()
		const choices = state.drain().choices
		if (!isNonEmpty(choices)) {
			return { statement, forms: oneForm }
		}
		state.begin("large")
		const large = sent(build())
		return { statement, forms: Object.freeze({ kind: "chosen", choices, large }) }
	}
	/** A single statement's parts built by `build` in the small per-execution mode, and, when that build made choices,
	 * built again in the large mode with those choices (`formed`). */
	const formedParts = (build: () => BuiltParts): FormedParts => {
		state.begin("small")
		const small = build()
		const choices = state.drain().choices
		if (!isNonEmpty(choices)) {
			return { small, large: undefined }
		}
		state.begin("large")
		return { small, large: { built: build(), choices } }
	}
	/** How the read-backs lower: over the installed names, each Delta node read where its program says. */
	const readBackOptions = {
		names: options.names,
		reads: options.reads,
		entries: frontend.deltaEntries,
		params: frontend.params,
		schema: frontend,
		templates: w.cx.templates,
		bound: lowering.bound
	}
	/** The statement `build` builds in its forms, placed after `dependsOn` with the step `step` gives of it. */
	const placed = <S extends WriteStatement | PutStatement>(
		build: () => S,
		dependsOn: ReadonlyArray<number>,
		step: (statement: S) => Extract<WriteStep, { readonly kind: "write" | "carrier" | "check" }>
	): number => {
		const { statement, forms } = formed(build, sentOf)
		return placeSpec(
			b,
			step(statement),
			writeStatementSpec(statement, dependsOn),
			statement.ast,
			statement.sql.nameMap,
			wholeText,
			forms,
			[]
		)
	}
	const tracker = new DependencyTracker()
	/** Each statement placed for an action so far, a membership check's under the addition it checks, with its position. */
	const recorded: Array<{ readonly action: PlanAction; readonly position: number }> = []
	const record = (action: PlanAction, position: number) => {
		recorded.push({ action, position })
	}
	/** The shared carriers a described member's statement reads, and the carriers of the bound inputs it reads. */
	const sharedReads = (node: RelNode): ReadonlyArray<string> => [
		...sharing.carriersRead(node).map((carrier) => `carrier:${carrier}`),
		...boundReads(plan.bound, [node])
	]
	/** What a read-back's statement reads: the relations its query reads, the bound inputs' carriers and the carriers of
	 * the delta sides it reads carried (WritePlan `carried`). */
	const readBackReads = (read: ReadBack): ReadonlyArray<string> => [
		...read.node.meta.reads.map((r) => `relation:${r}`),
		...boundReads(plan.bound, [read.node]),
		...read.deltas.flatMap((d) => {
			const carrier = plan.carried.get(deltaTarget(frontend.deltaEntries, d.relation))?.get(d.side)
			return carrier === undefined ? [] : [`carrier:${carrier.name}`]
		})
	]
	const describedReads = (inputs: ReadonlyArray<WriteInput>): ReadonlyArray<string> =>
		inputs.flatMap((input) => (input.kind === "described" ? sharedReads(input.node) : []))
	/** The statements an action's next statement follows: its own so far and those of the actions it depends on. */
	const actionDeps = (action: PlanAction): ReadonlyArray<number> =>
		recorded.flatMap((r) =>
			r.action.stratum === action.stratum &&
			(r.action.index === action.index || action.dependsOn.includes(r.action.index))
				? [r.position]
				: []
		)
	/** A planned write's step, of its statement `filled`. */
	const writeStep = (
		step: PlannedWrite,
		filled: ModifyingStatement<InsertResult> | ModifyingStatement<DeleteResult> | PutStatement
	): Extract<WriteStep, { readonly kind: "write" }> => ({
		kind: "write",
		stratum: step.action.stratum,
		action: step.action.index,
		relation: step.relation.name,
		result: filled.result,
		needs: filled.needs,
		uniqueAborts: uniqueAbortsOf(step.relation, abortsOf(step))
	})
	/** What a planned write reads and writes after which actions, for the dependency tracker. */
	const writeAccess = (
		step: PlannedWrite
	): readonly [ReadonlyArray<string>, ReadonlyArray<string>, ReadonlyArray<number>] => {
		const inputs = [step.input, ...(step.op === "exactDelete" ? step.except : [])]
		return [
			[...inputReads(inputs), ...describedReads(inputs), `relation:${step.relation.name}`],
			[`relation:${step.relation.name}`],
			actionDeps(step.action)
		]
	}
	/** The family statements, each placed where its stratum's schedule runs it (plan step `family`). */
	const families = familyProgram(frontend, w)
	/** What a family statement reads and writes, what its riding read-backs read and the carriers it fills, for the
	 * dependency tracker. */
	const familyDeps = (
		placement: FamilyPlacement,
		readBacks: ReadonlyArray<ReadBack>,
		carries: ReadonlyArray<CarriedSide>
	): ReadonlyArray<number> => {
		const relations = placementRelations(placement).map((r) => `relation:${r}`)
		const read = readBacks.flatMap(readBackReads)
		return tracker.add([...relations, ...read], [...relations, ...carries.map(carriedAccess)])
	}
	for (const step of plan.steps) {
		switch (step.kind) {
			case "bound": {
				/** A carried bound input's one evaluation, first among its stratum's statements: its carrier, which the
				 * session's stand-up of the write made, emptied, then filled from its query in the state the strata before
				 * it left, which every statement after it reads (ir/write.ts BoundInput). */
				const { input, carrier } = step
				placed(
					() => buildEmptyCarrier(w, carrier),
					tracker.add([], [`carrier:${carrier.name}`]),
					() => ({
						kind: "carrier",
						carrier: carrier.name,
						step: "empty",
						stratum: input.stratum,
						casts: castsNothing
					})
				)
				placed(
					() => buildFillCarrier(w, carrier, { kind: "member", node: input.node }),
					tracker.add(
						[
							...input.node.meta.reads.map((r) => `relation:${r}`),
							...boundReads(plan.bound, [input.node])
						],
						[`carrier:${carrier.name}`]
					),
					() => ({
						kind: "carrier",
						carrier: carrier.name,
						step: "fill",
						stratum: input.stratum,
						casts: castsNothing
					})
				)
				break
			}
			case "family":
				placeFamily(
					b,
					families,
					step.stratum,
					step.node,
					(placement) => familyDeps(placement, step.readBacks, step.carries),
					isNonEmpty(step.readBacks) || isNonEmpty(step.carries)
						? {
								kind: "riding",
								readBacks: step.readBacks,
								carries: step.carries,
								context: {
									frontend,
									made: plan.made,
									lower: (read, deltas, start) =>
										lowerReadBack(read, deltas, start, readBackOptions)
								}
							}
						: { kind: "none" }
				)
				break
			case "emptyCarrier": {
				const deps = tracker.add([], [`carrier:${step.carrier.name}`])
				placed(
					() => buildEmptyCarrier(w, step.carrier),
					deps,
					() => ({
						kind: "carrier",
						carrier: step.carrier.name,
						step: "empty",
						stratum: step.stratum,
						casts: castsNothing
					})
				)
				break
			}
			case "fillMember": {
				const reads = [
					...step.node.meta.reads.map((r) => `relation:${r}`),
					...sharedReads(step.node)
				]
				const deps = tracker.add(reads, [`carrier:${step.carrier.name}`])
				placed(
					() => buildFillCarrier(w, step.carrier, { kind: "member", node: step.node }),
					deps,
					() => ({
						kind: "carrier",
						carrier: step.carrier.name,
						step: "fill",
						stratum: step.stratum,
						casts: { kind: "member", relation: step.relation, stratum: step.stratum }
					})
				)
				break
			}
			case "fillShare": {
				const { share } = step
				const reads = [
					...share.node.meta.reads.map((r) => `relation:${r}`),
					...boundReads(plan.bound, [share.node])
				]
				const deps = tracker.add(reads, [`carrier:${step.carrier.name}`])
				/** A shared sub-query's fill lowers its own copies rather than reading the carrier it fills. */
				const fill = { ...w, cx: w.cx.withDispatch(sharing.filling(share)) }
				placed(
					() => buildFillCarrier(fill, step.carrier, { kind: "member", node: share.node }),
					deps,
					() => ({
						kind: "carrier",
						carrier: step.carrier.name,
						step: "fill",
						stratum: step.stratum,
						casts: castsNothing
					})
				)
				sharing.carry(share, {
					kind: "carrier",
					carrier: step.carrier.name,
					columns: carrierColumns(step.carrier)
				})
				break
			}
			case "write": {
				const position = placed(
					() => buildWriteOp(w, step),
					tracker.addAfter(...writeAccess(step)),
					(filled) => writeStep(step, filled)
				)
				record(step.action, position)
				break
			}
			case "single": {
				/** The shared sub-queries and the writes, each a statement of its own whose names start past the parts
				 * before it, and where the names after them start. */
				const buildParts = (): BuiltParts => {
					let start = ownStatement
					const shares: Array<SharedPart> = []
					sharing.clearEvaluations()
					/** A part of its own, of `width` columns, its query `lower`'s in a statement whose names start past the
					 * parts before it: the CTE every part after it reads it from. */
					const part = (width: number, lower: () => Select) => {
						const supply = new NameSupply(start)
						const placeholders = new WriteParams()
						w.cx.beginWriteStatement(supply, placeholders)
						const query = lower()
						const params = [...placeholders.slots]
						const names = freshNames(namesPast(supply.map(), ownStatement), width)
						start = names.next
						shares.push({
							name: names.relation,
							columns: names.columns,
							query,
							params,
							nameMap: [...supply.map(), ...names.nameMap]
						})
						return { kind: "enclosing", name: names.relation, columns: names.columns } as const
					}
					for (const held of heldParts(sharing.index, w.cx, step.shares, step.writes)) {
						switch (held.kind) {
							case "evaluation": {
								/** A call's evaluation every part reads, its arguments one statement's (StatementSharing evaluation). */
								const source = part(evaluationWidth(held.read), () =>
									sharing.evaluation(held.read, w.cx)
								)
								sharing.carryEvaluation(held.key, source)
								break
							}
							case "share": {
								const { share } = held
								const heading = share.node.heading.map((c) => ({ name: c.name, type: c.type }))
								/** A shared sub-query's CTE lowers its own copies rather than reading itself. */
								const source = part(heading.length, () => {
									const filling = { ...w, start, cx: w.cx.withDispatch(sharing.filling(share)) }
									return memberRows(filling, heading, share.node)
								})
								sharing.carry(share, source)
								break
							}
						}
					}
					const writes = mapNonEmpty(step.writes, (planned) => {
						const statement = buildWriteOp({ ...w, start }, planned)
						start = namesPast(statement.sql.nameMap, ownStatement)
						return { step: writeStep(planned, statement), statement }
					})
					sharing.clearEvaluations()
					return { shares, writes, start }
				}
				const position = b.statements.length
				const { single, writes, forms, riders } =
					isNonEmpty(step.readBacks) || isNonEmpty(step.carries)
						? ridingSingle(step.readBacks, step.carries, formedParts(buildParts), {
								frontend,
								made: plan.made,
								lower: (read, deltas, start) => lowerReadBack(read, deltas, start, readBackOptions)
							})
						: (() => {
								const plain = formed(
									() => {
										const built = buildParts()
										return { single: singleOf(built, noRiding), writes: built.writes }
									},
									(large) => partedSentOf(large.single)
								)
								return { ...plain.statement, forms: plain.forms, riders: [] }
							})()
				/** What the parts read, past the shared sub-queries the statement now carries, and what its riding
				 * read-backs read. */
				const accesses = mapNonEmpty(step.writes, (planned) => writeAccess(planned))
				const deps = tracker.addAfter(
					[...accesses.flatMap((x) => x[0]), ...step.readBacks.flatMap(readBackReads)],
					[...accesses.flatMap((x) => x[1]), ...step.carries.map(carriedAccess)],
					step.writes.flatMap((x) => actionDeps(x.action))
				)
				placeSpec(
					b,
					{
						kind: "single",
						stratum: step.stratum,
						parts: mapNonEmpty(writes, (x) => ({
							step: x.step,
							width: resultHeading(x.step.result).length
						})),
						uniqueAborts: writes.flatMap((x) => x.step.uniqueAborts)
					},
					singleStatementSpec(single, deps),
					single.ast,
					single.sql.nameMap,
					partedText(single),
					forms,
					riders
				)
				for (const x of step.writes) {
					record(x.action, position)
				}
				sharing.uncarry(step.shares)
				break
			}
			case "check": {
				const deps = tracker.addAfter(
					[...inputReads([step.input]), ...describedReads([step.input]), ...checkReads(step)],
					[],
					step.check.kind === "membership" && step.check.addition.kind === "action"
						? actionDeps(step.check.addition.action)
						: []
				)
				const position = placed(
					() => buildEntryCheck(w, step.input, entryCheckOf(step, frontend, options.world)),
					deps,
					(statement) => ({
						kind: "check",
						stratum: step.stratum,
						entry: statement.result.entry,
						needs: statement.needs
					})
				)
				if (step.check.kind === "membership" && step.check.addition.kind === "action") {
					record(step.check.addition.action, position)
				}
				break
			}
			case "readBack": {
				const deltas: DeltasOf = (relation, side) =>
					deltaSourceIn(relation, frontend.deltaEntries, (target) =>
						deltaAfter(plan.made, plan.carried, target, side)
					)
				const program = lowerReadBack(step.read, deltas, startNames, readBackOptions)
				placeReadBack(b, step.read, program, tracker.add(readBackReads(step.read), []))
				break
			}
		}
	}
	return b
}

/** A single statement's parts as one build in one per-execution mode makes them: its shared sub-queries, its writes,
 * each with its step, and where the names after them start (singleStatement `start`). */
interface BuiltParts {
	readonly shares: ReadonlyArray<SharedPart>
	readonly writes: NonEmptyReadonlyArray<{
		readonly step: Extract<WriteStep, { readonly kind: "write" }>
		readonly statement:
			| ModifyingStatement<InsertResult>
			| ModifyingStatement<DeleteResult>
			| PutStatement
	}>
	readonly start: NameSupplyStart
}

/** A single statement's parts in their forms: built in the small mode, and in the large mode with the choices the small
 * build made, where it made any. */
interface FormedParts {
	readonly small: BuiltParts
	readonly large:
		| { readonly built: BuiltParts; readonly choices: NonEmptyReadonlyArray<RelationChoice> }
		| undefined
}

/** The single statement of `built`'s parts, `riding` riding it. */
const singleOf = (built: BuiltParts, riding: Riding): SingleStatement =>
	singleStatement(
		built.shares,
		mapNonEmpty(built.writes, (x) => ({
			statement: x.statement,
			width: resultHeading(x.step.result).length
		})),
		riding,
		built.start
	)

/** Where the names of the single statement of `built`'s parts end: past its parts' names and each write part's own CTE
 * (single.ts singleStatement). */
const builtEnd = (built: BuiltParts): NameSupplyStart =>
	built.writes.reduce(
		(at, x) => freshNames(at, resultHeading(x.step.result).length).next,
		built.start
	)

/** The numbering past every name `a` and `b` are each past. */
const laterStart = (a: NameSupplyStart, b: NameSupplyStart): NameSupplyStart => ({
	relationStart: Math.max(a.relationStart, b.relationStart),
	columnStart: Math.max(a.columnStart, b.columnStart)
})

/**
 * A read-back's statement as a part of the statement it rides, the names its part adds drawn from `supply`, and the
 * part as the runtime reads it: one part's executable query numbered where it orders (lower/parts.ts partQuery); a
 * statement of tagged parts whole, its cells after the outer tag its own tag and cells, which the runtime divides
 * again (shapes/index.ts StatementParts).
 */
const ridingPartOf = (
	statement: SentStatement,
	width: number,
	supply: NameSupply
): { readonly part: ReadBackPart; readonly shape: TaggedPart } => {
	const nameMap = (): NameMap => [...statement.sql.nameMap, ...supply.map()]
	if (!isPlainQuery(statement.ast)) {
		return {
			part: { query: statement.ast, params: statement.params, nameMap: nameMap(), width },
			shape: { kind: "rows", width }
		}
	}
	const { query, columns, shape } = partQuery(statement.ast, supply)
	return {
		part: { query, params: statement.params, nameMap: nameMap(), width: columns.length },
		shape
	}
}

/** What riding a single statement reads beside its parts: the write's front end, the sides of the deltas some statement
 * makes, and how a read-back lowers over the deltas and naming start it is given. */
interface RidingContext {
	readonly frontend: WriteFrontend
	readonly made: WritePlan["made"]
	readonly lower: (
		read: ReadBack,
		deltas: DeltasOf,
		start: NameSupplyStart
	) => OptimizedDeliveryProgram<RelationChoice>
}

/**
 * The single statement of `formed`'s parts with the read-backs `readBacks` riding it and the sides `carries` carried
 * out of it (write/schedule/plan.ts placeReadBacks), in its forms, its writes as the small build made them, and each
 * riding read-back with where its rows stand among the statement's.
 *
 * Every delta a riding read-back names of a relation the statement writes, and every side it carries, is one CTE of the
 * statement over that write's RETURNING (write/readback/deltas.ts deltaCte), named once past every name either form's
 * parts define, so it has one name in both forms; a delta of a relation no statement writes is the empty relation.
 * Each carried side's carrier is filled from its CTE by a data-modifying CTE after them (write/readback/deltas.ts
 * carriedFill), named past them too; a side the write returns no rows of leaves its carrier empty. Each read-back is
 * lowered over those deltas, its statement named past them and past every earlier read-back's
 * (lower/conservative/types.ts ReadBackLowering start), and its statement is one part of the statement after the writes'
 * parts, in order, the names its part adds past all of those (`ridingPartOf`). The statement's
 * large form, where its writes or a read-back's statement made a per-execution choice, holds each part's large form,
 * a part of one form its own, and its choices are all of theirs.
 */
const ridingSingle = (
	readBacks: ReadonlyArray<ReadBack>,
	carries: ReadonlyArray<CarriedSide>,
	formed: FormedParts,
	context: RidingContext
): {
	readonly single: SingleStatement
	readonly writes: BuiltParts["writes"]
	readonly forms: ArtifactForms
	readonly riders: ReadonlyArray<RidingReadBack>
} => {
	const { small, large } = formed
	const { frontend } = context
	const start =
		large === undefined ? builtEnd(small) : laterStart(builtEnd(small), builtEnd(large.built))
	const named = new Map(
		frontend.deltas.flatMap((d) => (d.kind === "relation" ? [[d.relation.name, d] as const] : []))
	)
	const targetOf = (relation: string): string => deltaTarget(frontend.deltaEntries, relation)
	const supply = new NameSupply(start)
	/** Each delta a riding read-back names of a relation the statement writes, by relation and side, in the order of
	 * the statement's writes. */
	const names = new Map<string, Map<DeltaSide, DeltaCteName>>()
	for (const x of small.writes) {
		const relation = x.step.relation
		const delta = named.get(relation)
		const sides = new Set([
			...readBacks.flatMap((read) =>
				read.deltas.flatMap((d) => (targetOf(d.relation) === relation ? [d.side] : []))
			),
			...carries.flatMap((c) => (c.relation === relation ? [c.side] : []))
		])
		if (delta === undefined || sides.size === 0) {
			continue
		}
		const own = new Map<DeltaSide, DeltaCteName>()
		for (const side of deltaSides.filter((s) => sides.has(s))) {
			own.set(side, deltaCteName(delta.relation, side, supply))
		}
		names.set(relation, own)
	}
	/** Each carried side's fill CTE's name, in the order of `carries`. */
	const fillNames = carries.map((c) => supply.relation(carriedOrigin(c)))
	const deltaNames: NameMap = supply.map()
	const statementOf = (built: BuiltParts, relation: string) =>
		defined(
			built.writes.find((x) => x.step.relation === relation),
			`the write of ${relation} in the statement a read-back rides`
		).statement
	const held = (target: string, side: DeltaSide): DeltaHeld | undefined => {
		const cte = names.get(target)?.get(side)
		return cte === undefined
			? emptyDelta(context.made, target, side)
			: deltaIn(statementOf(small, target), cte)
	}
	const deltas: DeltasOf = (relation, side) =>
		deltaSourceIn(relation, frontend.deltaEntries, (target) => held(target, side))
	let cursor = namesPast(deltaNames, start)
	const placed = readBacks.map((read, at) => {
		const program = context.lower(read, deltas, cursor)
		const statement = program.statement
		cursor = namesPast(statement.sql.nameMap, cursor)
		if (statement.forms.kind === "chosen") {
			cursor = namesPast(statement.forms.large.sql.nameMap, cursor)
		}
		const width = sentHeading(program.parts, program.roots).length
		const own = ridingPartOf(statement, width, new NameSupply(cursor))
		cursor = namesPast(own.part.nameMap, cursor)
		const big =
			statement.forms.kind === "one"
				? undefined
				: ridingPartOf(statement.forms.large, width, new NameSupply(cursor))
		if (big !== undefined) {
			cursor = namesPast(big.part.nameMap, cursor)
		}
		const rider: RidingReadBack = Object.freeze({
			name: read.name,
			query: read.query,
			run: Object.freeze({
				delivery: program.delivery,
				parts: program.parts,
				roots: program.roots
			}),
			tag: small.writes.length + at,
			part: own.shape
		})
		return {
			rider,
			small: own.part,
			large: big?.part ?? own.part,
			choices: statement.forms.kind === "one" ? [] : statement.forms.choices
		}
	})
	const parts = placed
	const ridingIn = (built: BuiltParts, form: "small" | "large"): Riding => {
		const read = [...names].flatMap(([relation, sides]) => {
			const at = built.writes.findIndex((x) => x.step.relation === relation)
			const statement = statementOf(built, relation)
			return [...sides.values()].flatMap((cte) => {
				const one = deltaCte(statement, cte)
				return one === undefined ? [] : [{ cte: one, at }]
			})
		})
		const returned = new Set(read.map((d) => d.cte.name))
		return {
			deltas: read.map((d) => d.cte),
			fills: carries.flatMap((c, i) => {
				const cte = defined(
					names.get(c.relation)?.get(c.side),
					`the delta CTE of a side carried out of the statement`
				)
				return returned.has(cte.cte)
					? [carriedFill(defined(fillNames[i], "a carried side's fill name"), cte, c.carrier)]
					: []
			}),
			read: [...new Set(read.map((d) => d.at))],
			nameMap: deltaNames,
			parts: parts.map((p) => p[form])
		}
	}
	const single = singleOf(small, ridingIn(small, "small"))
	const choices = [...(large?.choices ?? []), ...parts.flatMap((p) => p.choices)]
	const riders = placed.map((p) => p.rider)
	if (!isNonEmpty(choices)) {
		return { single, writes: small.writes, forms: oneForm, riders }
	}
	const built = large?.built ?? small
	const largeSingle = singleOf(built, ridingIn(built, "large"))
	return {
		single,
		writes: small.writes,
		forms: Object.freeze({ kind: "chosen", choices, large: partedSentOf(largeSingle) }),
		riders
	}
}

/** Every side of a delta, in the order a statement names their CTEs. */
const deltaSides: ReadonlyArray<DeltaSide> = ["added", "removed", "met"]

/** The statement of one planned write op. */
const buildWriteOp = (
	w: WriteContext,
	step: PlannedWrite
): ModifyingStatement<InsertResult> | ModifyingStatement<DeleteResult> | PutStatement => {
	const { relation, input } = step
	switch (step.op) {
		case "insert":
			return buildInsert(w, { relation, input, of: "insert", stamps: step.stamps })
		case "exactDelete":
			return buildExactDelete(w, { relation, input, except: step.except })
		case "anchoredDelete":
			return buildAnchoredDelete(w, { relation, anchor: step.anchor })
		case "displace":
			return buildDisplacingDelete(w, { relation, input, differing: step.differing })
		case "putInsert":
			return buildInsert(w, { relation, input, of: "put", stamps: [] })
		case "upsert":
			return buildUpsert(w, {
				relation,
				input: step.input,
				inPlace: step.inPlace,
				arbiter: step.arbiter
			})
		case "updateFrom":
			return buildUpdateFrom(w, { relation, input, inPlace: step.inPlace })
		case "merge":
			return buildMerge(w, {
				relation,
				input,
				inPlace: step.inPlace,
				arbiter: step.arbiter,
				scope: step.scope
			})
	}
}

/** Which of a write op's unique violations abort the apply (uniqueAbortsOf). */
const abortsOf = (step: PlannedWrite): AbortKind => {
	switch (step.op) {
		case "insert":
		case "putInsert":
		case "upsert":
			return { kind: "probed" }
		case "merge":
			return { kind: "merge" }
		case "exactDelete":
		case "anchoredDelete":
		case "displace":
		case "updateFrom":
			return { kind: "other" }
	}
}

/** The duplicate-elimination placement the optimized artifact lowers its described members under, the same at every
 * level (PreparedWrite.place). No root of the write DAG observes repeats, because each consumer of a
 * member decides its own set boundary: a write statement reads it through SELECT DISTINCT unless distinctByEvidence
 * proves it distinct, a deletion ignores repeats, and a read-back is lowered on its own.
 * So the placement places a DISTINCT only where a node inside a member observes repeats, a fold, a
 * bound or a set form, and elides every other boundary the conservative realization emits, each elision under its
 * certificate. The conservative artifact keeps every boundary, and the write oracle compares the two. Its proofs
 * resolve keys through the schema's catalog: its constraints and its views' unique indexes,
 * named as the installation installs them. */
const placementOf = (dag: RelDag, schema: CatalogSchema): DedupPlan =>
	unwrap(
		placeDeduplication(dag, {
			context: "transaction",
			/** A write program records no constraint premise: its statements run in the transaction they prove for. */
			catalog: evidenceCatalog(schema),
			roots: "ignored"
		})
	)

/** The facts a compile at one level lowers by, over the write's placement, and the certificates its lowering records,
 * its own: each level's compile records into a list of its own. */
const writeFacts = (
	placement: DedupPlan
): { readonly facts: ShapeFacts; readonly certificates: ReadonlyArray<Certificate> } => {
	const certificates: Array<Certificate> = [...placement.certificates]
	const facts = shapeFactsFromPlan(placement, {
		derivedDefinition: false,
		certify: (certificate) => {
			if (!certificates.some((c) => canonicalEquals(c, certificate))) {
				certificates.push(certificate)
			}
		}
	})
	return { facts, certificates }
}

/** The check a planned check of a query entry builds: its membership against the base, under the role's names, which
 * the write is compiled as (`world`), or the refusal of a whole addition. A membership check exists only in a role's
 * compilation, whose frontend wrote a query entry: the frontend reads no installed name, so the names are the
 * compile's, never its frontend's. */
const entryCheckOf = (
	step: Extract<PlanStep, { readonly kind: "check" }>,
	frontend: WriteFrontend,
	world: WriteWorld
): EntryCheck => {
	const check = step.check
	if (check.kind === "outside") {
		return check
	}
	if (world.kind !== "role") {
		throw defect(
			`the check of the query entry ${check.entry.entry} in a write compiled as reality's, not its role's`
		)
	}
	const { relation } = check
	return {
		kind: "membership",
		entry: check.entry,
		relation,
		probes: check.probes,
		base: frontend.schema.definitions(),
		catalog: evidenceCatalog(frontend),
		world: world.names
	}
}

/** The relations a check of a query entry reads beside its input: the entry's target and every relation its filter
 * reads. */
const checkReads = (step: Extract<PlanStep, { readonly kind: "check" }>): ReadonlyArray<string> => {
	const check = step.check
	if (check.kind === "outside") {
		return []
	}
	const filter = check.entry.filter
	const read = filter.kind === "none" ? [] : [...queryUses(filter.query).relations]
	return [check.entry.target.name, ...read].map((r) => `relation:${r}`)
}

/**
 * A write compiled up to its isolation level: what its compile reads the same at every level, made once for each
 * ChangeSet and set of claims and compiled at each level a role reads it at (`compile`).
 *
 * It holds the write front end, the ChangeSetDesc checked against the schema and grouped into the WriteIR's actions
 * (compileChangeSet), and each put's target (choosePutTargets), which read the schema, the claims, the laws and the
 * clock but no level: `prepare` is given PrepareWriteOptions, which hold none; and so whether it has a READ COMMITTED
 * form (`readCommittedLack`, schedule/plan.ts), which its put targets decide, known before it compiles at any level.
 * Everything that reads the level is `compile`'s: the lowering's write context and the statements built over it. So
 * is everything a compile appends to as it lowers, made afresh at each level and never held here:
 * the facts whose certificates the lowering records (writeFacts), the statement share, the shape state and the share
 * index's memo, and its placement (`#place`), which reads no level but holds the physical analysis of the write's
 * whole DAG its facts read: each compile places the write for itself and drops the placement as it returns. A prepared
 * write holds no analysis beyond what its compiled write holds (`frontend`, the put choices).
 */
export class PreparedWrite {
	readonly schema: CheckedSchema
	readonly options: PrepareWriteOptions
	readonly frontend: WriteFrontend
	readonly chosen: ChosenTargets
	/**
	 * Why it has no READ COMMITTED form (schedule/plan.ts FormLack), its first insert's that has none; none where it has
	 * one. Its put targets decide it, so a role's compile reads it before compiling any member, and compiles a role with
	 * a member lacking one at SERIALIZABLE alone (program/workload/change.ts readCommittedChanges).
	 */
	readonly readCommittedLack: FormLack | undefined

	constructor(
		schema: CheckedSchema,
		options: PrepareWriteOptions,
		frontend: WriteFrontend,
		chosen: ChosenTargets
	) {
		this.schema = schema
		this.options = options
		this.frontend = frontend
		this.chosen = chosen
		this.readCommittedLack = readCommittedLack(chosen)
	}

	/**
	 * The write placed (PlacedWrite): its restated front end and the placement of its deduplication over the restated
	 * DAG (writeFacts), which read no level either. A placement holds the physical analysis its facts read, so the
	 * placed write is its one compile's and held by nothing past it (`compile`).
	 */
	#place(): Result.Result<PlacedWrite, CompileError> {
		return catchRefusal(() => {
			/** The optimized artifact lowers the restated write DAG (`WriteFrontend.restated`), its actions and read-backs
			 * each the restated node standing in its place, and each put its choice; the conservative realization lowers
			 * the checked one. */
			const restated: WriteFrontend = Object.freeze({ ...this.frontend, ...this.frontend.restated })
			const placement = placementOf(restated.ir.dag, this.frontend)
			return {
				compile: (level: Isolation): Result.Result<CompiledWrite, CompileError> =>
					catchRefusal(() => compileAt(this, restated, placement, level))
			}
		})
	}

	/**
	 * The write compiled at `level` (compileWrite's steps 3 to 5), placed for this compile alone (`#place`); refused at
	 * READ COMMITTED where it has no form there (NoReadCommittedForm, `readCommittedLack`), before it is placed.
	 */
	compile(level: Isolation): Result.Result<CompiledWrite, CompileError> {
		const lack = this.readCommittedLack
		if (level === "readCommitted" && lack !== undefined) {
			return Result.err(
				CompileError.make({
					_tag: "NoReadCommittedForm",
					at: childLoc(SourceLoc("ChangeSet", []), "writes", lack.relation),
					relation: lack.relation
				})
			)
		}
		return Result.flatMap(this.#place(), (placed) => placed.compile(level))
	}
}

/** A prepared write placed (PreparedWrite #place): compiled at a level from its placement. */
interface PlacedWrite {
	readonly compile: (level: Isolation) => Result.Result<CompiledWrite, CompileError>
}

const prepare = (
	schema: CheckedSchema,
	desc: ChangeSetDesc,
	options: PrepareWriteOptions
): PreparedWrite =>
	preparedOver(
		schema,
		unwrap(
			compileChangeSet(schema, desc, {
				claims: options.claims,
				laws: options.laws,
				derived: options.derived,
				codes: options.names.codes,
				clock: options.clock,
				source: options.source
			})
		),
		options
	)

/** A write prepared over its front end `frontend`, compiled already: its put targets chosen (steps 1 and 2). */
const preparedOver = (
	schema: CheckedSchema,
	frontend: WriteFrontend,
	options: PrepareWriteOptions
): PreparedWrite => new PreparedWrite(schema, options, frontend, choosePutTargets(frontend))

/**
 * A prepared write compiled at `level`: steps 3 to 5 of compileWrite, over the front end and put targets it holds, its
 * restated front end `restated` and the placement of its deduplication `placement` (PreparedWrite.place).
 */
const compileAt = (
	prepared: PreparedWrite,
	restated: WriteFrontend,
	placement: DedupPlan,
	level: Isolation
): CompiledWrite => {
	const { schema, frontend, chosen } = prepared
	const options: CompileWriteOptions = { ...prepared.options, level }
	const placed = writeFacts(placement)
	/** The statements every lowering below builds, shared where their requests are equal. */
	const share = new StatementShare()
	/** A write's described members lower statement by statement in each per-execution mode, and no CTE policy shares
	 * their stages. */
	const state = new ShapeState<RelationInput>("small", emptyCtePlan, noKeys)
	/**
	 * The templates of the compile's nodes (ir/dag-digest.ts DagTemplates), which its share planning's keys, its
	 * lowering's evaluation keys and attachment share keys and its read-backs' digests and lowerings all read, each
	 * node's written once for the compile.
	 */
	const templates = new DagTemplates()
	/**
	 * The carrier of each carried bound input, by its parameter, which every lowering below reads its InputSets through
	 * (BoundCarrierOf): the plan's, which the plan's carriers' typing reads this lowering to make, so it is held here once
	 * the plan is made, before any statement is lowered.
	 */
	const bound = new Map<ParamId, BoundCarrier>()
	const sharing = new StatementSharing(
		new ShareIndex(restated.ir.dag, templates),
		optimizedDispatch(placed.facts, state).dispatch,
		(node, cx, env, restriction) =>
			node.kind === "Union"
				? keyedUnion(placed.facts, node, cx, env, restriction)
				: keyedGroup(placed.facts, node, cx, env, restriction),
		placed.facts.fixed
	)
	const lowering: Lowering = {
		state,
		sharing,
		bound: (param) => bound.get(param),
		w: writeContext(restated.ir.dag, {
			names: options.names,
			reads: options.reads,
			params: frontend.params,
			dispatch: sharing.dispatch,
			share,
			level: options.level,
			generation: generations(options.laws, options.world),
			templates,
			bound: (param) => bound.get(param)
		})
	}
	const plan = planWrite(restated, chosenIn(chosen, frontend.restate), {
		distinct: (node, relation) => distinctByEvidence(placed.facts, node, relation),
		shares: (members, single) => {
			const shares = unwrap(
				planStatementShares(
					sharing.index,
					members,
					single ? (node) => heldEvaluationKey(lowering.w.cx, node) : noneHeld,
					single ? { kind: "byKeys", fixed: placed.facts.fixed } : { kind: "never" }
				)
			)
			for (const planned of shares) {
				certifyRestriction(placed.facts, planned)
			}
			return shares
		},
		carriers: {
			scope: options.carrierScope,
			typing: sessionTyping(options.names)
		}
	})
	for (const [param, carrier] of plan.bound) {
		bound.set(param, carrierRows(carrier))
	}
	const admission = buildAdmission(lowering.w, callerParams(frontend.params))
	const optimized = optimizedArtifact(restated, plan, lowering, admission, options)
	unwrap(insertOnly(schema, options.world, optimized.statements, options.names, options.laws))
	const program: CompiledWrite = {
		level: options.level,
		exclusion: noExclusion,
		kind: "write",
		context: "transaction",
		optimized: optimized.specs,
		certificates: placed.certificates,
		frontend,
		choices: chosen.choices,
		plan,
		artifact: optimized,
		standUps: writeStandUps(optimized, options.laws, options.names.schema),
		placements: familyProgram(restated, lowering.w),
		admission,
		params: callerParams(frontend.params),
		clocked: clockedParams(frontend.params),
		slots: frontend.slots,
		binding: decideBinding(frontend)
	}
	return program
}

/** The WriteProgram of a ChangeSet's Description against a checked schema.
 *
 * Compiling a ChangeSet into its WriteProgram.
 *
 * "WriteProgram: a ChangeSet's compiled artifacts: per stratum, the insert, delete, and put statements chosen per
 * relation, their RETURNING channels that form delta.added and delta.removed, netted across strata (added minus
 * later-removed, removed minus later-added), the read-back statements over the post-change state, the outcome decoders
 * for counts, reads, and witnesses. Reusable across sessions".
 * compileWrite builds it in five steps:
 *
 * 1. The write front end: the ChangeSetDesc checked against the schema and grouped into the WriteIR's actions
 *    (frontend/).
 * 2. The put targets: each put's statement, chosen with the proofs the whole ChangeSet and its DAG
 *    give.
 * 3. The schedule: the statements in order, each described member a leading CTE or a carrier, each read-back riding
 *    the one statement that makes its deltas, or after the strata where it reads none a statement makes, and each
 *    stratum where one snapshot suffices one single statement.
 * 4. The optimized artifact: each planned statement built by its package (insert/, delete/, carriers/, put/),
 *    a single statement's writes its parts, each riding read-back a part of its statement over that statement's
 *    RETURNING, and each read-back after the strata lowered over the post-change state, every stored relation a
 *    statement joins restricted to the keys of the rows it holds (write/probe.ts amongHeld), so no carrier is analyzed
 *    and none needs to be. The conservative realization, the write oracle's
 *    baseline, is no part of it (test/support/conservative.ts conservativeWrite).
 * 5. The template: its requirements, and the outcome: count rules, the witness decoder and the constraint-to-law map.
 *
 * A WriteProgram holds no parameter value; binding normalizes and encodes one application's inputs as their arrays,
 * and says which statements an empty input lets the runtime skip. */
export const compileWrite = (
	schema: CheckedSchema,
	desc: ChangeSetDesc,
	options: CompileWriteOptions
): Result.Result<CompiledWrite, CompileError> =>
	catchRefusal(() => {
		const { level, ...prepareOptions } = options
		return unwrap(prepare(schema, desc, prepareOptions).compile(level))
	})

/**
 * A ChangeSet's Description prepared against a checked schema (PreparedWrite): steps 1 and 2 of compileWrite, which
 * read no level, for PreparedWrite.compile to compile at each level it is read at.
 */
export const prepareWrite = (
	schema: CheckedSchema,
	desc: ChangeSetDesc,
	options: PrepareWriteOptions
): Result.Result<PreparedWrite, CompileError> => catchRefusal(() => prepare(schema, desc, options))

/**
 * A ChangeSet prepared over the front end another compile of it made (program/workload/compile.ts PlannedFrontends):
 * step 2 of compileWrite alone, the front end being the one prepareWrite would compile from `options`, which reads no
 * installed name, so a front end compiled over the same law model, role, claims and clock serves this compile's names.
 */
export const preparedWrite = (
	schema: CheckedSchema,
	frontend: WriteFrontend,
	options: PrepareWriteOptions
): Result.Result<PreparedWrite, CompileError> =>
	catchRefusal(() => preparedOver(schema, frontend, options))
