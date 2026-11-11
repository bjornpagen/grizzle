/**
 * A definition is a relation: a derived relation's or a role's query entry's that ends in `.orderBy(...).take(k)`
 * installs its take's ORDER BY and LIMIT and no order beside them, since a view's rows are a set to everything that
 * reads it, though a query that ends in the same take delivers its rows in the take's order.
 *
 * Property: over a drawn base relation R (one to three fields of integer, bigint and uuid, its primary key a drawn
 * prefix of them) and two drawn definitions over it, a derived relation's and a role's query entry's, each one rule,
 * a union of two or a count grouped by its head, ordered by drawn head columns and taking a drawn k: no SELECT of
 * any installed materialized view or role view orders rows it does not limit, and the derived relation's
 * materialized view and some role view each hold a limited SELECT, the take.
 *
 * Oracle: the specification that a view's rows are a set, read off the installed statements' typed SQL (an ORDER BY
 * with no LIMIT is a delivered order), never their text.
 *
 * Plant: take-definition-ordered (check/checker.ts rootOrder delivers a definition's rows in its take's order, as a
 * root a caller reads).
 *
 * Features: each owner (a derived relation, a world entry) taking from each form (one rule, a union, a count), a
 * take of one row, of two rows or more, and a descending key.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { Direction } from "#compiler/core/order.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { login } from "#compiler/program/workload/login.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { type QueryValue, queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { materializedDerived, relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { loginDescOf, role } from "#compiler/schema/world.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import { owning } from "#test/support/policy.ts"

/** The field types a base relation declares: each ordered, and a key alone. */
const fieldTypes = { int: pg.integer, bigint: pg.bigint, uuid } as const
type FieldType = keyof typeof fieldTypes

const fieldTypeGen: Gen<FieldType> = element<FieldType>(["int", "bigint", "uuid"])

/** What a take reads, each by the name a case notes it under: one rule, a union of two, a count grouped by its head. */
const forms = { rule: "one rule", union: "a union", count: "a count" } as const
type Form = keyof typeof forms

/** Who owns a definition, by the name a case notes it under. */
type Owner = "a derived relation" | "a world entry"

/**
 * A definition that ends in `.orderBy(...).take(k)` over the base relation R, whose every rule matches R binding each
 * field to a variable of its own: its form; the fields its head finds, those whose flag is set, R's first where none
 * is; its stated order, each key a head column by position, a column's first statement kept; and k.
 */
interface DefinitionSketch {
	readonly form: Form
	readonly head: ReadonlyArray<boolean>
	readonly order: ReadonlyArray<{ readonly at: number; readonly desc: boolean }>
	readonly k: number
}

/**
 * A case: R's field types, how many of its first fields its primary key holds, and two definitions over R, a derived
 * relation's and a role's query entry's.
 */
interface Sketch {
	readonly fields: Arr.NonEmptyReadonlyArray<FieldType>
	readonly key: number
	readonly derived: DefinitionSketch
	readonly world: DefinitionSketch
}

const definitionGen: Gen<DefinitionSketch> = (source) => ({
	form: source.draw(element<Form>(["rule", "union", "count"])),
	head: source.draw(array(boolean, { min: 3, max: 3 })),
	order: source.draw(
		array((s) => ({ at: s.draw(int(0, 3)), desc: s.draw(boolean) }), { min: 1, max: 3 })
	),
	k: source.draw(int(1, 3))
})

const sketchGen: Gen<Sketch> = (source) => ({
	fields: [source.draw(fieldTypeGen), ...source.draw(array(fieldTypeGen, { min: 0, max: 2 }))],
	key: source.draw(int(1, 3)),
	derived: source.draw(definitionGen),
	world: source.draw(definitionGen)
})

/** What a case reached: which owner's definition takes from which form, how many rows a take keeps, a descending key. */
type TakeFeature =
	| `${Owner} taking from ${(typeof forms)[Form]}`
	| "a take of one row"
	| "a take of two rows or more"
	| "a descending key"

const situations: Arr.NonEmptyReadonlyArray<TakeFeature> = [
	"a derived relation taking from one rule",
	"a derived relation taking from a union",
	"a derived relation taking from a count",
	"a world entry taking from one rule",
	"a world entry taking from a union",
	"a world entry taking from a count",
	"a take of one row",
	"a take of two rows or more",
	"a descending key"
]

const featuresOf = (owner: Owner, d: DefinitionSketch): ReadonlyArray<TakeFeature> => [
	`${owner} taking from ${forms[d.form]}`,
	d.k === 1 ? "a take of one row" : "a take of two rows or more",
	...(Arr.some(d.order, (o) => o.desc) ? (["a descending key"] as const) : [])
]

