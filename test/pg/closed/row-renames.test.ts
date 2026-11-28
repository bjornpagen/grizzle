/**
 * A roster's history across a declared rename, on PostgreSQL 19: the functions grizzle names by their content, each row
 * function a hoisted CHECK or generation calls and each roster constant a domain or a view calls, stand with their OIDs
 * exactly when the migration leaves what they compute unchanged, and so does everything that calls them.
 *
 * A history: a roster of three handles, Weight and Bonus keyed by it, each a value at every code, and Item, an id and a
 * closed id of the roster, whose wt = Weight.at(w, kind) and bonus = Bonus.at(b, kind) are generated and whose CHECK
 * heavy holds Weight.at(w, kind) at least a drawn bound, each read of a closed relation a row function
 * (physical/ddl/row-functions.ts); a writer that stores Item and a reader that reads it, of one login. Rows are stored
 * under the first version, each of a weight heavy admits. Its second version, each part turned on by the case's swarm,
 * renames the roster (to Sort, the kept case's, or to a fresh name), renames its handles (swaps and chains among
 * them), adds a member after them, or changes Weight's or Bonus's values; every rename declared (`--rename`).
 *
 * The model is what each function computes from: Weight's values at each code for wt's and heavy's row functions,
 * Bonus's for bonus's, the roster's live codes for the live-codes constant its domain's CHECK reads, and its names in
 * code order for the names constant the reader's view decodes kind by. A rename moves no code and no value, so it keeps
 * every function whose content it does not change: the row functions and the live-codes constant under any declared
 * rename, the names constant under the roster's alone.
 *
 * The oracles, PostgreSQL the judge:
 *
 * - **A function stands exactly when its content does.** The function each caller depends on (pg_depend: Item's two
 *   generations, heavy, the roster domain's CHECK, the reader's view) keeps its pg_proc OID exactly when the model says
 *   its content is unchanged: a renamed function is renamed in place, never dropped and created; a changed one is a new
 *   function.
 * - **What calls a standing function stands.** heavy and the roster domain's CHECK keep their OIDs when their functions
 *   do, so neither was added again; Item keeps its relfilenode and every row its xmin when both generations' functions
 *   stand, so nothing rewrote it; and the folder validates nothing when both CHECKs stand.
 * - **What calls a changed function is drawn again.** Every stored row's wt and bonus are the second version's values
 *   at its code; the migration is refused (23514) exactly when a stored row's weight is one the new heavy refuses.
 * - **Grants per role and the catalog.** The writer's and the reader's EXECUTE on each caller's function is a fresh
 *   installation's of the second version; the writer then stores a row at a drawn code, committed exactly when heavy
 *   admits its weight, its wt and bonus the model's; the reader reads every row through its view; and the migrated
 *   catalog is a fresh installation's of the second version, function bodies, grants and view queries included.
 *
 * Features: the roster renamed, handles renamed and swapped, a member added, Weight's and Bonus's values changed, a row
 * function and a constant renamed in place, each made anew, a migration refused by the new CHECK, the writer refused by
 * it, and stored rows.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import {
	declarationsOf,
	everyCaller,
	heldOf,
	insertItem,
	bitsKeptBy,
	keptBy,
	modelRows,
	notesOf,
	probeAdmitted,
	refusedBy,
	type RowFeature,
	rowCaseGen,
	rowsOf,
	validates,
	versionOf
} from "#test/pg/closed/row-renames.fixtures.ts"
import {
	applyNext,
	draftNext,
	installFirst,
	ownerSessionOf,
	serverOf,
	sessionOf
} from "#test/support/pg/closed/codes.fixtures.ts"
import { sameCatalog } from "#test/support/pg/migrate/support.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A roster's declared rename renames in place exactly the functions whose content it leaves, and everything calling
 * them stands: no CHECK added or validated again, no table rewritten, every grant and value the target's. */
