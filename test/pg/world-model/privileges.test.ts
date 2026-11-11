import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { type Reached, required } from "@grizzle/testing/features"
import { constant, element, type Gen, int, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record, Result } from "effect"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { educationInstall } from "#test/support/fixtures/education/index.ts"
import { caseHang } from "#test/support/limits.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	breakingAtCommit,
	type Checked,
	directTransaction,
	docsTenantRealities,
	drawnRealities,
	everyWriter,
	fresh,
	generatedDocsInstalls,
	leadsOf,
	noLead,
	opIn,
	programTests,
	requiredWhere,
	startingWith
} from "#test/support/worlds/drive/suite.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import {
	docsEditorInstall,
	docsInstall,
	docsOneShareEditorInstall,
	docsOneShareInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { installedView } from "#test/support/worlds/model/session/direct.ts"
import type { InstallSpec, WorldFeature } from "#test/support/worlds/model/types.ts"
import {
	expectedPrivileges,
	factText,
	type PrivilegeHolder,
	type InstalledObject,
	installedObjects,
	installedPrivileges,
	type MembershipOption,
	type PrivilegedObjectKind,
	type PrivilegeObject,
	type PrivilegeSet,
	type PrivilegeType,
	privilegeDiff,
	type RoleAttribute
} from "#test/support/worlds/privileges.ts"

/**
 * Least privilege, from above, for the education data a grizzle database holds. Three properties over installations
 * drawn on the documents base and the education fixture:
 *
 * - The installed privileges are exactly the expected ones: every privilege, grant option, membership option, role
 *   attribute and row-security flag each login, role and PUBLIC holds on every object of the installation, as
 *   PostgreSQL judges it (test/support/worlds/privileges.ts installedPrivileges), equals what README "Security model"
 *   derives from the InstallSpec (expectedPrivileges): nothing more, nothing less. Then, for one privilege of each kind
 *   on each kind of object that some login or role does not hold, the operation it governs, attempted as that login or
 *   role, is refused with 42501.
 * - The drift check reports every catalog fault it names and passes the rest, as the worlds model predicts it after
 *   each perturbation of the catalog, and Db.open, which contacts nothing, opens whatever the catalog holds.
 * - A direct writer meets the world and the laws as the README's SQLSTATEs: every statement on a table or a view a
 *   live transaction sends, and every COMMIT, is refused only with a SQLSTATE the README names, besides agreeing with
 *   the model.
 *
 * A perturbation changes database settings and the attempts take on roles, so the file runs in a database of its own.
 *
 * Plants (main's test phase): worlds-privileges-probe-public-execute.patch,
 * worlds-catalog-check-unexpected-objects-ignored.patch, worlds-direct-guard-sqlstate.patch.
 */
type Feature =
	| `held:${PrivilegedObjectKind}:${PrivilegeType}`
	| `refused:${PrivilegedObjectKind}:${PrivilegeType}`
	| `membership:${MembershipOption}`
	| `attribute:${RoleAttribute}`
	| "row-security:enabled"

/**
 * An installation of the documents base's worlds, drawn, or its README-shaped one (whose roles hold whole entries beside
 * claim-filled writable ones, a serial field's writer, deferred laws a writer meets at COMMIT) over the base or its
 * one-share variant (whose one share per document is a key on Share's `doc`, met at its statement), that variant
 * with an editor beside (whose every fact outside an entry it writes it sees through a relation it holds whole, or not
 * at all), or the education fixture's.
 */
const installs: Gen<InstallSpec> = oneOf([
	generatedDocsInstalls,
	element([docsInstall, docsOneShareInstall, docsEditorInstall]),
	constant(educationInstall)
])

/**
 * The direct suite's installations: the privileges installations two times in three, and otherwise the documents base
 * with an editor beside its worlds, over the base or its one-share variant (docsEditorInstall,
 * docsOneShareEditorInstall), the only installations whose writer meets, under no claims, a fact outside the entry it
 * writes yet visible to it.
 */
const directInstalls: Gen<InstallSpec> = weighted([
	[2, installs],
	[1, element([docsEditorInstall, docsOneShareEditorInstall])]
])

/** A statement on an object's SQL name, when it has one, and one on its name and each column it names. */
interface On {
	readonly on: (sql: (target: string) => string) => ReadonlyArray<string>
	readonly onColumns: (sql: (target: string, column: string) => string) => ReadonlyArray<string>
}

