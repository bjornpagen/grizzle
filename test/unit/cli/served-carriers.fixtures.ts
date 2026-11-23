/** What the properties of served-carriers.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Record as Rec, Result, String as Str } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { manifestStatements } from "#compiler/deploy/admission/manifest.ts"
import { manifestRoles, roleExpectation } from "#compiler/deploy/admission/roles.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import { decoderLoginOf } from "#compiler/deploy/snapshot/objects.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, mutable, relation, schema, unit, wholeEntriesOf } from "#compiler/public/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { repoRoot } from "#test/support/files.ts"
import { interpret, type ModelFile, type State } from "#test/support/migrate/interpret.ts"
import { draftActions } from "#test/support/migrate/review.ts"

/** A role's change member: none, an insert of R, or a put of R from a query over a relation parameter. */
const kinds = ["none", "insert", "put"] as const

type Kind = (typeof kinds)[number]

/** The roles of `app`, and those of `other`, none for no second login. */
interface Logins {
	readonly app: Arr.NonEmptyReadonlyArray<Kind>
	readonly other: ReadonlyArray<Kind>
}

/** The logins of the first draft, and of the second, which migrates from the first's snapshot. */
interface Case {
	readonly first: Logins
	readonly second: Logins
}

const loginsGen: Gen<Logins> = (source) => {
	const first = source.draw(element(kinds))
	const rest = source.draw(array(element(kinds), { min: 0, max: 2 }))
	return { app: [first, ...rest], other: source.draw(array(element(kinds), { min: 0, max: 1 })) }
}

export const caseGen: Gen<Case> = (source) => ({
	first: source.draw(loginsGen),
	second: source.draw(loginsGen)
})

export type Feature =
	| "a role whose served file creates a carrier"
	| "a role whose served file creates none"
	| "one login holding both"
	| "a second login"
	| "a role with no change member"
	| "a migration granting TEMPORARY to a role that held none"
	| "a migration revoking TEMPORARY from a role that stands"
	| "a migration dropping a role that held TEMPORARY"

const R = relation("R", { k: pg.integer, v: pg.integer }, ["k"])

const Base = schema("served_carriers", [R], [unit("Rs", { k: pg.integer }), mutable(R)])

/** A role of the box: R whole, written. */
const writer = (name: string) => role(Base, name, wholeEntriesOf(Base), { write: ["R"] })

/** The put of R by the role `r`, from a query over the relation parameter `rows`: its displacing deletion and its
 * insert both read the query's rows, from a carrier of the program's own. */
