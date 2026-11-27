/** What the properties of served-live.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Result as Answered, Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { isRecord } from "#compiler/core/record.ts"
import { emptySnapshot, writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { LivePlan } from "#compiler/live/notify.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { repoRoot } from "#test/support/files.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { type LawLevel } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { drawnLogin, type DrawnSchema, type RoleShape } from "#test/support/served-login.ts"

export type Feature =
	| "a footprint table routed by a field"
	| "a footprint table read table-wide"
	| "a relation two reads read"

const file = `${repoRoot}app/grizzle.config.ts`

/** What an installed identifier of a drafted snapshot names: a stored relation's table, with each column's field. */
interface Installed {
	readonly relation: string
	readonly fields: ReadonlyMap<string, string>
}

/**
 * Each installed table of a drafted snapshot, by its identifier, as its theory names it: an authored relation's. The
 * drawn schemas hold no stored derived relation (the law level's is live, oracle/public/laws.ts), so no derived record
 * names a table a footprint reads.
 */
const installedOf = (snapshot: DeploySnapshot): ReadonlyMap<string, Installed> =>
	new Map(
		Arr.flatMap(
			Rec.toEntries(snapshot.theory.relations),
			([relation, r]): ReadonlyArray<readonly [string, Installed]> => {
				switch (r.kind) {
					case "relation":
						return [
							[
								r.ident,
								{
									relation,
									fields: new Map(Arr.map(r.fields, (f) => [f.column, f.name] as const))
								}
							]
						]
					case "derived":
					case "closed":
						return []
				}
			}
		)
	)

/**
 * The live plan the served files' footprints are the union of (see the header), each name back as declared: none
 * where no served member reads.
 */
const unionOf = (
	footprints: ReadonlyArray<Readonly<Record<string, Readonly<Record<string, string>>>>>,
	installed: ReadonlyMap<string, Installed>,
	note: (feature: Feature) => void
): LivePlan => {
	if (!Arr.isReadonlyArrayNonEmpty(footprints)) {
		return { kind: "none" }
	}
	const tables = new Map<string, Set<string>>()
	const reads = new Map<string, number>()
	for (const footprint of footprints) {
		for (const [ident, routes] of Rec.toEntries(footprint)) {
			const named = defined(installed.get(ident), `the installed relation ${ident}`)
			reads.set(named.relation, (reads.get(named.relation) ?? 0) + 1)
			const fields = tables.get(named.relation) ?? new Set<string>()
			for (const column of Rec.keys(routes)) {
				fields.add(defined(named.fields.get(column), `the column ${column} of ${named.relation}`))
			}
			tables.set(named.relation, fields)
			note(
				Rec.isEmptyRecord(routes)
					? "a footprint table read table-wide"
					: "a footprint table routed by a field"
			)
		}
	}
	if (Arr.some([...reads.values()], (n) => n > 1)) {
		note("a relation two reads read")
	}
	return {
		kind: "reads",
		tables: Arr.map(Arr.sort([...tables.keys()], Order.String), (relation) => ({
			relation,
			routes: Arr.sort([...(tables.get(relation) ?? [])], Order.String)
		}))
	}
}

export const liveIsTheUnion = (
	drawnSchemaCase: DrawnSchema,
	level: LawLevel,
	shapes: Arr.NonEmptyReadonlyArray<RoleShape>,
	note: (feature: Feature) => void
) =>
	Effect.gen(function* () {
		const printed = () =>
			`${printCase(drawnSchemaCase.case)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
		const config = yield* Effect.result(
			resolveConfig(
				defineConfig({
					contracts: [],
					schemas: [drawnSchemaCase.laws.schema],
					logins: [drawnLogin(drawnSchemaCase, shapes)],
					migrations: "migrations",
					rolePrefixBytes: 0,
					connection: () => offlineOwner
				}),
				file
			)
		)
		if (Answered.isFailure(config)) {
			return
		}
		const configured = defined(config.success.schemas[0], "the configured schema")
		const compiled = Answered.getOrUndefined(compileSchema(configured))
		if (compiled === undefined) {
			return
		}
		const draft = yield* Effect.result(
			draftSchema(
				compiled,
				emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
				[],
				noDeclarations,
				silentPhases
			)
		)
		if (Answered.isFailure(draft)) {
			return
		}
		const { snapshot, served } = draft.success
		const entries = yield* Effect.result(
			eachServedFile(compiled, draft.success, served, silentPhases, Effect.succeed)
		)
		if (Answered.isFailure(entries)) {
			return
		}
		const footprints = Arr.flatMap(entries.success, (entry) =>
			Arr.flatMap(succeeded(servedFile(jsonOf(entry.text)), "the served file").roles, (role) =>
				Arr.flatMap(role.members, (member) => {
					switch (member.kind) {
						case "read":
						case "paged":
						case "key":
							return member.read.live.kind === "routed" ? [member.read.live.footprint] : []
						case "change":
							return []
					}
				})
			)
		)
		const union = unionOf(footprints, installedOf(snapshot), note)
		assert.deepEqual(
			snapshot.live,
			union,
			`the drafted snapshot's live plan is the union of its served reads' footprints\n${printed()}`
		)
		const written = jsonOf(
			succeeded(writeRuntimeSnapshot(snapshot, draft.success.derived), "snapshot.json")
		)
		assert.deepEqual(
			isRecord(written) ? written["live"] : undefined,
			union,
			`snapshot.json writes the live plan\n${printed()}`
		)
	})