const onOf = (o: InstalledObject): On => ({
	on: (sql) => Option.toArray(Option.map(o.target, sql)),
	onColumns: (sql) =>
		Option.match(o.target, {
			onNone: () => [],
			onSome: (t) => Arr.map(o.columns, (c) => sql(t, c))
		})
})

const relationAttempt = (
	kind: "table" | "view" | "materialized-view",
	p: PrivilegeType,
	{ on, onColumns }: On
): ReadonlyArray<string> => {
	switch (p) {
		case "SELECT":
			return on((t) => `SELECT 1 FROM ${t} WHERE false`)
		case "INSERT":
			return on((t) => `INSERT INTO ${t} DEFAULT VALUES`)
		case "UPDATE":
			return onColumns((t, c) => `UPDATE ${t} SET ${c} = ${c} WHERE false`)
		case "DELETE":
			return on((t) => `DELETE FROM ${t} WHERE false`)
		case "TRUNCATE":
			return kind === "table" ? on((t) => `TRUNCATE ${t}`) : []
		case "TRIGGER":
			return kind === "table"
				? on(
						(t) =>
							`CREATE TRIGGER attempt BEFORE INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()`
					)
				: []
		case "MAINTAIN":
			return kind === "table"
				? on((t) => `REINDEX TABLE ${t}`)
				: kind === "materialized-view"
					? on((t) => `REFRESH MATERIALIZED VIEW ${t}`)
					: []
		case "REFERENCES":
		case "USAGE":
		case "CREATE":
		case "EXECUTE":
			return []
	}
}

const columnAttempt = (p: PrivilegeType, { onColumns }: On): ReadonlyArray<string> => {
	switch (p) {
		case "SELECT":
			return onColumns((t, c) => `SELECT ${c} FROM ${t} WHERE false`)
		case "INSERT":
			return onColumns((t, c) => `INSERT INTO ${t} (${c}) SELECT NULL WHERE false`)
		case "UPDATE":
			return onColumns((t, c) => `UPDATE ${t} SET ${c} = ${c} WHERE false`)
		case "DELETE":
		case "TRUNCATE":
		case "REFERENCES":
		case "TRIGGER":
		case "MAINTAIN":
		case "USAGE":
		case "CREATE":
		case "EXECUTE":
			return []
	}
}

const sequenceAttempt = (p: PrivilegeType, { on }: On): ReadonlyArray<string> => {
	switch (p) {
		case "USAGE":
			return on((t) => `SELECT pg_catalog.nextval(${quoteString(t)}::pg_catalog.regclass)`)
		case "SELECT":
			return on((t) => `SELECT last_value FROM ${t}`)
		case "UPDATE":
			return on((t) => `SELECT pg_catalog.setval(${quoteString(t)}::pg_catalog.regclass, 1, true)`)
		case "INSERT":
		case "DELETE":
		case "TRUNCATE":
		case "REFERENCES":
		case "TRIGGER":
		case "MAINTAIN":
		case "CREATE":
		case "EXECUTE":
			return []
	}
}

/**
 * The statements that exercise a privilege on an object alone: a reference through a schema, a CREATE in it, a read, a
 * write or a maintenance statement on a relation or a column (an UPDATE of a relation naming each of its columns), a
 * call of a function that is no trigger function, the use of a sequence, and a type in a temporary table's column.
 * REFERENCES, which needs a referencing table of the attempter's own, and statements PostgreSQL refuses on the kind of
 * object before it checks a privilege (a view's TRUNCATE, TRIGGER and MAINTAIN) have none. A write may still be refused
 * before any privilege is checked, by what it writes rather than who writes it (a view that is not automatically
 * updatable, a materialized view, an identity or generated column, even through a view): the owner's plan of it meets
 * that too (plannedByOwner).
 */
const attemptsOf = (o: InstalledObject, p: PrivilegeType): ReadonlyArray<string> => {
	const at = onOf(o)
	const object = o.object
	switch (object.kind) {
		case "schema":
			return p === "USAGE"
				? at.on((t) => `SELECT 1 FROM ${t} WHERE false`)
				: p === "CREATE"
					? [`CREATE TABLE ${quoteIdent(object.schema)}.attempt ()`]
					: []
		case "table":
		case "view":
		case "materialized-view":
			return relationAttempt(object.kind, p, at)
		case "column":
			return columnAttempt(p, at)
		case "sequence":
			return sequenceAttempt(p, at)
		case "function":
			return p === "EXECUTE" && !o.trigger
				? at.on(
						(t) =>
							`SELECT ${t}(${Arr.join(
								Array.from({ length: o.arity }, () => "NULL"),
								", "
							)})`
					)
				: []
		case "type":
		case "type-of-column":
			return p === "USAGE" ? at.on((t) => `CREATE TEMPORARY TABLE attempt (v ${t})`) : []
	}
}

