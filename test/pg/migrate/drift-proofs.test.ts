/**
 * The drift check by proofs on PostgreSQL 19 (adapter/admission/drift.ts, deploy/admission/proof.ts, deploy/ledger
 * ledger.ts proofsTable): a migrate whose drift check finds no drift records, beside the ledger, each described object's
 * proof digest and the digest of its installed description, and the next drift check replays only what no row proves.
 *
 * - **Property:** a history of the shop's first one to three versions, each migrated by the runner. Before each
 *   version's own check the proofs hold the version before's rows (none before the first): the check replays exactly
 *   the objects the specification's replay set names, and admits the database; once it recorded the version's rows,
 *   the next check replays nothing and admits it again. Then a hand edit of an object no version changed (a column
 *   added, an index dropped, a CHECK dropped, a trigger disabled), made outside any migration, is refused at the stage
 *   drift with exactly its own mismatch.
 * - **Oracle:** specification. The replay set restated by object (test/support/migrate/proofs.ts specifiedReplay): an object
 *   whose replayed statements' canonical text, or the objects it is created after, differ from the proven version's,
 *   or that is created after one that does, is unproven where a description names its kind, and the replay is every
 *   unproven object with every object it is created after, in install order; and each hand edit's one mismatch, its
 *   kind and the fact the drift check spells.
 * - **Kept case:** the hand edit of an unchanged object, whose proof digest still matches, is caught.
 * - **Kills:** a full replay every time; a stored description digest that is never compared.
 * - **Features:** the first version, a version over another, nothing changed, and each hand edit.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { applyOnSession, checkDrift } from "#adapter/migrate/apply.ts"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { proofStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	caseGen,
	editStatement,
	handEdits,
	madeEdit,
	type ProofFeature,
	proofRowsOf,
	proofsHeld,
	versions
} from "#test/pg/migrate/drift-proofs.fixtures.ts"
import { driftedOf } from "#test/pg/migrate/recorded-drift.fixtures.ts"
import {
	kept,
	openMigrator,
	parsedTarget,
	refusal,
	reviewedSource
} from "#test/pg/migrate/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty } from "#test/support/migrate/kit.ts"
import { specifiedReplay } from "#test/support/migrate/proofs.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The drift check replays what no proof proves, and holds every proven object to its stored description. */
export const driftProofs = property.explore(caseGen, {
	needs: { caseSubstrate: Substrate.installing },
	situations: [
		"the first version",
		"a version over another",
		"nothing changed",
		...Arr.map(handEdits, (edit) => `hand edit: ${edit}` as const)
	] satisfies ReadonlyArray<Reached<ProofFeature>>,
	budget: { runs: 6, steered: 24 },
	check:
		({ caseSubstrate }, c: Case<ProofFeature>) =>
		(x) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const m = yield* openMigrator(substrate, substrate.owner)
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const allocated = yield* substrate.schema({ create: false, label: "proofs" })
							const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
							const ledger = succeeded(statementsFor(schema))
							const proofs = succeeded(proofStatements(schema))
							const over = {
								schema: atName(allocated),
								extensions: [],
								codes: firstCodes
							}
							const folders: ReadonlyArray<GenerateResult> = draftChain(
								Arr.map(versions.slice(0, x.versions), ([desc, declared]) => ({
									desc,
									options: over,
									declared
								})),
								fromEmpty
							)
							const sources = Arr.map(folders, (g) => reviewedSource(g, kept))
							const targetAt = (n: number): MigrationTarget =>
								parsedTarget({
									snapshot: defined(folders[n - 1], "a drafted folder").snapshot,
									folders: sources.slice(0, n)
								})
							for (const n of Array.from({ length: x.versions }, (_, i) => i + 1)) {
								const target = targetAt(n)
								c.note(n === 1 ? "the first version" : "a version over another")
								/** The rows the version before's migrate recorded, none before the first's. */
								const before = n === 1 ? [] : yield* proofRowsOf(m, proofs)
								yield* applyOnSession(m, [target])
								yield* proofsHeld(m, proofs, before)
								const own = yield* checkDrift(m, target.snapshot, ledger, proofs, [])
								assert.deepEqual(
									own.replayed,
									specifiedReplay(n === 1 ? undefined : targetAt(n - 1).snapshot, target.snapshot),
									`version ${n} over the proofs of the version before replays exactly what they do not prove`
								)
								yield* applyOnSession(m, [target])
								const again = yield* checkDrift(m, target.snapshot, ledger, proofs, [])
								c.note("nothing changed")
								assert.deepEqual(again.replayed, [], `version ${n}, proven, replays nothing`)
							}
							const last = targetAt(x.versions)
							const made = defined(
								Option.getOrUndefined(madeEdit(last.snapshot, x.edit, x.k)),
								`the shop's last version holds an object of ${x.edit}`
							)
							c.note(`hand edit: ${x.edit}`)
							yield* m.apart([editStatement(made)])
							const failed = yield* refusal(checkDrift(m, last.snapshot, ledger, proofs, []))
							const mismatches = driftedOf(failed)
							assert.deepEqual(
								Arr.map(mismatches, (mismatch) => ({
									kind: mismatch.kind,
									fact: Str.startsWith(made.fact)(mismatch.fact)
								})),
								[{ kind: made.kind, fact: true }],
								`${x.edit} by hand is refused by exactly its own mismatch, ${made.fact}`
							)
						})
					)
				}),
				Substrate,
				caseSubstrate
			),
	oracle: {
		kind: "specification",
		name: "the replay set restated by object over the two versions' manifests, and each hand edit's own mismatch"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/admission/drift.ts",
			original: "Arr.flatMap(rows, (row) => (proves(row) ? [] : [row.object]))",
			replacement: "Arr.map(rows, (row) => row.object)",
			why: "Every drift check replays the whole manifest, the proofs read and never trusted."
		},
		{
			file: "packages/grizzle/src/adapter/admission/drift.ts",
			original:
				"held !== undefined && held.ddl === row.ddl && held.description === row.description",
			replacement: "held !== undefined && held.ddl === row.ddl",
			why: "A proven object's installed description is never held to its row's, so a hand edit of an unchanged object is admitted."
		}
	]
})
