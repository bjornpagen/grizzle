/**
 * Description-boundary vocabulary for the IR fixtures (packages/engine/src/ir/desc.ts).
 *
 * The fixtures state each worked example's schema as a SchemaDesc written out as data, the form the surface builders
 * record and ownership consumes. These helpers spell the descriptors and statements the way the
 * builders of packages/engine/src/schema emit them, so a fixture reads like its public-API form while staying plain IR: a
 * side's field term is its field's name and a pred term is pred(field), mirrors is its two containments, the
 * alternatives helper expands to both containments per arm, each carrying the origin marker, and a relation used in key
 * position stands for its primary key.
 */
import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { FieldId } from "#compiler/core/ids.ts"
import type * as Result from "#compiler/core/result.ts"
import {
	type AttachDesc as AttachOf,
	type BindingsDesc as BindingsOf,
	type BoundDesc,
	type ChangeSetDesc as ChangeSetOf,
	type WorkloadDesc as WorkloadOf,
	conjunctsOf,
	decodeDesc,
	everyFact,
	type ExprDesc,
	type ExprDesc as ExprOf,
	type FieldDesc,
	type HeadTermDesc as HeadTermOf,
	type LiteralDesc,
	type MatchDesc as MatchOf,
	type MemberDesc as MemberOf,
	type PgScalarName,
	type QueryDesc as QueryOf,
	type QueryStageDesc as QueryStageOf,
	type ReadBackDesc as ReadBackOf,
	type RelationDesc as RelationOf,
	type RuleDesc as RuleOf,
	type SchemaDesc as SchemaOf,
	type SideDesc,
	type SourceDesc as SourceOf,
	type StatementDesc as StatementOf,
	type TermDesc,
	type VarDesc as VarOf,
	type WeightDesc
} from "#compiler/ir/desc.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"

/** The authored form of each Description type with located nodes. */
export type AttachDesc = AttachOf<object>
export type BindingsDesc = BindingsOf<object>
export type ChangeSetDesc = ChangeSetOf<object>
export type WorkloadDesc = WorkloadOf<object>
export type AuthoredExprDesc = ExprOf<object>
export type HeadTermDesc = HeadTermOf<object>
export type MatchDesc = MatchOf<object>
export type MemberDesc = MemberOf<object>
export type QueryDesc = QueryOf<object>
export type QueryStageDesc = QueryStageOf<object>
export type ReadBackDesc = ReadBackOf<object>
export type AuthoredRelationDesc = RelationOf<object>
export type RuleDesc = RuleOf<object>
export type SchemaDesc = SchemaOf<object>
export type SourceDesc = SourceOf<object>
export type AuthoredStatementDesc = StatementOf<object>
export type VarDesc = VarOf<object>

/** A decoding's value; a refusal is thrown, as a test author's malformed description is a broken test. */
const decodedOrThrow = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw result.error
	}
	return result.value
}

/**
 * An authored schema, decoded as a JavaScript author's description is: every relation and statement it leaves
 * unlocated is located at its path in the description.
 */
export const decodedSchema = (desc: SchemaDesc): SchemaOf =>
	decodedOrThrow(decodeDesc("schema", desc))

/** The query of an authored stage, decoded as a JavaScript author's description is. */
export const decodedQuery = (stage: QueryStageDesc): QueryOf =>
	decodedOrThrow(decodeDesc("query", { stage }))

/**
 * An authored ChangeSet member or read-back, decoded as the production path decodes one: inside its ChangeSet, which
 * locates it at its place in the ChangeSet.
 */
const decodedChangeSet = (
	members: ReadonlyArray<MemberDesc>,
	reads: ReadonlyArray<ReadBackDesc>
): ChangeSetOf =>
	decodedOrThrow(
		decodeDesc("changeSet", { schema: "Test", strata: [{ members }], reads, bindings: [] })
	)

export const decodedMember = (member: MemberDesc): MemberOf => {
	const [decoded] = decodedChangeSet([member], []).strata[0]?.members ?? []
	if (decoded === undefined) {
		throw new Error("a decoded ChangeSet keeps its one member")
	}
	return decoded
}

export const decodedReadBack = (readBack: ReadBackDesc): ReadBackOf => {
	const [decoded] = decodedChangeSet([], [readBack]).reads
	if (decoded === undefined) {
		throw new Error("a decoded ChangeSet keeps its one read-back")
	}
	return decoded
}

