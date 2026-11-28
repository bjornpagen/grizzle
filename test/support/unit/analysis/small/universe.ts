import { Array as Arr } from "effect"
import { type PhysicalEnv, unplaced } from "#compiler/analysis/physical/analyze.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import type { LogicalEnv } from "#compiler/logical/annotate.ts"
import type { ContainmentFact } from "#compiler/logical/attach.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import {
	type AuthoredStatementDesc,
	closedRelation,
	contained,
	eq,
	f,
	field,
	literal,
	on,
	onWhere,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts, type GenFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import {
	type GenClosed,
	type GenRelation,
	type GenSchema,
	schemaDesc
} from "#test/support/oracle/gen/schema.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The small closed universe the small-scope suite proves the analyses over: two relations, R(a, b) and S(a, b), both
 * integer columns, under seven variants of their keys and containment, and every database of at most two facts per
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

/**
 * A containment of S's fields in R's, field by field: of every fact of S, or of those its selection holds of, each
 * field of `selected` holding 1; held at every statement, or only at commit.
 */
export interface Containment {
	readonly from: Arr.NonEmptyReadonlyArray<FieldName>
	readonly to: Arr.NonEmptyReadonlyArray<FieldName>
	readonly selected: ReadonlyArray<FieldName>
	readonly held: "immediate" | "atCommit"
}

export interface Variant {
	readonly name: string
	readonly r: { readonly primaryKey: KeySet; readonly keys: ReadonlyArray<KeySet> }
	readonly s: { readonly primaryKey: KeySet; readonly keys: ReadonlyArray<KeySet> }
	readonly containments: ReadonlyArray<Containment>
}

/** S.b ⊆ R.a, held as `held`. */
const bInA = (held: Containment["held"]): Containment => ({
	from: ["b"],
	to: ["a"],
	selected: [],
	held
})

const variant = (v: Variant): Variant => v

/**
 * The seven variants: the key shapes a join, a projection and a group meet (a single key, a candidate key beside it, a
 * whole-heading key); a containment held at every statement and one held only at commit; a containment of a selected
 * source, which proves a child only of a parent whose fact the selection holds of; and a containment of two fields into
 * a whole-heading key, which proves a child correlated by both.
 */
export const variants: Arr.NonEmptyReadonlyArray<Variant> = [
	variant({
		name: "R(a) S(a)",
		r: { primaryKey: ["a"], keys: [] },
		s: { primaryKey: ["a"], keys: [] },
		containments: []
	}),
	variant({
		name: "R(a)+key(b) S(a,b)",
		r: { primaryKey: ["a"], keys: [["b"]] },
		s: { primaryKey: ["a", "b"], keys: [] },
		containments: []
	}),
	variant({
		name: "R(a,b) S(a)",
		r: { primaryKey: ["a", "b"], keys: [] },
		s: { primaryKey: ["a"], keys: [] },
		containments: []
	}),
	variant({
		name: "R(a) S(a), S.b ⊆ R.a",
		r: { primaryKey: ["a"], keys: [] },
		s: { primaryKey: ["a"], keys: [] },
		containments: [bInA("immediate")]
	}),
	variant({
		name: "R(a) S(a,b), S.b ⊆ R.a at commit",
		r: { primaryKey: ["a"], keys: [] },
		s: { primaryKey: ["a", "b"], keys: [] },
		containments: [bInA("atCommit")]
	}),
	variant({
		name: "R(a) S(a), σ(S, a = 1).b ⊆ R.a",
		r: { primaryKey: ["a"], keys: [] },
		s: { primaryKey: ["a"], keys: [] },
		containments: [{ from: ["b"], to: ["a"], selected: ["a"], held: "immediate" }]
	}),
	variant({
		name: "R(a,b) S(a), S(a,b) ⊆ R(a,b)",
		r: { primaryKey: ["a", "b"], keys: [] },
		s: { primaryKey: ["a"], keys: [] },
		containments: [{ from: ["a", "b"], to: ["a", "b"], selected: [], held: "immediate" }]
	})
]

/** Whether some containment of the variant holds only at commit. */
const heldAtCommit = (v: Variant): boolean => Arr.some(v.containments, (c) => c.held === "atCommit")

/** The contexts a variant is read in: a transaction differs from a snapshot only where some evidence holds at commit. */
export const contextsOf = (v: Variant): Arr.NonEmptyReadonlyArray<TemplateContext> =>
	heldAtCommit(v) ? ["snapshot", "transaction"] : ["snapshot"]

const int = (value: bigint): TypedLiteral => ({ kind: "int", value })

/** The closed relation C, keyed by a closed id of the roster CId of handles X and Y, with the payload a and b. */
export const closedName = "C"
const rosterName = "CId"
const rosterC: GenClosed = {
	name: rosterName,
	handles: ["X", "Y"],
	/** A fresh installation's codes: X is 0 and Y is 1. */
	codes: [
		{ kind: "live", handle: "X" },
		{ kind: "live", handle: "Y" }
	],
	payload: [],
	rows: [[{ kind: "handle", handle: "X" }], [{ kind: "handle", handle: "Y" }]]
}
const closedC = closedRelation(
	closedName,
	{ id: f.closedId(rosterName), a: f.integer, b: f.integer },
	["id"],
	[
		{ id: "X", a: 0, b: 0 },
		{ id: "Y", a: 0, b: 1 }
	]
)

