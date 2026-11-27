/**
 * Each role's isolation level is decided once, in the draft's workload plan, from the statements its served writes
 * send (program/isolation/certification.ts), and reaches everything that runs by it alike: the role's served file
 * records it and projects its writes at it, and the installation holds it, which its tables' guards follow.
 *
 * The box: the ChangeSet agreement's Work (test/support/agreement/changeset-schema.ts) configured alone, one login
 * over it whose writer holds every relation of Work whole and writes a drawn nonempty set of them, under `insert` or
 * `write`, and runs an insert of each relation of a drawn nonempty subset of them, every member supplied by the call;
 * beside it a reader of Work that writes nothing; and beside that login, as a drawn direct writer, none or a login whose
 * one role has no change member and inserts, or writes, a drawn nonempty set of the same relations, as psql does. The
 * relations written cover every kind of field and law Work holds: a closed id, a set and texts (Tag), a serial
 * (Ticket), a contract (Budget), a plain relation (Task), an immutable family owner (Order, Pool) and a tree (Node).
 *
 * Properties, over the draft's own plan as generate and check compile it (draftSchema, then eachServedFile):
 *
 * - Names: every reason any certificate gives names a relation of Work, never a table, a function or a statement the
 *   names grizzle installs leave unresolved (`?"schema"."name"`, `?function:...`, `?statement:...`), so every object a
 *   compiled write of a whole entry reaches is one the certifier reads facts of.
 * - Levels: each role's level as its served login reads it, the isolation of its role token (served(...).roles[r]
 *   isolation, the public reading an application and a test of it take, never the file's encoding), is its
 *   certificate's, and so is its level in the installation; each served login's tokens are exactly its roles.
 * - A role with no change member is SERIALIZABLE.
 * - Guards: every relation a READ COMMITTED role holds INSERT on has no guard trigger in the installation
 *   (physical/ddl/isolation.ts readCommittedRelations), so none of its writes is refused below SERIALIZABLE: a role
 *   writing a relation a SERIALIZABLE role writes too is SERIALIZABLE. Kept: an inserter of Tag beside a direct
 *   inserter of Tag, which certified READ COMMITTED while Tag kept its guard.
 * - The snapshot: each login compiled from the runtime snapshot alone (adapter/served/compile.ts snapshotServedEntry),
 *   as an application's test compiles it, is generate's served file byte for byte, a READ COMMITTED role's writes at
 *   that level among it: the snapshot records each role's certificate, which that compile compiles its ChangeSets at,
 *   so a test runs the forms production runs. Kept: the snapshot-only compile compiled every role at SERIALIZABLE, so
 *   its writes read what generate's did not (second-call's put of Fixed, batched's insert of Wide).
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { served as servedLogin } from "#adapter/public/layer.ts"
import { snapshotServedEntry } from "#adapter/served/compile.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { reasonsOf } from "#compiler/core/certificate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot, writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import { isolationTrigger } from "#compiler/physical/ddl/isolation.ts"
import { grantedPrivileges } from "#compiler/physical/ddl/roles.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { type AnyLogin, login, wholeEntriesOf } from "#compiler/public/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { Work } from "#test/support/agreement/changeset-schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { joined, jsonOf } from "#test/support/chunked.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import {
	caseGen,
	type Feature,
	file,
	listsOf,
	showCase
} from "#test/unit/cli/served-certified.fixtures.ts"

/**
 * A role's isolation level is decided once from the statements its writes send, every name they reach resolved, and
 * its served file and the installation hold it alike.
 *
 * Budget: its suite's count before the conversion (unit/cli/served-certified: 24 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (a role certified
 * READ COMMITTED; toolchain-test run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200, which
 * it stops short of once every situation is reached.
 */
