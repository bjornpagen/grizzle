import { Array as Arr } from "effect"
import { type PhysicalEnv, unplaced } from "#compiler/analysis/physical/analyze.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import type { LogicalEnv } from "#compiler/logical/annotate.ts"
import type { ContainmentFact } from "#compiler/logical/attach.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts, type GenFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import {
	type GenClosed,
	type GenRelation,
	type GenSchema,
	schemaDesc
} from "#test/support/oracle/gen/schema.ts"

/**
 * The small closed universe the small-scope suite proves the analyses over: two relations, R(a, b) and S(a, b), both
 * integer columns, under five variants of their keys and containment, and every database of at most two facts per
 * relation over the values 0 and 1 that the variant's installation lets an execution context see. Beside them stand a
 * closed relation C(id, a, b), whose two declared facts are the same in every database, and a relation parameter P(a),
 * whose rows the caller supplies, repeats included.
 *
 * Rule: the facts a context sees are the ones its evidence is allowed to assume. Every key holds in every context:
 * grizzle installs every key immediate. A containment holds in every context unless its evidence holds only at commit,
 * when a read inside a write transaction may see a source fact with no target. Both analyses are judged on every
 * database the context admits.
 *
 * C's facts are X(0, 0) and Y(0, 1): its handle and b are keys, and a is one literal in every fact, the three things
 * the analyses read off declared facts. P draws no rows, one row, one row given twice, and both values.
 *
 * Two facts per relation are enough to put two rows on one key, one fact on each
 * side of a join, and a dangling reference, which is what every key, cardinality and existence claim is about.
 */

export type RelationName = "R" | "S"
export type FieldName = "a" | "b"

export const relationNames: Arr.NonEmptyReadonlyArray<RelationName> = ["R", "S"]
export const fieldNames: readonly [FieldName, FieldName] = ["a", "b"]

/** How the installation holds a relation's containment S.b ⊆ R.a. */
export type Containment = "none" | "immediate" | "atCommit"

export interface Variant {
	readonly name: string
	readonly r: { readonly primaryKey: KeySet; readonly keys: ReadonlyArray<KeySet> }
	readonly s: { readonly primaryKey: KeySet; readonly keys: ReadonlyArray<KeySet> }
	readonly containment: Containment
}

const variant = (v: Variant): Variant => v

/**
 * The five variants: the key shapes a join, a projection and a group meet (a single key, a candidate key beside it, a
 * whole-heading key), and a containment held at every statement and one held only at commit.
 */
export const variants: Arr.NonEmptyReadonlyArray<Variant> = [
	variant({
		name: "R(a) S(a)",
		r: { primaryKey: ["a"], keys: [] },
		s: { primaryKey: ["a"], keys: [] },
		containment: "none"
	}),
	variant({
		name: "R(a)+key(b) S(a,b)",
		r: { primaryKey: ["a"], keys: [["b"]] },
		s: { primaryKey: ["a", "b"], keys: [] },
		containment: "none"
	}),
	variant({
		name: "R(a,b) S(a)",
		r: { primaryKey: ["a", "b"], keys: [] },
		s: { primaryKey: ["a"], keys: [] },
		containment: "none"
	}),
	variant({
		name: "R(a) S(a), S.b ⊆ R.a",
		r: { primaryKey: ["a"], keys: [] },
		s: { primaryKey: ["a"], keys: [] },
		containment: "immediate"
	}),
	variant({
		name: "R(a) S(a,b), S.b ⊆ R.a at commit",
		r: { primaryKey: ["a"], keys: [] },
		s: { primaryKey: ["a", "b"], keys: [] },
		containment: "atCommit"
	})
]

/** The contexts a variant is read in: a transaction differs from a snapshot only where some evidence holds at commit. */
export const contextsOf = (v: Variant): Arr.NonEmptyReadonlyArray<TemplateContext> =>
	v.containment === "atCommit" ? ["snapshot", "transaction"] : ["snapshot"]

const int = (value: bigint): TypedLiteral => ({ kind: "int", value })

/** The closed relation C: handles X and Y, payload a and b. */
export const closedName = "C"
const closedC: GenClosed = {
	name: closedName,
	handles: ["X", "Y"],
	payload: Arr.map(fieldNames, (field) => ({ name: field, type: int4 })),
	rows: [
		[{ kind: "enum", handle: "X" }, int(0n), int(0n)],
		[{ kind: "enum", handle: "Y" }, int(0n), int(1n)]
	]
}

/** The relation parameter P, a heading of one integer field a. */
export const relationParam = "P"

const relationOf = (name: RelationName, keys: Variant["r"]): GenRelation => ({
	name,
	columns: Arr.map(fieldNames, (field) => ({ name: field, type: int4 })),
	primaryKey: keys.primaryKey,
	keys: keys.keys,
	mutable: false
})

/** The variant as the reference evaluator and the schema generator's Description read it. */
const genSchemaOf = (v: Variant): GenSchema => ({
	name: "Small",
	relations: [relationOf("R", v.r), relationOf("S", v.s)],
	closed: [closedC],
	containments:
		v.containment === "none"
			? []
			: [{ from: { relation: "S", fields: ["b"] }, to: { relation: "R", fields: ["a"] } }]
})

/** What one variant's installation gives the analyses, built once: its owned law model, as production builds it. */
export interface Installed {
	readonly variant: Variant
	readonly schema: GenSchema
	readonly logical: (context: TemplateContext) => LogicalEnv
	readonly physical: (context: TemplateContext) => PhysicalEnv
}

