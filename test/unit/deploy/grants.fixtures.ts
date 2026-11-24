/** What the properties of grants.test.ts read: its space of two versions of a schema's role worlds, and its judge, a
 * model of the privileges PostgreSQL holds. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, String as Str } from "effect"
import { alterationStatement, type Declarations } from "#compiler/deploy/diff/plan.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { draftCodebook, noPreviousRosters } from "#compiler/ir/codes.ts"
import { noSpellings } from "#compiler/ir/pattern.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v as v_ } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { installationsOf, type OwnedLogin, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { Grant, GrantObjects, Grantee, SqlStatement } from "#compiler/sql/ast.ts"
import { printType } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import type { DeploySubject } from "#test/support/migrate/kit.ts"
import { owning } from "#test/support/policy.ts"

/** The relations a version holds beside A and B: none, or C as well. */
type Third = "none" | "C"
/** What the reader's role reads: A alone, A and B, or every relation the version holds. */
type Reads = "A" | "AB" | "all"
/** What the writer's role writes: nothing, A, or every relation the version holds. */
type Writes = "none" | "A" | "all"

/** A version of the schema and its worlds: its relations, A's note an integer or a bigint, the desk login's two roles, and a second
 * login whose role reads B. */
export interface Version {
	readonly third: Third
	readonly wide: boolean
	readonly reads: Reads
	readonly writes: Writes
	readonly second: boolean
}

const versions: ReadonlyArray<Version> = Arr.flatMap(["none", "C"] as const, (third) =>
	Arr.flatMap([false, true], (wide) =>
		Arr.flatMap(["A", "AB", "all"] as const, (reads) =>
			Arr.flatMap(["none", "A", "all"] as const, (writes) =>
				Arr.map([false, true], (second): Version => ({ third, wide, reads, writes, second }))
			)
		)
	)
)

/** A migration: from one version to another that differs from it in one knob, each knob's every turn. */
export interface Turn {
	readonly before: Version
	readonly after: Version
}

/** How many knobs two versions differ in. */
const knobsApart = (a: Version, b: Version): number =>
	Arr.filter(
		[
			a.third !== b.third,
			a.wide !== b.wide,
			a.reads !== b.reads,
			a.writes !== b.writes,
			a.second !== b.second
		],
		(x) => x
	).length

/** Every turn of one knob between two versions. */
export const turns = finite<Turn>((source) => {
	const pairs = Arr.flatMap(versions, (before) =>
		Arr.flatMap(versions, (after) => (knobsApart(before, after) === 1 ? [{ before, after }] : []))
	)
	const [first, ...rest] = pairs
	if (first === undefined) {
		throw new Error("two versions differ in one knob")
	}
	return source.draw(element([first, ...rest]))
})

/** The knob a turn turns, for its situations. */
export type TurnFeature =
	| "a relation dropped"
	| "a relation added"
	| "a column widened"
	| "a column narrowed"
	| "a role reads more"
	| "a role reads less"
	| "a role's writes change"
	| "a login added"
	| "a login dropped"

export const featureOf = (t: Turn): TurnFeature => {
	const { before: a, after: b } = t
	if (a.third !== b.third) {
		return b.third === "none" ? "a relation dropped" : "a relation added"
	}
	if (a.wide !== b.wide) {
		return b.wide ? "a column widened" : "a column narrowed"
	}
	if (a.reads !== b.reads) {
		const rank = { A: 0, AB: 1, all: 2 } as const
		return rank[b.reads] > rank[a.reads] ? "a role reads more" : "a role reads less"
	}
	if (a.writes !== b.writes) {
		return "a role's writes change"
	}
	return b.second ? "a login added" : "a login dropped"
}

/** A version's schema and logins, as the public API builds them: A, B and C, each in a unit of its own id, under a
 * level that stores Listing, A's ids and notes, which the writer holds whole and so reads by SELECT. */
