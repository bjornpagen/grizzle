/**
 * A compiled write's binding: what binding one application of it reads besides the call's own values (write/program/
 * bind.ts bindWrite), every judgment it would otherwise take from the law model decided once, when the write compiles
 * (write/program/decide.ts decideBinding), and carried in the program as plain data. Binding reads the program and the
 * call's values, and never the law model: what a stratum's appends fill, which facts each slot's statement proposes,
 * and which columns of a written relation are a counted family's count or end.
 */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { MemberDesc } from "#compiler/ir/desc.ts"
import type { ExprTable, TypedLiteral } from "#compiler/ir/expr.ts"
import type { FillAt } from "#compiler/ir/fill.ts"
import type { ColumnKey, FamilyId } from "#compiler/ir/law.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { type ColumnIndex, columnIndex } from "#compiler/runtime/write/cells.ts"
import {
	type CallEvaluator,
	callEvaluator,
	closedIndexOf,
	closedLeaf,
	closedNamed,
	type ClosedTable,
	type Evaluation,
	type Filler,
	filler,
	type HostEvaluator,
	hostEvaluator,
	type HostFill,
	type StatementFills
} from "#compiler/runtime/write/fill.ts"
import type { LaidLayout, NestedLayoutData } from "#compiler/runtime/write/nesting.ts"
import { type BindGroup, bindGroup, type GroupData } from "#compiler/runtime/write/normalize.ts"
import {
	prepareWitness,
	type WitnessData,
	type Witnessing
} from "#compiler/runtime/write/witness.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import type { DrawnBy } from "#compiler/types/changeset/changeset.ts"
import type { Proposal } from "#compiler/write/insert/statement.ts"

/**
 * A counted family as binding reads it: its id, its owner and member relations by name, its count and its ends, the
 * accumulated fields its last axis carries, by name, and its group, each member field with the owner key field it pairs
 * with, in key order.
 */
export interface CountedFamily {
	readonly id: FamilyId
	readonly owner: StoredRelationName
	readonly member: StoredRelationName
	readonly count: string
	readonly ends: ReadonlyArray<string>
	readonly group: NonEmptyReadonlyArray<{
		readonly member: HeadingColumn
		readonly owner: HeadingColumn
	}>
}

/**
 * A member slot whose facts hold rows of a counted family's owner or of its member, as the call's read names their
 * groups (FamilyShares): for each pair of the family's group the shares key, the field of a fact's top level, as the
 * call's read holds it (runtime/write/read-call.ts SlotReads `field`), whose value every row of the relation the fact
 * holds has at the pair's field: the row's own field, where the fact is the row, or the field the row's nesting copies
 * down to it unchanged along its families' groups, a tree's root field at every node.
 */
interface GroupHolder {
	readonly slot: string
	readonly fields: ReadonlyArray<string>
}

/**
 * A counted family's groups as a call's facts name them (adapter/apply/shares.ts drawShares): each slot whose facts hold
 * rows of its owner and each whose facts hold rows of its member, with the fields that name, in every such fact alike,
 * the pairs of its group each of those slots' facts holds a field of (write/program/decide.ts familyShares). A pair some
 * slot's facts hold no field of, a key field its walk draws, as a tree node's `start`, or one the call computes, is no
 * part of the key, so the facts are grouped coarser and never apart: every fact that holds a row of one group holds
 * one key. Where no pair is held, every fact of the family is one group.
 */
export interface FamilyShares {
	readonly owners: ReadonlyArray<GroupHolder>
	readonly members: ReadonlyArray<GroupHolder>
}

/**
 * A column of an owner's row that one of its counted families draws: the family's count, or one of its ends, an
 * accumulated field, at its `start` while the family is empty.
 */
export type OwnedColumn =
	| { readonly kind: "count"; readonly family: CountedFamily }
	| {
			readonly kind: "end"
			readonly family: CountedFamily
			readonly name: string
			readonly type: ScalarType
			readonly start: TypedLiteral
	  }

