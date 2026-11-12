/**
 * An installation's live plan is exactly what its served reads route by: the snapshot generate drafts records as `live`
 * every stored relation some served read's footprint holds, with every field some read routes it by, and every
 * materialized derived relation one reads, and nothing else, and none where no served member reads, so the change
 * source an installation installs from it signals every change a served read routes and none no read routes.
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level holding a
 * materialized view, and live logins drawn over them (test/support/served-login.ts liveLoginGen), whose first role reads
 * that view and through its query entry, each configured and drafted as `grizzle generate` drafts it (cli/generate.ts
 * draftSchema, then servedFiles): the union of the served files' read footprints, each installed table, view and column
 * named back as the drafted snapshot's theory names it (its relation's ident, its field's column), is the drafted
 * snapshot's live plan, and snapshot.json writes that plan.
 *
 * The oracle is the served files themselves: the routes a running layer reads, never program/workload/compile.ts
 * livePlanOf.
 *
 * Plants (~/.cache/grizzle-release/LIVE-ROUTES/plants): live-route-dropped.patch leaves each table's first routed
 * field out of the live plan; live-views-dropped.patch leaves every materialized derived relation out of it.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import { isRecord } from "#compiler/core/record.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { LivePlan } from "#compiler/live/notify.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	type DrawnSchema,
	drawnLogin,
	drawnSchema,
	liveLoginGen,
	type RoleShape
} from "#test/support/served-login.ts"

type Feature =
	| "a footprint table routed by a field"
	| "a footprint table read table-wide"
	| "a materialized view a read reads"
	| "a relation two reads read"

const file = `${repoRoot}app/grizzle.config.ts`

/**
 * What an installed identifier of a drafted snapshot names: a stored relation's table, with each column's field, or a
 * materialized derived relation's view.
 */
type Installed =
	| {
			readonly kind: "table"
			readonly relation: string
			readonly fields: ReadonlyMap<string, string>
	  }
	| { readonly kind: "view"; readonly relation: string }

/** Each installed table and view of a drafted snapshot, by its identifier, as its theory names it. */
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
									kind: "table",
									relation,
									fields: new Map(Arr.map(r.fields, (f) => [f.column, f.name] as const))
								}
							]
						]
					case "derived":
						return [[r.ident, { kind: "view", relation }]]
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
	const views = new Set<string>()
	const reads = new Map<string, number>()
	for (const footprint of footprints) {
		for (const [ident, routes] of Rec.toEntries(footprint)) {
			const named = defined(installed.get(ident), `the installed relation ${ident}`)
			reads.set(named.relation, (reads.get(named.relation) ?? 0) + 1)
			if (named.kind === "view") {
				views.add(named.relation)
				note("a materialized view a read reads")
				continue
			}
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
		})),
		views: Arr.sort([...views], Order.String)
	}
}

const liveIsTheUnion = (
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
					schemas: [drawnSchemaCase.laws.schema],
					logins: [drawnLogin(drawnSchemaCase, shapes)],
					migrations: "migrations",
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
				noDeclarations
			)
		)
		if (Answered.isFailure(draft)) {
			return
		}
		const { snapshot, snapshotFiles, served } = draft.success
		const entries = yield* Effect.result(servedFiles(compiled, snapshotFiles, served))
		if (Answered.isFailure(entries)) {
			return
		}
		const footprints = Arr.flatMap(entries.success, (entry) =>
			Arr.flatMap(servedFile(trustedJson<unknown>(entry.text)).roles, (role) =>
				Arr.flatMap(role.members, (member) => {
					switch (member.kind) {
						case "read":
						case "paged":
						case "key":
							return [member.read.footprint]
						case "change":
						case "refresh":
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
		const written = trustedJson<unknown>(snapshotFiles.snapshot)
		assert.deepEqual(
			isRecord(written) ? written["live"] : undefined,
			union,
			`snapshot.json writes the live plan\n${printed()}`
		)
	})

layer(NodeServices.layer, { excludeTestServices: true })("an installation's live plan", (it) => {
	it.effect("is exactly the union of what its served reads route by", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cli/served-live",
					draw: drawn((source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const),
					literal: Formatter.format,
					oracle: {
						kind: "second-implementation",
						name: "the union of the served files' read footprints, named back by the drafted snapshot's theory"
					},
					coverage: required<Feature>(
						[
							"a footprint table routed by a field",
							"a footprint table read table-wide",
							"a materialized view a read reads",
							"a relation two reads read"
						],
						{ cases: 24, sense: notesOnly }
					),
					kept: [],
					runs: 16,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 4,
					caseHang
				},
				([sketch, level], notes) =>
					Effect.suspend(() => {
						const schema = drawnSchema(notes.draw(resolveCase(sketch)), level)
						return liveIsTheUnion(schema, level, notes.draw(liveLoginGen(schema)), notes.note)
					})
			)
		)
	)
})
