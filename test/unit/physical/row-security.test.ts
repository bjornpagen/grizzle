import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { type AnyLogin, login, relation, schema } from "#compiler/public/schema.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, role } from "#compiler/schema/world.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"

/**
 * Row security in the fresh installation, over every way two roles write two tables: a table some role writes through
 * a query entry with a filter has row security, enabled after every policy on it, and each of its writers holds one
 * policy there, TRUE for a writer that holds every row of it (a whole entry, or a query entry whose filter is none) and
 * the entry's membership for a narrowing one, inline or through its filter function; a table no writer narrows has
 * neither row security nor a policy, whoever writes it and however, since every policy there would be TRUE and the
 * grants already decide. The roles share one login or sit in two, so a table's writers are judged across logins.
 *
 * The oracle is the rule restated over the case: which writes narrow is read from the case, never from the
 * installation. What PostgreSQL makes of the installed policies is the database suite's to judge.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): row-security-any-whole-writer.patch (a table some writer holds whole
 * goes without row security, whoever else narrows it).
 *
 * Features: tables without row security, written whole or by a filterless entry; tables under it, a whole writer or a
 * filterless entry holding TRUE, a filter function, two writers narrowing, and a table narrowed from one login and
 * written from another.
 */
const Shelf = relation("Shelf", { id: pg.integer }, ["id"])
const Note = relation("Note", { id: uuid, shelf: pg.integer }, ["id"])
const Card = relation("Card", { id: uuid, shelf: pg.integer }, ["id"])
const Library = schema("Library", [Shelf, Note, Card], [])
const owned = owning(Library)

const tables = ["Note", "Card"] as const
type Table = (typeof tables)[number]

const roleNames = ["clerk", "keeper"] as const
type RoleName = (typeof roleNames)[number]

/**
 * How a role writes a table: not at all; whole; through a query entry whose filter is none, which carries every field
 * of the table; through one whose filter fixes a field to a literal, which the policy reads inline; or through one whose
 * filter joins Shelf, which the policy reads through the role's filter function.
 */
const writes = ["none", "whole", "every row", "fixed", "joined"] as const
type Write = (typeof writes)[number]

type QueryWrite = Exclude<Write, "none" | "whole">

/** Whether a write narrows its table: a query entry with a filter. */
const narrowing: { readonly [W in Write]: boolean } = {
	none: false,
	whole: false,
	"every row": false,
	fixed: true,
	joined: true
}

/** Each table's query entry for each query write, by its name in the role. */
const queryEntries: {
	readonly [T in Table]: { readonly [W in QueryWrite]: readonly [string, EntryValue] }
} = {
	Note: {
		"every row": [
			"AllNotes",
			query(Library).rule((r) => {
				const { id, shelf } = v(Note, "note")
				return r.match(Note, { id, shelf }).find({ id, shelf })
			})
		],
		fixed: [
			"FirstShelfNotes",
			query(Library).rule((r) => {
				const { id } = v(Note, "note")
				return r.match(Note, { id, shelf: 1 }).find({ id })
			})
		],
		joined: [
			"ShelvedNotes",
			query(Library).rule((r) => {
				const { id, shelf } = v(Note, "note")
				return r.match(Note, { id, shelf }).match(Shelf, { id: shelf }).find({ id, shelf })
			})
		]
	},
	Card: {
		"every row": [
			"AllCards",
			query(Library).rule((r) => {
				const { id, shelf } = v(Card, "card")
				return r.match(Card, { id, shelf }).find({ id, shelf })
			})
		],
		fixed: [
			"FirstShelfCards",
			query(Library).rule((r) => {
				const { id } = v(Card, "card")
				return r.match(Card, { id, shelf: 1 }).find({ id })
			})
		],
		joined: [
			"ShelvedCards",
			query(Library).rule((r) => {
				const { id, shelf } = v(Card, "card")
				return r.match(Card, { id, shelf }).match(Shelf, { id: shelf }).find({ id, shelf })
			})
		]
	}
}

