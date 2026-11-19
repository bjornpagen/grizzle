/**
 * What the properties of share.test.ts read: their cases, a world of the NULL language (test/support/null/language.ts)
 * with rows of it and a generated field built to read one subterm more than once, the schema that states it beside a
 * second generated field of that subterm alone, and the installation and law model the schema compiles to.
 */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { array, element, type Gen, int, type Weighted, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { isRecord } from "#compiler/core/record.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { schema } from "#compiler/public/schema.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { buildTerm, closedOf, itemFields, storedField } from "#test/support/null/build.ts"
import {
	type Item,
	itemGen,
	type NullTerm as Term,
	type Pred,
	termGen,
	type World,
	worldGen
} from "#test/support/null/language.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * How a case's generated field reads its shared subterm:
 *
 * - "a boolean twice": `greatest(cond(b, X, Y), cond(b, Z, W))` over integer leaves (`leafGen`), `b` a predicate the
 *   rewrite proves never NULL (`exactPredGen`),
 *   which a split on `b` evaluates once;
 * - "a flag compared twice": `cond(f = v1, X, cond(f = v2, Y, Z))`, `f` Pick's flag at the row's kind, NULL where Pick
 *   holds no row at it, a chain of equalities the lowering prints as one simple CASE over `f`;
 * - "a flag in two conditionals": `greatest(cond(f = v1, 5, 2), cond(f = v2, 3, 4))`, `f` as above and `v1 <> v2`, which
 *   no split may take, since `f` is NULL where Pick holds no row: the world's last kind holds none and a row reads it,
 *   and every flag Pick holds is `v1` or `v2`, so the value at a NULL flag, 4, is the value at none of Pick's flags (5
 *   and 3);
 * - "a guarded flag": the same under `cond(Pick.has(kind), …, V)`, where `f` is never NULL, so a split may take it;
 * - "two arms of one context": `cond(p, greatest(X, 0), greatest(Y, 0))`, whose arms a factoring takes apart at X and Y;
 * - "a guarded chain": `cond(Pick.has(kind), cond(f = v1, 1, cond(f = v2, 2, 3)), 3)`, shape D's own
 *   (lower/conservative/expr/share.ts): its ELSE arm is the chain at the flag `k` Pick holds at the first kind, beside
 *   v1 and v2, so a factoring makes the chain's subject `cond(Pick.has(kind), f, k)`; Pick holds v1 at the second kind,
 *   which a row reads;
 * - "a drawn term": a term of the language, which reads a subterm twice only by chance.
 */
export type ShareShape =
	| "a boolean twice"
	| "a flag compared twice"
	| "a flag in two conditionals"
	| "a guarded flag"
	| "two arms of one context"
	| "a guarded chain"
	| "a drawn term"

/**
 * What a case reaches: each shape, a NULL shared read at a row, one between the flags Pick holds, a NULL value and a
 * value, several rows.
 */
export type ShareFeature =
	| ShareShape
	| "a shared subterm printed once"
	| "a NULL shared read"
	| "a NULL flag beside the flags Pick holds"
	| "a NULL value"
	| "a value"
	| "several rows"

/** A case's shared subterm: a predicate or a term of a flag. */
export type Shared =
	| { readonly kind: "pred"; readonly pred: Pred }
	| { readonly kind: "flag"; readonly term: Term }

/**
 * A case: its world, one to five rows, its shape, its shared subterm, the drawn terms the shape's conditionals choose
 * between, and the generated field's integer term over them.
 */
export interface ShareCase {
	readonly world: World
	readonly items: NonEmptyReadonlyArray<Item>
	readonly shape: ShareShape
	readonly shared: Shared
	readonly arms: ReadonlyArray<Term>
	readonly term: Term
}

/**
 * Whether a case's drawn arms read its shared subterm themselves, where an arm's read is one more evaluation of it
 * than the shape's: its text appears in an arm's.
 */
export const armsReadShared = (sc: ShareCase): boolean => {
	const shared = sc.shared.kind === "pred" ? sc.shared.pred : sc.shared.term
	return Arr.some(sc.arms, (arm) => holds(arm, shared))
}