/** The relation parameter P, a heading of one integer field a. */
export const relationParam = "P"

const relationOf = (name: RelationName, keys: Variant["r"]): GenRelation => ({
	name,
	columns: Arr.map(fieldNames, (field) => ({ name: field, type: int4 })),
	primaryKey: keys.primaryKey,
	keys: keys.keys,
	mutable: false
})

/** The variant's relations as the reference evaluator and the schema generator's Description read them. */
const genSchemaOf = (v: Variant): GenSchema => ({
	name: "Small",
	relations: [relationOf("R", v.r), relationOf("S", v.s)],
	closed: [rosterC],
	containments: []
})

/** A containment as its statement states it: S's side, over every fact or its selection, in R's. */
const containmentStatement = (c: Containment): AuthoredStatementDesc => {
	const [first, ...rest] = Arr.map(c.selected, (f) => eq(field(f), literal(1)))
	const from =
		first === undefined
			? on("S", c.from)
			: onWhere("S", c.from, rest.length === 0 ? first : { kind: "and", args: [first, ...rest] })
	return contained(from, on("R", c.to))
}

/**
 * The variant's Description: the generated schema's, which declares the roster CId, with the closed relation C over it,
 * whose declared rows the checker reads into a query's Closed node, and the variant's containments.
 */
const descOf = (v: Variant, schema: GenSchema): SchemaDesc => {
	const desc = schemaDesc(schema)
	return {
		...desc,
		relations: [...desc.relations, closedC],
		statements: [...desc.statements, ...Arr.map(v.containments, containmentStatement)]
	}
}

/** What one variant's installation gives the analyses, built once: its owned law model, as production builds it. */
export interface Installed {
	readonly variant: Variant
	readonly schema: GenSchema
	/** The schema's Description, as the checker reads it. */
	readonly desc: SchemaDesc
	readonly logical: (context: TemplateContext) => LogicalEnv
	readonly physical: (context: TemplateContext) => PhysicalEnv
}

export const installed = (v: Variant): Installed => {
	const schema = genSchemaOf(v)
	const desc = descOf(v, schema)
	const fixture = ownedFixture(desc)
	const theory = fixture.laws.theory
	/** A containment held only at commit is committed-snapshot evidence, whatever native object enforces it. */
	const containments: ReadonlyArray<ContainmentFact> = Arr.map(theory.evidence.containments, (c) =>
		heldAtCommit(v) ? { ...c, context: "committedSnapshot" as const } : c
	)
	/**
	 * The installed foreign key states the same validity context to the physical analysis, so neither analysis rests
	 * on it inside a transaction, where `databases` lets S.b dangle.
	 */
	const catalog = heldAtCommit(v)
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
		desc,
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
	return Arr.flatMap(
		upTo(items.length + 1, (i) => i),
		(size) => choose(0, size)
	)
}

const relationFacts = (keys: Variant["r"]) =>
	Arr.filter(
		subsetsOf(allFacts),
		(facts) =>
			facts.length <= 2 && Arr.every([keys.primaryKey, ...keys.keys], (k) => distinctOn(facts, k))
	)

/** The integer a fact holds in a field. */
const valueAt = (fact: ReadonlyArray<TypedLiteral>, field: FieldName): bigint =>
	intOf(fact[field === "a" ? 0 : 1])

/**
 * Whether a containment breaks over R's facts `r` and S's facts `s`: some fact of S its selection holds of, each
 * selected field 1, has no fact of R agreeing with it field by field.
 */
const breaks = (
	c: Containment,
	r: ReadonlyArray<ReadonlyArray<TypedLiteral>>,
	s: ReadonlyArray<ReadonlyArray<TypedLiteral>>
): boolean =>
	Arr.some(
		s,
		(fact) =>
			Arr.every(c.selected, (f) => valueAt(fact, f) === 1n) &&
			!Arr.some(r, (target) =>
				Arr.every(c.from, (f, i) => {
					const to = c.to[i]
					return to !== undefined && valueAt(fact, f) === valueAt(target, to)
				})
			)
	)

/**
 * Every database of the variant that some context may see: at most two facts per relation, every key held, and every
 * containment held but one that holds only at commit.
 */
export const databases = (v: Variant): ReadonlyArray<Database> =>
	Arr.flatMap(relationFacts(v.r), (r) =>
		Arr.flatMap(relationFacts(v.s), (s) => {
			const broken = Arr.filter(v.containments, (c) => breaks(c, r, s))
			return Arr.some(broken, (c) => c.held === "immediate")
				? []
				: [{ facts: canonicalFacts({ R: r, S: s }), dangles: broken.length > 0 }]
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