const fieldDesc = (desc: FieldDesc): FieldDesc => desc

/** Field descriptors. */
export const f = {
	pg: (type: PgScalarName): FieldDesc => ({ kind: "pg", type }),
	smallint: fieldDesc({ kind: "pg", type: "smallint" }),
	integer: fieldDesc({ kind: "pg", type: "integer" }),
	bigint: fieldDesc({ kind: "pg", type: "bigint" }),
	boolean: fieldDesc({ kind: "pg", type: "boolean" }),
	numeric: (precision: number, scale: number): FieldDesc => ({ kind: "numeric", precision, scale }),
	bigserial: fieldDesc({ kind: "serial", type: "bigserial" }),
	uuid: fieldDesc({ kind: "uuid" }),
	regex: (source: string, flags: "u" | "su"): FieldDesc => ({ kind: "text", source, flags }),
	/** str.regex("^.*$", "su"): the explicit wildcard. */
	wildcard: fieldDesc({ kind: "text", source: "^.*$", flags: "su" }),
	/** A contract that declares no fact its predicate proves, as contract(name, base, predicate) without `proves`. */
	contract: (name: string, base: FieldDesc, predicate: ExprDesc | undefined): FieldDesc => ({
		kind: "contract",
		name,
		base,
		predicate,
		facts: []
	}),
	span: (endpoint: FieldDesc, width: bigint | undefined): FieldDesc => ({
		kind: "span",
		endpoint,
		width
	}),
	closedId: (roster: string): FieldDesc => ({ kind: "closedId", roster })
} as const

/** Contract predicate terms: the domain's VALUE and typed literals. */
export const value: ExprDesc = { kind: "value" }
export const literal = (v: LiteralDesc): ExprDesc => ({
	kind: "literal",
	value: v,
	type: undefined
})

/**
 * The comparisons a contract predicate, a law and a filter share, in the form of their operands: located, as a
 * contract predicate's field descriptor holds them, or authored to be decoded, as the checker's tests state a filter.
 */
export const ge = <L>(left: ExprOf<L>, right: ExprOf<L>): ExprOf<L> => ({
	kind: "compare",
	op: "ge",
	left,
	right
})

export const le = <L>(left: ExprOf<L>, right: ExprOf<L>): ExprOf<L> => ({
	kind: "compare",
	op: "le",
	left,
	right
})

export const ne = <L>(left: ExprOf<L>, right: ExprOf<L>): ExprOf<L> => ({
	kind: "compare",
	op: "ne",
	left,
	right
})

export const eq = <L>(left: ExprOf<L>, right: ExprOf<L>): ExprOf<L> => ({
	kind: "compare",
	op: "eq",
	left,
	right
})

/** A conjunction of at least one predicate. */
export const and = <L>(first: ExprOf<L>, ...rest: ReadonlyArray<ExprOf<L>>): ExprOf<L> => ({
	kind: "and",
	args: [first, ...rest]
})

export const betweenExpr = (arg: ExprDesc, low: ExprDesc, high: ExprDesc): ExprDesc => ({
	kind: "between",
	arg,
	low,
	high
})

export const charLength = (arg: ExprDesc): ExprDesc => ({
	kind: "compute",
	fn: "charLength",
	args: [arg]
})
export const field = (name: string): ExprDesc => ({ kind: "field", field: name })

/** Relations. */
export const relation = (
	name: string,
	fields: Readonly<Record<string, FieldDesc>>,
	primaryKey: ReadonlyArray<string>
): AuthoredRelationDesc & { readonly kind: "relation" } => {
	const [key, ...rest] = primaryKey
	if (key === undefined) {
		throw new Error(`the fixture relation ${name} has no primary key`)
	}
	return { kind: "relation", name, fields, primaryKey: [key, ...rest] }
}

/** A closed relation of handles alone: no payload, so no facts. */
export const closed = (
	name: string,
	handles: ReadonlyArray<string>
): AuthoredRelationDesc & { readonly kind: "closed" } => closedWith(name, handles, {}, {})

/** A closed relation with a payload and each handle's facts. */
export const closedWith = (
	name: string,
	handles: ReadonlyArray<string>,
	payload: Readonly<Record<string, FieldDesc>>,
	facts: Readonly<Record<string, Readonly<Record<string, LiteralDesc>>>>
): AuthoredRelationDesc & { readonly kind: "closed" } => ({
	kind: "closed",
	name,
	handles: nonEmptyList(handles, "a closed relation's handles"),
	payload,
	facts
})

