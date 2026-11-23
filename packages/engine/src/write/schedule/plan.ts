import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type NamedSide, type ReadBackCrossing } from "#compiler/core/errors.ts"
import type { EntryName, ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { headStamped, type Stamped } from "#compiler/ir/instant.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import { type DeltaSide, inputsOf, type RelNode } from "#compiler/ir/rel.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type { BoundInput, ReadBack } from "#compiler/ir/write.ts"
import type { CarriedShare } from "#compiler/lower/shapes/share/statements.ts"
import type { CarrierScope } from "#compiler/sql/naming.ts"
import {
	type CarrierTyping,
	type WriteCarrier,
	CarrierSupply
} from "#compiler/write/carriers/carriers.ts"
import { type DeleteAnchor, deleteAnchor } from "#compiler/write/delete/anchor.ts"
import type {
	MemberCheck,
	WriteFrontend,
	WrittenRelation
} from "#compiler/write/frontend/compile.ts"
import { refuseStampedStatements } from "#compiler/write/frontend/instants.ts"
import {
	type FamilyAt,
	type FamilyNode,
	familyNodeRelations
} from "#compiler/write/frontend/schedule.ts"
import { primaryKeyShape } from "#compiler/write/frontend/targets.ts"
import {
	type InputProof,
	keyUniqueByEvidence,
	outsideInput,
	type RelationInput,
	type RereadInput,
	unproved,
	type WriteInput
} from "#compiler/write/insert/input.ts"
import { writesMet } from "#compiler/write/insert/protocol.ts"
import { compareHeading, factHeading, keyFirst } from "#compiler/write/insert/statement.ts"
import type { OutsideProbe } from "#compiler/write/insert/unique.ts"

import {
	type ChosenAction,
	type ChosenTargets,
	differingOf,
	type InPlace,
	type KeyArbiter
} from "#compiler/write/put/choose.ts"
import type { MergeScope } from "#compiler/write/put/proof.ts"
import { deltaTarget } from "#compiler/write/readback/deltas.ts"

/** An action a planned statement realizes: its stratum, its position among the stratum's actions
 * (ir.strata[stratum].actions), and the positions there of the earlier actions that must complete first (`Action`), whose
 * statements the action's own follow. The planner makes one per action, and every statement of the action carries it. */
export interface PlanAction {
	readonly stratum: StratumAt
	readonly index: number
	readonly dependsOn: ReadonlyArray<number>
}

/** What a check of a query entry refuses: an addition's facts outside the entry or at a key a fact outside it holds; or
 * any fact of an addition the Db's claims leave outside the world. */
export type PlannedCheck =
	| {
			readonly kind: "membership"
			readonly entry: CheckedEntry
			/** The addition it checks, which follows it: an action's, or facts only a family statement writes
			 * (write/frontend/compile.ts MemberCheck), which no action does. */
			readonly addition:
				| { readonly kind: "action"; readonly action: PlanAction }
				| { readonly kind: "family" }
			readonly relation: WrittenRelation
			/** The unique objects it probes for a fact outside the entry: a query entry's every probe, a scoped entry's
			 * those its owner's rows do not determine (write/frontend/compile.ts WholeCheck). */
			readonly probes: ReadonlyArray<OutsideProbe>
	  }
	| { readonly kind: "outside"; readonly entry: EntryName }

/** A write action's statement by what it does, with what its builder reads beyond the action's own input: an insertion
 * or a put's insert half, an exact deletion with the stratum's additions it excepts (D EXCEPT A), a deletion whose
 * member is anchored on an occurrence of its relation with the anchor, a put's displacing deletion over the relation's
 * payload and its insert half, and the in-place puts with what their choice proved (an upsert reads its slot's
 * relation input, a MERGE carries the scope it was proved over); the deletion a MERGE absorbs has no statement of its
 * own. */
type WriteOpStep =
	| { readonly op: "insert"; readonly stamps: ReadonlyArray<Stamped> }
	| { readonly op: "exactDelete"; readonly except: ReadonlyArray<WriteInput> }
	| { readonly op: "anchoredDelete"; readonly anchor: DeleteAnchor }
	| { readonly op: "displace"; readonly differing: NonEmptyReadonlyArray<LawField> }
	| { readonly op: "putInsert" }
	| {
			readonly op: "upsert"
			readonly input: RelationInput
			readonly inPlace: InPlace
			readonly arbiter: KeyArbiter
	  }
	| { readonly op: "updateFrom"; readonly inPlace: InPlace }
	| {
			readonly op: "merge"
			readonly inPlace: InPlace
			readonly arbiter: KeyArbiter
			readonly scope: MergeScope
	  }

/** A write action's statement in a stratum. */
export type PlannedWrite = {
	readonly kind: "write"
	readonly action: PlanAction
	readonly relation: WrittenRelation
	readonly input: WriteInput
} & WriteOpStep

/** One step of a write plan:
 * - `bound`, a relation parameter the ChangeSet binds to a query that a later stratum or a read-back reads (ir/write.ts
 *   BoundInput): its carrier, which the session's stand-up of the write made, emptied and filled from its query before
 *   the first stratum, every reader's InputSet of it reading that carrier;
 * - `emptyCarrier`, a carrier emptied at the start of its stratum, a member's or a shared sub-query's, which the
 *   session's stand-up of the write made (runtime/write/flight.ts StandUp);
 * - `fillMember`, a member's carrier, filled from its node: the facts its action writes into `relation`, cast into its
 *   columns' types;
 * - `fillShare`, the carrier of a sub-query several statements of the stratum read, filled from the share's copy;
 * - a write action's statement;
 * - `single`, a stratum's write actions as one statement over one snapshot (see `planWrite`): each sub-query several of
 *   them read, a CTE of the statement, and each action's write, in action order, its member read inline or as a
 *   relation parameter, then the read-backs that ride it, a lone write with read-backs riding it among them;
 * - `readBack`, a read-back after the last stratum, one that reads no delta a statement writes;
 * - `check`, a query entry's check of an addition's facts, `input`;
 * - `family`, a family statement of the stratum (frontend/schedule.ts FamilyNode), where its schedule runs it among
 *   the stratum's writes. */
export type PlanStep =
	| { readonly kind: "bound"; readonly input: BoundInput; readonly carrier: WriteCarrier }
	| {
			readonly kind: "emptyCarrier"
			readonly carrier: WriteCarrier
			readonly stratum: StratumAt
	  }
	| {
			readonly kind: "fillMember"
			readonly carrier: WriteCarrier
			readonly node: RelNode
			/** The relation its action writes, by declared name, whose columns type the carrier. */
			readonly relation: StoredRelationName
			readonly stratum: StratumAt
	  }
	| {
			readonly kind: "fillShare"
			readonly carrier: WriteCarrier
			readonly share: CarriedShare
			readonly stratum: StratumAt
	  }
	| PlannedWrite
	| {
			readonly kind: "single"
			readonly stratum: StratumAt
			readonly shares: ReadonlyArray<CarriedShare>
			readonly writes: NonEmptyReadonlyArray<PlannedWrite>
			/** The read-backs riding the statement, evaluated in it over its writes' RETURNING (`placeReadBacks`). */
			readonly readBacks: ReadonlyArray<ReadBack>
	  }
	| { readonly kind: "readBack"; readonly read: ReadBack }
	| {
			readonly kind: "check"
			readonly stratum: StratumAt
			readonly input: WriteInput
			readonly check: PlannedCheck
	  }
	| {
			readonly kind: "family"
			readonly stratum: StratumAt
			readonly node: FamilyNode
			/** The read-backs riding the statement, evaluated in it over its inserts' RETURNING: a stamped nesting's
			 * root's, which its family statement inserts (`placeReadBacks`), none for any other. */
			readonly readBacks: ReadonlyArray<ReadBack>
	  }

export interface WritePlan {
	readonly steps: ReadonlyArray<PlanStep>
	/** The carrier of each carried bound input (step `bound`), by its parameter, which every reader of it reads. */
	readonly bound: ReadonlyMap<ParamId, WriteCarrier>
	readonly carriers: ReadonlyArray<WriteCarrier>
	/** Whose session tables its carriers are (PlanEvidence `carrierScope`), every later carrier of its program's too. */
	readonly carrierScope: CarrierScope
	/** The sides of each relation's delta some statement makes, by the relation's name; every other side, a world
	 * relation's whose definition reads nothing the ChangeSet writes included, is empty by construction. */
	readonly made: ReadonlyMap<string, ReadonlySet<DeltaSide>>
}

/** One statement of an action before its stratum's inputs are placed: an exact deletion's excepted additions are
 * the actions its draft reads after its own, and whether it is anchored is decided once its input is placed. */
type DraftStep =
	| Exclude<WriteOpStep, { readonly op: "exactDelete" | "anchoredDelete" }>
	| { readonly op: "exactDelete" }
	| {
			readonly op: "precheck"
			readonly entry: CheckedEntry
			readonly probes: ReadonlyArray<OutsideProbe>
	  }

/** A statement that writes its relation: every one but a query entry's precheck, which reads its input. */
type WriteStepDraft = Exclude<DraftStep, { readonly op: "precheck" }>

const isWriteStep = (step: DraftStep): step is WriteStepDraft => step.op !== "precheck"

/** One action of a stratum before its input is placed: the action as its statements name it, its statements in order,
 * and, for an exact deletion, the positions of the additions to its relation it excepts, which read their inputs at the
 * deletion too. */
interface ActionDraft {
	readonly at: PlanAction
	readonly action: ChosenAction
	readonly steps: ReadonlyArray<DraftStep>
	readonly excepts: ReadonlyArray<number>
}

/** The statement of an action that reads its input once: its one statement when it has one; none when several do, as
 * a query entry's precheck reads it before the addition. */
const loneStep = (steps: ReadonlyArray<DraftStep>): DraftStep | undefined => {
	const [only, ...rest] = steps
	return only === undefined || rest.length > 0 ? undefined : only
}

/** An action with its input placed: a described member read inline by the one statement that reads it, or an input
 * every statement of the action reads, a relation parameter or a carrier. */
type PlacedAction =
	| {
			readonly kind: "inline"
			readonly draft: ActionDraft
			readonly step: DraftStep
			readonly input: Extract<WriteInput, { readonly kind: "described" }>
	  }
	| { readonly kind: "reread"; readonly draft: ActionDraft; readonly input: RereadInput }

/** A write of a stratum realized as one statement, with the one statement its action has. */
interface LoneWrite {
	readonly draft: ActionDraft
	readonly step: WriteStepDraft
}

/** How a stratum is realized: as one statement of sibling data-modifying CTEs where one snapshot suffices, its writes
 * each its action's one statement; or one statement after another. */
type Realization =
	| { readonly kind: "single"; readonly writes: NonEmptyReadonlyArray<LoneWrite> }
	| { readonly kind: "sequential" }

/** A stratum realized as one statement where one snapshot suffices: its statements are writes of distinct relations, at
 * least two, each its action's only statement. No statement then reads what another writes, a deletion excepts no
 * addition, and every member reads the stratum's starting state, the statement's own snapshot. The front end makes a
 * stratum's sources of one operation on one relation one action (write/frontend/compile.ts compileChangeSet), so a
 * stratum writes one relation twice only by two operations, which the relation's immediate keys order, removals first,
 * or by an insert's sources written at two headings. */
const realizationOf = (drafted: ReadonlyArray<ActionDraft>): Realization => {
	const writes = drafted.flatMap((draft): ReadonlyArray<LoneWrite> => {
		const step = loneStep(draft.steps)
		return step !== undefined && isWriteStep(step) ? [{ draft, step }] : []
	})
	return isNonEmpty(writes) &&
		writes.length >= 2 &&
		writes.length === drafted.length &&
		new Set(writes.map((w) => w.draft.action.info.relation.name)).size === writes.length
		? { kind: "single", writes }
		: { kind: "sequential" }
}

/** A write statement of action `draft`, reading `input` and excepting the inputs `except`. A member read inline at an
 * exact deletion with no addition of its stratum to except, that is anchored on an occurrence of the relation, lets the
 * DELETE's target play that occurrence. */
const plannedWrite = (
	draft: ActionDraft,
	step: WriteStepDraft,
	input: WriteInput,
	except: ReadonlyArray<WriteInput>
): PlannedWrite => {
	const relation = draft.action.info.relation
	const at = { action: draft.at, relation, input }
	switch (step.op) {
		case "exactDelete": {
			const anchor =
				input.kind === "described" && except.length === 0
					? deleteAnchor(input.node, relation)
					: undefined
			return anchor === undefined
				? { kind: "write", ...at, op: step.op, except }
				: { kind: "write", ...at, op: "anchoredDelete", anchor }
		}
		case "insert":
		case "putInsert":
		case "displace":
		case "upsert":
		case "updateFrom":
		case "merge":
			return { kind: "write", ...at, ...step }
	}
}

/** A statement of action `draft` in a stratum realized one statement after another. */
const statementStep = (
	draft: ActionDraft,
	step: DraftStep,
	input: WriteInput,
	except: ReadonlyArray<WriteInput>
): PlanStep => {
	const relation = draft.action.info.relation
	switch (step.op) {
		case "precheck":
			return {
				kind: "check",
				stratum: draft.at.stratum,
				input,
				check: {
					kind: "membership",
					entry: step.entry,
					addition: { kind: "action", action: draft.at },
					relation,
					probes: step.probes
				}
			}
		case "exactDelete":
		case "insert":
		case "putInsert":
		case "displace":
		case "upsert":
		case "updateFrom":
		case "merge":
			return plannedWrite(draft, step, input, except)
	}
}

/** The statements of a placed action in a stratum realized one statement after another; `except` the inputs of the
 * additions an exact deletion excepts. */
const placedSteps = (
	placed: PlacedAction,
	except: ReadonlyArray<WriteInput>
): ReadonlyArray<PlanStep> => {
	const { draft } = placed
	switch (placed.kind) {
		case "inline":
			return [statementStep(draft, placed.step, placed.input, except)]
		case "reread":
			return draft.steps.map((step) => statementStep(draft, step, placed.input, except))
	}
}

/** The statements of one action, in order; a put's by the target its choice chose for it (see `planWrite`). */
const opsOf = (action: ChosenAction): ReadonlyArray<DraftStep> => {
	switch (action.op) {
		case "delete":
			return [{ op: "exactDelete" }]
		case "insert":
			return [...precheckOf(action), { op: "insert", stamps: action.info.stamps }]
		case "put":
			return putOps(action)
	}
}

/**
 * The precheck of an addition into a query entry, right before its insert statement, probing every unique object of
 * its relation as the entry reaches it; or of an addition through a scoped entry, right before its first statement,
 * probing the objects its check names (write/frontend/compile.ts WholeCheck); none for a whole write held to nothing.
 */
const precheckOf = (action: ChosenAction): ReadonlyArray<DraftStep> => {
	const entry = action.info.entry
	switch (entry.kind) {
		case "entry":
			return [
				{
					op: "precheck",
					entry: entry.entry,
					probes: action.info.relation.uniques.probes
				}
			]
		case "whole":
			return entry.check.kind === "scoped"
				? [
						{
							op: "precheck",
							entry: entry.check.entry,
							probes: entry.check.probes
						}
					]
				: []
	}
}

/** The precheck of a put through a scoped entry, before every form of its put: no form of a whole put meets a row
 * outside the owner's rows as the entry's law, so the precheck refuses one first. A put of any other target is
 * prechecked where its form inserts (`precheckOf`). */
const scopedPrecheckOf = (put: ChosenAction): ReadonlyArray<DraftStep> =>
	put.info.entry.kind === "whole" ? precheckOf(put) : []

/**
 * Why a write has no READ COMMITTED form (core/errors.ts NoReadCommittedForm): the relation of its first insert, in its
 * strata's order and each stratum's actions' order, that has none.
 */
export interface FormLack {
	readonly relation: string
}

/**
 * Whether an action's insert has no READ COMMITTED form: an insert into a span primary key, whose exclusion constraint
 * arbitrates by ON CONFLICT DO NOTHING alone, so no statement of the insert tells a requested fact it met from one it
 * made, where at SERIALIZABLE the insert arbitrates every object and classifies what it met itself (protocol.ts
 * Arbitration `every`). An insert, and a put whose target deletes then inserts or puts an owner's group, inserts so; no
 * other action does.
 */
const lacksForm = (action: ChosenAction): boolean =>
	(action.op === "insert" ||
		(action.op === "put" &&
			(action.choice.target === "deleteThenInsert" || action.choice.target === "ownerPut"))) &&
	primaryKeyShape(action.info.relation).kind === "span"

/**
 * Why the write of `chosen` has no READ COMMITTED form (FormLack), its first insert's that has none; none where every
 * insert has one. It reads the put targets alone, which read no level, so it is known before any compile: a compile at
 * READ COMMITTED refuses such a write before it places it (write/program/compile.ts PreparedWrite.compile), and
 * certification reads it as the condition `form` of the role it compiles, which then compiles and runs SERIALIZABLE
 * alone (program/workload/change.ts readCommittedChanges).
 */
export const readCommittedLack = (chosen: ChosenTargets): FormLack | undefined => {
	for (const { actions } of chosen.strata) {
		for (const action of actions) {
			if (lacksForm(action)) {
				return { relation: action.info.relation.name }
			}
		}
	}
	return undefined
}

/** The statements of a put's chosen target. */
const putOps = (put: Extract<ChosenAction, { readonly op: "put" }>): ReadonlyArray<DraftStep> => {
	const { choice } = put
	const relation = put.info.relation
	switch (choice.target) {
		case "deleteThenInsert": {
			const differing = differingOf(relation)
			return [
				...(differing === undefined ? [] : [{ op: "displace", differing } as const]),
				...precheckOf(put),
				{ op: "putInsert" }
			]
		}
		case "onConflictDoUpdate":
			return [
				...scopedPrecheckOf(put),
				{
					op: "upsert",
					input: choice.slot.input,
					inPlace: choice.inPlace,
					arbiter: choice.arbiter
				}
			]
		case "updateFrom":
			return [...scopedPrecheckOf(put), { op: "updateFrom", inPlace: choice.inPlace }]
		case "ownerPut":
			return [
				...precheckOf(put),
				...(choice.inPlace === undefined
					? []
					: [{ op: "updateFrom", inPlace: choice.inPlace } as const]),
				{ op: "putInsert" }
			]
		case "merge":
			return [
				...scopedPrecheckOf(put),
				{ op: "merge", inPlace: choice.inPlace, arbiter: choice.arbiter, scope: choice.merge.scope }
			]
	}
}

/** What the plan may rely on about a described member beyond the write DAG's own evidence: whether its rows, as the
 * artifact lowers them, are distinct (`distinctByEvidence`). */
interface PlanEvidence {
	readonly distinct: (node: RelNode, relation: RelationInfo) => boolean
	/** The sub-queries several of a stratum's member statements read, each statement rooted at one member's node, to be
	 * carried across them (`planStatementShares`); where one statement realizes the stratum (`single`), each evaluation
	 * it holds as a part of its own is a statement of the planning, the only one that reads its call's arguments. */
	readonly shares: (members: ReadonlyArray<RelNode>, single: boolean) => ReadonlyArray<CarriedShare>
	/** The type each carrier column is declared with, which the carrier's name digests (write/carriers CarrierTyping). */
	readonly carrierTyping: CarrierTyping
	/** Whose session tables its carriers are, which their names digest (sql/naming.ts CarrierScope). */
	readonly carrierScope: CarrierScope
}

/** The stored relations a member reads itself, not through a carried sub-query, whose carrier holds the state before
 * the stratum's writes. */
const directReads = (root: RelNode, carried: ReadonlySet<RelNode>): ReadonlyArray<string> => {
	if (carried.size === 0) {
		return root.meta.reads
	}
	if (carried.has(root)) {
		return []
	}
	const reads = new Set<string>()
	const seen = new Set<RelNode>([root])
	const queue = [root]
	for (const node of queue) {
		if (node.kind === "Base") {
			reads.add(node.relation)
		}
		const fresh = inputsOf(node).filter((input) => !seen.has(input) && !carried.has(input))
		for (const input of fresh) {
			seen.add(input)
			queue.push(input)
		}
	}
	return [...reads]
}

/** The positions of the additions to an exact deletion's relation that it excepts: every addition to it, or, for a
 * deletion of a relation parameter's facts, only the described ones; none that stamps an instant of the relation's
 * primary key, whose every fact is new: its stamp is past every instant stored at its child (write/insert/stamp.ts), so
 * no stored fact the deletion removes is one of them, and its rows carry no such instant to be compared at. None for
 * any other action. */
const exceptsOf = (
	actions: ReadonlyArray<ChosenAction>,
	action: ChosenAction
): ReadonlyArray<number> => {
	if (action.op !== "delete") {
		return []
	}
	const key = action.info.relation.primaryFields
	const additions = actions.flatMap((b, index) =>
		b.relation === action.relation &&
		b.op !== "delete" &&
		!headStamped(b.info.stamps).some((s) => key.some((f) => f.name === s.field.name))
			? [{ index, action: b }]
			: []
	)
	return (
		action.info.reads.kind === "described"
			? additions
			: additions.filter((o) => o.action.info.reads.kind === "described")
	).map((o) => o.index)
}

/** What the evidence proves of the rows of an action's described member `node`. */
const memberProof = (action: ChosenAction, node: RelNode, evidence: PlanEvidence): InputProof => ({
	distinct: action.op !== "delete" && evidence.distinct(node, action.info.relation),
	keyUnique:
		action.op === "delete" ? { kind: "unproved" } : keyUniqueByEvidence(node, action.info.relation)
})

/** An action's input read where its statement reads it: its slot's relation parameter, or its described member
 * inline. */
const sourceInput = (action: ChosenAction, evidence: PlanEvidence): WriteInput => {
	const reads = action.info.reads
	return reads.kind === "described"
		? { kind: "described", node: reads.node, proof: memberProof(action, reads.node, evidence) }
		: reads.slot.input
}

/**
 * The steps of stratum `stratum`'s family statements, each its statement after the prechecks of the facts `checks` it is
 * the first of the stratum's to write (write/frontend/compile.ts MemberCheck): a check reads the relation its statement
 * writes, so the statement follows it (program/artifact.ts DependencyTracker), and every earlier statement of the
 * stratum, an owner's insert a reached entry's membership reads among them, precedes it.
 */
const familyStepsOf = (
	stratum: StratumAt,
	checks: ReadonlyArray<MemberCheck>
): ((f: FamilyAt) => ReadonlyArray<PlanStep>) => {
	const checked = new Set<MemberCheck>()
	return (f) => {
		const written = familyNodeRelations(f.node)
		const due = checks.filter((c) => !checked.has(c) && written.includes(c.relation.name))
		for (const c of due) {
			checked.add(c)
		}
		return [
			...due.map((c): PlanStep => ({
				kind: "check",
				stratum,
				input: c.slot.input,
				check: {
					kind: "membership",
					entry: c.check.entry,
					addition: { kind: "family" },
					relation: c.relation,
					probes: c.check.probes
				}
			})),
			{ kind: "family", stratum, node: f.node, readBacks: [] }
		]
	}
}

/** The steps of stratum `stratum` realized one statement after another: each shared sub-query carried from the start
 * of the stratum; each described member read inline by the one statement that reads it when no earlier statement of
 * the stratum writes a relation it reads directly, and carried from the start of the stratum otherwise; then each
 * action's statements. */
const sequentialSteps = (
	stratum: StratumAt,
	drafted: ReadonlyArray<ActionDraft>,
	family: ReadonlyArray<FamilyAt>,
	familyStep: (f: FamilyAt) => ReadonlyArray<PlanStep>,
	shares: ReadonlyArray<CarriedShare>,
	supply: CarrierSupply,
	evidence: PlanEvidence
): ReadonlyArray<PlanStep> => {
	const steps: Array<PlanStep> = []
	for (const share of shares) {
		const carrier = supply.next(
			share.node.heading.map((c) => ({ name: c.name, type: c.type })),
			undefined
		)
		steps.push({ kind: "emptyCarrier", carrier, stratum })
		steps.push({ kind: "fillShare", carrier, share, stratum })
	}
	const carried = new Set(shares.flatMap((share) => share.copies))
	/** The relations the statements of the actions placed so far write. */
	const written = new Set<string>()
	const placeAction = (draft: ActionDraft): PlacedAction => {
		const { action } = draft
		const reads = action.info.reads
		if (reads.kind !== "described") {
			return { kind: "reread", draft, input: reads.slot.input }
		}
		const relation = action.info.relation
		const proof = memberProof(action, reads.node, evidence)
		const step = loneStep(draft.steps)
		if (
			step !== undefined &&
			!drafted.some((d) => d.excepts.includes(draft.at.index)) &&
			!directReads(reads.node, carried).some((r) => written.has(r))
		) {
			return { kind: "inline", draft, step, input: { kind: "described", node: reads.node, proof } }
		}
		const fields = keyFirst(relation).filter((f) =>
			action.info.heading.some((c) => c.name === f.name)
		)
		const heading = action.op === "delete" ? compareHeading(fields) : factHeading(fields)
		const carrier = supply.next(heading, undefined)
		steps.push({ kind: "emptyCarrier", carrier, stratum })
		steps.push({ kind: "fillMember", carrier, node: reads.node, relation: relation.name, stratum })
		return { kind: "reread", draft, input: { kind: "carrier", carrier, proof } }
	}
	/** The family statements that run before the action at `index`, which its member's statement then reads after. */
	const familyBefore = (index: number): ReadonlyArray<FamilyAt> =>
		family.filter((f) => f.at <= index)
	const placed = drafted.map((draft) => {
		for (const f of familyBefore(draft.at.index)) {
			for (const relation of familyNodeRelations(f.node)) {
				written.add(relation)
			}
		}
		const p = placeAction(draft)
		if (draft.steps.some(isWriteStep)) {
			written.add(draft.action.info.relation.name)
		}
		return p
	})
	const familyPlaced = new Set<FamilyAt>()
	const familySteps = (upTo: number): ReadonlyArray<PlanStep> =>
		family.flatMap((f): ReadonlyArray<PlanStep> => {
			if (f.at > upTo || familyPlaced.has(f)) {
				return []
			}
			familyPlaced.add(f)
			return familyStep(f)
		})
	for (const p of placed) {
		appendAll(steps, familySteps(p.draft.at.index))
		const except = placed
			.filter((q) => p.draft.excepts.includes(q.draft.at.index))
			.map((q) => q.input)
		appendAll(steps, placedSteps(p, except))
	}
	appendAll(steps, familySteps(Number.POSITIVE_INFINITY))
	return steps
}

/** The stored relations reading `relation` in `world` reads: in a role's program, a world relation's definition's (its
 * view's), a relation it holds whole itself; in reality's, the relation itself, a derived relation's view changing
 * only at its refresh. */
const storedReads = (
	world: WriteFrontend["schema"]["world"],
	relation: string
): ReadonlyArray<string> => {
	if (world.kind === "reality") {
		return [relation]
	}
	const held = world.role.relations[relation]
	return held === undefined || held.kind === "whole" ? [relation] : held.reads
}

/** The stored relations a step's statements change: a write's relation, a single statement's writes', a family
 * statement's; a carrier's and a check's change none. */
const stepWrites = (step: PlanStep): ReadonlyArray<string> => {
	switch (step.kind) {
		case "write":
			return [step.relation.name]
		case "single":
			return step.writes.map((w) => w.relation.name)
		case "family":
			return familyNodeRelations(step.node)
		case "bound":
		case "emptyCarrier":
		case "fillMember":
		case "fillShare":
		case "check":
		case "readBack":
			return []
	}
}

/** `relations` and every relation a cascading foreign key reaches from them: a statement that changes a referenced key
 * changes the rows referencing it at its end (ON UPDATE CASCADE), whatever relation the statement names. */
const withCascades = (
	relations: Iterable<string>,
	frontend: WriteFrontend
): ReadonlySet<string> => {
	const cascades = frontend.laws.natives.flatMap((n) =>
		n.object.kind === "ForeignKey" && n.object.onUpdate === "cascade"
			? [{ from: n.object.target.name, to: n.object.relation.name }]
			: []
	)
	const out = new Set(relations)
	const queue = [...out]
	for (const relation of queue) {
		for (const c of cascades) {
			if (c.from === relation && !out.has(c.to)) {
				out.add(c.to)
				queue.push(c.to)
			}
		}
	}
	return out
}

/** A statement that runs once and returns its writes' rows, which a read-back may ride: a lone write, a single
 * statement, or a family statement that inserts a stamped nesting's root (write/frontend/compile.ts readableRoots). */
type Rideable = Extract<PlanStep, { readonly kind: "write" | "single" | "family" }>

/** `step` with the read-backs `riders` riding it: a single statement's own or a family statement's, or a lone write's as
 * a single statement of that one write. */
const ridden = (step: Rideable, riders: NonEmptyReadonlyArray<ReadBack>): PlanStep => {
	switch (step.kind) {
		case "single":
		case "family":
			return { ...step, readBacks: riders }
		case "write":
			return {
				kind: "single",
				stratum: step.action.stratum,
				shares: [],
				writes: [step],
				readBacks: riders
			}
	}
}

/** Where each read-back runs: the strata's statements with the read-backs riding them, the read-backs after the last
 * stratum, which read no delta a statement makes, and the sides of each relation's delta some statement makes, every
 * other side empty by construction. */
interface ReadBackPlacement {
	readonly strata: ReadonlyArray<PlanStep>
	readonly after: ReadonlyArray<ReadBack>
	readonly made: ReadonlyMap<string, ReadonlySet<DeltaSide>>
}

/** The sides of its relation's delta a write's statement makes, by the rows it returns (write/program/artifact.ts
 * changeTags): an insertion's, a put's insert half's and an upsert's the facts they made present, an arbitrated
 * insertion's also the stored facts it met (insert/protocol.ts writesMet), a deletion's and a put's displacing
 * deletion's those they made absent, an update's and a MERGE's the facts made present and absent. */
const opSides = (write: PlannedWrite): ReadonlyArray<DeltaSide> => {
	switch (write.op) {
		case "insert":
			return writesMet(write.relation, "insert") ? ["added", "met"] : ["added"]
		case "putInsert":
		case "upsert":
			return ["added"]
		case "exactDelete":
		case "anchoredDelete":
		case "displace":
			return ["removed"]
		case "updateFrom":
		case "merge":
			return ["added", "removed"]
	}
}

/** Both sides of a relation's delta. */
const bothSides: ReadonlyArray<DeltaSide> = ["added", "removed"]

/** The side whose pending facts a statement's rows of `side` net against (runtime/write/net.ts): an addition cancels
 * a pending removal of the same fact, a removal a pending addition, and a met fact is no met one where an earlier
 * statement of the write added it. */
const nettedAgainst = (side: DeltaSide): DeltaSide => (side === "added" ? "removed" : "added")

/** One side of a relation's delta a statement of stratum `stratum` makes: by a write of it, or by a family statement,
 * which no read-back's delta names (frontend/compile.ts refuses one). */
type SideWrite = {
	readonly relation: string
	readonly side: DeltaSide
	readonly stratum: StratumAt
} & ({ readonly kind: "write"; readonly write: PlannedWrite } | { readonly kind: "family" })

/** The sides of the relations' deltas a step's statements make: a write's by its op, a single statement's by its
 * parts', a family statement's both sides of each relation it writes; a carrier's, a check's and a classification's
 * none. */
const stepSides = (step: PlanStep): ReadonlyArray<SideWrite> => {
	const ofWrite = (write: PlannedWrite): ReadonlyArray<SideWrite> =>
		opSides(write).map((side): SideWrite => ({
			kind: "write",
			relation: write.relation.name,
			side,
			stratum: write.action.stratum,
			write
		}))
	switch (step.kind) {
		case "write":
			return ofWrite(step)
		case "single":
			return step.writes.flatMap(ofWrite)
		case "family":
			return familyNodeRelations(step.node).flatMap((relation) =>
				bothSides.map((side): SideWrite => ({
					kind: "family",
					relation,
					side,
					stratum: step.stratum
				}))
			)
		case "bound":
		case "emptyCarrier":
		case "fillMember":
		case "fillShare":
		case "check":
		case "readBack":
			return []
	}
}

/**
 * Whether the rows of `other`, which makes the side `side` nets against (`nettedAgainst`), may cancel rows of `side` that
 * `maker` makes (runtime/write/net.ts). A met fact is no met one where any addition of the write made it, one of its own
 * stratum too. An addition and a removal cancel across strata, and in one stratum only where a family statement makes
 * either, whose fact may be one the stratum deletes, which the stratum's change nets (net.ts stratumChange). No other
 * write of a stratum removes a fact another of its writes adds (README "A row one stratum both
 * adds and deletes stays"): an exact deletion excepts the stratum's complete additions (`exceptsOf`, the host netting
 * two enumerated sides) and removes only a stored fact, a put's displacing deletion removes only an occupant other than
 * the fact the put names at its key (write/delete/exact.ts buildDisplacingDelete), and a complete addition makes present
 * only a fact its stratum did not hold.
 */
const cancels = (side: DeltaSide, maker: SideWrite, other: SideWrite): boolean =>
	side === "met" ||
	maker.kind === "family" ||
	other.kind === "family" ||
	maker.stratum !== other.stratum

/** Where a read-back's named side is made whole: the position of the one statement that makes it, or the crossing
 * that leaves it made by no one statement. */
type Completion =
	| { readonly kind: "at"; readonly position: number }
	| { readonly kind: "crossing"; readonly crossing: ReadBackCrossing }

/**
 * The read-backs placed by their data dependencies among the strata's statements `strata`, each riding the one
 * statement that makes every delta it reads, or after the last stratum where it reads no delta a statement writes;
 * any other is refused as ReadBackCrossesStatements.
 *
 * A read-back reads the deltas it names and the post-change state of the relations it reads. A delta is what its
 * relation's write statements return, and those rows exist only inside the statement that returns them, so a read-back
 * over a delta some statement writes is evaluated inside the one statement S that makes every side it names, over S's
 * RETURNING (write/readback/deltas.ts deltaCte), and its delta never leaves S. That is sound exactly where:
 *
 * - every side it names is made whole by S: S is the only statement that makes that side of the relation, and no
 *   other statement that makes the side it nets against (`nettedAgainst`) may cancel S's rows (`cancels`): an addition
 *   and a removal made by writes of one stratum never do, but for a family statement's and a generated addition's; so
 *   S's rows of the side are the netted delta (runtime/write/net.ts);
 * - no statement at or after S writes a stored relation it reads as state, directly, through a role's view, or through
 *   a cascading foreign key, S's own writes included: S's snapshot is from before S's own writes, and the state after S
 *   is the state after the last stratum only where no later statement changes it.
 *
 * Each crossing is refused as the one it is: a named side two statements make, or one whose netting another statement
 * takes part in (`sideWrittenTwice`); two named sides that two statements make (`sidesApart`); and state written at or
 * after the statement that makes the delta (`stateAfter`). A stratum whose order would write a relation such a
 * read-back reads as state after its delta's relation is ordered again with the delta's relation last where no key
 * orders it (frontend/compile.ts, frontend/schedule.ts canonicalActionOrder), so the state it reads is written before the
 * statement it rides wherever the stratum's keys allow it.
 *
 * A side of a relation's delta no statement makes is empty by construction, as is a relation's no statement writes and
 * a world relation's whose definition reads nothing the ChangeSet writes (`NamedDelta` "empty"): every read-back reads
 * it as the empty relation, and a read-back that names no other side runs after the last stratum.
 */
const placeReadBacks = (
	frontend: WriteFrontend,
	strata: ReadonlyArray<PlanStep>
): ReadBackPlacement => {
	const sides = strata.map(stepSides)
	const writes = strata.map(stepWrites)
	const targetOf = (relation: string): string => deltaTarget(frontend.deltaEntries, relation)
	const made = new Map<string, Set<DeltaSide>>()
	for (const write of sides.flat()) {
		const own = made.get(write.relation) ?? new Set<DeltaSide>()
		own.add(write.side)
		made.set(write.relation, own)
	}
	/** The writes, by position, of `side` of `relation`'s delta. */
	const makers = (relation: string, side: DeltaSide) =>
		sides.flatMap((own, position) =>
			own.flatMap((write) =>
				write.relation === relation && write.side === side ? [{ position, write }] : []
			)
		)
	/** Where the side `named` is made whole. */
	const completion = (named: NamedSide): Completion => {
		const twice: Completion = { kind: "crossing", crossing: { kind: "sideWrittenTwice", ...named } }
		const [maker, ...others] = makers(named.relation, named.side)
		if (maker === undefined) {
			throw defect(`a statement making the ${named.side} side of ${named.relation}'s delta`)
		}
		if (others.length > 0) {
			return twice
		}
		const netting = makers(named.relation, nettedAgainst(named.side)).filter(
			(other) => other.position !== maker.position && cancels(named.side, maker.write, other.write)
		)
		return netting.length === 0 ? { kind: "at", position: maker.position } : twice
	}
	/** The statement `read` rides, or the crossing that leaves it no statement to ride; none where it reads no delta a
	 * statement writes. */
	const placement = (
		read: ReadBack
	):
		| { readonly kind: "after" }
		| { readonly kind: "rides"; readonly step: Rideable }
		| { readonly kind: "crossing"; readonly crossing: ReadBackCrossing } => {
		const named = read.deltas.flatMap((d) => {
			const relation = targetOf(d.relation)
			return made.get(relation)?.has(d.side) === true ? [{ relation, side: d.side }] : []
		})
		const [first, ...rest] = named
		if (first === undefined) {
			return { kind: "after" }
		}
		const at = completion(first)
		if (at.kind === "crossing") {
			return at
		}
		for (const side of rest) {
			const other = completion(side)
			if (other.kind === "crossing") {
				return other
			}
			if (other.position !== at.position) {
				return { kind: "crossing", crossing: { kind: "sidesApart", first, second: side } }
			}
		}
		const position = at.position
		const step = strata[position]
		if (
			step?.kind !== "write" &&
			step?.kind !== "single" &&
			!(step?.kind === "family" && step.node.kind === "additions" && step.node.appends === "rows")
		) {
			throw defect(`a read-back's delta made by a statement no read-back rides, at ${position}`)
		}
		const later = withCascades(writes.slice(position).flat(), frontend)
		const state = read.node.meta.reads.find((r) =>
			storedReads(frontend.schema.world, r).some((s) => later.has(s))
		)
		return state === undefined
			? { kind: "rides", step }
			: { kind: "crossing", crossing: { kind: "stateAfter", delta: first, state } }
	}
	const riders = new Map<Rideable, [ReadBack, ...Array<ReadBack>]>()
	const after: Array<ReadBack> = []
	const changeSet = SourceLoc("ChangeSet", [])
	for (const read of frontend.ir.reads) {
		const placed = placement(read)
		switch (placed.kind) {
			case "after":
				after.push(read)
				break
			case "crossing":
				throw new Refusal(
					CompileError.make({
						_tag: "ReadBackCrossesStatements",
						at: childLoc(changeSet, "reads", read.name),
						read: read.name,
						crossing: placed.crossing
					})
				)
			case "rides": {
				const riding = riders.get(placed.step)
				if (riding === undefined) {
					riders.set(placed.step, [read])
				} else {
					riding.push(read)
				}
			}
		}
	}
	return {
		strata: strata.map((step) => {
			if (step.kind !== "write" && step.kind !== "single" && step.kind !== "family") {
				return step
			}
			const riding = riders.get(step)
			return riding === undefined ? step : ridden(step, riding)
		}),
		after,
		made
	}
}

/** The sequence of statements a compiled ChangeSet runs inside its one transaction, from the write front end's order of
 * each stratum's actions by their dependency graph and the statement chosen for each put.
 *
 * Each action becomes its statements, in action order:
 *
 * - a deletion: the exact deletion of its member, reading D EXCEPT A when the stratum also adds to the relation and
 *   either side is described; two enumerated sides the host already netted;
 * - an insertion: the insert protocol for its relation and member shape, followed, into a span primary key, by the
 *   statement that classifies each requested fact it did not insert;
 * - a put: its target's statements: the displacing deletion and the insert protocol as its insert half for the
 *   DELETE-then-insert pair (a pure set keyed by scalars alone displaces nothing), or the one ON CONFLICT DO UPDATE,
 *   UPDATE ... FROM or MERGE statement, which absorbs the deletion it was proved with.
 *
 * Where each described member is evaluated. Every member of a stratum is evaluated against the state before the
 * stratum's writes, once. A member is a leading CTE of the statement that consumes it when that statement is its only
 * consumer and no earlier statement of the stratum writes a relation it reads, so the statement's snapshot is the
 * stratum's starting state for everything the member reads; this is the one-statement, no-carrier realization.
 * Otherwise it is evaluated into a transaction-scoped carrier at the start of the stratum, before any of the stratum's
 * writes, and every consumer reads the carrier: the two statements of an immutable put, an insertion followed by its
 * classification into a span primary key, an addition a deletion reads as D EXCEPT A, or a
 * member that would otherwise read a relation an earlier statement of its stratum changed. An insertion's or a put's
 * carrier is typed as the relation's columns, so it holds the facts as written; a deletion's as each field's base type
 * with its typmod, as the deletion compares.
 *
 * A sub-query several of a stratum's member statements read, one share key over all its copies, such as the work
 * queue's `pick`, which each member of the claim matches, is evaluated the same way: once into a carrier at the start
 * of the stratum, before the members' carriers, which read it, the shared sub-queries lowest first, and every statement
 * reads the carrier in place of its copy (`planStatementShares`). A member then reads directly only the relations it
 * reaches outside the carried sub-queries, which decides whether an earlier write of the stratum forces it into a
 * carrier of its own. A single statement reads its shared sub-queries as CTEs instead.
 *
 * A role's query entry adds checks. An addition into an entry is prechecked right before its insert statement, the
 * insert half of a put included, so its input has two consumers and is carried; a stratum with a precheck is realized
 * sequentially. An addition into an entry the Db's claims leave outside the world is no action but a check of its
 * source at the start of its stratum, before any of the stratum's writes, where its source reads the stratum's
 * starting state.
 *
 * A relation parameter the ChangeSet binds to a query that a later stratum or a read-back reads (ir/write.ts BoundInput)
 * is evaluated before the first stratum, into a carrier every statement after it reads (step `bound`), so no stratum's
 * statement and no read-back evaluates it over the state it reads; one only the first stratum's members read is a part
 * of their queries, which read the first stratum's starting state, the call's.
 *
 * Read-backs are placed by what they read (`placeReadBacks`): a read-back whose deltas one statement makes whole, and
 * whose state reads that statement and every later one leave alone, rides that statement, evaluated in it over its
 * RETURNING; one that reads no delta a statement makes comes last, after the last stratum; any other is refused
 * (ReadBackCrossesStatements), since a delta never leaves the statement that makes it.
 *
 * A stratum is realized sequentially, one statement per write action plus the member carriers and classifications the
 * rules above require, or as a single statement where one snapshot suffices: its statements are at
 * least two writes of distinct relations and nothing else, so no statement reads what another writes, a deletion
 * excepts no addition (that takes an addition to its own relation), and no member needs a carrier, because every
 * member reads the stratum's starting state, which is the single statement's own snapshot. Its actions are then
 * sibling data-modifying CTEs of one statement, its shared sub-queries CTEs they read, and its rows each action's rows
 * behind an action tag (`singleStatement`). Both realizations evaluate every member once against the stratum's starting
 * state, so final states, outcomes and reads are the same. */
export const planWrite = (
	frontend: WriteFrontend,
	chosen: ChosenTargets,
	evidence: PlanEvidence
): WritePlan => {
	const supply = new CarrierSupply(evidence.carrierTyping, evidence.carrierScope)
	/** Each carried bound input's evaluation, before the first stratum, in the call's starting state (ir/write.ts
	 * BoundInput): its carrier made and filled first, which every statement after it reads in its place. */
	const bound = frontend.ir.bound.map((input) => ({
		input,
		carrier: supply.next(
			input.node.heading.map((c) => ({ name: c.name, type: c.type })),
			undefined
		)
	}))
	/** The strata's statements, the read-backs placed among them below. */
	const strata: Array<PlanStep> = bound.map(({ input, carrier }) => ({
		kind: "bound",
		input,
		carrier
	}))
	/** The nodes each stratum's members reach: a carrier holds its stratum's starting state, so a node another
	 * stratum's member also reaches is never carried across statements; a single statement's parts are its own CTEs,
	 * which no later statement reads (write/program/compile.ts uncarries them), so it holds such a node too. */
	const reached = chosen.strata.map(({ actions }) => {
		const seen = new Set<RelNode>()
		const queue = actions.flatMap((action) =>
			action.info.reads.kind === "described" ? [action.info.reads.node] : []
		)
		for (const node of queue) {
			if (seen.has(node)) {
				continue
			}
			seen.add(node)
			appendAll(queue, inputsOf(node))
		}
		return seen
	})

	for (const [s, { actions, outside, checks, family }] of strataAt(chosen.strata)) {
		for (const refused of outside) {
			const reads = refused.reads
			strata.push({
				kind: "check",
				stratum: s,
				input:
					reads.kind === "slot"
						? outsideInput(reads.slot.slot, refused.entry, reads.slot.heading)
						: { kind: "described", node: reads.node, proof: unproved },
				check: { kind: "outside", entry: refused.entry }
			})
		}
		/** The positions of the deletions a MERGE absorbs. */
		const absorbed = new Set<number>(
			actions.flatMap((a) =>
				a.op === "put" && a.choice.target === "merge" ? [a.choice.merge.deletion] : []
			)
		)
		const drafted = actions.flatMap((action, index): ReadonlyArray<ActionDraft> =>
			absorbed.has(index)
				? []
				: [
						{
							at: { stratum: s, index, dependsOn: action.dependsOn },
							action,
							steps: opsOf(action),
							excepts: exceptsOf(actions, action)
						}
					]
		)
		/** A stratum one statement realizes runs its family statements after that statement, whose snapshot is the
		 * stratum's starting state, so one whose schedule runs a family statement before any of its actions is realized
		 * sequentially, its members carried where an earlier statement wrote what they read. */
		const before = family.some((f) => f.at < actions.length)
		const realization: Realization = before ? { kind: "sequential" } : realizationOf(drafted)
		/** The sub-queries several member statements read, carried from the start of the stratum: in one statement, its
		 * held evaluations among the statements, each reading its call's arguments once. */
		const members = drafted.flatMap(({ action }) =>
			action.info.reads.kind === "described" ? [action.info.reads.node] : []
		)
		const shares = (
			members.length < 2 ? [] : evidence.shares(members, realization.kind === "single")
		).filter(
			(share) =>
				realization.kind === "single" ||
				!share.copies.some((copy) => reached.some((nodes, t) => t !== s && nodes.has(copy)))
		)
		const familyStep = familyStepsOf(s, checks)
		if (realization.kind === "sequential") {
			refuseStampedStatements(
				drafted.map((d) => ({
					relation: d.action.info.relation,
					stamps: d.action.info.stamps,
					statements: d.steps.length,
					loc: childLoc(SourceLoc("ChangeSet", []), "writes", d.action.info.relation.name)
				}))
			)
		}
		switch (realization.kind) {
			case "single":
				strata.push({
					kind: "single",
					stratum: s,
					shares,
					writes: mapNonEmpty(realization.writes, ({ draft, step }) =>
						plannedWrite(draft, step, sourceInput(draft.action, evidence), [])
					),
					readBacks: []
				})
				appendAll(strata, family.flatMap(familyStep))
				break
			case "sequential":
				appendAll(strata, sequentialSteps(s, drafted, family, familyStep, shares, supply, evidence))
				break
		}
	}

	const placement = placeReadBacks(frontend, strata)
	const steps: Array<PlanStep> = [...placement.strata]
	for (const read of placement.after) {
		steps.push({ kind: "readBack", read })
	}
	return Object.freeze({
		steps: Object.freeze(steps),
		bound: new Map(bound.map(({ input, carrier }) => [input.param, carrier] as const)),
		carriers: Object.freeze(supply.all()),
		carrierScope: evidence.carrierScope,
		made: placement.made
	})
}
