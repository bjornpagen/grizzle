/** What the property of count.test.ts reads: its box, its model and the readings it builds. */

import type * as EngineResult from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Result } from "effect"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { type CompileError, isCompileError } from "#compiler/core/errors.ts"
import { sameScalarType, type ScalarType } from "#compiler/ir/scalar.ts"
import { queryInput } from "#compiler/program/input.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { changeSetOver as ChangeSet, type MemberInput } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/** The two types a count meets: natural, what a count is, and the bigint behind it, another type. */
export type Side = "natural" | "bigint"

/**
 * Where a case reads its count, `n: r.count()` over Item's rows by their kind:
 * - `head`: a query's head;
 * - `derived`: a stored derived relation's field, Item keyed by its kind first in the unit of its kind;
 * - `written`: an insert into a relation whose field n is of the type `into`;
 * - `union`: the head of a query of two rules, the count's and one that delivers n as `beside`, the literal 0n or a
 *   field of either type, read as the query's head or, `written`, inserted into a natural field (decideStage's place, a
 *   count of the earlier sessions beside 0 where there are none);
 * - `compared`: the derived relation's count read by a filter against a parameter of either type or the literal 1n.
 */
export type Reading =
	| { readonly kind: "head" }
	| { readonly kind: "derived" }
	| { readonly kind: "written"; readonly into: Side }
	| { readonly kind: "union"; readonly beside: "zero" | Side; readonly written: boolean }
	| { readonly kind: "compared"; readonly against: Side | "literal" }

/** A case of the box: a reading, and whether the schema declares a natural field of its own, Tally's, beside it. */
export interface CountCase {
	readonly reading: Reading
	readonly tally: boolean
}

const readings: Arr.NonEmptyReadonlyArray<Reading> = [
	{ kind: "head" },
	{ kind: "derived" },
	{ kind: "written", into: "natural" },
	{ kind: "written", into: "bigint" },
	...Arr.flatMap(["zero", "natural", "bigint"] as const, (beside) =>
		Arr.map([false, true] as const, (written) => ({ kind: "union", beside, written }) as const)
	),
	{ kind: "compared", against: "natural" },
	{ kind: "compared", against: "bigint" },
	{ kind: "compared", against: "literal" }
]

export const countGen: Gen<CountCase> = (source) => ({
	reading: source.draw(element(readings)),
	tally: source.draw(element([false, true] as const))
})

/** What a case's reading gives: the count's type where it is read, a write or a filter that compiles, or a refusal. */
export type Observed =
	| { readonly kind: "typed"; readonly type: Side | "another" }
	| { readonly kind: "compiled" }
	| { readonly kind: "refused"; readonly tag: CompileError["reason"]["_tag"] }

/**
 * The model: a count is a natural, so it is typed natural wherever it is read, and it meets a natural and no bigint,
 * as one type meets only itself; a literal beside it is of its type. A write of a member column of another type than
 * its field's is DescribedHeadingMismatch; a union whose arms deliver n at two types and a comparison of two types are
 * MalformedDescription.
 */
export const modelOf = (c: CountCase): Observed => {
	const count: Side = "natural"
	const r = c.reading
	switch (r.kind) {
		case "head":
		case "derived":
			return { kind: "typed", type: count }
		case "written":
			return r.into === count
				? { kind: "compiled" }
				: { kind: "refused", tag: "DescribedHeadingMismatch" }
		case "union": {
			const joined = r.beside === "zero" || r.beside === count
			return !joined
				? { kind: "refused", tag: "MalformedDescription" }
				: r.written
					? { kind: "compiled" }
					: { kind: "typed", type: count }
		}
		case "compared":
			return r.against === "literal" || r.against === count
				? { kind: "compiled" }
				: { kind: "refused", tag: "MalformedDescription" }
	}
}

/** A checked type as the box tells types: natural, bigint, or another. */
const sideOf = (t: ScalarType): Side | "another" =>
	t.contract?.name === "natural"
		? "natural"
		: sameScalarType(t, plainType("int8"))
			? "bigint"
			: "another"

/** A refusal, as a case observes one. */
const refusal = (error: CompileError): Observed => ({ kind: "refused", tag: error.reason._tag })

/** A compilation's result, as a case observes it: compiled, or its refusal. */
const compiled = <A>(result: EngineResult.Result<A, CompileError>): Observed =>
	result.ok ? { kind: "compiled" } : refusal(result.error)

/**
 * What building and compiling a case gives: `observe` builds its programs and reads them, and a refusal the builders
 * throw (a comparison of two types is refused as its builder is called) is observed as a refusal returned is.
 */
const observing = (observe: () => Observed): Observed => {
	const outcome = Result.try(observe)
	if (Result.isSuccess(outcome)) {
		return outcome.success
	}
	if (isCompileError(outcome.failure)) {
		return refusal(outcome.failure)
	}
	throw outcome.failure
}

/** The field of a side's type. */
const fieldOf = (side: Side) => (side === "natural" ? natural : pg.bigint)

