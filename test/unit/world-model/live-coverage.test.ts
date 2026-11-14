/**
 * Every read a login serves is covered by the live source of an installation migrated with that login's workload: only a
 * snapshot of an installation migrated without the login's workload holds an uncovered read (served/forms.ts
 * UncoveredRead), since generate builds the installation's publication from the same workload.
 *
 * Over the worlds suites' installations of the documents bases (drive/suite.ts docsInstalls: the README-shaped ones,
 * and generated ones, half of those named from the kernel dictionary or after PostgreSQL's types), built through the
 * public builders (execute/build.ts buildInstall), each login is given a workload holding, for every relation each of
 * its roles holds, the read the worlds executor serves of it (execute/session.ts readProgramOf) and, where the case
 * draws it, that read with one of its fields fixed to a parameter, so the read routes the relation's table by that
 * field. Each installation is drafted as `grizzle generate` drafts it with those workloads (cli/generate.ts
 * draftSchema, then servedFiles), and each login's file is compiled again over the snapshot.json the draft writes by
 * the test door the worlds executor compiled its reads by (adapter/public/compile.ts compileServed): generate serves
 * every login, and the door compiles each one's own workloads, refused by no UncoveredRead, into the file generate
 * wrote.
 *
 * The oracle is generate's own served file: compileServed with a login's own workloads is the compile generate commits
 * (its JSDoc), so the door's file is generate's, as JSON.
 *
 * Plants (~/.cache/grizzle-release/WORLDSCOVER/plants): live-second-table-dropped.patch leaves out of the live plan every
 * footprint table but the first of each read (program/workload/compile.ts livePlanOf), so a read through a query entry
 * whose filter reads another relation is uncovered; fixture-without-workload.patch drafts each installation with its
 * logins' workloads left out, as the worlds executor's installation was drafted (4be5e75c), so the door compiles the
 * reads under a snapshot with no live source.
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, element } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { compileServed } from "#adapter/public/compile.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { docsInstalls } from "#test/support/worlds/drive/suite.ts"
import {
	type BuiltRole,
	type BuiltWorlds,
	buildWorlds
} from "#test/support/worlds/execute/build.ts"
import {
	entryFields,
	readProgramOf,
	relationValue,
	rowField,
	type WritingRole
} from "#test/support/worlds/execute/session.ts"
import type { InstallSpec, LoginSpec, RoleSpec } from "#test/support/worlds/model/types.ts"

type Feature =
	| "a footprint table read table-wide"
	| "a footprint table routed by a field"
	| "a read whose footprint holds two tables"
	| "a materialized view a read reads"
	| "two logins"

const file = `${repoRoot}app/grizzle.config.ts`

/** The parameter a routed read fixes its field to. */
const routeParam = "routed"

/**
 * A role relation read whole with its field `field` fixed to the parameter `routeParam`, carried by `carrier`: the
 * executor's read of it (readProgramOf), routed by that field.
 */
const routedRead = (
	session: WritingRole,
	relation: string,
	field: string,
	carrier: unknown
): QueryValue => {
	const value = relationValue(session, relation)
	return queryOver(session.value).rule((r: RuleValue): FinishedValue => {
		const vars = varsOver(value, "value")
		return r
			.match(value, vars)
			.where(r.eq(vars[field], r.param(routeParam, carrier)))
			.find(vars)
	})
}

/**
 * The programs of a role's workload, its `place`th among its login's: for every relation it holds, the executor's read of
 * it, and, where the case draws it, that read routed by a field of a domain a parameter carries (session.ts rowField).
 */
const roleProgramsOf = (
	install: InstallSpec,
	built: BuiltWorlds,
	role: RoleSpec,
	place: number,
	c: Case<Feature>
): Effect.Effect<Readonly<Record<string, QueryValue>>> =>
	Effect.gen(function* () {
		const value = defined(built.roles[role.name], `the role ${role.name} as built`)
		const session: WritingRole = { role, value }
		const programs: Record<string, QueryValue> = {}
		for (const [i, relation] of Rec.keys(role.entries).entries()) {
			programs[`r${place}read${i}`] = yield* Effect.orDie(readProgramOf(session, relation))
			const routable = Arr.flatMap(
				Option.getOrElse(entryFields(install.base, role, relation), () => []),
				(f) =>
					Option.match(rowField(f.domain), {
						onNone: () => [],
						onSome: (carrier) => [{ field: f.field, carrier }]
					})
			)
			if (Arr.isReadonlyArrayNonEmpty(routable) && c.draw(boolean)) {
				const routed = c.draw(element(routable))
				programs[`r${place}routed${i}`] = routedRead(
					session,
					relation,
					routed.field,
					routed.carrier
				)
			}
		}
		return programs
	})