/** Whether `part` is `value` or a member of it at any depth, by canonical equality. */
const holds = (value: unknown, part: unknown): boolean =>
	canonicalEquals(value, part) ||
	(Arr.isArray(value)
		? Arr.some(value, (v) => holds(v, part))
		: isRecord(value) && Arr.some(Rec.values(value), (v) => holds(v, part)))

/** Pick's flag at the row's own kind: NULL where Pick holds no row at it. */
const flagRead: Term = { t: "at", field: "flag", key: { k: "own" } }

/** Whether `term` is the flag literal `code`. */
const isFlag = (term: Term, code: number): Pred => ({
	p: "cmp",
	op: "eq",
	a: term,
	b: { t: "lit", literal: { sort: "code", code } }
})

/** An integer term one operation deep. */
const intGen = (w: World): Gen<Term> => termGen(w, "int", 1, "check")

/**
 * An integer leaf, a row's integer or a literal: no two leaves share a part a factoring could take, so a split of two
 * conditionals over them is always the shorter text.
 */
const leafGen: Gen<Term> = weighted<Term>([
	[1, (s) => ({ t: "field", field: s.draw(element(["n", "m"] as const)) })],
	[1, (s) => ({ t: "lit", literal: { sort: "int", value: s.draw(int(-3, 3)) } })]
])

/**
 * A predicate the rewrite proves never NULL (share.ts nonNull): a presence in Pick at the row's kind, a comparison of a
 * row's integer or flag to a literal, and a conjunction, disjunction or negation of such, at most `depth` deep.
 */
const exactPredGen = (w: World, depth: number): Gen<Pred> => {
	const presence: Weighted<Pred> = [
		2,
		() => ({ p: "has", key: { rel: "pick", key: { k: "own" } } })
	]
	const leaves: ReadonlyArray<Weighted<Pred>> = [
		[
			3,
			(s) => ({
				p: "cmp",
				op: s.draw(element(["eq", "ne", "lt", "le", "gt", "ge"] as const)),
				a: { t: "field", field: s.draw(element(["n", "m"] as const)) },
				b: { t: "lit", literal: { sort: "int", value: s.draw(int(-3, 3)) } }
			})
		],
		[2, (s) => isFlag({ t: "field", field: "flag" }, s.draw(int(0, w.flags - 1)))]
	]
	const connectives: ReadonlyArray<Weighted<Pred>> =
		depth <= 0
			? []
			: [
					[
						2,
						(s) => ({
							p: s.draw(element(["and", "or"] as const)),
							args: [s.draw(exactPredGen(w, depth - 1)), s.draw(exactPredGen(w, depth - 1))]
						})
					],
					[1, (s) => ({ p: "not", arg: s.draw(exactPredGen(w, depth - 1)) })]
				]
	return weighted([presence, ...leaves, ...connectives])
}

/**
 * The greater of two integer terms, an integer: GREATEST evaluates each of its operands once, where a narrowing of their
 * sum would print the sum twice, in its bound's test and in its value.
 */
const both = (a: Term, b: Term): Term => ({ t: "extremum", op: "greatest", a, b })

