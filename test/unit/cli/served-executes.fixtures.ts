/** What the properties of served-executes.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	login,
	mutable,
	relation,
	schema,
	unit,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { FunctionName, SqlStatement } from "#compiler/sql/ast.ts"
import { lex } from "#compiler/sql/lexer.ts"
import { defineConfig } from "#index.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { repoRoot } from "#test/support/files.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"

/**
 * What a role's change and read members are: a read-back of a ChangeSet that writes nothing, delivering an option; a
 * query over a roster's codes; an insert of R; and a put of R from a query over a relation parameter, which reads its
 * rows from a carrier. A reader serves the first two alone.
 */
const memberKinds = ["readBack", "query", "insert", "put"] as const

type MemberKind = (typeof memberKinds)[number]

const readerKinds = ["readBack", "query"] as const satisfies ReadonlyArray<MemberKind>

/** A role of the box: whether it writes R and Tag, and the members it serves. */
interface RoleCase {
	readonly writes: boolean
	readonly members: ReadonlyArray<MemberKind>
}

/** The roles of the login `app`: one or two. */
export interface Case {
	readonly roles: Arr.NonEmptyReadonlyArray<RoleCase>
}

const roleGen: Gen<RoleCase> = (source) => {
	const writes = source.draw(element([false, true] as const))
	const kind: Gen<MemberKind> = writes ? element(memberKinds) : element(readerKinds)
	return { writes, members: Arr.dedupe(source.draw(array(kind, { min: 0, max: 3 }))) }
}

export const caseGen: Gen<Case> = (source) => {
	const first = source.draw(roleGen)
	return { roles: [first, ...source.draw(array(roleGen, { min: 0, max: 1 }))] }
}

export type Feature =
	| "a role that writes nothing whose served file calls the refusal function"
	| "a writer whose served file calls the refusal function"
	| "a served file calling none of the installation's functions"
	| "two roles"

const Kind = closed.ordered("Kind", ["Low", "High"])
const R = relation("R", { k: pg.integer, v: pg.integer, kind: closedId(Kind) }, ["k"])
const Tag = relation("Tag", { r: pg.integer, label: pg.integer }, ["r"])

const Base = schema("served_executes", [Kind, R, Tag], [unit("Rs", { k: pg.integer }), mutable(R)])

/** A role of the box: every relation whole, R and Tag written where it writes. */
const roleOf = (name: string, writes: boolean) =>
	role(Base, name, wholeEntriesOf(Base), {
		insert: writes ? ["Tag"] : [],
		write: writes ? ["R"] : []
	})

type BoxRole = ReturnType<typeof roleOf>

/** Every R with its tag, an option, which Tag's key on r proves at most one of. */
const tagged = (r: BoxRole) =>
	query(r)
		.rule((q) => {
			const { k, v: value } = v(R, "r")
			return q.match(R, { k, v: value }).find({ k, v: value })
		})
		.attach(
			"tag",
			(row) =>
				query(r).rule((q) => {
					const { label } = v(Tag, "tag")
					return q.match(Tag, { r: row.k, label }).find({ label })
				}),
			"option"
		)

/** The member of kind `kind` for the role `r`. */
const memberOf = (r: BoxRole, kind: MemberKind) => {
	switch (kind) {
		case "readBack":
			return ChangeSet.empty(r).read("tagged", () => tagged(r))
		case "query":
			return query(r).rule((q) => {
				const { k } = v(R, "r")
				return q.match(R, { k, kind: "High" }).find({ k })
			})
		case "insert":
			return ChangeSet.empty(r).insert(R, [])
		case "put":
			return ChangeSet.empty(r).put(
				R,
				query(r).rule((q) => {
					const rows = q.relation("rows", { k: R.fields.k, v: R.fields.v, kind: R.fields.kind })
					const { k, v: value, kind } = v(R, "r")
					return q.match(rows, { k, v: value, kind }).find({ k, v: value, kind })
				})
			)
	}
}

/** The name of the role at `place` among the login's. */
const roleName = (place: number): string => `a${place}`

/** The login `app` over a role of each of `roles`, named `a<place>`, each serving its drawn members. */
const loginOf = (roles: Arr.NonEmptyReadonlyArray<RoleCase>) => {
	const built = Arr.map(roles, (c, i) => {
		const r = roleOf(roleName(i), c.writes)
		const programs = Rec.fromEntries(
			Arr.map(c.members, (kind) => [`${kind}_${roleName(i)}`, memberOf(r, kind)] as const)
		)
		return { r, workloads: c.members.length === 0 ? [] : [workload(r, programs)] }
	})
	return login(
		Base,
		"app",
		Arr.map(built, (b) => b.r),
		{ workload: Arr.flatMap(built, (b) => b.workloads) }
	)
}

/** Whether `value` is a map, whose values a served form's texts may lie in. */
const isMap = (value: unknown): value is ReadonlyMap<unknown, unknown> => value instanceof Map

