import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { servedDerivations } from "#compiler/analysis/derived/served.ts"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import type {
	CheckedEntry,
	CheckedSchema,
	ClaimsMembership,
	DerivedAnalysis
} from "#compiler/analysis/schema.ts"
import { queryColumns } from "#compiler/analysis/theory/columns.ts"
import { withGenerationInputs } from "#compiler/analysis/theory/fill.ts"
import { navigateQuery, Navigation } from "#compiler/analysis/theory/navigate.ts"
import { editedBy } from "#compiler/analysis/theory/refill.ts"
import { immediateEvidence } from "#compiler/analysis/theory/theory.ts"
import { clockParams, sourcedParams } from "#compiler/check/clock.ts"
import {
	CheckSession,
	checkFill,
	checkMember,
	checkReadBack,
	checkRelation
} from "#compiler/check/index.ts"
import type { MemberColumn, MemberRelation } from "#compiler/check/schema.ts"
import { catchRefusal, Refusal, unwrap } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose, ruleRefused } from "#compiler/core/errors.ts"
import type { IdentityDigest } from "#compiler/core/fingerprint.ts"
import { EntryName, type LawId, ParamId, type StoredRelationName } from "#compiler/core/ids.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import * as Order from "#compiler/core/order.ts"
import { closedChangeRefusals } from "#compiler/core/refusals.ts"
import type { ClockBinding, ClockSource } from "#compiler/ir/clock.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { rooted } from "#compiler/ir/dag.ts"
import { claimedColumn, type DerivedRows, servedDag } from "#compiler/ir/derived.ts"
import {
	bindRelationParams,
	boundRowsLoc,
	boundRowsQuery,
	type ChangeSetDesc,
	decodeDesc,
	descIdentity,
	enumeratedMember,
	identityQuery,
	memberParamNames,
	type PlannedChangeSetDesc,
	type PlannedMemberDesc,
	type FactsMemberDesc,
	type QueryDesc,
	queryParamNames,
	type RelationParamSourceDesc,
	rowsParamNames,
	type WriteOp
} from "#compiler/ir/desc.ts"
import { fieldReads } from "#compiler/ir/expr.ts"
import { type Family, isSequence, isTreeOf, type TreeShape } from "#compiler/ir/family.ts"
import { familyDrawn, layoutKey } from "#compiler/ir/fill.ts"
import { type Computed, type Stamp, type Stamped, stampText } from "#compiler/ir/instant.ts"
import {
	type ColumnKey,
	columnKey,
	columnKeyOf,
	familyKey,
	generationOf,
	headingColumns,
	keyHeads,
	type LawField,
	type NativeColumn,
	type RelationInfo
} from "#compiler/ir/law.ts"
import type { LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import type { DeltaSide, Heading, HeadingColumn, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import { reservedSlot } from "#compiler/ir/slots.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type {
	Action,
	ActionCore,
	ActionOp,
	ActionSource,
	BoundInput,
	ReadBack,
	Stratum,
	WriteIR
} from "#compiler/ir/write.ts"
import { derivedEvidence, type ViewEvidence } from "#compiler/laws/model/catalog.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { keyWitness } from "#compiler/laws/model/uniques.ts"
import {
	analyzeLogical,
	judgedAsDelivered,
	keptNodes,
	type LogicalAnalysis,
	type LogicalEnv
} from "#compiler/logical/annotate.ts"
import { type Producers, propagatedWrite } from "#compiler/lower/optimize/propagate/index.ts"
import { sameExpr } from "#compiler/lower/shapes/catalog/exprs.ts"
import { everyParentTakes } from "#compiler/lower/shapes/take/decorrelate.ts"
import {
	closedIndexOf,
	closedLeaf,
	type HostEvaluator,
	hostEvaluator
} from "#compiler/runtime/write/fill.ts"
import { sentLayout } from "#compiler/runtime/write/nesting.ts"
import { readsThrough, writesOf } from "#compiler/schema/reach.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { RecordedLaw } from "#compiler/types/changeset/changeset.ts"
import { groupBy } from "#compiler/write/defined.ts"
import { deltaSources, GlueBuilder, QueryMerger, substitute } from "#compiler/write/frontend/dag.ts"
import {
	type EntryClaims,
	entryFacts,
	entryFillable,
	entryRelation,
	entryRowsParam,
	fillQuery
} from "#compiler/write/frontend/entry.ts"
import { equalQuery } from "#compiler/write/frontend/equal.ts"

import type { HostChecks, KeyGeneration, StartData } from "#compiler/runtime/write/normalize.ts"
import type { WitnessEntry } from "#compiler/runtime/write/witness.ts"
import type {
	FamilySource,
	UnitDelete,
	UnitMatch,
	UnitMember
} from "#compiler/write/delete/unit.ts"
import {
	type NestedLayout,
	type Nesting,
	nestingOf,
	statementFilled
} from "#compiler/write/family/nesting.ts"
import { endColumns, memberFamilies } from "#compiler/write/family/statements.ts"
import {
	type Removal,
	refuseStampsApart,
	refuseUnitPlace,
	removalOf,
	type StampingAction,
	stampsOf
} from "#compiler/write/frontend/instants.ts"
import {
	type PlainRefill,
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
	familyNodeRelations,
	type FamilyRemovals,
	type GeneratedColumn,
	generating,
	type CopySource,
	type HeldOwner,
	type HeldSource,
	type ImmediateReference,
	type Meeting,
	type OwnerCopy,
	type RemovalEdit,
	type Schedule,
	scheduleStratum
} from "#compiler/write/frontend/schedule.ts"
import { payloadOf, primaryKeyShape } from "#compiler/write/frontend/targets.ts"
import { type RelationInput, relationInput } from "#compiler/write/insert/input.ts"
import { isCarried, keyFirst } from "#compiler/write/insert/statement.ts"
import {
	entryUniques,
	type RelationUniques,
	relationUniques
} from "#compiler/write/insert/unique.ts"
import { computedChecks, hostChecks, keyGenerations } from "#compiler/write/normalize/normalize.ts"
import { existingKeysProofOver } from "#compiler/write/put/proof.ts"

export interface FrontendOptions {
	/** Which contexts the Db holds a fact of: a query entry's addition fills its fixed fields from them. */
	readonly claims: EntryClaims
	/** The law model of the checked schema's Owned (`SchemaArtifacts.laws`). */
	readonly laws: LawModel
	/** The derived analysis of the schema every written relation is an ordinary relation of, reality's own or the
	 * role's base (`SchemaArtifacts.derived`). */
	readonly derived: DerivedAnalysis
	/** The installation's codes, which every member's normalizer admits a closed id's and a set's values by. */
	readonly codes: Codebook
	/** Each parameter bound to the database's clock (check/clock.ts clockParams), the binding of the clocked member the
	 * ChangeSet serves; none for every other ChangeSet (ir/clock.ts noClock). */
	readonly clock: ClockBinding
	/**
	 * Where the ChangeSet's readings of the clock count from, its clocked parameters' and its stamps' alike (ir/clock.ts
	 * ClockSource): a moved clock's declares the clock's stated instant after the ChangeSet's own parameters.
	 */
	readonly source: ClockSource
}

/** One relation parameter of a write: the facts of one class of one operation's enumerated members, normalized on the
 * host (normalize/) and sent as its arrays, one per column. Its codecs are built with it, over its heading's positional
 * columns. */
export interface MemberSlot {
	readonly slot: ParamId
	/** stream when some member is a Stream, collected on the host, whole. */
	readonly transport: "enumerated" | "stream"
	/** The fields its facts carry, in heading order: its target's (`CheckedTarget`), none for the unit relation. */
	readonly heading: Heading
	/** The slot as its action's relation input, its columns in key-first order (insert/input.ts relationInput). */
	readonly input: RelationInput
}

/** An operation an enumerated input of one slot is read by: a deletion, a put, or an insertion. A deletion's facts name rows, or units, a tree's or a family owner's, which the
 * stratum's unit delete removes whole with every row nested under them (write/delete/unit.ts): the host nets a row the
 * stratum adds again out of its deletions, never a unit, whose rows the unit statement keeps one by one where the
 * stratum adds them again unchanged (runtime/write/normalize.ts). */
export type SingleAct =
	| { readonly op: "delete"; readonly names: "rows" | "units" }
	| { readonly op: "put" }
	| { readonly op: "insert" }

/** The enumerated members of one operation on one relation in one stratum, by their member slots' names, whose faults
 * name them, and the slot each of their facts travels in: one slot, for a deletion, a put and an insertion; or an
 * insertion whose facts nest families at their count fields (write/family/nesting.ts), split, filled and cut into its
 * families' writes on the host, its relation's own rows in its slot, every column but a generated one, and none for a
 * tree's roots, which their tree's write inserts. A nested slot's facts are admitted by its heading
 * (write/normalize/normalize.ts bindGroup). */
export type EnumeratedInput =
	| {
			readonly kind: "nested"
			readonly act: Extract<SingleAct, { readonly op: "insert" }>
			readonly slot: MemberSlot
			readonly nesting: Nesting
			/** Each member relation its families reach, with the same-key checks its nested rows are judged by, which are
			 * stated in its own words: a nested write reaches no query entry. */
			readonly reached: ReadonlyMap<StoredRelationName, HostChecks>
			readonly members: NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "single"
			readonly act: SingleAct
			readonly slot: MemberSlot
			readonly members: NonEmptyReadonlyArray<string>
			/** The fields its members' facts are admitted by: its slot's but those it starts. */
			readonly admitted: Heading
			/**
			 * The fields its slot carries beyond the ones its facts do, each at its start: an owner's counts and ends,
			 * which an owner of counted families inserted on the plain path writes from its slot, so the stratum's
			 * appends to it ride its own row (runtime/write/bind.ts freshOwners); none for any other input.
			 */
			readonly starts: ReadonlyArray<StartData>
	  }

/** The member slots whose facts an enumerated input writes as rows: none of a deletion's, every other input's one. */
const writingSlots = (input: EnumeratedInput): ReadonlyArray<MemberSlot> =>
	input.kind === "single" && input.act.op === "delete" ? [] : [input.slot]

/** The enumerated inputs of one relation in one stratum, one per operation, which the host normalizes together
 * (normalize/): a same-key refusal compares their additions. */
export interface SlotGroup {
	readonly stratum: StratumAt
	readonly relation: WrittenRelation
	readonly inputs: NonEmptyReadonlyArray<EnumeratedInput>
	/** The facts as the host checks them: the words they are stated in, and their same-key checks. */
	readonly facts: SlotFacts
}

/**
 * The words a slot group's facts are stated in: its written relation's own, through a whole entry; or a query entry's,
 * its head fields', with what the host reads them back into facts of its target by (runtime/write/witness.ts
 * WitnessEntry).
 */
export type StatedIn =
	| { readonly kind: "relation" }
	| { readonly kind: "entry"; readonly entry: WitnessEntry }

/** What the host's normalization reads of the facts of a slot group: the words they are stated in, their same-key
 * checks, over the facts' own fields, and the key generations it fills each fact with (write/normalize/normalize.ts
 * keyGenerations), none for facts a query entry states, whose statement casts them into its target. */
export interface SlotFacts {
	readonly stated: StatedIn
	readonly host: HostChecks
	readonly generations: ReadonlyArray<KeyGeneration>
}

/** Facts stated in their written relation's own words. */
const statedInRelation: StatedIn = Object.freeze({ kind: "relation" })

/** What a slot of facts that nest no member states beside their key and caller's fields: nothing. */
const noneWalked: ReadonlySet<ColumnKey> = new Set()

/** A slot of a stratum's edit of one member relation, by the operation its facts take, with the fields its facts leave
 * out that its family statement fills (ir/instant.ts Stamped): a stamped nesting's root's, and an insert's computed
 * fields; none for any other slot. */
export interface EditSlot {
	readonly as: "inserts" | "puts" | "deletes"
	readonly slot: ParamId
	readonly stamps: ReadonlyArray<Stamped>
}

/** A stratum's edits of one member relation: its slots, each normalized as any slot is, one per operation, its
 * inserts', then its puts', then its deletes'; none for a relation only a nested write of the stratum fills. */
export interface StratumEdit {
	readonly stratum: StratumAt
	readonly relation: WrittenRelation
	readonly slots: ReadonlyArray<EditSlot>
}

/** The operations of a stratum's edit, each under the name its slot is read by, in the order its slots are. */
const editSlotOps = [
	["insert", "inserts"],
	["put", "puts"],
	["delete", "deletes"]
] as const

/** A nested write of a stratum: the insert's relation's nesting and the slot its facts travel in. */
export interface NestedWrite {
	readonly stratum: StratumAt
	readonly nesting: Nesting
	readonly slot: MemberSlot
}

/** A relation whose rows a stratum's nested writes fill: its layout there (write/family/nesting.ts NestedLayout) and the
 * nesting that lays it out. */
export interface StratumLayout {
	readonly nesting: Nesting
	readonly layout: NestedLayout
}

/** A source of a relation's rows its stratum inserts or puts as the host sends it (schedule.ts HeldSource): the column
 * keys it holds, and the fields its rows leave out that a stamp fills (ir/instant.ts Stamped), which the statement that
 * writes them takes. */
interface SentSource {
	readonly source: HeldSource
	readonly holds: ReadonlyArray<ColumnKey>
	readonly stamps: ReadonlyArray<Stamped>
}

/** The sources of a relation's rows a stratum inserts or puts (frontend/compile.ts rowsOf): every one the host sends,
 * and those a family statement appends them from, its edits' slots and its nested rows. */
interface RowsOf {
	readonly sent: ReadonlyArray<SentSource>
	readonly appended: ReadonlyArray<SentSource>
}

/**
 * A stratum's fresh fill as the host leaves it to its statements (frontend/compile.ts freshFillOf, runtime/write/bind.ts
 * freshOwners): the columns of each relation's rows it leaves to the statement that writes them, by relation, their
 * stamps' and the generated fields over them, and each counted family member's key and group fields a stamp fills, the
 * call's one value of each, which its additions statement fills the host's members with (write/family/additions.ts
 * FreshGroups `drawn`).
 */
export interface FreshFill {
	readonly left: ReadonlyMap<StoredRelationName, ReadonlySet<ColumnKey>>
	readonly stamps: ReadonlyMap<StoredRelationName, ReadonlyArray<Stamped>>
}

/** A source of an owner's rows as a family statement reads an owner copy from it (schedule.ts HeldSource), with the
 * column keys it holds there. */
interface OwnerSourceRead {
	readonly source: HeldSource
	readonly holds: ReadonlyArray<ColumnKey>
}

/**
 * The rows of an owner its stratum inserts as a family statement reads its owner copies from them
 * (schedule.ts CopySource): none, so the table holds every owner a member names; some a described member inserts or
 * puts, whose rows the database computes; or every source of them, each with the columns it holds there.
 */
type OwnerReading =
	| { readonly kind: "none" }
	| { readonly kind: "described" }
	| { readonly kind: "sources"; readonly sources: NonEmptyReadonlyArray<OwnerSourceRead> }

/**
 * Each relation whose rows the nested writes `nested` fill in `stratum`, by name, laid out by the one nesting of the
 * stratum that writes its rows, each in the order its nesting is first met. A relation's rows are nested under at most
 * one sequence (analysis/theory/laws.ts families), a sequence's member is inserted only under its owner, and every
 * nested insert of one relation in one stratum holds that relation's one nesting (`nestingFor`), so the stratum's
 * distinct nestings lay out disjoint relations and no layout is picked among nested writes, whatever order the
 * ChangeSet states them in. The one reading of a stratum's nested layouts, the binding's and its family statements'.
 */
export const stratumLayouts = (
	nested: ReadonlyArray<NestedWrite>,
	stratum: StratumAt
): ReadonlyMap<StoredRelationName, StratumLayout> => {
	const out = new Map<StoredRelationName, StratumLayout>()
	for (const nesting of new Set(
		nested.flatMap((n) => (n.stratum === stratum ? [n.nesting] : []))
	)) {
		for (const [relation, layout] of nesting.layouts) {
			const other = out.get(relation)
			if (other !== undefined) {
				defect(
					`${relation}'s rows nested by one nesting of stratum ${stratum}, ${nesting.relation.name}'s, where ${other.nesting.relation.name}'s nests them too`
				)
			}
			out.set(relation, { nesting, layout })
		}
	}
	return out
}

/** A declared key, its fields' handles in its object's order, a span last, and the law its object reports with its
 * description: identity must be declared honestly. */
export interface KeyLaw {
	readonly fields: NonEmptyReadonlyArray<LawField>
	readonly law: LawId
	readonly described: RecordedLaw
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
			readonly sides: ReadonlySet<DeltaSide>
			readonly via: Via
	  }
	| {
			readonly kind: "empty"
			readonly name: string
			readonly heading: Heading
			readonly sides: ReadonlySet<DeltaSide>
	  }

/** The law of a written relation's primary key, the insert protocol's arbiter. */
export const arbiterLaw = (relation: WrittenRelation): LawId => relation.keyLaws[0].law

/** What the write lowering needs about one action beyond the WriteIR's record. */
export interface ActionInfo {
	readonly relation: WrittenRelation
	readonly reads: SourceReads
	/** The heading its source delivers. */
	readonly heading: Heading
	/** The instant fields its insert's rows leave out, each with what stamps it (write/frontend/instants.ts stampsOf);
	 * none for a put or a delete, which state every one, or an insert that states them all. */
	readonly stamps: ReadonlyArray<Stamped>
	/** What the action writes: its relation whole, or a role's query entry, whose fill its source reads through and whose
	 * membership its additions are prechecked against. */
	readonly entry: Via
	/** What its facts are held to beside its relation's laws and its entry's membership: the role's claims or nothing. */
	readonly claims: ClaimsCheck
}

/** How a role reaches a relation, a write writing it or a delta reading it: whole, or through the query entry the role
 * writes it by. */
export type Via =
	| { readonly kind: "whole" }
	| { readonly kind: "entry"; readonly entry: CheckedEntry }

/**
 * What a write is held to beside its relation's laws, whole or through a query entry alike: nothing; or, on a role whose
 * claims bind a unit the relation is a member of (schema/scope.ts), the claims: each fact it states prechecked against
 * the relation's claims membership (analysis/schema.ts ClaimsMembership), a fact outside the units the claims bind
 * outsideWorld under `entry`, the name the role writes the relation by, its query entry's or its own
 * (write/frontend/entry.ts claimsKeyOf), before the write, which is otherwise its relation's write, its families,
 * nestings and stamps drawn as any write's. Its laws hold over every row: a key a row outside the world holds refuses it
 * on that key.
 */
export type ClaimsCheck =
	| { readonly kind: "none" }
	| {
			readonly kind: "claimed"
			readonly membership: ClaimsMembership
			readonly entry: EntryName
	  }

const noCheck: ClaimsCheck = Object.freeze({ kind: "none" })

/** A relation read or written whole. */
const wholeVia: Via = Object.freeze({ kind: "whole" })

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

/** A family statement's source with the node it names read through `at`. */
const familySourceIn = (source: FamilySource, at: Counterpart): FamilySource =>
	source.kind === "described" ? Object.freeze({ kind: "described", node: at(source.node) }) : source

/** A family statement's place with each described source of a unit delete it reads read through `at`. */
const familyAtIn = (placed: FamilyAt, at: Counterpart): FamilyAt =>
	placed.node.kind === "unit"
		? Object.freeze({
				...placed,
				node: Object.freeze({
					kind: "unit",
					below: placed.node.below,
					units: mapNonEmpty(placed.node.units, (u): UnitDelete =>
						Object.freeze({ ...u, source: familySourceIn(u.source, at) })
					)
				})
			})
		: placed

/** A family statement's precheck with the described source it reads read through `at`. */
const memberCheckIn = (check: MemberCheck, at: Counterpart): MemberCheck =>
	Object.freeze({ ...check, source: familySourceIn(check.source, at) })

/** The write's queries before its DAG is analyzed: the strata, each with its refused additions, and the read-backs over
 * the nodes the frontend built, read in each form of the DAG through that form's counterparts (queriesIn). */
interface Drafted {
	readonly strata: ReadonlyArray<WriteStratum>
	readonly reads: ReadonlyArray<ReadBack>
	readonly params: ReadonlyArray<ParamId>
	readonly bound: ReadonlyArray<BoundInput>
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
						checks: Object.freeze(stratum.checks.map((c) => memberCheckIn(c, at))),
						family: Object.freeze(stratum.family.map((f) => familyAtIn(f, at)))
					})
				)
			),
			reads: Object.freeze(drafted.reads.map((r) => Object.freeze({ ...r, node: at(r.node) }))),
			params: drafted.params,
			bound: Object.freeze(drafted.bound.map((b) => Object.freeze({ ...b, node: at(b.node) })))
		})
	})

