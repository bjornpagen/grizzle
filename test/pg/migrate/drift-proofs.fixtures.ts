/** What the properties of drift-proofs.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Result } from "effect"
import type { DriftMismatch, ProofRow } from "#adapter/admission/drift.ts"
import { textArray } from "#adapter/admission/roles.ts"
import type { BatchFailure, InputTooLarge, ServerError } from "#adapter/errors/failures.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { type ApartFailure, oneShotStatement, sentAnswer } from "#adapter/wire/batch.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { ProofStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { Logic, Num } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { contained, on, relation, schema, select, type Statement } from "#compiler/public/schema.ts"
import { firstCodes } from "#test/support/compile.ts"
import { triggerDisabled } from "#test/support/drift/hand-change.ts"
import { atName } from "#test/support/kernel/naming.ts"
import {
	type DeploySubject,
	draftChain,
	fromEmpty,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { testSql } from "#test/support/sql.ts"
import { shopV1, shopV2, shopV3, shopV3Declared } from "#test/support/unit/deploy/schemas.ts"

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

/**
 * A case: a history of the shop's first `versions` versions, then `edit` of the `k`-th object its last version holds of
 * the edit, a version that holds one (`editable`).
 */
export interface ProofCase {
	readonly versions: number
	readonly edit: HandEdit
	readonly k: number
}

export const caseGen: Gen<ProofCase> = (source) => {
	const [edit, held] = source.draw(element(editable))
	return { versions: source.draw(element(held)), edit, k: source.draw(int(0, 999)) }
}

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
								sql: triggerDisabled({ schema, name: ident.relation }, ident.name),
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

/**
 * Each hand edit, with the counts of the shop's first versions whose last holds an object of it (madeEdit), read off the
 * shop drafted once, under one schema's name: the objects an edit may be made of are a snapshot's kinds and identities
 * within its schema, whatever schema a case drafts it under. Task's WeightNonNegative, the shop's one CHECK of a table,
 * stands in its second version alone (shopV3 drops it with Task.weight), so a CHECK is dropped over two versions; a
 * history whose last version holds no object of an edit is no case of it.
 */
const editable: Arr.NonEmptyReadonlyArray<readonly [HandEdit, Arr.NonEmptyReadonlyArray<number>]> =
	(() => {
		const drafted = draftChain(
			Arr.map(versions, ([desc, declared]) => ({
				desc,
				options: { schema: atName("proofs"), logins: [], extensions: [], codes: firstCodes },
				declared
			})),
			fromEmpty
		)
		return Arr.map(
			handEdits,
			(edit) =>
				[
					edit,
					nonEmpty(
						Arr.flatMap(drafted, (g, at) =>
							Option.isSome(madeEdit(g.snapshot, edit, 0)) ? [at + 1] : []
						),
						`a version of the shop holding an object of ${edit}`
					)
				] as const
		)
	})()

/** The statement of a hand edit as the migration session sends it, in a step of its own. */
export const editStatement = (made: MadeEdit) => oneShotStatement(testSql(made.sql), [])

/**
 * The laws over one relation on both sides, or over two, each the one law of a schema of its own: a selection of a
 * relation contained in another selection of it, which the rule judge holds (qti's Track srclang: a `track` whose
 * `kind` attribute is `subtitles` carries a `srclang` one, two rows of Attribute); a relation contained in its own key,
 * a foreign key referencing its own table; and a selection of one relation contained in a selection of another, which
 * the judge holds over two tables.
 */
export const readLaws = [
	"a selection in another of its relation",
	"a relation in its own key",
	"a selection in another relation's"
] as const
export type ReadLaw = (typeof readLaws)[number]

/** A document's attributes, each by its element's start and its name. */
const Attribute = relation("Attribute", { doc: int4, start: int4, name: int4 }, [
	"doc",
	"start",
	"name"
])

/** A document's elements, each by its start, with its parent's start and its kind. */
const Element = relation("Element", { doc: int4, start: int4, parent: int4, kind: int4 }, [
	"doc",
	"start"
])

/** Each law of readLaws over Attribute and Element. */
const readStatements: { readonly [L in ReadLaw]: Statement } = {
	"a selection in another of its relation": contained(
		on(
			select(Attribute, (a) => a.eq(a.name, 1)),
			"doc",
			"start"
		),
		on(
			select(Attribute, (a) => a.eq(a.name, 2)),
			"doc",
			"start"
		)
	),
	"a relation in its own key": contained(on(Element, "doc", "parent"), on(Element, "doc", "start")),
	"a selection in another relation's": contained(
		on(
			select(Attribute, (a) => a.eq(a.name, 1)),
			"doc",
			"start"
		),
		on(
			select(Element, (e) => e.eq(e.kind, 2)),
			"doc",
			"start"
		)
	)
}

/** The schema of Attribute and Element under `law` alone. */
export const readSchema = (law: ReadLaw) =>
	schema("Read", [Attribute, Element], [readStatements[law]])

/** The facts S names. */
const Named = relation("T", { t: int4 }, ["t"])
/** S's rows, each by s, with the t it names. */
const Naming = relation("S", { s: int4, t: int4 }, ["s"])

/**
 * The schemas whose every object's replay builds alone (drift-proofs.test.ts eachObjectReplaysAloneWithWhatItIsCreatedAfter):
 * the shop's first two versions, each migrated from nothing, and S's rows whose t meets a condition that computes, `t <=
 * t + 0`, contained in T. That condition is no field comparison, so the containment is its foreign key from S's
 * generated column of t (laws/model/plan.ts containmentDischarge, readsAlike), and the foreign key's reverse probes read
 * an index over that law column alone, which no UNIQUE serves.
 */
export const replaySchemas = [
	"the shop's first version",
	"the shop's second version",
	"a law column"
] as const
export type ReplaySchema = (typeof replaySchemas)[number]

/** Each schema of replaySchemas. */
export const replayed: { readonly [S in ReplaySchema]: DeploySubject } = {
	"the shop's first version": shopV1,
	"the shop's second version": shopV2,
	"a law column": schema(
		"Named",
		[Named, Naming],
		[
			contained(
				on(
					select(Naming, (r) => Logic.le(r.t, Num.add(r.t, 0))),
					"t"
				),
				on(Named, "t")
			)
		]
	)
}
