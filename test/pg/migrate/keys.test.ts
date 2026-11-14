/**
 * A relation's primary key moved between its fields over stored rows, migrated on PostgreSQL 19 by the real runner. A
 * primary key is named by its relation alone, so a migration that moves it to another field changes it under its own
 * name: on a table that may hold rows the new key's index is built concurrently under a temporary swap name, then
 * attached as the key (deploy/diff/diff.ts ownConstraint, swapName). A build over rows that repeat the new key is
 * refused by PostgreSQL with 23505, reporting the swap name as its constraint, which no snapshot's constraint-to-law map
 * holds: the folder's own laws (its meta.json's FolderLaws) hold it, under its table, as the moved key's law.
 *
 * A case draws three versions of Item, each keyed by one of its fields `id`, `a` and `b`, and rows of Item, stored
 * after the first version, those its key refuses left out. Each later version is drafted from the snapshot before, as
 * a history drafts it (install-migrate.ts draftVersion), and applied by the real runner as `grizzle migrate` applies
 * it, the drift check and the installed-catalog checker admitting every apply; or the last two together, as one apply
 * of two pending folders. The steered phase aims at a key moved over rows that keep it, over rows that repeat it, and
 * over rows that repeat it in the first of two pending folders.
 *
 * The oracle is the key restated over the stored rows: a version's key holds exactly when no two rows share its field.
 * A migration applies exactly when the rows keep the key of every version it reaches. A refused one names the folder of
 * the first version whose key the rows break, and that version's key law (migrate's StatementFailed or
 * FileCommitRefused `law`). After every apply the migrated catalog is a fresh install's of the version
 * (install-migrate.ts expectFreshCatalog).
 *
 * Features: a key moved over rows that keep it, over rows that repeat it, and over rows that repeat it in the first of
 * two pending folders, each a steered case constructs while it is pending.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): keys-swap-unrecorded (a key's index built under its swap name is no
 * Swap of the plan, so a refused build names no law).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	type Aim,
	aimedAt,
	apply,
	checkedAdmission,
	openMigrator
} from "#test/pg/migrate/support.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import {
	type DraftedVersion,
	draftVersion,
	expectFreshCatalog
} from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	fromEmpty,
	fromSnapshot,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The fields of Item, each the one field a version keys it by. */
const fieldNames = ["id", "a", "b"] as const
type Field = (typeof fieldNames)[number]

/** A stored row of Item: its values of `id`, `a` and `b`. */
type Row = Readonly<Record<Field, number>>

/** How the later versions are applied: each alone, or the last two as one apply. */
type Applied = "each alone" | "the last two together"

interface KeyCase {
	readonly keys: readonly [Field, Field, Field]
	readonly rows: ReadonlyArray<Row>
	readonly applied: Applied
}

const values = 3

const rowGen: Gen<Row> = (s) => ({
	id: s.draw(int(0, values - 1)),
	a: s.draw(int(0, values - 1)),
	b: s.draw(int(0, values - 1))
})

const caseGen: Gen<KeyCase> = (s) => ({
	keys: [s.draw(element(fieldNames)), s.draw(element(fieldNames)), s.draw(element(fieldNames))],
	rows: s.draw(array(rowGen, { min: 0, max: 4 })),
	applied: s.draw(boolean) ? "the last two together" : "each alone"
})

/** Whether rows keep the key over `field`: no two share its value. */
const keeps = (rows: ReadonlyArray<Row>, field: Field): boolean =>
	new Set(Arr.map(rows, (r) => r[field])).size === rows.length

const fields = Object.freeze({ id: pg.integer, a: pg.integer, b: pg.integer })
const ItemById = relation("Item", fields, ["id"])
const ItemByA = relation("Item", fields, ["a"])
const ItemByB = relation("Item", fields, ["b"])

/** The version of Item keyed by `key`, under `name`. */
const schemaOf = (name: string, key: Field) => {
	switch (key) {
		case "id":
			return schema(name, [ItemById], [])
		case "a":
			return schema(name, [ItemByA], [])
		case "b":
			return schema(name, [ItemByB], [])
	}
}

/** The law of Item's primary key at a plan. */
const keyLawOf = (plan: RealInstallPlan): Option.Option<string> =>
	Option.map(
		Arr.findFirst(
			plan.installation.laws.theory.laws,
			(law) => law.detail.kind === "key" && law.detail.key.primary
		),
		(law) => law.id
	)

/** The law a migration's refusal names, by migrate's reading of the refused constraint through its folder's laws. */
const namedLaw = (failure: MigrateError): Option.Option<string> => {
	const reason = failure.reason
	return reason._tag === "StatementFailed" || reason._tag === "FileCommitRefused"
		? Option.fromUndefinedOr(reason.law)
		: Option.none()
}

/** The folder a migration's refusal names, by its step's place, none for any other failure. */
const refusedFolder = (failure: MigrateError): Option.Option<string> => {
	const reason = failure.reason
	return reason._tag === "StatementFailed" || reason._tag === "FileCommitRefused"
		? Option.some(reason.folder)
		: Option.none()
}

type Feature =
	| "a primary key moved over rows that keep it"
	| "a primary key moved over rows that repeat it, refused naming its law"
	| "a primary key moved over rows that repeat it in the first of two pending folders, refused naming its law"

