/** What the properties of drift-proofs.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Result } from "effect"
import type { DriftMismatch, ProofRow } from "#adapter/admission/drift.ts"
import { textArray } from "#adapter/admission/roles.ts"
import type { BatchFailure, InputTooLarge, ServerError } from "#adapter/errors/failures.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { type ApartFailure, oneShotStatement, sentAnswer } from "#adapter/wire/batch.ts"
import type { ProofStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { defined } from "#test/support/assert.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { testSql } from "#test/support/sql.ts"
import { shopV1, shopV2, shopV3, shopV3Declared } from "#test/unit/deploy/schemas.ts"

/** The shop's versions, each over the one before (flights.fixtures.ts). */
export const versions = [
	[shopV1, noDeclarations],
	[shopV2, noDeclarations],
	[shopV3, shopV3Declared]
] as const

/**
 * A hand edit of an object no migration changed, made outside any migration once its proof stands: a column added to a
 * table, an index dropped, a CHECK constraint dropped, or a trigger disabled.
 */
export const handEdits = [
	"a column added",
	"an index dropped",
	"a check dropped",
	"a trigger disabled"
] as const
export type HandEdit = (typeof handEdits)[number]

/** A case: a history of the shop's first `versions` versions, then `edit` of the `k`-th object it may make it of. */
export interface ProofCase {
	readonly versions: number
	readonly edit: HandEdit
	readonly k: number
}

export const caseGen: Gen<ProofCase> = (source) => ({
	versions: source.draw(int(1, versions.length)),
	edit: source.draw(element(handEdits)),
	k: source.draw(int(0, 999))
})

export type ProofFeature =
	| "the first version"
	| "a version over another"
	| "nothing changed"
	| `hand edit: ${HandEdit}`

/** The proofs' rows as the drift check reads them, by the proofs' rows statement on the migration session. */
export const proofRowsOf = (
	m: MigrationSession,
	statements: ProofStatements
): Effect.Effect<ReadonlyArray<ProofRow>, ApartFailure | ServerError> =>
	Effect.flatMap(m.apart([oneShotStatement(statements.rows.text, [])]), (answers) =>
		Effect.fromResult(
			Result.map(sentAnswer(answers, 0), (outcome) =>
				Arr.map(outcome.rows, ([object, ddl, description]) => ({
					object: defined(object, "a proof's object"),
					ddl: defined(ddl, "a proof's digest"),
					description: defined(description, "a proof's description")
				}))
			)
		)
	)

/** The proofs replaced by `rows`, in a transaction of their own, as a migrate records them. */
export const proofsHeld = (
	m: MigrationSession,
	statements: ProofStatements,
	rows: ReadonlyArray<ProofRow>
): Effect.Effect<void, BatchFailure | InputTooLarge> =>
	m.transaction([
		oneShotStatement(statements.clear.text, []),
		oneShotStatement(statements.record.text, [
			textArray(Arr.map(rows, (r) => r.object)),
			textArray(Arr.map(rows, (r) => r.ddl)),
			textArray(Arr.map(rows, (r) => r.description))
		])
	])

/** A hand edit's statement, and the one mismatch the drift check finds of it: its kind and the start of its fact. */
export interface MadeEdit {
	readonly sql: string
	readonly kind: DriftMismatch["kind"]
	readonly fact: string
}

const qualified = (schema: string, name: string): string =>
	`${quoteIdent(schema)}.${quoteIdent(name)}`

/**
 * `edit` of the `k`-th object of `snapshot`'s schema it may be made of, in install order: the edit's statement and the
 * mismatch it leaves, as the drift check spells its fact (adapter/admission/drift.ts descriptionSelect); none where the
 * snapshot holds no such object.
 */
export const madeEdit = (
	snapshot: DeploySnapshot,
	edit: HandEdit,
	k: number
): Option.Option<MadeEdit> => {
	const schema = snapshot.schema
	const objects = snapshot.manifest.objects
	const parsed = Arr.map(objects, (o) => ({ object: o, ident: parseIdent(o.ident) }))
	const edits: { readonly [E in HandEdit]: () => ReadonlyArray<MadeEdit> } = {
		"a column added": () =>
			Arr.flatMap(parsed, ({ object, ident }) =>
				object.kind === "table" && ident.kind === "table" && ident.schema === schema
					? [
							{
								sql: `ALTER TABLE ${qualified(schema, ident.name)} ADD COLUMN "__by_hand" integer`,
								kind: "unexpected" as const,
								fact: `column ${schema}.${ident.name}.__by_hand as `
							}
						]
					: []
			),
		"an index dropped": () =>
			Arr.flatMap(parsed, ({ object, ident }) =>
				object.kind === "index" && ident.kind === "index" && ident.schema === schema
					? [
							{
								sql: `DROP INDEX ${qualified(schema, ident.name)}`,
								kind: "missing" as const,
								fact: `relation ${schema}.${ident.name} as `
							}
						]
					: []
			),
		"a check dropped": () =>
			Arr.flatMap(parsed, ({ object, ident }) =>
				object.kind === "check" && ident.kind === "constraint" && ident.schema === schema
					? [
							{
								sql: `ALTER TABLE ${qualified(schema, ident.relation)} DROP CONSTRAINT ${quoteIdent(ident.name)}`,
								kind: "missing" as const,
								fact: `constraint ${schema}.${ident.relation}.${ident.name} as `
							}
						]
					: []
			),
		"a trigger disabled": () =>
			Arr.flatMap(parsed, ({ ident }) =>
				ident.kind === "trigger" && ident.schema === schema
					? [
							{
								sql: `ALTER TABLE ${qualified(schema, ident.relation)} DISABLE TRIGGER ${quoteIdent(ident.name)}`,
								kind: "differs" as const,
								fact: `trigger ${schema}.${ident.relation}.${ident.name}`
							}
						]
					: []
			)
	}
	const made = edits[edit]()
	return Option.fromUndefinedOr(made[k % Math.max(made.length, 1)])
}

/** The statement of a hand edit as the migration session sends it, in a step of its own. */
export const editStatement = (made: MadeEdit) => oneShotStatement(testSql(made.sql), [])
