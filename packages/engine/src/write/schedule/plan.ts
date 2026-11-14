import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import { appendAll } from "#compiler/core/array.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type NamedSide, type ReadBackCrossing } from "#compiler/core/errors.ts"
import type { EntryName, StoredRelationName } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { LawField, RelationInfo, SpanField } from "#compiler/ir/law.ts"
import { type DeltaSide, inputsOf, type RelNode } from "#compiler/ir/rel.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import {
	completeAddition,
	completeClass,
	type ReadBack,
	type SerialClass
} from "#compiler/ir/write.ts"
import type { CarriedShare } from "#compiler/lower/shapes/share/statements.ts"
import {
	type CarrierTyping,
	type WriteCarrier,
	CarrierSupply
} from "#compiler/write/carriers/carriers.ts"
import { type DeleteAnchor, deleteAnchor } from "#compiler/write/delete/anchor.ts"
import type { CheckNames } from "#compiler/write/entry/precheck.ts"
import type {
	ActionEntry,
	WriteFrontend,
	WrittenRelation
} from "#compiler/write/frontend/compile.ts"
import {
	type FamilyAt,
	type FamilyNode,
	familyNodeRelations
} from "#compiler/write/frontend/schedule.ts"
import { payloadOf, primaryKeyShape } from "#compiler/write/frontend/targets.ts"
import type { HeldUnit } from "#compiler/write/hold/stated.ts"
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
import {
	compareHeading,
	factHeading,
	type InsertOf,
	keyFirst
} from "#compiler/write/insert/statement.ts"

import type {
	ChosenAction,
	ChosenTargets,
	InPlace,
	KeyArbiter
} from "#compiler/write/put/choose.ts"
import type { MergeScope } from "#compiler/write/put/proof.ts"
import { explicitSerials } from "#compiler/write/serial/advance.ts"

/** An action a planned statement realizes: its stratum, its position among the stratum's actions
 * (ir.strata[stratum].actions), and the positions there of the earlier actions that must complete first (`Action`), whose
 * statements the action's own follow. The planner makes one per action, and every statement of the action carries it. */
export interface PlanAction {
	readonly stratum: StratumAt
	readonly index: number
	readonly dependsOn: ReadonlyArray<number>
}

/** What a check of a query entry refuses: an addition's facts outside the entry or at a key a
 * fact outside it holds, the addition's serial class saying which keys it can probe; or any fact of an addition the
 * Db's claims leave outside the world. */
export type PlannedCheck =
	| {
			readonly kind: "membership"
			readonly entry: CheckedEntry
			/** The role's names its checks call. */
			readonly names: CheckNames
			readonly serial: SerialClass
			/** The addition it checks, which follows it. */
			readonly action: PlanAction
			readonly relation: WrittenRelation
	  }
	| { readonly kind: "outside"; readonly entry: EntryName }

/** A write action's statement by what it does, with what its builder reads beyond the action's own input: an insertion
 * or a put's insert half, an exact deletion with the stratum's additions it excepts (D EXCEPT A), a deletion whose
 * member is anchored on an occurrence of its relation with the anchor, a put's displacing deletion over the relation's
 * payload and its insert half, and the in-place puts with what their choice proved (an upsert reads its slot's
 * relation input, a MERGE carries the scope it was proved over); the deletion a MERGE absorbs has no statement of its
 * own. */
