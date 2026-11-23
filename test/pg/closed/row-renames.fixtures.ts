/** What row-renames.test.ts reads: its space of roster histories, each version's schema, the model of each function's
 * fate, and the catalog reads. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { type Swarm, swarm, weightOf } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Declarations, Rename } from "#compiler/deploy/diff/plan.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { login } from "#compiler/program/workload/login.ts"
import { Logic } from "#compiler/public/compute.ts"
import { bits, closedId, generated, pg } from "#compiler/public/fields.ts"
import { type AnyRole, check, closed, relation, schema } from "#compiler/public/schema.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { joined } from "#test/support/chunked.ts"
import { setText, setWidth } from "#test/support/closed/bit-text.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import type { Version } from "#test/support/installed.ts"
import { parsedName, roleNamesOf } from "#test/support/kernel/naming.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** The first version's roster: its name and its handles in code order. */
const firstRoster = "Kind"

const handles = ["a", "b", "c"] as const

/** The names a second version may give the roster: the first's own, the kept case's rename, and a fresh name. */
const rosterNames = [firstRoster, "Sort", "Other"] as const

type RosterName = (typeof rosterNames)[number]

/** The name a renamed handle may take beside the first's own, and the handle a second version may add after them. */
const freshHandle = "d"

const addedHandle = "e"

/** A value a closed relation holds at a code: Weight's weight, Bonus's bonus, and the least weight the CHECK admits. */
const valueGen = int(0, 3)

/** The codes the first version's stored rows hold, each row's id its position from 1. */
const storedSize = { min: 0, max: 4 } as const

/**
 * One version of a history, as the model holds it: the roster's name, its handles in code order, and the rows of the
 * two closed relations keyed by it, each holding one row at every code, Weight's weight w and Bonus's bonus b, each in
 * code order. A version is the schema `versionOf` builds: the roster, Weight and Bonus, and Item, an id and a closed id
 * of the roster, with wt = Weight.at(w, kind) and bonus = Bonus.at(b, kind) generated and the CHECK heavy holding
 * Weight.at(w, kind) at least the history's bound; each read of a closed relation is installed as a row function.
 */
interface VersionModel {
	readonly roster: RosterName
	readonly handles: Arr.NonEmptyReadonlyArray<string>
	readonly weights: ReadonlyArray<number>
	readonly bonuses: ReadonlyArray<number>
}

/**
 * A history: its first version, the least weight its CHECK admits, the code of each row stored under the first (ids 1,
 * 2, …), each of a weight the CHECK admits, its second version, and the code a writer stores after the migration.
 */
export interface RowCase {
	readonly first: VersionModel
	readonly bound: number
	readonly stored: ReadonlyArray<number>
	readonly second: VersionModel
	readonly probe: number
}

/** What a second version changes, each turned on by the case's swarm. */
const changes = [
	"roster renamed",
	"handles renamed",
	"member added",
	"weights changed",
	"bonuses changed"
] as const

type Change = (typeof changes)[number]

/** Each first handle's name at the second version: an injection of the handles into themselves and a fresh name, drawn
 * uniformly, so swaps and chains occur. */
const renamedHandles: Gen<ReadonlyArray<string>> = (source) =>
	source.draw(shuffled([...handles, freshHandle], { min: handles.length, max: handles.length }))

/** A closed relation's values at the second version: the first's, or each drawn again where `on`. */
const valuesAt =
	(first: ReadonlyArray<number>, on: boolean): Gen<ReadonlyArray<number>> =>
	(source) =>
		on ? Arr.map(first, () => source.draw(valueGen)) : first

export const rowCaseGen: Gen<RowCase> = (source) => {
	const weights = source.draw(array(valueGen, { min: handles.length, max: handles.length }))
	const bonuses = source.draw(array(valueGen, { min: handles.length, max: handles.length }))
	const bound = source.draw(valueGen)
	const admitted = Arr.filter(
		Arr.map(handles, (_, code) => code),
		(code) => defined(weights[code], "a code's weight") >= bound
	)
	const stored = Arr.isReadonlyArrayNonEmpty(admitted)
		? source.draw(array(element(admitted), storedSize))
		: []
	const on: Swarm<Change> = source.draw(swarm(changes))
	const turned = (change: Change): boolean => weightOf(on, change) > 0
	const roster = turned("roster renamed")
		? source.draw(element(["Sort", "Other"] as const))
		: firstRoster
	const names = turned("handles renamed") ? source.draw(renamedHandles) : handles
	const added = turned("member added")
		? Option.some({ weight: source.draw(valueGen), bonus: source.draw(valueGen) })
		: Option.none()
	const second: VersionModel = {
		roster,
		handles: [
			defined(names[0], "a first handle's name"),
			...Arr.drop(names, 1),
			...Option.match(added, { onNone: () => [], onSome: () => [addedHandle] })
		],
		weights: [
			...source.draw(valuesAt(weights, turned("weights changed"))),
			...Option.match(added, { onNone: () => [], onSome: (a) => [a.weight] })
		],
		bonuses: [
			...source.draw(valuesAt(bonuses, turned("bonuses changed"))),
			...Option.match(added, { onNone: () => [], onSome: (a) => [a.bonus] })
		]
	}
	return {
		first: { roster: firstRoster, handles, weights, bonuses },
		bound,
		stored,
		second,
		probe: source.draw(int(0, second.handles.length - 1))
	}
}

