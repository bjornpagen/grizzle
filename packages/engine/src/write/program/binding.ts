/**
 * A compiled write's binding: what binding one application of it reads besides the call's own values (write/program/
 * bind.ts bindWrite), every judgment it would otherwise take from the law model decided once, when the write compiles
 * (write/program/decide.ts decideBinding), and carried in the program as plain data. Binding reads the program and the
 * call's values, and never the law model: what a stratum's appends fill, which facts each slot's statement proposes,
 * and which columns of a written relation are a counted family's count or end.
 */
import type { ParamId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { FillAt } from "#compiler/ir/fill.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { ProgramPatterns } from "#compiler/scalar/regex/patterns.ts"
import {
	type ColumnKey,
	closedLeaf,
	type Evaluation,
	type Filler,
	filler,
	type HostEvaluator,
	type HostFill,
	hostEvaluator
} from "#compiler/write/family/fold.ts"
import type { NestedLayoutData } from "#compiler/write/family/nesting.ts"
import type { LaidLayout } from "#compiler/write/family/statements.ts"
import type { Proposal } from "#compiler/write/insert/statement.ts"
import { type BindGroup, bindGroup, type GroupData } from "#compiler/write/normalize/normalize.ts"
import {
	prepareWitness,
	type WitnessData,
	type Witnessing
} from "#compiler/write/program/witness.ts"

/**
 * A counted family as binding reads it: its id, its owner and member relations by name, its count and its ends, the
 * accumulated fields its last axis carries, by name, and its group, each member field with the owner key field it pairs
 * with, in key order.
 */
export interface CountedFamily {
	readonly id: FamilyId
	readonly owner: string
	readonly member: string
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
 * A relation the ChangeSet writes as its stated rows are judged (write/program/witness.ts JudgedRow): the fields a fact
 * of it states, its caller's and serial ones, by name; its primary key's fields, by name; its row layout
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
 * A stratum whose family statements run in the call's one flight, as its fresh owners' counts and ends are drawn on
 * the host (write/program/bind.ts freshOwners): the member slots its edits append from, each with its relation; every
 * counted family whose member relation its appends or nested writes reach, in the law model's order, of which an
 * application counts those its members name; and each owner of those families, by name.
 */
export interface FreshStratum {
	readonly stratum: StratumAt
	readonly appended: ReadonlyArray<{ readonly relation: string; readonly slot: ParamId }>
	readonly counted: ReadonlyArray<CountedFamily>
	readonly owners: ReadonlyMap<string, FreshOwner>
}

/**
 * An array or Stream member of the ChangeSet, as its call's facts reach it: the name of the member slot its facts travel
 * in, its stratum and operation, the relation its facts are of as the ChangeSet names it, and how they travel.
 */
export interface MemberAt {
	readonly slot: string
	readonly stratum: number
	readonly op: "insert" | "delete" | "put"
	readonly relation: string
	readonly kind: "array" | "stream"
}

/** Each relation whose rows one stratum's nested writes fill, by name, as the first of them that fills it lays it out. */
export interface NestedAt {
	readonly stratum: StratumAt
	readonly layouts: ReadonlyMap<string, NestedLayoutData>
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
	readonly judged: ReadonlyMap<string, JudgedRelation>
	/** What the write's nested walks and fresh fills fill by: the layouts they meet. */
	readonly fill: HostFill
	/** What the fill's evaluator reads. */
	readonly evaluation: Evaluation
	/** What the host judges a refused statement's stated rows by (witness.ts WitnessData). */
	readonly witness: WitnessData
}

/** A binding's closures, built once from its data under the installation's codes: the host's evaluator, and the filler
 * the write's nested walks and fresh fills fill by. */
export interface PreparedBinding {
	readonly evaluate: HostEvaluator
	readonly fill: Filler
	/** The slot groups as normalization runs them (normalize.ts bindGroup). */
	readonly groups: ReadonlyArray<BindGroup>
	/** The witness of a refused statement (witness.ts prepareWitness). */
	readonly witness: Witnessing
}

/**
 * The closures of a binding (`PreparedBinding`), built once: where the write compiles, and where a served login loads
 * it, each from the binding's data and the installation's codes alone, every pattern parsed here and none per row.
 */
export const prepareBinding = (binding: Binding, codes: Codebook): PreparedBinding => {
	const evaluate = hostEvaluator(
		codes,
		closedLeaf(binding.evaluation.closed),
		ProgramPatterns.of(binding.evaluation.patterns)
	)
	return Object.freeze({
		evaluate,
		fill: filler(binding.fill, codes, evaluate),
		groups: binding.groups.map((g) => bindGroup(g, codes)),
		witness: prepareWitness(binding.witness, binding.groups, codes)
	})
}