/**
 * The evidence a write's statements are read under, in its transaction: an immediate fact holds at every statement and
 * a deferred law only at COMMIT, so the laws' immediate containments alone; and a derived or world relation a member or
 * read-back matches is keyed by its definition's keys. Its frontend's analyses and its read-backs' lowering read it.
 */
export const transactionEvidence = (laws: LawModel): LogicalEnv => ({
	context: "transaction",
	containments: immediateEvidence(laws.theory.evidence).containments,
	keyedViews: true
})

/**
 * The queries `drafted` names over a write's analyzed DAG, each attachment judged at the delivered type the analysis
 * restated it to (rel.ts Attach judged), which the read-backs' reader delivers, each node the frontend built read as its
 * annotated counterpart, and that DAG. The DAG served (ir/derived.ts servedDag) and its analysis are made here and are
 * this function's alone, in no frame or scope of its caller's, so they are unreachable once the queries are read,
 * before the restatement analyzes the DAG again (made by the caller and passed in, each stayed in the caller's frame as
 * long as the compile ran): a write's compile holds one analysis at a time, where the first, held by the compile's own
 * scope, lived beside the second, each every node's properties (a write of edullm's endTest, 35K nodes, held two of
 * 540 MB each), and the served DAG's folds, every node of the write's, lived to the compile's end. `held` holds the
 * served DAG to the served rule before its analysis (analysis/derived/served.ts servedDerivations).
 */
const analyzedQueries = (
	drafted: Drafted,
	written: ValidDag,
	rows: DerivedRows,
	analyzed: (structure: ValidDag) => LogicalAnalysis,
	held: (served: ValidDag) => void
): { readonly dag: ValidDag; readonly queries: WriteQueries } => {
	const structural = servedDag(written, rows)
	held(structural.dag)
	const analysis = analyzed(structural.dag)
	const judged = judgedAsDelivered(analysis.dag)
	return {
		dag: judged.dag,
		queries: queriesIn(drafted, judged.dag, (node) =>
			judged.of(analysis.of(structural.of(node)).node)
		)
	}
}

/** A write's DAG restated (restatedRoots): the DAG, and each node the write names at its place there. */
interface Restated {
	readonly dag: ValidDag
	readonly at: ReadonlyMap<RelNode, RelNode>
}

/** The queries over another form of the write DAG, and the node standing there in the place of each node they name. */
interface Restatement {
	readonly restated: WriteQueries
	readonly restate: ReadonlyMap<RelNode, RelNode>
}

/**
 * The queries `named` names over another form of the write DAG (queriesIn), with each node read through `at` once and
 * its answer kept as data: the frontend a compiled write holds for as long as it lives then holds the restated form's
 * nodes alone, where a Counterpart closed over the restatement's analyses held every node's logical properties, its
 * functional dependencies and their bitsets, twice over, past the compile that read them.
 */
const restatedIn = (named: Drafted, dag: ValidDag, at: Counterpart): Restatement => {
	const restate = new Map<RelNode, RelNode>()
	const restated = queriesIn(named, dag, (node) => {
		const there = at(node)
		restate.set(node, there)
		return there
	})
	return { restated, restate }
}

/**
 * The producers of a write's opaque leaves (lower/optimize/propagate Producers), each node read through `at` in the DAG
 * the write's optimized artifact lowers: the sources of each relation's delta.added, its insert and put actions'
 * described sources, none for a relation one action fills from a slot. A relation a family's statements write has no
 * delta a read-back names, but a stamped nesting's plain root, whose rows its insert's source holds, every field but the
 * stamped ones, which no source holds.
 */
const writeProducers = (strata: ReadonlyArray<WriteStratum>, at: Counterpart): Producers => {
	const sources = new Map<string, Array<RelNode>>()
	const opaque = new Set<string>()
	for (const stratum of strata) {
		for (const action of stratum.actions) {
			if (action.op === "delete") {
				continue
			}
			if (action.source.kind === "described") {
				sources.getOrInsertComputed(action.relation, () => []).push(at(action.source.node))
			} else {
				opaque.add(action.relation)
			}
		}
	}
	return { added: new Map([...sources].filter(([relation]) => !opaque.has(relation))) }
}

/** An addition into a query entry whose fixed fields read a context the Db holds no fact of: every fact its sources hold
 * is outside the world, so its refusal is raised when they hold any row, at the start of its stratum, where its
 * sources are evaluated. `entry` names the entry; `reads` is its enumerated slot, its described
 * sources' union, or both as one union, each delivering the entry's facts. */
