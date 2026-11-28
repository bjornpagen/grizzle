/** What the properties of live-coverage.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { compileServed } from "#adapter/public/compile.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot, writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { repoRoot } from "#test/support/files.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"
import {
	buildWorlds,
	type BuiltRole,
	type BuiltWorlds
} from "#test/support/worlds/execute/build.ts"
import {
	entryFields,
	readProgramOf,
	relationValue,
	rowField,
	type WritingRole
} from "#test/support/worlds/execute/session.ts"
import type { InstallSpec, LoginSpec, RoleSpec } from "#test/support/worlds/model/types.ts"

export type Feature =
	| "a footprint table read table-wide"
	| "a footprint table routed by a field"
	| "a read whose footprint holds two tables"
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

/** What a served file's reads reach: each footprint's tables, their routes, and how many tables one holds. */
const notedReads = (served: ServedFile, note: (feature: Feature) => void): void => {
	for (const role of served.roles) {
		for (const member of role.members) {
			switch (member.kind) {
				case "read":
				case "key":
				case "paged": {
					const live = member.read.live
					if (live.kind === "constant" || live.kind === "answered") {
						break
					}
					if (Rec.keys(live.footprint).length > 1) {
						note("a read whose footprint holds two tables")
					}
					for (const routes of Rec.values(live.footprint)) {
						note(
							Rec.isEmptyRecord(routes)
								? "a footprint table read table-wide"
								: "a footprint table routed by a field"
						)
					}
					break
				}
				case "change":
					break
			}
		}
	}
}

export const coveredWhereMigrated = (install: InstallSpec, c: Case<Feature>) =>
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
					rolePrefixBytes: 0,
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
				noDeclarations,
				silentPhases
			)
		)
		const entries = yield* Effect.result(
			eachServedFile(compiled, draft, draft.served, silentPhases, Effect.succeed)
		)
		if (entries._tag === "Failure") {
			return assert.fail(
				`generate serves every login of an installation migrated with its workloads: ${Formatter.format(entries.failure.reason)}\n${printed}`
			)
		}
		const snapshot = jsonOf(
			succeeded(writeRuntimeSnapshot(draft.snapshot, draft.derived), "snapshot.json")
		)
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
				jsonOf(entry.text),
				`the door's file of ${value.name} is generate's\n${printed}`
			)
			notedReads(succeeded(servedFile(door.success), "the door's served file"), c.note)
		}
	})