/** A case of a world, its rows and a shape. */
export const caseGen: Gen<ShareCase> = (s) => {
	const world = s.draw(worldGen)
	const item = itemGen(world)
	const items: NonEmptyReadonlyArray<Item> = [
		s.draw(item),
		...s.draw(array(item, { min: 0, max: 4 }))
	]
	const [x, y, z, w] = [
		s.draw(intGen(world)),
		s.draw(intGen(world)),
		s.draw(intGen(world)),
		s.draw(intGen(world))
	]
	const arms = [x, y, z, w]
	const leaves = [s.draw(leafGen), s.draw(leafGen), s.draw(leafGen), s.draw(leafGen)] as const
	const code = int(0, world.flags - 1)
	const always: NonEmptyReadonlyArray<ShareShape> = [
		"a boolean twice",
		"a flag compared twice",
		"a guarded flag",
		"two arms of one context",
		"a drawn term"
	]
	const shapes: NonEmptyReadonlyArray<ShareShape> =
		world.flags < 2
			? always
			: world.flags < 3
				? [...always, "a flag in two conditionals"]
				: [...always, "a flag in two conditionals", "a guarded chain"]
	const shape = s.draw(element(shapes))
	const flag = { kind: "flag", term: flagRead } as const
	switch (shape) {
		case "a boolean twice": {
			const b = s.draw(exactPredGen(world, 2))
			const [lx, ly, lz, lw] = leaves
			return {
				world,
				items,
				shape,
				shared: { kind: "pred", pred: b },
				arms: leaves,
				term: both({ t: "cond", p: b, a: lx, b: ly }, { t: "cond", p: b, a: lz, b: lw })
			}
		}
		case "a flag compared twice":
			return {
				world,
				items,
				shape,
				shared: flag,
				arms: [x, y, z],
				term: {
					t: "cond",
					p: isFlag(flagRead, s.draw(code)),
					a: x,
					b: { t: "cond", p: isFlag(flagRead, s.draw(code)), a: y, b: z }
				}
			}
		case "a flag in two conditionals": {
			const absent = world.kinds - 1
			const first = s.draw(code)
			const second = (first + s.draw(int(1, world.flags - 1))) % world.flags
			const lit = (value: number): Term => ({ t: "lit", literal: { sort: "int", value } })
			return {
				world: {
					...world,
					pick: Arr.map(world.pick, (p, kind) =>
						kind === absent || p === undefined
							? undefined
							: { ...p, flag: s.draw(element([first, second] as const)) }
					)
				},
				items: [...items, { ...s.draw(item), kind: absent }],
				shape,
				shared: flag,
				arms: [lit(5), lit(2), lit(3), lit(4)],
				term: both(
					{ t: "cond", p: isFlag(flagRead, first), a: lit(5), b: lit(2) },
					{ t: "cond", p: isFlag(flagRead, second), a: lit(3), b: lit(4) }
				)
			}
		}
		case "a guarded flag":
			return {
				world,
				items,
				shape,
				shared: flag,
				arms,
				term: {
					t: "cond",
					p: { p: "has", key: { rel: "pick", key: { k: "own" } } },
					a: both(
						{ t: "cond", p: isFlag(flagRead, s.draw(code)), a: x, b: y },
						{ t: "cond", p: isFlag(flagRead, s.draw(code)), a: z, b: w }
					),
					b: x
				}
			}
		case "two arms of one context":
			return {
				world,
				items,
				shape,
				shared: flag,
				arms,
				term: {
					t: "cond",
					p: s.draw(exactPredGen(world, 1)),
					a: both(x, { t: "lit", literal: { sort: "int", value: 0 } }),
					b: both(y, { t: "lit", literal: { sort: "int", value: 0 } })
				}
			}
		case "a guarded chain": {
			const first = s.draw(code)
			const second = (first + s.draw(int(1, world.flags - 1))) % world.flags
			/** The least of the flags 0, 1 and 2 that is neither tested one: the world holds three flags at least. */
			const k = first !== 0 && second !== 0 ? 0 : first !== 1 && second !== 1 ? 1 : 2
			const lit = (value: number): Term => ({ t: "lit", literal: { sort: "int", value } })
			const holding = (flag: number) => ({ flag, n: 0, d: 0, t: "", b: false, x: 0, y: 0 })
			const kinds = Math.max(2, world.kinds)
			const chain: Term = {
				t: "cond",
				p: isFlag(flagRead, first),
				a: lit(1),
				b: { t: "cond", p: isFlag(flagRead, second), a: lit(2), b: lit(3) }
			}
			return {
				world: {
					...world,
					kinds,
					pick: Array.from({ length: kinds }, (_, kind) =>
						kind === 0 ? holding(k) : kind === 1 ? holding(first) : world.pick[kind]
					),
					allowed: [
						...world.allowed,
						...Array.from({ length: kinds - world.kinds }, (): ReadonlyArray<number> => [])
					]
				},
				items: [...items, { ...s.draw(item), kind: 1 }],
				shape,
				shared: flag,
				arms: [lit(1), lit(2), lit(3)],
				term: {
					t: "cond",
					p: { p: "has", key: { rel: "pick", key: { k: "own" } } },
					a: chain,
					b: lit(3)
				}
			}
		}
		case "a drawn term":
			return {
				world,
				items,
				shape,
				shared: flag,
				arms: [],
				term: s.draw(termGen(world, "int", 3, "check"))
			}
	}
}