export interface OutsideWrite {
	readonly entry: EntryName
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

/**
 * The facts of a relation a claims-held write writes (ClaimsCheck `claimed`) that no action of their stratum writes, read
 * off their source: a managed member's insert, put or delete, a stamped nesting's root, each off its slot, or a unit
 * delete's units, off its slot or its described source, each of which its family statement writes. Its precheck is its
 * family statement's, before the first of the stratum's that writes its relation (schedule/plan.ts familyStepsOf), as an
 * action's is before its first statement.
 */
export interface MemberCheck {
	readonly relation: WrittenRelation
	readonly source: FamilySource
	readonly check: Extract<ClaimsCheck, { readonly kind: "claimed" }>
}

/** A stratum of a write: its actions, each carrying its information, the additions it refuses outright
 * (OutsideWrite), and the prechecks of the facts only its family statements write (MemberCheck). */
export interface WriteStratum extends Stratum<ActionInfo> {
	readonly outside: ReadonlyArray<OutsideWrite>
	readonly checks: ReadonlyArray<MemberCheck>
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
	 * stated with its correlation explicit, analyzed in the same transaction context, then its constant columns read
	 * through (lower/optimize/propagate), every node under its own label. */
	readonly restated: WriteQueries
	/**
	 * The node of `restated.ir.dag` standing in the place of each node of `ir.dag` the write names, as data: the nodes
	 * alone, never the restatement's analyses they were read from (`restatedIn`).
	 */
	readonly restate: ReadonlyMap<RelNode, RelNode>
	/** The ChangeSet's Description as planned: each field-equality member made the query it is (write/frontend/equal.ts). */
	readonly desc: PlannedChangeSetDesc
	readonly schema: CheckedSchema
	readonly laws: LawModel
	/** What its derived relations prove, their inherited keys with their views' unique indexes and their drawn
	 * containments: with the laws, what the write's placement and read-backs resolve evidence through
	 * (`evidenceCatalog`). */
	readonly views: ViewEvidence
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
	/** Each stratum's edits of a family's member relation: its slots of inserted, put and deleted rows, which no action
	 * of its own writes, its family statements writing them (write/family/additions.ts, removals.ts). */
	readonly edits: ReadonlyArray<StratumEdit>
	/** Each stratum's fresh fill as the host leaves it to its statements (`FreshFill`), by stratum. */
	readonly fresh: ReadonlyMap<StratumAt, FreshFill>
	/** Each stratum's refills (write/frontend/refill.ts), by its position among the occupied strata, as `edits` holds it. */
	readonly refills: ReadonlyArray<{ readonly stratum: StratumAt; readonly refill: StratumRefill }>
	/** The relations whose deltas the read-backs name, in code point order. */
	readonly deltas: ReadonlyArray<NamedDelta>
	readonly references: ReadonlyArray<ImmediateReference>
	/** The query entries whose deltas a read-back names as their targets' projected, by name (see deltaOf). */
	readonly deltaEntries: ReadonlyMap<string, CheckedEntry>
	/** The installation's codes, which binding encodes the declared parameters' closed ids and sets by. */
	readonly codes: Codebook
	/** The host's evaluation of generated fields, as PostgreSQL generates them, which a nested write's fill reads
	 * (runtime/write/keys.ts FillContext). */
	readonly evaluate: HostEvaluator
	/** Each writing stratum's computed records (ir/instant.ts Computed), each with the relation whose host rows leave its
	 * fields out, which the call computes (`strataComputed`). */
	readonly computed: ReadonlyArray<{
		readonly stratum: StratumAt
		readonly relation: string
		readonly record: Computed
	}>
}

/** A tree's root fields, whose values name each of its trees: a tree's delete states them. */
const rootFieldsOf = (shape: TreeShape): NonEmptyReadonlyArray<LawField> => shape.root

const refuse = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/**
 * Whether a fact determines a field's value: one its caller or its sequence writes (isCarried), one PostgreSQL
 * generates from them, which the statement that writes the fact computes as PostgreSQL stores it, an instant, which
 * a put's or a delete's facts state from a stored one, a query's term, and whose every other writing is refused
 * (write/frontend/instants.ts stampsOf), or a place, whose relation no put or delete writes, which stampsOf refuses.
 * A field grizzle draws or accumulates is no fact's.
 */
const determined = (field: LawField): boolean =>
	isCarried(field) ||
	generationOf(field) !== undefined ||
	field.writing.kind === "instant" ||
	field.writing.kind === "place"

/**
 * A put or a delete of `relation`, `member`, refused (UnstatedKey) where a key it reads off its facts holds a field no
 * fact determines (`determined`): its primary key, by which a put names each row and a family's edit each member, and,
 * for a put, every key its same-key checks compare, the primary key's first. A key holding a field grizzle writes, such
 * as a sequence's index, is stated by no fact; one holding a generated field is compared by the statement that writes
 * the facts, at the field's generation expression over each. A delete compares no key before it is sent, so only its
 * primary key is read; an insert names no row by its key, a sequence's members being inserted nested under their owner,
 * whose nesting draws their index.
 */
const refuseUnstatedKey = (member: FactsMemberDesc, relation: WrittenRelation): void => {
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

/** The parameter a write's member slot binds, spelled by the one slot rule (slots.ts reservedSlot) at its stratum's
 * index among the ChangeSet's strata, empty ones included, as the ChangeSet value names its members' arrays.
 * `relation` is the member's own: an ordinary relation, or a query entry's facts. */
const writeSlotId = (stratum: number, act: ActionOp, relation: string): ParamId =>
	ParamId(reservedSlot(stratum, act.op, relation))

/**
 * Refuses delta.met of `name` where no statement tells a stored fact an insertion met from one it made: a relation
 * whose primary key holds a span, whose exclusion constraint arbitrates by ON CONFLICT DO NOTHING ON CONSTRAINT alone,
 * and a family's member relation, whose additions its family statement writes (`managed`).
 */
const refuseUnmet = (
	relation: RelationInfo,
	loc: SourceLoc,
	managed: (name: string) => boolean
): void => {
	if (managed(relation.name)) {
		throw new Refusal(
			ruleRefused(
				loc,
				"delta.met names no family's members: their additions are their family statement's, which meets no stored fact at an arbiter key"
			)
		)
	}
	if (primaryKeyShape(relation).kind === "span") {
		refuse(
			"UnsupportedOperation",
			loc,
			`a delta.met of ${relation.name}, whose primary key holds a range: its exclusion constraint arbitrates by ON CONFLICT DO NOTHING ON CONSTRAINT alone, so no statement tells a fact an insertion met from one it made`
		)
	}
}

/** The sides the read-backs name of one delta, each once. */
const sidesOf = (named: ReadonlyArray<{ readonly side: DeltaSide }>): NamedDelta["sides"] =>
	new Set(named.map((d) => d.side))

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
 * The heading a slot's members state of `heading`, its key heads (ir/law.ts keyHeads): each column but a key generation
 * (FieldWriting keyGenerated), which no member states and the host fills from its reads before the slot is encoded
 * (write/normalize), then each key generation's reads not already among them, at their columns in `facts`, the fields a
 * member of `relation` states: a tree's units named by root fields holding one state its reads. A slot written whole
 * alone: its columns are `relation`'s fields by name. A query entry's columns are its head's fields, named as the
 * entry names them, and an entry writes no relation whose key holds a key generation (WritabilityReason
 * keyHoldsGeneration), so its members state its slot's heading as it is.
 */
const keyHeading = (relation: RelationInfo, heading: Heading, facts: Heading): Heading =>
	keyHeads(
		relation,
		heading.flatMap((c) => relation.fields.filter((f) => f.name === c.name))
	).flatMap((f) => [...heading, ...facts].filter((c) => c.name === f.name).slice(0, 1))

/**
 * The heading a member relation's additions carry: each field its caller writes, never one PostgreSQL generates, which
 * is never written, so no INSERT or UPDATE lists its column (check/member.ts memberWrites, types/changeset
 * UnwrittenFieldsOf); and each key generation (ir/law.ts FieldWriting keyGenerated), which no member writes and the
 * host fills from its reads before the slot is encoded (write/normalize), so every statement over the slot reads the
 * fact's whole key.
 */
const carriedOf = (member: MemberRelation): Heading =>
	member.heading
		.filter((c) => c.writing.kind === "caller" || c.writing.kind === "keyGenerated")
		.map(carriedColumn)

/** What a member writes: its relation whole; or a query entry, its target its relation, `member` the entry's facts its
 * source carries, and whether the Db holds a fact of every context its fixed fields read. */
type MemberEntry =
	| { readonly kind: "whole" }
	| {
			readonly kind: "entry"
			readonly entry: CheckedEntry
			readonly member: MemberRelation
			readonly fillable: boolean
	  }

/**
 * A target as its members write it: its relation, whole or through a query entry, and the heading its facts carry.
 * targetOf decides it from the relation's name alone, so every member of one relation holds the one target, and its
 * heading heads every operation's slot of the relation, a delete's, a put's and an insert's alike. A nested insert's
 * heading is its nesting's (Nesting.top), so it heads no other operation's slot.
 */
interface CheckedTarget {
	readonly relation: WrittenRelation
	readonly entry: MemberEntry
	readonly claims: ClaimsCheck
	readonly carried: Heading
}

/**
 * A stratum's member, checked: its operation, its target, and its source, an array or Stream member slot, or a query
 * with its root in the write DAG, whose head is the member relation's. Its target is its relation's, whole, as targetOf
 * decides it for every member of the relation: a member holds no heading or class of its own, so no member's statement
 * can set the heading another operation's slot of its relation is admitted and carried under.
 */
interface CheckedMember {
	readonly op: WriteOp
	readonly target: CheckedTarget
	readonly loc: SourceLoc
	/** What its delete removes of its relation's place groups (write/frontend/instants.ts Removal). */
	readonly removes: Removal
	/** Its Description as the planner reads it: a field-equality member's its query's. */
	readonly planned: PlannedMemberDesc
	readonly source:
		| {
				readonly kind: "enumerated"
				readonly member: Extract<FactsMemberDesc["member"], { readonly kind: "array" | "stream" }>
		  }
		| {
				readonly kind: "described"
				/** Its checked query's root in the write DAG, where the merge renamed it: the member's own checked DAG, which
				 * no reader past the merge reads, is not held, so the compile holds the write DAG and no member's DAG beside
				 * it. */
				readonly root: RelNode
		  }
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
	/** What its facts are held to beside its relation's laws: its target's claims (CheckedTarget). */
	readonly claims: ClaimsCheck
	/** What its delete removes of its relation's place groups: every member's, `groups` only where each removes whole
	 * groups (write/frontend/instants.ts Removal). */
	readonly removes: Removal
	/** The fields its host rows leave out that the call computes, each filled by the call's value (ir/instant.ts Stamp
	 * `call`); none for a described member's rows, which state every field. */
	readonly computed: ReadonlyArray<Stamped>
	/** Where its first member stands, which a refusal of how it writes an instant names. */
	readonly loc: SourceLoc
}

/** A stratum's delete of a unit root's units before its source is built: its relation, the heading its facts carry, its
 * enumerated slot, its described members' roots, and where the first of its members stands. */
interface UnitDraft {
	readonly relation: WrittenRelation
	readonly heading: Heading
	readonly slot: MemberSlot | undefined
	readonly roots: ReadonlyArray<RelNode>
	/** What its units are held to beside its relation's laws: its target's claims (CheckedTarget). */
	readonly claims: ClaimsCheck
	/** What it removes of its relation's place groups (write/frontend/instants.ts Removal). */
	readonly removes: Removal
	readonly loc: SourceLoc
}

/** A refused addition before its source is built (OutsideWrite), its sources' facts carrying `carried`. */
interface OutsideDraft {
	readonly entry: EntryName
	readonly carried: Heading
	readonly reads: DraftReads
}

/**
 * The columns a row of `relation` holds `column` by, by key: a law column by itself, and a field by itself or, generated,
 * by the written fields its generation reads, transitively, over which a statement evaluates it (write/family/scan.ts
 * scannedValue).
 */
const heldBy = (relation: RelationInfo, column: NativeColumn): ReadonlyArray<ColumnKey> =>
	column.kind === "law"
		? [columnKey(column)]
		: withGenerationInputs(relation, [column.field]).flatMap((f) =>
				f.writing.kind === "generated" ? [] : [columnKeyOf(f.name)]
			)

/**
 * The sentence of a refused write that changes the family `family` of an immutable owner: `head` names the write and
 * its member relation, and `effect` the owner it changes, where the write appends to one.
 */
const fixedSentence = (head: string, family: Family, effect: string | undefined): string =>
	`${head}, a member of the family ${family.id.owner}.${family.id.count} of the immutable ${family.owner.name}${effect === undefined ? "" : `, ${effect}`}: an immutable owner's family is fixed when its owner is inserted; declare mutable(${family.owner.name}) to change it`

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
			return { relation: node.members[0], op: "insert" }
		case "nothing":
			return { relation: node.owners[0].relation, op: "count" }
	}
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
 * The schema or fragment a ChangeSet was built over is a level of the schema it compiles against by content, whatever
 * name places either (`isLevelOf`): db.apply and db.compile check it before they compile (`levelSchema`), and a
 * workload checks it when it is built. The Description names no schema, so nothing compares a name with the one the
 * compiled schema is installed under.
 *
 * 1. Check. Each member's relation is resolved once by name. Compiled for a role, it must be in the role's write list,
 *    which the types already require of db.apply (a description that breaks it is OutsideRole): a whole entry writes
 *    its ordinary relation of the base, and a query entry its writable entry's target; an insert also writes every
 *    sequence member its nesting reaches, whose rows a role holds nothing of unless its write list names it. Compiled
 *    for reality (a workload), it must be an ordinary relation (a closed or derived relation, which no ChangeSet writes, is
 *    MalformedDescription at the member). Each described member is checked as a query whose head is written into that
 *    relation, or into the entry's heading (checkMember: DescribedHeadingMismatch), and each read-back as a query over the post-change state that may read the delta sources of
 *    every ordinary relation (checkReadBack); both read the role's relations, which reach nothing else. The parameters
 *    of every member and read-back are one namespace, which the Description's decoder has checked holds every name
 *    ChangeSet.bind closed and no name of a member slot: a name declared twice must be declared alike,
 *    which the checked types of its declarations decide.
 * 2. Group. Within a stratum, the enumerated members (arrays and Streams) of one operation on one relation are one
 *    enumerated input (`EnumeratedInput`), the facts the host normalizes (normalize/): one slot read by one action.
 *    A slot whose facts carry no field is the unit relation, read like any other input. Every source of one operation
 *    on one relation in one stratum whose rows are written at one heading is one action, the slot's and the described
 *    members' alike: a stratum's meaning is S' = (S \ D) ∪ A, its members' parallel composition, which reads no member
 *    beside another, so the members of one operation are the one operation of their union. Several sources are one
 *    described source, the Union of their queries and of the enumerated slot's InputSet, read as a set of facts
 *    (insert/input.ts factSet), so a fact two of them give is one, and whose same-key check in the statement refuses
 *    two facts of one key, which raise the primary key's law as a conflict witness between two actions would. For a
 *    put it is the meaning itself: a put is the described deletion of the occupants at its members' keys, evaluated
 *    against the state before the stratum, plus their insertion, and two separate statements would let the second
 *    deletion remove the first's new fact, so two puts of one key with different payloads would replace instead of
 *    conflicting. For an insert and a delete it keeps the stratum's writes one action per relation and operation, so a
 *    stratum one snapshot suffices for is one statement (write/schedule/plan.ts realizationOf), which stamps each clock
 *    once (write/frontend/instants.ts refuseStampedStatements) and makes each side of the relation's delta a read-back
 *    reads whole. A whole relation's member is written at the fields it delivers, its caller's and the instants it
 *    states from stored ones, a query entry's at the entry's facts, which its fill reads every source at; the slot's
 *    rows at its relation's caller's fields, but that an insert's leave out the fields the call computes, which its
 *    statement fills (`computedStamps`), and an owner's insert, or put beside no query, carries the counts and ends the
 *    host draws into them (runtime/write/bind.ts freshOwners). A source written at another heading is another action of the operation, since one action's rows are
 *    stamped and filled alike: an insert's host rows that leave computed fields out or carry an owner's counts, beside a
 *    query's, which state the one and leave the other to the statement, and an insert's query stating a reference from
 *    a stored instant beside one leaving it to be stamped; a put's or a delete's, which states every instant, never
 *    compiles beside another (`stampsOf` refuses the one that leaves an instant out). Actions of two operations on one
 *    relation stay two, in the schedule's order, removals before additions (`scheduleStratum`): an insert and a put or
 *    a delete of one key, or a put and a delete, meet at the relation's immediate keys statement by statement, and
 *    PostgreSQL runs sibling data-modifying CTEs of one table in no order.
 *    A query entry's action reads its sources through the entry's fill, one fill per action over
 *    the union of its sources, so it writes the target's facts. An addition into an entry whose fixed fields read a
 *    context the Db holds no fact of is no action but a refusal of its sources (WriteStratum.outside), and a deletion
 *    there is dropped.
 * 3. Lowering. The statement that realizes an action is the lowering's, a put's chosen with the proofs the whole
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

/** The relation of the base a member written into `relation` writes: itself in reality, its role's write list's
 * target in a role; none for a name the role's write list leaves out, which the member's own target refuses. */
const baseWritten = (world: CheckedSchema["world"], relation: string): ReadonlyArray<string> => {
	if (world.kind === "reality") {
		return [relation]
	}
	const write = world.writes.get(relation)
	if (write === undefined) {
		return []
	}
	switch (write.kind) {
		case "whole":
			return [write.relation.name]
		case "rows":
			return [write.writable.target.name]
	}
}

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
	/** The columns of each query the ChangeSet's members import, each checked once however many members navigate it. */
	const columns = queryColumns(checked, at)
	const { laws, derived, codes, clock } = options
	const views = derivedEvidence(derived, laws.existence)
	const existingKeysProof = existingKeysProofOver({ laws, views })
	/** The base every written relation is an ordinary relation of: reality's own, or the role's base. */
	const base = checked.definitions()
	/** Each relation of the base the ChangeSet writes: each member's, through its role's write list where it runs on one,
	 * and each relation a write of those writes in turn (schema/reach.ts writesOf). */
	const writtenRelations = writesOf(
		checked.owned,
		desc.strata.flatMap((stratum) =>
			stratum.members.flatMap((m) => baseWritten(checked.world, m.relation))
		)
	)

