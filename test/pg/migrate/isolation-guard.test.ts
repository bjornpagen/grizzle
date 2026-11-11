/**
 * A table's isolation guard, migrated as its writers' certified levels change. A table takes the guard trigger
 * (physical/ddl/isolation.ts addIsolationTrigger) unless every role that writes it is certified READ COMMITTED and holds
 * only INSERT there (readCommittedRelations); generate certifies each role once from the statements its writes send
 * (program/isolation/certification.ts), and the installation's guards follow its certificates. A migration between two
 * versions whose certificates differ must create or drop the guard exactly as a fresh install of the target holds it,
 * or a READ COMMITTED writer's every write is refused by a guard left behind, or a SERIALIZABLE one runs unguarded.
 *
 * A case draws three versions of one schema of two relations, Post and Tag, keyed by id, and one login over it with
 * two roles. The writer writes a drawn nonempty set of them, under `insert` or `write`, and its workload inserts a
 * drawn subset of those, each row supplied by the call; the other role writes a drawn set of them under `write`, with no
 * change member, so it runs SERIALIZABLE, and a relation it writes stays guarded whoever else writes it. Post may be
 * renamed to Note at the second or the third version, so a guard is dropped or created on a table its migration
 * renames. Each version is drafted by generate's own draft (cli/generate.ts draftSchema), its roles certified in the
 * draft's workload plan, from the snapshot the one before reached, and applied by the real runner, the drift check and
 * the installed-catalog checker admitting every apply; or the last two together, as one apply of two pending folders.
 *
 * The oracle is the guard's rule restated over the case: a relation is guarded unless some role writes it and every
 * role that writes it is certified READ COMMITTED (the draft's certificates) and writes it by `insert`. After every
 * apply:
 *
 * - the migrated catalog is a fresh install's of the version (sameCatalog), the guard triggers included;
 * - a READ COMMITTED write of each table, an INSERT of no row, which fires its statement trigger, is refused with 25000
 *   exactly where the rule guards its relation, and otherwise admitted.
 *
 * Features: a guard dropped and one created on a migration, each on a table it renames, a guard flipped within two
 * pending folders, and a READ COMMITTED write admitted and one refused by its guard, each pending one constructed.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): isolation-guard-kept (a migration never drops a table's isolation guard
 * while the table stands).
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, subarray, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Record as Rec } from "effect"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import {
	type Aim,
	aimedAt,
	apply,
	checkedAdmission,
	openMigrator,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { repoRoot } from "#test/support/files.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { draftedAt, noDeclarations } from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { attemptChecked } from "#test/support/substrate.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const tables = ["post", "tag"] as const
type Table = (typeof tables)[number]

type Mode = "insert" | "write"

/** A version's roles: the writer's mode and the relations it writes and inserts, and the other role's writes. */
interface Version {
	readonly mode: Mode
	readonly writes: Arr.NonEmptyReadonlyArray<Table>
	readonly inserts: ReadonlyArray<Table>
	readonly other: ReadonlyArray<Table>
}

interface GuardCase {
	readonly versions: readonly [Version, Version, Version]
	/** The version Post is renamed to Note at, if any. */
	readonly renamedAt: 1 | 2 | "never"
	readonly applied: "each alone" | "the last two together"
}

/** A nonempty subset of `values`: one drawn, and any others beside it, in the order `values` holds them. */
const nonEmptySubset =
	<A>(values: Arr.NonEmptyReadonlyArray<A>): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(s) => {
		const first = s.draw(element(values))
		const rest = s.draw(subarray(values))
		return [first, ...Arr.filter(rest, (v) => v !== first)]
	}

const versionGen: Gen<Version> = (s) => {
	const writes = s.draw(nonEmptySubset(tables))
	return {
		mode: s.draw(element<Mode>(["insert", "write"])),
		writes,
		inserts: s.draw(subarray(writes)),
		other: s.draw(
			weighted<ReadonlyArray<(typeof tables)[number]>>([
				[2, constant([])],
				[1, subarray(tables)]
			])
		)
	}
}

const caseGen: Gen<GuardCase> = (s) => ({
	versions: [s.draw(versionGen), s.draw(versionGen), s.draw(versionGen)],
	renamedAt: s.draw(element<GuardCase["renamedAt"]>([1, 2, "never"])),
	applied: s.draw(element<GuardCase["applied"]>(["each alone", "the last two together"]))
})

