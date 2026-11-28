/** What empty-level.test.ts reads: its installation, its box, and each case's calls. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fragment, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { noPlaceholders, type Version } from "#test/support/install-migrate.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * What a case does with den's shape of a read of no relation: serves the read itself on the role, commits its rows
 * through the role's ChangeSet and reads them back, commits den's census of them, a rule over the role matching the
 * read bound by its own parameters, and reads them back, or builds a read of the base's relation over a level of the
 * base that declares no relation of its own for the role.
 */
export type Call =
	| "the read of no relation"
	| "the commit of its rows"
	| "the census of its rows"
	| "a read over a level declaring nothing of its own, refused"

export const calls: Gen<Call> = element<Call>([
	"the read of no relation",
	"the commit of its rows",
	"the census of its rows",
	"a read over a level declaring nothing of its own, refused"
])

export type EmptyLevelFeature = `${Call} by a role holding nothing of the base`

/**
 * The installation under `name`, den's shape of a derived root over a schedule: Base, the app's Want(batch, size);
 * Thin, a level over it declaring no relation of its own; App over Thin, a fragment of Hour(at, bell), as den's
 * fragment of a flow's facts; the role `den` holding Hour alone, nothing of the base, and inserting it; `hourOf`, a
 * read over schema.empty of its two parameters, as a schedule's input derived from its key; and the login `desk` of
 * den serving hourOf itself, `record`, the insert of hourOf's rows into Hour, `census`, den's request of a root derived
 * from its key, the insert into Hour of the rows a rule over den finds where it matches hourOf bound by the request's
 * own parameters and Hour holds no such row yet, and `hours`, the read of Hour. `thinWant` reads Want over Thin.
 */
const builtOf = (name: string) => {
	const Name = str.regex("^[a-z]{1,8}$")
	const Want = relation("Want", { batch: Name, size: int8 }, ["batch"])
	const Hour = relation("Hour", { at: int8, bell: Name }, ["at", "bell"])
	const base = schema(name, [Want], [])
	const thin = schema.extend([base], `${name}_1`, [], [])
	const app = schema.extend([thin], `${name}_2`, [fragment([Hour], [])], [])
	const den = role(app, "den", { Hour }, { insert: ["Hour"] })
	const hourOf = query(schema.empty).rule((r) =>
		r.find({ at: r.param("at", int8), bell: r.param("bell", Name) })
	)
	const record = ChangeSet.empty(den).insert(Hour, hourOf)
	const census = ChangeSet.empty(den).insert(
		Hour,
		query(den).rule((r) => {
			const derived = hourOf.bind({
				at: r.param("hourAt", int8),
				bell: r.param("hourBell", Name)
			})
			const { at, bell } = v(derived, "derived")
			return r.match(derived, { at, bell }).where(r.not(Hour, { at, bell })).find({ at, bell })
		})
	)
	const hours = query(den).rule((r) => {
		const { at, bell } = v(Hour, "hour")
		return r.match(Hour, { at, bell }).find({ at, bell })
	})
	const thinWant = query(thin).rule((r) => {
		const { batch, size } = v(Want, "want")
		return r.match(Want, { batch, size }).find({ batch, size })
	})
	const desk = login(app, "desk", [den], {
		workload: [workload(den, { derive: hourOf, record, census, hours })]
	})
	const version: Version = { schema: app, logins: [desk] }
	return { version, desk, den, thinWant, programs: { derive: hourOf, record, census, hours } }
}

/** A schedule's key: the instant its cron matched, and its member, the bell that chimes it. */
const key = { at: 3_600_000_000n, bell: "noon" } as const

/**
 * A case: installs the app through its migration; asserts the den role holds SELECT on no relation of the base's level
 * (Want is there, held by none); then, as the case says, calls the read of no relation through the served Db of den,
 * which answers the key's row; commits its rows by `record`, or by den's `census`, its key the request's parameters,
 * and reads Hour back, which holds the key's row; or builds a workload over den of the read of Want over Thin, refused,
 * since Thin is no level den holds: it declares nothing, but holds the base's Want below it.
 * Oracle: PostgreSQL's privileges and acceptance of every served statement, and the level rule's refusal.
 */
export const emptyLevelCase = (call: Call, c: Case<EmptyLevelFeature>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const built: Array<ReturnType<typeof builtOf>> = []
		const m = yield* migrated({
			label: "empty_level",
			schemaName: { kind: "unique" },
			first: (name) => {
				const b = builtOf(name)
				built.push(b)
				return b.version
			},
			later: [],
			apply: noPlaceholders,
			declared: () => noDeclarations,
			observe: noObservation
		})
		const at = built[0]
		assert.ok(at !== undefined, "the installation was built")
		const [base] = m.installation.names.levels
		const denRoles = yield* substrate.admin.queryValues(
			"SELECT rolname FROM pg_catalog.pg_roles WHERE starts_with(rolname, $1::text) AND rolname LIKE '%\\_\\_den'",
			[identifierOf(base)]
		)
		const [denRole] = Arr.map(denRoles, (row) => String(row[0]))
		assert.ok(denRole !== undefined && denRoles.length === 1, "the installation has den's one role")
		const [held] = yield* substrate.admin.queryValues(
			"SELECT count(*)::int4, count(*) FILTER (WHERE pg_catalog.has_table_privilege($1::text, c.oid, 'SELECT'))::int4 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $2::text AND c.relkind IN ('r', 'p', 'v', 'm')",
			[denRole, identifierOf(base)]
		)
		assert.ok(Number(held?.[0]) > 0, "the base's level holds its relations")
		assert.equal(Number(held?.[1]), 0, "den holds SELECT on no relation of the base's level")
		if (call === "a read over a level declaring nothing of its own, refused") {
			const refused = catchCompileError(() => workload(at.den, { thinWant: at.thinWant }))
			assert.ok(
				!refused.ok,
				"a workload over den of a read of the base's relation over Thin is refused: Thin is no level den holds"
			)
		} else {
			const db = yield* openServedDb(m, at.desk.roles.den, {})
			const served = yield* db.serve(at.programs)
			const committed = (write: "record" | "census", params: Readonly<Record<string, unknown>>) =>
				Effect.flatMap(writeOnce(member(served, write))({ params, facts: {} }), () =>
					readOnce(member(served, "hours"))({ params: {}, facts: {} })
				)
			const answered =
				call === "the read of no relation"
					? yield* readOnce(member(served, "derive"))({ params: key, facts: {} })
					: call === "the commit of its rows"
						? yield* committed("record", key)
						: yield* committed("census", { hourAt: key.at, hourBell: key.bell })
			assert.deepEqual(
				Arr.map(answered, (row) => ({ ...row })),
				[key],
				`${call} answers the key's row`
			)
		}
		c.note(`${call} by a role holding nothing of the base`)
	})