/**
 * A version under the declared name `name`: the roster, Weight and Bonus over it, and Item, an id, a closed id of the
 * roster and a set over it, flags, typed by the roster's bits domain, which the role `writer` writes and `reader` reads,
 * both of the login `desk`.
 */
export const versionOf = (name: string, v: VersionModel, bound: number) => {
	const Roster = closedBuilder(v.roster, v.handles, "ordered", [])
	const Weight = closed.relation(
		"Weight",
		{ kind: closedId(Roster), w: pg.integer },
		["kind"],
		Arr.map(v.handles, (kind, code) => ({ kind, w: defined(v.weights[code], "a code's weight") }))
	)
	const Bonus = closed.relation(
		"Bonus",
		{ kind: closedId(Roster), b: pg.integer },
		["kind"],
		Arr.map(v.handles, (kind, code) => ({ kind, b: defined(v.bonuses[code], "a code's bonus") }))
	)
	const Item = relation.generated(
		"Item",
		{ id: pg.integer, kind: closedId(Roster), flags: bits(Roster) },
		["id"],
		(r) => ({
			wt: generated(pg.integer, Weight.at("w", r.kind)),
			bonus: generated(pg.integer, Bonus.at("b", r.kind))
		})
	)
	const base = schema(
		name,
		[Roster, Weight, Bonus, Item],
		[check("heavy", Item, (r) => Logic.ge(Weight.at("w", r.kind), bound))]
	)
	const writer = role(base, "writer", { Item }, { write: ["Item"] })
	const reader = role(base, "reader", { Item }, { write: [] })
	const version: Version = { schema: base, logins: [login(base, "desk", [writer, reader])] }
	return { version, writer, reader }
}

/** What the second version declares: the roster's rename, and each handle's whose name moves, by the roster's names
 * before and after (`--rename`). */
export const declarationsOf = (c: RowCase): Declarations => ({
	renames: [
		...(c.second.roster === c.first.roster
			? []
			: [
					{
						from: { kind: "relation" as const, relation: parsedName(c.first.roster) },
						to: { kind: "relation" as const, relation: parsedName(c.second.roster) }
					}
				]),
		...Arr.flatMap(c.first.handles, (handle, code): ReadonlyArray<Rename> => {
			const to = defined(c.second.handles[code], "a first code's handle at the second version")
			return to === handle
				? []
				: [
						{
							from: { kind: "handle", roster: parsedName(c.first.roster), handle },
							to: { kind: "handle", roster: parsedName(c.second.roster), handle: to }
						}
					]
		})
	],
	drops: []
})

/**
 * Each object of a version that calls a function grizzle names by its content, and what that function computes from:
 * Item's generated wt and its CHECK heavy, Weight's rows; Item's generated bonus, Bonus's rows; the roster domain's
 * CHECK and the bits domain's CHECK, which flags is typed by, the roster's live codes (its live-codes constant); and
 * the reader's view of Item, whose decoded kind reads the roster's names (its names constant).
 */
const callers = ["wt", "heavy", "bonus", "domain", "sets", "view"] as const

export type Caller = (typeof callers)[number]

const contentOf = {
	wt: "weights",
	heavy: "weights",
	bonus: "bonuses",
	domain: "live",
	sets: "live",
	view: "names"
} as const satisfies Readonly<Record<Caller, string>>

/** A version's content a function computes from: a closed relation's values at each code, the roster's live codes, all
 * of its codes, and its names in code order. */
const contentAt = (v: VersionModel, caller: Caller): ReadonlyArray<number | string> => {
	switch (contentOf[caller]) {
		case "weights":
			return v.weights
		case "bonuses":
			return v.bonuses
		case "live":
			return Arr.map(v.handles, (_, code) => code)
		case "names":
			return v.handles
	}
}

