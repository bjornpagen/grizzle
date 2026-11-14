/**
 * Certification stays put: a role's isolation certificate is decided by its writes alone, so the live source a login's
 * reads install over their footprint tables (the publication and the replica identity its plan asks for) changes no
 * verdict. Over the QTI-shaped learner (the isolation oracle's sitting
 * shape, test/pg/isolation/support/shapes.ts: an importer writing a Doc and its Pools, a learner starting a Sitting by
 * reading the Doc's group, or naming every value of it) and the platform fixture (test/support/fixtures/api/platform.ts,
 * its billing role's served workload), each drafted as `grizzle generate` drafts it from the empty snapshot
 * (cli/generate.ts draftSchema):
 *
 * - every role's certificate, its level and its reasons, under a drawn set of the login's reads, is the one it has
 *   under no read at all, where no table is a live source;
 * - the draft with no read plans no live table (its snapshot's live plan is empty), and the draft with reads plans every
 *   footprint table of its reads, so the two drafts certify over installations that differ by exactly their live
 *   source.
 *
 * The oracle is the certifier's verdict without the live source: the same logins' draft with every read left out, whose
 * workloads hold their writes alone, and whose roles, privileges and writes are the drawn draft's.
 *
 * Reads drawn: for the sitting shape, a drawn set of reads over its four relations (a Doc by its node, a Doc's Pools,
 * a Doc's Sittings, a Sitting's Served rows, every Doc), served to a reader of its own login, which holds every relation
 * whole and writes nothing, and serves nothing in the draft without reads; for the platform, a drawn subset of the
 * billing workload's reads, its billing role and login built again over the same schema.
 *
 * Plant: none of its own; a live table read by the certifier as a trigger-held law's (analysis/isolation/facts.ts), so a
 * role writing a footprint table loses READ COMMITTED, turns it red.
 *
 * Features: each fixture, a role certified READ COMMITTED, a role certified SERIALIZABLE, a live table a READ
 * COMMITTED role writes, no read kept, a read kept.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, type Gen, subset } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload, workloadState } from "#compiler/program/workload/value.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyLogin,
	type AnySchema,
	login,
	role,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { sittingShape } from "#test/pg/isolation/support/shapes.ts"
import { assert, defined } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { platformAt } from "#test/support/fixtures/api/platform.ts"
import { caseHang } from "#test/support/limits.ts"
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

/**
 * A case: its fixture, and for the sitting shape the reads its reader is given. The platform's reads kept are drawn
 * where the case runs, among the reads its billing workload holds.
 */
interface Case {
	readonly fixture: Fixture
	readonly sitting: ReadonlyArray<SittingRead>
}

const caseGen: Gen<Case> = (source) => {
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

type Feature =
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
				return r.match(Doc, { node: r.param("node", uuid), n }).find({ n })
			})
		case "poolsOfDoc":
			return query(reader).rule((r) => {
				const { pool, size } = v(Pool, "pool")
				return r.match(Pool, { doc: r.param("doc", uuid), pool, size }).find({ pool, size })
			})
		case "sittingsOfDoc":
			return query(reader).rule((r) => {
				const { id, child } = v(Sitting, "sitting")
				return r.match(Sitting, { id, doc: r.param("doc", uuid), child }).find({ id, child })
			})
		case "servedOfSitting":
			return query(reader).rule((r) => {
				const { pool, size } = v(Served, "served")
				return r
					.match(Served, { sitting: r.param("sitting", uuid), pool, size })
					.find({ pool, size })
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
			write: writableNamesOf(fixture.Billing),
			refresh: ["DailySpend"]
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
const platformBillingReads = readsOf(
	defined(platformAt("Platform").server.workload[0], "the billing workload")
)

const configFile = `${repoRoot}app/grizzle.config.ts`

/** The draft `grizzle generate` makes of a case's schema and logins from the empty snapshot. */
const draftOf = (c: Case, platformReads: ReadonlyArray<string>, withReads: boolean) =>
	Effect.gen(function* () {
		const built = logins(c, platformReads, withReads)
		const config = yield* resolveConfig(
			defineConfig({
				schemas: [built.schema],
				logins: built.logins,
				migrations: "migrations",
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
			noDeclarations
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
					Arr.map(Rec.values(l.roles), (r) => [r.role.name, r.role.write] as const)
				)
			)
		}
	})

layer(NodeServices.layer, { excludeTestServices: true })("a role's certificate", (it) => {
	it.effect(
		"is the same with the live source of any reads as with none, for the QTI-shaped learner and the platform",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/live/certification",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the certifier's verdict over the same logins' draft with no read, which holds no live source"
						},
						coverage: required<Feature>(
							[
								"the sitting shape",
								"the platform",
								"a role certified READ COMMITTED",
								"a role certified SERIALIZABLE",
								"a live table a READ COMMITTED role writes",
								"no read kept",
								"a read kept"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 12,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							notes.note(c.fixture.kind === "platform" ? "the platform" : "the sitting shape")
							const platformReads = notes.draw(
								subset(platformBillingReads, { min: 0, max: platformBillingReads.length })
							)
							const withTriggers = yield* draftOf(c, platformReads, true)
							const without = yield* draftOf(c, platformReads, false)
							notes.note(
								Arr.isReadonlyArrayNonEmpty(withTriggers.kept) ? "a read kept" : "no read kept"
							)
							assert.deepEqual(
								withTriggers.certification,
								without.certification,
								`every role certifies as it does with no live source\n${Formatter.format(c)}`
							)
							assert.deepEqual([...without.live], [], "a draft with no read plans no live table")
							for (const certified of withTriggers.certification) {
								if (certified.certificate.level === "readCommitted") {
									notes.note("a role certified READ COMMITTED")
									const writes = withTriggers.writes.get(certified.role) ?? []
									if (Arr.some(writes, (relation) => withTriggers.live.has(relation))) {
										notes.note("a live table a READ COMMITTED role writes")
									}
								} else {
									notes.note("a role certified SERIALIZABLE")
								}
							}
						})
				)
			)
	)
})
