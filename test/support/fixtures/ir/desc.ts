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
import { Array as Arr, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import {
	type AttachDesc as AttachOf,
	type BindingsDesc as BindingsOf,
	type ChangeSetDesc as ChangeSetOf,
	type WorkloadDesc as WorkloadOf,
	conjunctsOf,
	decodeDesc,
	everyFact,
	type ExprDesc,
	type ExprDesc as ExprOf,
	type FieldDecl,
	type FieldDesc,
	type HeadTermDesc as HeadTermOf,
	type LiteralDesc,
	type MatchDesc as MatchOf,
	type MonoidName,
	type MemberDesc as MemberOf,
	type PgScalarName,
	type QueryDesc as QueryOf,
	type QueryStageDesc as QueryStageOf,
	type ReadBackDesc as ReadBackOf,
	type RelationDesc as RelationOf,
	type RuleDesc as RuleOf,
	type SchemaDesc as SchemaOf,
	type SideDesc,
	type SlotsDesc,
	type SourceDesc as SourceOf,
	type StatementDesc as StatementOf,
	type TermDesc,
	type VarDesc as VarOf
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

/** natural: the builtin contract over bigint, never below zero, that pred reads (scalar/natural.ts). */
const naturalDesc: FieldDesc = {
	kind: "contract",
	name: "natural",
	base: { kind: "pg", type: "bigint" },
	predicate: {
		kind: "compare",
		op: "ge",
		left: { kind: "value" },
		right: { kind: "literal", value: 0n, type: undefined }
	},
	facts: ["nonnegative"]
}

/** Field descriptors. */
export const f = {
	pg: (type: PgScalarName): FieldDesc => ({ kind: "pg", type }),
	smallint: fieldDesc({ kind: "pg", type: "smallint" }),
	integer: fieldDesc({ kind: "pg", type: "integer" }),
	bigint: fieldDesc({ kind: "pg", type: "bigint" }),
	boolean: fieldDesc({ kind: "pg", type: "boolean" }),
	numeric: (precision: number, scale: number): FieldDesc => ({ kind: "numeric", precision, scale }),
	natural: naturalDesc,
	/** A family's index or count, drawn(natural): grizzle draws it from the nested arrays its caller writes. */
	drawn: { type: naturalDesc, writing: { kind: "drawn" } } satisfies FieldDecl<object>,
	/** A fold's end or a copy along a family axis: grizzle fills it on the host, `start` at its axis's base. */
	accumulated: (type: FieldDesc, start: LiteralDesc): FieldDecl<object> => ({
		type,
		writing: { kind: "accumulated", start }
	}),
	/** A field PostgreSQL generates from its row, `expr` of its type exactly. */
	generated: (type: FieldDesc, expr: ExprDesc): FieldDecl<object> => ({
		type,
		writing: { kind: "generated", expr }
	}),
	/** A bigint field its sequence draws, GENERATED ALWAYS AS IDENTITY. */
	bigserial: {
		type: { kind: "pg", type: "bigint" },
		writing: { kind: "serial" }
	} satisfies FieldDecl<object>,
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

/** A relation's field as a fixture states it: a type the caller writes, or a declaration that says how it is written. */
export type FixtureField = FieldDesc | FieldDecl<object>

/** A fixture field as its relation declares it: a bare type is written by the caller. */
const declOf = (field: FixtureField): FieldDecl<object> =>
	"writing" in field ? field : { type: field, writing: { kind: "caller" } }

/** Relations. */
export const relation = (
	name: string,
	fields: Readonly<Record<string, FixtureField>>,
	primaryKey: ReadonlyArray<string>
): AuthoredRelationDesc & { readonly kind: "relation" } => {
	const [key, ...rest] = primaryKey
	if (key === undefined) {
		throw new Error(`the fixture relation ${name} has no primary key`)
	}
	return {
		kind: "relation",
		name,
		fields: Rec.map(fields, declOf),
		primaryKey: [key, ...rest]
	}
}

/** A roster: its handles in declared order, which is their codes' order. */
export const closed = (
	name: string,
	handles: ReadonlyArray<string>
): AuthoredRelationDesc & { readonly kind: "closed" } => ({
	kind: "closed",
	name,
	handles: nonEmptyList(handles, "a roster's handles")
})

/**
 * A closed relation: its fields, its key of closed-id fields in the order its mixed radix reads them, and its rows, each
 * a value of every field.
 */
export const closedRelation = (
	name: string,
	fields: Readonly<Record<string, FieldDesc>>,
	key: ReadonlyArray<string>,
	rows: ReadonlyArray<Readonly<Record<string, LiteralDesc>>>
): AuthoredRelationDesc & { readonly kind: "closedRelation" } => ({
	kind: "closedRelation",
	name,
	fields,
	key: nonEmptyList(key, "a closed relation's key"),
	rows
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

/** A contained statement: the left side's tuples are among the right side's. */
export const contained = (
	left: SideDesc,
	right: SideDesc
): Extract<AuthoredStatementDesc, { readonly kind: "contained" }> => ({
	kind: "contained",
	left,
	right
})

/** fin(owner, count): the slots of an owner's drawn count, a family's second argument. */
export const fin = (owner: string, count: string): SlotsDesc => ({ owner, count })

/** counted(member, fin(owner, count)): each owner's members, its group paired with its primary key, their index hidden. */
export const counted = (member: SideDesc, slots: SlotsDesc): AuthoredStatementDesc => ({
	kind: "family",
	order: "counted",
	member,
	slots
})

/** ordered(member, fin(owner, count)): each owner's members by their group, then their drawn index 0 … n − 1. */
export const ordered = (member: SideDesc, slots: SlotsDesc): AuthoredStatementDesc => ({
	kind: "family",
	order: "ordered",
	member,
	slots
})

/** fold(family, monoid, step, end): the family's step values combined by the monoid into each owner's end fields. */
export const fold = (
	family: SlotsDesc,
	monoid: MonoidName,
	step: SideDesc,
	end: SideDesc
): AuthoredStatementDesc => ({ kind: "fold", family, monoid, step, end })

/** mirrors(left, right), declared directly: its two containments, left into right and then right into left. */
export const mirrors = (
	left: SideDesc,
	right: SideDesc
): readonly [
	Extract<AuthoredStatementDesc, { readonly kind: "contained" }>,
	Extract<AuthoredStatementDesc, { readonly kind: "contained" }>
] => [contained(left, right), contained(right, left)]

/**
 * alternatives(parent, discriminator, roster, arms): its own statement, over every fact of the parent by its primary
 * key and each handle's arm by its primary key, in roster order. The discriminator's containment in the roster is its
 * closedId field's type, no statement.
 */
export const alternatives = (
	parent: { readonly name: string; readonly primaryKey: ReadonlyArray<string> },
	discriminator: string,
	roster: { readonly name: string; readonly handles: ReadonlyArray<string> },
	arms: Readonly<
		Record<string, { readonly name: string; readonly primaryKey: ReadonlyArray<string> }>
	>
): AuthoredStatementDesc => ({
	kind: "alternatives",
	parent: on(parent.name, parent.primaryKey),
	discriminator,
	roster: roster.name,
	arms: nonEmptyList(
		Arr.flatMap(roster.handles, (handle) => {
			const arm = arms[handle]
			return arm === undefined ? [] : [{ handle, arm: on(arm.name, arm.primaryKey) }]
		}),
		`the arms of alternatives over ${parent.name}.${discriminator}`
	)
})
