import type { CatalogKey } from "#compiler/analysis/physical/evidence.ts"
import type { CheckedEntry, CheckedSchema, DerivedAnalysis } from "#compiler/analysis/schema.ts"
import { layoutKey, readsOf } from "#compiler/analysis/theory/fill.ts"
import { immediateEvidence } from "#compiler/analysis/theory/theory.ts"
import { checkFill, checkMember, checkReadBack } from "#compiler/check/index.ts"
import type { MemberColumn, MemberRelation } from "#compiler/check/schema.ts"
import {
	positionalColumns,
	type RelationNormalizer,
	type RelationSlot,
	type RelationSpec,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import { type LawId, ParamId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import type * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { rooted } from "#compiler/ir/dag.ts"
import type { ChangeSetDesc, MemberDesc } from "#compiler/ir/desc.ts"
import { type Family, isSequence, isTreeOf } from "#compiler/ir/family.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import { slotSpelling } from "#compiler/ir/slots.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import {
	type Action,
	type ActionCore,
	type ActionOp,
	type ActionSource,
	completeClass,
	type ReadBack,
	type SerialClass,
	type Stratum,
	type WriteIR
} from "#compiler/ir/write.ts"
import { derivedKeyConstraints } from "#compiler/laws/model/catalog.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { keyWitness } from "#compiler/laws/model/uniques.ts"
import {
	analyzeLogical,
	judgedAsDelivered,
	type LogicalAnalysis
} from "#compiler/logical/annotate.ts"
import { everyParentTakes } from "#compiler/lower/shapes/take/decorrelate.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { groupBy } from "#compiler/write/defined.ts"
import type { CheckNames, WriteWorld } from "#compiler/write/entry/precheck.ts"
import { deltaSources, GlueBuilder, QueryMerger, substitute } from "#compiler/write/frontend/dag.ts"
import {
	type EntryClaims,
	entryDraws,
	entryFacts,
	entryFillable,
	entryRelation,
	entryRowsParam,
	fillQuery,
	type SerialDraw
} from "#compiler/write/frontend/entry.ts"

import { relationDepths } from "#compiler/write/family/compose.ts"
import { fixedSentence } from "#compiler/write/family/edit.ts"
import {
	closedLeaf,
	type ClosedRows,
	columnKey,
	familyKey,
	type HostEvaluator,
	hostEvaluator,
	literalHost
} from "#compiler/write/family/fold.ts"
import { type Nesting, nestingOf } from "#compiler/write/family/nesting.ts"
import {
	endColumns,
	memberFamilies,
	type RowColumn,
	rowLayout
} from "#compiler/write/family/statements.ts"
import {
	type PlainRefill,
	plainRefills,
	type RefillHolds,
	type StratumRefill,
	type StratumWrite,
	stratumRefill
} from "#compiler/write/frontend/refill.ts"
import {
	canonicalActionOrder,
	type FamilyAdditions,
	type FamilyAt,
	type FamilyNode,
	type FamilyPair,
	type FamilyRemovals,
	type GeneratedColumn,
	generating,
	type ImmediateReference,
	type Meeting,
	type RemovalEdit,
	scheduleStratum,
	updateChanges
} from "#compiler/write/frontend/schedule.ts"
import { payloadOf } from "#compiler/write/frontend/targets.ts"
import { type RelationInput, relationInput } from "#compiler/write/insert/input.ts"
import { isCarried, isSerialField } from "#compiler/write/insert/statement.ts"
import { type RelationUniques, relationUniques } from "#compiler/write/insert/unique.ts"
import { type HostChecks, hostChecks } from "#compiler/write/normalize/normalize.ts"
import { existingKeysProof } from "#compiler/write/put/proof.ts"

export interface FrontendOptions {
	/** Which contexts the Db holds a fact of: a query entry's addition fills its fixed fields from them. */
	readonly claims: EntryClaims
	/** The law model of the checked schema's Owned (`SchemaArtifacts.laws`). */
	readonly laws: LawModel
	/** The derived analysis of the schema every written relation is an ordinary relation of, reality's own or the
	 * role's base (`SchemaArtifacts.derived`). */
	readonly derived: DerivedAnalysis
	/** The world the compilation's statements are named in: a role's names its query entries' checks call. */
	readonly world: WriteWorld
	/** The installation's codes, which every member's normalizer admits a closed id's and a set's values by. */
	readonly codes: Codebook
}

/** The classes an insertion into a target's facts fall in, each with what it carries, decided once per target where
 * its member is checked (`targetOf`). Unclassed: a target with no serial field to draw, every fact complete. Classed:
 * every fact omits all of `serial`, the member's fields carrying a serial field it may leave out (generated), or none
 * (complete); `drawn` is the generated class, the target's serial fields its identity draws, which every statement
 * of the class reads. A generated class of no field is the unit relation: it holds the one empty fact or none. */
type InsertClasses<A> =
	| { readonly kind: "unclassed"; readonly complete: A }
	| {
			readonly kind: "classed"
			readonly serial: NonEmptyReadonlyArray<string>
			readonly drawn: Extract<SerialClass, { readonly kind: "generated" }>
			readonly complete: A
			readonly generated: A
	  }

/** One relation parameter of a write: the facts of one class of one operation's enumerated members, normalized on the
 * host (normalize/) and sent as its arrays, one per column. Its codecs are built with it, over its heading's positional
 * columns. */
export interface MemberSlot {
	readonly slot: ParamId
	/** stream when some member is a Stream, collected on the host, whole. */
	readonly transport: "enumerated" | "stream"
	/** The fields its facts carry, in heading order: its class's (`InsertClasses`), none for the unit relation. */
	readonly heading: Heading
	/** The slot as its action's relation input, its columns in key-first order (insert/input.ts relationInput). */
	readonly input: RelationInput
}

/** A member an enumerated input reads, by its member slot, with what admits its facts, whose faults name the member. */
export interface InputMember<N> {
	readonly name: string
	readonly normalize: N
}

/** An operation an enumerated input of one slot is read by: a deletion, a put, or an insertion into an unclassed
 * target, whose every fact is complete. */
export type SingleAct =
	| { readonly op: "delete" }
	| { readonly op: "put" }
	| { readonly op: "insert"; readonly serial: Extract<SerialClass, { readonly kind: "complete" }> }

/** The enumerated members of one operation on one relation in one stratum, and the slot each of their facts travels
 * in: one slot, for a deletion, a put and an insertion into an unclassed target; an insertion into a classed target,
 * every fact of which the host routes to exactly one of its two slots or refuses; or an insertion whose facts nest
 * families at their count fields (write/family/nesting.ts), split, filled and cut into its families' writes on the
 * host, its relation's own rows in its slot, every column but a generated one, and none for a tree's roots, which
 * their tree's write inserts. */
export type EnumeratedInput =
	| {
			readonly kind: "nested"
			readonly act: Extract<SingleAct, { readonly op: "insert" }>
			readonly slot: MemberSlot
			readonly nesting: Nesting
			/** Each member relation its families reach, as its same-key checks judge its nested rows. */
			readonly reached: ReadonlyMap<string, SlotFacts>
			readonly members: NonEmptyReadonlyArray<InputMember<RelationNormalizer>>
	  }
	| {
			readonly kind: "single"
			readonly act: SingleAct
			readonly slot: MemberSlot
			readonly members: NonEmptyReadonlyArray<InputMember<RelationNormalizer>>
			/**
			 * The fields its slot carries beyond the ones its facts do, each at its start: an owner's counts and ends,
			 * which an owner of counted families inserted on the plain path writes from its slot, so the stratum's
			 * appends to it ride its own row (write/program/bind.ts); none for any other input.
			 */
			readonly starts: ReadonlyArray<{ readonly name: string; readonly value: unknown }>
	  }
	| {
			readonly kind: "classed"
			readonly serial: NonEmptyReadonlyArray<string>
			readonly complete: MemberSlot
			readonly generated: MemberSlot
			readonly members: NonEmptyReadonlyArray<
				InputMember<{
					readonly complete: RelationNormalizer
					readonly generated: RelationNormalizer
				}>
			>
	  }

/** The member slots an enumerated input fills, in the order the front end drafts them: its one slot, or the complete
 * slot and then the generated one. */
export const inputSlots = (input: EnumeratedInput): NonEmptyReadonlyArray<MemberSlot> => {
	switch (input.kind) {
		case "single":
		case "nested":
			return [input.slot]
		case "classed":
			return [input.complete, input.generated]
	}
}

/** The enumerated inputs of one relation in one stratum, one per operation, which the host normalizes together
 * (normalize/): a same-key refusal compares their additions. */
export interface SlotGroup {
	readonly stratum: StratumAt
	readonly relation: WrittenRelation
	readonly inputs: NonEmptyReadonlyArray<EnumeratedInput>
	/** The facts as the host checks them: the relation's or a query entry's name, and its same-key checks. */
	readonly facts: SlotFacts
}

/** What the host's normalization reads of the facts of a slot group: the relation the facts are of as a refusal names
 * it, and its same-key checks, over the facts' own fields. */
export interface SlotFacts {
	readonly name: string
	readonly host: HostChecks
}

/** A stratum's edits of one member relation: its slots, each normalized as any slot is, by operation. */
export interface StratumEdit {
	readonly stratum: StratumAt
	readonly relation: WrittenRelation
	readonly inserts: ParamId | undefined
	readonly puts: ParamId | undefined
	readonly deletes: ParamId | undefined
}

/** A nested write of a stratum: the insert's relation's nesting and the slot its facts travel in. */
export interface NestedWrite {
	readonly stratum: StratumAt
	readonly nesting: Nesting
	readonly slot: MemberSlot
}

/** A declared key, its fields' handles in its object's order, a span last, and the law its object reports with its
 * description: identity must be declared honestly. */
export interface KeyLaw {
	readonly fields: NonEmptyReadonlyArray<LawField>
	readonly law: LawId
	readonly described: Law
}

/** A relation the ChangeSet writes: its checked information, its declared keys with their laws, the primary key's first,
 * whose law a refusal at the insert protocol's arbiter raises, and the unique objects an insert
 * into it meets. */
export type WrittenRelation = RelationInfo & {
	readonly keyLaws: NonEmptyReadonlyArray<KeyLaw>
	readonly uniques: RelationUniques
	/** The host's same-key checks of its enumerated additions. */
	readonly host: HostChecks
}

/** Where facts of a written relation meet (schedule.ts Meeting): at its primary key where it has a payload, else at a
 * unique object besides it where it has one, else nowhere. */
const meetingOf = (relation: WrittenRelation): Meeting =>
	payloadOf(relation).kind === "keyed"
		? "key"
		: isNonEmpty(relation.uniques.others)
			? "unique"
			: "nowhere"

/** A delta some read-back names (`ReadBack.deltas`), and the sides the read-backs name: an ordinary relation's,
 * read whole or through the query entry the role writes it by, whose delta is the relation's projected onto the
 * entry's head (WriteFrontend.deltaEntries); or the empty delta of a world relation whose definition reads nothing the
 * ChangeSet writes, carried in carriers of its heading that no statement fills. */
export type NamedDelta =
	| {
			readonly kind: "relation"
			readonly relation: RelationInfo
			readonly sides: "added" | "removed" | "both"
			readonly via: DeltaVia
	  }
	| {
			readonly kind: "empty"
			readonly name: string
			readonly heading: Heading
			readonly sides: "added" | "removed" | "both"
	  }

/** The law of a written relation's primary key, the insert protocol's arbiter. */
export const arbiterLaw = (relation: WrittenRelation): LawId => relation.keyLaws[0].law

/** What the write lowering needs about one action beyond the WriteIR's record. */
export interface ActionInfo {
	readonly relation: WrittenRelation
	readonly reads: SourceReads
	/** The heading its source delivers. */
	readonly heading: Heading
	/** What the action writes: its relation whole, or a role's query entry, whose fill its source reads through and whose
	 * membership its additions are prechecked against. */
	readonly entry: ActionEntry
}

/** How a delta reads its relation: whole, or through the query entry the role writes it by. */
export type DeltaVia =
	| { readonly kind: "whole" }
	| { readonly kind: "entry"; readonly entry: CheckedEntry }

export type ActionEntry =
	| { readonly kind: "whole" }
	| { readonly kind: "entry"; readonly entry: CheckedEntry; readonly names: CheckNames }

const whole: ActionEntry = Object.freeze({ kind: "whole" })

const describedIn = (
	node: RelNode,
	at: Counterpart
): Extract<SourceReads, { readonly kind: "described" }> =>
	Object.freeze({ kind: "described", node: at(node) })

const sourceReadsIn = (reads: SourceReads, at: Counterpart): SourceReads =>
	reads.kind === "described" ? describedIn(reads.node, at) : reads

/** An action's source with the node it names read through `at`. */
export const sourceIn = (source: ActionSource, at: Counterpart): ActionSource =>
	source.kind === "described" ? Object.freeze({ kind: "described", node: at(source.node) }) : source

/** An action's information with the node its reads name read through `at`. */
export const infoIn = (info: ActionInfo, at: Counterpart): ActionInfo =>
	Object.freeze({ ...info, reads: sourceReadsIn(info.reads, at) })

/** A refused addition with the node its sources name read through `at`. */
export const outsideIn = (write: OutsideWrite, at: Counterpart): OutsideWrite =>
	Object.freeze({ entry: write.entry, reads: sourceReadsIn(write.reads, at) })

/** The write's queries before its DAG is analyzed: the strata, each with its refused additions, and the read-backs over
 * the nodes the frontend built, read in each form of the DAG through that form's counterparts (queriesIn). */
interface Drafted {
	readonly strata: ReadonlyArray<WriteStratum>
	readonly reads: ReadonlyArray<ReadBack>
	readonly params: ReadonlyArray<ParamId>
}

/** The queries over `dag`, every node they name read through `at`, its counterpart in `dag`. */
const queriesIn = (drafted: Drafted, dag: ValidDag, at: Counterpart): WriteQueries =>
	Object.freeze({
		ir: Object.freeze({
			dag,
			strata: Object.freeze(
				drafted.strata.map((stratum): WriteStratum =>
					Object.freeze({
						actions: Object.freeze(
							stratum.actions.map((action) =>
								Object.freeze({
									...action,
									source: sourceIn(action.source, at),
									info: infoIn(action.info, at)
								})
							)
						),
						outside: Object.freeze(stratum.outside.map((write) => outsideIn(write, at))),
						family: stratum.family
					})
				)
			),
			reads: Object.freeze(drafted.reads.map((r) => Object.freeze({ ...r, node: at(r.node) }))),
			params: drafted.params
		})
	})

/** An addition into a query entry whose fixed fields read a context the Db holds no fact of: every fact its sources hold
 * is outside the world, so its refusal is raised when they hold any row, at the start of its stratum, where its
 * sources are evaluated. `entry` names the entry; `reads` is its enumerated slot, its described
 * sources' union, or both as one union, each delivering the entry's facts. */
export interface OutsideWrite {
	readonly entry: string
	readonly reads: SourceReads
}

/** What a source of facts reads, the write-side refinement of an action's source (`ActionSource`): its enumerated slot
 * alone, an enumerated or stream source; or a described source, its node, which holds the slot as one more union arm
 * when the action has one. A slot of no field is read like any other, as the unit relation. */
export type SourceReads =
	| { readonly kind: "slot"; readonly slot: MemberSlot }
	| { readonly kind: "described"; readonly node: RelNode }

/** A node the write names, read in another form of the write DAG: the node standing in its place there. */
export type Counterpart = (node: RelNode) => RelNode

/** A stratum of a write: its actions, each carrying its information, and the additions it refuses outright
 * (OutsideWrite). */
export interface WriteStratum extends Stratum<ActionInfo> {
	readonly outside: ReadonlyArray<OutsideWrite>
	/** Where each of the stratum's family statements runs among its actions (schedule.ts FamilyAt). */
	readonly family: ReadonlyArray<FamilyAt>
}

/** The WriteIR of a write's front end, each stratum with its refused additions. */
export interface FrontendIR extends WriteIR<ActionInfo> {
	readonly strata: ReadonlyArray<WriteStratum>
}

/** What a write reads, over one form of its DAG: its WriteIR, every node it names a node of `ir.dag`. */
export interface WriteQueries {
	readonly ir: FrontendIR
}

/** A member slot with the slot group and the enumerated input it belongs to (WriteFrontend `slotsById`). */
export interface SlotAt {
	readonly group: SlotGroup
	readonly input: EnumeratedInput
	readonly slot: MemberSlot
}

export interface WriteFrontend extends WriteQueries {
	/** The same queries over the write DAG the optimized artifact lowers: ir.dag with every take correlated through bind
	 * stated with its correlation explicit, analyzed in the same transaction context, every node under its own label. */
	readonly restated: WriteQueries
	/** The node of `restated.ir.dag` standing in the place of a node of `ir.dag`. */
	readonly restate: Counterpart
	readonly desc: ChangeSetDesc
	readonly schema: CheckedSchema
	readonly laws: LawModel
	/** Each derived relation's inherited keys with its view's unique index: with the laws, what the write's placement
	 * and read-backs resolve keys through (`evidenceCatalog`). */
	readonly views: ReadonlyArray<CatalogKey>
	/** The relations the ChangeSet writes, in code point order. */
	readonly written: ReadonlyArray<WrittenRelation>
	/** The parameters the members and read-backs declare, merged by name. */
	readonly params: ReadonlyArray<ParamDecl>
	/** The parameters ChangeSet.bind closed. */
	readonly bindings: ReadonlyArray<string>
	/** The enumerated slots, by stratum and relation in code point order. */
	readonly slots: ReadonlyArray<SlotGroup>
	/** Every member slot of `slots` by its parameter, with the slot group and the input it belongs to. */
	readonly slotsById: ReadonlyMap<ParamId, SlotAt>
	/** Each stratum's nested writes, by stratum and relation: the families each reaches, whose statements follow the
	 * stratum's own. */
	readonly nested: ReadonlyArray<NestedWrite>
	/** Each stratum's edits of a family's member relation (write/family/edit.ts): its slots of inserted, put and deleted
	 * rows, which no action of its own writes, the family planner's statements following the stratum's own. */
	readonly edits: ReadonlyArray<StratumEdit>
	/** Each stratum's refills (write/frontend/refill.ts), by its position among the occupied strata, as `edits` holds it. */
	readonly refills: ReadonlyArray<{ readonly stratum: StratumAt; readonly refill: StratumRefill }>
	/** The relations whose deltas the read-backs name, in code point order. */
	readonly deltas: ReadonlyArray<NamedDelta>
	readonly references: ReadonlyArray<ImmediateReference>
	/** The query entries whose deltas a read-back names as their targets' projected, by name (see deltaOf). */
	readonly deltaEntries: ReadonlyMap<string, CheckedEntry>
	/** The installation's codes, which binding encodes the declared parameters' closed ids and sets by. */
	readonly codes: Codebook
	/** The host's evaluation of generated fields, as PostgreSQL generates them, which the family planner's fill reads
	 * (write/family/edit.ts FillContext). */
	readonly evaluate: HostEvaluator
}

const refuse = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/**
 * Whether a fact determines a field's value: one its caller or its sequence writes (isCarried), or one PostgreSQL
 * generates from them, which the statement that writes the fact computes as PostgreSQL stores it. A field grizzle draws
 * or accumulates is no fact's.
 */
const determined = (field: LawField): boolean =>
	isCarried(field) || field.writing.kind === "generated"

/**
 * A put or a delete of `relation`, `member`, refused (UnstatedKey) where a key it reads off its facts holds a field no
 * fact determines (`determined`): its primary key, by which a put names each row and a family's edit each member, and,
 * for a put, every key its same-key checks compare, the primary key's first. A key holding a field grizzle writes, such
 * as a sequence's index, is stated by no fact; one holding a generated field is compared by the statement that writes
 * the facts, at the field's generation expression over each. A delete compares no key before it is sent, so only its
 * primary key is read; an insert names no row by its key, a sequence's members being inserted nested under their owner,
 * whose nesting draws their index.
 */
const refuseUnstatedKey = (member: MemberDesc, relation: WrittenRelation): void => {
	const op = member.op
	if (op === "insert") {
		return
	}
	const [primary, ...declared] = relation.keyLaws
	const read: ReadonlyArray<{ readonly kind: "primary" | "declared"; readonly law: KeyLaw }> = [
		{ kind: "primary", law: primary },
		...(op === "put" ? declared.map((law) => ({ kind: "declared" as const, law })) : [])
	]
	for (const { kind, law } of read) {
		const unstated = law.fields.filter((f) => !determined(f))
		if (isNonEmpty(unstated)) {
			throw new Refusal(
				CompileError.make({
					_tag: "UnstatedKey",
					at: member.loc,
					op,
					relation: relation.name,
					key: { kind, fields: law.fields.map((f) => f.name) },
					unstated: unstated.map((f) => f.name)
				})
			)
		}
	}
}

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/** The serial kind a member slot's parameter is spelled with, by its target's classes: none for an unclassed target;
 * for a classed one, generated for its generated class, explicit for complete facts, a deletion's or a put's. */
const slotKind = (
	act: ActionOp,
	classes: InsertClasses<Heading>
): "none" | "explicit" | "generated" => {
	switch (classes.kind) {
		case "unclassed":
			return "none"
		case "classed":
			return act.op === "insert" && act.serial.kind === "generated" ? "generated" : "explicit"
	}
}

/** The parameter a write's member slot binds, spelled by the one slot rule (`slotKind`) at its stratum's index among the
 * ChangeSet's strata, empty ones included, as the ChangeSet value names its members' arrays. `relation` is the member's
 * own: an ordinary relation, or a query entry's facts. */
const writeSlotId = (
	stratum: number,
	act: ActionOp,
	classes: InsertClasses<Heading>,
	relation: string
): ParamId => ParamId(slotSpelling("slot", stratum, act.op, slotKind(act, classes), relation))

/** The sides a read-back names of one delta: both, or the one it names. */
const sidesOf = (
	named: ReadonlyArray<{ readonly side: "added" | "removed" }>
): NamedDelta["sides"] => {
	const added = named.some((d) => d.side === "added")
	const removed = named.some((d) => d.side === "removed")
	return added && removed ? "both" : added ? "added" : "removed"
}

const sameHeading = (a: Heading, b: Heading): boolean =>
	a.length === b.length &&
	a.every((c) => {
		const d = b.find((x) => x.name === c.name)
		return d !== undefined && sameScalarType(c.type, d.type)
	})

/** A column as a member's facts carry it: its name and its type. */
const carriedColumn = (c: MemberColumn): HeadingColumn => ({
	name: c.name,
	type: c.type
})

/**
 * Whether an addition's facts carry a field written so: a caller's, and a serial one, which an insert may leave to its
 * sequence; never one PostgreSQL generates, which is never written, so no INSERT or UPDATE lists its column
 * (check/member.ts memberWrites, types/changeset UnwrittenFieldsOf).
 */
const additionCarries = (c: MemberColumn): boolean =>
	c.writing.kind === "caller" || c.writing.kind === "serial"

/** A member relation's classes, each the heading an addition's facts carry (`additionCarries`), by the serial fields of its target an addition may leave out (`draws`): an entry's serial head
 * fields its filter does not read (entry.ts entryDraws), a whole relation's every serial field. */
const classesOf = (
	member: MemberRelation,
	draws: ReadonlyArray<SerialDraw>
): InsertClasses<Heading> => {
	const complete = member.heading.filter(additionCarries).map(carriedColumn)
	const [first, ...rest] = draws
	if (first === undefined) {
		return { kind: "unclassed", complete }
	}
	const carried = mapNonEmpty([first, ...rest], (d) => d.carried)
	return {
		kind: "classed",
		serial: carried,
		drawn: { kind: "generated", drawn: mapNonEmpty([first, ...rest], (d) => d.field) },
		complete,
		generated: complete.filter((c) => !carried.includes(c.name))
	}
}

/** A described insertion's class, by the head its query delivers (checkMemberHeading has refused a head that supplies
 * some serial fields and not others). */
const describedClass = (classes: InsertClasses<Heading>, delivered: Heading): SerialClass => {
	switch (classes.kind) {
		case "unclassed":
			return completeClass
		case "classed":
			return classes.serial.every((f) => delivered.some((c) => c.name === f))
				? completeClass
				: classes.drawn
	}
}

/** What a member writes: its relation whole; or a query entry, its target its relation, `member` the entry's facts its
 * source carries, and whether the Db holds a fact of every context its fixed fields read. */
type MemberEntry =
	| { readonly kind: "whole" }
	| {
			readonly kind: "entry"
			readonly entry: CheckedEntry
			readonly names: CheckNames
			readonly member: MemberRelation
			readonly fillable: boolean
	  }

/**
 * A target as its members write it: its relation, whole or through a query entry, and its classes' carried headings.
 * targetOf decides it from the relation's name alone, so every member of one relation holds the one target, and its
 * classes head every operation's slot of the relation, a delete's, a put's and an insert's alike. A nested insert's
 * heading is its nesting's (Nesting.top), never a class, so it heads no other operation's slot.
 */
interface CheckedTarget {
	readonly relation: WrittenRelation
	readonly entry: MemberEntry
	readonly classes: InsertClasses<Heading>
}

/**
 * A stratum's member, checked: its operation, its target, and its source, an array or Stream member slot, or a query
 * with its root in the write DAG, whose head is the member relation's. Its target is its relation's, whole, as targetOf
 * decides it for every member of the relation: a member holds no heading or class of its own, so no member's statement
 * can set the heading another operation's slot of its relation is admitted and carried under.
 */
interface CheckedMember {
	readonly op: MemberDesc["op"]
	readonly target: CheckedTarget
	readonly loc: SourceLoc
	readonly source:
		| {
				readonly kind: "enumerated"
				readonly member: Exclude<MemberDesc["member"], { readonly kind: "query" }>
		  }
		| { readonly kind: "described"; readonly query: LogicalQuery; readonly root: RelNode }
}

/** What an action reads before its source is built: its enumerated slot alone, or the roots of its described members,
 * with its slot as one more arm of their union when it has one. */
type DraftReads =
	| { readonly kind: "slot"; readonly slot: MemberSlot }
	| {
			readonly kind: "described"
			readonly slot: MemberSlot | undefined
			readonly roots: NonEmptyReadonlyArray<RelNode>
	  }

/** What a draft writes: its relation whole, or a query entry through its fill, `reads` its sources in the entry's facts:
 * the fill's root in the write DAG, over its relation parameter `entryRowsParam`, which the sources are substituted
 * for (substitute). */
type DraftEntry =
	| { readonly kind: "whole" }
	| {
			readonly kind: "entry"
			readonly entry: CheckedEntry
			readonly names: CheckNames
			readonly fill: RelNode
	  }

/** An action before its source is built: what it does, its relation, the heading its sources' facts carry, what it
 * reads, and what it writes. */
interface Draft {
	readonly act: ActionOp
	readonly relation: WrittenRelation
	readonly carried: Heading
	readonly reads: DraftReads
	readonly entry: DraftEntry
}

/** A refused addition before its source is built (OutsideWrite), its sources' facts carrying `carried`. */
interface OutsideDraft {
	readonly entry: string
	readonly carried: Heading
	readonly reads: DraftReads
}

/**
 * The columns a family draws on its member, by key (write/family/edit.ts fillGroup): its index, its folds' accumulators,
 * and each column its owner and predecessor axes carry that the host draws, an accumulated field or a law column.
 */
const drawnBy = (f: Family): ReadonlyArray<string> => [
	columnKey(f.index),
	...f.folds.flatMap((fold) =>
		fold.planes.flatMap((plane) => [columnKey(plane.before), columnKey(plane.after)])
	),
	...[...f.axes.owner, ...f.axes.predecessor].flatMap((pair) =>
		pair.from.kind === "law" || pair.from.field.writing.kind === "accumulated"
			? [columnKey(pair.from)]
			: []
	)
]

/**
 * Where a stratum's family additions or removals stands in a cycle its stratum cannot order: the removals' member's
 * delete; the additions' member's insert, or its first owner's count where it appends to none.
 */
const familyWriteAt = (
	node: FamilyAdditions | FamilyRemovals
): { readonly relation: string; readonly op: "insert" | "delete" | "count" } => {
	if (node.kind === "removals") {
		return { relation: node.member, op: "delete" }
	}
	switch (node.appends) {
		case "rows":
			return { relation: node.member, op: "insert" }
		case "nothing":
			return { relation: node.owners[0].relation, op: "count" }
	}
}

/** Whether a member relation's row column is a field its caller writes, a caller's or a serial one. */
const callerWritten = (c: RowColumn): boolean =>
	c.column.kind === "field" &&
	(c.column.field.writing.kind === "caller" || c.column.field.writing.kind === "serial")

const merge = (params: Map<string, ParamDecl>, decl: ParamDecl, loc: SourceLoc): void => {
	const prior = params.get(decl.name)
	if (prior === undefined) {
		params.set(decl.name, decl)
		return
	}
	const same =
		prior.kind === "relation"
			? decl.kind === "relation" && sameHeading(prior.heading, decl.heading)
			: decl.kind === "scalar" && sameScalarType(prior.type, decl.type)
	if (!same) {
		refuse(
			"MalformedDescription",
			loc,
			`one declaration of parameter ${decl.name} across the ChangeSet's members and read-backs; two of them type it differently`
		)
	}
}

/** The ChangeSet description `desc` compiled against the checked schema `checked`. The law model and the derived
 * analysis are the ones its caller holds of the schema (`FrontendOptions.laws`, `.derived`).
 *
 * The write front end: a ChangeSetDesc against a schema to its WriteIR.
 *
 * The schema a ChangeSet was built over is a level of the schema it compiles against by content, whatever name places
 * either (`isLevelOf`): db.apply and db.compile check it before they compile
 * (`levelSchema`), and a workload finds the level its ChangeSet names. The description's schema name only
 * labels that level, so it is never compared with the name the compiled schema is installed under.
 *
 * 1. Check. Each member's relation is resolved once by name. Compiled for a role, it must be in the role's write list,
 *    which the types already require of db.apply (a description that breaks it is OutsideRole): a whole entry writes
 *    its ordinary relation of the base, and a query entry its writable entry's target; an insert also writes every
 *    sequence member its nesting reaches, whose rows a role holds nothing of unless its write list names it. Compiled
 *    for reality (a workload), it must be an ordinary relation (a closed or derived relation, which no ChangeSet writes, is
 *    MalformedDescription at the member). Each described member is checked as a query whose head is written into that
 *    relation, or into the entry's heading (checkMember: DescribedHeadingMismatch, an insert omitting all of its serial
 *    fields or none), and each read-back as a query over the post-change state that may read the delta sources of
 *    every ordinary relation (checkReadBack); both read the role's relations, which reach nothing else. The parameters
 *    of every member and read-back are one namespace, which the Description's decoder has checked holds every name
 *    ChangeSet.bind closed and no name of a member slot: a name declared twice must be declared alike,
 *    which the checked types of its declarations decide.
 * 2. Group. Within a stratum, the enumerated members (arrays and Streams) of one operation on one relation are one
 *    enumerated input (`EnumeratedInput`), the facts the host normalizes (normalize/): one slot read by one action, or,
 *    for an insert into a target with serial fields, one slot per class (`InsertClasses`), each read by its own action,
 *    because the program is compiled before its facts are drawn and an array may hold both. The host routes each fact
 *    to exactly one of them. A class whose facts carry no field is the unit relation, read like any other input.
 *    Every generated addition of one relation in one stratum, the generated slot and each described
 *    generated insert, is one action over the Union of its sources, because equal generated additions are one
 *    requested addition and yield one new fact; every other described insert or delete member is its
 *    own action. Every put source of one relation in one
 *    stratum is one action, because a put is the described deletion of the occupants at its members' keys, evaluated
 *    against the state before the stratum, plus their insertion: two separate statements would let the
 *    second deletion remove the first's new fact, so two puts of one key with different payloads would replace instead
 *    of conflicting. Several put sources are one described source, the Union of their queries and of
 *    the enumerated slot's InputSet, whose same-key check in the statement refuses such a pair.
 *    A query entry's action reads its sources through the entry's fill, one fill per action over
 *    the union of its sources, so it writes the target's facts. An addition into an entry whose fixed fields read a
 *    context the Db holds no fact of is no action but a refusal of its sources (WriteStratum.outside), and a deletion
 *    there is dropped.
 * 3. Serial class. Each insertion's serial class, decided once per target (`classesOf`): generated, when its facts
 *    omit every serial field the target lets them leave out (all of a relation's, a query entry's classed head
 *    fields), which its identity draws, `drawn`; or complete; a described member's by the head its query delivers
 *    (`describedClass`). The statement that realizes an action is the lowering's, a put's chosen with the proofs the
 *    whole ChangeSet gives. An insertion drafts its acts for its enumerated members whatever facts they are applied
 *    with: a classed target's both classes, each reading its own slot, the generated one with every described
 *    generated addition.
 * 4. Schedule. The stratum's dependency graph, from the relation phases and the schema's immediate foreign
 *    keys (`natives`).
 * 5. Evidence. The whole write DAG is analyzed in the transaction context, so a read-back, and a
 *    described member evaluated inside the transaction, rely on immediate-constraint evidence only: a deferred
 *    containment never narrows an attachment there.
 *
 * Empty strata are dropped: a stratum with no member is the identity transition, which ChangeSet.union keeps only to
 * align strata by position, so `sequence(a, empty)` means `a` alone. */
export const compileChangeSet = (
	checked: CheckedSchema,
	desc: ChangeSetDesc,
	options: FrontendOptions
): Result.Result<WriteFrontend, CompileError> => catchRefusal(() => compile(checked, desc, options))

/** A write into a query entry is judged against the entry's filter at its own statement, in the middle of its stratum
 * (, and the role's row security), so a stratum that also writes a relation the filter reads
 * would make which facts the entry holds depend on the order its statements run in. Such a write is refused, as a
 * delta of a world relation the ChangeSet moves is (deltaOf, below); the target, which a stratum writes only through
 * the entry, is no such relation. A later stratum (ChangeSet.sequence) is judged against the state the earlier one
 * left, so writing the relation in another stratum is admitted. */
const compile = (
	checked: CheckedSchema,
	desc: ChangeSetDesc,
	options: FrontendOptions
): WriteFrontend => {
	const at = SourceLoc("ChangeSet", [])
	const { laws, derived, codes } = options
	const views = derivedKeyConstraints(derived)
	/** The base every written relation is an ordinary relation of: reality's own, or the role's base. */
	const base = checked.definitions()

	/** 1. Check the members and read-backs, merging their queries into one DAG in that order. */
	const merger = new QueryMerger()
	const params = new Map<string, ParamDecl>()
	/** Every ordinary relation of the base as a member writes it: its declared keys with their laws, its unique objects
	 * and its host checks. */
	const writable = new Map(
		[...laws.relations].map(([name, written]): readonly [string, WrittenRelation] => {
			const uniques = relationUniques(written)
			const keyLaws = Object.freeze(
				mapNonEmpty(uniques.keys, (u): KeyLaw =>
					Object.freeze({ fields: keyWitness(u), law: u.law, described: u.described })
				)
			)
			return [
				name,
				Object.freeze({
					...written.relation,
					keyLaws,
					uniques,
					host: hostChecks(keyLaws, uniques, codes)
				})
			]
		})
	)
	const writtenOf = (name: string, loc: SourceLoc): WrittenRelation =>
		writable.get(name) ??
		refuse("MalformedDescription", loc, `an ordinary relation of the schema, not ${name}`)
	/** The schema's families: a nested insert reaches some of them (write/family/nesting.ts). */
	const families = laws.families
	/** The families of the schema as the schedule orders their statements, a tree's aside: each with its owner axis. */
	const pairs: ReadonlyArray<FamilyPair> = families.flatMap((f): ReadonlyArray<FamilyPair> => {
		if (isTreeOf(f, f.member.name)) {
			return []
		}
		/** The family's owner axis: the cascading key from its member to its owner over its count copy ‹n›. */
		const axis = laws.natives.find(
			(n) =>
				n.object.kind === "ForeignKey" &&
				n.object.onUpdate === "cascade" &&
				n.object.relation.name === f.member.name &&
				n.object.target.name === f.owner.name &&
				n.object.columns.some((c) => c.kind === "law" && c.column === f.copy)
		)?.object
		if (axis?.kind !== "ForeignKey") {
			throw defect(`the owner axis of the family ${f.id.owner}.${f.id.count}`)
		}
		return [
			{
				family: f.id,
				owner: f.owner.name,
				member: f.member.name,
				immediate: !axis.deferrable,
				fromColumns: axis.columns.map(columnKey),
				toColumns: axis.targetColumns.map(columnKey)
			}
		]
	})
	/** Whether `family`'s owner axis is immediate, which orders its members' rows after their owner's. */
	const immediateOwner = (family: Family): boolean =>
		pairs.some((p) => p.immediate && familyKey(p.family) === familyKey(family.id))
	/** The host's evaluation of the generated fields a nesting's copies, steps and selections read, over the schema's
	 * closed relations, as PostgreSQL generates them, by the law model's compiled patterns. */
	const evaluate = hostEvaluator(
		codes,
		closedLeaf(
			new Map(
				[...checked.closed].map(([name, c]): readonly [string, ClosedRows] => [
					name,
					{ heading: c.heading, key: c.relation.primaryFields.length, rows: c.rows }
				])
			)
		),
		laws.patterns
	)
	const nestings = new Map<string, Nesting>()
	/** The nesting of an insert into `relation`, built once. */
	const nestingFor = (relation: RelationInfo): Nesting => {
		const known = nestings.get(relation.name)
		if (known !== undefined) {
			return known
		}
		const built = nestingOf(relation, laws.theory.fill, codes, evaluate)
		nestings.set(relation.name, built)
		return built
	}
	/** The sequence `name` is a member of, a tree's aside: its members are written only under their owner. */
	const sequenceOf = (name: string) =>
		families.find((f) => f.member.name === name && isSequence(f) && !isTreeOf(f, name))
	/** The relations an insert into `name` writes rows of: its own, and every sequence's members its nesting reaches. */
	const insertedBy = (name: string): ReadonlySet<string> => {
		const written = new Set<string>([name])
		for (const owner of written) {
			for (const f of families) {
				if (f.owner.name === owner && isSequence(f)) {
					written.add(f.member.name)
				}
			}
		}
		return written
	}
	/** Whether `name` is a member of a family: its rows' drawn values are the family planner's (write/family/edit.ts). */
	const managed = (name: string): boolean => families.some((f) => f.member.name === name)
	/**
	 * The relations whose rows an insert into `name` writes through its nesting that are counted families' members, its
	 * own among them: each one's counted families complete its rows after the walk, from what the read flight finds
	 * stored, as they do a member's own insert (write/family/nesting.ts NestedLayout).
	 */
	const countedReached = (relation: RelationInfo): ReadonlyArray<string> =>
		[...nestingFor(relation).layouts].flatMap(([name, laid]) =>
			laid.pending.size > 0 ? [name] : []
		)
	/** Whether an insert into `name` nests families: it owns a sequence, ordered or a tree, or is a tree's relation.
	 * A counted family's members are rows of their own, inserted directly by their group key, so an
	 * owner of counted families alone is inserted on the plain path, its counts at 0 and its ends at their starts. */
	const nests = (name: string): boolean =>
		families.some((f) => f.owner.name === name && isSequence(f))
	/** An insert into `name` writes rows of every sequence member its nesting reaches, which a role holds nothing of
	 * unless its write list names it (physical/ddl/roles.ts grants a member's writer a hold on its owner, never an owner's
	 * writer one on its members): each is OutsideRole where the role's write list leaves it out. `name` itself is the
	 * target targetOf admitted, by its own name or through a query entry the write list names in its place. */
	const refuseNestedOutsideRole = (name: string, loc: SourceLoc): void => {
		const world = checked.world
		if (world.kind === "reality") {
			return
		}
		for (const reached of insertedBy(name)) {
			if (reached !== name && !world.writes.has(reached)) {
				throw new Refusal(
					CompileError.make({
						_tag: "OutsideRole",
						at: loc,
						role: world.role.name,
						access: { kind: "write", relation: reached }
					})
				)
			}
		}
	}
	/**
	 * An insert or a put of `relation` from a query, `member`, refused (QueriedOwnerAppend) where its stratum, `members`,
	 * writes a member of one of the counted families it owns, unless every fact it writes carries a stored owner's key
	 * (existingKeysProof). An owner inserted in the stratum that appends to its family holds its final count and ends in
	 * its own row, since PostgreSQL checks a row's CHECKs as it inserts the row, and grizzle draws them on the host from
	 * the facts the ChangeSet states; a query's facts are the statement's alone, so the owner would be inserted at its
	 * starts, which a CHECK over an end refuses. A write of stored owners only inserts none, and compiles.
	 */
	const refuseQueriedOwnerAppend = (
		member: MemberDesc,
		relation: RelationInfo,
		query: LogicalQuery,
		members: ReadonlyArray<MemberDesc>
	): void => {
		const op = member.op
		if (op === "delete") {
			return
		}
		const appended = families.find(
			(f) =>
				f.owner.name === relation.name &&
				!isSequence(f) &&
				members.some((m) => m.relation === f.member.name && m.op !== "delete")
		)
		if (appended === undefined || existingKeysProof(query.dag.roots[0], relation)) {
			return
		}
		throw new Refusal(
			CompileError.make({
				_tag: "QueriedOwnerAppend",
				at: member.loc,
				op,
				owner: relation.name,
				family: { owner: appended.id.owner, count: appended.id.count },
				member: appended.member.name
			})
		)
	}
	/** A relation written whole, its classes its own serial fields'. */
	const wholeTarget = (name: string, loc: SourceLoc): CheckedTarget => {
		const relation = writtenOf(name, loc)
		return {
			relation,
			entry: { kind: "whole" },
			classes: classesOf(
				relation,
				relation.heading.flatMap((f) =>
					isSerialField(f) ? [{ carried: f.name, field: f.name }] : []
				)
			)
		}
	}
	/** What a member's relation name writes (see `compileChangeSet`), and its classes, decided once. */
	const targetOf = (name: string, loc: SourceLoc): CheckedTarget => {
		const world = checked.world
		if (world.kind === "reality") {
			return wholeTarget(name, loc)
		}
		const role = world.role
		const write = world.writes.get(name)
		if (write === undefined) {
			throw new Refusal(
				CompileError.make({
					_tag: "OutsideRole",
					at: loc,
					role: role.name,
					access: { kind: "write", relation: name }
				})
			)
		}
		if (write.kind === "whole") {
			return wholeTarget(name, loc)
		}
		const entry = write.writable
		const relation = writtenOf(entry.target.name, loc)
		const writeWorld = options.world
		if (writeWorld.kind !== "role") {
			throw new Refusal(
				CompileError.make(
					prose(
						"MalformedDescription",
						loc,
						`a write into the query entry ${entry.entry} of the role ${role.name} compiled in that role's world`
					)
				)
			)
		}
		const member = entryRelation(entry)
		return {
			relation,
			entry: {
				kind: "entry",
				entry,
				names: writeWorld.names,
				member,
				fillable: entryFillable(entry, options.claims)
			},
			classes: classesOf(member, entryDraws(entry))
		}
	}
	const strataMembers = desc.strata.map((stratum) =>
		stratum.members.map((member): CheckedMember => {
			const loc = member.loc
			const target = targetOf(member.relation, loc)
			const { relation, entry } = target
			if (member.op === "insert") {
				refuseNestedOutsideRole(relation.name, loc)
			}
			const sequence = sequenceOf(relation.name)
			if (sequence !== undefined && member.op === "insert") {
				refuse(
					"UnsupportedOperation",
					loc,
					`an insert into ${relation.name}, a member of the sequence ${sequence.id.owner}.${sequence.id.count}: a sequence's member is written under its owner: nest it in order at the owner's count field`
				)
			}
			const tree = families.find((f) => isTreeOf(f, relation.name))
			if (tree !== undefined && member.op !== "insert") {
				refuse(
					"UnsupportedOperation",
					loc,
					`a ${member.op} of ${relation.name}, a node of the tree ${tree.id.owner}.${tree.id.count}: a tree is rewritten whole, which grizzle plans only by inserting its root with the whole tree nested`
				)
			}
			refuseUnstatedKey(member, relation)
			const fixed = families.find(
				(f) =>
					f.member.name === relation.name &&
					!isTreeOf(f, relation.name) &&
					!writtenOf(f.owner.name, loc).mutable
			)
			if (fixed !== undefined && member.op === "delete") {
				refuse(
					"UnsupportedOperation",
					loc,
					fixedSentence(`a delete of ${relation.name}`, fixed, undefined)
				)
			}
			/** An insert appends to its owners' families, which only an owner the same stratum inserts may take when the
			 * owner is immutable, itself or nested in another's insert; with no insert of the owner in the stratum, every
			 * append is to a stored owner. */
			const appendsToStored =
				fixed !== undefined &&
				member.op === "insert" &&
				!stratum.members.some(
					(m) => m.op === "insert" && insertedBy(m.relation).has(fixed.owner.name)
				)
			if (fixed !== undefined && appendsToStored) {
				refuse(
					"UnsupportedOperation",
					loc,
					fixedSentence(
						`an insert into ${relation.name}`,
						fixed,
						"appending to an owner this stratum does not insert"
					)
				)
			}
			/** A nested insert appends each counted member it writes to that member's counted families, as a member's own
			 * insert does, so an immutable owner of one of them takes it only where the stratum inserts that owner. */
			const nestedFixed =
				member.op === "insert" && nests(relation.name)
					? countedReached(relation).flatMap((name) =>
							families.filter(
								(f) =>
									f.member.name === name &&
									name !== relation.name &&
									!isSequence(f) &&
									!writtenOf(f.owner.name, loc).mutable &&
									!stratum.members.some(
										(m) => m.op === "insert" && insertedBy(m.relation).has(f.owner.name)
									)
							)
						)[0]
					: undefined
			if (nestedFixed !== undefined) {
				refuse(
					"UnsupportedOperation",
					loc,
					fixedSentence(
						`an insert into ${relation.name}, which nests ${nestedFixed.member.name}`,
						nestedFixed,
						"appending to an owner this stratum does not insert"
					)
				)
			}
			const owned = families.find((f) => f.owner.name === relation.name)
			if (owned !== undefined && member.op === "put" && !writtenOf(relation.name, loc).mutable) {
				refuse(
					"UnsupportedOperation",
					loc,
					`a put of ${relation.name}, the immutable owner of the family ${owned.id.owner}.${owned.id.count}: an owner's put updates the fields its facts carry in place and leaves its families as they are, which an immutable relation refuses; declare mutable(${relation.name}) to put it`
				)
			}
			const edited = managed(relation.name) && tree === undefined
			if (edited && (entry.kind !== "whole" || member.member.kind === "query")) {
				refuse(
					"UnsupportedOperation",
					loc,
					`a ${member.op} of ${relation.name}, a member of a family, ${entry.kind !== "whole" ? "through a query entry" : "by a query"}: grizzle draws its family's values from its rows on the host, so write ${relation.name} whole from an array or a Stream`
				)
			}
			if (edited && member.op !== "insert" && nests(relation.name)) {
				refuse(
					"UnsupportedOperation",
					loc,
					`a ${member.op} of ${relation.name}, both a family's member and a sequence's owner: its sequence's members are nested under its rows, which a member's edit does not reach, so write ${relation.name} by inserting its owner with its rows nested`
				)
			}
			const nested = member.op === "insert" && nests(relation.name)
			if (nested && (entry.kind !== "whole" || member.member.kind === "query")) {
				refuse(
					"UnsupportedOperation",
					loc,
					`an insert into ${relation.name}, which owns a sequence, ${entry.kind !== "whole" ? "through a query entry" : "by a query"}: a sequence's members are written nested in order under their owner, so insert ${relation.name} whole from an array or a Stream`
				)
			}
			const written: MemberRelation = entry.kind === "entry" ? entry.member : relation
			const source = member.member
			if (source.kind !== "query") {
				return { op: member.op, target, loc, source: { kind: "enumerated", member: source } }
			}
			const query = unwrap(
				checkMember(
					checked,
					{ op: member.op, relation: written, query: source.query, loc },
					{ label: `${member.op} ${member.relation}` }
				)
			)
			refuseQueriedOwnerAppend(member, relation, query, stratum.members)
			for (const p of query.params) {
				merge(params, p, loc)
			}
			return {
				op: member.op,
				target,
				loc,
				source: { kind: "described", query, root: merger.add(query) }
			}
		})
	)
	/** A write into an entry refuses a stratum that also writes a relation its filter reads. */
	const refuseMovedFilter = (m: CheckedMember, writtenNames: ReadonlySet<string>): void => {
		if (m.target.entry.kind !== "entry") {
			return
		}
		const entry = m.target.entry.entry
		const filter = entry.filter
		if (filter.kind === "none") {
			return
		}
		const moved = [...queryUses(filter.query).relations]
			.toSorted(Order.compareStrings)
			.find((r) => r !== entry.target.name && writtenNames.has(r))
		if (moved !== undefined) {
			refuse(
				"UnsupportedOperation",
				m.loc,
				`a write into ${entry.entry} in a stratum that also writes ${moved}, which ${entry.entry}'s filter reads, so which facts ${entry.entry} holds would depend on the order the stratum's statements run in; write ${moved} in another stratum (ChangeSet.sequence), whose state ${entry.entry} is then judged against or left`
			)
		}
	}
	/** What a refill reads and rewrites of the base, which a role holds only whole (write/frontend/refill.ts). */
	const holds: RefillHolds = ((): RefillHolds => {
		const world = checked.world
		if (world.kind === "reality") {
			return { kind: "reality" }
		}
		return {
			kind: "role",
			role: world.role.name,
			base: world.base.owned.name,
			reads: (relation) =>
				checked.entries.some((e) => e.kind === "whole" && e.relation.name === relation),
			writes: (relation) => world.writes.get(relation)?.kind === "whole"
		}
	})()
	/** Each stratum's refills, by its position among the ChangeSet's strata. */
	const refills = new Map<number, StratumRefill>()
	for (const [s, members] of strataMembers.entries()) {
		const writtenNames = new Set(members.map((m) => m.target.relation.name))
		const writes: Array<StratumWrite> = []
		for (const m of members) {
			refuseMovedFilter(m, writtenNames)
			const { relation, entry, classes } = m.target
			/** The counted members a nested insert writes: each edits only its counted families, since its sequences are the
			 * walk's, under their fresh owners. */
			const nestedCounted =
				m.op === "insert" && nests(relation.name)
					? countedReached(relation).flatMap((name) =>
							name === relation.name ? [] : [writtenOf(name, m.loc)]
						)
					: []
			/** A put's rows: its slot's facts, or a query's rows, through a query member or a query entry's fill. */
			const putRows: StratumWrite["rows"] =
				m.op !== "put"
					? { kind: "none" }
					: entry.kind === "entry" ||
						  members.some(
								(o) =>
									o.target.relation.name === relation.name &&
									o.op === "put" &&
									o.source.kind === "described"
						  )
						? { kind: "query" }
						: {
								kind: "slot",
								slot: writeSlotId(s, { op: "put" }, classes, relation.name)
							}
			for (const w of [
				{ relation, op: m.op, edited: families, rows: putRows },
				...nestedCounted.map((counted) => ({
					relation: counted,
					op: m.op,
					edited: families.filter((f) => !isSequence(f)),
					rows: { kind: "none" } as const
				}))
			]) {
				writes.push({
					change: { kind: "write", relation: w.relation, op: w.op, edited: w.edited },
					loc: m.loc,
					rows: w.rows
				})
			}
		}
		const edited = new Set(
			writes.flatMap((w) =>
				families.some(
					(f) => f.member.name === w.change.relation.name && !isTreeOf(f, f.member.name)
				)
					? [w.change.relation.name]
					: []
			)
		)
		const refill = unwrap(stratumRefill(families, writes, edited, holds, immediateOwner))
		if (refill !== undefined) {
			refills.set(s, refill)
		}
	}
	const readBacks = desc.reads.map((r) => {
		const query = unwrap(checkReadBack(checked, r, { label: `read ${r.name}` }))
		for (const p of query.params) {
			merge(params, p, childLoc(at, "reads", r.name))
		}
		const root = merger.add(query)
		return { name: r.name, query: r.query, root, deltas: deltaSources(root) }
	})

	/** A query entry's fill over `input`, the facts its sources carry, checked against the base as a member of its target
	 * and merged into the DAG: its root. The fill omits exactly the serial fields of the target an addition through the
	 * entry leaves out, its classes' drawn fields (entry.ts entryDraws); every other serial field, one the entry's
	 * filter reads or its fill fixes, is one every fact carries. */
	const mergeFill = (
		entry: CheckedEntry,
		relation: WrittenRelation,
		classes: InsertClasses<Heading>,
		op: MemberDesc["op"],
		input: Heading,
		loc: SourceLoc
	): RelNode => {
		const drawn: ReadonlyArray<string> = classes.kind === "classed" ? classes.drawn.drawn : []
		const target: MemberRelation = {
			name: relation.name,
			heading: relation.heading.map((f) => ({
				name: f.name,
				type: f.type,
				writing:
					f.writing.kind !== "serial" || drawn.includes(f.name) ? f.writing : { kind: "caller" }
			}))
		}
		return merger.add(
			unwrap(
				checkFill(
					base,
					{ op, relation: target, query: fillQuery(entry, input, loc), loc },
					{ label: `${op} ${entry.entry}` }
				)
			)
		)
	}

	/** 2. Group each stratum's members into actions. */
	const slots: Array<SlotGroup> = []
	const occupied = strataAt(
		strataMembers.flatMap((members, s) => (members.length > 0 ? [{ s, members }] : []))
	)
	/** Every put source of the relation in the stratum is one action (see `compileChangeSet`).
	 *
	 * An exact delete of an absent fact is a no-op, so every delete member is its own action.
	 *
	 * Every generated addition of the relation in the stratum is one action over the union of its
	 * sources, so the one SELECT DISTINCT over its head makes equal generated additions one new fact
	 * whichever sources requested them. Every other insert member is its own action: the insert
	 * protocol makes a second equal fact an exact repeat. */
	/** Each stratum's nested writes, by its position among the occupied strata, the stratum its statements run in. */
	const nestedWrites: Array<NestedWrite> = []
	/** Each stratum's slots of the relations whose rows a family planner writes, by operation, and the counted members
	 * its nested writes reach, whose rows the planner completes (`countedReached`). */
	const edits: Array<{
		readonly stratum: StratumAt
		readonly relation: string
		readonly write:
			| { readonly op: "insert" | "put" | "delete"; readonly slot: ParamId }
			| { readonly op: "nested" }
	}> = []
	const draftsByStratum = occupied.map(([stratum, { s, members }]) => {
		const drafts: Array<Draft> = []
		const outside: Array<OutsideDraft> = []
		const byRelation = [...groupBy(members, (m) => m.target.relation.name)].toSorted(
			Order.mapInput(Order.compareStrings, ([name]: readonly [string, unknown]) => name)
		)
		for (const [, list] of byRelation) {
			/** One target per base relation per role (targetOf), its writable entry and its classes, so every member of the
			 * relation writes it alike and every operation's slot is headed by the relation's own classes. */
			const { relation, entry: target, classes } = list[0].target
			const written: MemberRelation = target.kind === "entry" ? target.member : relation
			const groupInputs: Array<EnumeratedInput> = []
			const ops = (["delete", "put", "insert"] as const).flatMap((op) => {
				const ofOp = list.filter((m) => m.op === op)
				return isNonEmpty(ofOp) ? [{ op, ofOp }] : []
			})
			for (const { op, ofOp } of ops) {
				const firstOfOp = headNonEmpty(ofOp)
				const enumerated = ofOp.flatMap((m) =>
					m.source.kind === "enumerated" ? [m.source.member] : []
				)
				const queries = ofOp.flatMap((m) => (m.source.kind === "described" ? [m.source] : []))
				const loc = firstOfOp.loc
				const transport = enumerated.some((m) => m.kind === "stream") ? "stream" : "enumerated"
				/** The member slot of one class of the operation's enumerated members, its facts carrying `carried`, and
				 * the normalizer that admits a member's facts against it. */
				const classSlot = (
					act: ActionOp,
					carried: Heading,
					admitted: Heading
				): {
					readonly slot: MemberSlot
					readonly normalizer: (member: string) => RelationNormalizer
				} => {
					const spec = (slot: RelationSlot, over: Heading): RelationSpec => ({
						relation: written.name,
						columns: positionalColumns(over),
						slot,
						codes
					})
					const id = writeSlotId(s, act, classes, written.name)
					return {
						slot: Object.freeze({
							slot: id,
							transport,
							heading: carried,
							input: relationInput(id, carried, relation)
						}),
						normalizer: (member) =>
							relationNormalizer(spec({ kind: "slot", name: member }, admitted))
					}
				}
				/** The operation's enumerated input of one slot, read as `act`, when it has enumerated members. */
				const singleInput = (
					act: SingleAct,
					carried: Heading,
					admitted: Heading
				): MemberSlot | undefined => {
					if (!isNonEmpty(enumerated)) {
						return undefined
					}
					const { slot, normalizer } = classSlot(act, carried, admitted)
					const starts = slot.input.family.map((c) => {
						const field = defined(
							relation.fields.find((f) => f.name === c.name),
							`the field ${relation.name}.${c.name} a slot carries`
						)
						const value =
							field.writing.kind === "accumulated"
								? literalHost(carrierSpecOf(field.type, codes), field.writing.start)
								: 0n
						return { name: c.name, value }
					})
					groupInputs.push(
						Object.freeze({
							kind: "single",
							act,
							slot,
							members: Object.freeze(
								mapNonEmpty(enumerated, (m) =>
									Object.freeze({ name: m.slot, normalize: normalizer(m.slot) })
								)
							),
							starts: Object.freeze(starts)
						})
					)
					return slot
				}
				/** The insertion's enumerated input into a classed target, one slot per class, when it has enumerated
				 * members. */
				const classedInput = (
					classed: Extract<InsertClasses<Heading>, { readonly kind: "classed" }>
				): { readonly complete: MemberSlot; readonly generated: MemberSlot } | undefined => {
					if (!isNonEmpty(enumerated)) {
						return undefined
					}
					const complete = classSlot(
						{ op: "insert", serial: completeClass },
						classed.complete,
						classed.complete
					)
					const generated = classSlot(
						{ op: "insert", serial: classed.drawn },
						classed.generated,
						classed.generated
					)
					groupInputs.push(
						Object.freeze({
							kind: "classed",
							serial: classed.serial,
							complete: complete.slot,
							generated: generated.slot,
							members: Object.freeze(
								mapNonEmpty(enumerated, (m) =>
									Object.freeze({
										name: m.slot,
										normalize: Object.freeze({
											complete: complete.normalizer(m.slot),
											generated: generated.normalizer(m.slot)
										})
									})
								)
							)
						})
					)
					return { complete: complete.slot, generated: generated.slot }
				}
				/** The action `act` over its slot and the described members' `roots`, their facts carrying `carried`, when
				 * it reads any: written whole, through its entry's fill, or refused outright when the fill can fill
				 * nothing, where a deletion is a no-op. */
				const draft = (
					act: ActionOp,
					carried: Heading,
					slot: MemberSlot | undefined,
					roots: ReadonlyArray<RelNode>
				): void => {
					const reads: DraftReads | undefined = isNonEmpty(roots)
						? { kind: "described", slot, roots }
						: slot === undefined
							? undefined
							: { kind: "slot", slot }
					if (reads === undefined) {
						return
					}
					if (target.kind === "whole") {
						drafts.push({ act, relation, carried, reads, entry: { kind: "whole" } })
						return
					}
					if (!target.fillable) {
						if (act.op !== "delete") {
							outside.push({ entry: target.entry.entry, carried, reads })
						}
						return
					}
					const fill = mergeFill(target.entry, relation, classes, act.op, carried, loc)
					drafts.push({
						act,
						relation,
						carried,
						reads,
						entry: { kind: "entry", entry: target.entry, names: target.names, fill }
					})
				}
				/** An owner of counted families' counts and ends, which its enumerated slot carries at their starts when the
				 * slot is the owner's own rows: a query entry's slot fills its fill, a member of the owner whose head holds only
				 * the fields its facts state (check/member.ts memberHeading), so the owner's insert writes them at their starts
				 * and the stratum's appends to it take its count statement. */
				const owned =
					target.kind === "whole" && families.some((f) => f.owner.name === relation.name)
						? written.heading
								.filter((c) => c.writing.kind === "drawn" || c.writing.kind === "accumulated")
								.map(carriedColumn)
						: []
				if (
					managed(relation.name) &&
					!families.some((f) => isTreeOf(f, relation.name)) &&
					!(op === "insert" && nests(relation.name))
				) {
					/** A member relation that owns counted families carries their counts and ends in its insert and put slots,
					 * as an owner's own slot does: the rows its additions append are inserted with them, as the stratum's
					 * appends to them draw them (write/program/bind.ts freshOwners). */
					const heading = op === "delete" ? classes.complete : [...classes.complete, ...owned]
					const act: SingleAct =
						op === "insert" ? { op, serial: completeClass } : op === "put" ? { op } : { op }
					const slot = singleInput(act, heading, classes.complete)
					if (slot !== undefined) {
						edits.push(
							Object.freeze({
								stratum,
								relation: relation.name,
								write: { op, slot: slot.slot }
							})
						)
					}
					continue
				}
				switch (op) {
					case "put": {
						const act = { op }
						/** An enumerated put of an owner carries its counts and ends in its slot, at their starts, as its
						 * insertion does: the stratum's appends to an owner the put inserts replace them before its insert
						 * half is sent (write/program/bind.ts), and a stored owner's are no field its UPDATE sets. A put
						 * that also reads queries carries none, since their rows hold only written fields. */
						const carried = isNonEmpty(queries) ? classes.complete : [...classes.complete, ...owned]
						draft(
							act,
							carried,
							singleInput(act, carried, classes.complete),
							queries.map((q) => q.root)
						)
						break
					}
					case "delete": {
						const act = { op }
						/** One relation, one fact heading (rule 0): a deletion's facts carry what an addition's do, its
						 * written fields, so a fact inserted and deleted is one fact with one identity, which nets. A
						 * generated field is a function of the written ones, so it decides no match. */
						const facts = classes.complete
						draft(act, facts, singleInput(act, facts, facts), [])
						for (const q of queries) {
							draft(act, facts, undefined, [q.root])
						}
						break
					}
					case "insert": {
						const complete: SingleAct = { op, serial: completeClass }
						if (nests(relation.name)) {
							const nesting = nestingFor(relation)
							if (isNonEmpty(enumerated)) {
								/** A nested insert's facts are its rows as its nesting writes them (Nesting.top), each count and end
								 * drawn from its members: never a put's, which state their caller's fields, so the host refuses the
								 * two at one key (normalize/ step 3). */
								const { slot, normalizer } = classSlot(complete, nesting.top, nesting.top)
								groupInputs.push(
									Object.freeze({
										kind: "nested",
										act: complete,
										slot,
										nesting,
										reached: new Map(
											nesting.reached.map((r) => {
												const member = writtenOf(r.family.member.name, loc)
												return [member.name, { name: member.name, host: member.host }] as const
											})
										),
										members: Object.freeze(
											mapNonEmpty(enumerated, (m) =>
												Object.freeze({ name: m.slot, normalize: normalizer(m.slot) })
											)
										)
									})
								)
								nestedWrites.push(Object.freeze({ stratum, nesting, slot }))
								for (const name of countedReached(relation)) {
									edits.push(
										Object.freeze({ stratum, relation: name, write: { op: "nested" } as const })
									)
								}
								if (nesting.root.kind === "plain") {
									draft(complete, nesting.top, slot, [])
								}
							}
							break
						}
						const described = queries.map((q) => ({
							root: q.root,
							serial: describedClass(classes, q.query.dag.roots[0].heading)
						}))
						switch (classes.kind) {
							case "unclassed": {
								/** An owner of counted families carries its counts and ends in its slot, at their starts,
								 * which the stratum's appends to it replace before its insert is sent. */
								const carried = [...classes.complete, ...owned]
								draft(complete, carried, singleInput(complete, carried, classes.complete), [])
								break
							}
							case "classed": {
								const classSlots = classedInput(classes)
								draft(complete, classes.complete, classSlots?.complete, [])
								draft(
									{ op, serial: classes.drawn },
									classes.generated,
									classSlots?.generated,
									described.flatMap((d) => (d.serial.kind === "generated" ? [d.root] : []))
								)
								break
							}
						}
						for (const d of described) {
							if (d.serial.kind === "complete") {
								draft(complete, classes.complete, undefined, [d.root])
							}
						}
						break
					}
				}
			}
			if (isNonEmpty(groupInputs)) {
				slots.push(
					Object.freeze({
						stratum,
						relation,
						inputs: Object.freeze(groupInputs),
						facts:
							target.kind === "entry"
								? entryFacts(target.entry, relation.host)
								: { name: relation.name, host: relation.host }
					})
				)
			}
		}
		return { stratum, drafts, outside }
	})

	const glue = new GlueBuilder(merger.dag)

	/** The sources of a draft as one node of the heading `heading` its reader takes: the slot's InputSet, the described
	 * members' roots, or their Union, each conformed to `heading`. */
	const sourceOf = (
		reads: Extract<DraftReads, { readonly kind: "described" }>,
		relation: string,
		heading: Heading
	): RelNode => {
		const [first, ...more] = reads.roots
		if (reads.slot === undefined && more.length === 0) {
			return glue.conform(first, heading)
		}
		return glue.union(
			reads.slot === undefined
				? reads.roots
				: [glue.inputSet(reads.slot.slot, relation, heading), ...reads.roots],
			heading
		)
	}

	/** 3. Each draft's source. */
	interface Built {
		readonly action: ActionCore
		readonly info: ActionInfo
	}
	const builtByStratum = draftsByStratum.map(({ stratum, drafts, outside }) => ({
		stratum,
		outside,
		built: drafts.map(({ act, relation, carried, reads, entry }): Built => {
			/** The source, what it reads and the heading it delivers: the slot alone; one described member's query alone;
			 * or the Union of the slot's InputSet and of every described member's query. A query entry's sources, in its
			 * facts, fill its fill's relation parameter, and the fill is the source. */
			const read = ((): {
				readonly source: ActionSource
				readonly reads: SourceReads
				readonly heading: Heading
			} => {
				if (entry.kind === "entry") {
					const name = entry.entry.entry
					const node = substitute(entry.fill, entryRowsParam, (input) =>
						reads.kind === "slot"
							? glue.inputSet(reads.slot.slot, name, input)
							: sourceOf(reads, name, input)
					)
					return {
						source: { kind: "described", node },
						reads: { kind: "described", node },
						heading: node.heading
					}
				}
				switch (reads.kind) {
					case "slot":
						return {
							source: { kind: reads.slot.transport, slot: reads.slot.slot },
							reads,
							heading: carried
						}
					case "described": {
						const [first, ...more] = reads.roots
						const node =
							reads.slot === undefined && more.length === 0
								? first
								: sourceOf(reads, relation.name, carried)
						return {
							source: { kind: "described", node },
							reads: { kind: "described", node },
							heading: node.heading
						}
					}
				}
			})()
			const info: ActionInfo = Object.freeze({
				relation,
				reads: read.reads,
				heading: read.heading,
				entry:
					entry.kind === "entry"
						? Object.freeze({ kind: "entry", entry: entry.entry, names: entry.names })
						: whole
			})
			return { action: { ...act, relation: relation.name, source: read.source }, info }
		})
	}))
	/** Each refused addition's sources, in the entry's facts, built after every action's. */
	const placedByStratum = builtByStratum.map(({ stratum, built, outside }) => ({
		stratum,
		built,
		outside: Object.freeze(
			outside.map((d): OutsideWrite => {
				const reads: SourceReads =
					d.reads.kind === "slot"
						? d.reads
						: { kind: "described", node: sourceOf(d.reads, d.entry, d.carried) }
				return Object.freeze({ entry: d.entry, reads })
			})
		)
	}))

	/** The DAG, rooted at every described source and read-back. */
	const sourceRoots = [
		...placedByStratum.flatMap(({ built }) =>
			built.flatMap(({ action }) =>
				action.source.kind === "described" ? [action.source.node] : []
			)
		),
		...placedByStratum.flatMap(({ outside }) =>
			outside.flatMap((w) => (w.reads.kind === "described" ? [w.reads.node] : []))
		)
	]
	/** A ChangeSet of enumerated members alone and no read-back has no query: its DAG has no root. */
	const structural = glue.build([...new Set([...sourceRoots, ...readBacks.map((r) => r.root)])])
	const references: ReadonlyArray<ImmediateReference> = laws.natives.flatMap((n) =>
		n.object.kind === "ForeignKey" && !n.object.deferrable
			? [
					{
						from: n.object.relation.name,
						to: n.object.target.name,
						cascade: n.object.onUpdate === "cascade",
						fromColumns: n.object.columns.map(columnKey),
						toColumns: n.object.targetColumns.map(columnKey)
					}
				]
			: []
	)
	/**
	 * The columns of `relation` PostgreSQL generates, by key, each with the columns it reads: its generated fields, and
	 * its law columns no family draws, a selected side's term or a pred term, which read its fields and its drawn law
	 * columns by name.
	 */
	const generatedOf = (relation: string): ReadonlyArray<GeneratedColumn> => {
		const fields = writtenOf(relation, at).fields
		const lawColumns = laws.natives.flatMap((n) =>
			n.object.kind === "LawColumn" && n.object.relation.name === relation ? [n.object] : []
		)
		/** A column a generated expression reads by name: a field of the row, or one of its law columns. */
		const keyOf = (name: string): string => {
			const field = fields.find((f) => f.name === name)
			if (field !== undefined) {
				return columnKey({ kind: "field", field })
			}
			const law = lawColumns.find((c) => c.column === name)
			if (law === undefined) {
				throw defect(`the column ${name} a generated column of ${relation} reads`)
			}
			return columnKey({ kind: "law", column: law.column })
		}
		return [
			...fields.flatMap((f) =>
				f.writing.kind === "generated"
					? [
							{
								key: columnKey({ kind: "field", field: f }),
								reads: readsOf(f.writing.expr).map(keyOf)
							}
						]
					: []
			),
			...lawColumns.flatMap((c) =>
				c.value.kind === "generated"
					? [
							{
								key: columnKey({ kind: "law", column: c.column }),
								reads: [...c.value.guard, c.value.term].flatMap(readsOf).map(keyOf)
							}
						]
					: []
			)
		]
	}
	/** Each relation's depth among the families, which orders a stratum's family statements among themselves. */
	const depthOf = relationDepths(families)
	/** A stratum's refills, by its position among the occupied strata. */
	const refillOf = (stratum: StratumAt): StratumRefill | undefined =>
		refills.get(defined(occupied[stratum], "an occupied stratum")[1].s)
	/**
	 * A stratum's family statements, in the order the family planner runs them among themselves (write/family/
	 * compose.ts): every edited relation's deletes, deepest relation first; then each relation's refill and its updates
	 * in place, deepest relation first, so a refill of a member runs before the change of its owner that would cascade
	 * into it, and after its own deletes; then the counts of every family of an edited relation and of every family a
	 * refill recounts; then the inserts of every relation a family write writes, its nested writes' and its edits',
	 * shallowest first. The schedule places them among the stratum's actions. Each changes only what it writes: an update
	 * in place what the stratum's edits of its relation write in place (schedule.ts updateChanges), a refill every column
	 * but its relation's key and groups, and a count its owner's count and ends, each with the columns PostgreSQL
	 * generates from them.
	 */
	const familyNodesOf = (stratum: StratumAt): ReadonlyArray<FamilyNode> => {
		const edited = [...new Set(edits.filter((e) => e.stratum === stratum).map((e) => e.relation))]
		const refill = refillOf(stratum)
		const written = familyWritesOf(stratum, edited, refill)
		if (written !== undefined) {
			return written
		}
		const refilled = refill?.relations ?? []
		const inserted = [
			...new Set([
				...nestedWrites
					.filter((n) => n.stratum === stratum)
					.flatMap((n) => [...n.nesting.layouts.keys()]),
				...edited
			])
		]
		const deepest = (names: ReadonlyArray<string>) =>
			names.toSorted((a, b) => depthOf(b) - depthOf(a))
		const counted = [
			...edited.flatMap((relation) =>
				memberFamilies(relation, families).filter((f) => !isTreeOf(f, relation))
			),
			...(refill?.recounted ?? [])
		]
		return [
			...deepest(edited).map((relation): FamilyNode => ({
				kind: "rows",
				relation,
				statement: "delete"
			})),
			...deepest([...new Set([...edited, ...refilled])]).flatMap(
				(relation): ReadonlyArray<FamilyNode> => {
					const columns = rowLayout(writtenOf(relation, at), families).columns
					/** The columns an update in place of the relation sets. */
					const settable = columns.filter((c) => c.settable)
					const generated = generatedOf(relation)
					/** The columns its counted families draw on a member. */
					const drawn = new Set(
						memberFamilies(relation, families)
							.filter((f) => !isTreeOf(f, relation) && !isSequence(f))
							.flatMap(drawnBy)
					)
					return [
						...(refilled.includes(relation)
							? [
									{
										kind: "rows",
										relation,
										statement: "refill",
										changes: generating(
											columns.flatMap((c) => (c.settable || c.copy ? [c.key] : [])),
											generated
										)
									} as const
								]
							: []),
						...(edited.includes(relation) && isNonEmpty(settable)
							? [
									{
										kind: "rows",
										relation,
										statement: "update",
										changes: updateChanges({
											ops: edits.flatMap((e) =>
												e.stratum === stratum && e.relation === relation ? [e.write.op] : []
											),
											own: settable.flatMap((c) => (callerWritten(c) ? [c.key] : [])),
											placed: settable.flatMap((c) => (drawn.has(c.key) ? [c.key] : [])),
											refreshed: refilled.includes(relation)
												? settable.flatMap((c) => (callerWritten(c) ? [] : [c.key]))
												: [],
											generated
										})
									} as const
								]
							: [])
					]
				}
			),
			...[...new Map(counted.map((f) => [familyKey(f.id), f] as const)).values()].map(
				(f): FamilyNode => ({
					kind: "owners",
					family: f.id,
					relation: f.owner.name,
					member: f.member.name,
					changes: generating(
						[
							columnKey({ kind: "field", field: f.count }),
							...endColumns(f).map((field) => columnKey({ kind: "field", field }))
						],
						generatedOf(f.owner.name)
					)
				})
			),
			...deepest(inserted)
				.toReversed()
				.map((relation): FamilyNode => ({ kind: "rows", relation, statement: "insert" }))
		]
	}

	/**
	 * A stratum's family work as one removals statement and one additions statement of each member relation
	 * (write/family/removals.ts, write/family/additions.ts), where its refills are puts' of plain relations
	 * (frontend/refill.ts plainRefills): a member's removals where an edit puts or deletes it or a refill draws a family
	 * of it again, its additions where one inserts or puts it or a nested write fills its rows, each with each owner of
	 * its families, its count and ends changed, and, for a member it removes from and appends nothing to, the recount of
	 * the owners the stratum puts; none for any other stratum, whose family statements the family planner plans.
	 */
	const familyWritesOf = (
		stratum: StratumAt,
		edited: ReadonlyArray<string>,
		refill: StratumRefill | undefined
	): ReadonlyArray<FamilyNode> | undefined => {
		const own = edits.filter((e) => e.stratum === stratum)
		/** The relations whose rows the stratum's nested writes fill, which its additions insert (write/family/nesting.ts
		 * sentLayout). */
		const nested = nestedWrites.flatMap((n) =>
			n.stratum === stratum ? [...n.nesting.layouts.keys()] : []
		)
		const by = (ops: ReadonlyArray<"insert" | "put" | "delete">) => [
			...new Set(own.flatMap((e) => (ops.some((op) => op === e.write.op) ? [e.relation] : [])))
		]
		/** The stratum's refills its family statements draw, by member relation; none where the family planner draws them. */
		const refilled =
			refill === undefined
				? new Map<string, ReadonlyArray<PlainRefill>>()
				: plainRefills(refill, managed, new Set(by(["put", "delete"])))
		if (
			refilled === undefined ||
			(edited.length === 0 && nested.length === 0 && refilled.size === 0)
		) {
			return undefined
		}
		const removing = by(["put", "delete"])
		const slotted = by(["insert", "put"])
		const adding = [...new Set([...slotted, ...nested])]
		/** Each refilled member's starts: every way's a put's, which mixes with no other kind; or the edits of one
		 * relation the stratum puts or deletes, beside the appends to the member itself, whose additions recount the
		 * owners whose counts and ends its stored members copy, which their owner axes cascade; none otherwise, which the
		 * family planner refills on the host. */
		const startsOf = (member: string, memberRefills: ReadonlyArray<PlainRefill>) => {
			const all = memberRefills.flatMap((r) => r.ways.map((way) => way.root))
			const puts = all.flatMap((x) => (x.kind === "put" ? [x.relation] : []))
			if (isNonEmpty(puts)) {
				return puts.length === all.length
					? { kind: "put" as const, relations: [...new Set(puts)] }
					: undefined
			}
			const [edit, ...otherEdits] = [
				...new Set(all.flatMap((x) => (x.kind === "edit" ? [x.relation] : [])))
			]
			return isNonEmpty(otherEdits) ||
				(edit !== undefined && !removing.includes(edit)) ||
				(all.some((x) => x.kind === "recount") && !adding.includes(member))
				? undefined
				: { kind: "flight" as const, edit }
		}
		const starts = new Map(
			[...refilled].map(
				([member, refilledFamilies]) => [member, startsOf(member, refilledFamilies)] as const
			)
		)
		if ([...starts.values()].some((x) => x === undefined)) {
			return undefined
		}
		/** The members whose refills start at plain puts, each its own removals statement's, by the puts' relations. */
		const putRefilled = new Map(
			[...starts].flatMap(([member, x]) =>
				x?.kind === "put" ? [[member, x.relations] as const] : []
			)
		)
		/** The members an edit's refills rewrite in the edit's own removals statement (FamilyRemovals `riders`). */
		const ridersOf = (member: string): ReadonlyArray<string> =>
			[...starts].flatMap(([rider, x]) =>
				x?.kind === "flight" && x.edit === member ? [rider] : []
			)
		/** The owners of `drawn`, the families a family statement draws, each changed at its counts and ends. */
		const ownersOfFamilies = (drawn: ReadonlyArray<Family>) =>
			[...new Set(drawn.map((f) => f.owner.name))].map((relation) => ({
				relation,
				changes: generating(
					drawn.flatMap((f) =>
						f.owner.name === relation
							? [
									columnKey({ kind: "field", field: f.count }),
									...endColumns(f).map((field) => columnKey({ kind: "field", field }))
								]
							: []
					),
					generatedOf(relation)
				)
			}))
		/** The families a family statement draws its slots' rows of `members` by: every one but a member's own tree. */
		const slotFamilies = (members: ReadonlyArray<string>) =>
			members.flatMap((relation) =>
				memberFamilies(relation, families).filter((f) => !isTreeOf(f, relation))
			)
		const ownersOf = (members: ReadonlyArray<string>) => ownersOfFamilies(slotFamilies(members))
		const putting = by(["put"])
		const deleting = by(["delete"])
		/** What `member`'s removals statement does to its rows (schedule.ts RemovalEdit): the operations the stratum states
		 * of a member it puts or deletes, and else the refill its plain puts' cascades draw. */
		const removalEdits = (member: string): NonEmptyReadonlyArray<RemovalEdit> =>
			putting.includes(member)
				? deleting.includes(member)
					? ["put", "delete"]
					: ["put"]
				: deleting.includes(member)
					? ["delete"]
					: ["refill"]
		/** The members whose removals statements redraw their groups: an edit's, which puts or deletes them, and a
		 * refill's. */
		const redrawing = [...new Set([...removing, ...putRefilled.keys()])]
		/**
		 * The owners the stratum puts by a slot whose groups its removals leave to the additions to recount after the put
		 * (write/family/removals.ts): a mutable owner of a family of a removed member but a tree, whether or not the
		 * stratum appends to it.
		 */
		const put = ownersOf(redrawing).filter(
			(o) =>
				families.some(
					(f) =>
						f.owner.name === o.relation &&
						f.owner.mutable &&
						f.members.kind !== "tree" &&
						redrawing.includes(f.member.name)
				) &&
				slots.some(
					(g) =>
						g.stratum === stratum &&
						g.relation.name === o.relation &&
						g.inputs.some((i) => i.kind === "single" && i.act.op === "put")
				)
		)
		/** The owners the stratum puts of `member`'s families, which the member's additions recount after the put. */
		const putOf = (member: string) =>
			ownersOfFamilies(
				families.filter(
					(f) =>
						f.member.name === member &&
						f.owner.mutable &&
						f.members.kind !== "tree" &&
						put.some((o) => o.relation === f.owner.name)
				)
			)
		/** The owners `member`'s additions draw: every family's of its slots, a counted family's of its nested rows. */
		const drawnOwners = (member: string) =>
			ownersOfFamilies(
				memberFamilies(member, families).filter(
					(f) => !isTreeOf(f, member) && (slotted.includes(member) || !isSequence(f))
				)
			)
		/** The owners whose rows `member`'s additions copy a column of into their appended rows (an owner copy, fill.ts
		 * FillRule), which the statement reads as the stratum's earlier statements leave them. */
		const copiedOwners = (member: string) => [
			...new Set(
				memberFamilies(member, families).flatMap((f) =>
					!isTreeOf(f, member) &&
					(slotted.includes(member) || !isSequence(f)) &&
					defined(
						laws.theory.fill.layouts.get(layoutKey(member, { kind: "member", family: f })),
						`the fill layout of ${member} as a member of ${f.id.owner}.${f.id.count}`
					).columns.some(
						(c) => c.rule.kind === "ownerCopy" && familyKey(c.rule.family.id) === familyKey(f.id)
					)
						? [f.owner.name]
						: []
				)
			)
		]
		const recountedOnly = [
			...new Set(
				families.flatMap((f) => (redrawing.includes(f.member.name) ? [f.member.name] : []))
			)
		].filter((m) => !adding.includes(m))
		return [
			...redrawing.map((member) => ({
				kind: "removals" as const,
				member,
				edits: removalEdits(member),
				owners: ownersOf([member, ...ridersOf(member)]),
				refilledFrom: putRefilled.get(member) ?? [],
				riders: ridersOf(member)
			})),
			...adding.map((member) => {
				const drawn = drawnOwners(member)
				return {
					kind: "additions" as const,
					appends: "rows" as const,
					member,
					copies: copiedOwners(member),
					owners: [
						...drawn,
						...putOf(member).filter((o) => !drawn.some((d) => d.relation === o.relation))
					]
				}
			}),
			...recountedOnly.flatMap((member) => {
				const owners = putOf(member)
				return isNonEmpty(owners)
					? [
							{
								kind: "additions" as const,
								appends: "nothing" as const,
								member,
								owners
							}
						]
					: []
			})
		]
	}

	/** 4. Schedule, with the final sources: a stratum whose actions an immediate key orders in a cycle is refused,
	 * since no order of its statements keeps every key at every statement. */
	const strata = placedByStratum.map(({ stratum, built, outside }): WriteStratum => {
		const schedule = scheduleStratum(
			canonicalActionOrder(built.map((b) => ({ ...b, meeting: meetingOf(b.info.relation) }))),
			familyNodesOf(stratum),
			pairs,
			references,
			refillOf(stratum)?.order ?? { precedes: [], edges: [] }
		)
		if (schedule.kind === "cycle") {
			throw new Refusal(
				CompileError.make({
					_tag: "UnorderableStratum",
					at,
					cycle: mapNonEmpty(schedule.cycle, (w) =>
						w.kind === "action"
							? { relation: w.action.action.relation, op: w.action.action.op }
							: w.node.kind === "additions" || w.node.kind === "removals"
								? familyWriteAt(w.node)
								: {
										relation: w.node.relation,
										op:
											w.node.kind === "owners"
												? "count"
												: w.node.statement === "refill"
													? "update"
													: w.node.statement
									}
					)
				})
			)
		}
		return Object.freeze({
			actions: Object.freeze(
				schedule.actions.map(({ scheduled, dependsOn }): Action<ActionInfo> =>
					Object.freeze({ ...scheduled.action, dependsOn, info: scheduled.info })
				)
			),
			outside,
			family: Object.freeze(schedule.family)
		})
	})

	/** 5. Evidence: the transaction context. */
	const analyzed = (structure: ValidDag): LogicalAnalysis =>
		unwrap(
			analyzeLogical(structure, {
				context: "transaction",
				containments: immediateEvidence(laws.theory.evidence).containments,
				/** A derived or world relation a member or read-back matches is keyed by its definition's keys. */
				keyedViews: true
			})
		)
	const analysis = analyzed(structural)
	/** The analyzed DAG, each attachment judged at the delivered type the analysis restated it to (rel.ts Attach
	 * judged), which the read-backs' reader delivers. */
	const judged = judgedAsDelivered(analysis.dag)
	const dag = judged.dag
	const reads: ReadonlyArray<ReadBack> = readBacks.map((r) =>
		Object.freeze({
			name: r.name,
			query: r.query,
			node: r.root,
			deltas: Object.freeze(
				r.deltas.map((d) => Object.freeze({ relation: d.relation, side: d.side }))
			)
		})
	)
	/** The delta a Delta source names, by the checker's resolution (checkReadBack): an ordinary relation, whole; or a
	 * world relation W of the role. A delta in grizzle is what the ChangeSet wrote, so W's is defined exactly where it
	 * is what the ChangeSet wrote to W:
	 *
	 * - the ChangeSet writes nothing W's definition reads, neither its target nor any relation its filter reads: W's
	 *   delta is empty, as an ordinary relation's the ChangeSet does not write is;
	 * - W is a writable entry, the ChangeSet writes its target T only through W, and nothing else W's definition reads:
	 *   W's delta is T's projected onto W's head. Every fact an addition through W writes was prechecked into W, and a
	 *   deletion through W removes only facts of W, which the role's row security shows, so T's change is exactly W's;
	 * - otherwise it is refused: something the ChangeSet writes could move facts into or out of W, so the change to W
	 *   would not be what this ChangeSet wrote to it. */
	const deltaEntries = new Map<string, CheckedEntry>()
	const writtenThrough = new Map<string, Set<string>>()
	for (const members of strataMembers) {
		for (const m of members) {
			const { relation, entry } = m.target
			const through = writtenThrough.get(relation.name) ?? new Set<string>()
			through.add(entry.kind === "entry" ? entry.entry.entry : relation.name)
			writtenThrough.set(relation.name, through)
		}
	}
	type DeltaOf =
		| { readonly kind: "relation"; readonly relation: string; readonly via: DeltaVia }
		| { readonly kind: "empty"; readonly name: string }
	const deltaOf = (name: string): DeltaOf => {
		const world = checked.world
		if (world.kind === "reality") {
			return { kind: "relation", relation: name, via: whole }
		}
		const held = world.role.relations[name]
		if (held === undefined || held.kind === "whole") {
			return { kind: "relation", relation: name, via: whole }
		}
		const moving = (relations: Iterable<string>): string | undefined =>
			[...relations].toSorted(Order.compareStrings).find((r) => writtenThrough.has(r))
		const refused = (written: string): never =>
			refuse(
				"UnsupportedOperation",
				at,
				`a delta of ${name} the ChangeSet wrote; it also writes ${written}, which can move facts into or out of ${name}, so the change to ${name} would not be what this ChangeSet wrote to it`
			)
		const write = world.writes.get(name)
		const entry = write?.kind === "rows" ? write.writable : undefined
		if (entry === undefined) {
			const moved = moving(held.reads)
			return moved === undefined ? { kind: "empty", name } : refused(moved)
		}
		const filter = entry.filter
		const written = moving(filter.kind === "none" ? [] : queryUses(filter.query).relations)
		if (written !== undefined) {
			return refused(written)
		}
		const through = writtenThrough.get(entry.target.name)
		if (through === undefined) {
			return { kind: "empty", name }
		}
		if ([...through].some((n) => n !== name)) {
			return refused(entry.target.name)
		}
		deltaEntries.set(name, entry)
		return { kind: "relation", relation: entry.target.name, via: { kind: "entry", entry } }
	}
	/** The relations a family write writes through its families' statements: every reached family's member, a tree's
	 * relation among them, every edited member relation, and the owners of its families, whose count statements return
	 * only their keys, counts and ends. Their statements fill no delta carrier, so no read-back names their deltas. */
	const stratumRefills = occupied.flatMap(([stratum, { s }]) => {
		const refill = refills.get(s)
		return refill === undefined ? [] : [Object.freeze({ stratum, refill })]
	})
	const nestedRelations = new Set([
		...nestedWrites.flatMap((n) => [...n.nesting.layouts.keys()]),
		...edits.map((e) => e.relation),
		...families
			.filter((f) => edits.some((e) => e.relation === f.member.name))
			.map((f) => f.owner.name),
		...stratumRefills.flatMap(({ refill }) => [
			...refill.relations,
			...refill.recounted.map((f) => f.owner.name)
		])
	])
	if (new Set(edits.map((e) => e.stratum)).size > 1) {
		refuse(
			"UnsupportedOperation",
			at,
			"family members written in more than one stratum: each stratum's edits are planned from what one read before the changeset's writes finds, so write a ChangeSet's family members in one stratum"
		)
	}
	/** A refill draws from what the one read before the changeset's writes finds, so it is planned only in the first
	 * stratum, beside every edit of a family's members. */
	const refilledAt = stratumRefills.find(
		({ stratum }) => stratum > 0 || edits.some((e) => e.stratum !== stratum)
	)
	if (refilledAt !== undefined) {
		refuse(
			"UnsupportedOperation",
			at,
			`a change in stratum ${refilledAt.stratum} that refills the families ${refilledAt.refill.closure.refills.map((f) => `${f.id.owner}.${f.id.count}`).join(", ")}, beside an earlier stratum or family members written in another: a refill is planned from what one read before the changeset's writes finds, so make the change in the first stratum, with every family member the ChangeSet writes`
		)
	}
	const stratumEdits: ReadonlyArray<StratumEdit> = [
		...groupBy(edits, (e) => `${e.stratum}\u0000${e.relation}`)
	].map(([, list]): StratumEdit => {
		const first = list[0]
		const slotOf = (op: "insert" | "put" | "delete"): ParamId | undefined => {
			for (const e of list) {
				if (e.write.op === op) {
					return e.write.slot
				}
			}
			return undefined
		}
		return Object.freeze({
			stratum: first.stratum,
			relation: writtenOf(first.relation, at),
			inserts: slotOf("insert"),
			puts: slotOf("put"),
			deletes: slotOf("delete")
		})
	})
	for (const r of readBacks) {
		for (const d of r.deltas) {
			if (nestedRelations.has(d.relation)) {
				refuse(
					"UnsupportedOperation",
					childLoc(at, "reads", r.name),
					`a delta of ${d.relation}, which a family write writes through its family's statements: read ${d.relation} itself after the change`
				)
			}
		}
	}
	const classified = readBacks.flatMap((r) =>
		r.deltas.map((d) => ({ delta: d, side: d.side, of: deltaOf(d.relation) }))
	)
	const relationDeltas = groupBy(
		classified.flatMap((d) => (d.of.kind === "relation" ? [{ side: d.side, ...d.of }] : [])),
		(d) => d.relation
	).map(([name, named]): NamedDelta => {
		const throughEntry = named.find((d) => d.via.kind === "entry")
		const relation = base.relations.get(name)
		if (relation === undefined) {
			return refuse(
				"MalformedDescription",
				at,
				`a Delta source over an ordinary relation, not ${name}`
			)
		}
		return Object.freeze({
			kind: "relation",
			relation,
			sides: sidesOf(named),
			via: throughEntry === undefined ? whole : throughEntry.via
		})
	})
	/** An empty delta is carried in the heading of the Delta node that names it. */
	const emptyDeltas = groupBy(
		classified.flatMap((d) =>
			d.of.kind === "empty" ? [{ side: d.side, name: d.of.name, delta: d.delta }] : []
		),
		(d) => d.name
	).map(([name, named]): NamedDelta =>
		Object.freeze({
			kind: "empty",
			name,
			heading: named[0].delta.heading.map((c) => ({ name: c.name, type: c.type })),
			sides: sidesOf(named)
		})
	)
	const namedDeltas = [...relationDeltas, ...emptyDeltas].toSorted(
		Order.mapInput(Order.compareStrings, (d: NamedDelta) =>
			d.kind === "relation" ? d.relation.name : d.name
		)
	)

	const slotParams = slots.flatMap((g) => g.inputs.flatMap((i) => inputSlots(i).map((s) => s.slot)))
	const userParams = [...params.values()].toSorted(
		Order.mapInput(Order.compareStrings, (p: ParamDecl) => p.name)
	)
	const drafted: Drafted = {
		strata,
		reads,
		params: Object.freeze([...userParams.map((p) => p.id), ...slotParams])
	}
	/** The queries over the analyzed DAG, each node the frontend built read as its annotated counterpart. */
	const queries = queriesIn(drafted, dag, (node) => judged.of(analysis.of(node).node))
	/** The DAG the optimized artifact lowers: every take correlated through bind restated with its correlation explicit,
	 * as a query's is, so the take policy sees its parent set, and analyzed alike. The rewrite reads the analyzed DAG's
	 * roots, every described source and read-back, and keeps every node's label; each node the queries name is read as
	 * the node standing in its place there. A DAG with no root restates nothing and names no node. The conservative
	 * realization lowers `dag`, as checked. */
	const roots = dag.roots
	const restatement = ((): { readonly restated: WriteQueries; readonly restate: Counterpart } => {
		if (!isNonEmpty(roots)) {
			return { restated: queries, restate: (node) => node }
		}
		const takes = unwrap(everyParentTakes({ dag: rooted(roots), params: userParams }))
		const again = analyzed(takes.query.dag)
		const againJudged = judgedAsDelivered(again.dag)
		const restate: Counterpart = (node) => againJudged.of(again.of(takes.node(node)).node)
		const named: Drafted = {
			strata: queries.ir.strata,
			reads: queries.ir.reads,
			params: queries.ir.params
		}
		return { restated: queriesIn(named, againJudged.dag, restate), restate }
	})()

	return Object.freeze({
		...queries,
		...restatement,
		desc,
		schema: checked,
		laws,
		views,
		written: Object.freeze(
			[
				...new Set([
					...strataMembers.flat().map((m) => m.target.relation),
					...[...nestedRelations].map((name) => writtenOf(name, at))
				])
			].toSorted(Order.mapInput(Order.compareStrings, (r: WrittenRelation) => r.name))
		),
		params: Object.freeze(userParams),
		bindings: Object.freeze([...desc.bindings]),
		slots: Object.freeze(slots),
		slotsById: new Map(
			slots.flatMap((group) =>
				group.inputs.flatMap((input) =>
					inputSlots(input).map(
						(slot) => [slot.slot, Object.freeze({ group, input, slot })] as const
					)
				)
			)
		),
		nested: Object.freeze(nestedWrites),
		edits: stratumEdits,
		refills: Object.freeze(stratumRefills),
		deltas: Object.freeze(namedDeltas),
		references: Object.freeze(references),
		deltaEntries,
		codes,
		evaluate
	})
}
