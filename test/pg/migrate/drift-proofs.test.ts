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
 *   drift with exactly its own mismatch. A history ends at a version holding an object of its edit
 *   (drift-proofs.fixtures.ts editable): a CHECK is dropped over the shop's first two versions, whose second holds its
 *   one CHECK of a table, Task's WeightNonNegative.
 * - **Oracle:** specification. The replay set restated by object (test/support/migrate/proofs.ts specifiedReplay): an object
 *   whose replayed statements' canonical text, or the objects it is created after, differ from the proven version's,
 *   or that is created after one that does, is unproven where a description names its kind, and the replay is every
 *   unproven object with every object it is created after, in install order; and each hand edit's one mismatch, its
 *   kind and the fact the drift check spells.
 * - **Kept case:** the hand edit of an unchanged object, whose proof digest still matches, is caught.
 * - **Kills:** a full replay every time; a stored description digest that is never compared.
 * - **Features:** the first version, a version over another, nothing changed, and each hand edit.
 *
 * And a cast's type, which only its cast names (physical/obligations/graph.ts namedEdges): a set's schema migrated,
 * then its table alone changed, its CHECK's or its generated field's membership test, whose singleton set is a literal
 * cast to its roster's bits domain, which no column is typed by.
 *
 * - **Property:** over the first version's proofs, the second's check replays exactly the specification's replay set,
 *   the table unproven and the domain, proven, among what it is created after, and admits the database: PostgreSQL
 *   resolves the cast, where a manifest whose edges held no cast's type left the domain out of the replay, which was
 *   refused (42704), S7's drift check on qti's attribute.
 * - **Oracle:** specification, the replay set restated by object, its objects' names read off their printed text
 *   (test/support/migrate/proofs.ts specifiedAfter); and PostgreSQL, which builds the replay.
 * - **Box, exhausted:** each of the two changes of the set's table (schemas.ts setChanges).
 * - **Kill:** no edge from a type a cast names.
 * - **Features:** each change.
 *
 * And a law over one relation on both sides (laws/model/model.ts ruleTrigger, analysis/theory/laws.ts `reads`, each
 * relation once; physical/obligations/graph.ts, each identity one object): a migrate records one proof of each object
 * its drift check describes, where qti's ledger installation, whose Track srclang is a selection of Attribute contained
 * in another of it, held each of the rule's judge blocks twice and its migrate refused at the stage record, a duplicate
 * key of __drift_proofs_pk.
 *
 * - **Property:** a schema of the law alone, migrated by the runner, its drift check and its record among it: the
 *   proofs then hold each object the check describes once, and the next check replays nothing and records nothing.
 * - **Oracle:** specification: each object of the manifest of a kind a description names, its identity once
 *   (test/support/migrate/proofs.ts specifiedProofs).
 * - **Box, exhausted:** each of the three laws (drift-proofs.fixtures.ts readLaws).
 * - **Kill:** a rule's tables one for each side of its law, the relation of a containment of one relation's
 *   selection in another of it held twice.
 * - **Features:** each law.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { applyOnSession, checkDrift } from "#adapter/migrate/apply.ts"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { proofStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { type GraphIdent, parseIdent } from "#compiler/physical/obligations/graph.ts"
import {
	caseGen,
	editStatement,
	handEdits,
	madeEdit,
	type ProofFeature,
	proofRowsOf,
	proofsHeld,
	type ReadLaw,
	readLaws,
	readSchema,
	versions
} from "#test/pg/migrate/drift-proofs.fixtures.ts"
import { driftedOf } from "#test/pg/migrate/recorded-drift.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import { specifiedProofs, specifiedReplay } from "#test/support/migrate/proofs.ts"
import {
	kept,
	openMigrator,
	parsedTarget,
	refusal,
	reviewedSource
} from "#test/support/pg/migrate/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { type SetChange, setChanges, setsSchema } from "#test/support/unit/deploy/schemas.ts"

/** The drift check replays what no proof proves, and holds every proven object to its stored description. */
export const driftProofs = property.explore(caseGen, {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
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
								logins: [],
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
				Effect.map(caseSubstrate, (taken) => taken.substrate)
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

/** A replay over an unproven table creates the bits domain its CHECK or its generated field casts to, which no edge names. */
export const driftReplaysTheDomainAnUnprovenTablesCastNames = property.exhaust(
	finite((source): SetChange =>
		defined(setChanges[source.draw(int(0, setChanges.length - 1))], "a change")
	),
	{
		needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
		situations: setChanges satisfies ReadonlyArray<Reached<SetChange>>,
		check:
			({ caseSubstrate }, c: Case<SetChange>) =>
			(change) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const m = yield* openMigrator(substrate, substrate.owner)
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const allocated = yield* substrate.schema({ create: false, label: "sets" })
								const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
								const ledger = succeeded(statementsFor(schema))
								const proofs = succeeded(proofStatements(schema))
								const over = {
									schema: atName(allocated),
									logins: [],
									extensions: [],
									codes: firstCodes
								}
								const folders = draftChain(
									Arr.map([setsSchema("first"), setsSchema(change)], (desc) => ({
										desc,
										options: over,
										declared: noDeclarations
									})),
									fromEmpty
								)
								const sources = Arr.map(folders, (g) => reviewedSource(g, kept))
								const [first, second] = Arr.map([1, 2], (n) =>
									parsedTarget({
										snapshot: defined(folders[n - 1], "a drafted folder").snapshot,
										folders: sources.slice(0, n)
									})
								)
								const one = defined(first, "the first version")
								const two = defined(second, "the second version")
								yield* applyOnSession(m, [one])
								const before = yield* proofRowsOf(m, proofs)
								yield* applyOnSession(m, [two])
								yield* proofsHeld(m, proofs, before)
								const own = yield* checkDrift(m, two.snapshot, ledger, proofs, [])
								c.note(change)
								assert.deepEqual(
									own.replayed,
									specifiedReplay(one.snapshot, two.snapshot),
									`${change} changed, the check over the first version's proofs replays exactly what they do not prove`
								)
								/** Where the replay creates the first object `is` holds of. */
								const at = (is: (ident: GraphIdent) => boolean): Option.Option<number> =>
									Arr.findFirstIndex(own.replayed, (ident) => is(parseIdent(ident)))
								const created = Option.all([
									at((g) => g.kind === "domain" && Str.includes("_bits_")(g.name)),
									at((g) => g.kind === "table" && g.name === "tagged")
								])
								assert.ok(
									Option.exists(created, ([domain, table]) => domain < table),
									`${change} changed, the replay creates the bits domain before the unproven table that casts to it: ${Arr.join(own.replayed, ", ")}`
								)
							})
						)
					}),
					Substrate,
					Effect.map(caseSubstrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the replay set restated by object over the two versions' manifests, and PostgreSQL building it"
		},
		box: "each of the two changes of the set's table, its CHECK or its generated field, the bits domain as it was",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/obligations/graph.ts",
				original: '\t\t\t\t\tnamed("type", t.schema, t.name)\n',
				replacement: "",
				why: "An object is created after no type a cast or a literal of its statements names, so the unproven table is replayed without the bits domain its cast names, and PostgreSQL refuses the replay (42704): S7's drift check on qti's attribute."
			}
		]
	}
)