/**
 * The schema of a case: its world's closed relations, and Gen, the rows' fields with the generated field g of the
 * case's term and h of its shared subterm alone: a flag's read, or a predicate's conditional of 1 and 0.
 */
const builtOf = (sc: ShareCase) => {
	const c = closedOf(sc.world)
	const Gen = generatedRelation(
		"Gen",
		itemFields(c),
		["id"],
		(r) => ({
			g: generatedField(storedField(c, "int"), buildTerm(c, r, sc.term), []),
			h:
				sc.shared.kind === "pred"
					? generatedField(
							storedField(c, "int"),
							buildTerm(c, r, {
								t: "cond",
								p: sc.shared.pred,
								a: { t: "lit", literal: { sort: "int", value: 1 } },
								b: { t: "lit", literal: { sort: "int", value: 0 } }
							}),
							[]
						)
					: generatedField(storedField(c, "code"), buildTerm(c, r, sc.shared.term), [])
		}),
		[]
	)
	return { c, schema: schema("Shared", [...Rec.values(c), Gen], []) }
}

/** A case's installation, from nothing under its schema's own levels. */
export const installationOfCase = (sc: ShareCase): Installation => {
	const owned = succeeded(ownedInput(builtOf(sc).schema), "the case's schema owns")
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		),
		"the case's schema installs"
	)
}

/** The IR expression of Gen's generated field `field` in an installation's law model. */
export const generatedExpr = (installation: Installation, field: "g" | "h"): ScalarExpr => {
	const gen = defined(installation.checked.relations.get("Gen"), "the relation Gen")
	const writing = defined(
		Option.getOrUndefined(Arr.findFirst(gen.fields, (f) => f.name === field)),
		`the field ${field} of Gen`
	).writing
	return writing.kind === "generated" ? writing.expr : assert.fail(`${field} is generated`)
}

/** The SQL text of Gen's generated column of `field` as the installation creates it. */
export const generatedSql = (installation: Installation, field: "g" | "h"): string => {
	const table = installation.names.relation("Gen")
	const column = installation.names.column("Gen", field)
	const create = defined(
		Arr.flatMap(installation.statements, (st) =>
			st.kind === "createTable" && st.table.name === table.name ? [st] : []
		)[0],
		"Gen's CREATE TABLE"
	)
	const generation = defined(
		Option.getOrUndefined(Arr.findFirst(create.columns, (col) => col.name === column)),
		`the column of ${field}`
	).generated
	return generation?.kind === "stored"
		? printExpr(generation.expr)
		: assert.fail(`${field}'s column is a stored generation`)
}

/**
 * The SQL text of a case's shared subterm as the installation prints it: h's column, a flag's read itself, or a
 * predicate's `CASE WHEN <predicate> THEN 1 ELSE 0 END`, the predicate's text before its last THEN; undefined where the
 * rewrite folded the predicate away, as it folds `has(k) AND NOT has(k)` to false, so no row evaluates it.
 */
export const sharedSql = (installation: Installation, sc: ShareCase): string | undefined => {
	const h = generatedSql(installation, "h")
	if (sc.shared.kind === "flag") {
		return h
	}
	const lead = "CASE WHEN "
	const then = Option.getOrUndefined(Str.lastIndexOf(" THEN ")(h))
	return Str.startsWith(lead)(h) && then !== undefined && then > lead.length
		? Str.slice(lead.length, then)(h)
		: undefined
}

/** How many times `part` occurs in `text`, none overlapping. */
export const occurrences = (text: string, part: string): number =>
	part.length === 0 ? 0 : Str.split(part)(text).length - 1