/** ℕ's destructor over a natural field, one level deep: the term defined where the field is above zero. */
export const pred = (fieldName: string): TermDesc => ({ kind: "pred", field: fieldName })

/** A side's terms as on(...) states them: a field term by its field's name, a pred term by pred(field). */
const termsOf = (
	relationName: string,
	terms: ReadonlyArray<string | TermDesc>
): Arr.NonEmptyReadonlyArray<TermDesc> =>
	nonEmptyList(
		Arr.map(terms, (t): TermDesc => (typeof t === "string" ? { kind: "field", field: t } : t)),
		`a side of ${relationName}`
	)

/** A side over every fact of the relation; a side names at least one term. */
export const on = (relationName: string, terms: ReadonlyArray<string | TermDesc>): SideDesc => ({
	relation: relationName,
	terms: termsOf(relationName, terms),
	selection: everyFact
})

/** A side over the facts the row predicate holds of, select(R, predicate) projected onto its terms. */
export const onWhere = (
	relationName: string,
	terms: ReadonlyArray<string | TermDesc>,
	predicate: ExprDesc
): SideDesc => ({
	relation: relationName,
	terms: termsOf(relationName, terms),
	selection: { conjuncts: conjunctsOf(predicate) }
})

/** An additional candidate key: the side's terms are unique over the facts it selects. */
export const key = (side: SideDesc): AuthoredStatementDesc => ({ kind: "key", side })

export const mutable = (relationName: string): AuthoredStatementDesc => ({
	kind: "mutable",
	relation: relationName
})

export const check = (
	name: string,
	relationName: string,
	predicate: AuthoredExprDesc
): AuthoredStatementDesc => ({
	kind: "check",
	name,
	relation: relationName,
	predicate
})

/** A contained statement declared directly: no alternatives expansion marks it. */
export const contained = (
	left: SideDesc,
	right: SideDesc
): Extract<AuthoredStatementDesc, { readonly kind: "contained" }> => ({
	kind: "contained",
	left,
	right,
	origin: undefined
})

/** mirrors(left, right), declared directly: its two containments, left into right and then right into left. */
export const mirrors = (
	left: SideDesc,
	right: SideDesc
): readonly [
	Extract<AuthoredStatementDesc, { readonly kind: "contained" }>,
	Extract<AuthoredStatementDesc, { readonly kind: "contained" }>
] => [contained(left, right), contained(right, left)]

/** A capacity statement. */
export const capacity = (
	target: SideDesc,
	from: SideDesc,
	within: BoundDesc,
	weight: WeightDesc
): AuthoredStatementDesc => ({
	kind: "capacity",
	target,
	from,
	weight,
	within
})

/**
 * A capacity's bounds: each a literal, or the name of a field of the target fact; a high bound of `*` is no upper
 * bound.
 */
export const within = (low: bigint | string, high: bigint | string): BoundDesc => ({
	low: typeof low === "bigint" ? low : { ref: low },
	high: high === "*" ? "*" : typeof high === "bigint" ? high : { ref: high }
})

/**
 * alternatives(parent, discriminator, roster, arms): the two containments of mirrors(on(select(parent, (p) =>
 * p.eq(p[discriminator], roster.handle(h))), ...parentKey), on(arm, ...armKey)) per handle with an arm, in roster order,
 * every statement marked with the expansion's origin. The discriminator's containment in the roster is its closedId
 * field's type, no statement.
 */
export const alternatives = (
	parent: { readonly name: string; readonly primaryKey: ReadonlyArray<string> },
	discriminator: string,
	roster: { readonly name: string; readonly handles: ReadonlyArray<string> },
	arms: Readonly<
		Record<string, { readonly name: string; readonly primaryKey: ReadonlyArray<string> }>
	>
): ReadonlyArray<AuthoredStatementDesc> => {
	const origin = { alternatives: FieldId(parent.name, discriminator) }
	return Arr.flatMap(roster.handles, (handle): ReadonlyArray<AuthoredStatementDesc> => {
		const arm = arms[handle]
		if (arm === undefined) {
			return []
		}
		return Arr.map(
			mirrors(
				onWhere(parent.name, parent.primaryKey, eq(field(discriminator), literal(handle))),
				on(arm.name, arm.primaryKey)
			),
			(statement): AuthoredStatementDesc => ({ ...statement, origin })
		)
	})
}
