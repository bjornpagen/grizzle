/** What the properties of keys.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import {
	type DraftedVersion,
	draftVersion,
	expectFreshCatalog,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	fromEmpty,
	fromSnapshot,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import {
	type Aim,
	apply,
	checkedAdmission,
	openMigrator
} from "#test/support/pg/migrate/support.ts"
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

export const caseGen: Gen<KeyCase> = (s) => ({
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

/** Every law a migration's refusal names, by migrate's reading of the refused constraint through its folder's laws. */
const namedLaws = (failure: MigrateError): ReadonlyArray<string> => {
	const reason = failure.reason
	return reason._tag === "StatementFailed" || reason._tag === "FileCommitRefused" ? reason.laws : []
}

/** The folder a migration's refusal names, by its step's place, none for any other failure. */
const refusedFolder = (failure: MigrateError): Option.Option<string> => {
	const reason = failure.reason
	return reason._tag === "StatementFailed" || reason._tag === "FileCommitRefused"
		? Option.some(reason.folder)
		: Option.none()
}

export type Feature =
	| "a primary key moved over rows that keep it"
	| "a primary key moved over rows that repeat it, refused naming its law"
	| "a primary key moved over rows that repeat it in the first of two pending folders, refused naming its law"

export const walk = (c: KeyCase, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
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
				{ schema: schemaOf(name, key), declarations: noDeclarations },
				{ installation, previous, step },
				{ extensions: [], compile: compileInstallation, review: noPlaceholders }
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
					Option.exists(law, (id) => Arr.contains(namedLaws(failure), id)),
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

/** The cases each required situation is aimed at while it is pending: the generator draws the one a case's turn aims
 * at (aimed) in place of its plain draw. */
export const aims: ReadonlyArray<Aim<KeyCase, Feature>> = [
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