/** Post's name at `step`: Note from the version it is renamed at. */
const postName = (c: GuardCase, step: number): "Post" | "Note" =>
	c.renamedAt !== "never" && step >= c.renamedAt ? "Note" : "Post"

const nameAt = (c: GuardCase, step: number, table: Table): string =>
	table === "post" ? postName(c, step) : "Tag"

const Post = relation("Post", { id: pg.integer }, ["id"])
const Note = relation("Note", { id: pg.integer }, ["id"])
const Tag = relation("Tag", { id: pg.integer }, ["id"])

const file = `${repoRoot}app/grizzle.config.ts`

/** The configuration of `version` under `name`, Post named Post. */
const withPost = (name: string, version: Version) => {
	const S = schema(name, [Post, Tag], [])
	const names = Arr.map(version.writes, (t) => (t === "post" ? "Post" : "Tag"))
	const writer = role(
		S,
		"writer",
		wholeEntriesOf(S),
		version.mode === "insert" ? { insert: names } : { write: names }
	)
	const other = role(S, "other", wholeEntriesOf(S), {
		write: Arr.map(version.other, (t) => (t === "post" ? "Post" : "Tag"))
	})
	const programs = Rec.fromEntries(
		Arr.map(
			version.inserts,
			(t) => [`add_${t}`, ChangeSet.empty(writer).insert(t === "post" ? Post : Tag, [])] as const
		)
	)
	return defineConfig({
		schemas: [S],
		logins: [
			login(S, "app", [writer, other], {
				workload: Arr.isReadonlyArrayNonEmpty(version.inserts) ? [workload(writer, programs)] : []
			})
		],
		migrations: "migrations",
		connection: () => offlineOwner
	})
}

/** The configuration of `version` under `name`, Post renamed to Note. */
const withNote = (name: string, version: Version) => {
	const S = schema(name, [Note, Tag], [])
	const names = Arr.map(version.writes, (t) => (t === "post" ? "Note" : "Tag"))
	const writer = role(
		S,
		"writer",
		wholeEntriesOf(S),
		version.mode === "insert" ? { insert: names } : { write: names }
	)
	const other = role(S, "other", wholeEntriesOf(S), {
		write: Arr.map(version.other, (t) => (t === "post" ? "Note" : "Tag"))
	})
	const programs = Rec.fromEntries(
		Arr.map(
			version.inserts,
			(t) => [`add_${t}`, ChangeSet.empty(writer).insert(t === "post" ? Note : Tag, [])] as const
		)
	)
	return defineConfig({
		schemas: [S],
		logins: [
			login(S, "app", [writer, other], {
				workload: Arr.isReadonlyArrayNonEmpty(version.inserts) ? [workload(writer, programs)] : []
			})
		],
		migrations: "migrations",
		connection: () => offlineOwner
	})
}

/** What a step declares: the rename of Post to Note at the version that takes it. */
const declaredAt = (c: GuardCase, step: number): Declarations =>
	step > 0 && postName(c, step) !== postName(c, step - 1)
		? {
				renames: [
					{
						from: { kind: "relation", relation: parsedName(postName(c, step - 1)) },
						to: { kind: "relation", relation: parsedName(postName(c, step)) }
					}
				],
				drops: []
			}
		: noDeclarations

/**
 * The version at `step` under `name`, drafted as generate drafts it from `previous`, the empty snapshot when there is
 * none: the draft's folder, snapshot and installation, and each role's certified level.
 */
const draftedVersion = (
	c: GuardCase,
	step: number,
	name: string,
	previous: Option.Option<DeploySnapshot>,
	declared: Declarations
) =>
	Effect.gen(function* () {
		const version = c.versions[step]
		assert.ok(version !== undefined, `the case holds version ${step}`)
		const config = postName(c, step) === "Post" ? withPost(name, version) : withNote(name, version)
		const resolved = yield* resolveConfig(config, file)
		const configured = defined(resolved.schemas[0], "the configured schema")
		const compiled = yield* Effect.fromResult(compileSchema(configured))
		const draft = yield* draftSchema(
			compiled,
			Option.getOrElse(previous, () =>
				emptySnapshot({ schemaName: configured.declared, schema: configured.ident })
			),
			[],
			declared
		)
		assert.ok(draft.served.kind === "logins", "a schema with a login plans its logins")
		const levels = new Map<string, Isolation>(
			Arr.map(draft.served.certification, (r) => [r.role, r.certificate.level] as const)
		)
		return { draft, levels }
	})

