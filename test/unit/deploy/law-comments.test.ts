/**
 * The COMMENT ON a law's installed object reads the law as its author wrote it (core/identity.ts displayOf, analysis/
 * theory/spelling.ts, the law column's display): `key T(id where Logic.gt(u, 1))`, where it spelled each conjunct of the side's
 * selection as its canonical JSON. A declared rename of a field the selection reads restates the comment, so the draft
 * comments the law's object, as the rename names it, with the field's new name and never leaves the old one.
 *
 * - **Property:** over drawn row predicates of T's integer field and its flag (a comparison of each operator, a range,
 *   a negation, a disjunction), keyed over the side they select: the installation from nothing comments the key's
 *   constraint with `key T(id where …)`, the predicate as the shape's own printer writes it over u; the draft renaming u to v,
 *   declared, comments that object, as the rename names it, with the predicate written over v, and no statement of
 *   the draft comments anything with u.
 * - **Oracle:** second-implementation: the shape's own printer of the builder calls it made.
 * - **Features:** each kind of node a shape draws.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { type CompareOp, compareOps } from "#compiler/ir/desc.ts"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, bool, int4 } from "#compiler/public/fields.ts"
import { closed, contained, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import type { Comment, SqlStatement } from "#compiler/sql/ast.ts"
import type { PredicateBase } from "#compiler/types/core/phantom.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedCodes } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	asDrafted,
	compile,
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { statementsOf } from "#test/unit/deploy/renames.fixtures.ts"

/** A row predicate's shape over T's integer field and its flag. */
type Shape =
	| { readonly kind: "compare"; readonly op: CompareOp; readonly value: number }
	| { readonly kind: "between"; readonly low: number; readonly high: number }
	| { readonly kind: "flag"; readonly is: boolean }
	| { readonly kind: "not"; readonly arg: Shape }
	| { readonly kind: "or"; readonly left: Shape; readonly right: Shape }

type CommentFeature =
	| Shape["kind"]
	| "a selection the rename restates"
	| "a selection the rename leaves"

const leafGen: Gen<Shape> = oneOf<Shape>([
	(s) => ({ kind: "compare", op: s.draw(element(compareOps)), value: s.draw(int(-2, 2)) }),
	(s) => ({ kind: "between", low: s.draw(int(-3, 0)), high: s.draw(int(1, 5)) }),
	(s) => ({ kind: "flag", is: s.draw(element([true, false] as const)) })
])

const shapeGen = (depth: number): Gen<Shape> =>
	depth === 0
		? leafGen
		: oneOf<Shape>([
				leafGen,
				(s) => ({ kind: "not", arg: s.draw(shapeGen(depth - 1)) }),
				(s) => ({
					kind: "or",
					left: s.draw(shapeGen(depth - 1)),
					right: s.draw(shapeGen(depth - 1))
				})
			])

/** The predicate a shape builds over the integer term `n` and the flag `flag`. */
const built = <N, B>(
	shape: Shape,
	n: N,
	flag: B,
	via: {
		readonly compare: (op: CompareOp, n: N, value: number) => PredicateBase
		readonly between: (n: N, low: number, high: number) => PredicateBase
		readonly flag: (flag: B, is: boolean) => PredicateBase
	}
): PredicateBase => {
	const go = (x: Shape): PredicateBase => {
		switch (x.kind) {
			case "compare":
				return via.compare(x.op, n, x.value)
			case "between":
				return via.between(n, x.low, x.high)
			case "flag":
				return via.flag(flag, x.is)
			case "not":
				return Logic.not(go(x.arg))
			case "or":
				return Logic.or([go(x.left), go(x.right)])
		}
	}
	return go(shape)
}

/** The texts a shape may be written as over the integer field named `n`: a disjunction's operands either way round. */
const written = (shape: Shape, n: string): ReadonlyArray<string> => {
	switch (shape.kind) {
		case "compare":
			return [`Logic.${shape.op}(${n}, ${String(shape.value)})`]
		case "between":
			return [`Logic.between(${n}, ${String(shape.low)}, ${String(shape.high)})`]
		case "flag":
			return [`Logic.eq(flag, ${String(shape.is)})`]
		case "not":
			return Arr.map(written(shape.arg, n), (a) => `Logic.not(${a})`)
		case "or":
			return Arr.flatMap(written(shape.left, n), (l) =>
				Arr.flatMap(written(shape.right, n), (r) => [
					`Logic.or([${l}, ${r}])`,
					`Logic.or([${r}, ${l}])`
				])
			)
	}
}

const H = closed.ordered("H", ["a", "b"] as const)
const P = closed.relation("P", { h: closedId(H) }, ["h"], [{ h: "a" }])

/**
 * The schema keying T over the side `shape` selects and holding that side's closed ids in the closed relation P, its
 * integer field named u.
 */
const overU = (shape: Shape) => {
	const T = relation("T", { id: Id, u: int4, flag: bool, h: closedId(H) }, ["id"])
	const side = () =>
		select(T, (t) =>
			built(shape, t.u, t.flag, {
				compare: (op, n, value) => Logic[op](n, value),
				between: (n, low, high) => Logic.between(n, low, high),
				flag: (f, is) => Logic.eq(f, is)
			})
		)
	return schema(
		"Commented",
		[H, P, T],
		[key(on(side(), "id")), contained(on(side(), "h"), on(P, "h"))]
	)
}

/** The same schema with u renamed v. */
const overV = (shape: Shape) => {
	const T = relation("T", { id: Id, v: int4, flag: bool, h: closedId(H) }, ["id"])
	const side = () =>
		select(T, (t) =>
			built(shape, t.v, t.flag, {
				compare: (op, n, value) => Logic[op](n, value),
				between: (n, low, high) => Logic.between(n, low, high),
				flag: (f, is) => Logic.eq(f, is)
			})
		)
	return schema(
		"Commented",
		[H, P, T],
		[key(on(side(), "id")), contained(on(side(), "h"), on(P, "h"))]
	)
}

