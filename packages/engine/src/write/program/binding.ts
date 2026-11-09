/**
 * A compiled write's binding: what binding one application of it reads besides the call's own values (write/program/
 * bind.ts bindWrite), every judgment it would otherwise take from the law model decided once, when the write compiles
 * (write/program/decide.ts decideBinding), and carried in the program as plain data. Binding reads the program and the
 * call's values, and never the law model: what a stratum's appends fill, which facts each slot's statement proposes,
 * and which columns of a written relation are a counted family's count or end.
 */
import type { ParamId } from "#compiler/core/ids.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { FillPosition } from "#compiler/ir/fill.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { ColumnKey } from "#compiler/write/family/fold.ts"
import type { RowLayout } from "#compiler/write/family/statements.ts"
import type { Proposal } from "#compiler/write/insert/statement.ts"

/**
 * A column of an owner's row that one of its counted families draws: the family's count, or one of its ends, an
 * accumulated field, at its `start` while the family is empty.
 */
export type OwnedColumn =
	| { readonly kind: "count"; readonly family: Family }
	| {
			readonly kind: "end"
			readonly family: Family
			readonly name: string
			readonly type: ScalarType
			readonly start: TypedLiteral
	  }

/**
 * A relation the ChangeSet writes as its stated rows are judged (write/program/witness.ts JudgedRow): its row layout
 * (write/family/statements.ts rowLayout), and each column of it a counted family it owns draws, by column key, the first
 * family in the law model's order that draws it.
 */
export interface JudgedRelation {
	readonly layout: RowLayout
	readonly owned: ReadonlyMap<ColumnKey, OwnedColumn>
}

/**
 * Where a stratum's nested writes stand an owner's rows: at their position in the walk, whose counts and ends its fill
 * draws there, or nowhere, when no nested write of the stratum fills the owner.
 */
export type NestedOwner =
	| { readonly kind: "none" }
	| { readonly kind: "at"; readonly position: FillPosition }

/** An owner a stratum's appends may count: the slots whose facts insert it, and where the stratum's nested writes
 * stand its rows. A sequence's member is only ever inserted nested, so it inserts from no slot. */
export interface FreshOwner {
	readonly inserting: ReadonlyArray<ParamId>
	readonly nested: NestedOwner
}

/**
 * A stratum whose family statements run in the call's one flight, as its fresh owners' counts and ends are drawn on
 * the host (write/program/bind.ts freshOwners): the member slots its edits append from, each with its relation; every
 * counted family whose member relation its appends or nested writes reach, in the law model's order, of which an
 * application counts those its members name; and each owner of those families, by name.
 */
export interface FreshStratum {
	readonly stratum: StratumAt
	readonly appended: ReadonlyArray<{ readonly relation: string; readonly slot: ParamId }>
	readonly counted: ReadonlyArray<Family>
	readonly owners: ReadonlyMap<string, FreshOwner>
}

/** A compiled write's binding (see the module's header). */
export interface Binding {
	/** Which facts of each member slot the statement that writes them proposes (insert/statement.ts Proposal). */
	readonly proposals: ReadonlyMap<ParamId, Proposal>
	/** Each stratum whose fresh owners the host counts, in order. */
	readonly fresh: ReadonlyArray<FreshStratum>
	/** Each relation whose stated rows are judged, by name. */
	readonly judged: ReadonlyMap<string, JudgedRelation>
}