export const installed = (v: Variant): Installed => {
	const schema = genSchemaOf(v)
	const fixture = ownedFixture(schemaDesc(schema))
	const theory = fixture.laws.theory
	/** A containment held only at commit is committed-snapshot evidence, whatever native object enforces it. */
	const containments: ReadonlyArray<ContainmentFact> = Arr.map(theory.evidence.containments, (c) =>
		v.containment === "atCommit" ? { ...c, context: "committedSnapshot" as const } : c
	)
	/**
	 * The installed foreign key states the same validity context to the physical analysis, so neither analysis rests
	 * on it inside a transaction, where `databases` lets S.b dangle.
	 */
	const catalog =
		v.containment === "atCommit"
			? {
					...fixture.catalog,
					containments: Arr.map(fixture.catalog.containments, (c) => ({
						...c,
						context: "committedSnapshot" as const
					}))
				}
			: fixture.catalog
	return {
		variant: v,
		schema,
		logical: (context) => ({
			context,
			containments,
			keyedViews: false
		}),
		physical: (context) => ({ context, catalog, realization: unplaced, roots: "result" })
	}
}

/** Every fact one relation can hold: each field 0 or 1. */
const allFacts: ReadonlyArray<ReadonlyArray<TypedLiteral>> = Arr.flatMap([0n, 1n], (a) =>
	Arr.map([0n, 1n], (b): ReadonlyArray<TypedLiteral> => [int(a), int(b)])
)

/** The integer a fact holds in a field: every fact of the universe holds one in each. */
const intOf = (literal: TypedLiteral | undefined): bigint => {
	if (literal?.kind !== "int") {
		throw new Error("a fact of the universe holds an integer in every field")
	}
	return literal.value
}

const distinctOn = (facts: ReadonlyArray<ReadonlyArray<TypedLiteral>>, key: KeySet): boolean => {
	const seen = new Set<string>()
	for (const fact of facts) {
		const k = Arr.join(
			Arr.map(key, (field) => String(intOf(fact[field === "a" ? 0 : 1]))),
			","
		)
		if (seen.has(k)) {
			return false
		}
		seen.add(k)
	}
	return true
}

/** One database, and whether it breaks the containment, which only a containment held at commit lets a transaction see. */
export interface Database {
	readonly facts: GenFacts
	/** A fact of S references no fact of R. */
	readonly dangles: boolean
}

/** Every subset of the items, as a list in their order, smaller subsets first. */
export const subsetsOf = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
	const choose = (from: number, size: number): ReadonlyArray<ReadonlyArray<A>> =>
		size === 0
			? [[]]
			: Arr.flatMap(items, (head, i) =>
					i >= from && i <= items.length - size
						? Arr.map(choose(i + 1, size - 1), (rest) => [head, ...rest])
						: []
				)
	return Arr.flatMap(Arr.range(0, items.length), (size) => choose(0, size))
}

const relationFacts = (keys: Variant["r"]) =>
	Arr.filter(
		subsetsOf(allFacts),
		(facts) =>
			facts.length <= 2 && Arr.every([keys.primaryKey, ...keys.keys], (k) => distinctOn(facts, k))
	)

/**
 * Every database of the variant that some context may see: at most two facts per relation, every key held, and the
 * containment held unless it holds only at commit.
 */
export const databases = (v: Variant): ReadonlyArray<Database> =>
	Arr.flatMap(relationFacts(v.r), (r) =>
		Arr.flatMap(relationFacts(v.s), (s) => {
			const targets = new Set(Arr.map(r, (fact) => intOf(fact[0])))
			const dangles =
				v.containment !== "none" && Arr.some(s, (fact) => !targets.has(intOf(fact[1])))
			return dangles && v.containment !== "atCommit"
				? []
				: [{ facts: canonicalFacts({ R: r, S: s }), dangles }]
		})
	)

/**
 * Whether the analyses must hold on the database in a context: a transaction may see what holds only at commit broken,
 * a snapshot never.
 */
export const seen = (d: Database, context: TemplateContext): boolean =>
	context === "transaction" || !d.dangles

/** The parameters a plan reads. */
export interface ParamsRead {
	/** The scalar parameter p. */
	readonly scalar: boolean
	/** The relation parameter P. */
	readonly relation: boolean
}

type Bound = Readonly<Record<string, GenParam>>

/** No parameter bound. */
const none: Bound = {}

const scalarValues: ReadonlyArray<Bound> = Arr.map([0n, 1n], (v) => ({
	p: { kind: "scalar", type: int4, value: int(v) }
}))

/** P's rows: none, one, one given twice, and both values. */
const relationValues: ReadonlyArray<Bound> = Arr.map([[], [1n], [0n, 0n], [0n, 1n]], (values) => ({
	[relationParam]: {
		kind: "relation",
		heading: [{ name: "a", type: int4 }],
		rows: Arr.map(values, (v) => [int(v)])
	}
}))

/**
 * Every binding of the parameters a plan reads: p as 0 or 1, P as each of its row lists; a plan reading none runs
 * once, with none.
 */
export const parameterValues = (reads: ParamsRead): ReadonlyArray<Bound> =>
	Arr.flatMap(reads.scalar ? scalarValues : [none], (scalar) =>
		Arr.map(reads.relation ? relationValues : [none], (relation): Bound => ({
			...scalar,
			...relation
		}))
	)