type WriteOpStep =
	| { readonly op: "insert"; readonly serial: SerialClass; readonly entry: ActionEntry }
	| { readonly op: "exactDelete"; readonly except: ReadonlyArray<WriteInput> }
	| { readonly op: "anchoredDelete"; readonly anchor: DeleteAnchor }
	| { readonly op: "displace"; readonly payload: NonEmptyReadonlyArray<LawField> }
	| { readonly op: "putInsert"; readonly entry: ActionEntry }
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
 * - `createCarrier`, a carrier created at the start of its stratum: a member's or a shared sub-query's;
 * - `fillMember`, a member's carrier, filled from its node: the facts its action writes into `relation`, cast into its
 *   columns' types;
 * - `fillShare`, the carrier of a sub-query several statements of the stratum read, filled from the share's copy;
 * - a write action's statement;
 * - `single`, a stratum's write actions as one statement over one snapshot (see `planWrite`): each sub-query several of
 *   them read, a CTE of the statement, and each action's write, in action order, its member read inline or as a
 *   relation parameter, then the read-backs that ride it, a lone write with read-backs riding it among them;
 * - `advance`, a sequence advance after an addition whose facts carry explicit serial values;
 * - `classify`, the classification after an insert into a span primary key, of an insertion or of a put's insert half,
 *   `span` the key's span field;
 * - `readBack`, a read-back after the last stratum, one that reads no delta a statement writes;
 * - `check`, a query entry's check of an addition's facts, `input`;
 * - `family`, a family statement of the stratum (frontend/schedule.ts FamilyNode), where its schedule runs it among
 *   the stratum's writes;
 * - `hold`, the hold of the groups a write states of a retirable unit it touches, before the first statement that
 *   touches it (`placeHolds`). */
