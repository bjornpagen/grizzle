import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type NamedSide } from "#compiler/core/errors.ts"
import type { EntryName, ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { headStamped, type Stamped } from "#compiler/ir/instant.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import { boundParamsRead, type DeltaSide, inputsOf, type RelNode } from "#compiler/ir/rel.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type { BoundInput, ReadBack } from "#compiler/ir/write.ts"
import { type Rank, rowsBound } from "#compiler/lower/optimize/cte-policy/index.ts"
import type { CarriedShare } from "#compiler/lower/shapes/share/statements.ts"
import {
	type CarriedRows,
	type CarrierDeclaring,
	CarrierSupply,
	nodeRows,
	type WriteCarrier
} from "#compiler/write/carriers/carriers.ts"
import { type DeleteAnchor, deleteAnchor } from "#compiler/write/delete/anchor.ts"
import { type FamilySource, familyInput } from "#compiler/write/delete/unit.ts"
import type {
	ClaimsCheck,
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
import { deltaTarget } from "#compiler/write/readback/deltas.ts"

/** An action a planned statement realizes: its stratum, its position among the stratum's actions
 * (ir.strata[stratum].actions), and the positions there of the earlier actions that must complete first (`Action`), whose
 * statements the action's own follow. The planner makes one per action, and every statement of the action carries it. */
export interface PlanAction {
	readonly stratum: StratumAt
	readonly index: number
	readonly dependsOn: ReadonlyArray<number>
}

/** The write a check checks, which follows it: an action's, or facts only a family statement writes
 * (write/frontend/compile.ts MemberCheck), which no action does. */
export type CheckedAddition =
	| { readonly kind: "action"; readonly action: PlanAction }
	| { readonly kind: "family" }

/** What a check refuses: an addition's facts outside a query entry or at a key a fact outside it holds; a write's facts
 * outside the units the role's claims bind, by the relation's claims membership (write/frontend/compile.ts ClaimsCheck
 * `claimed`); or any fact of an addition the Db's claims leave outside the world. */
export type PlannedCheck =
	| {
			readonly kind: "membership"
			readonly entry: CheckedEntry
			readonly addition: CheckedAddition
			readonly relation: WrittenRelation
			/** The unique objects it probes for a fact outside the entry: every probe of its relation. */
			readonly probes: ReadonlyArray<OutsideProbe>
	  }
	| (Claimed & { readonly addition: CheckedAddition; readonly relation: WrittenRelation })
	| { readonly kind: "outside"; readonly entry: EntryName }

/** A write's claims precheck: the claims membership it judges each fact by, and the name it refuses one under. */
type Claimed = Extract<ClaimsCheck, { readonly kind: "claimed" }>

/** A write action's statement by what it does, with what its builder reads beyond the action's own input: an insertion
 * or a put's insert half, an exact deletion with the stratum's additions it excepts (D EXCEPT A), a deletion whose
 * member is anchored on an occurrence of its relation with the anchor, a put's displacing deletion over the relation's
 * payload and its insert half, and the in-place puts with what their choice proved (an upsert reads its slot's
 * relation input). */
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

/** A write action's statement in a stratum. */
export type PlannedWrite = {
	readonly kind: "write"
	readonly action: PlanAction
	readonly relation: WrittenRelation
	readonly input: WriteInput
} & WriteOpStep

/** One step of a write plan:
 * - `bound`, a relation parameter the ChangeSet binds to a query that a reader in another state reads (ir/write.ts
 *   BoundInput): its carrier, filled from its query first among its stratum's steps, every reader's InputSet of it
 *   reading that carrier;
 * - `fillMember`, a member's carrier, filled from its node: the facts its action writes into `relation`, cast into its
 *   columns' types;
 * - `fillShare`, the carrier of a sub-query several statements of the stratum read, filled from the share's copy;
 * - a write action's statement;
 * - `single`, a stratum's write actions as one statement over one snapshot (see `planWrite`): each sub-query several of
 *   them read, a CTE of the statement, and each action's write, in action order, its member read inline or as a
 *   relation parameter, then the read-backs that ride it and the delta sides it carries out of itself, a lone write
 *   with read-backs riding it or sides carried out of it among them;
 * - `readBack`, a read-back after the last stratum, each delta side a statement makes that it reads carried there
 *   (CarriedSide);
 * - `check`, a query entry's check of an addition's facts, `input`;
 * - `family`, a family statement of the stratum (frontend/schedule.ts FamilyNode), where its schedule runs it among
 *   the stratum's writes. */
export type PlanStep =
	| { readonly kind: "bound"; readonly input: BoundInput; readonly carrier: WriteCarrier }
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
			/** The delta sides it makes whole that a read-back after the last stratum reads, each filled into its carrier
			 * inside the statement from its writes' RETURNING (`placeReadBacks`). */
			readonly carries: ReadonlyArray<CarriedSide>
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
			/** The added side of a stamped nesting's root it inserts that a read-back after the last stratum reads, filled
			 * into its carrier inside the statement from its insert's RETURNING (`placeReadBacks`); none for any other. */
			readonly carries: ReadonlyArray<CarriedSide>
	  }

/**
 * One side of a relation's delta carried out of the one statement that makes it whole, for the read-backs after the
 * last stratum that read it: `side` of `relation`'s delta, the relation a stored one (a query entry's delta named by its
 * target), and the carrier of the relation's heading that holds it. That statement fills it inside itself from the rows
 * its RETURNING returns of that side (write/readback/deltas.ts carriedStash), and no other statement writes it, so after
 * that statement it holds exactly the side's rows: the facts the write made present, absent or met there, which no later statement nets or makes
 * again (`placeReadBacks`).
 */
export interface CarriedSide {
	readonly relation: string
	readonly side: DeltaSide
	readonly carrier: WriteCarrier
}

export interface WritePlan {
	readonly steps: ReadonlyArray<PlanStep>
	/** The carrier of each carried bound input (step `bound`), by its parameter, which every reader of it reads. */
	readonly bound: ReadonlyMap<ParamId, WriteCarrier>
	readonly carriers: ReadonlyArray<WriteCarrier>
	/** How its carriers are declared (PlanEvidence `carriers`), every later carrier of its program's too. */
	readonly declaring: CarrierDeclaring
	/** The sides of each relation's delta some statement makes, by the relation's name; every other side, a world
	 * relation's whose definition reads nothing the ChangeSet writes included, is empty by construction. */
	readonly made: ReadonlyMap<string, ReadonlySet<DeltaSide>>
	/** The carrier of each side a statement carries out of itself (CarriedSide), by its relation, then its side: every
	 * side some statement makes that a read-back after the last stratum reads. */
	readonly carried: ReadonlyMap<string, ReadonlyMap<DeltaSide, WriteCarrier>>
	/** Each unit delete's described source a claims precheck reads, by its node, with the carrier the precheck's steps
	 * fill, which the delete reads in its place (`familyStepsOf`, write/delete/unit.ts FamilySource). */
	readonly sources: ReadonlyMap<RelNode, CarriedSource>
}

/** A family statement's source as a carrier holds it (write/delete/unit.ts FamilySource). */
type CarriedSource = Extract<FamilySource, { readonly kind: "carrier" }>

/** One statement of an action before its stratum's inputs are placed: an exact deletion's excepted additions are
 * the actions its draft reads after its own, and whether it is anchored is decided once its input is placed. */
type DraftStep =
	| Exclude<WriteOpStep, { readonly op: "exactDelete" | "anchoredDelete" }>
	| { readonly op: "exactDelete" }
	| {
			readonly op: "precheck"
			readonly check:
				| {
						readonly kind: "membership"
						readonly entry: CheckedEntry
						readonly probes: ReadonlyArray<OutsideProbe>
				  }
				| Claimed
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
				check: { ...step.check, addition: { kind: "action", action: draft.at }, relation }
			}
		case "exactDelete":
		case "insert":
		case "putInsert":
		case "displace":
		case "upsert":
		case "updateFrom":
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
			return [...claimedPrecheckOf(action), { op: "exactDelete" }]
		case "insert":
			return [...precheckOf(action), { op: "insert", stamps: action.info.stamps }]
		case "put":
			return putOps(action)
	}
}

