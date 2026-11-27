/**
 * What the properties of share.test.ts read: their cases, a world of the NULL language (test/support/null/language.ts)
 * with rows of it and a generated field built to read one subterm more than once, the schema that states it beside a
 * second generated field of that subterm alone, and the installation and law model the schema compiles to; and the
 * cases of a factoring's work, a world whose Pick holds as many values as it has kinds (`countedWorld`) and a
 * conditional over a read of it, whose arms no value makes one of the other (`apartGen`) or whose ELSE arm is its THEN
 * arm at a value (`valueArmGen`).
 */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isRecord } from "#compiler/core/record.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { lowerPersistent } from "#compiler/physical/ddl/expr.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { schema } from "#compiler/public/schema.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { tableCol } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
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
 * - "a float read twice": `cond(Pick.has(kind), greatest(x, x), z)` or least's, a double precision term, `x` Pick's
 *   double at the row's kind, which Pick holds as 0 at one of the first two kinds and as -0 at the other, in a drawn
 *   order, and rows read both: `=` holds the two zeros equal, so a split's test of `x = 0` meets both, where the
 *   extremum is 0 at one and -0 at the other;
 * - "a drawn term": a term of the language, which reads a subterm twice only by chance.
 */
export type ShareShape =
	| "a boolean twice"
	| "a flag compared twice"
	| "a flag in two conditionals"
	| "a guarded flag"
	| "two arms of one context"
	| "a guarded chain"
	| "a float read twice"
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

/** A case's shared subterm: a predicate, a term of a flag, or a term of a double. */
export type Shared =
	| { readonly kind: "pred"; readonly pred: Pred }
	| { readonly kind: "flag"; readonly term: Term }
	| { readonly kind: "float"; readonly term: Term }

/**
 * A case: its world, one to five rows, its shape, its shared subterm, the drawn terms the shape's conditionals choose
 * between, and the generated field's term over them with its sort, an integer's or a double's.
 */
export interface ShareCase {
	readonly world: World
	readonly items: NonEmptyReadonlyArray<Item>
	readonly shape: ShareShape
	readonly shared: Shared
	readonly arms: ReadonlyArray<Term>
	readonly sort: "int" | "f8"
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
		"a float read twice",
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
				sort: "int",
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
				sort: "int",
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
				sort: "int",
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
				sort: "int",
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
				sort: "int",
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
				sort: "int",
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
		case "a float read twice": {
			const kinds = Math.max(2, world.kinds)
			const first = s.draw(boolean) ? -0 : 0
			const zeros = [first, Object.is(first, -0) ? 0 : -0] as const
			const x: Term = { t: "at", field: "x", key: { k: "own" } }
			return {
				world: {
					...world,
					kinds,
					pick: Array.from({ length: kinds }, (_, kind) => {
						const zero = zeros[kind]
						const held = world.pick[kind]
						return zero === undefined
							? held
							: { ...(held ?? { flag: 0, n: 0, d: 0, t: "", b: false, x: 0, y: 0 }), x: zero }
					}),
					allowed: [
						...world.allowed,
						...Array.from({ length: kinds - world.kinds }, (): ReadonlyArray<number> => [])
					]
				},
				items: [...items, { ...s.draw(item), kind: 0 }, { ...s.draw(item), kind: 1 }],
				shape,
				sort: "f8",
				shared: { kind: "float", term: x },
				arms: [],
				term: {
					t: "cond",
					p: { p: "has", key: { rel: "pick", key: { k: "own" } } },
					a: { t: "extremum", op: s.draw(element(["greatest", "least"] as const)), a: x, b: x },
					b: s.draw(termGen(world, "f8", 1, "check"))
				}
			}
		}
		case "a drawn term":
			return {
				world,
				items,
				shape,
				sort: "int",
				shared: flag,
				arms: [],
				term: s.draw(termGen(world, "int", 3, "check"))
			}
	}
}

/** What a case's schema is built of: its world, its term and its sort, and its shared subterm. */
type Built = Pick<ShareCase, "world" | "term" | "shared" | "sort">

/** A shared subterm alone as a stored sort and a term: a flag's or a double's read, a predicate's conditional of 1 and 0. */
const sharedAlone = (
	shared: Shared
): { readonly sort: "int" | "code" | "f8"; readonly term: Term } => {
	switch (shared.kind) {
		case "pred":
			return {
				sort: "int",
				term: {
					t: "cond",
					p: shared.pred,
					a: { t: "lit", literal: { sort: "int", value: 1 } },
					b: { t: "lit", literal: { sort: "int", value: 0 } }
				}
			}
		case "flag":
			return { sort: "code", term: shared.term }
		case "float":
			return { sort: "f8", term: shared.term }
	}
}