	/** 1. Check the members and read-backs, merging their queries into one DAG in that order, every check one session's
	 * (check/session.ts), so every closed import of one key, in any of them, is one node of the DAG. */
	const session = CheckSession.own()
	/** Its members' navigation, each query they read navigated once for the ChangeSet (analysis/theory/navigate.ts). */
	const navigation = new Navigation(laws.theory.regionFacts)
	const merger = new QueryMerger(session)
	const params = new Map<string, ParamDecl>()
	/** Each stratum's write members of facts, its inserts' computed fields aside (`strataComputed`). */
	const strataWrites = desc.strata.map((stratum) =>
		stratum.members.flatMap((m): ReadonlyArray<FactsMemberDesc> =>
			m.member.kind === "computed"
				? []
				: [{ op: m.op, relation: m.relation, member: m.member, loc: m.loc }]
		)
	)
	/** The strata that write, each by its position among them, the stratum its statements run in, with its place among
	 * the ChangeSet's strata: a stratum that writes nothing changes no state and runs no statement. */
	const occupiedStrata = strataAt(
		strataWrites.flatMap((members, s) => (members.length > 0 ? [s] : []))
	)
	/** The state before the ChangeSet's stratum `s`, by the writing strata before it: the state the stratum's members
	 * read, the one before the occupied stratum at that position, or after the last where none is at or after `s`. */
	const stateBefore = (s: number): number => occupiedStrata.filter(([, place]) => place < s).length
	/**
	 * 0. The call's bound rows (ChangeSetDesc `boundRows`): each relation parameter ChangeSet.bind closed with a query is
	 * one input of the call, its rows in the state before the first stratum of the part it was bound on (BoundRowsDesc
	 * `stratum`, ir/write.ts BoundInput). Its readers are the members that read it, each in the state before its own
	 * stratum, the read-backs, in the state after the last, and the inputs whose rows read it, each in the state it is
	 * evaluated in. One whose every reader reads a state that agrees with the one it is evaluated in on everything its
	 * rows read (`agrees`) reads the same rows in its own state, so it is a part of their queries, as any import of a
	 * query is (`inlined`): metis's assign binds its target test to a read of the catalog the assign never writes, so the
	 * stratum after the first and the read-backs read the catalog themselves, keyed by the call's test. Any other is
	 * carried (`later`): checked once, after the carried inputs its own rows read,
	 * its query a root of the write DAG evaluated right before the statements of the first stratum at or after its own
	 * that writes (write/schedule/plan.ts), every reader's use of it read as its InputSet (CheckSession `bound`). Its
	 * query's own parameters join the ChangeSet's.
	 */
	const readerStates = (name: string): ReadonlyArray<number> => [
		...desc.strata.flatMap((stratum, s) =>
			stratum.members.some((m) => memberParamNames(m.member).has(name)) ? [stateBefore(s)] : []
		),
		...desc.reads.flatMap((r) =>
			queryParamNames(r.query).has(name) ? [stateBefore(desc.strata.length)] : []
		),
		...Object.values(desc.boundRows).flatMap((other) =>
			rowsParamNames(other.rows).has(name) ? [stateBefore(other.stratum)] : []
		)
	]
	/** The relations each writing stratum writes, by its place among them (`occupiedStrata`), closed under what a write
	 * of one writes of another (schema/reach.ts writesOf). */
	const occupiedWrites = occupiedStrata.map(([, place]) =>
		writesOf(
			checked.owned,
			defined(strataWrites[place], "a writing stratum's members").flatMap((m) =>
				baseWritten(checked.world, m.relation)
			)
		)
	)
	/** The relations of the base whose facts a binding's rows depend on (schema/reach.ts readsThrough): what its query
	 * reads, at any depth of its imports, and what each binding its rows read depends on in turn. */
	const footprints = new Map<string, ReadonlySet<string>>()
	const footprintOf = (name: string): ReadonlySet<string> => {
		const known = footprints.get(name)
		if (known !== undefined) {
			return known
		}
		const { rows } = defined(desc.boundRows[name], "a binding of the ChangeSet's bound rows")
		const uses = queryUses(boundRowsQuery(name, rows, boundRowsLoc(name)))
		const own = readsThrough(
			checked.owned,
			checked.world.kind === "role" ? checked.world.role : undefined,
			[...uses.relations, ...uses.deltas]
		)
		const footprint = new Set([
			...own,
			...[...rowsParamNames(rows)].flatMap((read) =>
				desc.boundRows[read] === undefined ? [] : [...footprintOf(read)]
			)
		])
		footprints.set(name, footprint)
		return footprint
	}
	/** Whether a binding evaluated in the state `from` reads the same rows in the state `to`, a later one: no stratum
	 * between them writes a relation its rows depend on. */
	const agrees = (name: string, from: number, to: number): boolean => {
		const footprint = footprintOf(name)
		return occupiedWrites
			.slice(from, to)
			.every((written) => ![...footprint].some((relation) => written.has(relation)))
	}
	const later = new Set(
		Object.entries(desc.boundRows).flatMap(([name, { stratum }]) =>
			readerStates(name).every((state) => agrees(name, stateBefore(stratum), state)) ? [] : [name]
		)
	)
	const inlined = new Map(
		Object.entries(desc.boundRows).flatMap(([name, { rows }]) =>
			later.has(name) ? [] : [[name, rows] as const]
		)
	)
	/** The identity query of each relation parameter source an inlined binding reads (bindRelationParams), one for
	 * every source of one identity, so the members that read one binding read one import of it, one node of the DAG. */
	const identities = new Map<IdentityDigest, QueryDesc>()
	const identity = (source: RelationParamSourceDesc): QueryDesc => {
		const key = unwrap(descIdentity(source))
		const known = identities.get(key)
		if (known !== undefined) {
			return known
		}
		const loc = boundRowsLoc(source.name)
		const typedBy = source.kind === "paramOf" ? checked.relation(source.relation, loc) : undefined
		const fields =
			source.kind === "param"
				? Object.keys(source.heading)
				: typedBy?.kind === "relation"
					? headingColumns(typedBy.heading).map((c) => c.name)
					: []
		if (!isNonEmpty(fields)) {
			return refuse(
				"MalformedDescription",
				loc,
				`relation parameter ${source.name} over a heading of at least one field`
			)
		}
		const query = unwrap(decodeDesc("query", identityQuery(source, fields, loc)))
		identities.set(key, query)
		return query
	}
	/**
	 * A query evaluated in some state, a member's, a read-back's or an input's, with each inlined binding it reads a part
	 * of it, every reader of an inlined binding reading the state it is evaluated in, and each inlined binding its rows
	 * read in turn: the rows a binding writes in are its own namespace's
	 * and are not bound again by the pass that writes them (ir/desc.ts RelationBinding), so each pass binds what the one
	 * before it wrote, until none reads an inlined binding, a pass for each binding at most.
	 */
	const inlinedIn = (query: QueryDesc): QueryDesc => {
		let bound = query
		for (let pass = 0; pass <= inlined.size; pass += 1) {
			const used = queryParamNames(bound)
			if (![...inlined.keys()].some((name) => used.has(name))) {
				return bound
			}
			bound = bindRelationParams(bound, inlined, identity)
		}
		defect("a binding's rows that read it again, which ChangeSet.bind admits none of")
	}
	const boundInputs: Array<BoundInput> = []
	const carrying = new Set<string>()
	/** The input `name` carried (`later`), after each carried input its rows read. */
	const carry = (name: string): void => {
		if (carrying.has(name)) {
			return
		}
		carrying.add(name)
		const { stratum, rows } = defined(
			desc.boundRows[name],
			"a binding of the ChangeSet's bound rows"
		)
		for (const read of rowsParamNames(rows)) {
			if (later.has(read)) {
				carry(read)
			}
		}
		const loc = boundRowsLoc(name)
		const query = unwrap(
			checkRelation(
				checked,
				navigateQuery(
					inlinedIn(boundRowsQuery(name, rows, loc)),
					loc,
					columns,
					{ kind: "perRead" },
					navigation
				),
				{ label: `bind ${name}`, clock, session }
			)
		)
		for (const p of query.params) {
			merge(params, p, loc)
		}
		const node = merger.add(query)
		session.bound.set(name, node.heading)
		/** Some reader reads another state than the one the input is evaluated in, so that state is before a stratum
		 * that writes: a read-back's alone, after the last, has every reader in it. */
		const [before] = defined(
			occupiedStrata[stateBefore(stratum)],
			"a writing stratum at or after a carried input's"
		)
		boundInputs.push(Object.freeze({ param: ParamId(name), stratum: before, node }))
	}
	for (const name of later) {
		carry(name)
	}
	/** Each ordinary relation of the base the ChangeSet writes, as a member writes it (`writtenOf`), built where the
	 * compile first reads it, so a compile reads of the base only the relations its ChangeSet writes. */
	const writable = new Map<string, WrittenRelation>()
	/** An ordinary relation of the base as a member writes it: its declared keys with their laws, its unique objects and
	 * its host checks. */
	const writtenOf = (name: string, loc: SourceLoc): WrittenRelation => {
		const known = writable.get(name)
		if (known !== undefined) {
			return known
		}
		const written =
			laws.relations.get(name) ??
			refuse("MalformedDescription", loc, `an ordinary relation of the schema, not ${name}`)
		const uniques = relationUniques(written)
		const keyLaws = Object.freeze(
			mapNonEmpty(uniques.keys, (u): KeyLaw =>
				Object.freeze({ fields: keyWitness(u), law: u.law, described: u.described })
			)
		)
		const made: WrittenRelation = Object.freeze({
			...written.relation,
			keyLaws,
			uniques,
			host: hostChecks(keyLaws, uniques, [])
		})
		writable.set(name, made)
		return made
	}
	/** The same-key checks a nesting's rows of `relation` are judged by: its keys at the fields they hold of rows that
	 * leave out the fields its stamps fill (write/family/nesting.ts Nesting `stamps`), so a key over a stamp holds its
	 * rows at its child, which the call's rows agreeing there share; the relation's own where none is stamped. */
	const stampedChecksOf = (relation: WrittenRelation, nesting: Nesting): HostChecks =>
		hostChecks(relation.keyLaws, relation.uniques, nesting.stamps.get(relation.name) ?? [])
	/** The same-key checks a group's facts of `relation` are judged by: its nested insert's (`stampedChecksOf`), whose
	 * stamps fill the fields every row of its relation leaves out, the group's one insert; where its insert computes
	 * fields its host rows leave out, `computed` (`computedStamps`), each key over one compared for its puts and its
	 * inserted facts apart (write/normalize/normalize.ts computedChecks); the relation's own otherwise. */
	const groupHost = (
		relation: WrittenRelation,
		inputs: ReadonlyArray<EnumeratedInput>,
		computed: ReadonlyArray<Stamped>
	): HostChecks => {
		const nested = inputs.find((input) => input.kind === "nested")
		if (nested !== undefined) {
			return stampedChecksOf(relation, nested.nesting)
		}
		return computed.length === 0
			? relation.host
			: computedChecks(relation.keyLaws, relation.uniques, computed)
	}
	/** The schema's families: a nested insert reaches some of them (write/family/nesting.ts). */
	const families = laws.families