export type PlanStep =
	| {
			readonly kind: "createCarrier"
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
	| {
			readonly kind: "advance"
			readonly action: PlanAction
			readonly relation: WrittenRelation
			readonly input: RereadInput
			/** The explicit serial fields the addition carries, each advanced past (serial/advance.ts explicitSerials). */
			readonly fields: NonEmptyReadonlyArray<LawField>
	  }
	| {
			readonly kind: "classify"
			readonly action: PlanAction
			readonly relation: WrittenRelation
			readonly serial: SerialClass
			readonly input: WriteInput
			readonly span: SpanField
			readonly of: InsertOf
	  }
	| { readonly kind: "readBack"; readonly read: ReadBack }
	| {
			readonly kind: "check"
			readonly stratum: StratumAt
			readonly input: WriteInput
			readonly check: PlannedCheck
	  }
	| { readonly kind: "family"; readonly stratum: StratumAt; readonly node: FamilyNode }
	| { readonly kind: "hold"; readonly hold: HeldUnit }

export interface WritePlan {
	readonly steps: ReadonlyArray<PlanStep>
	readonly carriers: ReadonlyArray<WriteCarrier>
	/** The sides of each relation's delta some statement makes, by the relation's name; every other side, a world
	 * relation's whose definition reads nothing the ChangeSet writes included, is empty by construction. */
	readonly made: ReadonlyMap<string, ReadonlySet<DeltaSide>>
}

/** One statement of an action before its stratum's inputs are placed: an exact deletion's excepted additions are
 * the actions its draft reads after its own, and whether it is anchored is decided once its input is placed. */
type DraftStep =
	| Exclude<WriteOpStep, { readonly op: "exactDelete" | "anchoredDelete" }>
	| { readonly op: "exactDelete" }
	| { readonly op: "advance"; readonly fields: NonEmptyReadonlyArray<LawField> }
	| {
			readonly op: "classify"
			readonly serial: SerialClass
			readonly span: SpanField
			readonly of: InsertOf
	  }
	| {
			readonly op: "precheck"
			readonly entry: CheckedEntry
			readonly names: CheckNames
			readonly serial: SerialClass
	  }

/** A statement that reads its action's input as the action's own: every one but a sequence advance, which reads it
 * again after the statement that wrote it. */
type StatementStep = Exclude<DraftStep, { readonly op: "advance" }>

/** A statement that writes its relation: every one but a sequence advance, a span classification and a query entry's
 * precheck, which read it or its input. */
type WriteStepDraft = Exclude<DraftStep, { readonly op: "advance" | "classify" | "precheck" }>

const isWriteStep = (step: DraftStep): step is WriteStepDraft =>
	step.op !== "advance" && step.op !== "classify" && step.op !== "precheck"

/** One action of a stratum before its input is placed: the action as its statements name it, its statements in order,
 * and, for an exact deletion, the positions of the additions to its relation it excepts, which read their inputs at the
 * deletion too. */
interface ActionDraft {
	readonly at: PlanAction
	readonly action: ChosenAction
	readonly steps: ReadonlyArray<DraftStep>
	readonly excepts: ReadonlyArray<number>
}

/** The statement of an action that reads its input once: its one statement when it has one; none when several do,
 * as a sequence advance reads it again after the addition. */
const loneStep = (steps: ReadonlyArray<DraftStep>): StatementStep | undefined => {
	const [only, ...rest] = steps
	return only === undefined || rest.length > 0 || only.op === "advance" ? undefined : only
}

/** An action with its input placed: a described member read inline by the one statement that reads it, or an input
 * every statement of the action reads, a relation parameter or a carrier, which a sequence advance reads again. */
type PlacedAction =
	| {
			readonly kind: "inline"
			readonly draft: ActionDraft
			readonly step: StatementStep
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
 * addition, and every member reads the stratum's starting state, the statement's own snapshot. */
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
	step: StatementStep,
	input: WriteInput,
	except: ReadonlyArray<WriteInput>
): PlanStep => {
	const relation = draft.action.info.relation
	switch (step.op) {
		case "classify":
			return {
				kind: "classify",
				action: draft.at,
				relation,
				input,
				serial: step.serial,
				span: step.span,
				of: step.of
			}
		case "precheck":
			return {
				kind: "check",
				stratum: draft.at.stratum,
				input,
				check: {
					kind: "membership",
					entry: step.entry,
					names: step.names,
					serial: step.serial,
					action: draft.at,
					relation
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
		case "reread": {
			const { input } = placed
			return draft.steps.map((step): PlanStep =>
				step.op === "advance"
					? {
							kind: "advance",
							action: draft.at,
							relation: draft.action.info.relation,
							input,
							fields: step.fields
						}
					: statementStep(draft, step, input, except)
			)
		}
	}
}

/** The statements of one action, in order; a put's by the target its choice chose for it, then the sequence advance
 * every addition's explicit serial values oblige (see `planWrite`). */
const opsOf = (action: ChosenAction, level: Isolation): ReadonlyArray<DraftStep> => {
	switch (action.op) {
		case "delete":
			return [{ op: "exactDelete" }]
		case "insert":
			return [
				...precheckOf(action, action.serial),
				{ op: "insert", serial: action.serial, entry: action.info.entry },
				...classify(action.info.relation, action.serial, "insert", level),
				...advanceOf(action.info.relation, action.serial)
			]
		case "put":
			return [...putOps(action, level), ...advanceOf(action.info.relation, completeClass)]
	}
}

/** The precheck of an addition into a query entry, right before its insert statement. */
const precheckOf = (action: ChosenAction, serial: SerialClass): ReadonlyArray<DraftStep> => {
	const entry = action.info.entry
	return entry.kind === "entry"
		? [{ op: "precheck", entry: entry.entry, names: entry.names, serial }]
		: []
}

/** The sequence advance after an addition whose facts carry explicit serial values, of each of them. */
const advanceOf = (relation: RelationInfo, serial: SerialClass): ReadonlyArray<DraftStep> => {
	const [first, ...rest] = explicitSerials(relation, serial)
	return first === undefined ? [] : [{ op: "advance", fields: [first, ...rest] }]
}

/** The classification after an insert of `of` into a span primary key (`buildSpanClassify`), at READ COMMITTED: at
 * SERIALIZABLE the insert classifies the requested facts it met itself (protocol.ts Arbitration `every`). */
const classify = (
	relation: RelationInfo,
	serial: SerialClass,
	of: InsertOf,
	level: Isolation
): ReadonlyArray<DraftStep> => {
	const key = primaryKeyShape(relation)
	return serial.kind === "complete" && key.kind === "span" && level === "readCommitted"
		? [{ op: "classify", serial, span: key.span, of }]
		: []
}

/** The statements of a put's chosen target. */
const putOps = (
	put: Extract<ChosenAction, { readonly op: "put" }>,
	level: Isolation
): ReadonlyArray<DraftStep> => {
	const { choice } = put
	const relation = put.info.relation
	switch (choice.target) {
		case "deleteThenInsert": {
			const payload = payloadOf(relation)
			return [
				...(payload.kind === "pureSet"
					? []
					: [{ op: "displace", payload: payload.fields } as const]),
				...precheckOf(put, completeClass),
				{ op: "putInsert", entry: put.info.entry },
				...classify(relation, completeClass, "put", level)
			]
		}
		case "onConflictDoUpdate":
			return [
				{
					op: "upsert",
					input: choice.slot.input,
					inPlace: choice.inPlace,
					arbiter: choice.arbiter
				}
			]
		case "updateFrom":
			return [{ op: "updateFrom", inPlace: choice.inPlace }]
		case "ownerPut":
			return [
				...precheckOf(put, completeClass),
				...(choice.inPlace === undefined
					? []
					: [{ op: "updateFrom", inPlace: choice.inPlace } as const]),
				{ op: "putInsert", entry: put.info.entry },
				...classify(relation, completeClass, "put", level)
			]
		case "merge":
			return [
				{ op: "merge", inPlace: choice.inPlace, arbiter: choice.arbiter, scope: choice.merge.scope }
			]
	}
}

/** What the plan may rely on about a described member beyond the write DAG's own evidence: whether its rows, as the
 * artifact lowers them, are distinct (`distinctByEvidence`). */
interface PlanEvidence {
	/** The level the write runs at, which decides whether an insert into a span primary key classifies what it met
	 * itself (`classify`). */
	readonly level: Isolation
	readonly distinct: (node: RelNode, relation: RelationInfo) => boolean
	/** The sub-queries several of a stratum's member statements read, each statement rooted at one member's node, to be
	 * carried across them (`planStatementShares`). */
	readonly shares: (members: ReadonlyArray<RelNode>) => ReadonlyArray<CarriedShare>
	/** The type each carrier column is declared with, which the carrier's name digests (write/carriers CarrierTyping). */
	readonly carrierTyping: CarrierTyping
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

/** The positions of the additions to an exact deletion's relation that it excepts: every complete addition to it, or,
 * for a deletion of a relation parameter's facts, only the described ones. None for any other action. */
const exceptsOf = (
	actions: ReadonlyArray<ChosenAction>,
	action: ChosenAction
): ReadonlyArray<number> => {
	if (action.op !== "delete") {
		return []
	}
	const additions = actions.flatMap((b, index) =>
		b.relation === action.relation && completeAddition(b) ? [{ index, action: b }] : []
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

/** The steps of stratum `stratum` realized one statement after another: each shared sub-query carried from the start
 * of the stratum; each described member read inline by the one statement that reads it when no earlier statement of
 * the stratum writes a relation it reads directly, and carried from the start of the stratum otherwise; then each
 * action's statements. */
const sequentialSteps = (
	stratum: StratumAt,
	drafted: ReadonlyArray<ActionDraft>,
	family: ReadonlyArray<FamilyAt>,
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
		steps.push({ kind: "createCarrier", carrier, stratum })
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
		steps.push({ kind: "createCarrier", carrier, stratum })
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
			return [{ kind: "family", stratum, node: f.node }]
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

/** The stored relations a step's statements change: a write's relation, a single statement's writes', a family
 * statement's; a carrier's, a check's, a sequence advance's, a classification's and a hold's change none. */
const stepWrites = (step: PlanStep): ReadonlyArray<string> => {
	switch (step.kind) {
		case "write":
			return [step.relation.name]
		case "single":
			return step.writes.map((w) => w.relation.name)
		case "family":
			return familyNodeRelations(step.node)
		case "createCarrier":
		case "fillMember":
		case "fillShare":
		case "advance":
		case "classify":
		case "check":
		case "readBack":
		case "hold":
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

/** The stored relations reading `relation` reads: in a role's program, a world relation's definition's (its view's), a
 * relation it holds whole itself; in reality's, the relation itself, a derived relation's view changing only at its
 * refresh. */
const storedReads = (frontend: WriteFrontend, relation: string): ReadonlyArray<string> => {
	const world = frontend.schema.world
	if (world.kind === "reality") {
		return [relation]
	}
	const held = world.role.relations[relation]
	return held === undefined || held.kind === "whole" ? [relation] : held.reads
}

/** A statement that runs once and returns its writes' rows, which a read-back may ride: a lone write, or a single
 * statement. */
type Rideable = Extract<PlanStep, { readonly kind: "write" | "single" }>

/** `step` with the read-backs `riders` riding it: a single statement's own, or a lone write's as a single statement of
 * that one write. */
const ridden = (step: Rideable, riders: NonEmptyReadonlyArray<ReadBack>): PlanStep =>
	step.kind === "single"
		? { ...step, readBacks: riders }
		: {
				kind: "single",
				stratum: step.action.stratum,
				shares: [],
				writes: [step],
				readBacks: riders
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
			return writesMet(write.relation, write.serial, "insert") ? ["added", "met"] : ["added"]
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

/** One side of a relation's delta a statement makes: by a write of it, or by a family statement, which no read-back's
 * delta names (frontend/compile.ts refuses one) and which is never one half of a put. */
type SideWrite = {
	readonly relation: string
	readonly side: DeltaSide
} & ({ readonly kind: "write"; readonly write: PlannedWrite } | { readonly kind: "family" })

/** The sides of the relations' deltas a step's statements make: a write's by its op, a single statement's by its
 * parts', a family statement's both sides of each relation it writes; a carrier's, a check's, a sequence advance's, a
 * classification's and a hold's none. */
const stepSides = (step: PlanStep): ReadonlyArray<SideWrite> => {
	const ofWrite = (write: PlannedWrite): ReadonlyArray<SideWrite> =>
		opSides(write).map((side): SideWrite => ({
			kind: "write",
			relation: write.relation.name,
			side,
			write
		}))
	switch (step.kind) {
		case "write":
			return ofWrite(step)
		case "single":
			return step.writes.flatMap(ofWrite)
		case "family":
			return familyNodeRelations(step.node).flatMap((relation) =>
				bothSides.map((side): SideWrite => ({ kind: "family", relation, side }))
			)
		case "createCarrier":
		case "fillMember":
		case "fillShare":
		case "advance":
		case "classify":
		case "check":
		case "readBack":
		case "hold":
			return []
	}
}

/** Whether `a` and `b` are the two statements of one put realized as the DELETE-then-insert pair: its displacing
 * deletion and its insert half. The deletion makes only removals and the insert half only additions, and no fact is
 * both: a displaced occupant differs in its payload from the one fact the put names at its key (write/delete/exact.ts
 * buildDisplacingDelete), and the insert half adds only facts the put names, so the pair's sides never cancel. */
const putHalves = (a: SideWrite, b: SideWrite): boolean =>
	a.kind === "write" &&
	b.kind === "write" &&
	a.write.action === b.write.action &&
	((a.write.op === "displace" && b.write.op === "putInsert") ||
		(a.write.op === "putInsert" && b.write.op === "displace"))

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
 * - every side it names is made whole by S: S is the only statement that makes that side of the relation, and every
 *   other statement that makes the side it nets against (`nettedAgainst`) is the other half of S's own put
 *   (`putHalves`), whose rows never cancel S's; so S's rows of the side are the netted delta (runtime/write/net.ts);
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
	/** The relation a Delta names the delta of: its own, or a query entry's target. */
	const targetOf = (relation: string): string =>
		frontend.deltaEntries.get(relation)?.target.name ?? relation
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
			(other) => other.position !== maker.position
		)
		return netting.every((other) => putHalves(maker.write, other.write))
			? { kind: "at", position: maker.position }
			: twice
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
		if (step?.kind !== "write" && step?.kind !== "single") {
			throw defect(`a read-back's delta made by a statement no read-back rides, at ${position}`)
		}
		const later = withCascades(writes.slice(position).flat(), frontend)
		const state = read.node.meta.reads.find((r) =>
			storedReads(frontend, r).some((s) => later.has(s))
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
			if (step.kind !== "write" && step.kind !== "single") {
				return step
			}
			const riding = riders.get(step)
			return riding === undefined ? step : ridden(step, riding)
		}),
		after,
		made
	}
}

/** Whether `step` reads or writes a relation of `held`'s unit the write touches: a body it writes, by an action, a
 * classification or a family statement, or a relation a member, a shared sub-query or a read-back of it reads,
 * through a role's views (`storedReads`). A header written touches nothing; a member reading the header the unit
 * holds for its retirement field touches it, and is held before it reads it. */
const touchesUnit = (frontend: WriteFrontend, step: PlanStep, held: HeldUnit): boolean => {
	const reads = (node: RelNode): boolean =>
		node.meta.reads.some((r) => storedReads(frontend, r).some((s) => held.observed.has(s)))
	const body = (relation: string): boolean => held.unit.bodies.has(relation)
	const input = (i: WriteInput): boolean => i.kind === "described" && reads(i.node)
	const write = (w: PlannedWrite): boolean =>
		body(w.relation.name) || input(w.input) || (w.op === "exactDelete" && w.except.some(input))
	switch (step.kind) {
		case "write":
			return write(step)
		case "single":
			return (
				step.writes.some(write) ||
				step.shares.some((share) => reads(share.node)) ||
				step.readBacks.some((read) => reads(read.node))
			)
		case "fillMember":
			return reads(step.node)
		case "fillShare":
			return reads(step.share.node)
		case "classify":
			return body(step.relation.name) || input(step.input)
		case "check":
			return input(step.input)
		case "readBack":
			return reads(step.read.node)
		case "family":
			return familyNodeRelations(step.node).some(body)
		case "createCarrier":
		case "advance":
		case "hold":
			return false
	}
}

/**
 * `steps` with each unit of `holds` held right before the first of them that touches it (`touchesUnit`), in its
 * header's order: from the hold until the transaction ends, no retirement of a group the write states commits, so the
 * rows of the unit's bodies each statement after it reads and writes are, for the call, as an insert-only relation's
 * (write/hold/stated.ts heldUnits). A write that inserts a header and the bodies of its group holds them after the
 * header's statement, which the action order runs first (`planWrite`), so the group it creates is open when the hold
 * locks it.
 */
const placeHolds = (
	frontend: WriteFrontend,
	steps: ReadonlyArray<PlanStep>,
	holds: ReadonlyArray<HeldUnit>
): ReadonlyArray<PlanStep> =>
	holds.reduce<ReadonlyArray<PlanStep>>((placed, hold) => {
		const at = placed.findIndex((step) => touchesUnit(frontend, step, hold))
		if (at < 0) {
			throw defect(`a statement touching the retirable unit ${hold.unit.header} the write holds`)
		}
		return [...placed.slice(0, at), { kind: "hold", hold }, ...placed.slice(at)]
	}, steps)

/** The sequence of statements a compiled ChangeSet runs inside its one transaction, from the write front end's order of
 * each stratum's actions by their dependency graph and the statement chosen for each put.
 *
 * Each action becomes its statements, in action order:
 *
 * - a deletion: the exact deletion of its member, reading D EXCEPT A when the stratum also adds to the relation and
 *   either side is described; two enumerated sides the host already netted;
 * - an insertion: the insert protocol for its relation and member shape, followed, into a span primary key, by the
 *   statement that classifies each requested fact it did not insert, then one sequence advance per serial field when
 *   it carries explicit serial values; a generated class of no field reads the unit input like any other;
 * - a put: its target's statements: the displacing deletion and the insert protocol as its insert half for the
 *   DELETE-then-insert pair (a pure set displaces nothing), or the one ON CONFLICT DO UPDATE, UPDATE ... FROM or MERGE
 *   statement, which absorbs the deletion it was proved with; then the sequence advances when its facts carry explicit
 *   serial values.
 *
 * The sequence advance is the addition's, not its statement's: an insertion or a put whose facts carry explicit serial
 * values advances each sequence past them whatever statement realizes it, UPDATE ... FROM included, which inserts
 * nothing but names complete facts, so the sequence ends past the keys the action names on every realization.
 *
 * Where each described member is evaluated. Every member of a stratum is evaluated against the state before the
 * stratum's writes, once. A member is a leading CTE of the statement that consumes it when that statement is its only
 * consumer and no earlier statement of the stratum writes a relation it reads, so the statement's snapshot is the
 * stratum's starting state for everything the member reads; this is the one-statement, no-carrier realization.
 * Otherwise it is evaluated into a transaction-scoped carrier at the start of the stratum, before any of the stratum's
 * writes, and every consumer reads the carrier: the two statements of an immutable put, an insertion followed by its
 * sequence advance or by its classification into a span primary key, an addition a deletion reads as D EXCEPT A, or a
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
 * Read-backs are placed by what they read (`placeReadBacks`): a read-back whose deltas one statement makes whole, and
 * whose state reads that statement and every later one leave alone, rides that statement, evaluated in it over its
 * RETURNING; one that reads no delta a statement makes comes last, after the last stratum; any other is refused
 * (ReadBackCrossesStatements), since a delta never leaves the statement that makes it.
 *
 * Each retirable unit the write touches, `holds`, is held before the first statement that touches it (`placeHolds`). A
 * stratum that writes the header of one is realized sequentially, so its hold can stand after the header's statement
 * and before its bodies'.
 *
 * A stratum is realized sequentially, one statement per write action plus the member carriers, sequence advances and
 * classifications the rules above require, or as a single statement where one snapshot suffices: its statements are at
 * least two writes of distinct relations and nothing else, so no statement reads what another writes, a deletion
 * excepts no addition (that takes an addition to its own relation), and no member needs a carrier, because every
 * member reads the stratum's starting state, which is the single statement's own snapshot. Its actions are then
 * sibling data-modifying CTEs of one statement, its shared sub-queries CTEs they read, and its rows each action's rows
 * behind an action tag (`singleStatement`). Both realizations evaluate every member once against the stratum's starting
 * state, so final states, outcomes and reads are the same. */
export const planWrite = (
	frontend: WriteFrontend,
	chosen: ChosenTargets,
	evidence: PlanEvidence,
	holds: ReadonlyArray<HeldUnit>
): WritePlan => {
	const supply = new CarrierSupply(evidence.carrierTyping)
	/** The strata's statements, the read-backs placed among them below. */
	const strata: Array<PlanStep> = []
	/** The nodes each stratum's members reach: a carried copy holds its stratum's starting state, so a node another
	 * stratum's member also reaches is never carried. */
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

	for (const [s, { actions, outside, family }] of strataAt(chosen.strata)) {
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
							steps: opsOf(action, evidence.level),
							excepts: exceptsOf(actions, action)
						}
					]
		)
		/** The sub-queries several member statements read, carried from the start of the stratum. */
		const members = drafted.flatMap(({ action }) =>
			action.info.reads.kind === "described" ? [action.info.reads.node] : []
		)
		const shares = (members.length < 2 ? [] : evidence.shares(members)).filter(
			(share) =>
				!share.copies.some((copy) => reached.some((nodes, t) => t !== s && nodes.has(copy)))
		)
		/** A stratum one statement realizes runs its family statements after that statement, whose snapshot is the
		 * stratum's starting state, so one whose schedule runs a family statement before any of its actions is realized
		 * sequentially, its members carried where an earlier statement wrote what they read. */
		const before = family.some((f) => f.at < actions.length)
		/** A stratum that writes a held unit's header holds the unit after the header's statement. */
		const creates = holds.some((h) =>
			drafted.some((d) => d.action.info.relation.name === h.unit.header)
		)
		const realization: Realization =
			before || creates ? { kind: "sequential" } : realizationOf(drafted)
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
				appendAll(
					strata,
					family.map((f): PlanStep => ({ kind: "family", stratum: s, node: f.node }))
				)
				break
			case "sequential":
				appendAll(strata, sequentialSteps(s, drafted, family, shares, supply, evidence))
				break
		}
	}

	const placement = placeReadBacks(frontend, strata)
	const steps: Array<PlanStep> = [...placement.strata]
	for (const read of placement.after) {
		steps.push({ kind: "readBack", read })
	}
	return Object.freeze({
		steps: Object.freeze(placeHolds(frontend, steps, holds)),
		carriers: Object.freeze(supply.all()),
		made: placement.made
	})
}
