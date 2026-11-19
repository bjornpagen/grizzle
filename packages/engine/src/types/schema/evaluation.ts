/**
 * What a host evaluation of one row of a schema's relation reads and gives (program/evaluate.ts rowEvaluator), typed
 * off the schema: the row's fields, each the codec's host value of its field's type, and what the row comes to, each
 * generated field's value, each row check's verdict and whether its source selects it, as PostgreSQL computes them.
 */
import type { Result } from "effect"
import type { Fact } from "#compiler/types/schema/relation.ts"
import type { RelationOf, StatementsOf } from "#compiler/types/schema/schema.ts"
import type { Selection } from "#compiler/types/schema/statements.ts"

/**
 * What a row is evaluated as a row of: a relation of S, stored, derived or closed, a roster among the closed ones, or a
 * selection of one, select(R, φ).
 */
export type RowSource<S> = RelationOf<S> | Selection<RelationOf<S>>

/** The relation a row source's rows are of: a selection's relation, or the relation itself. */
export type SourceRelation<Src> = Src extends Selection<infer R> ? R : Src

/** The fields of R PostgreSQL generates from its row (relation.generated), each by its name. */
export type GeneratedFieldOf<R> = R extends { readonly fields: infer Fields }
	? {
			[K in keyof Fields]-?: Fields[K] extends { readonly writing: "generated" } ? K : never
		}[keyof Fields]
	: never

/** A row of R as the host evaluates it: every field R stores but those PostgreSQL generates, each its host value. */
export type EvaluatedRow<R> = Omit<Fact<R>, GeneratedFieldOf<R>>

/** The names of S's row checks over R, check(name, R, predicate), each one CHECK its verdict is of. */
export type CheckNameOf<S, R> = Extract<
	StatementsOf<S>[number],
	{ readonly kind: "check"; readonly relation: R }
>["name"]

/**
 * What a row check comes to over a row, as both its discharges judge it, a table's `CHECK ((p) IS TRUE)` and a derived
 * relation's rule's violation query, `WHERE (p) IS NOT TRUE`: it holds where its predicate is true, and breaks where it
 * is false or NULL.
 */
export type CheckVerdict = "holds" | "breaks"

/**
 * Why the host has no value for one item of a row's evaluation: its expression is one the host does not lower, such as
 * float arithmetic in a rule's predicate, which only a query admits, or reads what the host does not evaluate, an
 * operation outside the evaluator or a column it does not hold, such as a law column grizzle fills, `why` its words. The
 * item's place in the evaluation is the one it is, so it states no place of its own.
 */
export interface Unevaluated {
	readonly _tag: "Unevaluated"
	readonly why: string
}

/**
 * A row PostgreSQL refuses before it computes anything of it: the value of `field` is outside its type's refinements,
 * a contract's predicate or a pattern, which its domain's CHECK refuses (23514).
 */
export interface DomainRefused<R> {
	readonly _tag: "DomainRefused"
	readonly field: keyof EvaluatedRow<R> & string
}

/**
 * A row's evaluation over S: each generated field of its relation, its value or NULL, null; each row check of its
 * relation, its verdict; and whether its source selects it, the truth of the source's predicate, a relation's being
 * select(R, TRUE). Each item is its own Result, Effect's, so an item the host cannot evaluate leaves the others theirs.
 */
export interface RowEvaluation<S, R> {
	readonly generated: {
		readonly [K in GeneratedFieldOf<R>]: Result.Result<Fact<R>[K] | null, Unevaluated>
	}
	readonly checks: { readonly [N in CheckNameOf<S, R>]: Result.Result<CheckVerdict, Unevaluated> }
	readonly selected: Result.Result<boolean, Unevaluated>
}

/**
 * A row of R its relation's domains admit (program/evaluate.ts rowEvaluator's admit): `row` the row as the caller stated
 * it, every value of a refined field inside its type's contract and patterns, as PostgreSQL holds the row before it
 * computes anything of it. Only admit makes one, and each source of R evaluates it, so its domains are judged once.
 */
export interface AdmittedRow<R> {
	readonly row: EvaluatedRow<R>
	readonly [admittedOf]: R
}

/** The brand an admitted row rides under, which no value holds and only rowEvaluator's admit mints. */
declare const admittedOf: unique symbol

/**
 * The host's evaluation of rows of S's sources (program/evaluate.ts rowEvaluator): `admit(R, row)` holds a row of R to
 * its domains once, DomainRefused or the admitted row; the evaluator itself evaluates an admitted row of R as a row of
 * any source of R, its items computed once, where it is first evaluated, and shared by every source of R over the
 * admitted row, each column of it read once for them all.
 */
export interface RowEvaluator<S> {
	<Src extends RowSource<S>>(
		source: Src,
		row: AdmittedRow<SourceRelation<Src>>
	): RowEvaluation<S, SourceRelation<Src>>
	readonly admit: <R extends RelationOf<S>>(
		relation: R,
		row: EvaluatedRow<R>
	) => Result.Result<AdmittedRow<R>, DomainRefused<R>>
}
