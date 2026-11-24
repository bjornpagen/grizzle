/** What the property of reached-calls.test.ts reads: its schema, its login's roles and their programs, its space and its
 * model of what each role reaches. */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import type { FunctionVolatility } from "#compiler/core/function.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { type AnyRole, derived, fn, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { loginBuilder as login } from "#compiler/schema/world.ts"
import type { AnyLoginRole } from "#compiler/types/schema/world.ts"

/**
 * A login whose roles each run their own programs over one schema, each program reaching a declared function in one way
 * or none: the base holds Item(doc, at, n), keyed by the document then the place, in the unit of its document, and five
 * functions of an integer, each an SQL body of its argument plus one, named by the one place that calls it (`callers`):
 * ownFn, which a program's own head calls; derivedFn, which the definition of Derived over Item calls, a level above;
 * nestedFn, which the definition of Under over Item calls, beside Derived, read by Nested over Under a level above them,
 * two derived relations down; entryFn, which a role's query entry Entry over Item calls; and idleFn, which the definition
 * of Idle over Item calls, which no program reads. Each function is immutable or stable, as the case draws it: a
 * derived relation over an immutable one is stored, kept in its table under Document, and one over a stable one is live,
 * read through its definition (analysis/derived/storage.ts), Nested as Under is.
 *
 * Each role holds Item whole, and Entry where it reads it or as the case draws it, inserts into Item where it writes,
 * and runs one program of each reading it draws (`readings`): the rows of Item with ownFn of each value, of Derived, of
 * Nested, of Entry, or of Item as they are. A reader's program is the query of those rows; a writer's inserts into Item,
 * at place `to` of document `doc`, the value those rows hold at place `at` of it, so it writes a holder of every derived
 * relation and reads a stored one through its definition (analysis/schema.ts CheckedSchema serves).
 */

const Item = relation("Item", { doc: pg.integer, at: pg.integer, n: pg.integer }, ["doc", "at"])

const Document = unit("Document", { doc: pg.integer })

/** The declared functions, each by the one place that calls it. */
export const callers = ["own", "derived", "nested", "entry", "idle"] as const

export type Caller = (typeof callers)[number]

/** What a function is declared, each a volatility a derived relation over it is stored or live by. */
const volatilities = ["immutable", "stable"] as const satisfies ReadonlyArray<FunctionVolatility>

type Volatility = (typeof volatilities)[number]

/** Each function's declared name, by its caller, so each row the catalog answers names its caller. */
export const functionNames = {
	own: "ownFn",
	derived: "derivedFn",
	nested: "nestedFn",
	entry: "entryFn",
	idle: "idleFn"
} as const satisfies { readonly [C in Caller]: string }