const walk = (c: KeyCase, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owner = substrate.owner.role
		const name = yield* substrate.schema({ create: false, label: "keys" })
		const installation = identity.schema(parsedSchemaName(name))
		const table = `${quoteIdent(identifierOf(installation))}.${quoteIdent(identifierOf(identity.table(parsedName("Item"))))}`
		const ownerLogin = yield* ambientOwner(ordinarySession, [identifierOf(installation)])
		const migrator = yield* openMigrator(substrate, ownerLogin.credentials)
		const [first] = c.keys
		const stored = Arr.dedupeWith(c.rows, (x, y) => x[first] === y[first])
		const drafted: Array<DraftedVersion> = []
		let previous: Previous = fromEmpty
		for (const [step, key] of c.keys.entries()) {
			const draft = yield* draftVersion(
				{ schema: schemaOf(name, key), logins: [], declarations: noDeclarations },
				{ installation, owner, previous, step },
				{ extensions: [], compile: compileInstallation }
			)
			drafted.push(draft)
			previous = fromSnapshot(draft.snapshot)
			if (step === 1 && c.applied === "the last two together") {
				continue
			}
			const folders = Arr.map(drafted, (d) => d.folder)
			const outcome = yield* Effect.result(
				apply(
					migrator,
					{ snapshot: draft.snapshot, folders },
					checkedAdmission(draft.plan.installation, substrate.admin)
				)
			)
			const pending = step === 2 && c.applied === "the last two together" ? [1, 2] : [step]
			const breaking = Arr.findFirst(pending, (at) => !keeps(stored, Arr.getUnsafe(c.keys, at)))
			if (outcome._tag === "Failure") {
				const failure = outcome.failure
				if (Option.isNone(breaking)) {
					return assert.fail(
						`step ${step + 1} failed where the stored rows keep every key it reaches: ${failure.message}\n${Formatter.format(c)}`
					)
				}
				const at = breaking.value
				const atDraft = Arr.getUnsafe(drafted, at)
				const law = keyLawOf(atDraft.plan)
				assert.ok(
					Option.exists(refusedFolder(failure), (folder) => folder === atDraft.folder.name),
					`the refusal names the folder of step ${at + 1}, the first whose key the rows repeat: ${failure.message}`
				)
				assert.ok(
					Option.exists(law, (id) => Option.exists(namedLaw(failure), (named) => named === id)),
					`the refusal names the key law of the folder it refuses: ${failure.message}`
				)
				note(
					at === step
						? "a primary key moved over rows that repeat it, refused naming its law"
						: "a primary key moved over rows that repeat it in the first of two pending folders, refused naming its law"
				)
				return
			}
			if (Option.isSome(breaking)) {
				return assert.fail(
					`step ${step + 1} applied though the stored rows repeat the key of step ${breaking.value + 1}\n${Formatter.format(c)}`
				)
			}
			if (step === 0) {
				yield* transaction(
					substrate.admin,
					Arr.map(stored, (r) => `INSERT INTO ${table} (id, a, b) VALUES (${r.id}, ${r.a}, ${r.b})`)
				)
			} else if (
				stored.length > 1 &&
				Arr.some(pending, (at) => Arr.getUnsafe(c.keys, at) !== Arr.getUnsafe(c.keys, at - 1))
			) {
				note("a primary key moved over rows that keep it")
			}
			yield* expectFreshCatalog(draft.plan.installation, folders, draft.planned)
		}
	})

/** A case whose first two versions key Item by `id` and then by `a`, over rows each `rows` draws. */
const movedOver =
	(rows: Gen<ReadonlyArray<Row>>, applied: Applied): Gen<KeyCase> =>
	(s) => ({
		keys: ["id", "a", s.draw(element(fieldNames))],
		rows: s.draw(rows),
		applied
	})

/** Two rows of distinct ids, sharing `a` or not. */
const twoRows =
	(a: "shared" | "distinct"): Gen<ReadonlyArray<Row>> =>
	(s) => {
		const shared = s.draw(int(0, values - 1))
		return [
			{ id: 0, a: shared, b: s.draw(int(0, values - 1)) },
			{ id: 1, a: a === "shared" ? shared : (shared + 1) % values, b: s.draw(int(0, values - 1)) }
		]
	}

/** The cases each required situation is aimed at while it is pending (Case.steering). */
const aims: ReadonlyArray<Aim<KeyCase, Feature>> = [
	["a primary key moved over rows that keep it", movedOver(twoRows("distinct"), "each alone")],
	[
		"a primary key moved over rows that repeat it, refused naming its law",
		movedOver(twoRows("shared"), "each alone")
	],
	[
		"a primary key moved over rows that repeat it in the first of two pending folders, refused naming its law",
		movedOver(twoRows("shared"), "the last two together")
	]
]

/** The case a search runs: its drawn one, or, while a situation `aims` reaches is pending, the one aimed at it. */
const aimed = aimedAt(aims)

layer(Substrate.layer)("a primary key moved over stored rows", (it) => {
	it.effect(
		"migrate a primary key to another field exactly when the stored rows keep it, naming its law when they do not",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "migrate/keys",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the key restated over the stored rows: a migration applies exactly when no two rows share the key of any version it reaches, and a refused one names that version's key law"
						},
						coverage: required<Feature>(
							[
								"a primary key moved over rows that keep it",
								"a primary key moved over rows that repeat it, refused naming its law",
								"a primary key moved over rows that repeat it in the first of two pending folders, refused naming its law"
							],
							{ cases: 30, sense: notesOnly }
						),
						kept: [],
						runs: 12,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(c, cx) => Effect.scoped(walk(aimed(c, cx), cx.note))
				)
			)
	)
})