const built = (
	v: Version
): { readonly base: DeploySubject; readonly logins: ReadonlyArray<OwnedLogin> } => {
	const A = relation("A", { id: Id, note: v.wide ? pg.bigint : pg.integer }, ["id"])
	const B = relation("B", { id: Id }, ["id"])
	const C = relation("C", { id: Id }, ["id"])
	const owned = (l: Parameters<typeof loginDescOf>[0]): OwnedLogin =>
		succeeded(ownLogin(defined(loginDescOf(l), "a login built by login(...)")))
	if (v.third === "C") {
		const root = schema("Worlds", [A, B, C], [unit("Entity", { id: Id })])
		const Listing = derived.stored(
			"Listing",
			query(root).rule((r) => {
				const { id, note } = v_(A, "a")
				return r.match(A, { id, note }).find({ id, note })
			})
		)
		const base = schema.extend([root], "Worlds_1", [Listing], [])
		const listing = base.relations.Listing
		const reader =
			v.reads === "A"
				? role(base, "reader", { A })
				: v.reads === "AB"
					? role(base, "reader", { A, B })
					: role(base, "reader", { A, B, C })
		const writer =
			v.writes === "A"
				? role(base, "writer", { A, Listing: listing }, { insert: ["A"] })
				: v.writes === "all"
					? role(base, "writer", { A, B, C, Listing: listing }, { insert: ["A", "B", "C"] })
					: role(base, "writer", { A, B, Listing: listing })
		const desk = owned(login(base, "desk", [reader, writer]))
		return {
			base,
			logins: v.second
				? [desk, owned(login(base, "counter", [role(base, "clerk", { B })]))]
				: [desk]
		}
	}
	const root = schema("Worlds", [A, B], [unit("Entity", { id: Id })])
	const Listing = derived.stored(
		"Listing",
		query(root).rule((r) => {
			const { id, note } = v_(A, "a")
			return r.match(A, { id, note }).find({ id, note })
		})
	)
	const base = schema.extend([root], "Worlds_1", [Listing], [])
	const listing = base.relations.Listing
	const reader = v.reads === "A" ? role(base, "reader", { A }) : role(base, "reader", { A, B })
	const writer =
		v.writes === "A"
			? role(base, "writer", { A, Listing: listing }, { insert: ["A"] })
			: v.writes === "all"
				? role(base, "writer", { A, B, Listing: listing }, { insert: ["A", "B"] })
				: role(base, "writer", { A, B, Listing: listing })
	const desk = owned(login(base, "desk", [reader, writer]))
	return {
		base,
		logins: v.second ? [desk, owned(login(base, "counter", [role(base, "clerk", { B })]))] : [desk]
	}
}

/** A version's installation, as `grizzle generate` compiles it with its logins. */
const installationOf = (v: Version): Installation => {
	const { base, logins } = built(v)
	const owned = owning(base)
	const codes = draftCodebook(noPreviousRosters, new Map(), rostersOf(owned), noSpellings)
	assert.ok(codes.ok, "the version's rosters draw their codes")
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), logins, [], codes.value)
		)
	)
}

/** What a turn declares: C's drop and the counter login's, each the reviewer's to see go. */
const declaredOf = (t: Turn): Declarations => ({
	renames: [],
	drops: [
		...(t.before.third === "C" && t.after.third === "none"
			? [{ kind: "relation" as const, relation: parsedName("C") }]
			: []),
		...(t.before.second && !t.after.second
			? [{ kind: "login" as const, login: parsedName("counter") }]
			: [])
	]
})

/** The steps' statements, in order, each alteration as the ALTER TABLE it prints as. */
const statementsOf = (
	installation: Installation,
	previous: DeploySnapshot,
	declared: Declarations
) => {
	const drafted = draftMigration({
		previous,
		installation,
		workload: noWorkload,
		declared,
		abandoned: []
	})
	if (!drafted.ok) {
		return assert.fail(`the draft: ${drafted.error.message}`)
	}
	return {
		snapshot: drafted.value.snapshot,
		statements: Arr.flatMap(drafted.value.plan.steps, (s): ReadonlyArray<SqlStatement> =>
			s.draft.kind === "statement"
				? [s.draft.statement]
				: s.draft.kind === "alteration"
					? [alterationStatement(s.draft.table, s.draft.actions)]
					: s.draft.kind === "confirm"
						? s.draft.keep
						: []
		)
	}
}