/** A point of the box: how each role writes each table, and whether the roles sit in one login or two. */
interface Point {
	readonly writes: { readonly [R in RoleName]: { readonly [T in Table]: Write } }
	readonly logins: "one" | "two"
}

const writeGen: Gen<Write> = element(writes)

const pointGen: Gen<Point> = (source) => {
	const roleWrites = (): { readonly [T in Table]: Write } => ({
		Note: source.draw(writeGen),
		Card: source.draw(writeGen)
	})
	const clerk = roleWrites()
	const keeper = roleWrites()
	return { writes: { clerk, keeper }, logins: source.draw(boolean) ? "two" : "one" }
}

/**
 * A role's value: Shelf whole, read, and each table it writes by the entry its write names. Its entries are drawn, so it
 * is built by the role builder's admission core, as a JavaScript caller builds one: the public signature types a
 * literal entry record.
 */
const roleOf = (name: RoleName, w: { readonly [T in Table]: Write }) => {
	const entries: Record<string, EntryValue> = { Shelf: Library.relations.Shelf }
	const written: Array<string> = []
	for (const t of tables) {
		const write = w[t]
		if (write === "none") {
			continue
		}
		if (write === "whole") {
			entries[t] = Library.relations[t]
			written.push(t)
			continue
		}
		const [entry, value] = queryEntries[t][write]
		entries[entry] = value
		written.push(entry)
	}
	return role(Library, name, entries, { write: written, refresh: [] })
}

const loginsOf = (p: Point): ReadonlyArray<AnyLogin> => {
	const clerk = roleOf("clerk", p.writes.clerk)
	const keeper = roleOf("keeper", p.writes.keeper)
	return p.logins === "one"
		? [login(Library, "desk", [clerk, keeper])]
		: [login(Library, "desk", [clerk]), login(Library, "counter", [keeper])]
}

const installationOf = (p: Point): Installation => {
	const logins = Arr.map(loginsOf(p), (l) =>
		succeeded(ownLogin(defined(loginDescOf(l), "a login built by login(...)")))
	)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				installationsOf(owned),
				logins,
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
}

/** A policy as the rule judges it: its table, its role, and whether its predicate admits every row. */
interface PolicyView {
	readonly table: Table
	readonly role: RoleName
	readonly holds: "every row" | "narrowed"
}

/** TRUE, the predicate of a policy that narrows nothing. */
const admitsEveryRow = (filter: Expr): boolean =>
	filter.kind === "literal" && filter.value.kind === "bool" && filter.value.value

/** What the installation's statements do with row security: the tables it enables it on, each with whether every
 * policy on that table comes before it, and its policies. */
const observed = (
	i: Installation
): {
	readonly secured: ReadonlyArray<{ readonly table: Table; readonly afterPolicies: boolean }>
	readonly policies: ReadonlyArray<PolicyView>
} => {
	const tableOf = new Map<string, Table>(
		Arr.map(tables, (t) => [i.names.relation(t).name, t] as const)
	)
	const roleOf = new Map(
		Arr.flatMap(i.worlds, (l) =>
			Arr.flatMap(l.roles, (r) =>
				Arr.flatMap(roleNames, (n) => (n === r.name ? [[r.role, n] as const] : []))
			)
		)
	)
	const policies: Array<PolicyView & { readonly at: number }> = []
	const enabled: Array<{ readonly table: Table; readonly at: number }> = []
	for (const [at, s] of i.statements.entries()) {
		if (s.kind === "createPolicy") {
			policies.push({
				table: defined(tableOf.get(s.table.name), "a policy on a written table"),
				role: defined(roleOf.get(s.role), "a policy of a declared role"),
				holds: admitsEveryRow(s.filter) ? "every row" : "narrowed",
				at
			})
		} else if (
			s.kind === "alterTable" &&
			Arr.some(s.actions, (a) => a.kind === "enableRowSecurity")
		) {
			enabled.push({ table: defined(tableOf.get(s.table.name), "a written table"), at })
		}
	}
	return {
		secured: Arr.map(enabled, (e) => ({
			table: e.table,
			afterPolicies: Arr.every(policies, (p) => p.table !== e.table || p.at < e.at)
		})),
		policies: Arr.map(policies, ({ table, role, holds }) => ({ table, role, holds }))
	}
}