/**
 * Whether a caller's function is the same function after the migration, by the model: what it computes from is the
 * same at both versions. A rename moves no code and no value, so a declared rename of the roster or of its handles keeps
 * every function but the names constant, whose content is the names; an added member changes every one; a changed
 * closed relation, the functions reading it.
 */
export const keptBy = (c: RowCase, caller: Caller): boolean =>
	sameValues(contentAt(c.first, caller), contentAt(c.second, caller))

/**
 * Whether the roster's bits domain is the same domain after the migration, by the model: its width, the roster's codes
 * in whole bytes, is the same at both versions. A rename of the roster renames the domain with it, so flags keeps its
 * type and no column is converted.
 */
export const bitsKeptBy = (c: RowCase): boolean =>
	setWidth(c.first.handles.length) === setWidth(c.second.handles.length)

/** Whether two lists hold the same values in the same order. */
const sameValues = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>): boolean =>
	left.length === right.length && Arr.every(left, (value, i) => value === right[i])

/** Whether the migration is refused, by the model: a stored row's code weighs less, at the second version, than the
 * CHECK admits. */
export const refusedBy = (c: RowCase): boolean =>
	Arr.some(c.stored, (code) => defined(c.second.weights[code], "a stored code's weight") < c.bound)

/** Each row a version's Item holds by the model, in id order: the stored rows, then the writer's probe where its weight
 * is admitted, each with the second version's weight and bonus at its code. */
export const modelRows = (c: RowCase, probed: boolean): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map([...c.stored, ...(probed ? [c.probe] : [])], (code, i) => [
		String(i + 1),
		String(defined(c.second.weights[code], "a code's weight")),
		String(defined(c.second.bonuses[code], "a code's bonus"))
	])

/** Whether the writer's probe is admitted by the second version's CHECK. */
export const probeAdmitted = (c: RowCase): boolean =>
	defined(c.second.weights[c.probe], "the probe's weight") >= c.bound

export type RowFeature =
	| Change
	| "handles swapped"
	| "a row function renamed in place"
	| "a constant renamed in place"
	| "a row function made anew"
	| "a constant made anew"
	| "refused by the new CHECK"
	| "the writer refused by the CHECK"
	| "stored rows"

/** The features a case reaches by its history alone. */
export const notesOf = (c: RowCase): ReadonlyArray<RowFeature> => {
	const renamed = c.second.roster !== c.first.roster
	const moved = Arr.filter(c.first.handles, (h, code) => c.second.handles[code] !== h)
	const rowFunctions = Arr.filter(
		callers,
		(k) => contentOf[k] === "weights" || contentOf[k] === "bonuses"
	)
	const constants = Arr.filter(callers, (k) => contentOf[k] === "live" || contentOf[k] === "names")
	return [
		...(renamed ? (["roster renamed"] as const) : []),
		...(Arr.isReadonlyArrayNonEmpty(moved) ? (["handles renamed"] as const) : []),
		...(Arr.some(moved, (h) => Arr.contains(c.second.handles, h))
			? (["handles swapped"] as const)
			: []),
		...(c.second.handles.length > c.first.handles.length ? (["member added"] as const) : []),
		...(sameValues(c.first.weights, Arr.take(c.second.weights, c.first.weights.length))
			? []
			: (["weights changed"] as const)),
		...(sameValues(c.first.bonuses, Arr.take(c.second.bonuses, c.first.bonuses.length))
			? []
			: (["bonuses changed"] as const)),
		...(renamed && Arr.some(rowFunctions, (k) => keptBy(c, k))
			? (["a row function renamed in place"] as const)
			: []),
		...(renamed && Arr.some(constants, (k) => keptBy(c, k))
			? (["a constant renamed in place"] as const)
			: []),
		...(Arr.some(rowFunctions, (k) => !keptBy(c, k))
			? (["a row function made anew"] as const)
			: []),
		...(Arr.some(constants, (k) => !keptBy(c, k)) ? (["a constant made anew"] as const) : []),
		...(refusedBy(c) ? (["refused by the new CHECK"] as const) : []),
		...(Arr.isReadonlyArrayNonEmpty(c.stored) ? (["stored rows"] as const) : [])
	]
}

/** The one function a caller calls, as PostgreSQL's dependencies hold it: its OID, and whether the writer and the
 * reader may EXECUTE it. */
interface Called {
	readonly oid: string
	readonly executes: readonly [boolean, boolean]
}