/** One privilege of one grantee on one object, as PostgreSQL's ACL holds it: the model's unit. */
const unitKey = (object: string, privilege: string, grantee: Grantee): string =>
	`${object}\u0001${privilege}\u0001${grantee.kind === "role" ? grantee.name : "PUBLIC"}`

/** The objects a GRANT or REVOKE names, each by its kind and qualified name, a function's with its argument types. */
const objectsOf = (on: GrantObjects): ReadonlyArray<string> => {
	switch (on.kind) {
		case "TABLE":
		case "DOMAIN":
		case "TYPE":
			return Arr.map(on.names, (n) => `${on.kind} ${n.schema}.${n.name}`)
		case "FUNCTION":
			return Arr.map(
				on.names,
				(n) => `FUNCTION ${n.schema}.${n.name}(${Arr.join(Arr.map(n.args, printType), ", ")})`
			)
		case "SCHEMA":
			return Arr.map(on.names, (n) => `SCHEMA ${n}`)
		case "DATABASE":
			return ["DATABASE"]
	}
}

const unitsOf = (g: Pick<Grant, "privileges" | "on" | "to">): ReadonlyArray<string> =>
	Arr.flatMap(g.to, (grantee) =>
		Arr.flatMap(objectsOf(g.on), (object) =>
			Arr.map(g.privileges, (p) => unitKey(object, p, grantee))
		)
	)

/** The object a unit is on, and its grantee. */
const objectOf = (unit: string): string => defined(Str.split(unit, "\u0001")[0], "a unit's object")
const granteeOf = (unit: string): string =>
	defined(Str.split(unit, "\u0001")[2], "a unit's grantee")

/** What the model finds of a migration over the previous installation's privileges: the privileges every role holds
 * after it, and each statement it ran that changed nothing PostgreSQL holds, or that a later one undid. */
interface Run {
	readonly held: ReadonlySet<string>
	readonly idle: ReadonlyArray<string>
}

/**
 * The model of PostgreSQL's privileges (aclchk.c): a GRANT adds each unit it states, a REVOKE takes each away, a
 * column grant is a unit of its table and privilege per column that the table's REVOKE of the privilege takes too, and
 * a DROP of an object or a role takes every unit on it or of it; a DROP ROLE of a role that still holds a unit is
 * refused (2BP01). A PUBLIC unit is a revoke of the installation's default, which a migration runs only for an object it
 * creates (a new or recreated object starts from PostgreSQL's defaults, a function its CREATE FUNCTION creates among
 * them). Idle: a GRANT of a unit held, a REVOKE of one
 * not held, a REVOKE of a unit of a grantee that survives on an object the migration drops, and a GRANT of a unit the
 * migration revoked on an object it did not create again.
 */
