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
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { FillAt } from "#compiler/ir/fill.ts"
import type { ColumnKey, FamilyId } from "#compiler/ir/law.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { type ColumnIndex, columnIndex } from "#compiler/runtime/write/cells.ts"
import {
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

/** A family as a row of it past every statement is reported by (bind.ts FamilyRowBound): its owner relation, its count
 * field and its member relation, by name. */
export interface FamilyNames {
	readonly owner: StoredRelationName
	readonly count: string
	readonly member: StoredRelationName
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
	/** Each relation a nested write fills, by name, as the first family it is a member of names it, which a row of it no
	 * statement carries even alone is reported by. */
	readonly rowFamilies: ReadonlyMap<StoredRelationName, FamilyNames>
	/** Which facts of each member slot the statement that writes them proposes (insert/statement.ts Proposal). */
	readonly proposals: ReadonlyMap<ParamId, Proposal>
	/** Each stratum whose fresh owners the host counts, in order. */
	readonly fresh: ReadonlyArray<FreshStratum>
	/** Each relation whose stated rows are judged, by name. */
	readonly judged: ReadonlyMap<StoredRelationName, JudgedRelation>
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
	const evaluate = hostEvaluator(
		closedLeaf(closedIndexOf(closedNamed(binding.evaluation.closed, closed))),
		patterns
	)
	const columns = columnIndex()
	return Object.freeze({
		evaluate,
		fill: filler(binding.fill, codes, evaluate, columns),
		columns,
		groups: binding.groups.map((g) => bindGroup(g, codes)),
		witness: prepareWitness(binding.witness, binding.groups, codes, closed, patterns)
	})
}