/**
 * The schema of a case: its world's closed relations, and Gen, the rows' fields with the generated field g of the
 * case's term and h of its shared subterm alone (sharedAlone).
 */
const builtOf = (sc: Built) => {
	const c = closedOf(sc.world)
	const alone = sharedAlone(sc.shared)
	const Gen = generatedRelation(
		"Gen",
		itemFields(c),
		["id"],
		(r) => ({
			g: generatedField(storedField(c, sc.sort), buildTerm(c, r, sc.term), []),
			h: generatedField(storedField(c, alone.sort), buildTerm(c, r, alone.term), [])
		}),
		[]
	)
	return { c, schema: schema("Shared", [...Rec.values(c), Gen], []) }
}

/** A case's installation, from nothing under its schema's own levels. */
export const installationOfCase = (sc: Built): Installation => {
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

/**
 * The SQL text of what Gen's generated column of `field` computes as the installation creates it: its generation, or,
 * where the installation hoists it into a row function (physical/ddl/row-functions.ts), that function's body, each
 * column the function's parameter by position, which is the expression the column's call evaluates.
 */
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
	if (generation?.kind !== "stored") {
		return assert.fail(`${field}'s column is a stored generation`)
	}
	const expr = generation.expr
	const body =
		expr.kind === "call" && expr.fn.kind === "qualified"
			? rowFunctionBody(installation, expr.fn.name)
			: undefined
	return printExpr(body ?? expr)
}

/** The body of the installation's row function `name`, a PL/pgSQL constant; none where it creates no such function. */
const rowFunctionBody = (installation: Installation, name: string): Expr | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(
			Arr.flatMap(installation.statements, (st) =>
				st.kind === "createConstant" && st.language === "plpgsql" && st.name.name === name
					? [st.body]
					: []
			),
			() => true
		)
	)

/**
 * The SQL text of a case's shared subterm as the installation prints it: h's column, a flag's or a double's read
 * itself, or a predicate's `CASE WHEN <predicate> THEN 1 ELSE 0 END`, the predicate's text before its last THEN;
 * undefined where the rewrite folded the predicate away, as it folds `has(k) AND NOT has(k)` to false, so no row
 * evaluates it.
 */
export const sharedSql = (installation: Installation, sc: ShareCase): string | undefined => {
	const h = generatedSql(installation, "h")
	switch (sc.shared.kind) {
		case "flag":
		case "float":
			return h
		case "pred":
			return predicateText(h)
	}
}

/** A predicate's text in h's `CASE WHEN <predicate> THEN 1 ELSE 0 END`, before its last THEN (sharedSql). */
const predicateText = (h: string): string | undefined => {
	const lead = "CASE WHEN "
	const then = Option.getOrUndefined(Str.lastIndexOf(" THEN ")(h))
	return Str.startsWith(lead)(h) && then !== undefined && then > lead.length
		? Str.slice(lead.length, then)(h)
		: undefined
}

/** How many times `part` occurs in `text`, none overlapping. */
export const occurrences = (text: string, part: string): number =>
	part.length === 0 ? 0 : Str.split(part)(text).length - 1

/**
 * Gen's generated field g lowered as its column's persistent SQL (physical/ddl/expr.ts lowerPersistent), as the
 * installation's table lowers it (physical/ddl/tables.ts): each column it reads Gen's own.
 */
export const loweredG = (installation: Installation, g: ScalarExpr): string =>
	printExpr(
		lowerPersistent(installation.names, g, {
			reads: {
				kind: "row",
				column: (ref) => tableCol(installation.names.column("Gen", ref.name))
			},
			loc: SourceLoc("Gen.g", [])
		})
	)

/**
 * A world of `kinds` kinds and `flags` flags whose Pick holds a row at every kind, its integer `n` the kind's code, so a
 * read of Pick's `n` takes `kinds` values; and no row of Wt and Next, whose reads no case here makes.
 */
export const countedWorld = (kinds: number, flags: number): World => ({
	kinds,
	flags,
	pick: Array.from({ length: kinds }, (_, kind) => ({
		flag: kind % flags,
		n: kind,
		d: 0,
		t: "",
		b: false,
		x: 0,
		y: 0
	})),
	weight: Array.from({ length: flags }, () => undefined),
	succ: Array.from({ length: flags }, () => undefined),
	next: Array.from({ length: flags }, () => []),
	allowed: Array.from({ length: kinds }, () => [])
})

/**
 * The installation of a work case's world and integer term as g, h Pick's flag at the row's kind, which no work case
 * reads.
 */
