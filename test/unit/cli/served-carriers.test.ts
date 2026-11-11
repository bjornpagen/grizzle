import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { manifestStatements } from "#compiler/deploy/admission/manifest.ts"
import { manifestRoles, roleExpectation } from "#compiler/deploy/admission/roles.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, mutable, relation, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { role } from "#compiler/schema/world.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * A role holds TEMPORARY on the database exactly when its served workload creates a carrier, a temporary table: the
 * installation grants it to those roles and to no other role or login (physical/ddl/roles.ts addWorlds), and the drift
 * check expects each login's and role's own TEMPORARY grant on the database to be exactly that (deploy/admission/roles.ts
 * roleExpectation).
 *
 * The box: one relation, R(k, v) keyed by k and mutable, and the login `app` of one to three roles, beside it none or
 * a second login `other` of one role. Every role holds R whole and writes it, and owns a drawn change member: none, an
 * insert of R, or a put of R with a read-back of both sides of its delta, every member supplied by the call.
 *
 * Oracle: the texts each role's served file holds, as `grizzle generate` writes them (draftSchema, then servedFiles): a
 * role creates a carrier exactly when one of them is a CREATE TEMPORARY TABLE, whatever step, staged form or variant
 * sends it. The installation's grants of TEMPORARY on the database, its manifest's, go to exactly those roles, and each
 * login's and role's expectation holds the database's TEMPORARY exactly for them.
 *
 * Features: a role whose served file creates a carrier, a role whose does not, one login holding both, a second login,
 * and a role with no change member.
 *
 * Plants (~/.cache/grizzle-release/GZTEMP/plants): temporary-every-role (every role granted TEMPORARY),
 * temporary-no-role (no role granted it), temporary-expectation-blind (the expectation leaves the database's grant out).
 */

/** A role's change member: none, an insert of R, or a put of R with a read-back of both sides of its delta. */
const kinds = ["none", "insert", "put"] as const
type Kind = (typeof kinds)[number]

/** The roles of `app`, and those of `other`, none for no second login. */
interface Case {
	readonly app: Arr.NonEmptyReadonlyArray<Kind>
	readonly other: ReadonlyArray<Kind>
}

const caseGen: Gen<Case> = (source) => {
	const first = source.draw(element(kinds))
	const rest = source.draw(array(element(kinds), { min: 0, max: 2 }))
	return { app: [first, ...rest], other: source.draw(array(element(kinds), { min: 0, max: 1 })) }
}

type Feature =
	| "a role whose served file creates a carrier"
	| "a role whose served file creates none"
	| "one login holding both"
	| "a second login"
	| "a role with no change member"

const R = relation("R", { k: pg.integer, v: pg.integer }, ["k"])
const Base = schema("served_carriers", { R }, [mutable(R)])

/** A role of the box: R whole, written. */
const writer = (name: string) => role(Base, name, wholeEntriesOf(Base), { write: ["R"] })

/** The put of R by the role `r`, with a read-back of both sides of its delta. */
const putOf = (r: ReturnType<typeof writer>) =>
	ChangeSet.empty(r)
		.put(R, [])
		.read("delta", (d) =>
			query(r)
				.rule((q) => {
					const { k, v: value } = v(R, "added")
					return q.match(d.added(R), { k, v: value }).find({ side: "added", k, v: value })
				})
				.rule((q) => {
					const { k, v: value } = v(R, "removed")
					return q.match(d.removed(R), { k, v: value }).find({ side: "removed", k, v: value })
				})
		)

/** The insert of R by the role `r`. */
const insertOf = (r: ReturnType<typeof writer>) => ChangeSet.empty(r).insert(R, [])

/** A role's change member, an insert of R or a put of it. */
type Member = ReturnType<typeof insertOf> | ReturnType<typeof putOf>

/** The workloads the role `r`, named `name`, owns for its change member of `kind`: none for no member. */
const workloadsOf = (r: ReturnType<typeof writer>, name: string, kind: Kind) => {
	if (kind === "none") {
		return []
	}
	const programs: Readonly<Record<string, Member>> =
		kind === "insert" ? { [`add_${name}`]: insertOf(r) } : { [`put_${name}`]: putOf(r) }
	return [workload(r, programs)]
}

/** The login `name` over a role of each of `drawnKinds`, each named after `prefix` and its place. */
const loginOf = (name: string, prefix: string, drawnKinds: Arr.NonEmptyReadonlyArray<Kind>) => {
	const built = Arr.map(drawnKinds, (kind, i) => {
		const r = writer(`${prefix}${i}`)
		return { r, workloads: workloadsOf(r, `${prefix}${i}`, kind) }
	})
	return login(
		Base,
		name,
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

const file = `${repoRoot}app/grizzle.config.ts`

layer(NodeServices.layer, { excludeTestServices: true })("TEMPORARY on the database", (it) => {
	it.effect(
		"is granted to exactly the roles whose served workload creates a carrier, and expected of exactly them",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/served-carriers",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the CREATE TEMPORARY TABLE texts each role's served file holds"
						},
						coverage: required<Feature>(
							[
								"a role whose served file creates a carrier",
								"a role whose served file creates none",
								"one login holding both",
								"a second login",
								"a role with no change member"
							],
							{ cases: 16, sense: notesOnly }
						),
						kept: [],
						runs: 16,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							const app = loginOf("app", "a", c.app)
							const others = Arr.isReadonlyArrayNonEmpty(c.other)
								? [loginOf("other", "b", c.other)]
								: []
							if (others.length > 0) {
								notes.note("a second login")
							}
							if (Arr.some([...c.app, ...c.other], (k) => k === "none")) {
								notes.note("a role with no change member")
							}
							const config = yield* resolveConfig(
								defineConfig({
									schemas: [Base],
									logins: [app, ...others],
									migrations: "migrations",
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
								noDeclarations
							)
							const served = draft.served
							assert.ok(served.kind === "logins", "a schema with a login plans its logins")
							const entries = yield* servedFiles(compiled, draft.snapshotFiles, served)
							const creates = Arr.flatMap(entries, (entry) => {
								const roles = Arr.map(servedFile(trustedJson<unknown>(entry.text)).roles, (r) => ({
									key: `${entry.login}.${r.name}`,
									carrier: Arr.some(textsIn(r.members), Str.startsWith("CREATE TEMPORARY TABLE "))
								}))
								if (Arr.some(roles, (r) => r.carrier) && Arr.some(roles, (r) => !r.carrier)) {
									notes.note("one login holding both")
								}
								return roles
							})
							for (const r of creates) {
								notes.note(
									r.carrier
										? "a role whose served file creates a carrier"
										: "a role whose served file creates none"
								)
							}
							const carriers = Arr.sort(
								Arr.flatMap(creates, (r) => (r.carrier ? [r.key] : [])),
								Str.Order
							)
							const installation = draft.installation
							const declared = new Map([
								...Arr.flatMap(installation.worlds, (l) => [
									[l.role, `${l.name}`] as const,
									...Arr.map(l.roles, (r) => [r.role, `${l.name}.${r.name}`] as const)
								])
							])
							const declaredOf = (installed: string): string =>
								defined(declared.get(installed), `the declared name of ${installed}`)
							const granted = Arr.flatMap(installation.manifest.objects, (o) =>
								Arr.flatMap(o.ddl, (s) =>
									s.kind === "grant" &&
									s.on.kind === "DATABASE" &&
									Arr.contains(s.privileges, "TEMPORARY")
										? Arr.flatMap(s.to, (g) => (g.kind === "role" ? [declaredOf(g.name)] : ["PUBLIC"]))
										: []
								)
							)
							assert.deepEqual(
								Arr.sort(granted, Str.Order),
								carriers,
								"the installation grants TEMPORARY on the database to exactly the roles whose served file creates a carrier, once each"
							)
							const statements = succeeded(manifestStatements(draft.snapshot))
							for (const installed of manifestRoles(statements)) {
								const held = Arr.filter(
									roleExpectation(statements, installation.names.schema, installed).privileges,
									(p) => p.family === "database"
								)
								assert.deepEqual(
									Arr.map(held, (p) => p.privilege),
									Arr.contains(carriers, declaredOf(installed)) ? ["TEMPORARY"] : [],
									`${declaredOf(installed)}: the drift check expects its own TEMPORARY on the database exactly when its served file creates a carrier`
								)
							}
						})
				)
			)
	)
})