/** A login of the installation, its roles as built, with a workload of each role's programs (roleProgramsOf). */
const loginWithReads = (
	install: InstallSpec,
	built: BuiltWorlds,
	spec: LoginSpec,
	c: Case<Feature>
) =>
	Effect.gen(function* () {
		const members = yield* Effect.forEach(spec.roles, (name) =>
			Effect.succeed(defined(built.roles[name], `the role ${name} as built`))
		)
		const workloads = yield* Effect.forEach(members, (value: BuiltRole, place) =>
			Effect.map(
				roleProgramsOf(
					install,
					built,
					defined(
						Arr.findFirst(install.roles, (r) => r.name === value.name).pipe(Option.getOrUndefined),
						`the role ${value.name} of the installation`
					),
					place,
					c
				),
				(programs) => workload(value, programs)
			)
		)
		return login(built.made.base, spec.name, members, { workload: workloads })
	})

/** What a served file's reads reach: each footprint's tables and views, their routes, and how many tables one holds. */
const notedReads = (served: ServedFile, note: (feature: Feature) => void): void => {
	const views = served.live.kind === "source" ? served.live.views : []
	for (const role of served.roles) {
		for (const member of role.members) {
			switch (member.kind) {
				case "read":
				case "key":
				case "paged": {
					const live = member.read.live
					if (live.kind === "constant") {
						break
					}
					const tables = Arr.filter(Rec.keys(live.footprint), (t) => !views.includes(t))
					if (tables.length > 1) {
						note("a read whose footprint holds two tables")
					}
					for (const [table, routes] of Rec.toEntries(live.footprint)) {
						note(
							views.includes(table)
								? "a materialized view a read reads"
								: Rec.isEmptyRecord(routes)
									? "a footprint table read table-wide"
									: "a footprint table routed by a field"
						)
					}
					break
				}
				case "instant":
				case "change":
				case "refresh":
					break
			}
		}
	}
}

const coveredWhereMigrated = (install: InstallSpec, c: Case<Feature>) =>
	Effect.gen(function* () {
		const printed = Formatter.format(install)
		const built = yield* Effect.orDie(buildWorlds(install, install.base.name))
		const logins = yield* Effect.forEach(install.logins, (spec) =>
			loginWithReads(install, built, spec, c)
		)
		if (logins.length > 1) {
			c.note("two logins")
		}
		const config = yield* Effect.orDie(
			resolveConfig(
				defineConfig({
					schemas: [built.made.base],
					logins,
					migrations: "migrations",
					connection: () => offlineOwner
				}),
				file
			)
		)
		const configured = defined(config.schemas[0], "the configured schema")
		const compiled = yield* Effect.orDie(Effect.fromResult(compileSchema(configured)))
		const draft = yield* Effect.orDie(
			draftSchema(
				compiled,
				emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
				[],
				noDeclarations
			)
		)
		const entries = yield* Effect.result(servedFiles(compiled, draft.snapshotFiles, draft.served))
		if (entries._tag === "Failure") {
			return assert.fail(
				`generate serves every login of an installation migrated with its workloads: ${Formatter.format(entries.failure.reason)}\n${printed}`
			)
		}
		const snapshot = trustedJson<unknown>(draft.snapshotFiles.snapshot)
		for (const value of logins) {
			const entry = defined(
				Arr.findFirst(entries.success, (e) => e.login === value.name).pipe(Option.getOrUndefined),
				`generate's served file of ${value.name}`
			)
			const door = yield* Effect.result(compileServed(value, snapshot, value.workload))
			if (door._tag === "Failure") {
				return assert.fail(
					`the door compiles ${value.name}'s own workloads over the snapshot.json of an installation migrated with them: ${Formatter.format(door.failure)}\n${printed}`
				)
			}
			assert.deepEqual(
				door.success,
				trustedJson<unknown>(entry.text),
				`the door's file of ${value.name} is generate's\n${printed}`
			)
			notedReads(succeeded(servedFile(door.success), "the door's served file"), c.note)
		}
	})

layer(NodeServices.layer, { excludeTestServices: true })("a login's served reads", (it) => {
	it.effect(
		"are covered by the live source of an installation migrated with the login's workload",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/world-model/live-coverage",
						draw: drawn(docsInstalls),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "generate's served file of the login, against the test door's compile of its own workloads"
						},
						coverage: required<Feature>(
							[
								"a footprint table read table-wide",
								"a footprint table routed by a field",
								"a read whose footprint holds two tables",
								"a materialized view a read reads",
								"two logins"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 16,
						shrink: { kind: "bounded", candidates: 200 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					coveredWhereMigrated
				)
			)
	)
})