export const aRolesIsolationLevelIsDecidedOnceFromTheStatementsItsWritesSendEveryNameTheyReachResolvedAndItsServedFileAndTheInstallationHoldItAlike =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"an insert role",
			"a write role",
			"a role certified READ COMMITTED",
			"a role certified SERIALIZABLE for its own statements",
			"a role with no change member",
			"a direct writer of a relation the writer writes",
			"a READ COMMITTED role served from the snapshot alone"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: Case<Feature>) => (c) =>
			Effect.gen(function* () {
				notes.note(c.mode === "insert" ? "an insert role" : "a write role")
				const writer = role(Work, "writer", wholeEntriesOf(Work), listsOf(c.mode, c.writes))
				const reader = role(Work, "reader", wholeEntriesOf(Work))
				const programs = Rec.fromEntries(
					Arr.map(
						c.inserts,
						(w) => [`add${w.name}`, ChangeSet.empty(writer).insert(w.relation, [])] as const
					)
				)
				const app = login(Work, "app", [writer, reader], {
					workload: [workload(writer, programs)]
				})
				const direct = c.direct
				const psql =
					direct.kind === "none"
						? []
						: [
								login(Work, "psql", [
									role(Work, "direct", wholeEntriesOf(Work), listsOf(direct.kind, direct.writes))
								])
							]
				if (
					direct.kind !== "none" &&
					Arr.some(direct.writes, (d) => Arr.some(c.writes, (w) => w.name === d.name))
				) {
					notes.note("a direct writer of a relation the writer writes")
				}
				const config = yield* resolveConfig(
					defineConfig({
						contracts: [],
						schemas: [Work],
						logins: [app, ...psql],
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
				const servedLogins = new Map(
					Arr.map(
						entries,
						(e) => [e.login, servedLogin<AnyLogin>(jsonOf(e.text), e.login)] as const
					)
				)
				const installation = draft.installation
				const guarded = new Set(
					Arr.flatMap(installation.manifest.objects, (o) =>
						o.kind === "isolationTrigger" ? [o.ident] : []
					)
				)
				for (const certified of served.certification) {
					const reasons =
						certified.certificate.level === "serializable"
							? reasonsOf(certified.certificate.why)
							: []
					for (const reason of reasons) {
						if (reason.at.kind !== "role") {
							assert.ok(
								!Str.startsWith("?")(reason.at.relation),
								`role ${certified.role}: ${reason.at.relation} is an object the installed names resolve`
							)
						}
					}
					if (certified.certificate.level === "readCommitted") {
						notes.note("a role certified READ COMMITTED")
					} else if (Arr.some(reasons, (r) => r.condition === "members")) {
						notes.note("a role with no change member")
					} else {
						notes.note("a role certified SERIALIZABLE for its own statements")
					}
					const servedRoles = defined(
						servedLogins.get(certified.login),
						`the served login ${certified.login}`
					).roles
					assert.equal(
						defined(
							Rec.get(servedRoles, certified.role).pipe(Option.getOrUndefined),
							`the served role ${certified.role}`
						).isolation,
						certified.certificate.level,
						`role ${certified.role}: its served login reads its certificate's level`
					)
					const installed = Option.getOrUndefined(
						Arr.findFirst(
							draft.installation.certification,
							(i) => i.login === certified.login && i.role === certified.role
						)
					)
					assert.equal(
						defined(installed, `the installation's level of ${certified.role}`).certificate.level,
						certified.certificate.level,
						`role ${certified.role}: the installation holds its certificate's level`
					)
					if (certified.certificate.level === "readCommitted") {
						const checked = defined(
							Arr.findFirst(
								Arr.flatMap(installation.logins, (l) =>
									l.login.name === certified.login ? l.roles : []
								),
								(r) => r.checked.world.role.name === certified.role
							).pipe(Option.getOrUndefined),
							`the installed role ${certified.role}`
						)
						for (const [relation, held] of grantedPrivileges(installation.laws, checked.checked)) {
							if (held.has("INSERT")) {
								assert.ok(
									!guarded.has(
										isolationTrigger(
											installation.names.schema,
											installation.names.relation(relation)
										).ident
									),
									`role ${certified.role} runs READ COMMITTED and ${relation}, which it inserts, has no guard`
								)
							}
						}
					}
				}
				const snapshot = jsonOf(
					succeeded(writeRuntimeSnapshot(draft.snapshot, draft.derived), "snapshot.json")
				)
				for (const [i, l] of compiled.logins.entries()) {
					const planned = defined(entries[i], `the planned file of login ${i}`)
					const alone = yield* snapshotServedEntry(l, snapshot)
					assert.equal(
						joined(alone.text),
						joined(planned.text),
						`login ${planned.login}: its served file from the snapshot alone is generate's`
					)
					if (
						Arr.some(
							served.certification,
							(r) => r.login === planned.login && r.certificate.level === "readCommitted"
						)
					) {
						notes.note("a READ COMMITTED role served from the snapshot alone")
					}
				}
				const logins: ReadonlyArray<AnyLogin> = [app, ...psql]
				for (const l of logins) {
					assert.deepEqual(
						Arr.sort(
							Rec.keys(defined(servedLogins.get(l.name), `the served login ${l.name}`).roles),
							Str.Order
						),
						Arr.sort(Rec.keys(l.roles), Str.Order),
						`login ${l.name}: its served login holds a token for each of its roles`
					)
				}
				assert.deepEqual(
					Arr.sort(
						Arr.map(served.certification, (r) => `${r.login}.${r.role}`),
						Str.Order
					),
					Arr.sort(
						Arr.flatMap(logins, (l) => Arr.map(Rec.keys(l.roles), (r) => `${l.name}.${r}`)),
						Str.Order
					),
					"a certificate for each role of each login"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the certificates the plan holds, against the names grizzle installs and the levels the served files and the installation record"
		},
		budget: { runs: 24, steered: 200 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/cli/served-certified.test.ts#aRolesIsolationLevelIsDecidedOnceFromTheStatementsItsWritesSendEveryNameTheyReachResolvedAndItsServedFileAndTheInstallationHoldItAlike:-:0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0"
				),
				reason:
					"an inserter of Tag beside a direct inserter of Tag, certified READ COMMITTED while Tag kept its guard",
				since: "2026-11-10"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/served/compile.ts",
				original:
					'\t\t\t(role) => defined(levels.get(role), "the certified level of each role of the login"),\n',
				replacement: '\t\t\t() => "serializable",\n',
				why: "The snapshot-only compile compiles every role at SERIALIZABLE whatever its certificate: a READ COMMITTED role's served file from the snapshot is no longer generate's, its writes compiled at another level than production runs them."
			},
			{
				file: "packages/engine/src/program/workload/roles.ts",
				original: "\t\tif (levelSchema(state.schema, role, loc).ok) {",
				replacement:
					'\t\tif (state.schema.kind === "role" ? state.schema.value === role.value : levelSchema(state.schema, role, loc).ok) {',
				why: "programsOn reads a role value again to tell a workload's role from the login's, where a parsed role holds none (program/input.ts ParsedRole): the writer's workload runs on the reader too, whose inserts its role refuses, and the draft is refused."
			},
			{
				file: "packages/grizzle/src/adapter/served/served.ts",
				original: "\t\troles[role.name] = servedRole(read.base, name, role.name, role.isolation)",
				replacement:
					'\t\troles[role.name] = servedRole(read.base, name, role.name, "serializable")',
				why: "served gives every role token `serializable`; the levels' property fails."
			},
			{
				file: "packages/grizzle/src/adapter/served/served.ts",
				original: "\t\troles[role.name] = servedRole(read.base, name, role.name, role.isolation)",
				replacement:
					"\t\troles[role.name] = servedRole(read.base, name, role.name, (read.roles[0] ?? role).isolation)",
				why: "served gives every role token its login's first role's level; the levels' property fails."
			},
			{
				file: "packages/grizzle/src/cli/config.ts",
				original: "\tconst unknown = Arr.findFirst(Rec.keys(value), (k) => !allowed.includes(k))",
				replacement: "\tconst unknown = Arr.findFirst(Rec.keys(value), (k) => true)",
				why: "Operator mutant (boolean-return) at packages/grizzle/src/cli/config.ts:146 in onlyKeys: `!allowed.includes(k)` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		],
		show: showCase
	})