/**
 * A relation the ChangeSet writes as its stated rows are judged (runtime/write/witness.ts JudgedRow): the fields a fact
 * of it states, its caller's, by name; its primary key's fields, by name; its row layout
 * (write/family/statements.ts rowLayout); and each column of it a counted family it owns draws, by column key, the first
 * family in the law model's order that draws it.
 */
export interface JudgedRelation {
	readonly stated: ReadonlyArray<string>
	readonly primary: NonEmptyReadonlyArray<string>
	readonly layout: LaidLayout
	readonly owned: ReadonlyMap<ColumnKey, OwnedColumn>
}

/**
 * Where a stratum's nested writes stand an owner's rows: at their position in the walk, whose counts and ends its fill
 * draws there, or nowhere, when no nested write of the stratum fills the owner.
 */
export type NestedOwner =
	| { readonly kind: "none" }
	| { readonly kind: "at"; readonly position: FillAt }

/** An owner a stratum's appends may count: the slots whose facts insert it, and where the stratum's nested writes
 * stand its rows. A sequence's member is only ever inserted nested, so it inserts from no slot. */
export interface FreshOwner {
	readonly inserting: ReadonlyArray<ParamId>
	readonly nested: NestedOwner
}

/**
 * A stratum with family statements, as its fresh groups are drawn on the host (runtime/write/bind.ts freshOwners): the
 * member slots its edits append from, each with its relation; every counted family whose member relation its appends
 * or nested writes reach, in the law model's order, of which an application counts those its members name, with the
 * fresh layout its fresh groups' members are sent in; and each owner of those families, by name.
 */
export interface FreshStratum {
	readonly stratum: StratumAt
	readonly appended: ReadonlyArray<{
		readonly relation: StoredRelationName
		readonly slot: ParamId
	}>
	readonly counted: ReadonlyArray<CountedFamily>
	/** Each counted family's fresh layout (write/program/decide.ts freshLayoutOf), by the family's key: its fresh groups'
	 * members, the stratum's fresh fills draw, as its additions statement reads them. */
	readonly fresh: ReadonlyMap<string, LaidLayout>
	/** Each counted family of `counted`, as the call's facts name its groups (FamilyShares), by the family's key: what a
	 * call drawn in shares holds whole in one share. */
	readonly shares: ReadonlyMap<string, FamilyShares>
	readonly owners: ReadonlyMap<StoredRelationName, FreshOwner>
	/** The columns of each relation's rows its fresh fills leave to the statement that writes them, their stamps' and
	 * every generated field over one (write/frontend/compile.ts FreshFill `left`): no row the host holds holds one, and a
	 * group field among them is the call's one value on both sides of its family, which no host match reads. */
	readonly left: StatementFills
}

/**
 * An array or Stream member of the ChangeSet, as its call's facts reach it: the name of the member slot its facts travel
 * in, its stratum and operation, the relation its facts are of as the ChangeSet names it, and how they travel.
 */
export interface MemberAt {
	readonly slot: string
	readonly stratum: number
	readonly op: MemberDesc["op"]
	readonly relation: string
	readonly kind: "array" | "stream"
}

/**
 * Whether a write's facts may be drawn in shares by its shape (adapter/apply/shares.ts drawShares, which adds that its
 * call of no facts sends no statement): every member an array of inserted facts, all in one stratum, and no relation
 * parameter, so a share's statements are the call's over that share's facts alone. The one statement of it, which the
 * draw and the compile's check of the laws a share is judged by (write/program/decide.ts sharedChecksBacked) both read.
 */
export const drawableShape = (
	members: ReadonlyArray<MemberAt>,
	params: ReadonlyArray<{ readonly kind: string }>
): boolean =>
	members.length > 0 &&
	members.every((m) => m.op === "insert" && m.kind === "array") &&
	new Set(members.map((m) => m.stratum)).size === 1 &&
	params.every((p) => p.kind !== "relation")

/**
 * The fields of a relation's host rows one stratum's insert computes (ir/instant.ts Computed, ChangeSet.insertAllComputed),
 * each by its name and its type with its term, which reads the call alone, its declared parameters, its clock and
 * literals, lowered as the host evaluator reads it: the host evaluates each once a call (runtime/write/bind.ts
 * computedValues), so the rows its write states hold the value every row of the call holds there, as the statement
 * that writes them fills it, and a refusal of one is witnessed by its whole key. A term the host does not evaluate, one
 * reading the call's clock among them, leaves its field to the statement, and a witness names it by its `source`.
 */
