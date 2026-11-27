/** What the properties of certification.test.ts read: its spaces, models and helpers. */

import { boolean, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload, workloadState } from "#compiler/program/workload/value.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { silentPhases } from "#compiler/core/phase.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyLogin,
	type AnySchema,
	login,
	role,
	wholeEntriesOf,
	wholeWritesOf
} from "#compiler/public/schema.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { sittingShape } from "#test/pg/isolation/support/shapes.ts"
import { repoRoot } from "#test/support/files.ts"
import { platformAt } from "#test/support/fixtures/api/platform.ts"
import { Id } from "#test/support/ids.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/** The fixtures: the sitting shape with its learner's members and the importer's extension or not, and the platform. */
type Fixture =
	| { readonly kind: "sitting"; readonly members: "start" | "named"; readonly extended: boolean }
	| { readonly kind: "platform" }

/** The reads the sitting shape is given, each over a role of it. */
const sittingReads = [
	"docByNode",
	"poolsOfDoc",
	"sittingsOfDoc",
	"servedOfSitting",
	"docs"
] as const

type SittingRead = (typeof sittingReads)[number]

/** The relation each sitting read matches, its one footprint table. */
export const sittingFootprint: {
	readonly [R in SittingRead]: keyof ReturnType<typeof sittingShape>["schema"]["relations"]
} = {
	docByNode: "Doc",
	poolsOfDoc: "Pool",
	sittingsOfDoc: "Sitting",
	servedOfSitting: "Served",
	docs: "Doc"
}

/**
 * A case: its fixture, and for the sitting shape the reads its reader is given. The platform's reads kept are drawn
 * where the case runs, among the reads its billing workload holds.
 */
interface Case {
	readonly fixture: Fixture
	readonly sitting: ReadonlyArray<SittingRead>
}

export const caseGen: Gen<Case> = (source) => {
	const fixture: Fixture = source.draw(boolean)
		? { kind: "platform" }
		: {
				kind: "sitting",
				members: source.draw(boolean) ? "start" : "named",
				extended: source.draw(boolean)
			}
	return {
		fixture,
		sitting: source.draw(subset(sittingReads, { min: 0, max: sittingReads.length }))
	}
}

export type Feature =
	| "the sitting shape"
	| "the platform"
	| "a role certified READ COMMITTED"
	| "a role certified SERIALIZABLE"
	| "a live table a READ COMMITTED role writes"
	| "no read kept"
	| "a read kept"

/** The program kinds a workload holds that read: the tables of each one's footprint are live tables. */
const readKinds: ReadonlySet<string> = new Set(["query", "ordered", "paged", "key"])

/** The names of `w`'s programs that read, in its record's order. */
const readsOf = (w: AnyWorkload): ReadonlyArray<string> =>
	Arr.flatMap(defined(workloadState(w), "a workload workload(...) built").programs, (p) =>
		readKinds.has(p.kind) ? [p.name] : []
	)

/** A sitting read over `reader`, which holds the sitting shape's four relations whole. */
const sittingRead = (reader: SittingReader, read: SittingRead): unknown => {
	const { Doc, Pool, Sitting, Served } = reader.relations
	switch (read) {
		case "docByNode":
			return query(reader).rule((r) => {
				const { n } = v(Doc, "doc")
				return r.match(Doc, { node: r.param("node", Id), n }).find({ n })
			})
		case "poolsOfDoc":
			return query(reader).rule((r) => {
				const { pool, size } = v(Pool, "pool")
				return r.match(Pool, { doc: r.param("doc", Id), pool, size }).find({ pool, size })
			})
		case "sittingsOfDoc":
			return query(reader).rule((r) => {
				const { id, child } = v(Sitting, "sitting")
				return r.match(Sitting, { id, doc: r.param("doc", Id), child }).find({ id, child })
			})
		case "servedOfSitting":
			return query(reader).rule((r) => {
				const { pool, size } = v(Served, "served")
				return r.match(Served, { sitting: r.param("sitting", Id), pool, size }).find({ pool, size })
			})
		case "docs":
			return query(reader).rule((r) => {
				const { node, n } = v(Doc, "doc")
				return r.match(Doc, { node, n }).find({ node, n })
			})
	}
}

/** The sitting shape's reader: every relation of the shape whole, writing nothing. */
const sittingReader = (shape: ReturnType<typeof sittingShape>) =>
	role(shape.schema, "reader", wholeEntriesOf(shape.schema))

type SittingReader = ReturnType<typeof sittingReader>

/**
 * The schema and the logins of a case, each built afresh, its reads kept as `withReads` says, and the names of every
 * read it kept. The sitting shape keeps its login as it is, beside a login of its reader whose workload holds the
 * case's reads, or which serves nothing; the platform's billing role is built again over the same schema, its login's
 * workload holding the billing workload's writes and the reads kept.
 */
const logins = (
	c: Case,
	platformReads: ReadonlyArray<string>,
	withReads: boolean
): {
	readonly schema: AnySchema
	readonly logins: ReadonlyArray<AnyLogin>
	readonly kept: ReadonlyArray<string>
} => {
	if (c.fixture.kind === "platform") {
		const fixture = platformAt("Platform")
		const billing = defined(fixture.server.workload[0], "the billing workload")
		const reads = readsOf(billing)
		const kept = new Set(withReads ? platformReads : [])
		const programs = Rec.filter(
			billing.programs,
			(_, name) => !reads.includes(name) || kept.has(name)
		)
		const again = role(fixture.Billing, "billing", wholeEntriesOf(fixture.Billing), {
			...wholeWritesOf(fixture.Billing)
		})
		return {
			schema: fixture.Billing,
			logins: [
				login(fixture.Billing, "server", [again], { workload: [workload(again, programs)] })
			],
			kept: withReads ? [...kept] : []
		}
	}
	const shape = sittingShape("Qti", c.fixture.members, c.fixture.extended)
	const reader = sittingReader(shape)
	const given = withReads ? c.sitting : []
	const programs = Rec.fromEntries(
		Arr.map(given, (read) => [read, sittingRead(reader, read)] as const)
	)
	return {
		schema: shape.schema,
		logins: [
			shape.login,
			Rec.isEmptyRecord(programs)
				? login(shape.schema, "watcher", [reader])
				: login(shape.schema, "watcher", [reader], { workload: [workload(reader, programs)] })
		],
		kept: given
	}
}

/** The reads of the platform's billing workload, by name, in its record's order. */
export const platformBillingReads = readsOf(
	defined(platformAt("Platform").server.workload[0], "the billing workload")
)

const configFile = `${repoRoot}app/grizzle.config.ts`

/** The draft `grizzle generate` makes of a case's schema and logins from the empty snapshot. */
export const draftOf = (c: Case, platformReads: ReadonlyArray<string>, withReads: boolean) =>
	Effect.gen(function* () {
		const built = logins(c, platformReads, withReads)
		const config = yield* resolveConfig(
			defineConfig({
				contracts: [],
				schemas: [built.schema],
				logins: built.logins,
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => offlineOwner
			}),
			configFile
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
		return {
			certification: served.certification,
			kept: built.kept,
			live: new Set(
				draft.snapshot.live.kind === "none"
					? []
					: Arr.map(draft.snapshot.live.tables, (table) => table.relation)
			),
			writes: new Map(
				Arr.flatMap(built.logins, (l) =>
					Arr.map(
						Rec.values(l.roles),
						(r) => [r.role.name, [...r.role.insert, ...r.role.write]] as const
					)
				)
			)
		}
	})