/** A migrate records one proof of each object its drift check describes, its law reading one relation on both sides or not. */
export const aMigrateRecordsOneProofOfEachObjectThoughItsLawReadsARelationTwice = property.exhaust(
	finite((source): ReadLaw => defined(readLaws[source.draw(int(0, readLaws.length - 1))], "a law")),
	{
		needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
		situations: readLaws satisfies ReadonlyArray<Reached<ReadLaw>>,
		check:
			({ caseSubstrate }, c: Case<ReadLaw>) =>
			(law) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const m = yield* openMigrator(substrate, substrate.owner)
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const allocated = yield* substrate.schema({ create: false, label: "reads" })
								const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
								const ledger = succeeded(statementsFor(schema))
								const proofs = succeeded(proofStatements(schema))
								const folder = defined(
									draftChain(
										[
											{
												desc: readSchema(law),
												options: {
													schema: atName(allocated),
													logins: [],
													extensions: [],
													codes: firstCodes
												},
												declared: noDeclarations
											}
										],
										fromEmpty
									)[0],
									"the drafted folder"
								)
								const target = parsedTarget({
									snapshot: folder.snapshot,
									folders: [reviewedSource(folder, kept)]
								})
								yield* applyOnSession(m, [target])
								c.note(law)
								const recorded = yield* proofRowsOf(m, proofs)
								assert.deepEqual<ReadonlyArray<string>>(
									Arr.map(recorded, (row) => row.object),
									specifiedProofs(target.snapshot),
									`${law}: the migrate recorded one proof of each object its drift check describes`
								)
								const again = yield* checkDrift(m, target.snapshot, ledger, proofs, [])
								assert.deepEqual(
									again.replayed,
									[],
									`${law}: proven, the next check replays nothing`
								)
								assert.equal(
									again.proofs.kind,
									"held",
									`${law}: proven, the next check records nothing`
								)
							})
						)
					}),
					Substrate,
					Effect.map(caseSubstrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "each object of the manifest of a kind a description names, its identity once"
		},
		box: "each of the three laws, a selection of a relation in another of it, a relation in its own key and a selection in another relation's, a schema each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original: "const tables = [...law.reads].flatMap(",
				replacement:
					'const tables = (law.detail.kind === "containment" ? [law.detail.from.relation, law.detail.to.relation] : [...law.reads]).flatMap(',
				why: "A rule's tables are one for each side of its law, so a selection of Attribute contained in another of it holds Attribute's table twice and the judge each of its blocks twice, two objects of one identity: the generate refuses it, and where it did not, the migrate's record of the proofs refused a duplicate key of __drift_proofs_pk (23505), qti's ledger installation."
			}
		]
	}
)
