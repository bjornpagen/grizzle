/** What the properties of isolation-guard.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, subarray, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	login,
	mutable,
	relation,
	role,
	schema,
	unit,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import {
	type Aim,
	apply,
	checkedAdmission,
	openMigrator,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { installationSql } from "#test/support/compile.ts"
import { repoRoot } from "#test/support/files.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftedAt, noDeclarations } from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { attemptChecked } from "#test/support/substrate.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const tables = ["post", "tag"] as const

type Table = (typeof tables)[number]

type Mode = "insert" | "write"

/**
 * A version's roles: the writer's mode and the relations it writes and inserts, and the other role's writes. A writer
 * by `write` writes the open Tag alone, where it holds UPDATE and DELETE; a closed relation's writer holds INSERT alone
 * whichever list names it.
 */
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
	const mode = s.draw(element<Mode>(["insert", "write"]))
	const writes: Arr.NonEmptyReadonlyArray<Table> =
		mode === "write" ? ["tag"] : s.draw(nonEmptySubset(tables))
	return {
		mode,
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

export const caseGen: Gen<GuardCase> = (s) => ({
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

/** Tag open, mutable inside the unit of its id, in every version; Post and Note closed. */
const openTag = [mutable(Tag), unit("Row", { id: pg.integer })] as const

const file = `${repoRoot}app/grizzle.config.ts`

/** The configuration of `version` under `name`, Post named Post. */
const withPost = (name: string, version: Version) => {
	const S = schema(name, [Post, Tag], openTag)
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
	const S = schema(name, [Note, Tag], openTag)
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
			declared,
			silentPhases
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

export type Feature =
	| "a guard dropped on a migration, every writer of its table certified READ COMMITTED"
	| "a guard created on a migration, a writer of its table SERIALIZABLE"
	| "a guard dropped on a table its migration renames"
	| "a guard created on a table its migration renames"
	| "a guard flipped within two pending folders applied together"
	| "a READ COMMITTED write admitted after a migration"
	| "a READ COMMITTED write refused by its table's guard after a migration"

export const walk = (c: GuardCase, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: "guard" })
		const schemaIdent = identifierOf(identity.schema(parsedSchemaName(name)))
		const tableOf = (relationName: string) =>
			`${quoteIdent(schemaIdent)}.${quoteIdent(identifierOf(identity.table(parsedName(relationName))))}`
		const session = yield* substrate.session({ ...ownerSession(), label: "owner guard" })
		const ownerLogin = yield* ambientOwner(ordinarySession, [schemaIdent])
		const migrator = yield* openMigrator(substrate, ownerLogin.credentials)
		const folders: Array<FolderTexts> = []
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

/**
 * A version that guards `table`: the open Tag written by the writer's `write`, holding DELETE there; Post inserted by
 * the writer and written by the other role too, which runs SERIALIZABLE.
 */
const serialOn = (table: Table): Version =>
	table === "tag"
		? { mode: "write", writes: [table], inserts: [table], other: [] }
		: { mode: "insert", writes: [table], inserts: [table], other: [table] }

export const aims: ReadonlyArray<Aim<GuardCase, Feature>> = [
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