/** The privileges a write statement exercises, which PostgreSQL may refuse by what the statement writes first. */
const writes: ReadonlySet<PrivilegeType> = new Set(["INSERT", "UPDATE", "DELETE"])

/**
 * Whether the owner, who holds every privilege on the installation's objects and whose row security is never forced,
 * gets a statement planned: a write PostgreSQL refuses before it checks a privilege is refused to the owner too.
 */
const plannedByOwner = (session: RawSession, sql: string) =>
	Effect.map(Effect.result(session.query(`EXPLAIN ${sql}`, [])), Result.isSuccess)

const held = (
	set: PrivilegeSet,
	grantee: PrivilegeHolder,
	object: PrivilegeObject,
	privilege: PrivilegeType
): boolean => set.has(factText({ kind: "privilege", grantee, object, privilege, grantable: false }))

/**
 * Whether a grantee holds no privilege that would let the attempt of `p` on the object through: `p` itself; on a
 * table, `p` on any of its columns; on a column, `p` on its table (a column privilege is read beyond its table's); on a
 * sequence, UPDATE in place of USAGE.
 */
const withheld = (
	set: PrivilegeSet,
	grantee: PrivilegeHolder,
	o: InstalledObject,
	objects: ReadonlyArray<InstalledObject>,
	p: PrivilegeType
): boolean => {
	const object = o.object
	if (held(set, grantee, object, p)) {
		return false
	}
	switch (object.kind) {
		case "table":
		case "view":
		case "materialized-view":
			return !Arr.some(
				objects,
				(c) =>
					c.object.kind === "column" &&
					c.object.schema === object.schema &&
					c.object.relation === object.name &&
					held(set, grantee, c.object, p)
			)
		case "column": {
			const tables: ReadonlyArray<"table" | "view" | "materialized-view"> = [
				"table",
				"view",
				"materialized-view"
			]
			return !Arr.some(tables, (kind) =>
				held(set, grantee, { kind, schema: object.schema, name: object.relation }, p)
			)
		}
		case "sequence":
			return p !== "USAGE" || !held(set, grantee, object, "UPDATE")
		case "schema":
		case "function":
		case "type":
		case "type-of-column":
			return true
	}
}

/** One attempt: a statement as a login or role that must be refused with 42501. */
interface Attempt {
	readonly grantee: PrivilegeHolder
	readonly role: string
	readonly kind: PrivilegedObjectKind
	readonly privilege: PrivilegeType
	readonly sql: string
}

/**
 * Takes on `role` for one transaction in the owner's session, sends `sql` and rolls back: the SQLSTATE it was refused
 * with, or none when it ran.
 */
const attempt = (session: RawSession, role: string, sql: string) =>
	Effect.gen(function* () {
		yield* session.begin
		yield* session.query(`SET LOCAL ROLE ${quoteIdent(role)}`, [])
		const outcome = yield* Effect.result(session.query(sql, []))
		yield* session.rollback
		return Result.match(outcome, {
			onSuccess: () => Option.none<string>(),
			onFailure: (error) =>
				Option.some(
					error.reason._tag === "ServerError" ? error.reason.fields.code : error.reason.message
				)
		})
	})

/** What an attempt exercises: a privilege on a kind of object. */
const kindOf = (a: Attempt): string => `${a.kind}:${a.privilege}`