/** A function of an integer, of `volatility`: its argument plus one. */
const declaredAs = (volatility: Volatility) =>
	({
		calls: [],
		args: { x: pg.integer },
		returns: pg.integer,
		volatility,
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT x + 1`
	}) as const

/** What a role's program reads: a relation whose rows reach a function, each the caller of its name, or Item alone. */
const readings = ["own", "derived", "nested", "entry", "plain"] as const

type Reading = (typeof readings)[number]

/** The function a program of each reading reaches: its caller's, and plain Item's none. */
const reachedBy: { readonly [R in Reading]: ReadonlyArray<Caller> } = {
	own: ["own"],
	derived: ["derived"],
	nested: ["nested"],
	entry: ["entry"],
	plain: []
}

/** The roles a login may hold, in order: a case's are the first of them. */
const roleNames = ["first", "second", "third"] as const

type RoleName = (typeof roleNames)[number]

/** One role of a case: the readings it runs a program of, whether it writes, and whether it holds Entry. */
export interface RoleCase {
	readonly name: RoleName
	readonly readings: ReadonlyArray<Reading>
	readonly writes: boolean
	readonly entry: boolean
}

interface ItemFact {
	readonly doc: number
	readonly at: number
	readonly n: number
}

export interface ReachedCase {
	readonly volatility: { readonly [C in Caller]: Volatility }
	readonly roles: Arr.NonEmptyReadonlyArray<RoleCase>
	readonly items: ReadonlyArray<ItemFact>
}

/** The functions a role's programs reach, the model: each its readings reach. */
export const reachedOf = (r: RoleCase): ReadonlySet<Caller> =>
	new Set(Arr.flatMap(r.readings, (reading) => reachedBy[reading]))

/** The schema of a case's volatilities under `name`: Item and the functions at its root, Derived, Under and Idle a level
 * above, and Nested over Under a level above them. */
const levelsOf = (volatility: ReachedCase["volatility"], name: string) => {
	const ownFn = fn(functionNames.own, declaredAs(volatility.own))
	const derivedFn = fn(functionNames.derived, declaredAs(volatility.derived))
	const nestedFn = fn(functionNames.nested, declaredAs(volatility.nested))
	const entryFn = fn(functionNames.entry, declaredAs(volatility.entry))
	const idleFn = fn(functionNames.idle, declaredAs(volatility.idle))
	const base = schema(name, [Item, ownFn, derivedFn, nestedFn, entryFn, idleFn], [Document])
	const Derived = derived(
		"Derived",
		query(base).rule((r) => {
			const { doc, at, n } = v(Item, "item")
			return r.match(Item, { doc, at, n }).find({ doc, at, v: Fn.call(derivedFn, { x: n }) })
		})
	)
	const Under = derived(
		"Under",
		query(base).rule((r) => {
			const { doc, at, n } = v(Item, "item")
			return r.match(Item, { doc, at, n }).find({ doc, at, v: Fn.call(nestedFn, { x: n }) })
		})
	)
	const Idle = derived(
		"Idle",
		query(base).rule((r) => {
			const { doc, at, n } = v(Item, "item")
			return r.match(Item, { doc, at, n }).find({ doc, at, v: Fn.call(idleFn, { x: n }) })
		})
	)
	const middle = schema.extend([base], `${name}_m`, [Derived, Under, Idle], [])
	const Nested = derived(
		"Nested",
		query(middle).rule((r) => {
			const { doc, at, v: value } = v(Under, "under")
			return r.match(Under, { doc, at, v: value }).find({ doc, at, v: value })
		})
	)
	const top = schema.extend([middle], `${name}_t`, [Nested], [])
	/** Item's places with entryFn of each value: the query entry Entry. */
	const entry = query(top).rule((r) => {
		const { doc, at, n } = v(Item, "item")
		return r.match(Item, { doc, at, n }).find({ doc, at, v: Fn.call(entryFn, { x: n }) })
	})
	return { top, ownFn, Derived, Nested, entry }
}

type Levels = ReturnType<typeof levelsOf>

/**
 * The program of `reading` over the top level: a reader's, the query of its rows, each a document, a place and a value;
 * a writer's, the insert into Item, at place `to` of document `doc`, of the value its row at place `at` of it holds.
 */
const programOf = (
	levels: Levels,
	reading: Exclude<Reading, "entry">,
	writes: boolean
): unknown => {
	const { top, ownFn, Derived, Nested } = levels
	switch (reading) {
		case "own":
			return writes
				? ChangeSet.empty(top).insert(
						Item,
						query(top).rule((r) => {
							const doc = r.param("doc", pg.integer)
							const { n } = v(Item, "item")
							return r
								.match(Item, { doc, at: r.param("at", pg.integer), n })
								.find({ doc, at: r.param("to", pg.integer), n: Fn.call(ownFn, { x: n }) })
						})
					)
				: query(top).rule((r) => {
						const { doc, at, n } = v(Item, "item")
						return r.match(Item, { doc, at, n }).find({ doc, at, v: Fn.call(ownFn, { x: n }) })
					})
		case "derived":
			return writes
				? ChangeSet.empty(top).insert(
						Item,
						query(top).rule((r) => {
							const doc = r.param("doc", pg.integer)
							const { v: value } = v(Derived, "derived")
							return r
								.match(Derived, { doc, at: r.param("at", pg.integer), v: value })
								.find({ doc, at: r.param("to", pg.integer), n: value })
						})
					)
				: query(top).rule((r) => {
						const { doc, at, v: value } = v(Derived, "derived")
						return r.match(Derived, { doc, at, v: value }).find({ doc, at, v: value })
					})
		case "nested":
			return writes
				? ChangeSet.empty(top).insert(
						Item,
						query(top).rule((r) => {
							const doc = r.param("doc", pg.integer)
							const { v: value } = v(Nested, "nested")
							return r
								.match(Nested, { doc, at: r.param("at", pg.integer), v: value })
								.find({ doc, at: r.param("to", pg.integer), n: value })
						})
					)
				: query(top).rule((r) => {
						const { doc, at, v: value } = v(Nested, "nested")
						return r.match(Nested, { doc, at, v: value }).find({ doc, at, v: value })
					})
		case "plain":
			return writes
				? ChangeSet.empty(top).insert(
						Item,
						query(top).rule((r) => {
							const doc = r.param("doc", pg.integer)
							const { n } = v(Item, "item")
							return r
								.match(Item, { doc, at: r.param("at", pg.integer), n })
								.find({ doc, at: r.param("to", pg.integer), n })
						})
					)
				: query(top).rule((r) => {
						const { doc, at, n } = v(Item, "item")
						return r.match(Item, { doc, at, n }).find({ doc, at, v: n })
					})
	}
}

/** A role of the case's role `rc` over `levels`, with its programs by name, each named by its role and its reading,
 * so no two of a login's share one. */
const roleOf = (
	levels: Levels,
	rc: RoleCase
): { readonly role: AnyRole; readonly programs: Readonly<Record<string, unknown>> } => {
	const { top } = levels
	const writes = { insert: rc.writes ? (["Item"] as const) : ([] as const) }
	const named = (reading: Reading) => `${rc.name}_${reading}`
	const programsOver = (entry: unknown) =>
		Rec.fromEntries(
			Arr.map(rc.readings, (reading) => [
				named(reading),
				reading === "entry" ? entry : programOf(levels, reading, rc.writes)
			])
		)
	if (!rc.entry) {
		return { role: role(top, rc.name, { Item }, writes), programs: programsOver(undefined) }
	}
	const holder = role(top, rc.name, { Item, Entry: levels.entry }, writes)
	const { Entry } = holder.relations
	const held = holder.relations.Item
	return {
		role: holder,
		programs: programsOver(
			rc.writes
				? ChangeSet.empty(holder).insert(
						held,
						query(holder).rule((r) => {
							const doc = r.param("doc", pg.integer)
							const { v: value } = v(Entry, "entry")
							return r
								.match(Entry, { doc, at: r.param("at", pg.integer), v: value })
								.find({ doc, at: r.param("to", pg.integer), n: value })
						})
					)
				: query(holder).rule((r) => {
						const { doc, at, v: value } = v(Entry, "entry")
						return r.match(Entry, { doc, at, v: value }).find({ doc, at, v: value })
					})
		)
	}
}

/**
 * The world of a case under the declared name `name`: its schema's top level and the login `server` of its roles, each
 * running its own programs; and, by a role's name, the role, the role reached through the login and its programs.
 */
export const worldOf = (c: ReachedCase, name: string) => {
	const levels = levelsOf(c.volatility, name)
	const [first, ...rest] = Arr.map(c.roles, (rc) => ({ rc, ...roleOf(levels, rc) }))
	const built = new Map(Arr.map([first, ...rest], (r) => [r.rc.name, r] as const))
	const server = login(
		levels.top,
		"server",
		[first.role, ...Arr.map(rest, (r) => r.role)],
		[{ workload: Arr.map([first, ...rest], (r) => workload(r.role, r.programs)) }]
	)
	const of = (role: RoleName) => defined(built.get(role), `the case's role ${role}`)
	return {
		top: levels.top,
		login: server,
		role: (role: RoleName): AnyRole => of(role).role,
		loginRole: (role: RoleName): AnyLoginRole =>
			defined(server.roles[role], `the role ${role} of the login`),
		programs: (role: RoleName): Readonly<Record<string, unknown>> => of(role).programs
	}
}

/** The installation's build of a case: its world's top level and its login, under the installation's name. */
export const buildOf = (c: ReachedCase) => (name: string) => {
	const world = worldOf(c, name)
	return { schema: world.top, logins: [world.login] }
}

/** The documents and places a case's Item may hold, and the place a writer reads (`at`) and writes (`to`). */
const docs = [1, 2] as const
const places = [1, 2] as const
export const writeParams = { doc: 1, at: 1, to: 9 } as const

/** One role named `name`: a set of readings, whether it writes, and whether it holds Entry, which it does where it
 * reads it. */
const roleGen =
	(name: RoleName): Gen<RoleCase> =>
	(source) => {
		const read = source.draw(subset(readings, { min: 0, max: readings.length }))
		return {
			name,
			readings: read,
			writes: source.draw(boolean),
			entry: Arr.contains(read, "entry") || source.draw(boolean)
		}
	}

const volatilityGen: Gen<ReachedCase["volatility"]> = (source) => ({
	own: source.draw(element(volatilities)),
	derived: source.draw(element(volatilities)),
	nested: source.draw(element(volatilities)),
	entry: source.draw(element(volatilities)),
	idle: source.draw(element(volatilities))
})

const itemsGen: Gen<ReadonlyArray<ItemFact>> = (source) =>
	Arr.flatMap(docs, (doc) =>
		Arr.flatMap(places, (at) =>
			source.draw(boolean) ? [{ doc, at, n: source.draw(int(0, 3)) }] : []
		)
	)

export const caseGen: Gen<ReachedCase> = (source) => {
	const count = source.draw(int(1, roleNames.length))
	const [first, ...rest] = roleNames
	return {
		volatility: source.draw(volatilityGen),
		roles: [
			source.draw(roleGen(first)),
			...Arr.map(rest.slice(0, count - 1), (name) => source.draw(roleGen(name)))
		],
		items: source.draw(itemsGen)
	}
}

export type ReachedFeature =
	| "a call in a program's own Description, granted"
	| "a call in a live derived relation's definition, granted"
	| "a call in a stored derived relation's definition, granted"
	| "a call two derived relations down, granted"
	| "a call in a query entry's definition, granted"
	| "a call only another role's programs reach, withheld"
	| "a role reading only a live derived relation over its call, run as the role"
	| "a writer of a holder reading a stored relation through its definition, run as the role"

/** `rc` reading `reading` too. */
const reading = (rc: RoleCase, read: Reading): RoleCase => ({
	...rc,
	readings: Arr.contains(rc.readings, read) ? rc.readings : [...rc.readings, read],
	entry: rc.entry || read === "entry"
})

/** A drawn case whose first role is `f` of its own, and whose functions are `volatility` of their own. */
const aimedAt =
	(
		f: (rc: RoleCase) => RoleCase,
		volatility: Partial<ReachedCase["volatility"]>
	): Gen<ReachedCase> =>
	(source) => {
		const c = source.draw(caseGen)
		const [first, ...rest] = c.roles
		return { ...c, volatility: { ...c.volatility, ...volatility }, roles: [f(first), ...rest] }
	}

/**
 * The case each situation is aimed by: a drawn case whose first role reads what the situation reads, under the
 * volatility that stores or keeps live what it reads; for a call only another role reaches, a drawn case of two roles
 * or more whose first reads Item with ownFn and whose second does not.
 */
export const aims: ReadonlyArray<readonly [ReachedFeature, Gen<ReachedCase>]> = [
	["a call in a program's own Description, granted", aimedAt((rc) => reading(rc, "own"), {})],
	[
		"a call in a live derived relation's definition, granted",
		aimedAt((rc) => reading(rc, "derived"), { derived: "stable" })
	],
	[
		"a call in a stored derived relation's definition, granted",
		aimedAt((rc) => reading(rc, "derived"), { derived: "immutable" })
	],
	["a call two derived relations down, granted", aimedAt((rc) => reading(rc, "nested"), {})],
	["a call in a query entry's definition, granted", aimedAt((rc) => reading(rc, "entry"), {})],
	[
		"a call only another role's programs reach, withheld",
		(source) => {
			const c = source.draw(caseGen)
			const [first, ...rest] = c.roles
			const [second = source.draw(roleGen("second")), ...others] = rest
			const withoutOwn: RoleCase = {
				...second,
				readings: Arr.filter(second.readings, (r) => r !== "own")
			}
			return { ...c, roles: [reading(first, "own"), withoutOwn, ...others] }
		}
	],
	[
		"a role reading only a live derived relation over its call, run as the role",
		aimedAt((rc) => ({ ...rc, readings: ["derived"], writes: false }), { derived: "stable" })
	],
	[
		"a writer of a holder reading a stored relation through its definition, run as the role",
		aimedAt((rc) => ({ ...reading(rc, "derived"), writes: true }), { derived: "immutable" })
	]
]

/** A case's facts, as the installation loads them. */
export const factsOf = (c: ReachedCase) => ({
	Item: Arr.map(c.items, (i) => ({ doc: i.doc, at: i.at, n: i.n }))
})