/** One key of an orderBy: a head column and its direction. */
type OrderArgument = readonly [string, Direction]

/** The definition a sketch states over R, its rules over the schema `over`; a count's column is `n`. */
const definitionOf = (
	over: unknown,
	R: unknown,
	fields: Arr.NonEmptyReadonlyArray<string>,
	d: DefinitionSketch
): QueryValue => {
	const found = Arr.filter(fields, (_, i) => d.head[i] === true)
	const head: Arr.NonEmptyReadonlyArray<string> = Arr.isReadonlyArrayNonEmpty(found)
		? found
		: [fields[0]]
	const rule = (r: RuleValue): FinishedValue => {
		const x = v(R, "r")
		const finds = Rec.fromEntries(Arr.map(head, (f) => [f, x[f]] as const))
		return r.match(R, x).find(d.form === "count" ? { ...finds, n: r.count() } : finds)
	}
	const arms = d.form === "union" ? query(over).rule(rule).rule(rule) : query(over).rule(rule)
	const heading: Arr.NonEmptyReadonlyArray<string> =
		d.form === "count" ? Arr.append(head, "n") : head
	const order = Arr.dedupeWith(
		Arr.map(d.order, (o): OrderArgument => [
			defined(heading[o.at % heading.length], "a head column"),
			o.desc ? "desc" : "asc"
		]),
		(a: OrderArgument, b: OrderArgument) => a[0] === b[0]
	)
	return arms.orderBy(...argumentsOf(order)).take(d.k)
}

/**
 * A case's installation: R, the derived relation D over it, and the role `reader` of the whole entry R and the query
 * entry W over R, in the login `app`.
 */
const installed = (s: Sketch): ReadonlyArray<SqlStatement> => {
	const fields = Arr.map(s.fields, (_, i) => `f${i}` as const)
	const R = relation(
		"R",
		Rec.fromEntries(Arr.map(s.fields, (t, i) => [`f${i}`, fieldTypes[t]] as const)),
		Arr.take(fields, s.key),
		[]
	)
	const Base = schema("Base", [R], [], [])
	const D = materializedDerived("D", definitionOf(Base, R, fields, s.derived), [])
	const S = schema.extend(Base, "S", [D], [], [])
	const reader = role(
		S,
		"reader",
		{ R, W: definitionOf(S, R, fields, s.world) },
		{ write: [], refresh: [] }
	)
	const app = defined(loginDescOf(login(S, "app", [reader])), "a login built by login(...)")
	const owned = owning(S)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				installationsOf(owned),
				[succeeded(ownLogin(app))],
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	).statements
}

/** The SELECTs of `statement` that order their rows, those that limit them and those that do not. */
const orderings = (
	statement: SqlStatement
): { readonly limited: number; readonly unlimited: number } => {
	let limited = 0
	let unlimited = 0
	transformStatement(statement, {
		...identityHooks,
		select: (s) => {
			if (s.orderBy.length > 0 && s.limit === undefined) {
				unlimited++
			} else if (s.orderBy.length > 0) {
				limited++
			}
			return s
		}
	})
	return { limited, unlimited }
}

/** The installed views of a case hold no order beside a take, and the derived relation's and the entry's hold theirs. */
const installsNoOrder = (s: Sketch): void => {
	const views = Arr.filter(
		installed(s),
		(st) => st.kind === "createMaterializedView" || st.kind === "createView"
	)
	for (const view of views) {
		assert.equal(orderings(view).unlimited, 0, "a view SELECT that orders rows it does not limit")
	}
	const taking = (kind: "createMaterializedView" | "createView"): boolean =>
		Arr.some(views, (st) => st.kind === kind && orderings(st).limited > 0)
	assert.ok(taking("createMaterializedView"), "the derived relation's view holds its take")
	assert.ok(taking("createView"), "the query entry's view holds its take")
}

describe("a definition that ends in a take", () => {
	it.effect("installs its take's order and no order beside it", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/derived/take",
					draw: drawn(sketchGen),
					literal: Formatter.format,
					oracle: {
						kind: "specification",
						name: "a view's rows are a set: no installed SELECT orders rows it does not limit"
					},
					coverage: required<TakeFeature>(situations, { cases: 200, sense: notesOnly }),
					kept: [],
					runs: 120,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(s, k) =>
					Effect.sync(() => {
						k.noteAll([
							...featuresOf("a derived relation", s.derived),
							...featuresOf("a world entry", s.world)
						])
						installsNoOrder(s)
					})
			)
		)
	)
})