/**
 * What a version's installation holds of its callers: each caller's one function, and the OIDs of the constraints and
 * the table a function's fate decides, the CHECK heavy, the roster domain's CHECK, the bits domain's CHECK and Item's
 * relfilenode, with each stored row's xmin in id order; the bits domain's own OID, and flags' attribute number and type.
 */
interface Held {
	readonly called: Readonly<Record<Caller, Called>>
	readonly heavy: string
	readonly domain: string
	readonly sets: string
	readonly relfilenode: string
	readonly xmins: ReadonlyArray<string>
	readonly bits: string
	readonly flags: { readonly attnum: string; readonly type: string }
}

/** The names of an installation's objects a caller is read by, as the naming door and the role's names give them:
 * Item's table, heavy's constraint name, the roster domain, its bits domain and the reader's view of Item, each as SQL
 * names it. */
interface CallerAt {
	readonly table: string
	readonly heavy: string
	readonly domain: string
	readonly bits: string
	readonly view: string
	readonly column: (field: "wt" | "bonus" | "flags") => string
}

const callersAt = (
	m: Installed,
	names: PhysicalNames,
	roster: RosterName,
	reader: AnyRole
): CallerAt => {
	const table = names.relation("Item")
	return {
		table: printObjectName({ schema: table.schema, name: table.name }),
		heavy: identifierOf(identity.check("Item", parsedName("heavy"))),
		domain: printObjectName(names.rosterDomain(parsedName(roster))),
		bits: printObjectName(names.bitsDomain(parsedName(roster))),
		view: roleNamesOf(m, reader).view("Item"),
		column: (field) => names.column("Item", field)
	}
}

/** Where a caller stands in pg_depend: the catalog holding it, and the query of its OID over `params`. */
const objectOf = (
	at: CallerAt,
	caller: Caller
): { readonly catalog: string; readonly sql: string; readonly params: ReadonlyArray<string> } => {
	switch (caller) {
		case "wt":
		case "bonus":
			return {
				catalog: "pg_catalog.pg_attrdef",
				sql: "SELECT ad.oid::int8::text FROM pg_catalog.pg_attrdef AS ad JOIN pg_catalog.pg_attribute AS a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum WHERE ad.adrelid = $1::text::regclass AND a.attname = $2::text",
				params: [at.table, at.column(caller)]
			}
		case "heavy":
			return {
				catalog: "pg_catalog.pg_constraint",
				sql: "SELECT c.oid::int8::text FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = $1::text::regclass AND c.conname = $2::text",
				params: [at.table, at.heavy]
			}
		case "domain":
		case "sets":
			return {
				catalog: "pg_catalog.pg_constraint",
				sql: "SELECT c.oid::int8::text FROM pg_catalog.pg_constraint AS c WHERE c.contypid = $1::text::regtype AND c.contype = 'c'",
				params: [caller === "domain" ? at.domain : at.bits]
			}
		case "view":
			return {
				catalog: "pg_catalog.pg_rewrite",
				sql: "SELECT r.oid::int8::text FROM pg_catalog.pg_rewrite AS r WHERE r.ev_class = $1::text::regclass",
				params: [at.view]
			}
	}
}

/** The one value of a query's one row, as text. */
const oneText = (rows: ReadonlyArray<ReadonlyArray<unknown>>, what: string): string => {
	assert.equal(rows.length, 1, `one row of ${what}`)
	return String(defined(rows[0], what)[0])
}

/**
 * What `m` holds of its callers (Held) at the version whose installation names its objects `names`, read as its owner on
 * `owner`, the roster named `roster`, the roles `writer` and `reader` asked for EXECUTE: a caller depending on other than
 * one function, the view on other than one function returning name[] among those it calls, fails the case.
 */
