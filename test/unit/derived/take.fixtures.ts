/** What the properties of take.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import type { Direction } from "#compiler/core/order.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { login } from "#compiler/program/workload/login.ts"
import { int4, int8 } from "#compiler/public/fields.ts"
import { queryOver as query, type QueryValue, varsOver as v } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { loginDescOf, roleBuilder as role } from "#compiler/schema/world.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { argumentsOf } from "#test/support/list.ts"
import { owning } from "#test/support/policy.ts"

/** The field types a base relation declares: each ordered, and a key alone. */
const fieldTypes = { int: int4, bigint: int8, uuid: Id } as const

type FieldType = keyof typeof fieldTypes

const fieldTypeGen: Gen<FieldType> = element<FieldType>(["int", "bigint", "uuid"])

/** What a take reads, each by the name a case notes it under: one rule, a union of two, a count grouped by its head. */
const forms = { rule: "one rule", union: "a union", count: "a count" } as const

type Form = keyof typeof forms

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
 * A case: R's field types, how many of its first fields its primary key holds, and a role's query entry's definition
 * over R.
 */
interface Sketch {
	readonly fields: Arr.NonEmptyReadonlyArray<FieldType>
	readonly key: number
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

export const sketchGen: Gen<Sketch> = (source) => ({
	fields: [source.draw(fieldTypeGen), ...source.draw(array(fieldTypeGen, { min: 0, max: 2 }))],
	key: source.draw(int(1, 3)),
	world: source.draw(definitionGen)
})

/** What a case reached: which form the entry's definition takes from, how many rows a take keeps, a descending key. */
export type TakeFeature =
	| `a world entry taking from ${(typeof forms)[Form]}`
	| "a take of one row"
	| "a take of two rows or more"
	| "a descending key"

export const situations: Arr.NonEmptyReadonlyArray<TakeFeature> = [
	"a world entry taking from one rule",
	"a world entry taking from a union",
	"a world entry taking from a count",
	"a take of one row",
	"a take of two rows or more",
	"a descending key"
]

export const featuresOf = (d: DefinitionSketch): ReadonlyArray<TakeFeature> => [
	`a world entry taking from ${forms[d.form]}`,
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

/** A case's installation: R, and the role `reader` of the whole entry R and the query entry W over R, in the login `app`. */
const installed = (s: Sketch): ReadonlyArray<SqlStatement> => {
	const fields = Arr.map(s.fields, (_, i) => `f${i}` as const)
	const R = relation(
		"R",
		Rec.fromEntries(Arr.map(s.fields, (t, i) => [`f${i}`, fieldTypes[t]] as const)),
		Arr.take(fields, s.key),
		[]
	)
	const S = schema("Base", [R], [], [])
	const reader = role(S, "reader", { R, W: definitionOf(S, R, fields, s.world) }, { write: [] })
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

/** The installed views of a case hold no order beside a take, and the entry's holds its own. */
export const installsNoOrder = (s: Sketch): void => {
	const views = Arr.filter(installed(s), (st) => st.kind === "createView")
	for (const view of views) {
		assert.equal(orderings(view).unlimited, 0, "a view SELECT that orders rows it does not limit")
	}
	assert.ok(
		Arr.some(views, (st) => orderings(st).limited > 0),
		"the query entry's view holds its take"
	)
}