/** The comments among `statements` on the key's constraint and the containment's: those reading either law. */
const lawComments = (statements: ReadonlyArray<SqlStatement>): ReadonlyArray<Comment> =>
	Arr.filter(
		statements,
		(s): s is Comment =>
			s.kind === "comment" &&
			(Str.startsWith("key T(")(s.text) || Str.startsWith("check of T for law")(s.text))
	)

/** The texts the two laws' comments may read, as sets of one text each, over the integer field named `n`. */
const commentsOver = (shape: Shape, n: string): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(written(shape, n), (w) =>
		Arr.sort([`key T(id where ${w})`, `check of T for law T(h) where ${w} in P(h)`], Order.String)
	)

/** The texts of `comments`, sorted. */
const textsOf = (comments: ReadonlyArray<Comment>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(comments, (c) => c.text),
		Order.String
	)

/** Whether a shape reads the integer field, which the rename renames. */
const readsField = (shape: Shape): boolean =>
	shape.kind === "or"
		? readsField(shape.left) || readsField(shape.right)
		: shape.kind === "not"
			? readsField(shape.arg)
			: shape.kind !== "flag"

/** Each kind a shape holds. */
const kindsOf = (shape: Shape): ReadonlyArray<CommentFeature> =>
	shape.kind === "or"
		? [shape.kind, ...kindsOf(shape.left), ...kindsOf(shape.right)]
		: shape.kind === "not"
			? [shape.kind, ...kindsOf(shape.arg)]
			: [shape.kind]

const renamed: Declarations = {
	renames: [
		{
			from: { kind: "field", relation: parsedName("T"), field: parsedName("u") },
			to: { kind: "field", relation: parsedName("T"), field: parsedName("v") }
		}
	],
	drops: []
}

/** A law's COMMENT reads its selection as its author wrote it, and a declared rename restates it. */
export const aLawsCommentReadsItsSelectionAsTheAuthorWroteItAndARenameRestatesIt = property.explore(
	shapeGen(2),
	{
		needs: {},
		situations: [
			"compare",
			"between",
			"flag",
			"not",
			"or",
			"a selection the rename restates",
			"a selection the rename leaves"
		] satisfies ReadonlyArray<Reached<CommentFeature>>,
		budget: { runs: 60, steered: 40 },
		check: (_, c: Case<CommentFeature>) => (shape) =>
			Effect.sync(() => {
				for (const kind of kindsOf(shape)) {
					c.note(kind)
				}
				const installation = compile(overU(shape), asDrafted)
				const installed = succeeded(
					generate({
						installation,
						timestamp: draftedAt(1),
						previous: fromEmpty,
						workload: noWorkload,
						declared: noDeclarations,
						name: "installed"
					})
				)
				const first = textsOf(lawComments(statementsOf(installed.plan.steps)))
				const overUTexts = commentsOver(shape, "u")
				assert.ok(
					Arr.some(overUTexts, (t) => Arr.join(t, "\n") === Arr.join(first, "\n")),
					`the laws' comments, ${Arr.join(first, "; ")}, read their author's predicate, one of ${Arr.join(
						Arr.map(overUTexts, (t) => Arr.join(t, "; ")),
						" | "
					)}`
				)
				const codes = succeeded(draftCodes(overV(shape), fromSnapshot(installed.snapshot), renamed))
				const draft = succeeded(
					generate({
						installation: compile(overV(shape), { ...asDrafted, codes: installedCodes(codes) }),
						timestamp: draftedAt(2),
						previous: fromSnapshot(installed.snapshot),
						workload: noWorkload,
						declared: renamed,
						name: "renamed"
					})
				)
				const statements = statementsOf(draft.plan.steps)
				const restated = textsOf(lawComments(statements))
				if (!readsField(shape)) {
					c.note("a selection the rename leaves")
					assert.equal(
						restated.length,
						0,
						"laws whose selection reads no u are commented as installed"
					)
					return
				}
				c.note("a selection the rename restates")
				const overVTexts = commentsOver(shape, "v")
				assert.ok(
					Arr.some(overVTexts, (t) => Arr.join(t, "\n") === Arr.join(restated, "\n")),
					`the restated comments, ${Arr.join(restated, "; ")}, read the predicate over v, one of ${Arr.join(
						Arr.map(overVTexts, (t) => Arr.join(t, "; ")),
						" | "
					)}`
				)
				assert.ok(
					!Arr.some(statements, (s) => s.kind === "comment" && Str.includes("(u,")(s.text)),
					"no comment of the draft names u"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the shape's own printer of the builder calls it made"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					"\t\t\t\tdisplays: plan.selection.conjuncts.map((c) =>\n\t\t\t\t\tpredicateSource(c.predicate, (f) => f, languagePattern)\n\t\t\t\t)",
				replacement: "\t\t\t\tdisplays: plan.selection.conjuncts.map((c) => c.text)",
				why: "A law column's display spells its selection's conjuncts by their canonical JSON again, as the key's constraint, named by the column, reads it; every key's comment reads otherwise than its author wrote it."
			},
			{
				file: "packages/engine/src/analysis/theory/spelling.ts",
				original: "\t\t\tdisplay: predicateSource(c.predicate, (f) => f, languagePattern),",
				replacement: "\t\t\tdisplay: c.text,",
				why: "A law's display spells its side's conjuncts by their canonical JSON again, as the containment's CHECK, named by the law, reads it; every containment's comment reads otherwise than its author wrote it."
			}
		]
	}
)