const run = (start: ReadonlySet<string>, statements: ReadonlyArray<SqlStatement>): Run => {
	const held = new Set(start)
	const idle: Array<string> = []
	const created = new Set<string>()
	const revoked = new Map<string, string>()
	const droppedRoles = new Set<string>()
	const droppedObjects = new Set<string>()
	const drop = (object: string): void => {
		droppedObjects.add(object)
		for (const u of held) {
			if (objectOf(u) === object || Str.startsWith(`${object} column `)(objectOf(u))) {
				held.delete(u)
			}
		}
	}
	for (const s of statements) {
		if (s.kind === "grant") {
			for (const u of unitsOf(s)) {
				if (held.has(u)) {
					idle.push(`a GRANT of a held ${u}`)
				}
				if (revoked.has(u) && !created.has(objectOf(u))) {
					idle.push(`a GRANT of ${u}, which it revoked`)
				}
				held.add(u)
			}
		} else if (s.kind === "grantColumns") {
			for (const column of s.columns) {
				const u = unitKey(`TABLE ${s.table.schema}.${s.table.name} column ${column}`, s.privilege, {
					kind: "role",
					name: s.to
				})
				if (held.has(u)) {
					idle.push(`a GRANT of a held ${u}`)
				}
				held.add(u)
			}
		} else if (s.kind === "revoke") {
			const units = unitsOf({ privileges: s.privileges, on: s.on, to: s.from })
			for (const u of units) {
				const object = objectOf(u)
				if (granteeOf(u) === "PUBLIC") {
					if (!created.has(object)) {
						idle.push(`a PUBLIC REVOKE on ${object}, which the migration did not create`)
					}
					continue
				}
				const columns = Arr.filter(
					[...held],
					(x) =>
						Str.startsWith(`${object} column `)(objectOf(x)) &&
						Str.endsWith(Str.slice(object.length)(u))(x)
				)
				if (!held.has(u) && columns.length === 0) {
					idle.push(`a REVOKE of ${u}, held by no one`)
				}
				held.delete(u)
				for (const x of columns) {
					held.delete(x)
				}
				revoked.set(u, object)
			}
		} else if (s.kind === "drop" && s.object === "ROLE") {
			const still = Arr.filter([...held], (u) => granteeOf(u) === s.name)
			assert.deepEqual(still, [], `PostgreSQL drops the role ${s.name} only once it holds nothing`)
			droppedRoles.add(s.name)
		} else if (s.kind === "drop" && s.object !== "SCHEMA") {
			drop(`${s.object === "VIEW" ? "TABLE" : s.object} ${s.name.schema}.${s.name.name}`)
		} else if (s.kind === "drop") {
			drop(`SCHEMA ${s.name}`)
		} else if (s.kind === "createTable") {
			created.add(`TABLE ${s.table.schema}.${s.table.name}`)
		} else if (s.kind === "createView" || s.kind === "createStoredTable") {
			created.add(`TABLE ${s.name.schema}.${s.name.name}`)
		} else if (s.kind === "createDomain") {
			created.add(`DOMAIN ${s.name.schema}.${s.name.name}`)
		} else if (s.kind === "createRowType") {
			created.add(`TYPE ${s.name.schema}.${s.name.name}`)
		} else if (s.kind === "createSchema") {
			created.add(`SCHEMA ${s.name}`)
		} else if (s.kind === "createFunction") {
			created.add(
				`FUNCTION ${s.name.schema}.${s.name.name}(${Arr.join(
					Arr.map(s.params, (param) => printType(param.type)),
					", "
				)})`
			)
		}
	}
	for (const [u, object] of revoked) {
		if (droppedObjects.has(object) && !droppedRoles.has(granteeOf(u))) {
			idle.push(`a REVOKE of ${u} on an object the migration drops`)
		}
	}
	return { held: new Set(Arr.filter([...held], (u) => granteeOf(u) !== "PUBLIC")), idle }
}

/** The privileges an installation holds installed from nothing: its first draft's, run over none. */
const freshOf = (
	v: Version
): { readonly snapshot: DeploySnapshot; readonly held: ReadonlySet<string> } => {
	const first = statementsOf(
		installationOf(v),
		emptySnapshot({ schemaName: "Worlds", schema: "worlds" }),
		{
			renames: [],
			drops: []
		}
	)
	return { snapshot: first.snapshot, held: run(new Set(), first.statements).held }
}

/**
 * A turn's judge, the model of PostgreSQL's privileges: drafted from the first version's snapshot, the migration ends at
 * exactly the privileges the second version holds installed from nothing, and runs no idle statement: it grants no
 * privilege a role holds, revokes none it does not, revokes none on an object it drops from a role it keeps, and grants
 * back none it revoked; so a privilege both versions hold on an object the migration keeps is never touched.
 */
export const judge = (t: Turn): void => {
	const before = freshOf(t.before)
	const after = freshOf(t.after)
	const migration = statementsOf(installationOf(t.after), before.snapshot, declaredOf(t))
	const result = run(before.held, migration.statements)
	assert.deepEqual(
		Arr.sort([...result.held], Order.String),
		Arr.sort([...after.held], Order.String),
		"the migration ends at the privileges the second version holds installed from nothing"
	)
	assert.deepEqual(result.idle, [], "the migration runs no GRANT or REVOKE that changes nothing")
}