/** Whether `value` is a record, whose values a served form's texts may lie in. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null

/** Every text `value` holds, at any depth of its lists, maps and records. */
const textsIn = (value: unknown): ReadonlyArray<string> => {
	if (typeof value === "string") {
		return [value]
	}
	if (isMap(value)) {
		return Arr.flatMap(Arr.fromIterable(value.values()), textsIn)
	}
	if (Arr.isArray(value)) {
		return Arr.flatMap(value, textsIn)
	}
	return isRecord(value) ? Arr.flatMap(Rec.values(value), textsIn) : []
}

/**
 * Each schema-qualified name a text calls, `<schema>.<name>`, read off the printed SQL's tokens (sql/lexer.ts): a
 * quoted schema, a dot, a quoted name and an opening parenthesis. A table with a column list reads alike, so a caller
 * keeps the names of functions alone.
 */
const qualifiedCalls = (text: string): ReadonlyArray<string> => {
	const tokens = lex(text).tokens
	return Arr.flatMap(tokens, (schemaToken, i) => {
		const [dot, name, open] = [tokens[i + 1], tokens[i + 2], tokens[i + 3]]
		return schemaToken.kind === "quotedIdent" &&
			dot?.kind === "punct" &&
			dot.text === "." &&
			name?.kind === "quotedIdent" &&
			open?.kind === "punct" &&
			open.text === "("
			? [`${schemaToken.text}.${name.text}`]
			: []
	})
}

/** Every function an installation's manifest creates, `<schema>.<name>`: its functions and its constants. */
const createdFunctions = (statements: ReadonlyArray<SqlStatement>): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(statements, (s) =>
			s.kind === "createFunction" || s.kind === "createConstant"
				? [`${s.name.schema}.${s.name.name}`]
				: s.kind === "packConstant"
					? [`${s.function.schema}.${s.function.name}`]
					: []
		)
	)

const file = `${repoRoot}app/grizzle.config.ts`

/** A served role's calls into the installation's own functions and the functions it is granted EXECUTE on. */
interface ServedRole {
	readonly name: string
	readonly writes: boolean
	readonly calls: ReadonlyArray<string>
	readonly granted: ReadonlySet<string>
	readonly refusal: string
}

/**
 * The draft of the case's login from nothing, as `grizzle generate` makes it, and of each role of its served file the
 * functions of the installation's own its texts call, beside those the installation grants the role EXECUTE on.
 */
export const servedRoles = (c: Case) =>
	Effect.gen(function* () {
		const config = yield* resolveConfig(
			defineConfig({
				schemas: [Base],
				logins: [loginOf(c.roles)],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => offlineOwner
			}),
			file
		)
		const configured = defined(config.schemas[0], "the configured schema")
		const compiled = yield* Effect.fromResult(compileSchema(configured))
		const draft = yield* draftSchema(
			compiled,
			emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
			[],
			noDeclarations,
			silentPhases
		)
		const served = draft.served
		assert.ok(served.kind === "logins", "a schema with a login plans its logins")
		const entries = yield* eachServedFile(compiled, draft, served, silentPhases, Effect.succeed)
		const installation = draft.installation
		const app = defined(
			Option.getOrUndefined(Arr.findFirst(installation.worlds, (l) => l.name === "app")),
			"the installed login app"
		)
		const installedRole = (name: string): string =>
			defined(
				Option.getOrUndefined(Arr.findFirst(app.roles, (r) => r.name === name)),
				`the installed role ${name}`
			).role
		const qualified = (fn: FunctionName): string => `${fn.schema}.${fn.name}`
		const grantedTo = (installed: string): ReadonlySet<string> =>
			new Set(
				Arr.flatMap(installation.manifest.objects, (o) =>
					Arr.flatMap(o.ddl, (s) =>
						s.kind === "grant" &&
						s.on.kind === "FUNCTION" &&
						Arr.contains(s.privileges, "EXECUTE") &&
						Arr.some(s.to, (g) => g.kind === "role" && g.name === installed)
							? Arr.map(s.on.names, qualified)
							: []
					)
				)
			)
		const refusal = `${installation.names.schema}.__refuse`
		const functions = createdFunctions(Arr.flatMap(installation.manifest.objects, (o) => o.ddl))
		const ownCalls = (text: string): ReadonlyArray<string> =>
			Arr.filter(qualifiedCalls(text), (name) => functions.has(name))
		const writers = new Map(Arr.map(c.roles, (r, i) => [roleName(i), r.writes] as const))
		return Arr.flatMap(entries, (entry): ReadonlyArray<ServedRole> => {
			const parsed = succeeded(servedFile(jsonOf(entry.text)), "the served file")
			return Arr.map(parsed.roles, (r) => ({
				name: r.name,
				writes: defined(writers.get(r.name), `the case's role ${r.name}`),
				calls: Arr.sort(Arr.dedupe(Arr.flatMap(textsIn(r.members), ownCalls)), Str.Order),
				granted: grantedTo(installedRole(r.name)),
				refusal
			}))
		})
	})