export const installationOfTerm = (world: World, term: Term): Installation =>
	installationOfCase({ world, term, sort: "int", shared: { kind: "flag", term: flagRead } })

/** Pick's integer at the row's own kind: in a countedWorld, one of as many values as the world has kinds. */
const countRead: Term = { t: "at", field: "n", key: { k: "own" } }

/** An integer literal. */
const intLit = (value: number): Term => ({ t: "lit", literal: { sort: "int", value } })

/**
 * A conditional whose arms are operations of two kinds: `cond(p, greatest(T, a), least(f, b))`, T Pick's `n` at the
 * row's kind, alone or beside a leaf under an extremum, f a row's integer and a, b leaves. Neither arm holds a
 * conditional, and the THEN arm at no value of T's read is the ELSE arm, a least of a row's integer, so a factoring of
 * it tries no value. No closed read in it is read twice, so a split it takes is of a predicate, whose values are true
 * and false at every size of its world. `kinds` is that size, its kinds, and `flags` its flags.
 */
export interface ApartCase {
	readonly kinds: number
	readonly flags: number
	readonly read: ApartRead
	readonly term: Term
}

/** How an apart case's THEN arm reads Pick's `n`: alone under its greatest, or beside a leaf under an extremum. */
export type ApartRead = "a read alone" | "a read beside a leaf"

/** An apart case: a world of one to three kinds, and its conditional. */
export const apartGen: Gen<ApartCase> = (s) => {
	const kinds = s.draw(int(1, 3))
	const flags = s.draw(int(1, 3))
	const form = s.draw(element(["a read alone", "a read beside a leaf"] as const))
	const op = s.draw(element(["greatest", "least"] as const))
	const leaf = s.draw(leafGen)
	const read: Term =
		form === "a read alone"
			? countRead
			: s.draw(boolean)
				? { t: "extremum", op, a: countRead, b: leaf }
				: { t: "extremum", op, a: leaf, b: countRead }
	return {
		kinds,
		flags,
		read: form,
		term: {
			t: "cond",
			p: s.draw(exactPredGen(countedWorld(kinds, flags), 1)),
			a: { t: "extremum", op: "greatest", a: read, b: s.draw(leafGen) },
			b: {
				t: "extremum",
				op: "least",
				a: { t: "field", field: s.draw(element(["n", "m"] as const)) },
				b: s.draw(leafGen)
			}
		}
	}
}

/**
 * How a conditional's ELSE arm is its THEN arm at a value of Pick's `n` at the row's kind, the arm folded (share.ts
 * #substituted), where the arms differ at more than one pair, so only a factoring that tries the read's values makes
 * it:
 *
 * - "a decided conditional": `cond(p, cond(n = v, 1001, 1002), 1002)`, the THEN arm at any value but v its own ELSE arm,
 *   which the factoring makes `cond(cond(p, n, w) = v, 1001, 1002)`, w the first value but v;
 * - "a constant operation": `cond(p, greatest(n, 1001), 1001)`, the THEN arm at any value 1001, every value of n being
 *   below it, which the factoring makes `greatest(cond(p, n, 0), 1001)`.
 */
export type ValueArm = "a decided conditional" | "a constant operation"

/**
 * A case of an arm at a value: its world of two to four kinds, the arm's kind, the conditional, its condition one
 * predicate of no connective, so no subterm of it is read twice and no split takes it, and the literal its ELSE arm is,
 * which the factored column prints once.
 */
export interface ValueArmCase {
	readonly world: World
	readonly arm: ValueArm
	readonly term: Term
	readonly literal: number
}

/** A case of an arm at a value. */
export const valueArmGen: Gen<ValueArmCase> = (s) => {
	const kinds = s.draw(int(2, 4))
	const world = countedWorld(kinds, s.draw(int(1, 3)))
	const p = s.draw(exactPredGen(world, 0))
	const arm = s.draw(element(["a decided conditional", "a constant operation"] as const))
	switch (arm) {
		case "a decided conditional":
			return {
				world,
				arm,
				literal: 1002,
				term: {
					t: "cond",
					p,
					a: {
						t: "cond",
						p: { p: "cmp", op: "eq", a: countRead, b: intLit(s.draw(int(0, kinds - 1))) },
						a: intLit(1001),
						b: intLit(1002)
					},
					b: intLit(1002)
				}
			}
		case "a constant operation":
			return {
				world,
				arm,
				literal: 1001,
				term: {
					t: "cond",
					p,
					a: { t: "extremum", op: "greatest", a: countRead, b: intLit(1001) },
					b: intLit(1001)
				}
			}
	}
}