/**
 * The prechecks of an addition, right before its insert statement: its claims (`claimedPrecheckOf`), then, into a query
 * entry, its membership, probing every unique object of its relation as the entry reaches it.
 */
const precheckOf = (action: ChosenAction): ReadonlyArray<DraftStep> => {
	const entry = action.info.entry
	const claimed = claimedPrecheckOf(action)
	switch (entry.kind) {
		case "whole":
			return claimed
		case "entry":
			return [
				...claimed,
				{
					op: "precheck",
					check: {
						kind: "membership",
						entry: entry.entry,
						probes: action.info.relation.uniques.probes
					}
				}
			]
	}
}

/** The precheck of a write held to the role's claims, whole or through a query entry alike (write/frontend/compile.ts
 * ClaimsCheck), before every statement of it but a put's displacing deletion: no statement of a write meets a fact
 * outside the world as a law, so the precheck refuses one first, a delete's and every form of a put's among them; none
 * for a write held to nothing. */
const claimedPrecheckOf = (action: ChosenAction): ReadonlyArray<DraftStep> => {
	const claims = action.info.claims
	return claims.kind === "claimed" ? [{ op: "precheck", check: claims }] : []
}

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
				...claimedPrecheckOf(put),
				{
					op: "upsert",
					input: choice.slot.input,
					inPlace: choice.inPlace,
					arbiter: choice.arbiter
				}
			]
		case "updateFrom":
			return [...claimedPrecheckOf(put), { op: "updateFrom", inPlace: choice.inPlace }]
		case "ownerPut":
			return [
				...precheckOf(put),
				...(choice.inPlace === undefined
					? []
					: [{ op: "updateFrom", inPlace: choice.inPlace } as const]),
				{ op: "putInsert" }
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
	/** How its carriers are declared, each column's type (write/carriers CarrierDeclaring). */
	readonly carriers: CarrierDeclaring
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
 * stratum, an owner's insert a reached entry's membership reads among them, precedes it. A check of a unit delete's
 * described source and the delete read one evaluation of it: a carrier from `supply` the check's steps fill, recorded in
 * `sources`, which the delete then reads in its place (write/delete/unit.ts FamilySource), as an action's described
 * member several statements read is carried (`sequentialSteps`).
 */
const familyStepsOf = (
	stratum: StratumAt,
	checks: ReadonlyArray<MemberCheck>,
	supply: CarrierSupply,
	sources: Map<RelNode, CarriedSource>
): ((f: FamilyAt) => ReadonlyArray<PlanStep>) => {
	const checked = new Set<MemberCheck>()
	/** The steps of check `c`: its source carried first where it is described, then the check of it. */
	const checkSteps = (c: MemberCheck): ReadonlyArray<PlanStep> => {
		const check = { ...c.check, addition: { kind: "family" } as const, relation: c.relation }
		if (c.source.kind !== "described") {
			return [{ kind: "check", stratum, input: familyInput(c.source), check }]
		}
		const node = c.source.node
		const fields = keyFirst(c.relation).filter((f) => node.heading.some((h) => h.name === f.name))
		const carrier = supply.next(
			compareHeading(fields),
			nodeRows([node], `a member of ${c.relation.name}`)
		)
		const input = { kind: "carrier", carrier, proof: unproved } as const
		sources.set(node, { kind: "carrier", input })
		return [
			{ kind: "fillMember", carrier, node, relation: c.relation.name, stratum },
			{ kind: "check", stratum, input, check }
		]
	}
	return (f) => {
		const written = familyNodeRelations(f.node)
		const due = checks.filter((c) => !checked.has(c) && written.includes(c.relation.name))
		for (const c of due) {
			checked.add(c)
		}
		return [
			...due.flatMap(checkSteps),
			{ kind: "family", stratum, node: f.node, readBacks: [], carries: [] }
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
			nodeRows([share.node], "a shared sub-query")
		)
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
		const carrier = supply.next(heading, nodeRows([reads.node], `a member of ${relation.name}`))
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

/**
 * The rows of `named`'s delta side the statement `step` makes, by what bounds them: each write of the relation in it,
 * by what it reads (`writtenRank`); a family statement's nested rows, the call's own.
 */
const deltaRows = (named: NamedSide, step: Rideable): CarriedRows => {
	const rows = `the ${named.side} side of ${named.relation}'s delta`
	if (step.kind === "family") {
		return { ranks: ["held"], rows }
	}
	const ranks = (step.kind === "single" ? step.writes : [step])
		.filter((w) => w.relation.name === named.relation)
		.map((w) => writtenRank(w.input))
	return { ranks: isNonEmpty(ranks) ? ranks : ["held"], rows }
}

/**
 * The rank of the rows a write reads as its input bounds them: a described member's node's (rowsBound), a carried
 * member's its carrier's, none for an unbounded one; a relation parameter's facts, the call's own.
 */
const writtenRank = (input: WriteInput): Rank | undefined => {
	switch (input.kind) {
		case "described":
			return rowsBound(input.node)
		case "carrier":
			return input.carrier.bound === "none" ? undefined : input.carrier.bound
		case "relation":
			return "held"
	}
}

/** `step` with the read-backs `riders` riding it and the delta sides `carries` carried out of it: a single statement's
 * own or a family statement's, or a lone write's as a single statement of that one write. */
const ridden = (
	step: Rideable,
	riders: ReadonlyArray<ReadBack>,
	carries: ReadonlyArray<CarriedSide>
): PlanStep => {
	switch (step.kind) {
		case "single":
		case "family":
			return { ...step, readBacks: riders, carries }
		case "write":
			return {
				kind: "single",
				stratum: step.action.stratum,
				shares: [],
				writes: [step],
				readBacks: riders,
				carries
			}
	}
}

/** Where each read-back runs: the strata's statements with the read-backs riding them and the delta sides carried out
 * of them; the read-backs after the last stratum;
 * the sides of each relation's delta some statement makes, every other side empty by construction; and the carrier of
 * each carried side. */
interface ReadBackPlacement {
	readonly strata: ReadonlyArray<PlanStep>
	readonly after: ReadonlyArray<ReadBack>
	readonly made: ReadonlyMap<string, ReadonlySet<DeltaSide>>
	readonly carried: ReadonlyMap<string, ReadonlyMap<DeltaSide, WriteCarrier>>
}

/** The sides of its relation's delta a write's statement makes, by the rows it returns (write/program/artifact.ts
 * changeTags): an insertion's, a put's insert half's and an upsert's the facts they made present, an arbitrated
 * insertion's also the stored facts it met (insert/protocol.ts writesMet), a deletion's and a put's displacing
 * deletion's those they made absent, an update's the facts made present and absent. */
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

/**
 * Where each read-back is evaluated, by its data dependencies among the strata's statements `strata`, the carriers of
 * the delta sides it carries drawn from `supply`: inside the one statement that makes every delta side it reads, where
 * the state it reads is settled there; otherwise after the last stratum, each side a statement makes carried there from
 * the statement that makes it whole. Only a side no one statement makes whole is refused, as ReadBackCrossesStatements.
 *
 * A read-back reads the delta sides it names and the post-change state of the relations it reads. A side is what its
 * relation's write statements return, and those rows exist only inside the statement that returns them. The one
 * statement S that makes a side whole is the only statement that makes that side of the relation, and no other
 * statement that makes the side it nets against (`nettedAgainst`) may cancel S's rows (`cancels`): an addition and a
 * removal made by writes of one stratum never do, but for a family statement's and a generated addition's; so S's rows
 * of the side are the netted delta (runtime/write/net.ts). A side two statements make, or one another statement nets, is
 * the rows of no statement, and a read-back that names it is refused (the crossing names it); a side no statement makes
 * is empty by construction, as is a relation's no statement writes and a world relation's whose definition reads
 * nothing the ChangeSet writes (`NamedDelta` "empty"), and every read-back reads it as the empty relation.
 *
 * Every other read-back is evaluated in one of two places, each of which gives it the rows the whole write leaves:
 *
 * - It rides S, evaluated inside S over S's RETURNING (write/readback/deltas.ts deltaCte), where S makes every side it
 *   names whole, no statement at or after S writes a stored relation it reads as state, directly, through a role's view,
 *   or through a cascading foreign key, S's own writes included (S's snapshot is from before them, and the state after S
 *   is the state after the last stratum only where no later statement changes it), and every bound input it reads is
 *   filled before S. A stratum whose order would write a relation such a read-back reads as state after its delta's
 *   relation is ordered again with the delta's relation last where no key orders it (frontend/compile.ts,
 *   frontend/schedule.ts canonicalActionOrder), so it rides wherever the stratum's keys allow it.
 * - Otherwise it is evaluated after the last stratum, in the state the whole write leaves, and each side it names that a
 *   statement makes is carried there (CarriedSide): the statement making it whole fills a carrier of its own from its
 *   RETURNING inside itself, and the read-back reads the carrier where it reads the side. The
 *   carrier holds exactly that statement's rows of the side, which are the whole netted side, so the read-back reads the
 *   write's own delta, its keys as the write made them, joined to every relation as the whole write leaves it: never
 *   the delta re-derived by a search of the state. A read-back that names no side a statement makes runs there too,
 *   carrying nothing.
 *
 * What a read-back after the last stratum reads beside its carried sides is read in the same transaction after every
 * write, so a relation keyed by the call's own rows is read as the call leaves it. The rows a carried side holds are
 * the call's own, made under the call's borrows: at READ COMMITTED a unit's rows are written only under its exclusive
 * borrow, which the call holds until it ends (analysis/isolation/borrows.ts), so no other call writes a row at the
 * keys the side holds before the read-back reads them, and under SERIALIZABLE the transaction's one snapshot and its
 * own writes are what every statement of it reads. A carrier holds no predicate lock and is the transaction's alone.
 */
const placeReadBacks = (
	frontend: WriteFrontend,
	strata: ReadonlyArray<PlanStep>,
	supply: CarrierSupply
): ReadBackPlacement => {
	const sides = strata.map(stepSides)
	const writes = strata.map(stepWrites)
	/** The position of each carried bound input's fill (step `bound`), by its parameter. */
	const filled = new Map(
		strata.flatMap((step, position) =>
			step.kind === "bound" ? [[step.input.param, position] as const] : []
		)
	)
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
	/** The position of the one statement that makes the side `named` whole, none where no one statement does. */
	const completion = (named: NamedSide): number | undefined => {
		const [maker, ...others] = makers(named.relation, named.side)
		if (maker === undefined) {
			defect(`a statement making the ${named.side} side of ${named.relation}'s delta`)
		}
		if (others.length > 0) {
			return undefined
		}
		const netting = makers(named.relation, nettedAgainst(named.side)).filter(
			(other) => other.position !== maker.position && cancels(named.side, maker.write, other.write)
		)
		return netting.length === 0 ? maker.position : undefined
	}
	/** The statement at `position`, which makes a side whole: one that runs once and returns its writes' rows. */
	const rideableAt = (position: number): Rideable => {
		const step = strata[position]
		if (
			step?.kind === "write" ||
			step?.kind === "single" ||
			(step?.kind === "family" && step.node.kind === "additions" && step.node.appends === "rows")
		) {
			return step
		}
		defect(`a read-back's delta made by a statement that returns no rows of it, at ${position}`)
	}
	/** Whether the state `read` reads is settled at the statement at `position`, the one it would ride: no statement
	 * there or after writes a stored relation it reads, and every bound input it reads is filled before it. */
	const settledAt = (read: ReadBack, position: number): boolean => {
		const later = withCascades(writes.slice(position).flat(), frontend)
		return (
			!read.node.meta.reads.some((r) =>
				storedReads(frontend.schema.world, r).some((s) => later.has(s))
			) &&
			[...boundParamsRead([read.node])].every(
				(param) => defined(filled.get(param), "a carried bound input's fill") < position
			)
		)
	}
	/** Where `read` is evaluated: riding the statement that makes every side it names whole, or after the last stratum
	 * with each side it names carried from the statement making it whole; or the side no one statement makes whole. */
	const placement = (
		read: ReadBack
	):
		| { readonly kind: "rides"; readonly step: Rideable }
		| {
				readonly kind: "after"
				readonly carried: ReadonlyArray<{ readonly named: NamedSide; readonly step: Rideable }>
		  }
		| { readonly kind: "crossing"; readonly delta: NamedSide } => {
		const named = read.deltas.flatMap((d) => {
			const relation = targetOf(d.relation)
			return made.get(relation)?.has(d.side) === true ? [{ relation, side: d.side }] : []
		})
		const whole: Array<{ readonly named: NamedSide; readonly position: number }> = []
		for (const side of named) {
			const position = completion(side)
			if (position === undefined) {
				return { kind: "crossing", delta: side }
			}
			whole.push({ named: side, position })
		}
		const [first, ...rest] = whole
		if (
			first !== undefined &&
			rest.every((w) => w.position === first.position) &&
			settledAt(read, first.position)
		) {
			return { kind: "rides", step: rideableAt(first.position) }
		}
		return {
			kind: "after",
			carried: whole.map((w) => ({ named: w.named, step: rideableAt(w.position) }))
		}
	}
	const relations = new Map<string, RelationInfo>(
		frontend.deltas.flatMap((d) =>
			d.kind === "relation" ? [[d.relation.name, d.relation] as const] : []
		)
	)
	const riders = new Map<Rideable, Array<ReadBack>>()
	const carries = new Map<Rideable, Array<CarriedSide>>()
	const carried = new Map<string, Map<DeltaSide, WriteCarrier>>()
	/** The carrier of `named`, made the first time a read-back carries it, out of the statement `step` that makes it. */
	const carry = (named: NamedSide, step: Rideable): void => {
		const own = carried.get(named.relation) ?? new Map<DeltaSide, WriteCarrier>()
		carried.set(named.relation, own)
		if (own.has(named.side)) {
			return
		}
		const relation = defined(
			relations.get(named.relation),
			`the delta of ${named.relation} a read-back names`
		)
		const carrier = supply.next(
			relation.heading.map((f) => ({ name: f.name, type: f.type })),
			deltaRows(named, step)
		)
		own.set(named.side, carrier)
		const side: CarriedSide = { relation: named.relation, side: named.side, carrier }
		const list = carries.get(step)
		if (list === undefined) {
			carries.set(step, [side])
		} else {
			list.push(side)
		}
	}
	const after: Array<ReadBack> = []
	const changeSet = SourceLoc("ChangeSet", [])
	for (const read of frontend.ir.reads) {
		const placed = placement(read)
		switch (placed.kind) {
			case "crossing":
				throw new Refusal(
					CompileError.make({
						_tag: "ReadBackCrossesStatements",
						at: childLoc(changeSet, "reads", read.name),
						read: read.name,
						delta: placed.delta
					})
				)
			case "after":
				for (const { named, step } of placed.carried) {
					carry(named, step)
				}
				after.push(read)
				break
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
		strata: strata.flatMap((step): ReadonlyArray<PlanStep> => {
			if (step.kind !== "write" && step.kind !== "single" && step.kind !== "family") {
				return [step]
			}
			const riding = riders.get(step) ?? []
			const carrying = carries.get(step) ?? []
			return riding.length === 0 && carrying.length === 0
				? [step]
				: [ridden(step, riding, carrying)]
		}),
		after,
		made,
		carried
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
 *   DELETE-then-insert pair (a pure set keyed by scalars alone displaces nothing), or the one ON CONFLICT DO UPDATE or
 *   UPDATE ... FROM statement.
 *
 * Where each described member is evaluated. Every member of a stratum is evaluated against the state before the
 * stratum's writes, once. A member is a leading CTE of the statement that consumes it when that statement is its only
 * consumer and no earlier statement of the stratum writes a relation it reads, so the statement's snapshot is the
 * stratum's starting state for everything the member reads; this is the one-statement, no-carrier realization.
 * Otherwise it is evaluated into a carrier at the start of the stratum, before any of the stratum's
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
 * A relation parameter the ChangeSet binds to a query that a reader in another state reads (ir/write.ts BoundInput) is
 * evaluated first among its stratum's steps, before its outside checks and its statements, after every statement of
 * the strata before it, into a carrier every statement after it reads (step `bound`), so no later stratum's statement
 * and no read-back evaluates it over the state it reads; one whose every reader reads the state it is evaluated in is a
 * part of their queries.
 *
 * Read-backs are placed by what they read (`placeReadBacks`): a read-back whose deltas one statement makes whole, and
 * whose state reads that statement and every later one leave alone, rides that statement, evaluated in it over its
 * RETURNING; any other comes last, after the last stratum, each delta side a statement makes that it reads carried
 * there in a carrier the statement making it fills from its RETURNING; one that reads a side
 * no one statement makes whole is refused (ReadBackCrossesStatements).
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
	const supply = new CarrierSupply(evidence.carriers)
	/** Each carried bound input's evaluation, in the state before its stratum (ir/write.ts BoundInput): its carrier made,
	 * and filled first among its stratum's steps, which every statement after it reads in its place. */
	const bound = frontend.ir.bound.map((input) => ({
		input,
		carrier: supply.next(
			input.node.heading.map((c) => ({ name: c.name, type: c.type })),
			nodeRows([input.node], `relation parameter ${input.param}`)
		)
	}))
	/** The strata's statements, the read-backs placed among them below. */
	const strata: Array<PlanStep> = []
	/** Each checked unit delete's described source with the carrier its precheck fills (WritePlan `sources`). */
	const sources = new Map<RelNode, CarriedSource>()
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
		for (const { input, carrier } of bound.filter((b) => b.input.stratum === s)) {
			strata.push({ kind: "bound", input, carrier })
		}
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
		const drafted = actions.map((action, index): ActionDraft => ({
			at: { stratum: s, index, dependsOn: action.dependsOn },
			action,
			steps: opsOf(action),
			excepts: exceptsOf(actions, action)
		}))
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
		const familyStep = familyStepsOf(s, checks, supply, sources)
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
					readBacks: [],
					carries: []
				})
				appendAll(strata, family.flatMap(familyStep))
				break
			case "sequential":
				appendAll(strata, sequentialSteps(s, drafted, family, familyStep, shares, supply, evidence))
				break
		}
	}

	const placement = placeReadBacks(frontend, strata, supply)
	const steps: Array<PlanStep> = [...placement.strata]
	for (const read of placement.after) {
		steps.push({ kind: "readBack", read })
	}
	return Object.freeze({
		steps: Object.freeze(steps),
		bound: new Map(bound.map(({ input, carrier }) => [input.param, carrier] as const)),
		carriers: Object.freeze(supply.all()),
		declaring: evidence.carriers,
		made: placement.made,
		carried: placement.carried,
		sources
	})
}
