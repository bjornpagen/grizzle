import type { CatalogKey } from "#compiler/analysis/physical/evidence.ts"
import type { CheckedEntry, CheckedSchema, DerivedAnalysis } from "#compiler/analysis/schema.ts"
import { immediateEvidence } from "#compiler/analysis/theory/theory.ts"
import { checkMember, checkReadBack } from "#compiler/check/index.ts"
import type { MemberRelation } from "#compiler/check/schema.ts"
import {
	type NormalForm,
	normalForm,
	positionalColumns,
	type RelationNormalizer,
	type RelationSlot,
	type RelationSpec,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import type { BudgetMeter } from "#compiler/core/budget.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import { type LawId, ParamId } from "#compiler/core/ids.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import type * as Result from "#compiler/core/result.ts"
import { rooted } from "#compiler/ir/dag.ts"
import type { ChangeSetDesc, MemberDesc } from "#compiler/ir/desc.ts"
import type { KeyField, RelationInfo } from "#compiler/ir/law.ts"
import type { LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import type { Heading, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import { slotSpelling } from "#compiler/ir/slots.ts"
import type {
	Action,
	ActionCore,
	ActionOp,
	ActionSource,
	ReadBack,
	SerialClass,
	Stratum,
	WriteIR
} from "#compiler/ir/write.ts"
import { derivedKeyConstraints } from "#compiler/laws/model/catalog.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { keyWitness } from "#compiler/laws/model/uniques.ts"
import { analyzeLogical, type LogicalAnalysis } from "#compiler/logical/annotate.ts"
import { everyParentTakes } from "#compiler/lower/shapes/take/decorrelate.ts"
import { withoutSerial } from "#compiler/scalar/compute/types.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { groupBy } from "#compiler/write/defined.ts"
import type { CheckNames, WriteWorld } from "#compiler/write/entry/precheck.ts"
import { deltaSources, GlueBuilder, QueryMerger, substitute } from "#compiler/write/frontend/dag.ts"
import {
	type EntryClaims,
	entryFacts,
	entryFillable,
	entryRelation,
	entryRowsParam,
	fillQuery
} from "#compiler/write/frontend/entry.ts"

import {
	canonicalActionOrder,
	type ImmediateReference,
	scheduleStratum
} from "#compiler/write/frontend/schedule.ts"
import { type RelationInput, relationInput } from "#compiler/write/insert/input.ts"
import { type RelationUniques, relationUniques } from "#compiler/write/insert/unique.ts"
import { type HostChecks, hostChecks } from "#compiler/write/normalize/normalize.ts"

export interface FrontendOptions {
	/** Which contexts the Db holds a fact of: a query entry's addition fills its fixed fields from them. */
	readonly claims: EntryClaims
	readonly meter: BudgetMeter
	/** The law model of the checked schema's Owned (`SchemaArtifacts.laws`). */
	readonly laws: LawModel
	/** The derived analysis of the schema every written relation is an ordinary relation of, reality's own or the
	 * role's base (`SchemaArtifacts.derived`). */
	readonly derived: DerivedAnalysis
	/** The world the compilation's statements are named in: a role's names its query entries' checks call. */
	readonly world: WriteWorld
}

/** An enumerated action's relation input: the facts of the ChangeSet value's array and Stream member slots `members`,
 * normalized on the host (normalize/) and sent as one relation parameter, for the operation and serial class of its
 * action. Its codecs are built with it, over its heading's positional columns (). */
export type WriteSlot = ActionOp & {
	readonly slot: ParamId
	/** stream when some member is a Stream, collected on the host up to recordsetMaxRows facts. */
	readonly kind: "enumerated" | "stream"
	readonly members: ReadonlyArray<SlotMember>
	/** The fields its facts carry, in heading order: the relation's heading, without the serial fields for generated
	 * additions, typed without the serial generation flag. */
	readonly heading: Heading
	/** The normal form of its admitted facts, which its relation parameter's placeholders encode. */
	readonly normalForm: NormalForm
	/** The slot as its action's relation input, its columns in key-first order (insert/input.ts relationInput). */
	readonly input: RelationInput
}

/** A member slot a write slot reads, and the normalizer that admits its facts against the slot's heading, whose faults
 * name the member. */
export interface SlotMember {
	readonly name: string
	readonly normalize: RelationNormalizer
}

/** The enumerated slots of one relation in one stratum, which the host normalizes together (normalize/): a same-key
 * refusal compares their additions. */
export interface SlotGroup {
	readonly stratum: number
	readonly relation: WrittenRelation
	readonly slots: NonEmptyReadonlyArray<WriteSlot>
	/** The facts the slots carry as the host checks them: the relation's, or a query entry's. */
	readonly facts: SlotFacts
}

/** What the host's normalization reads of the facts of a slot group: the relation the facts are of as a refusal names
 * it, its serial fields, and its same-key checks, over the facts' own fields. */
export interface SlotFacts {
	readonly name: string
	readonly serial: ReadonlyArray<string>
	readonly host: HostChecks
}

/** A declared key, its fields' handles in its object's order, a span last, and the law its object reports with its
 * description: identity must be declared honestly. */
export interface KeyLaw {
	readonly fields: NonEmptyReadonlyArray<KeyField>
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
	readonly reads: ActionReads
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

const readsIn = (reads: ActionReads, at: Counterpart): ActionReads =>
	reads.kind === "described" ? describedIn(reads.node, at) : reads

const sourceReadsIn = (reads: SourceReads, at: Counterpart): SourceReads =>
	reads.kind === "described" ? describedIn(reads.node, at) : reads

/** An action's source with the node it names read through `at`. */
export const sourceIn = (source: ActionSource, at: Counterpart): ActionSource =>
	source.kind === "described" ? Object.freeze({ kind: "described", node: at(source.node) }) : source

/** An action's information with the node its reads name read through `at`. */
export const infoIn = (info: ActionInfo, at: Counterpart): ActionInfo =>
	Object.freeze({ ...info, reads: readsIn(info.reads, at) })

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
						outside: Object.freeze(stratum.outside.map((write) => outsideIn(write, at)))
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
 * when the action has one. */
export type SourceReads =
	| { readonly kind: "slot"; readonly slot: WriteSlot }
	| { readonly kind: "described"; readonly node: RelNode }

/** What an action reads: its source's facts (`SourceReads`); or, for a generated addition into a relation whose every
 * field is serial, its slot alone, whose facts carry no field, each the one empty fact the host makes one, so the
 * addition is one row of identity defaults when the slot holds any. The front end refuses a described member there
 * (`compile`), and builds it only for a relation written whole: a query entry's fill reads a relation parameter of at
 * least one field. */
export type ActionReads = SourceReads | { readonly kind: "defaults"; readonly slot: WriteSlot }

/** A node the write names, read in another form of the write DAG: the node standing in its place there. */
export type Counterpart = (node: RelNode) => RelNode

/** A stratum of a write: its actions, each carrying its information, and the additions it refuses outright
 * (OutsideWrite). */
export interface WriteStratum extends Stratum<ActionInfo> {
	readonly outside: ReadonlyArray<OutsideWrite>
}

/** The WriteIR of a write's front end, each stratum with its refused additions. */
export interface FrontendIR extends WriteIR<ActionInfo> {
	readonly strata: ReadonlyArray<WriteStratum>
}

/** What a write reads, over one form of its DAG: its WriteIR, every node it names a node of `ir.dag`. */
export interface WriteQueries {
	readonly ir: FrontendIR
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
	/** The relations whose deltas the read-backs name, in code point order. */
	readonly deltas: ReadonlyArray<NamedDelta>
	readonly references: ReadonlyArray<ImmediateReference>
	/** The query entries whose deltas a read-back names as their targets' projected, by name (see deltaOf). */
	readonly deltaEntries: ReadonlyMap<string, CheckedEntry>
}

const refuse = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/** The parameter a write's member slot binds, spelled by the one slot rule, its kind the serial class
 * of its facts: generated; explicit, complete facts of a relation with serial fields; or none. `relation` is the
 * member's own: an ordinary relation, or a query entry's facts. */
const writeSlotId = (stratum: number, act: ActionOp, relation: MemberRelation): ParamId =>
	ParamId(
		slotSpelling(
			"slot",
			stratum,
			act.op,
			act.op === "insert" && act.serial === "generated"
				? "generated"
				: relation.serial.length > 0
					? "explicit"
					: "none",
			relation.name
		)
	)

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

/** A relation's heading as the facts of `act` carry it: names and types, serial generation flags dropped, and a
 * generated addition's serial fields. */
const inputHeading = (relation: MemberRelation, act: ActionOp): Heading =>
	relation.heading
		.filter(
			(c) => act.op !== "insert" || act.serial === "complete" || !relation.serial.includes(c.name)
		)
		.map((c) => ({ name: c.name, type: withoutSerial(c.type) }))

/** The serial class of a described insert from the heading its query delivers (checkMemberHeading has refused a head
 * that supplies some serial fields and not others). */
const insertSerial = (relation: MemberRelation, query: LogicalQuery): SerialClass => {
	const delivered = query.dag.roots[0].heading
	return relation.serial.every((f) => delivered.some((c) => c.name === f))
		? "complete"
		: "generated"
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

/** A stratum's member, checked: its operation, its relation, what it writes, and its source, an array or Stream member
 * slot, or a query with its root in the write DAG, whose head is the member relation's. */
interface CheckedMember {
	readonly op: MemberDesc["op"]
	readonly relation: WrittenRelation
	readonly entry: MemberEntry
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
	| { readonly kind: "slot"; readonly slot: WriteSlot }
	| {
			readonly kind: "described"
			readonly slot: WriteSlot | undefined
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

/** An action before its source is built: what it does, its relation, what it reads, and what it writes. */
interface Draft {
	readonly act: ActionOp
	readonly relation: WrittenRelation
	readonly reads: DraftReads
	readonly entry: DraftEntry
}

/** A refused addition before its source is built (OutsideWrite). */
interface OutsideDraft {
	readonly entry: string
	readonly member: MemberRelation
	readonly act: ActionOp
	readonly reads: DraftReads
}

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
 *    its ordinary relation of the base, and a query entry its writable entry's target. Compiled for
 *    reality (a workload), it must be an ordinary relation (a closed or derived relation, which no ChangeSet writes, is
 *    MalformedDescription at the member). Each described member is checked as a query whose head is written into that
 *    relation, or into the entry's heading (checkMember: DescribedHeadingMismatch, an insert omitting all of its serial
 *    fields or none), and each read-back as a query over the post-change state that may read the delta sources of
 *    every ordinary relation (checkReadBack); both read the role's relations, which reach nothing else. The parameters
 *    of every member and read-back are one namespace, which the Description's decoder has checked holds every name
 *    ChangeSet.bind closed and no name of a member slot: a name declared twice must be declared alike,
 *    which the checked types of its declarations decide.
 * 2. Group. Within a stratum, the enumerated members (arrays and Streams) of one operation on one relation are one
 *    action reading one slot, the relation input the host normalizes (normalize/): an insert into a relation with
 *    serial fields has two, one for complete facts and one for generated additions, because an array may hold both.
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
 * 3. Serial class. Each insertion's serial class: generated, when its facts omit the relation's serial fields, or
 *    complete. The statement that realizes an action is the lowering's, a put's chosen with the proofs the whole
 *    ChangeSet gives.
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
	const meter = options.meter
	const { laws, derived } = options
	const views = derivedKeyConstraints(derived)
	const checkOptions = { meter }
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
					host: hostChecks(keyLaws, uniques)
				})
			]
		})
	)
	const writtenOf = (name: string, loc: SourceLoc): WrittenRelation =>
		writable.get(name) ??
		refuse("MalformedDescription", loc, `an ordinary relation of the schema, not ${name}`)
	/** What a member's relation name writes (see `compileChangeSet`). */
	const targetOf = (
		name: string,
		loc: SourceLoc
	): { relation: WrittenRelation; entry: MemberEntry } => {
		const world = checked.world
		if (world.kind === "reality") {
			return { relation: writtenOf(name, loc), entry: { kind: "whole" } }
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
			return { relation: writtenOf(name, loc), entry: { kind: "whole" } }
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
		return {
			relation,
			entry: {
				kind: "entry",
				entry,
				names: writeWorld.names,
				member: entryRelation(entry),
				fillable: entryFillable(entry, options.claims)
			}
		}
	}
	/** A described generated addition into a relation whose every field is serial has a head of no field. No
	 * relation input holds zero columns (`InputSet`), so it could meet no enumerated slot in a
	 * generated action's union (group, below), and alone it would be no slot's defaults (`ActionReads`), the one empty
	 * fact the host normalized: such an addition is an enumerated member, an array or a Stream of empty facts. */
	const strataMembers = desc.strata.map((stratum) =>
		stratum.members.map((member): CheckedMember => {
			const loc = member.loc
			const { relation, entry } = targetOf(member.relation, loc)
			const written: MemberRelation = entry.kind === "entry" ? entry.member : relation
			const source = member.member
			if (source.kind !== "query") {
				return {
					op: member.op,
					relation,
					entry,
					loc,
					source: { kind: "enumerated", member: source }
				}
			}
			const query = unwrap(
				checkMember(
					checked,
					{ op: member.op, relation: written, query: source.query, loc },
					{ ...checkOptions, label: `${member.op} ${member.relation}` }
				)
			)
			for (const p of query.params) {
				merge(params, p, loc)
			}
			if (
				member.op === "insert" &&
				written.heading.every((c) => written.serial.includes(c.name)) &&
				insertSerial(written, query) === "generated"
			) {
				refuse(
					"UnsupportedOperation",
					loc,
					`a generated addition into ${written.name}, whose every field is serial, as an array or a Stream of empty facts; a described member's head holds no field to add`
				)
			}
			return {
				op: member.op,
				relation,
				entry,
				loc,
				source: { kind: "described", query, root: merger.add(query) }
			}
		})
	)
	/** A write into an entry refuses a stratum that also writes a relation its filter reads. */
	const refuseMovedFilter = (m: CheckedMember, writtenNames: ReadonlySet<string>): void => {
		if (m.entry.kind !== "entry") {
			return
		}
		const entry = m.entry.entry
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
	for (const members of strataMembers) {
		const writtenNames = new Set(members.map((m) => m.relation.name))
		for (const m of members) {
			refuseMovedFilter(m, writtenNames)
		}
	}
	const readBacks = desc.reads.map((r) => {
		const query = unwrap(checkReadBack(checked, r, { ...checkOptions, label: `read ${r.name}` }))
		for (const p of query.params) {
			merge(params, p, childLoc(at, "reads", r.name))
		}
		const root = merger.add(query)
		return { name: r.name, query: r.query, root, deltas: deltaSources(root) }
	})

	/** A query entry's fill over `input`, the facts its sources carry, checked against the base as a member of its target
	 * and merged into the DAG: its root. */
	const mergeFill = (
		entry: CheckedEntry,
		relation: WrittenRelation,
		op: MemberDesc["op"],
		input: Heading,
		loc: SourceLoc
	): RelNode =>
		merger.add(
			unwrap(
				checkMember(
					base,
					{ op, relation, query: fillQuery(entry, input, loc), loc },
					{ ...checkOptions, label: `${op} ${entry.entry}` }
				)
			)
		)

	/** 2. Group each stratum's members into actions. */
	const slots: Array<SlotGroup> = []
	const occupied = strataMembers.flatMap((members, s) =>
		members.length > 0 ? [{ s, members }] : []
	)
	/** Every put source of the relation in the stratum is one action (see `compileChangeSet`).
	 *
	 * An exact delete of an absent fact is a no-op, so every delete member is its own action.
	 *
	 * Every generated addition of the relation in the stratum is one action over the union of its
	 * sources, so the one SELECT DISTINCT over its head makes equal generated additions one new fact
	 * whichever sources requested them. Every other insert member is its own action: the insert
	 * protocol makes a second equal fact an exact repeat. */
	const draftsByStratum = occupied.map(({ s, members }) => {
		const drafts: Array<Draft> = []
		const outside: Array<OutsideDraft> = []
		const byRelation = [...groupBy(members, (m) => m.relation.name)].toSorted(
			Order.mapInput(Order.compareStrings, ([name]: readonly [string, unknown]) => name)
		)
		for (const [, list] of byRelation) {
			const relation = list[0].relation
			/** One writable entry per base relation per role, so every member of the relation writes it alike. */
			const target = list[0].entry
			const written: MemberRelation = target.kind === "entry" ? target.member : relation
			const groupSlots: Array<WriteSlot> = []
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
				/** The slot of the operation's enumerated members, read as `act`, when it has any. */
				const slotOf = (act: ActionOp): WriteSlot | undefined => {
					if (enumerated.length === 0) {
						return undefined
					}
					const heading = inputHeading(written, act)
					const columns = positionalColumns(heading)
					const spec = (slot: RelationSlot): RelationSpec => ({
						relation: written.name,
						columns,
						slot
					})
					const id = writeSlotId(s, act, written)
					const slot: WriteSlot = Object.freeze({
						...act,
						slot: id,
						kind: enumerated.some((m) => m.kind === "stream") ? "stream" : "enumerated",
						members: Object.freeze(
							enumerated.map((m): SlotMember =>
								Object.freeze({
									name: m.slot,
									normalize: relationNormalizer(spec({ kind: "slot", name: m.slot }))
								})
							)
						),
						heading,
						normalForm: normalForm(spec({ kind: "none" })),
						input: relationInput(id, heading, relation)
					})
					groupSlots.push(slot)
					return slot
				}
				/** The action `act` over its slot and the described members' `roots`, when it reads any: written whole, through
				 * its entry's fill, or refused outright when the fill can fill nothing, where a deletion is a no-op. */
				const draft = (
					act: ActionOp,
					slot: WriteSlot | undefined,
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
						drafts.push({ act, relation, reads, entry: { kind: "whole" } })
						return
					}
					if (!target.fillable) {
						if (act.op !== "delete") {
							outside.push({ entry: target.entry.entry, member: written, act, reads })
						}
						return
					}
					const fill = mergeFill(target.entry, relation, act.op, inputHeading(written, act), loc)
					drafts.push({
						act,
						relation,
						reads,
						entry: { kind: "entry", entry: target.entry, names: target.names, fill }
					})
				}
				switch (op) {
					case "put": {
						const act = { op }
						draft(
							act,
							slotOf(act),
							queries.map((q) => q.root)
						)
						break
					}
					case "delete": {
						const act = { op }
						draft(act, slotOf(act), [])
						for (const q of queries) {
							draft(act, undefined, [q.root])
						}
						break
					}
					case "insert": {
						const classed = queries.map((q) => ({
							root: q.root,
							serial: insertSerial(written, q.query)
						}))
						const generated = classed.flatMap((d) => (d.serial === "generated" ? [d.root] : []))
						/** The facts' own serial fields decide: a query entry's facts carry every serial field its
						 * filter reads (`entryRelation`). */
						const classes: ReadonlyArray<SerialClass> =
							written.serial.length === 0 ? ["complete"] : ["complete", "generated"]
						for (const serial of classes) {
							const act = { op, serial }
							draft(act, slotOf(act), serial === "generated" ? generated : [])
						}
						for (const d of classed.filter((x) => x.serial !== "generated")) {
							draft({ op, serial: d.serial }, undefined, [d.root])
						}
						break
					}
				}
			}
			if (isNonEmpty(groupSlots)) {
				slots.push(
					Object.freeze({
						stratum: s,
						relation,
						slots: Object.freeze(groupSlots),
						facts:
							target.kind === "entry"
								? entryFacts(target.entry, target.member, relation.host)
								: { name: relation.name, serial: relation.serial, host: relation.host }
					})
				)
			}
		}
		return { drafts, outside }
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
	const builtByStratum = draftsByStratum.map(({ drafts, outside }) => ({
		outside,
		built: drafts.map(({ act, relation, reads, entry }): Built => {
			const heading = inputHeading(relation, act)
			/** The source, what it reads and the heading it delivers: the slot alone; one described member's query alone;
			 * or the Union of the slot's InputSet and of every described member's query. A query entry's sources, in its
			 * facts, fill its fill's relation parameter, and the fill is the source. */
			const read = ((): {
				readonly source: ActionSource
				readonly reads: ActionReads
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
							source: { kind: reads.slot.kind, slot: reads.slot.slot },
							reads: isNonEmpty(reads.slot.heading)
								? reads
								: { kind: "defaults", slot: reads.slot },
							heading
						}
					case "described": {
						const [first, ...more] = reads.roots
						const node =
							reads.slot === undefined && more.length === 0
								? first
								: sourceOf(reads, relation.name, heading)
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
	const placedByStratum = builtByStratum.map(({ built, outside }) => ({
		built,
		outside: Object.freeze(
			outside.map((d): OutsideWrite => {
				const heading = inputHeading(d.member, d.act)
				const reads: SourceReads =
					d.reads.kind === "slot"
						? d.reads
						: { kind: "described", node: sourceOf(d.reads, d.entry, heading) }
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
			? [{ from: n.object.relation.name, to: n.object.target.name }]
			: []
	)

	/** 4. Schedule, with the final sources. */
	const strata = placedByStratum.map(({ built, outside }): WriteStratum =>
		Object.freeze({
			actions: Object.freeze(
				scheduleStratum(canonicalActionOrder(built), references).map(
					({ scheduled, dependsOn }): Action<ActionInfo> =>
						Object.freeze({ ...scheduled.action, dependsOn, info: scheduled.info })
				)
			),
			outside
		})
	)

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
	const dag = analysis.dag
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
			const through = writtenThrough.get(m.relation.name) ?? new Set<string>()
			through.add(m.entry.kind === "entry" ? m.entry.entry.entry : m.relation.name)
			writtenThrough.set(m.relation.name, through)
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
			heading: named[0].delta.heading.map((c) => ({ name: c.name, type: withoutSerial(c.type) })),
			sides: sidesOf(named)
		})
	)
	const namedDeltas = [...relationDeltas, ...emptyDeltas].toSorted(
		Order.mapInput(Order.compareStrings, (d: NamedDelta) =>
			d.kind === "relation" ? d.relation.name : d.name
		)
	)

	const slotParams = slots.flatMap((g) => g.slots.map((s) => s.slot))
	const userParams = [...params.values()].toSorted(
		Order.mapInput(Order.compareStrings, (p: ParamDecl) => p.name)
	)
	const drafted: Drafted = {
		strata,
		reads,
		params: Object.freeze([...userParams.map((p) => p.id), ...slotParams])
	}
	/** The queries over the analyzed DAG, each node the frontend built read as its annotated counterpart. */
	const queries = queriesIn(drafted, dag, (node) => analysis.of(node).node)
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
		const restate: Counterpart = (node) => again.of(takes.node(node)).node
		const named: Drafted = {
			strata: queries.ir.strata,
			reads: queries.ir.reads,
			params: queries.ir.params
		}
		return { restated: queriesIn(named, again.dag, restate), restate }
	})()

	return Object.freeze({
		...queries,
		...restatement,
		desc,
		schema: checked,
		laws,
		views,
		written: Object.freeze(
			[...new Set(strataMembers.flat().map((m) => m.relation))].toSorted(
				Order.mapInput(Order.compareStrings, (r: WrittenRelation) => r.name)
			)
		),
		params: Object.freeze(userParams),
		bindings: Object.freeze([...desc.bindings]),
		slots: Object.freeze(slots),
		deltas: Object.freeze(namedDeltas),
		references: Object.freeze(references),
		deltaEntries
	})
}