export interface ComputedFields {
	readonly stratum: StratumAt
	readonly relation: StoredRelationName
	readonly fields: ReadonlyArray<{
		readonly name: string
		readonly type: ScalarType
		readonly term: ExprTable
		/** What supplies its value where the host does not evaluate its term (types/changeset DrawnBy): the database's
		 * clock where the term reads it, else the statement's evaluation of the call's term. */
		readonly source: Extract<DrawnBy, "clock" | "call">
	}>
}

/** Each relation whose rows one stratum's nested writes fill, by name, as the first of them that fills it lays it out. */
export interface NestedAt {
	readonly stratum: StratumAt
	readonly layouts: ReadonlyMap<StoredRelationName, NestedLayoutData>
}

/** A compiled write's binding (see the module's header). */
export interface Binding {
	/** Each array or Stream member of the ChangeSet, in its strata's order. */
	readonly members: ReadonlyArray<MemberAt>
	/** The slot groups, as normalization reads them (write/normalize/normalize.ts GroupData). */
	readonly groups: ReadonlyArray<GroupData>
	/** Each stratum's nested layouts, in the strata's order. */
	readonly nested: ReadonlyArray<NestedAt>
	/** Which facts of each member slot the statement that writes them proposes (insert/statement.ts Proposal). */
	readonly proposals: ReadonlyMap<ParamId, Proposal>
	/** Each stratum whose fresh owners the host counts, in order. */
	readonly fresh: ReadonlyArray<FreshStratum>
	/** Each relation whose stated rows are judged, by name. */
	readonly judged: ReadonlyMap<StoredRelationName, JudgedRelation>
	/** Each stratum's computed fields of each relation it inserts computing some (ComputedFields). */
	readonly computed: ReadonlyArray<ComputedFields>
	/** What the write's nested walks and fresh fills fill by: the layouts they meet. */
	readonly fill: HostFill
	/** What the fill's evaluator reads. */
	readonly evaluation: Evaluation
	/** What the host judges a refused statement's stated rows by (witness.ts WitnessData). */
	readonly witness: WitnessData
}

/** A binding's closures, built once from its data under the installation's codes: the host's evaluator, the filler the
 * write's nested walks and fresh fills fill by, and the column index every row of the write is laid out by. */
export interface PreparedBinding {
	readonly evaluate: HostEvaluator
	/** The evaluator of a computed field's term over the call (ComputedFields). */
	readonly evaluateCall: CallEvaluator
	readonly fill: Filler
	/** Each relation's columns, at the positions a row of it holds them (cells.ts ColumnIndex), which its filler, its
	 * binds and its preview share. */
	readonly columns: ColumnIndex
	/** The slot groups as normalization runs them (normalize.ts bindGroup). */
	readonly groups: ReadonlyArray<BindGroup>
	/** The witness of a refused statement (witness.ts prepareWitness). */
	readonly witness: Witnessing
}

/**
 * The closures of a binding (`PreparedBinding`), built once: where the write compiles, and where a served login loads
 * it, each from the binding's data, the installation's codes, its closed table and its table of the patterns its types
 * read, `patterns`, so none is parsed per row.
 */
export const prepareBinding = (
	binding: Binding,
	codes: Codebook,
	closed: ClosedTable,
	patterns: PatternReads
): PreparedBinding => {
	const leaf = closedLeaf(closedIndexOf(closedNamed(binding.evaluation.closed, closed)))
	const evaluate = hostEvaluator(leaf, patterns)
	const columns = columnIndex()
	return Object.freeze({
		evaluate,
		evaluateCall: callEvaluator(leaf, patterns),
		fill: filler(binding.fill, codes, evaluate, columns),
		columns,
		groups: binding.groups.map((g) => bindGroup(g, codes)),
		witness: prepareWitness(binding.witness, binding.groups, codes, closed, patterns)
	})
}