export const aFunctionNamedByItsContentStandsAcrossARosterChangeExactlyWhenItsContentDoesAndSoDoesEverythingCallingIt =
	property.explore(rowCaseGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"roster renamed",
			"handles renamed",
			"handles swapped",
			"member added",
			"weights changed",
			"bonuses changed",
			"a row function renamed in place",
			"a constant renamed in place",
			"a row function made anew",
			"a constant made anew",
			"refused by the new CHECK",
			"the writer refused by the CHECK",
			"stored rows"
		] satisfies ReadonlyArray<Reached<RowFeature>>,
		check:
			({ substrate }, k: Case<RowFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							k.noteAll(notesOf(c))
							const { m, first } = yield* installFirst("row_renames", (name) =>
								versionOf(name, c.first, c.bound)
							)
							const writer = yield* sessionOf(m, first.writer, "writer")
							yield* writer.begin
							for (const [i, code] of c.stored.entries()) {
								yield* writer.query(insertItem(m, i + 1, code, c.first.handles.length), [])
							}
							yield* writer.commit
							const owner = yield* ownerSessionOf
							const before = yield* heldOf(m, m.names, owner, c.first.roster, first)
							const next = yield* draftNext(
								m,
								m.snapshot,
								versionOf(m.declared, c.second, c.bound).version,
								2,
								declarationsOf(c)
							)
							const failure = yield* Effect.match(applyNext(m, [next]), {
								onSuccess: () => Option.none(),
								onFailure: Option.some
							})
							if (refusedBy(c)) {
								assert.ok(
									Option.isSome(failure),
									"a migration over a stored row whose weight the new heavy refuses is refused"
								)
								assert.equal(
									serverOf(failure.value).sqlstate,
									sqlstates.checkViolation,
									failure.value.message
								)
								return
							}
							assert.ok(
								Option.isNone(failure),
								`the migration applies: ${Option.match(failure, { onNone: () => "", onSome: (e) => e.message })}`
							)
							const after = yield* heldOf(
								m,
								next.plan.installation.names,
								owner,
								c.second.roster,
								first
							)
							for (const caller of everyCaller) {
								assert.equal(
									after.called[caller].oid === before.called[caller].oid,
									keptBy(c, caller),
									`the ${caller}'s function ${keptBy(c, caller) ? "stands, renamed in place" : "is a new function"}: its content ${keptBy(c, caller) ? "is" : "is not"} the first version's`
								)
							}
							assert.equal(
								after.heavy === before.heavy,
								keptBy(c, "heavy"),
								"heavy stands exactly when its row function does, never added again over it"
							)
							assert.equal(
								after.domain === before.domain,
								keptBy(c, "domain"),
								"the roster domain's CHECK stands exactly when its live-codes constant does, never added again over it"
							)
							assert.equal(
								after.bits === before.bits,
								bitsKeptBy(c),
								"the roster's bits domain stands, renamed with its roster, exactly when its width does"
							)
							assert.equal(
								after.sets === before.sets,
								bitsKeptBy(c) && keptBy(c, "sets"),
								"the bits domain's CHECK stands exactly when its domain and its live-codes constant do, never added again over it"
							)
							assert.deepEqual(
								[after.flags.attnum, after.flags.type],
								[before.flags.attnum, after.bits],
								"flags keeps its attribute number and is typed by the bits domain the migration leaves"
							)
							assert.equal(
								before.flags.type,
								before.bits,
								"flags is typed by the roster's bits domain"
							)
							if (keptBy(c, "wt") && keptBy(c, "bonus") && bitsKeptBy(c)) {
								assert.equal(
									after.relfilenode,
									before.relfilenode,
									"Item is not rewritten when both its generations' row functions and flags' domain stand"
								)
								assert.deepEqual(
									after.xmins,
									before.xmins,
									"no row of Item is updated when both its generations' row functions and flags' domain stand"
								)
							}
							if (keptBy(c, "heavy") && keptBy(c, "domain") && keptBy(c, "sets") && bitsKeptBy(c)) {
								assert.ok(
									!validates(next.folder),
									"the migration validates nothing when heavy, the roster domain's CHECK and the bits domain's CHECK stand"
								)
							}
							const stored = yield* rowsOf(m, owner, Option.none())
							assert.deepEqual(
								stored,
								modelRows(c, false),
								"every stored row's wt and bonus are the second version's values at its code"
							)
							const probed = yield* attempt(writer, [
								insertItem(m, c.stored.length + 1, c.probe, c.second.handles.length)
							])
							if (probeAdmitted(c)) {
								assert.deepEqual(
									probed,
									{ kind: "committed" },
									"the writer stores a row heavy admits"
								)
							} else {
								k.note("the writer refused by the CHECK")
								assert.ok(
									probed.kind === "refused" && probed.fields.code === sqlstates.checkViolation,
									`the writer's row is refused by heavy: ${probed.kind === "refused" ? probed.fields.code : "it committed"}`
								)
							}
							const reader = yield* sessionOf(m, first.reader, "reader")
							const read = yield* rowsOf(m, reader, Option.some(first.reader))
							assert.deepEqual(
								read,
								modelRows(c, probeAdmitted(c)),
								"the reader reads every row through its view, each wt and bonus the model's"
							)
							const fresh = yield* installFirst("row_renames_fresh", (name) =>
								versionOf(name, c.second, c.bound)
							)
							const freshHeld = yield* heldOf(
								fresh.m,
								fresh.m.names,
								owner,
								c.second.roster,
								fresh.first
							)
							assert.deepEqual(
								Arr.map(everyCaller, (caller) => [caller, after.called[caller].executes]),
								Arr.map(everyCaller, (caller) => [caller, freshHeld.called[caller].executes]),
								"the writer's and the reader's EXECUTE on each caller's function is a fresh installation's"
							)
							yield* sameCatalog(
								next.plan.installation,
								fresh.m.installation,
								"the migrated second version against a fresh one"
							)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's dependencies, OIDs, relfilenodes and xmins of the functions and what calls them against the content model, its verdicts on the migration and the writer, its privileges, and its catalog against a fresh installation's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original:
					'\t\t\tconst to = namespace === "function" ? renamedTo.get(name.name) : undefined',
				replacement: "\t\t\tconst to = undefined",
				why: "A renamed function's grants, PUBLIC revoke and comment left under its previous name: the draft revokes EXECUTE on a name the rename took away, and the migration fails, 42883."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\t\tfound.set(create.name.name, prior)\n",
				replacement: "",
				why: "A row function a roster's rename leaves unchanged is never found by its definition under the previous names, so the migration creates it anew beside the old one: Item's generations and heavy call a new function, heavy is added again NOT VALID and validated, and the generations are set again, a rewrite of Item."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\t\t\tfound.set(target, prior)\n",
				replacement: "",
				why: "A renamed roster's names and live-codes constants are never found under its previous name, so the migration creates them anew: the roster domain's CHECK is re-pointed at a new live-codes constant, dropped, added NOT VALID and validated, a scan of every column the domain types."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\tconst prior = heldRows.find((h) => h === restated && !renamedFrom(h))",
				replacement: "\t\tconst prior = heldRows.find((h) => !renamedFrom(h))",
				why: "A held row function paired with a target whatever its content, so a roster's rename beside a change of Weight's or Bonus's rows renames the old function and replaces its body in place: the generation or heavy keeps the function's OID, which the model holds a new function, and heavy is never validated over the new weights."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\t\treturn holder === undefined ||",
				replacement: "\t\t\treturn true ||",
				why: "A renamed roster's bits domain left under its previous name, so the migration creates the target's bits domain anew and converts flags to it (ALTER COLUMN TYPE), a rewrite of Item, its CHECK added and validated again: flags' type and the domain's OID move."
			}
		]
	})