	/** The host's evaluation of the generated fields a nesting's copies, steps and selections read, over the schema's
	 * closed relations, as PostgreSQL generates them, by the law model's compiled patterns. */
	const evaluate = hostEvaluator(closedLeaf(closedIndexOf(closedTableOf(checked))), laws.patterns)
	const nestings = new Map<string, Nesting>()
	/** The nesting of an insert into `relation` in the `s`-th stratum, built once for each record of computed fields it
	 * takes: its rows leave out every instant and place, as a nested fact states none, which its stamps fill or which are
	 * refused (write/frontend/instants.ts stampsOf), and every field the stratum's insert computes, which the call's value
	 * fills (`computedStamps`), its one family statement filling them all (write/family/nesting.ts Nesting `stamps`). */
	const nestingFor = (relation: RelationInfo, s: number): Nesting => {
		const computed = computedStamps(s, relation.name)
		const cached = computed.length === 0 ? relation.name : `${relation.name}\u0000${s}`
		const known = nestings.get(cached)
		if (known !== undefined) {
			return known
		}
		const built = unwrap(
			nestingOf(
				relation,
				laws.theory.fill,
				stampsOf(
					laws.theory.instants,
					relation,
					"insert",
					"rows",
					relation.fields
						.filter(
							(f) =>
								f.writing.kind !== "instant" &&
								f.writing.kind !== "place" &&
								!computed.some((c) => c.field.name === f.name)
						)
						.map((f) => ({ name: f.name, type: f.type })),
					{ kind: "family" },
					relation.loc,
					computed
				),
				relation.loc
			)
		)
		nestings.set(cached, built)
		return built
	}
	/** The sequence `name` is a member of, a tree's aside: its members are written only under their owner. */
	const sequenceOf = (name: string) =>
		memberFamilies(name, families).find((f) => isSequence(f) && !isTreeOf(f, name))
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
	/**
	 * The relations a member of a stratum may add rows of: an insert's every relation it writes rows of (`insertedBy`), a
	 * nested counted member among them, which its nesting appends to its counted families as its own insert would; a
	 * put's own, which inserts a row its key finds none at; a delete's none.
	 */
	const addedBy = (member: FactsMemberDesc): ReadonlySet<string> => {
		switch (member.op) {
			case "insert":
				return insertedBy(member.relation)
			case "put":
				return new Set([member.relation])
			case "delete":
				return new Set()
		}
	}
	/** Whether `name` is a member of a family: its rows' drawn values are its family statements' (write/family/
	 * additions.ts, removals.ts). */
	const managed = (name: string): boolean => families.some((f) => f.member.name === name)
	/** The tree `name` is the relation of, by its shape, none where it is no tree's. */
	const treeShapeOf = (name: string): TreeShape | undefined =>
		families.flatMap((f) =>
			f.shape.kind === "tree" && f.member.name === name && f.owner.name === name ? [f.shape] : []
		)[0]
	/** The tree `name` is the relation of, as a unit delete of it names its rows (write/delete/unit.ts UnitMatch), none
	 * where it is no tree's. */
	const unitTreeOf = (name: string): UnitMatch | undefined =>
		families.flatMap((f): ReadonlyArray<UnitMatch> =>
			f.shape.kind === "tree" && f.member.name === name && f.owner.name === name
				? [{ kind: "tree", tree: f, shape: f.shape }]
				: []
		)[0]
	/** A family `name` is a member of besides its own tree, none where it is no other family's member. */
	const otherFamilyOf = (name: string): Family | undefined =>
		memberFamilies(name, families).find((f) => !isTreeOf(f, name))
	/**
	 * Whether a delete of `name` removes units whole (write/delete/unit.ts): it owns a family, a tree's relation its own,
	 * and is no other family's member, so its rows and every row nested under them go together.
	 */
	const unitRoot = (name: string): boolean =>
		families.some((f) => f.owner.name === name) && otherFamilyOf(name) === undefined
	/** A put or a delete of `name`, refused where it is closed: a closed relation's facts are inserted, never changed or
	 * deleted, and only a relation mutable inside a unit changes (schema/own.ts ownUnits). */
	const refuseClosedChange = (op: "put" | "delete", name: string, loc: SourceLoc): void => {
		if (!writtenOf(name, loc).mutable) {
			throw new Refusal(ruleRefused(loc, closedChangeRefusals[op]))
		}
	}
	/**
	 * The relations below a stratum's unit roots `roots` (`unitRoot`), each after the owners of every family that reaches
	 * it: every member of a family owned in the units, transitively, a tree's relation its own family's member, judged over
	 * the stratum's units together, so a member of two families whose owners two of its deletes remove goes with either.
	 * Refused where a relation below is a member of a family whose owner no unit delete of the stratum removes, whose
	 * groups its removal would leave partial, and where the world writes a relation below through a query entry, not
	 * whole. The schema refuses families that nest relations in a cycle below a unit's root when it compiles
	 * (analysis/theory/fill.ts, UnwritableRelation `unitCycle`), so the relations below always take an owner order. Which rows the deletes name is the call's: a row
	 * removed with one owner whose other owner stays leaves that family's group partial, which the family's own law, its
	 * owner, predecessor or last axis, refuses at commit.
	 */
	const unitBelow = (
		roots: NonEmptyReadonlyArray<StoredRelationName>,
		loc: SourceLoc
	): ReadonlyArray<UnitMember> => {
		const reached: Array<StoredRelationName> = [...roots]
		for (const owner of reached) {
			for (const f of families) {
				if (
					f.owner.name === owner &&
					!isTreeOf(f, f.member.name) &&
					!reached.includes(f.member.name)
				) {
					reached.push(f.member.name)
				}
			}
		}
		const below = reached.filter((name) => !roots.includes(name))
		const named = roots.join(", ")
		for (const name of below) {
			const outside = memberFamilies(name, families).find(
				(f) => !isTreeOf(f, name) && !reached.includes(f.owner.name)
			)
			if (outside !== undefined) {
				refuse(
					"UnsupportedOperation",
					loc,
					`a delete of ${named}, whose rows nest ${name}, also a member of ${outside.id.owner}.${outside.id.count}, whose owner ${outside.owner.name} no delete of the stratum removes: removing ${name}'s rows would leave ${outside.owner.name}'s groups partial`
				)
			}
		}
		const ordered: Array<StoredRelationName> = []
		const intoUnit = (name: StoredRelationName): ReadonlyArray<Family> =>
			families.filter((f) => f.member.name === name && !isTreeOf(f, name))
		for (let remaining = below; isNonEmpty(remaining);) {
			const next = remaining.find((name) =>
				intoUnit(name).every((f) => roots.includes(f.owner.name) || ordered.includes(f.owner.name))
			)
			if (next === undefined) {
				defect(
					`a delete of ${named}, whose families nest ${remaining.join(", ")} in a cycle, which the schema refuses when it compiles (analysis/theory/fill.ts unwritable, UnwritableRelation unitCycle)`
				)
			}
			ordered.push(next)
			remaining = remaining.filter((name) => name !== next)
		}
		return ordered.map((name): UnitMember => {
			refuseClosedChange("delete", name, loc)
			const target = targetOf(name, loc)
			if (target.entry.kind !== "whole") {
				refuse(
					"UnsupportedOperation",
					loc,
					`a delete of ${named}, whose rows nest ${name}, which the role writes through the query entry ${target.entry.entry.entry}: a delete of a tree or a family's owner removes every row nested under it, of relations its role holds whole`
				)
			}
			const [first, ...rest] = intoUnit(name)
			if (first === undefined) {
				defect(`the family that reaches ${name} below ${named}`)
			}
			const reaching: NonEmptyReadonlyArray<Family> = [first, ...rest]
			return Object.freeze({
				relation: target.relation,
				families: reaching,
				tree: families.find((f) => isTreeOf(f, name))
			})
		})
	}
	/**
	 * The relations whose rows an insert into `name` writes through its nesting that are counted families' members, its
	 * own among them: each one's counted families complete its rows after the walk, in its stratum's additions, as they
	 * do a member's own insert (write/family/nesting.ts NestedLayout).
	 */
	const countedReached = (relation: RelationInfo, s: number): ReadonlyArray<StoredRelationName> =>
		[...nestingFor(relation, s).layouts].flatMap(([name, laid]) =>
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
	 * adds rows of a member of one of the counted families it owns (`addedBy`), its own write of the member or one nested
	 * under another relation's insert, unless every fact it writes carries a stored owner's key (existingKeysProof). An
	 * owner inserted in the stratum that appends to its family holds its final count and ends in its own row, since
	 * PostgreSQL checks a row's CHECKs as it inserts the row and every appended member's foreign key reads its owner's
	 * count, and grizzle draws them on the host from the facts the ChangeSet states; a query's facts are the statement's
	 * alone, so the owner would be inserted at its starts, which a CHECK over an end refuses, as an immutable owner's
	 * members' references to its count do. A write of stored owners only inserts none, and compiles.
	 */
	const refuseQueriedOwnerAppend = (
		member: FactsMemberDesc,
		relation: RelationInfo,
		query: LogicalQuery,
		members: ReadonlyArray<FactsMemberDesc>
	): void => {
		const op = member.op
		if (op === "delete") {
			return
		}
		const appended = families.find(
			(f) =>
				f.owner.name === relation.name &&
				!isSequence(f) &&
				members.some((m) => addedBy(m).has(f.member.name))
		)
		if (appended === undefined || existingKeysProof(query.dag.roots[0], relation, [])) {
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
	/** What the role's write of `name` by `entry`, the name it writes the relation by, is held to: the claims where the
	 * world restricts the relation, nothing elsewhere. */
	const claimsOf = (name: string, entry: EntryName): ClaimsCheck => {
		const membership = checked.claimsMembership(name)
		return membership === undefined ? noCheck : { kind: "claimed", membership, entry }
	}
	/** A relation written whole, its facts held to `claims`. */
	const wholeTarget = (name: string, loc: SourceLoc, claims: ClaimsCheck): CheckedTarget => {
		const relation = writtenOf(name, loc)
		return { relation, entry: wholeVia, claims, carried: carriedOf(relation) }
	}
	/** What the role's world holds of each relation: its claims bind the units it restricts (schema/scope.ts). */
	const claimedWorld = checked.worldRows()
	/**
	 * Whether every fact a described source states lies in the units the role's claims bind, whole or through a query
	 * entry's fill alike: at each field of its relation the claims membership reads, the unit's key, a key the world's
	 * rows hold (ir/derived.ts claimedColumn), so its precheck would refuse nothing and is emitted nowhere.
	 */
	const claimedRows = (root: RelNode, membership: ClaimsMembership): boolean => {
		const restriction = claimedWorld.restricted.get(membership.target.name)
		return (
			restriction?.on.every((p) =>
				claimedColumn(claimedWorld, restriction.owner.unit, root, p.left)
			) === true
		)
	}
	/** What a write's facts are held to: its target's `claims`, or nothing where they are a described source's, `described`,
	 * every fact of which lies in the world (`claimedRows`). */
	const heldClaims = (claims: ClaimsCheck, described: RelNode | undefined): ClaimsCheck =>
		claims.kind === "claimed" &&
		described !== undefined &&
		claimedRows(described, claims.membership)
			? noCheck
			: claims
	/** What a member's relation name writes (see `compileChangeSet`), and the heading its facts carry, decided once. */
	const targetOf = (name: string, loc: SourceLoc): CheckedTarget => {
		const world = checked.world
		if (world.kind === "reality") {
			return wholeTarget(name, loc, noCheck)
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
			return wholeTarget(name, loc, claimsOf(name, EntryName(name)))
		}
		const entry = write.writable
		const written = writtenOf(entry.target.name, loc)
		/** Written through the entry, its unique objects are probed at the fields the role holds (insert/unique.ts
		 * entryUniques). */
		const relation: WrittenRelation = Object.freeze({
			...written,
			uniques: entryUniques(written.uniques)
		})
		const member = entryRelation(entry)
		return {
			relation,
			entry: {
				kind: "entry",
				entry,
				member,
				fillable: entryFillable(entry, options.claims)
			},
			claims: claimsOf(written.name, entry.entry),
			carried: carriedOf(member)
		}
	}
	/**
	 * Each stratum's computed records (ir/instant.ts Computed), by the relation whose host rows leave their fields out:
	 * each record's query, one rule matching nothing, checked as an insert member of its relation whose head is the
	 * computed fields alone (check/member.ts checkMemberHeading), so each field's value is a term of its type over the
	 * call's parameters, its clock reading among them, and literals, and its parameters join the ChangeSet's. A relation
	 * takes one record a stratum; one written through a query entry takes none, its rows filling the entry's fill.
	 */
	const strataComputed = desc.strata.map((stratum, s): ReadonlyMap<string, Computed> => {
		const records = new Map<string, Computed>()
		for (const m of stratum.members) {
			if (m.op !== "insert" || m.member.kind !== "computed") {
				continue
			}
			const loc = m.loc
			const target = targetOf(m.relation, loc)
			const relation = target.relation
			if (records.has(relation.name)) {
				refuse(
					"UnsupportedOperation",
					loc,
					`an insert into ${relation.name} computing one record of fields in its stratum: its host rows take each computed field from one value, so state every computed field of the stratum's inserts of ${relation.name} in one record`
				)
			}
			if (target.entry.kind !== "whole") {
				refuse(
					"UnsupportedOperation",
					loc,
					`an insert into ${relation.name} through the query entry ${target.entry.entry.entry} computing fields of its host rows: the entry's fill reads its rows as they are stated, so state every field, or insert ${relation.name} whole`
				)
			}
			const [arm, ...moreArms] =
				m.member.query.stage.kind === "rules" ? m.member.query.stage.arms : []
			if (
				arm === undefined ||
				moreArms.length > 0 ||
				arm.matches.length > 0 ||
				arm.where.length > 0 ||
				arm.vars.length > 0
			) {
				return refuse(
					"MalformedDescription",
					loc,
					`the computed fields of an insert into ${relation.name}: one rule that matches nothing and finds each field's value`
				)
			}
			if (
				!stratum.members.some(
					(o) =>
						o.op === "insert" &&
						o.relation === m.relation &&
						(o.member.kind === "array" || o.member.kind === "stream")
				)
			) {
				refuse(
					"UnsupportedOperation",
					loc,
					`computed fields of ${relation.name}'s host rows, beside no array or Stream insert of ${relation.name} in their stratum: the call computes the fields an insert's host rows leave out`
				)
			}
			const named = new Set(Object.keys(arm.head))
			const computedHeading: MemberRelation = {
				name: relation.name,
				heading: relation.heading.filter((c) => named.has(c.name))
			}
			const query = unwrap(
				checkMember(
					checked,
					{
						op: "insert",
						relation: computedHeading,
						query: navigateQuery(
							inlinedIn(m.member.query),
							loc,
							columns,
							{ kind: "perRead" },
							navigation
						),
						loc
					},
					{ label: `insert ${relation.name}'s computed fields`, clock, session }
				)
			)
			for (const p of query.params) {
				merge(params, p, loc)
			}
			const root = query.dag.roots[0]
			if (root.kind !== "ProjectSet") {
				defect(
					`the computed fields of ${relation.name} checked as one rule's projection, not a ${root.kind}`
				)
			}
			const [first, ...rest] = root.out.map(({ name, expr }) => ({
				field: defined(
					relation.fields.find((f) => f.name === name),
					`the computed field ${relation.name}.${name}`
				),
				expr
			}))
			if (first === undefined) {
				return refuse(
					"MalformedDescription",
					loc,
					`the computed fields of an insert into ${relation.name}: at least one field`
				)
			}
			records.set(relation.name, { key: `${s}\u0000${relation.name}`, fields: [first, ...rest] })
		}
		return records
	})
	/** The fields of `relation`'s host rows its insert in the `s`-th stratum computes, each filled by the call's one value
	 * of it (ir/instant.ts Stamp `call`); none where the stratum computes none of its fields. */
	const computedStamps = (s: number, relation: string): ReadonlyArray<Stamped> => {
		const computed = strataComputed[s]?.get(relation)
		return computed === undefined
			? []
			: computed.fields.map(({ field }) => ({
					field,
					stamp: { kind: "call", computed, from: field.name }
				}))
	}
	const strataMembers = strataWrites.map((members, s) =>
		members.map((member): CheckedMember => {
			const loc = member.loc
			const target = targetOf(member.relation, loc)
			const { relation, entry } = target
			if (member.op === "insert") {
				refuseNestedOutsideRole(relation.name, loc)
			} else {
				refuseClosedChange(member.op, relation.name, loc)
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
			if (tree !== undefined && member.op === "put") {
				refuse(
					"UnsupportedOperation",
					loc,
					`a put of ${relation.name}, a node of the tree ${tree.id.owner}.${tree.id.count}: a tree is rewritten whole, inserted from its root with the whole tree nested and deleted by its root fields`
				)
			}
			const memberOf = otherFamilyOf(relation.name)
			if (tree !== undefined && member.op === "delete" && memberOf !== undefined) {
				refuse(
					"UnsupportedOperation",
					loc,
					`a delete of ${relation.name}, a tree whose nodes are members of ${memberOf.id.owner}.${memberOf.id.count}: a tree whose nodes are another family's members is deleted with that family's owner, ${memberOf.owner.name}`
				)
			}
			const unitDelete = member.op === "delete" && unitRoot(relation.name)
			if (unitDelete && entry.kind !== "whole") {
				refuse(
					"UnsupportedOperation",
					loc,
					`a delete of ${relation.name} through the query entry ${entry.entry.entry}: a delete of a tree or a family's owner removes every row nested under it, of relations its role holds whole, so delete ${relation.name} whole`
				)
			}
			if (tree === undefined || member.op !== "delete") {
				refuseUnstatedKey(member, relation)
			}
			const fixed = memberFamilies(relation.name, families).find(
				(f) => !isTreeOf(f, relation.name) && !writtenOf(f.owner.name, loc).mutable
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
				!members.some((m) => m.op === "insert" && insertedBy(m.relation).has(fixed.owner.name))
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
					? countedReached(relation, s).flatMap((name) =>
							families.filter(
								(f) =>
									f.member.name === name &&
									name !== relation.name &&
									!isSequence(f) &&
									!writtenOf(f.owner.name, loc).mutable &&
									!members.some(
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
			const edited = managed(relation.name) && tree === undefined
			const described = !enumeratedMember(member.member)
			if (edited && (entry.kind !== "whole" || described)) {
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
			if (nested && (entry.kind !== "whole" || described)) {
				refuse(
					"UnsupportedOperation",
					loc,
					`an insert into ${relation.name}, which owns a sequence, ${entry.kind !== "whole" ? "through a query entry" : "by a query"}: a sequence's members are written nested in order under their owner, so insert ${relation.name} whole from an array or a Stream`
				)
			}
			const written: MemberRelation =
				entry.kind === "entry"
					? entry.member
					: unitDelete && tree !== undefined
						? {
								name: relation.name,
								heading: rootFieldsOf(defined(treeShapeOf(relation.name), "a tree's shape"))
							}
						: relation
			const source = member.member
			/** What a delete of the member removes of its relation's place groups, by the fields its rows state: a
			 * field-equality member's equated fields, any other member's written heading. */
			const removes = removalOf(
				laws.theory.instants,
				relation,
				source.kind === "equal" ? Object.keys(source.fields) : written.heading.map((c) => c.name)
			)
			if (source.kind === "array" || source.kind === "stream") {
				return {
					op: member.op,
					target,
					loc,
					removes,
					planned: { op: member.op, relation: member.relation, member: source, loc },
					source: { kind: "enumerated", member: source }
				}
			}
			const describedQuery =
				source.kind === "query" ? inlinedIn(source.query) : equalQuery(written, source.fields, loc)
			const query = unwrap(
				checkMember(
					checked,
					{
						op: member.op,
						relation: written,
						query: navigateQuery(describedQuery, loc, columns, { kind: "perRead" }, navigation),
						loc
					},
					{ label: `${member.op} ${member.relation}`, clock, session }
				)
			)
			refuseQueriedOwnerAppend(member, relation, query, members)
			for (const p of query.params) {
				merge(params, p, loc)
			}
			return {
				op: member.op,
				target,
				loc,
				removes,
				planned: {
					op: member.op,
					relation: member.relation,
					member: { kind: "query", query: describedQuery },
					loc
				},
				source: { kind: "described", root: merger.add(query) }
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
			const { relation, entry } = m.target
			/** The counted members a nested insert writes: each edits only its counted families, since its sequences are the
			 * walk's, under their fresh owners. */
			const nestedCounted =
				m.op === "insert" && nests(relation.name)
					? countedReached(relation, s).flatMap((name) =>
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
								slot: writeSlotId(s, { op: "put" }, relation.name)
							}
			for (const w of [
				{ relation, op: m.op, edited: editedBy(families, relation), rows: putRows },
				...nestedCounted.map((counted) => ({
					relation: counted,
					op: m.op,
					edited: editedBy(families, counted).filter((f) => !isSequence(f)),
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
		const refill = unwrap(stratumRefill(laws.theory.fill, families, writes, edited, holds))
		if (refill !== undefined) {
			refills.set(s, refill)
		}
	}
	const readBacks = desc.reads.map((r) => {
		const query = unwrap(
			checkReadBack(
				checked,
				{ name: r.name, query: inlinedIn(r.query) },
				{ label: `read ${r.name}`, clock, session }
			)
		)
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
		op: WriteOp,
		input: Heading,
		loc: SourceLoc
	): RelNode =>
		merger.add(
			unwrap(
				checkFill(
					base,
					{ op, relation, query: fillQuery(entry, input, loc), loc },
					{ label: `${op} ${entry.entry}`, clock, session }
				)
			)
		)

	/** 2. Group each stratum's members into actions. */
	const slots: Array<SlotGroup> = []
	const occupied = occupiedStrata.map(
		([stratum, s]) =>
			[stratum, { s, members: defined(strataMembers[s], "a writing stratum's members") }] as const
	)
	/** Each stratum's nested writes, by its position among the occupied strata, the stratum its statements run in. */
	const nestedWrites: Array<NestedWrite> = []
	/** Each stratum's slots of the relations whose rows its family statements write, by operation, and the counted
	 * members its nested writes reach, whose rows those statements complete (`countedReached`). */
	const edits: Array<{
		readonly stratum: StratumAt
		readonly relation: StoredRelationName
		readonly write:
			| {
					readonly op: "insert" | "put" | "delete"
					readonly slot: ParamId
					readonly stamps: ReadonlyArray<Stamped>
			  }
			| { readonly op: "nested" }
	}> = []
	/** Each stratum's prechecks of the slots of `edits` a claims-held write writes. */
	const memberChecks: Array<{ readonly stratum: StratumAt; readonly check: MemberCheck }> = []
	/** Records the precheck of `source`'s facts of `relation`, which a family statement of `stratum` writes, where they are
	 * held to the claims (`heldClaims`). */
	const precheckMember = (
		stratum: StratumAt,
		relation: WrittenRelation,
		source: FamilySource,
		claims: ClaimsCheck
	): void => {
		const held = heldClaims(claims, source.kind === "described" ? source.node : undefined)
		if (held.kind === "claimed") {
			memberChecks.push(
				Object.freeze({ stratum, check: Object.freeze({ relation, source, check: held }) })
			)
		}
	}
	const draftsByStratum = occupied.map(([stratum, { s, members }]) => {
		const drafts: Array<Draft> = []
		const outside: Array<OutsideDraft> = []
		const units: Array<UnitDraft> = []
		const byRelation = [...groupBy(members, (m) => m.target.relation.name)].toSorted(
			Order.mapInput(Order.compareStrings, ([name]: readonly [string, unknown]) => name)
		)
		for (const [, list] of byRelation) {
			/** One target per base relation per role (targetOf), its writable entry and the heading its facts carry, so every
			 * member of the relation writes it alike and every operation's slot is headed by the relation's own heading. */
			const { relation, entry: target, claims, carried: facts } = list[0].target
			const written: MemberRelation = target.kind === "entry" ? target.member : relation
			const groupInputs: Array<EnumeratedInput> = []
			const ops = (["delete", "put", "insert"] as const).flatMap((op) => {
				const ofOp = list.filter((m) => m.op === op)
				return isNonEmpty(ofOp) ? [{ op, ofOp }] : []
			})
			for (const { op, ofOp } of ops) {
				const firstOfOp = headNonEmpty(ofOp)
				/** What the operation removes of its relation's place groups: whole groups only where every member does. */
				const removes: Removal = ofOp.every((m) => m.removes === "groups") ? "groups" : "rows"
				const enumerated = ofOp.flatMap((m) =>
					m.source.kind === "enumerated" ? [m.source.member] : []
				)
				const queries = ofOp.flatMap((m) =>
					m.source.kind === "described" ? [{ root: m.source.root, loc: m.loc }] : []
				)
				/** The heading a described member's rows are written at: a whole relation's, the written fields it delivers, its
				 * caller's and the instants it states; a query entry's, the entry's facts, at which its fill reads every
				 * source. */
				const writtenAt = (root: RelNode): Heading =>
					target.kind === "whole"
						? written.heading
								.filter((c) => root.heading.some((d) => d.name === c.name))
								.map(carriedColumn)
						: facts
				/** The operation's described members, those written at one heading together, in their first member's
				 * order: each the sources of one action (see `compileChangeSet`), where its first member stands. */
				const headed: Array<{
					readonly heading: Heading
					readonly roots: [RelNode, ...Array<RelNode>]
					readonly loc: SourceLoc
				}> = []
				for (const q of queries) {
					const heading = writtenAt(q.root)
					const group = headed.find((g) => sameHeading(g.heading, heading))
					if (group === undefined) {
						headed.push({ heading, roots: [q.root], loc: q.loc })
					} else {
						group.roots.push(q.root)
					}
				}
				const loc = firstOfOp.loc
				const transport = enumerated.some((m) => m.kind === "stream") ? "stream" : "enumerated"
				/** The member slot of the operation's enumerated members, its facts carrying `carried` and stating `walked`
				 * beside their key and caller's fields (insert/input.ts relationInput). */
				const memberSlot = (
					act: ActionOp,
					carried: Heading,
					walked: ReadonlySet<ColumnKey>
				): MemberSlot => {
					const id = writeSlotId(s, act, written.name)
					return Object.freeze({
						slot: id,
						transport,
						heading: carried,
						input: relationInput(id, carried, relation, walked)
					})
				}
				/** The names of the operation's enumerated members, when it has any. */
				const memberNames = isNonEmpty(enumerated)
					? Object.freeze(mapNonEmpty(enumerated, (m) => m.slot))
					: undefined
				/** The operation's enumerated input of one slot, read as `act`, when it has enumerated members: its facts
				 * carry `carried`, its members' admitted against `admitted`. */
				const singleInput = (
					act: SingleAct,
					carried: Heading,
					admitted: Heading
				): MemberSlot | undefined => {
					if (memberNames === undefined) {
						return undefined
					}
					const slot = memberSlot(act, carried, noneWalked)
					const starts = slot.input.family.map((c): StartData => {
						const field = defined(
							relation.fields.find((f) => f.name === c.name),
							`the field ${relation.name}.${c.name} a slot carries`
						)
						return {
							name: c.name,
							start:
								field.writing.kind === "accumulated"
									? { kind: "literal", type: field.type, literal: field.writing.start }
									: { kind: "zero" }
						}
					})
					groupInputs.push(
						Object.freeze({
							kind: "single",
							act,
							slot,
							members: memberNames,
							admitted: target.kind === "whole" ? keyHeading(relation, admitted, facts) : admitted,
							starts: Object.freeze(starts)
						})
					)
					return slot
				}
				/** The action `act` over its slot and the described members' `roots`, their facts carrying `carried`, when
				 * it reads any: written whole, through its entry's fill, or refused outright when the fill can fill
				 * nothing, where a deletion is a no-op. */
				const draft = (
					act: ActionOp,
					carried: Heading,
					slot: MemberSlot | undefined,
					roots: ReadonlyArray<RelNode>,
					site: SourceLoc,
					computed: ReadonlyArray<Stamped>
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
						drafts.push({
							act,
							relation,
							carried,
							reads,
							entry: target,
							claims,
							removes,
							loc: site,
							computed
						})
						return
					}
					if (!target.fillable) {
						if (act.op !== "delete") {
							outside.push({ entry: target.entry.entry, carried, reads })
						}
						return
					}
					const fill = mergeFill(target.entry, relation, act.op, carried, loc)
					drafts.push({
						act,
						relation,
						carried,
						reads,
						entry: { kind: "entry", entry: target.entry, fill },
						claims,
						removes,
						loc: site,
						computed
					})
				}
				/**
				 * The operation's actions `act`, one per heading its sources' rows are written at (see `compileChangeSet`):
				 * its slot's, `carried`, with the described members written at it as more arms of its union, then each other
				 * group of described members (`headed`) over their union. Only the slot's action fills the fields its host rows
				 * leave out, `computed`, since a member written at its heading states them.
				 */
				const actionsOf = (
					act: ActionOp,
					carried: Heading,
					slot: MemberSlot | undefined,
					computed: ReadonlyArray<Stamped>
				): void => {
					const joined =
						slot === undefined ? undefined : headed.find((g) => sameHeading(g.heading, carried))
					draft(act, carried, slot, joined?.roots ?? [], loc, computed)
					for (const g of headed) {
						if (g !== joined) {
							draft(act, g.heading, undefined, g.roots, g.loc, [])
						}
					}
				}
				/** An owner of counted families' counts and ends, which its enumerated slot carries at their starts when the
				 * slot is the owner's own rows: a query entry's slot fills its fill, a member of the owner whose head holds only
				 * the fields its facts state (check/member.ts memberHeading), so the owner's insert writes them at their starts
				 * and the stratum's appends to it take its count statement. Only these: the copies, indexes and accumulators it
				 * holds as a member are drawn by the families it is a member of, which a fresh owner's fill reads from its facts
				 * (runtime/write/bind.ts freshOwners), where a start would stand in for them. */
				const ownedNames = new Set(
					families.flatMap((f) =>
						f.owner.name === relation.name
							? [f.count.name, ...endColumns(f).map((e) => e.name)]
							: []
					)
				)
				const owned =
					target.kind === "whole"
						? written.heading.filter((c) => ownedNames.has(c.name)).map(carriedColumn)
						: []
				if (
					managed(relation.name) &&
					!families.some((f) => isTreeOf(f, relation.name)) &&
					!(op === "insert" && nests(relation.name))
				) {
					/** A member relation that owns counted families carries their counts and ends in its insert and put slots,
					 * as an owner's own slot does: the stratum's appends to a group with no member yet draw them (write/program/
					 * bind.ts freshOwners), which an inserted row holds; a put's row, which may be a stored one the stratum
					 * moves, holds them as its groups' members do, and these only where a group holds none
					 * (write/family/additions.ts appendedOf). */
					const computed = op === "insert" ? computedStamps(s, relation.name) : []
					const stated = facts.filter((c) => !computed.some((st) => st.field.name === c.name))
					const heading = op === "delete" ? stated : [...stated, ...owned]
					const act: SingleAct = op === "delete" ? { op, names: "rows" } : { op }
					const slot = singleInput(act, heading, stated)
					if (slot !== undefined) {
						edits.push(
							Object.freeze({
								stratum,
								relation: relation.name,
								write: { op, slot: slot.slot, stamps: computed }
							})
						)
						precheckMember(stratum, relation, { kind: "slot", input: slot.input }, claims)
					}
					continue
				}
				switch (op) {
					case "put": {
						const act = { op }
						/** An enumerated put of an owner carries its counts and ends in its slot, at their starts, as its
						 * insertion does: the stratum's appends to an owner the put inserts replace them before its insert
						 * half is sent (runtime/write/bind.ts freshOwners), and a stored owner's are no field its UPDATE sets. A put
						 * that also reads queries carries none, since their rows hold only written fields. */
						const carried = isNonEmpty(queries) ? facts : [...facts, ...owned]
						actionsOf(act, carried, singleInput(act, carried, facts), [])
						break
					}
					case "delete": {
						if (unitRoot(relation.name)) {
							const act: SingleAct = { op, names: "units" }
							/** A tree's units are named by their root fields, an owner's by its facts. */
							const shape = treeShapeOf(relation.name)
							const named =
								shape === undefined
									? facts
									: facts.filter((c) => rootFieldsOf(shape).some((f) => f.name === c.name))
							units.push({
								relation,
								heading: named,
								slot: singleInput(act, named, named),
								roots: queries.map((q) => q.root),
								claims,
								removes,
								loc
							})
							break
						}
						/** One relation, one fact heading (rule 0): a deletion's facts carry what an addition's do, its
						 * written fields, so a fact inserted and deleted is one fact with one identity, which nets. A
						 * generated field is a function of the written ones, so it decides no match. */
						const act: SingleAct = { op, names: "rows" }
						actionsOf(act, facts, singleInput(act, facts, facts), [])
						break
					}
					case "insert": {
						const insert: SingleAct = { op }
						if (nests(relation.name)) {
							const nesting = nestingFor(relation, s)
							if (memberNames !== undefined) {
								/** A nested insert's facts are its rows as its nesting writes them (Nesting.top), each count and end
								 * drawn from its members: never a put's, which state their caller's fields, so the host refuses the
								 * two at one key (normalize/ step 3). A stamped nesting's root is written by its family statement,
								 * which stamps it with every member that carries its stamp (write/family/nesting.ts Nesting
								 * `stamps`), so it is that statement's edit and no action of its own. */
								const slot = memberSlot(insert, nesting.top, nesting.walked)
								groupInputs.push(
									Object.freeze({
										kind: "nested",
										act: insert,
										slot,
										nesting,
										reached: new Map(
											nesting.reached.map((r) => {
												const member = writtenOf(r.family.member.name, loc)
												return [member.name, stampedChecksOf(member, nesting)] as const
											})
										),
										members: memberNames
									})
								)
								nestedWrites.push(Object.freeze({ stratum, nesting, slot }))
								for (const name of countedReached(relation, s)) {
									edits.push(
										Object.freeze({ stratum, relation: name, write: { op: "nested" } as const })
									)
								}
								if (nesting.root.kind === "plain") {
									const stamps = nesting.stamps.get(relation.name)
									if (stamps !== undefined) {
										edits.push(
											Object.freeze({
												stratum,
												relation: relation.name,
												write: { op: "insert", slot: slot.slot, stamps }
											})
										)
										precheckMember(stratum, relation, { kind: "slot", input: slot.input }, claims)
									} else {
										draft(insert, nesting.top, slot, [], loc, [])
									}
								}
							}
							break
						}
						/** An owner of counted families carries its counts and ends in its slot, at their starts, which the
						 * stratum's appends to it replace before its insert is sent; its host rows leave out every field the
						 * call computes, which its statement fills. */
						const computed = computedStamps(s, relation.name)
						const stated = facts.filter((c) => !computed.some((st) => st.field.name === c.name))
						const carried = [...stated, ...owned]
						actionsOf(insert, carried, singleInput(insert, carried, stated), computed)
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
								: {
										stated: statedInRelation,
										host: groupHost(relation, groupInputs, computedStamps(s, relation.name)),
										generations: keyGenerations(relation.fields)
									}
					})
				)
			}
		}
		const [firstUnit, ...moreUnits] = units
		const below =
			firstUnit === undefined
				? []
				: unitBelow(
						[firstUnit.relation.name, ...moreUnits.map((u) => u.relation.name)],
						firstUnit.loc
					)
		const edited = members.find(
			(m) =>
				m.op === "put" &&
				(units.some((u) => u.relation.name === m.target.relation.name) ||
					below.some((b) => b.relation.name === m.target.relation.name))
		)
		if (edited !== undefined) {
			throw new Refusal(
				ruleRefused(
					edited.loc,
					"a stratum puts no row its deletes remove whole: a delete of a tree or of a family's owner removes every row nested under it, so put in another stratum (ChangeSet.sequence), or insert the rows again whole"
				)
			)
		}
		return { stratum, drafts, outside, units, below }
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
		/** Where its first member stands (Draft). */
		readonly loc: SourceLoc
	}
	const builtByStratum = draftsByStratum.map(({ stratum, drafts, outside }) => ({
		stratum,
		outside,
		built: drafts.map(
			({ act, relation, carried, reads, entry, claims, removes, loc, computed }): Built => {
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
					stamps: stampsOf(
						laws.theory.instants,
						relation,
						act.op,
						removes,
						read.heading,
						entry.kind === "whole"
							? managed(relation.name) || nests(relation.name)
								? { kind: "family" }
								: { kind: "own" }
							: { kind: "entry" },
						loc,
						computed
					),
					entry:
						entry.kind === "entry" ? Object.freeze({ kind: "entry", entry: entry.entry }) : entry,
					claims: heldClaims(claims, read.reads.kind === "described" ? read.reads.node : undefined)
				})
				return { action: { ...act, relation: relation.name, source: read.source }, info, loc }
			}
		)
	}))
	/** Each action's stamps by its stratum, which a ChangeSet stamps each clock in one stratum of, every reference beside
	 * its clock's insert (write/frontend/instants.ts refuseStampsApart). */
	const stamping: ReadonlyArray<StampingAction> = [
		...builtByStratum.flatMap(({ stratum, built }) =>
			built.map(({ info, loc }) => ({
				stratum,
				relation: info.relation,
				stamps: info.stamps,
				writer: "own" as const,
				loc
			}))
		),
		...nestedWrites.flatMap(({ stratum, nesting }) =>
			[nesting.relation, ...nesting.reached.map((r) => r.family.member)].flatMap((relation) => {
				const stamps = nesting.stamps.get(relation.name)
				return stamps === undefined
					? []
					: [{ stratum, relation, stamps, writer: "family" as const, loc: relation.loc }]
			})
		)
	]
	refuseStampsApart(stamping)
	/** Each stratum's unit deletes, each its relation's units from its one source, built after every action's. */
	const unitsByStratum = draftsByStratum.map(({ stratum, units, below }) => ({
		stratum,
		below,
		units: units.map((unit): UnitDelete => {
			refuseUnitPlace(laws.theory.instants, unit.relation, unit.removes, unit.loc)
			const [firstRoot, ...moreRoots] = unit.roots
			const source: FamilySource =
				firstRoot === undefined
					? {
							kind: "slot",
							input: defined(unit.slot, "the slot of a unit delete of no described member").input
						}
					: {
							kind: "described",
							node: sourceOf(
								{ kind: "described", slot: unit.slot, roots: [firstRoot, ...moreRoots] },
								unit.relation.name,
								unit.heading
							)
						}
			precheckMember(stratum, unit.relation, source, unit.claims)
			const stated = keyFirst(unit.relation).filter((f) =>
				unit.heading.some((c) => c.name === f.name)
			)
			const [firstField, ...moreFields] = stated
			if (firstField === undefined) {
				defect(`the fields a delete of ${unit.relation.name}'s units states`)
			}
			const match: UnitMatch = unitTreeOf(unit.relation.name) ?? {
				kind: "facts",
				fields: [firstField, ...moreFields]
			}
			return Object.freeze({ relation: unit.relation, match, source })
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
		),
		...unitsByStratum.flatMap(({ units }) =>
			units.flatMap((u) => (u.source.kind === "described" ? [u.source.node] : []))
		)
	]
	/** A ChangeSet of enumerated members alone and no read-back has no query: its DAG has no root. */
	const structural = glue.build([
		...new Set([...sourceRoots, ...readBacks.map((r) => r.root), ...boundInputs.map((b) => b.node)])
	])
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
				defect(`the column ${name} a generated column of ${relation} reads`)
			}
			return columnKey({ kind: "law", column: law.column })
		}
		return [
			...fields.flatMap((f) =>
				f.writing.kind === "generated"
					? [
							{
								key: columnKey({ kind: "field", field: f }),
								reads: fieldReads([f.writing.expr]).map(keyOf)
							}
						]
					: []
			),
			...lawColumns.flatMap((c) =>
				c.value.kind === "generated"
					? [
							{
								key: columnKey({ kind: "law", column: c.column }),
								reads: fieldReads([...c.value.guard, c.value.term]).map(keyOf)
							}
						]
					: []
			)
		]
	}
	/** A stratum's refills, by its position among the occupied strata. */
	const refillOf = (stratum: StratumAt): StratumRefill | undefined =>
		refills.get(defined(occupied[stratum], "an occupied stratum")[1].s)
	/** A stratum's family statements: its unit deletes' one statement first (write/delete/unit.ts), then its family
	 * work (`familyWorkOf`). */
	const familyNodesOf = (stratum: StratumAt): ReadonlyArray<FamilyNode> => {
		const work = familyWorkOf(stratum)
		const atStratum = unitsByStratum.find((u) => u.stratum === stratum)
		const [first, ...rest] = atStratum?.units ?? []
		return first === undefined
			? work
			: [{ kind: "unit", units: [first, ...rest], below: atStratum?.below ?? [] }, ...work]
	}

	/**
	 * The sources of the rows of `relation` that `stratum` inserts or puts (`RowsOf`), each as the host sends it: a slot
	 * that writes them, holding its stated fields (insert/input.ts RelationInput), never the counts and ends it carries at
	 * their starts, which a put of a stored owner leaves as stored; and the stratum's nested rows of them, holding their
	 * sent layout (runtime/write/nesting.ts sentLayout). Each with the fields its rows leave out that a stamp fills, which
	 * the statement that writes them takes: a family edit's slot its edit's, an action's slot its action's (ActionInfo
	 * `stamps`), a nested insert's own slot and the nested rows their nesting's. The one reading of what each source of a
	 * stratum's rows holds: an owner copy's (`ownerReadingOf`) and a fresh fill's (`freshFillOf`).
	 */
	const rowsOf = (stratum: StratumAt, relation: StoredRelationName): RowsOf => {
		const edited = new Map(
			edits.flatMap((e) =>
				e.stratum === stratum &&
				e.relation === relation &&
				(e.write.op === "insert" || e.write.op === "put")
					? [[e.write.slot, e.write.stamps] as const]
					: []
			)
		)
		const acted = new Map(
			placedByStratum.flatMap((p) =>
				p.stratum === stratum
					? p.built.flatMap((b) =>
							b.action.relation === relation && b.action.source.kind === "enumerated"
								? [[b.action.source.slot, b.info.stamps] as const]
								: []
						)
					: []
			)
		)
		const slotted = slots.flatMap((g) =>
			g.stratum === stratum && g.relation.name === relation
				? g.inputs.flatMap((input) =>
						writingSlots(input).map((slot): SentSource => ({
							source: { kind: "slot", slot: slot.slot },
							holds: slot.input.stated.map((c) => columnKeyOf(c.name)),
							stamps:
								edited.get(slot.slot) ??
								acted.get(slot.slot) ??
								(input.kind === "nested" ? (input.nesting.stamps.get(relation) ?? []) : [])
						}))
					)
				: []
		)
		const laid = stratumLayouts(nestedWrites, stratum).get(relation)
		const nested: ReadonlyArray<SentSource> =
			laid === undefined
				? []
				: [
						{
							source: { kind: "nestedRows" },
							holds: ((sent) => [...sent.key, ...sent.columns].map((c) => c.key))(
								sentLayout(laid.layout)
							),
							stamps: laid.nesting.stamps.get(relation) ?? []
						}
					]
		return {
			sent: [...slotted, ...nested],
			appended: [
				...slotted.filter((r) => r.source.kind === "slot" && edited.has(r.source.slot)),
				...nested
			]
		}
	}

	/**
	 * A stratum's fresh fill as the host leaves it to its statements (`FreshFill`): the host draws each fresh group of a
	 * counted family the stratum appends members to (runtime/write/bind.ts freshOwners) from the rows it sends of its
	 * owners and its members (`rowsOf`), which hold no stamped field. A member's key or group field is held by every
	 * source of its rows, or stamped by every one with one value of the call, the same term of its parameters (ir/instant.ts
	 * Stamp `call`, lower/shapes/catalog/exprs.ts sameExpr), which every row of the call holds, so the host's rows of a call
	 * are keyed by the rest (write/family/nesting.ts keyedOf), and the statement fills it, the host's members with the
	 * member's own stamps (FreshFill `stamps`). A group field is held on both sides, which the host matches a member to its
	 * owner by, or stamped on both by one value, a unit the call's rows share, which it matches by no longer; and every
	 * column the host draws reads no stamped one, the columns it leaves to the statement being the stamps' and the
	 * generated fields over them (nesting.ts statementFilled). Refused where the host could not draw a group
	 * (UnsupportedOperation, UnfillableField).
	 */
	const freshFillOf = (stratum: StratumAt): FreshFill => {
		const reached = families.filter(
			(f) => !isSequence(f) && isNonEmpty(rowsOf(stratum, f.member.name).appended)
		)
		/** The expression of the call's value a call stamp fills its field with. */
		const valueOf = (stamp: Extract<Stamp, { readonly kind: "call" }>) =>
			defined(
				stamp.computed.fields.find((f) => f.field.name === stamp.from),
				`the computed field ${stamp.from}`
			).expr
		/** Whether two stamps fill their fields with one value of the call: one record's field, or one term. */
		const oneValue = (a: Stamped, b: Stamped): boolean =>
			a.stamp.kind === "call" &&
			b.stamp.kind === "call" &&
			((a.stamp.computed === b.stamp.computed && a.stamp.from === b.stamp.from) ||
				sameExpr(valueOf(a.stamp), valueOf(b.stamp)))
		/** The stamp every one of `sources` fills `field` with, one value of the call, none where every one holds it;
		 * refused where some hold it and others stamp it, or they stamp it apart. */
		const agreed = (
			sources: ReadonlyArray<SentSource>,
			relation: StoredRelationName,
			field: string
		): Stamped | undefined => {
			const [first, ...rest] = sources.map((r) => r.stamps.find((st) => st.field.name === field))
			if (first === undefined && rest.every((st) => st === undefined)) {
				return undefined
			}
			if (
				first?.stamp.kind === "call" &&
				rest.every((st) => st !== undefined && oneValue(first, st))
			) {
				return first
			}
			return refuse(
				"UnsupportedOperation",
				at,
				`the rows of ${relation} that stratum ${stratum} inserts beside a counted family's members, some of which state ${field} while others leave it to a stamp or stamp it apart: the host draws each fresh group from rows that hold or share it, so state ${field} in every insert of ${relation}, or compute it in each by one term of the call's parameters`
			)
		}
		const stamps = new Map<StoredRelationName, Array<Stamped>>()
		for (const f of reached) {
			const members = rowsOf(stratum, f.member.name).appended
			const owners = rowsOf(stratum, f.owner.name).sent
			const memberStamps = stamps.getOrInsertComputed(f.member.name, () => [])
			const fields = [
				...new Set([...f.member.primaryFields, ...f.group.map((g) => g.member)].map((x) => x.name))
			]
			for (const field of fields) {
				const st = agreed(members, f.member.name, field)
				if (st !== undefined && !memberStamps.some((m) => m.field.name === field)) {
					memberStamps.push(st)
				}
			}
			if (!isNonEmpty(owners)) {
				continue
			}
			for (const g of f.group) {
				const member = agreed(members, f.member.name, g.member.name)
				const owner = agreed(owners, f.owner.name, g.owner.name)
				if (
					(member === undefined) !== (owner === undefined) ||
					(member !== undefined && owner !== undefined && !oneValue(member, owner))
				) {
					refuse(
						"UnsupportedOperation",
						at,
						`a fresh group of ${f.owner.name}.${f.count.name} in stratum ${stratum}, whose member field ${f.member.name}.${g.member.name} and owner field ${f.owner.name}.${g.owner.name} are not one value of the call: the host draws a group whose owner the stratum inserts by matching its members to it, so state both fields, or compute both by one term of the call's parameters`
					)
				}
			}
		}
		const owners = [...new Set(reached.map((f) => f.owner))]
		const walked = [
			...owners.flatMap((owner) => {
				const laid = stratumLayouts(nestedWrites, stratum).get(owner.name)
				const rows = rowsOf(stratum, owner.name).sent
				/** Its slots' rows stand at the top, but a sequence member's, which stands only where its owner nests it. */
				const top =
					rows.some((r) => r.source.kind === "slot") &&
					!families.some((g) => isSequence(g) && g.member.name === owner.name)
				return [
					...(top ? [{ relation: owner, position: { kind: "top" } as const }] : []),
					...(laid === undefined ? [] : [{ relation: owner, position: laid.layout.position }])
				]
			}),
			...reached.map((f) => ({
				relation: f.member,
				position: { kind: "member", family: f } as const
			}))
		]
		const filled = unwrap(
			statementFilled(
				laws.theory.fill,
				walked,
				(relation) =>
					new Set(
						rowsOf(stratum, relation).sent.flatMap((r) =>
							r.stamps.map((st) => columnKeyOf(st.field.name))
						)
					),
				at
			)
		)
		return { left: new Map([...filled].filter(([, keys]) => keys.size > 0)), stamps }
	}

	/**
	 * A stratum's family work as one removals statement and one additions statement of each member relation
	 * (write/family/removals.ts, write/family/additions.ts), drawing its refills (frontend/refill.ts StratumRefill): a
	 * member's removals where an edit puts or deletes it or a refill draws a family of it again, its additions where one
	 * inserts or puts it or a nested write fills its rows, each with each owner of its families, its count and ends
	 * changed, and, for a member it removes from and appends nothing to, the recount of the owners the stratum puts.
	 */
	const familyWorkOf = (stratum: StratumAt): ReadonlyArray<FamilyNode> => {
		const own = edits.filter((e) => e.stratum === stratum)
		/** The relations whose rows the stratum's nested writes fill, which its additions insert (write/family/nesting.ts
		 * sentLayout). */
		const nested = nestedWrites.flatMap((n) =>
			n.stratum === stratum ? [...n.nesting.layouts.keys()] : []
		)
		const by = (ops: ReadonlyArray<"insert" | "put" | "delete">) => [
			...new Set(own.flatMap((e) => (ops.some((op) => op === e.write.op) ? [e.relation] : [])))
		]
		/** The stratum's refills, by member relation. */
		const refilled =
			refillOf(stratum)?.members ?? new Map<StoredRelationName, ReadonlyArray<PlainRefill>>()
		const removing = by(["put", "delete"])
		const slotted = by(["insert", "put"])
		const adding = [...new Set([...slotted, ...nested])]
		/** Each refilled member's starts, any mix of: the puts of plain relations, whose facts its removals statement
		 * reads; the edit of the one relation the stratum puts or deletes whose removals statement the member rides in
		 * (refill.ts refuses a member two edits reach, `edits`); and the appends to the member itself, whose additions
		 * recount the owners whose counts and ends its stored members copy, which their owner axes cascade. */
		const starts = new Map(
			[...refilled].map(([member, memberRefills]) => {
				const all = memberRefills.flatMap((r) => r.ways.map((way) => way.root))
				return [
					member,
					{
						puts: [...new Set(all.flatMap((x) => (x.kind === "put" ? [x.relation] : [])))],
						edit: all.find((x) => x.kind === "edit")?.relation
					}
				] as const
			})
		)
		/** The members whose refills start at plain puts and at no edit, each its own removals statement's, by the puts'
		 * relations. */
		const putRefilled = new Map(
			[...starts].flatMap(([member, x]) =>
				x.edit === undefined && isNonEmpty(x.puts) ? [[member, x.puts] as const] : []
			)
		)
		/** The members an edit's refills rewrite in the edit's own removals statement, from the rows it redraws, and in its
		 * additions, from the rows they append, a stored one a put moves among them (FamilyRemovals and FamilyAdditions
		 * `riders`). */
		const ridersOf = (member: StoredRelationName): ReadonlyArray<StoredRelationName> =>
			[...starts].flatMap(([rider, x]) => (x.edit === member ? [rider] : []))
		/** The members an additions statement's refills rewrite (FamilyAdditions `riders`): its edit's riders, and, where the
		 * stratum puts `member`, every member relation of a counted family it owns, whose copies of a moved row's counts and
		 * ends follow the row as the additions insert it again, which no cascade does: a recount of the row by another
		 * statement of the stratum, which may run while the row is absent, reaches them only there. */
		const appendRidersOf = (member: StoredRelationName): ReadonlyArray<StoredRelationName> => [
			...new Set([
				...ridersOf(member),
				...(by(["put"]).includes(member)
					? families.flatMap((f) =>
							f.owner.name === member && !isSequence(f) ? [f.member.name] : []
						)
					: [])
			])
		]
		/** The plain relations whose puts a removals statement's refills read the facts of, which it runs before: its own
		 * member's, and every rider's it rewrites. */
		const refilledFromOf = (member: StoredRelationName): ReadonlyArray<StoredRelationName> => [
			...new Set([
				...(putRefilled.get(member) ?? []),
				...ridersOf(member).flatMap((rider) => starts.get(rider)?.puts ?? [])
			])
		]
		/** A rider's rows as a family statement rewrites them (schedule.ts RowChanges): at the columns each of its families
		 * draws on it, as the statement draws them again (write/program/compile.ts ridersOf), its own tree's aside. */
		const riderChanges = (rider: StoredRelationName) => ({
			relation: rider,
			changes: generating(
				memberFamilies(rider, families).flatMap((f) =>
					isTreeOf(f, rider)
						? []
						: familyDrawn(laws.theory.fill, rider, f).map((c) => columnKey(c.column))
				),
				generatedOf(rider)
			)
		})
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
		const removalEdits = (member: StoredRelationName): NonEmptyReadonlyArray<RemovalEdit> =>
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
						f.shape.kind !== "tree" &&
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
						f.shape.kind !== "tree" &&
						put.some((o) => o.relation === f.owner.name)
				)
			)
		/** The owners `member`'s additions draw: every family's of its slots, a counted family's of its nested rows. */
		const drawnOwners = (member: StoredRelationName) =>
			ownersOfFamilies(
				memberFamilies(member, families).filter(
					(f) => !isTreeOf(f, member) && (slotted.includes(member) || !isSequence(f))
				)
			)
		/**
		 * The rows of `owner` the stratum inserts as the family statement that appends `statement` reads its owner copies
		 * from them (`OwnerReading`). A stamp is taken once in its stratum, by the statement that writes the rows carrying it
		 * (ir/instant.ts stampText, write/family/additions.ts stampedSources), so a statement holds an owner's stamped
		 * columns only where it appends the owner itself, and then reads the owner's rows as it appends them, each source it
		 * appends them from with the stamps it takes of it (`RowsOf` appended); any other statement reads them as the host
		 * sends them, without a stamp (`RowsOf` sent).
		 */
		const ownerReadingOf = (
			owner: StoredRelationName,
			statement: ReadonlyArray<StoredRelationName>
		): OwnerReading => {
			if (
				placedByStratum.some(
					(p) =>
						p.stratum === stratum &&
						p.built.some(
							(b) =>
								b.action.relation === owner &&
								b.action.op !== "delete" &&
								b.action.source.kind !== "enumerated"
						)
				)
			) {
				return { kind: "described" }
			}
			const rows = rowsOf(stratum, owner)
			const sources: ReadonlyArray<OwnerSourceRead> = statement.includes(owner)
				? rows.appended.map((r) => ({
						source: r.source,
						holds: [...r.holds, ...r.stamps.map((st) => columnKeyOf(st.field.name))]
					}))
				: rows.sent.map((r) => ({ source: r.source, holds: r.holds }))
			return isNonEmpty(sources) ? { kind: "sources", sources } : { kind: "none" }
		}
		/** Where an owner copy of `f` reads the owner column `to` (schedule.ts CopySource), its owner's rows `reading` as
		 * its statement reads them: held where every source of them holds the group's fields and the columns that hold
		 * `to` (`heldBy`). */
		const copySource = (f: Family, to: NativeColumn, reading: OwnerReading): CopySource => {
			switch (reading.kind) {
				case "none":
					return "stored"
				case "described":
					return "drawn"
				case "sources": {
					const need = [...f.group.map((g) => columnKeyOf(g.owner.name)), ...heldBy(f.owner, to)]
					return reading.sources.every((s) => need.every((k) => s.holds.includes(k)))
						? "held"
						: "drawn"
				}
			}
		}
		/** The owner copies `member`'s additions draw, each with where it reads its owner's column (schedule.ts
		 * OwnerCopy), each owner's rows as `readingOf` gives them: every family's of its slots', a counted family's of its
		 * nested rows', but its own tree's. */
		const ownerCopiesOf = (
			member: StoredRelationName,
			readingOf: (owner: StoredRelationName) => OwnerReading
		): ReadonlyArray<OwnerCopy> =>
			memberFamilies(member, families).flatMap((f) =>
				isTreeOf(f, member) || (!slotted.includes(member) && isSequence(f))
					? []
					: defined(
							laws.theory.fill.layouts.get(layoutKey(member, { kind: "member", family: f })),
							`the fill layout of ${member} as a member of ${f.id.owner}.${f.id.count}`
						).columns.flatMap((c): ReadonlyArray<OwnerCopy> =>
							c.rule.kind === "ownerCopy" && familyKey(c.rule.family.id) === familyKey(f.id)
								? [
										{
											family: familyKey(f.id),
											owner: f.owner.name,
											column: columnKey(c.column),
											source: copySource(f, c.rule.to, readingOf(f.owner.name))
										}
									]
								: []
						)
			)
		/**
		 * The member relations the stratum appends, each statement's: one apiece, but the relations whose appended rows a
		 * nesting stamps from one head or fills from one computed record, which one statement writes so the head is stamped
		 * once and the record evaluated once (write/family/nesting.ts Nesting `stamps`), each set in the order `appended`
		 * names its first.
		 */
		const stampedTogether = (
			appended: ReadonlyArray<StoredRelationName>
		): ReadonlyArray<NonEmptyReadonlyArray<StoredRelationName>> => {
			const headsOf = (member: StoredRelationName): ReadonlySet<string> =>
				new Set(
					nestedWrites.flatMap((n) =>
						n.stratum === stratum
							? (n.nesting.stamps.get(member) ?? []).map((st) => stampText(st.stamp))
							: []
					)
				)
			const sets: Array<{ members: Array<StoredRelationName>; heads: Set<string> }> = []
			for (const member of appended) {
				const heads = headsOf(member)
				const joined = sets.filter((x) => [...heads].some((h) => x.heads.has(h)))
				const into = {
					members: [...joined.flatMap((x) => x.members), member],
					heads: new Set(heads)
				}
				for (const x of joined) {
					for (const h of x.heads) {
						into.heads.add(h)
					}
					sets.splice(sets.indexOf(x), 1)
				}
				sets.push(into)
			}
			return sets.flatMap((x) => {
				const [first, ...rest] = x.members
				return first === undefined ? [] : [[first, ...rest] as const]
			})
		}
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
				refilledFrom: refilledFromOf(member),
				riders: ridersOf(member).map(riderChanges)
			})),
			...stampedTogether(adding).map((members) => {
				const owners = members.flatMap((member) => {
					const drawn = drawnOwners(member)
					return [
						...drawn,
						...putOf(member).filter((o) => !drawn.some((d) => d.relation === o.relation))
					]
				})
				/** Each owner's rows as this statement reads them, read once. */
				const readings = new Map<StoredRelationName, OwnerReading>()
				const ownerCopies = members.flatMap((member) =>
					ownerCopiesOf(member, (owner) =>
						readings.getOrInsertComputed(owner, () => ownerReadingOf(owner, members))
					)
				)
				return {
					kind: "additions" as const,
					appends: "rows" as const,
					members,
					copies: [...new Set(ownerCopies.flatMap((c) => (c.source === "drawn" ? [c.owner] : [])))],
					ownerCopies,
					held: [...readings].flatMap(([owner, reading]): ReadonlyArray<HeldOwner> =>
						reading.kind === "sources" &&
						ownerCopies.some((c) => c.owner === owner && c.source === "held")
							? [{ owner, rows: mapNonEmpty(reading.sources, (s) => s.source) }]
							: []
					),
					owners: [...groupBy(owners, (o) => o.relation)].map(([relation, changed]) => ({
						relation,
						changes: [...new Set(changed.flatMap((o) => o.changes))]
					})),
					riders: [...new Set(members.flatMap(appendRidersOf))].map(riderChanges)
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

	/** The relation whose delta a read-back's Delta of `name` is: its own, or a writable query entry's target. */
	const deltaTarget = (name: string): string => {
		const world = checked.world
		if (world.kind === "reality") {
			return name
		}
		const held = world.role.relations[name]
		const write = world.writes.get(name)
		return held === undefined || held.kind === "whole" || write?.kind !== "rows"
			? name
			: write.writable.target.name
	}
	/** Each delta a read-back names, by its relation, with the relations the read-back reads as state. */
	const deltaReads = readBacks.flatMap((r) =>
		r.deltas.map((d) => ({ delta: deltaTarget(d.relation), state: r.root.meta.reads }))
	)

	/**
	 * A stratum's unit delete whose rows a query states, refused where a write of the stratum that runs before it, a
	 * removal of rows that reference its rows immediately, writes a relation the query reads: every member reads the state
	 * before its stratum, which the query would no longer read.
	 */
	const refuseUnitReadAfterWrites = (
		schedule: Extract<Schedule<Built & { readonly meeting: Meeting }>, { readonly kind: "ordered" }>
	): void => {
		const placed = schedule.family.findIndex(({ node }) => node.kind === "unit")
		const unit = schedule.family[placed]
		const node = unit?.node
		if (unit === undefined || node?.kind !== "unit") {
			return
		}
		const written = new Set([
			...schedule.actions.slice(0, unit.at).map((a) => a.scheduled.action.relation),
			...schedule.family.slice(0, placed).flatMap((f) => familyNodeRelations(f.node))
		])
		for (const u of node.units) {
			const read =
				u.source.kind === "described"
					? u.source.node.meta.reads.find(
							(r) => written.has(r) || (!base.relations.has(r) && written.size > 0)
						)
					: undefined
			if (read !== undefined) {
				refuse(
					"UnsupportedOperation",
					at,
					`a delete of ${u.relation.name} from a query that reads ${read}, beside a removal of rows that reference its rows, which runs before it and writes what the query reads: state ${u.relation.name}'s rows as an array, or write the removal in another stratum (ChangeSet.sequence)`
				)
			}
		}
	}

	/** 4. Schedule, with the final sources: a stratum whose actions an immediate key orders in a cycle is refused,
	 * since no order of its statements keeps every key at every statement. A read-back over a delta rides the statement
	 * that makes it where the state it reads is settled there, and is carried to the end of the write otherwise
	 * (write/schedule/plan.ts placeReadBacks); the statement sees only the state earlier statements wrote: where the
	 * stratum's order runs a delta's relation before a relation the same read-back reads as state, the stratum is ordered
	 * again with that delta's relation after every action no key orders before it (schedule.ts canonicalActionOrder), so
	 * the read-back rides with no carrier, and any other stratum keeps its order. */
	const strata = placedByStratum.map(({ stratum, built, outside }): WriteStratum => {
		const scheduleOf = (last: ReadonlySet<string>) =>
			scheduleStratum(
				canonicalActionOrder(
					built.map((b) => ({ ...b, meeting: meetingOf(b.info.relation) })),
					last
				),
				familyNodesOf(stratum),
				references
			)
		const natural = scheduleOf(new Set())
		const order: ReadonlyArray<string> =
			natural.kind === "cycle" ? [] : natural.actions.map((a) => a.scheduled.action.relation)
		const late = new Set(
			deltaReads.flatMap(({ delta, state }) => {
				const made = order.lastIndexOf(delta)
				return made >= 0 && state.some((s) => s !== delta && order.lastIndexOf(s) > made)
					? [delta]
					: []
			})
		)
		const schedule = late.size === 0 ? natural : scheduleOf(late)
		if (schedule.kind === "cycle") {
			throw new Refusal(
				CompileError.make({
					_tag: "UnorderableStratum",
					at,
					cycle: mapNonEmpty(schedule.cycle, (w) =>
						w.kind === "action"
							? { relation: w.action.action.relation, op: w.action.action.op }
							: w.node.kind === "unit"
								? { relation: w.node.units[0].relation.name, op: "delete" }
								: familyWriteAt(w.node)
					)
				})
			)
		}
		refuseUnitReadAfterWrites(schedule)
		return Object.freeze({
			actions: Object.freeze(
				schedule.actions.map(({ scheduled, dependsOn }): Action<ActionInfo> =>
					Object.freeze({ ...scheduled.action, dependsOn, info: scheduled.info })
				)
			),
			outside,
			checks: Object.freeze(memberChecks.flatMap((c) => (c.stratum === stratum ? [c.check] : []))),
			family: Object.freeze(schedule.family)
		})
	})

	/** 5. Evidence: the transaction context. */
	const analyzed = (structure: ValidDag): LogicalAnalysis =>
		unwrap(analyzeLogical(structure, transactionEvidence(laws), keptNodes([])))
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
		| { readonly kind: "relation"; readonly relation: string; readonly via: Via }
		| { readonly kind: "empty"; readonly name: string }
	const deltaOf = (name: string): DeltaOf => {
		const world = checked.world
		if (world.kind === "reality") {
			return { kind: "relation", relation: name, via: wholeVia }
		}
		const held = world.role.relations[name]
		if (held === undefined || held.kind === "whole") {
			return { kind: "relation", relation: name, via: wholeVia }
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
	/** The relations a family write writes through its families' statements: every relation of a unit delete's units,
	 * every reached family's member, a tree's relation among them, every edited member relation, and the owners of its
	 * families, whose count statements return only their keys, counts and ends. Their statements return no delta a
	 * read-back rides, so no read-back names their deltas. */
	const stratumRefills = occupied.flatMap(([stratum, { s }]) => {
		const refill = refills.get(s)
		return refill === undefined ? [] : [Object.freeze({ stratum, refill })]
	})
	const nestedRelations = new Set<string>([
		...unitsByStratum.flatMap(({ units, below }) => [
			...units.map((u) => u.relation.name),
			...below.map((b) => b.relation.name)
		]),
		...nestedWrites.flatMap((n) => [...n.nesting.layouts.keys()]),
		...edits.map((e) => e.relation),
		...families
			.filter((f) => edits.some((e) => e.relation === f.member.name))
			.map((f) => f.owner.name),
		...stratumRefills.flatMap(({ refill }) => [
			...refill.members.keys(),
			...refill.families.flatMap((f) => (isNonEmpty(endColumns(f)) ? [f.owner.name] : []))
		])
	])
	/** The strata that write a family's members: one at most, and a refill only in the first, beside every edit of a
	 * family's members. Each stratum's family statements draw from the state the strata before it leave, which no
	 * property of grizzle's holds to a write's model beside another stratum's family writes yet. */
	const editingStrata = new Set(edits.map((e) => e.stratum))
	if (editingStrata.size > 1) {
		refuse(
			"UnsupportedOperation",
			at,
			"family members written in more than one stratum: grizzle writes a ChangeSet's family members in one stratum, so write them all there"
		)
	}
	const refilledAt = stratumRefills.find(
		({ stratum }) => stratum > 0 || edits.some((e) => e.stratum !== stratum)
	)
	if (refilledAt !== undefined) {
		refuse(
			"UnsupportedOperation",
			at,
			`a change in stratum ${refilledAt.stratum} that refills the families ${refilledAt.refill.families.map((f) => `${f.id.owner}.${f.id.count}`).join(", ")}, beside an earlier stratum or family members written in another: grizzle refills a family only in a ChangeSet's first stratum, beside every family member it writes, so make the change there`
		)
	}
	const stratumEdits: ReadonlyArray<StratumEdit> = [
		...groupBy(edits, (e) => `${e.stratum}\u0000${e.relation}`)
	].map(([, list]): StratumEdit => {
		const first = list[0]
		return Object.freeze({
			stratum: first.stratum,
			relation: writtenOf(first.relation, at),
			slots: editSlotOps.flatMap(([op, as]) =>
				list
					.flatMap((e): ReadonlyArray<EditSlot> =>
						e.write.op === op ? [{ as, slot: e.write.slot, stamps: e.write.stamps }] : []
					)
					.slice(0, 1)
			)
		})
	})
	const classified = readBacks.flatMap((r) =>
		r.deltas.map((d) => ({ read: r.name, delta: d, side: d.side, of: deltaOf(d.relation) }))
	)
	/** The roots of the stamped nestings, whose rows their family statements insert with their members', returning them as
	 * an insert returns its rows, so a read-back of their delta rides that statement (write/schedule/plan.ts
	 * placeReadBacks); every other relation of a family write is read after the change. */
	const readableRoots = new Set<string>(
		nestedWrites.flatMap(({ nesting }) =>
			nesting.root.kind === "plain" &&
			nesting.stamps.has(nesting.relation.name) &&
			!families.some((f) => f.member.name === nesting.relation.name)
				? [nesting.relation.name]
				: []
		)
	)
	for (const { read, delta, side, of } of classified) {
		if (
			of.kind === "relation" &&
			nestedRelations.has(of.relation) &&
			!readableRoots.has(of.relation)
		) {
			refuse(
				"UnsupportedOperation",
				childLoc(at, "reads", read),
				`a delta of ${delta.relation}, which a family write writes through its family's statements: read ${delta.relation} itself after the change`
			)
		}
		const met =
			side === "met" && of.kind === "relation" ? base.relations.get(of.relation) : undefined
		if (met !== undefined) {
			refuseUnmet(met, childLoc(at, "reads", read), managed)
		}
	}
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
			via: throughEntry === undefined ? wholeVia : throughEntry.via
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

	const slotParams = slots.flatMap((g) => g.inputs.map((i) => i.slot.slot))
	const userParams = sourcedParams(
		unwrap(
			clockParams(
				[...params.values()].toSorted(
					Order.mapInput(Order.compareStrings, (p: ParamDecl) => p.name)
				),
				clock,
				"clocked"
			)
		),
		options.source
	)
	const drafted: Drafted = {
		strata,
		reads,
		params: Object.freeze([...userParams.map((p) => p.id), ...slotParams]),
		bound: boundInputs
	}
	/**
	 * The queries over the analyzed DAG, each node the frontend built read as its annotated counterpart, over the write
	 * DAG as its lowering reads it (ir/derived.ts servedDag): every derived relation a member, a read-back or a fill reads
	 * from its table where this schema reads its table (analysis/schema.ts CheckedSchema serves) and its definition reads
	 * none of the relations the ChangeSet writes, through its definition otherwise, whose rows the write's own earlier
	 * statements change before its COMMIT's upkeep replaces that table.
	 */
	const rows = checked.rows(writtenRelations)
	const { dag, queries } = analyzedQueries(drafted, structural, rows, analyzed, (served) =>
		servedDerivations({
			schema: checked,
			rows,
			checked: structural,
			served,
			imports: merger.imports,
			member: "a served ChangeSet"
		})
	)
	/** The DAG the optimized artifact lowers: every take correlated through bind restated with its correlation explicit,
	 * as a query's is, so each is the probe of its parent (lower/shapes/take/decorrelate.ts), and analyzed alike. The rewrite reads the analyzed DAG's
	 * roots, every described source and read-back, and keeps every node's label; each node the queries name is read as
	 * the node standing in its place there. A DAG with no root restates nothing and names no node. Where the rewrite
	 * restates no take, it answers the query it was given (lower/shapes/take/decorrelate.ts everyParentTakes), whose
	 * DAG is `dag` itself, analyzed already: the logical analysis is idempotent, so analyzing it again states what it
	 * states (test/unit/analysis/logical/evidence.test.ts), and the optimized form is `dag`, each node its own, where
	 * the restatement analyzed the whole write DAG a second time (edullm's ledger's `evaluate`, 20,550 nodes and no take
	 * restated: 100 s for its analysis, then 181 s for the same claims again). Then its constant columns are read through
	 * (lower/optimize/propagate propagatedWrite), its leaves through the write's producers (writeProducers), which leaves
	 * a DAG it edits nothing of as it is. The conservative realization lowers `dag`, as checked, so the write oracle reads
	 * the pass's restrictions and substitutions against the DAG without them. */
	/**
	 * The DAG the write's statements are restated in, its takes correlated through bind restated over every parent
	 * (lower/shapes/take/decorrelate.ts everyParentTakes) and analyzed, and each root of the analyzed DAG, every node the
	 * write names, at its place there, as data: the rewrite, the restatement's analysis and its judged twin are read in
	 * this frame alone, so none is alive once it returns, nor any fold of theirs, where the counterpart the restated
	 * queries were read through held all three until the compile's end. Where the rewrite restates no take, the DAG is
	 * the analyzed one and each root its own.
	 */
	const restatedRoots = (analyzedRoots: NonEmptyReadonlyArray<RelNode>): Restated => {
		const input = { dag: rooted(analyzedRoots), params: userParams }
		const takes = unwrap(everyParentTakes(input))
		if (takes.query === input) {
			return { dag, at: new Map(analyzedRoots.map((root) => [root, root] as const)) }
		}
		const again = analyzed(takes.query.dag)
		const againJudged = judgedAsDelivered(again.dag)
		return {
			dag: againJudged.dag,
			at: new Map(
				analyzedRoots.map(
					(root) => [root, againJudged.of(again.of(takes.node(root)).node)] as const
				)
			)
		}
	}
	const roots = dag.roots
	const restatement = ((): Restatement => {
		if (!isNonEmpty(roots)) {
			return { restated: queries, restate: new Map() }
		}
		const named: Drafted = {
			strata: queries.ir.strata,
			reads: queries.ir.reads,
			params: queries.ir.params,
			bound: queries.ir.bound
		}
		/**
		 * The restated DAG with every key the write's statements fix at a parameter bound where it is read, and every
		 * reference to a column holding a parameter reading it (lower/optimize/propagate propagatedWrite), as a query's
		 * optimized lowering binds them: each node the queries name read as the node standing in its place there.
		 */
		const propagated = (restated: Restated): Restatement => {
			const through = (node: RelNode): RelNode =>
				defined(restated.at.get(node), "a node a write names, a root of its analyzed DAG")
			const done = propagatedWrite(restated.dag, writeProducers(named.strata, through))
			return restatedIn(named, done.dag, (node) => done.node(through(node)))
		}
		return propagated(restatedRoots(roots))
	})()

	return Object.freeze({
		...queries,
		...restatement,
		desc: Object.freeze({
			strata: Object.freeze(
				strataMembers.map((members) =>
					Object.freeze({
						members: Object.freeze(members.map((m) => m.planned))
					})
				)
			),
			reads: desc.reads,
			bindings: desc.bindings,
			boundRows: desc.boundRows
		}),
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
				group.inputs.map(
					(input) => [input.slot.slot, Object.freeze({ group, input, slot: input.slot })] as const
				)
			)
		),
		nested: Object.freeze(nestedWrites),
		edits: stratumEdits,
		fresh: new Map(placedByStratum.map(({ stratum }) => [stratum, freshFillOf(stratum)] as const)),
		refills: Object.freeze(stratumRefills),
		deltas: Object.freeze(namedDeltas),
		references: Object.freeze(references),
		deltaEntries,
		codes,
		evaluate,
		computed: Object.freeze(
			occupiedStrata.flatMap(([stratum, s]) =>
				[...defined(strataComputed[s], "a writing stratum's computed records")].map(
					([relation, record]) => Object.freeze({ stratum, relation, record })
				)
			)
		)
	})
}