/** The rule: row security on exactly the tables some role narrows, and there one policy per writer. */
const expected = (
	p: Point
): {
	readonly secured: ReadonlyArray<Table>
	readonly policies: ReadonlyArray<PolicyView>
} => {
	const secured = Arr.filter(tables, (t) => Arr.some(roleNames, (r) => narrowing[p.writes[r][t]]))
	return {
		secured,
		policies: Arr.flatMap(secured, (table) =>
			Arr.flatMap(roleNames, (role): ReadonlyArray<PolicyView> => {
				const write = p.writes[role][table]
				return write === "none"
					? []
					: [{ table, role, holds: narrowing[write] ? "narrowed" : "every row" }]
			})
		)
	}
}

type RowSecurityFeature =
	| "a table written whole by every writer, without row security"
	| "a table a filterless query entry writes, without row security"
	| "a table under row security a whole writer holds TRUE on"
	| "a table under row security a filterless query entry holds TRUE on"
	| "a table under row security through a filter function"
	| "a table two writers narrow"
	| "a table narrowed from one login and written from another"

const features: Arr.NonEmptyReadonlyArray<RowSecurityFeature> = [
	"a table written whole by every writer, without row security",
	"a table a filterless query entry writes, without row security",
	"a table under row security a whole writer holds TRUE on",
	"a table under row security a filterless query entry holds TRUE on",
	"a table under row security through a filter function",
	"a table two writers narrow",
	"a table narrowed from one login and written from another"
]

const notesOf = (p: Point): ReadonlyArray<RowSecurityFeature> =>
	Arr.flatMap(tables, (t): ReadonlyArray<RowSecurityFeature> => {
		const ws = Arr.map(roleNames, (r) => p.writes[r][t])
		const narrowed = Arr.some(ws, (w) => narrowing[w])
		const writers = Arr.filter(ws, (w) => w !== "none")
		if (!narrowed) {
			return [
				...(writers.length > 0 && Arr.every(writers, (w) => w === "whole")
					? ["a table written whole by every writer, without row security" as const]
					: []),
				...(Arr.some(ws, (w) => w === "every row")
					? ["a table a filterless query entry writes, without row security" as const]
					: [])
			]
		}
		return [
			...(Arr.some(ws, (w) => w === "whole")
				? ["a table under row security a whole writer holds TRUE on" as const]
				: []),
			...(Arr.some(ws, (w) => w === "every row")
				? ["a table under row security a filterless query entry holds TRUE on" as const]
				: []),
			...(Arr.some(ws, (w) => w === "joined")
				? ["a table under row security through a filter function" as const]
				: []),
			...(Arr.every(ws, (w) => narrowing[w]) ? ["a table two writers narrow" as const] : []),
			...(p.logins === "two" && writers.length === roleNames.length
				? ["a table narrowed from one login and written from another" as const]
				: [])
		]
	})

describe("row security", () => {
	it.effect(
		"is enabled on exactly the tables some writer narrows, after one policy per writer there",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "five writes for each of two roles on each of two tables, in one login or two",
						oracle: {
							kind: "specification",
							name: "row security on exactly the tables some writer narrows, one policy per writer there"
						},
						suite: "unit/physical/row-security",
						generator: pointGen,
						literal: Formatter.format,
						coverage: requiredInSpace<RowSecurityFeature>(features),
						caseHang,
						concurrency: 1
					},
					(p, c) =>
						Effect.sync(() => {
							for (const f of notesOf(p)) {
								c.note(f)
							}
							const seen = observed(installationOf(p))
							const want = expected(p)
							assert.deepEqual(
								Arr.sort(
									Arr.map(seen.secured, (s) => s.table),
									Order.String
								),
								Arr.sort(want.secured, Order.String),
								"the tables under row security"
							)
							for (const s of seen.secured) {
								assert.ok(s.afterPolicies, `row security on ${s.table} after its policies`)
							}
							unorderedEqual(seen.policies, want.policies, "the policies")
						})
				)
			)
	)
})