/** The level of `roleName` the draft certified; a role the draft did not certify is a defect of the case. */
const levelOf = (levels: ReadonlyMap<string, Isolation>, roleName: string): Isolation =>
	defined(levels.get(roleName), `the certified level of role ${roleName}`)

/**
 * The rule: `table` is guarded unless some role writes it and every role that writes it is certified READ COMMITTED
 * and writes it by `insert`.
 */
const guarded = (
	version: Version,
	levels: ReadonlyMap<string, Isolation>,
	table: Table
): boolean => {
	const writers = [
		...(version.writes.includes(table)
			? [{ level: levelOf(levels, "writer"), mode: version.mode }]
			: []),
		...(version.other.includes(table)
			? [{ level: levelOf(levels, "other"), mode: "write" satisfies Mode }]
			: [])
	]
	return (
		writers.length === 0 ||
		Arr.some(writers, (w) => w.level !== "readCommitted" || w.mode !== "insert")
	)
}

type Feature =
	| "a guard dropped on a migration, every writer of its table certified READ COMMITTED"
	| "a guard created on a migration, a writer of its table SERIALIZABLE"
	| "a guard dropped on a table its migration renames"
	| "a guard created on a table its migration renames"
	| "a guard flipped within two pending folders applied together"
	| "a READ COMMITTED write admitted after a migration"
	| "a READ COMMITTED write refused by its table's guard after a migration"

const walk = (c: GuardCase, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: "guard" })
		const schemaIdent = identifierOf(identity.schema(parsedSchemaName(name)))
		const tableOf = (relationName: string) =>
			`${quoteIdent(schemaIdent)}.${quoteIdent(identifierOf(identity.table(parsedName(relationName))))}`
		const session = yield* substrate.session({ ...ownerSession(), label: "owner guard" })
		const ownerLogin = yield* ambientOwner(ordinarySession, [schemaIdent])
		const migrator = yield* openMigrator(substrate, ownerLogin.credentials)
		const folders: Array<FolderSource> = []
		const guards: Array<ReadonlyMap<Table, boolean>> = []
		let previous: Option.Option<DeploySnapshot> = Option.none()
		let appliedGuards: ReadonlyMap<Table, boolean> | undefined
		for (const [step, version] of c.versions.entries()) {
			const { draft, levels } = yield* draftedVersion(c, step, name, previous, declaredAt(c, step))
			folders.push({
				name: `${draftedAt(step + 1)}_step_${step + 1}`,
				metaText: draft.folder.metaText,
				files: draft.folder.files
			})
			previous = Option.some(draft.snapshot)
			const guard = new Map(Arr.map(tables, (t) => [t, guarded(version, levels, t)] as const))
			guards.push(guard)
			if (step === 1 && c.applied === "the last two together") {
				continue
			}
			const outcome = yield* Effect.result(
				apply(
					migrator,
					{ snapshot: draft.snapshot, folders: [...folders] },
					checkedAdmission(draft.installation, substrate.admin)
				)
			)
			if (outcome._tag === "Failure") {
				return assert.fail(
					`step ${step + 1} failed: ${outcome.failure.message}\n${Formatter.format(outcome.failure.reason._tag === "Drifted" ? outcome.failure.reason.mismatches : outcome.failure.reason)}\n${Formatter.format(c)}`
				)
			}
			if (appliedGuards !== undefined) {
				const before = appliedGuards
				const renamed = step > 0 && postName(c, step) !== postName(c, step - 1)
				for (const t of tables) {
					const was = defined(before.get(t), `the guard of ${t} before`)
					const now = defined(guard.get(t), `the guard of ${t}`)
					if (was && !now) {
						note(
							renamed && t === "post"
								? "a guard dropped on a table its migration renames"
								: "a guard dropped on a migration, every writer of its table certified READ COMMITTED"
						)
					}
					if (!was && now) {
						note(
							renamed && t === "post"
								? "a guard created on a table its migration renames"
								: "a guard created on a migration, a writer of its table SERIALIZABLE"
						)
					}
				}
				if (step === 2 && c.applied === "the last two together") {
					const middle = defined(guards[1], "the second version's guards")
					if (Arr.some(tables, (t) => middle.get(t) !== before.get(t))) {
						note("a guard flipped within two pending folders applied together")
					}
				}
			}
			appliedGuards = guard
			yield* Effect.scoped(
				Effect.gen(function* () {
					const freshName = yield* substrate.schema({ create: false, label: "guard_fresh" })
					const fresh = yield* draftedVersion(c, step, freshName, Option.none(), noDeclarations)
					yield* transaction(
						substrate.admin,
						installationSql(fresh.draft.installation, substrate.database)
					)
					yield* sameCatalog(
						draft.installation,
						fresh.draft.installation,
						`step ${step + 1} migrated against a fresh install`
					)
				})
			)
			for (const t of tables) {
				const target = tableOf(nameAt(c, step, t))
				const written = yield* attemptChecked(
					session,
					[
						"SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
						`INSERT INTO ${target} SELECT * FROM ${target} WHERE false`
					],
					Effect.void
				)
				if (written.kind === "refused" && written.fields.code !== "25000") {
					return assert.fail(
						`step ${step + 1}: a READ COMMITTED write of ${nameAt(c, step, t)} is refused with ${written.fields.code}, not the guard's 25000\n${Formatter.format(c)}`
					)
				}
				const refused = written.kind === "refused"
				const expected = defined(guard.get(t), `the guard of ${t}`)
				assert.equal(
					refused,
					expected,
					`step ${step + 1}: a READ COMMITTED write of ${nameAt(c, step, t)} is ${refused ? "refused" : "admitted"}, where its rule ${expected ? "guards" : "admits"} it\n${Formatter.format(c)}`
				)
				note(
					refused
						? "a READ COMMITTED write refused by its table's guard after a migration"
						: "a READ COMMITTED write admitted after a migration"
				)
			}
		}
	})