export const heldOf = (
	m: Installed,
	names: PhysicalNames,
	owner: RawSession,
	roster: RosterName,
	roles: { readonly writer: AnyRole; readonly reader: AnyRole }
) =>
	Effect.gen(function* () {
		const at = callersAt(m, names, roster, roles.reader)
		const objects = yield* Effect.forEach(callers, (caller) =>
			Effect.gen(function* () {
				const object = objectOf(at, caller)
				const objectRows = yield* owner.values(object.sql, object.params)
				const oid = oneText(objectRows, `the ${caller}`)
				const rows = yield* owner.values(
					`SELECT DISTINCT p.oid::int8::text, pg_catalog.has_function_privilege($1::text::name, p.oid, 'EXECUTE'), pg_catalog.has_function_privilege($2::text::name, p.oid, 'EXECUTE') FROM pg_catalog.pg_depend AS d JOIN pg_catalog.pg_proc AS p ON p.oid = d.refobjid WHERE d.classid = $3::text::regclass AND d.objid = $4::text::oid AND d.refclassid = 'pg_catalog.pg_proc'::regclass AND ($5::text <> 'view' OR p.prorettype = 'pg_catalog.name[]'::regtype)`,
					[m.role(roles.writer), m.role(roles.reader), object.catalog, oid, caller]
				)
				assert.equal(rows.length, 1, `the ${caller} calls one function named by its content`)
				const one = defined(rows[0], `the ${caller}'s function`)
				const called: Called = { oid: String(one[0]), executes: [one[1] === true, one[2] === true] }
				return { caller, oid, called }
			})
		)
		const of = (caller: Caller) =>
			defined(
				Option.getOrUndefined(Arr.findFirst(objects, (o) => o.caller === caller)),
				`the ${caller}`
			)
		const files = yield* owner.values(
			"SELECT relfilenode::int8::text FROM pg_catalog.pg_class WHERE oid = $1::text::regclass",
			[at.table]
		)
		const relfilenode = oneText(files, "Item's relfilenode")
		const xmins = yield* owner.values(
			`SELECT xmin::text FROM ${at.table} ORDER BY ${quoteIdent(names.column("Item", "id"))}`,
			[]
		)
		const bits = yield* owner.values("SELECT $1::text::regtype::oid::int8::text", [at.bits])
		const flags = yield* owner.values(
			"SELECT a.attnum::text, a.atttypid::int8::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = $1::text::regclass AND a.attname = $2::text",
			[at.table, at.column("flags")]
		)
		const flag = defined(flags[0], "flags' attribute")
		const held: Held = {
			called: {
				wt: of("wt").called,
				heavy: of("heavy").called,
				bonus: of("bonus").called,
				domain: of("domain").called,
				sets: of("sets").called,
				view: of("view").called
			},
			heavy: of("heavy").oid,
			domain: of("domain").oid,
			sets: of("sets").oid,
			relfilenode,
			xmins: Arr.map(xmins, (row) => String(row[0])),
			bits: oneText(bits, "the bits domain's OID"),
			flags: { attnum: String(flag[0]), type: String(flag[1]) }
		}
		return held
	})

/** Each row Item holds, its id, weight and bonus as text, in id order: as the owner reads the table, or as the reader
 * reads its view. */
export const rowsOf = (m: Installed, session: RawSession, through: Option.Option<AnyRole>) =>
	Effect.map(
		Option.match(through, {
			onNone: () => {
				const table = m.names.relation("Item")
				const column = (field: string) => quoteIdent(m.names.column("Item", field))
				return session.values(
					`SELECT ${column("id")}::text, ${column("wt")}::text, ${column("bonus")}::text FROM ${printObjectName({ schema: table.schema, name: table.name })} ORDER BY ${column("id")}`,
					[]
				)
			},
			onSome: (reader) => {
				const names = roleNamesOf(m, reader)
				return session.values(
					`SELECT v.${names.column("Item", "id")}::text, v.${names.column("Item", "wt")}::text, v.${names.column("Item", "bonus")}::text FROM ${names.view("Item")} AS v ORDER BY v.${names.column("Item", "id")}`,
					[]
				)
			}
		}),
		(rows): ReadonlyArray<ReadonlyArray<string>> => Arr.map(rows, (row) => Arr.map(row, String))
	)

/**
 * The INSERT a writer stores Item's row of `id` at `code` by, under a roster of `size` codes: its flags the set of its
 * own code, as its bits domain's text (bit-text.ts setText).
 */
export const insertItem = (m: Installed, id: number, code: number, size: number): string => {
	const table = m.names.relation("Item")
	const column = (field: string) => quoteIdent(m.names.column("Item", field))
	return `INSERT INTO ${printObjectName({ schema: table.schema, name: table.name })} (${column("id")}, ${column("kind")}, ${column("flags")}) VALUES (${id}::integer, ${code}::smallint, B'${setText(size, [code])}')`
}

/** Whether a drafted folder validates a constraint: a statement of its files holding VALIDATE CONSTRAINT. */
export const validates = (folder: FolderTexts): boolean =>
	Arr.some(folder.files, (file) => Str.includes("VALIDATE CONSTRAINT")(joined(file.text)))

/** Every caller, in its roster's order. */
export const everyCaller: Arr.NonEmptyReadonlyArray<Caller> = callers
