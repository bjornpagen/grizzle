/**
 * A role that writes nothing runs the read-backs its login serves: Learning Commons' reader (edullm
 * packages/data/learning-commons logins.ts), one role over every relation whole and writing none, serves its reads as
 * read-backs of a ChangeSet that writes nothing, and a read-back checks each bare child and option it delivers inside its
 * own statement through the installation's refusal function (lower/conservative/deliver.ts checkedAttachment).
 * PostgreSQL checks EXECUTE on every function of a plan as the plan starts, so the role must hold EXECUTE on the
 * refusal function whatever it writes (physical/ddl/roles.ts addRole), or every such read fails with "permission
 * denied for function __refuse" though it compiled and `grizzle check` passed.
 *
 * The box: Family, a shelf, parents each contained in it, and a tag and a badge per parent, each keyed by the parent;
 * the reader's login, drafted and served as `grizzle generate` does (Served.of over the generated template), whose one
 * member reads every parent back with its shelf (a bare child), its tag and its badge (options). A case stores drawn
 * parents on the one shelf, each with or without a tag and a badge, and tags of no parent, as the owner; then opens a
 * Db of the reader through its login and calls the member once.
 *
 * Oracle: a model of the delivered types over the stored rows: the call is unchanged, and reads back exactly the
 * stored parents, each on its shelf, with its tag and badge where it has them and none where it has none.
 *
 * Features: no parent, a parent with a tag and a badge, a parent with neither, a parent with one of them, a tag of no
 * parent.
 */
import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { isRecord } from "#compiler/core/record.ts"
import {
	caseGen,
	deliveredOf,
	factsOf,
	Family,
	familyTemplate,
	type Feature,
	featuresOf,
	modelOf,
	readerApp
} from "#test/pg/served/unwritten-read-backs.fixtures.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { Served } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A role that writes nothing runs the read-backs its login serves, each delivering exactly the rows the model states. */
export const aRoleThatWritesNothingRunsTheReadBacksItsLoginServesEachDeliveringExactlyTheRowsTheModelStates =
	property.explore(caseGen, {
		needs: { family: Served.of(readerApp(Family), Substrate.fresh(familyTemplate)) },
		situations: [
			"no parent",
			"a parent with a tag and a badge",
			"a parent with neither",
			"a parent with one of them",
			"a tag of no parent"
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 16, steered: 16 },
		check:
			({ family }, notes: Case<Feature>) =>
			(c) =>
				Effect.gen(function* () {
					for (const feature of featuresOf(c)) {
						notes.note(feature)
					}
					const { substrate, installed, fixture } = yield* family
					yield* Effect.provideService(loadMigrated(installed, factsOf(c)), Substrate, substrate)
					const called = yield* Effect.result(
						Effect.scoped(
							Effect.gen(function* () {
								const db = yield* Db.open(fixture.login.roles.reader, {})
								return yield* db.workload.family.once({ params: {}, facts: {} })
							})
						).pipe(withLayer(fixture.layer))
					)
					if (Result.isFailure(called)) {
						return assert.fail(
							`the reader's read-back of ${Formatter.format(c)} fails: ${Formatter.format(called.failure)}`
						)
					}
					const outcome = called.success
					assert.equal(outcome._tag, "unchanged", "a ChangeSet that writes nothing changes nothing")
					const rows = isRecord(outcome.reads) ? outcome.reads["family"] : undefined
					assert.ok(Arr.isArray(rows), "the call reads the family back")
					unorderedEqual(
						Arr.map(Arr.isArray(rows) ? rows : [], deliveredOf),
						modelOf(c),
						`the parents read back, each on its shelf with its tag and badge: ${Formatter.format(rows)}`
					)
				}),
		oracle: {
			kind: "specification",
			name: "the delivered types over the stored rows: every parent, on its shelf, with its tag and badge where it has them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original:
					'\tprivileges.push(grant(["EXECUTE"], { kind: "FUNCTION", names: [refusalFunction(b.schema)] }))\n',
				replacement:
					'\tif (role.writes.size > 0 || Object.keys(role.contexts).length > 0) {\n\t\tprivileges.push(grant(["EXECUTE"], { kind: "FUNCTION", names: [refusalFunction(b.schema)] }))\n\t}\n',
				why: "The old grant: EXECUTE on the refusal function to a role that writes or reads a context alone, so the reader's read-back fails with permission denied for function __refuse (Learning Commons' reader, 2026-11-17)."
			}
		]
	})