/** A version whose writer is certified READ COMMITTED on `table` alone: it inserts it, and no other role writes it. */
const certifiedOn = (table: Table): Version => ({
	mode: "insert",
	writes: [table],
	inserts: [table],
	other: []
})

/** A version whose writer writes `table` by `write`, holding DELETE there, so the table is guarded. */
const serialOn = (table: Table): Version => ({
	mode: "write",
	writes: [table],
	inserts: [table],
	other: []
})

const aims: ReadonlyArray<Aim<GuardCase, Feature>> = [
	[
		"a guard dropped on a migration, every writer of its table certified READ COMMITTED",
		(s) => ({
			versions: [serialOn("tag"), certifiedOn("tag"), s.draw(versionGen)],
			renamedAt: "never",
			applied: "each alone"
		})
	],
	[
		"a guard created on a migration, a writer of its table SERIALIZABLE",
		(s) => ({
			versions: [certifiedOn("tag"), serialOn("tag"), s.draw(versionGen)],
			renamedAt: "never",
			applied: "each alone"
		})
	],
	[
		"a guard dropped on a table its migration renames",
		(s) => ({
			versions: [serialOn("post"), certifiedOn("post"), s.draw(versionGen)],
			renamedAt: 1,
			applied: "each alone"
		})
	],
	[
		"a guard created on a table its migration renames",
		(s) => ({
			versions: [certifiedOn("post"), serialOn("post"), s.draw(versionGen)],
			renamedAt: 1,
			applied: "each alone"
		})
	],
	[
		"a guard flipped within two pending folders applied together",
		(s) => ({
			versions: [serialOn("tag"), certifiedOn("tag"), serialOn("tag")],
			renamedAt: s.draw(element<GuardCase["renamedAt"]>([1, 2, "never"])),
			applied: "the last two together"
		})
	]
]

/** The case a search runs: its drawn one, or, while a situation `aims` reaches is pending, the one aimed at it. */
const aimed = aimedAt(aims)

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"a table's isolation guard, migrated as its writers' certified levels change",
	(it) => {
		it.effect(
			"a migration creates or drops each guard exactly as a fresh install of its target holds it, and a READ COMMITTED write is refused exactly where a guard stands",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "migrate/isolation-guard",
							draw: drawn(caseGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the guard's rule restated over the case: a relation is guarded unless some role writes it and every role that writes it is certified READ COMMITTED and writes it by insert"
							},
							coverage: required<Feature>(
								[
									"a guard dropped on a migration, every writer of its table certified READ COMMITTED",
									"a guard created on a migration, a writer of its table SERIALIZABLE",
									"a guard dropped on a table its migration renames",
									"a guard created on a table its migration renames",
									"a guard flipped within two pending folders applied together",
									"a READ COMMITTED write admitted after a migration",
									"a READ COMMITTED write refused by its table's guard after a migration"
								],
								{ cases: 40, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: { kind: "bounded", candidates: 20 },
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(c, cx) => Effect.scoped(walk(aimed(c, cx), cx.note))
					)
				)
		)
	}
)