/** The first property's case: an installation, and each attempted privilege drawn from the case's tape. */
const privilegeCase = (install: InstallSpec, c: Case<Feature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const world = yield* realize(install, ordinarySession)
			const names = world.names
			const expected = expectedPrivileges(install, names)
			const installed = yield* installedPrivileges(names)
			const diff = privilegeDiff(expected, installed)
			assert.deepEqual(
				diff,
				{ missing: [], extra: [] },
				"the installed privileges are the expected privileges"
			)
			for (const fact of installed.values()) {
				switch (fact.kind) {
					case "privilege":
						c.note(`held:${fact.object.kind}:${fact.privilege}`)
						break
					case "membership":
						c.note(`membership:${fact.option}`)
						break
					case "attribute":
						c.note(`attribute:${fact.attribute}`)
						break
					case "row-security":
						c.note("row-security:enabled")
						break
				}
			}
			const objects = yield* installedObjects(names)
			const grantees: ReadonlyArray<readonly [PrivilegeHolder, string]> = [
				...Arr.map(
					Record.toEntries(names.logins),
					([name, role]): readonly [PrivilegeHolder, string] => [{ kind: "login", name }, role]
				),
				...Arr.map(
					Record.toEntries(names.roles),
					([name, role]): readonly [PrivilegeHolder, string] => [{ kind: "role", name }, role]
				)
			]
			const statements = Arr.flatMap(objects, (o) =>
				Arr.flatMap(attemptKinds, (p) => Arr.map(attemptsOf(o, p), (sql) => ({ o, p, sql })))
			)
			const { admin, session: open } = yield* Substrate
			for (const [, role] of grantees) {
				yield* admin.query(
					`GRANT ${quoteIdent(role)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`,
					[]
				)
			}
			const session = yield* open(ownerSession())
			const ownerPlanned = yield* Effect.filter(
				Arr.dedupe(Arr.flatMap(statements, (s) => (writes.has(s.p) ? [s.sql] : []))),
				(sql) => plannedByOwner(session, sql)
			)
			const planned = new Set(ownerPlanned)
			const candidates = Arr.flatMap(statements, ({ o, p, sql }) =>
				writes.has(p) && !planned.has(sql)
					? []
					: Arr.flatMap(grantees, ([grantee, role]): ReadonlyArray<Attempt> =>
							withheld(installed, grantee, o, objects, p)
								? [{ grantee, role, kind: o.object.kind, privilege: p, sql }]
								: []
						)
			)
			const chosen = Arr.flatMap(Arr.dedupe(Arr.map(candidates, kindOf)), (kind) => {
				const group = Arr.filter(candidates, (a) => kindOf(a) === kind)
				return Option.toArray(Arr.get(group, c.draw(int(0, group.length - 1))))
			})
			for (const a of chosen) {
				const refusal = yield* attempt(session, a.role, a.sql)
				assert.deepEqual(
					refusal,
					Option.some("42501"),
					`${a.sql} as the ${a.grantee.kind} that holds no ${a.privilege} on it`
				)
				c.note(`refused:${a.kind}:${a.privilege}`)
			}
		})
	)

const attemptKinds: ReadonlyArray<PrivilegeType> = [
	"USAGE",
	"CREATE",
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE",
	"TRUNCATE",
	"TRIGGER",
	"MAINTAIN",
	"EXECUTE"
]

/**
 * What the first property's population must reach: each privilege README "Security model" grants, on each kind of object it
 * grants one on, every membership option and attribute it gives, row security, and a refused attempt of each privilege
 * an attempt exercises alone on each kind of object.
 */
const situations: Arr.NonEmptyReadonlyArray<Reached<Feature>> = [
	"held:schema:USAGE",
	"held:table:SELECT",
	"held:table:INSERT",
	"held:table:UPDATE",
	"held:table:DELETE",
	"held:column:SELECT",
	"held:column:INSERT",
	"held:column:UPDATE",
	"held:view:SELECT",
	"held:materialized-view:MAINTAIN",
	"held:function:EXECUTE",
	"held:type-of-column:USAGE",
	"membership:member",
	"membership:set",
	"attribute:LOGIN",
	"attribute:INHERIT",
	"row-security:enabled",
	"refused:schema:USAGE",
	"refused:schema:CREATE",
	"refused:table:SELECT",
	"refused:table:INSERT",
	"refused:table:UPDATE",
	"refused:table:DELETE",
	"refused:table:TRUNCATE",
	"refused:table:TRIGGER",
	"refused:table:MAINTAIN",
	"refused:view:SELECT",
	"refused:view:INSERT",
	"refused:view:UPDATE",
	"refused:view:DELETE",
	"refused:materialized-view:SELECT",
	"refused:materialized-view:MAINTAIN",
	"refused:column:SELECT",
	"refused:column:INSERT",
	"refused:column:UPDATE",
	"refused:sequence:USAGE",
	"refused:sequence:SELECT",
	"refused:sequence:UPDATE",
	"refused:function:EXECUTE",
	"refused:type-of-column:USAGE"
]