const putOf = (r: ReturnType<typeof writer>) =>
	ChangeSet.empty(r).put(
		R,
		query(r).rule((q) => {
			const rows = q.relation("rows", { k: R.fields.k, v: R.fields.v })
			const { k, v: value } = v(R, "r")
			return q.match(rows, { k, v: value }).find({ k, v: value })
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

/** Each declared role of `drafted`'s logins, `<login>.<role>`, whose served file creates a carrier: the oracle. */
interface Drafted {
	readonly draft: Effect.Success<ReturnType<typeof draftSchema>>
	readonly carriers: ReadonlyArray<string>
	/** Each installed login and role, by its PostgreSQL role, as `<login>` and `<login>.<role>`. */
	readonly declared: ReadonlyMap<string, string>
}

/**
 * The draft of `logins` from `previous`, as `grizzle generate` makes it, with its served files' carrier roles, each
 * note its logins and served files reach, and the installation's and the expectation's TEMPORARY on the database held
 * to them.
 */
export const drafted = (
	logins: Logins,
	previous: (configured: { readonly declared: string; readonly ident: string }) => DeploySnapshot,
	declarations: Declarations,
	notes: { readonly note: (feature: Feature) => void }
) =>
	Effect.gen(function* () {
		const app = loginOf("app", "a", logins.app)
		const others = Arr.isReadonlyArrayNonEmpty(logins.other)
			? [loginOf("other", "b", logins.other)]
			: []
		if (others.length > 0) {
			notes.note("a second login")
		}
		if (Arr.some([...logins.app, ...logins.other], (k) => k === "none")) {
			notes.note("a role with no change member")
		}
		const config = yield* resolveConfig(
			defineConfig({
				schemas: [Base],
				logins: [app, ...others],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => offlineOwner
			}),
			file
		)
		const configured = defined(config.schemas[0], "the configured schema")
		const compiled = yield* Effect.fromResult(compileSchema(configured))
		const draft = yield* draftSchema(compiled, previous(configured), [], declarations, silentPhases)
		const served = draft.served
		assert.ok(served.kind === "logins", "a schema with a login plans its logins")
		const entries = yield* servedFiles(compiled, draft, served, silentPhases)
		const creates = Arr.flatMap(entries, (entry) => {
			const file = succeeded(servedFile(jsonOf(entry.text)), "the served file")
			const roles = Arr.map(file.roles, (r) => ({
				key: `${entry.login}.${r.name}`,
				carrier: Arr.some(textsIn(r.members), Str.includes("CREATE TEMPORARY TABLE "))
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
		const declared = new Map(
			Arr.flatMap(installation.worlds, (l) => [
				[l.role, l.name] as const,
				...Arr.map(l.roles, (r) => [r.role, `${l.name}.${r.name}`] as const)
			])
		)
		const declaredOf = (installed: string): string =>
			defined(declared.get(installed), `the declared name of ${installed}`)
		const granted = Arr.flatMap(installation.manifest.objects, (o) =>
			Arr.flatMap(o.ddl, (s) =>
				s.kind === "grant" && s.on.kind === "DATABASE" && Arr.contains(s.privileges, "TEMPORARY")
					? Arr.map(s.to, (g) => (g.kind === "role" ? declaredOf(g.name) : "PUBLIC"))
					: []
			)
		)
		assert.deepEqual(
			Arr.sort(granted, Str.Order),
			carriers,
			"the installation grants TEMPORARY on the database to exactly the roles whose served file creates a carrier, once each"
		)
		const { statements } = succeeded(manifestStatements(draft.snapshot))
		for (const installed of manifestRoles(statements)) {
			const held = Arr.filter(
				roleExpectation(
					statements,
					installation.names.schema,
					installed,
					decoderLoginOf(draft.snapshot.manifest.objects)
				).privileges,
				(p) => p.family === "database"
			)
			assert.deepEqual(
				Arr.map(held, (p) => p.privilege),
				Arr.contains(carriers, declaredOf(installed)) ? ["TEMPORARY"] : [],
				`${declaredOf(installed)}: the drift check expects its own TEMPORARY on the database exactly when its served file creates a carrier`
			)
		}
		const result: Drafted = { draft, carriers, declared }
		return result
	})

/** A draft's folder as the migration model runs it, file by file, each loss written in. */
const modelFiles = (d: Drafted): ReadonlyArray<ModelFile> =>
	Arr.map(planFiles(d.draft.plan), (f) => ({
		draft: { name: f.name },
		actions: Arr.flatMap(f.drafts, draftActions)
	}))

/** The model's state once `d`'s folder runs on `state`; a refusal fails the case, naming the file and the action. */
export const migrated = (d: Drafted, state: State): State => {
	const run = interpret(d.draft.installation.names.schema, state, modelFiles(d), (p) => {
		throw new Error(`the migration asks no placeholder, but drafted a ${p.kind}`)
	})
	if (Result.isFailure(run)) {
		assert.fail(
			`the migration fails on the model: ${run.failure.file} #${run.failure.action}, ${run.failure.reason}`
		)
	}
	return run.success
}

/** The declared roles the model's database privileges name, each holding TEMPORARY alone, sorted. */
export const temporaryHolders = (
	state: State,
	declared: ReadonlyMap<string, string>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map([...state.databasePrivileges], ([role, held]) => {
			assert.deepEqual([...held], ["TEMPORARY"], `${role} holds TEMPORARY alone on the database`)
			return defined(declared.get(role), `the declared name of ${role}`)
		}),
		Str.Order
	)