/** What a case gives: its schema built, its count read where its reading reads it (see Reading). */
export const observedOf = (c: CountCase): Observed =>
	observing(() => {
		const r = c.reading
		const Item = relation("Item", { id: pg.integer, kind: pg.integer }, ["kind", "id"])
		const Tally = relation("Tally", { kind: pg.integer, t: natural }, ["kind"])
		const Into = relation(
			"Into",
			{ kind: pg.integer, n: fieldOf(r.kind === "written" ? r.into : "natural") },
			["kind"]
		)
		const Beside = relation(
			"Beside",
			{
				kind: pg.integer,
				n: fieldOf(r.kind === "union" && r.beside === "bigint" ? "bigint" : "natural")
			},
			["kind"]
		)
		const own = [
			Item,
			...(c.tally ? [Tally] : []),
			...(r.kind === "written" || (r.kind === "union" && r.written) ? [Into] : []),
			...(r.kind === "union" && r.beside !== "zero" ? [Beside] : [])
		]
		const Counts = schema("Counts", own, [unit("Kinds", { kind: pg.integer })])
		const counted = query(Counts).rule((q) => {
			const { id, kind } = v(Item, "item")
			return q.match(Item, { id, kind }).find({ kind, n: q.count() })
		})
		const headOf = (checked: CheckedSchema, of: Parameters<typeof queryInput>[0]): Observed => {
			const admitted = checkQuery(
				checked,
				succeeded(queryInput(of), "the query's input").desc,
				checkOptions("count")
			)
			if (!admitted.ok) {
				return refusal(admitted.error)
			}
			const [root] = admitted.value.dag.roots
			const n = defined(
				Option.getOrUndefined(Arr.findFirst(root.heading, (h) => h.name === "n")),
				"the head field n"
			)
			return { kind: "typed", type: sideOf(n.type) }
		}
		const written = (of: MemberInput): Observed =>
			compiled(
				compileWrite(
					checking(Counts),
					descOf(ChangeSet.empty(Counts).insert(Into, of)),
					realityWrite(succeeded(testArtifacts(Counts, testCompile), "the schema's artifacts"))
				)
			)
		switch (r.kind) {
			case "head":
				return headOf(checking(Counts), counted)
			case "written":
				return written(counted)
			case "union": {
				/** Built as a JavaScript caller builds it, untyped: the types refuse a bigint arm beside a count's, as the
				 * checker does, which the case observes. */
				const both = queryOver(Counts)
					.rule((q: RuleValue) => {
						const item = varsOver(Item, "item")
						return q
							.match(Item, { id: item["id"], kind: item["kind"] })
							.find({ kind: item["kind"], n: q.count() })
					})
					.rule((q: RuleValue) => {
						if (r.beside === "zero") {
							const item = varsOver(Item, "item")
							return q
								.match(Item, { id: item["id"], kind: item["kind"] })
								.find({ kind: item["kind"], n: 0n })
						}
						const beside = varsOver(Beside, "beside")
						return q
							.match(Beside, { kind: beside["kind"], n: beside["n"] })
							.find({ kind: beside["kind"], n: beside["n"] })
					})
				return r.written ? written(both) : headOf(checking(Counts), both)
			}
			case "derived":
			case "compared": {
				const Tallied = derived.stored(
					"Tallied",
					query(Counts).rule((q) => {
						const { id, kind } = v(Item, "item")
						return q.match(Item, { id, kind }).find({ kind, n: q.count() })
					})
				)
				const Read = schema.extend([Counts], "Read", [Tallied], [])
				const checked = checking(Read)
				if (r.kind === "derived") {
					const tallied = defined(
						Option.getOrUndefined(Arr.findFirst(checked.derived, (d) => d.name === "Tallied")),
						"Tallied's analysis"
					)
					const { desc } = defined(
						Option.getOrUndefined(Arr.findFirst(tallied.heading, (h) => h.name === "n")),
						"Tallied's field n"
					)
					return {
						kind: "typed",
						type:
							desc.kind === "contract" && desc.name === "natural"
								? "natural"
								: desc.kind === "pg" && desc.type === "bigint"
									? "bigint"
									: "another"
					}
				}
				/** Built untyped, as a JavaScript caller builds it: the types refuse a bigint beside a count, as the checker
				 * does. */
				const filtered = queryOver(Read).rule((q: RuleValue) => {
					const tallied = varsOver(Tallied, "tallied")
					return q
						.match(Tallied, { kind: tallied["kind"], n: tallied["n"] })
						.where(
							q.ge(
								tallied["n"],
								r.against === "literal" ? 1n : q.param("least", fieldOf(r.against))
							)
						)
						.find({ kind: tallied["kind"] })
				})
				return compiled(
					checkQuery(
						checked,
						succeeded(queryInput(filtered), "the filter's input").desc,
						checkOptions("count")
					)
				)
			}
		}
	})

/** What a case reaches. */
export type CountFeature =
	| "read in a head"
	| "read as a derived field"
	| "written into a natural"
	| "written into a bigint, refused"
	| "beside 0 in a union"
	| "beside a natural in a union"
	| "beside a bigint in a union, refused"
	| "a union written into a natural"
	| "compared with a natural"
	| "compared with a bigint, refused"
	| "compared with a literal"
	| "a schema declaring no natural field"

/** The features of a case. */
export const featuresOf = (c: CountCase): ReadonlyArray<CountFeature> => {
	const r = c.reading
	const declaresNatural =
		c.tally ||
		(r.kind === "written" && r.into === "natural") ||
		(r.kind === "union" && (r.written || r.beside === "natural"))
	const own: ReadonlyArray<CountFeature> = declaresNatural
		? []
		: ["a schema declaring no natural field"]
	switch (r.kind) {
		case "head":
			return [...own, "read in a head"]
		case "derived":
			return [...own, "read as a derived field"]
		case "written":
			return [
				...own,
				r.into === "natural" ? "written into a natural" : "written into a bigint, refused"
			]
		case "union":
			return [
				...own,
				r.beside === "zero"
					? "beside 0 in a union"
					: r.beside === "natural"
						? "beside a natural in a union"
						: "beside a bigint in a union, refused",
				...(r.written && r.beside !== "bigint" ? ["a union written into a natural" as const] : [])
			]
		case "compared":
			return [
				...own,
				r.against === "natural"
					? "compared with a natural"
					: r.against === "bigint"
						? "compared with a bigint, refused"
						: "compared with a literal"
			]
	}
}