/**
 * The SQLSTATEs the README names for a direct writer; a refusal of a live transaction's statement on a relation grizzle
 * installs is one of them. A role's closed roster held whole has no view (its members are literals in every query that
 * reads it), so a select of its view names no relation and meets PostgreSQL's 42P01, which no README row is for. A
 * select whose own predicate raises (ViewFilter raise-on) meets the writer's raise, or the writer's column its relation
 * lacks, which are the writer's, never a refusal of grizzle's.
 */
const readmeSqlstate = ({ seen }: Checked): void => {
	const { action, observation, before } = seen
	if (observation.kind !== "refused" && observation.kind !== "law-refused") {
		return
	}
	if (action.kind === "direct-end") {
		assert.notEqual(
			observation.sqlstate,
			"other",
			"a COMMIT is refused with a SQLSTATE the README names"
		)
		return
	}
	if (action.kind !== "direct") {
		return
	}
	const session = before.sessions[action.session]
	const live = session?.kind === "direct" && session.transaction === "open"
	const statement = action.statement
	const onRelation =
		statement.kind === "insert" ||
		statement.kind === "delete" ||
		statement.kind === "update" ||
		statement.kind === "truncate" ||
		(statement.kind === "select-table" && statement.filter.kind === "none") ||
		(statement.kind === "select-view" &&
			statement.filter.kind === "none" &&
			installedView(before.install, statement.role, statement.relation) !== undefined)
	if (live && onRelation) {
		assert.notEqual(
			observation.sqlstate,
			"other",
			`a ${statement.kind} is refused with a SQLSTATE the README names`
		)
	}
}

const directFeature = (f: WorldFeature): boolean =>
	opIn({
		kinds: ["direct", "direct-end"],
		writers: ["direct-role", "direct-login"],
		observations: ["ok", "rows", "refused", "law-refused"]
	})(f) ||
	startingWith(
		"object:grant:",
		"object:revoke:",
		"object:policy:",
		"object:membership:",
		"object:advance-function:",
		"object:filter-function:",
		"object:key-probe:attempt-refused",
		"object:key-probe:accepted-inside",
		"object:view:attempt-refused",
		"object:barrier-view:attempt-refused",
		"object:barrier-view:raise-suppressed"
	)(f)

const catalogFeature = (f: WorldFeature): boolean =>
	startingWith("invalid:catalog:", "invariant:least-privilege")(f) ||
	opIn({ kinds: ["open-db"], writers: ["db"], observations: ["opened", "open-refused"] })(f) ||
	opIn({ kinds: ["tamper"], writers: everyWriter, observations: ["ok"] })(f) ||
	opIn({ kinds: ["drift"], writers: everyWriter, observations: ["drift"] })(f)

layer(Substrate.isolatedLayer, { excludeTestServices: true })(
	"least privilege: the worlds' privileges from above",
	(it) => {
		it.effect("every role's installed privileges are exactly the expected privileges", (ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: 'README "Security model" derived from the InstallSpec (worlds/privileges.ts expectedPrivileges) against PostgreSQL\'s own judgment of every privilege, and 42501 for an operation one it lacks governs'
						},
						suite: "pg/world-model/privileges",
						draw: drawn(installs),
						literal: Formatter.format,
						coverage: required<Feature>(situations, { cases: 8, sense: notesOnly }),
						kept: [],
						runs: 8,
						shrink: { kind: "bounded", candidates: 100 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					privilegeCase
				)
			)
		)

		programTests(it, {
			suite: "pg/world-model/privileges/catalog-check",
			name: "the drift check reports every catalog fault it names and passes the rest, and every Db opens",
			installs,
			realize: fresh,
			focus: ["tamper", "open-db", "drift"],
			steps: 10,
			cases: 100,
			required: requiredWhere(catalogFeature),
			realities: drawnRealities,
			lead: noLead,
			check: () => undefined
		})

		programTests(it, {
			suite: "pg/world-model/privileges/direct",
			name: "a direct writer meets the world and the laws as the README's SQLSTATEs",
			installs: directInstalls,
			realize: fresh,
			focus: ["direct-begin", "direct", "direct-end"],
			steps: 12,
			cases: 32,
			required: requiredWhere(directFeature),
			realities: docsTenantRealities,
			lead: leadsOf(
				directTransaction(requiredWhere(directFeature)),
				breakingAtCommit(requiredWhere(directFeature))
			),
			check: readmeSqlstate
		})
	}
)
