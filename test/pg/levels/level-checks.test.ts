/**
 * A level's row check over a relation of the level below it, on PostgreSQL 19rc2.
 *
 * Each case draws a base level `Base` holding Attribute (an integer key, an unbounded text `value` and an integer `n`),
 * its own row checks over Attribute, and a level `Media` over it whose list states row checks over Attribute too, each a
 * predicate over the row: `Compute.matches(value, pattern)` over a pattern drawn over one of the text generators'
 * alphabets, `n` compared with a small literal, and NOT, AND and OR over them.
 *
 * 1. Through both levels' logins. The installation's history adds Media by a migration over the installed Base, the
 *    migrated catalog compared with a fresh install's, and serves a login over each level: the author's over Base and the
 *    editor's over Media, both inserting Attribute. Each drawn row, breaking any subset of Base's checks and Media's, is
 *    inserted through each login. Oracle: the predicates evaluated on the host (`holds`, each match by ECMAScript's own
 *    test, test/support/regex.ts jsMatcher):
 *    - a row every check holds on is stored through both;
 *    - through the editor's login, whose compile holds every check, a row that breaks some is refused naming `every`
 *      check it breaks, each by its CHECK on Attribute's table as constraintNamesOf names it, its witness the row's key;
 *    - through the author's login, whose compile holds Base's checks alone, the refusal names Base's checks the row
 *      breaks exactly as the host judges them, with the row's key, whatever Media's: `every`, those checks, where
 *      PostgreSQL named one of them; or `above`, Media's one check PostgreSQL named first, a check the row breaks, as
 *      Media names it and by its CHECK, then `own: "every"` and those checks with the row's key where the row breaks
 *      some, and `own: "none"` with no witness where it breaks none;
 *    - the snapshot lists each of Media's checks under Media and none under Base, and Attribute's table holds exactly
 *      the CHECKs constraintNamesOf names for Base's checks and Media's.
 * 2. Through migrations. Base alone is installed and its rows seeded; the migration to Media and its checks applies
 *    exactly when every stored row holds every check, and is refused otherwise in its Validate file, by SQLSTATE 23514
 *    naming the CHECK of a check some stored row breaks, every row left as it was; once the reviewer deletes the
 *    breaking rows it applies. Base's record in the snapshot (its name, schema, fingerprint and laws) is the same as in
 *    the installation without Media, and Attribute's table holds exactly Media's CHECKs; a direct writer's row is then
 *    refused, by the CHECK of a check it breaks, exactly when the host finds one broken. The migration that removes
 *    Media's checks drops them: Attribute's table holds no CHECK, Base's record is still the same, and every refused
 *    row is stored. Oracle: the same host evaluation.
 *
 * Every constraint name is read through constraintNamesOf and every table and column through the installation's names.
 * Each check's name starts with a drawn initial, so Base's and Media's CHECKs interleave in the order PostgreSQL tries
 * them, and a row breaking both meets either first.
 *
 * Features: an unbounded text matched by a pattern in a level's check, a row such a match refuses, each login's
 * refusal by each kind of check, the author's own checks named beside Media's and Media's alone, two checks broken at
 * once, a row stored through both logins; for the migrations, the migration refused by a stored row and applied over
 * lawful ones, a probe refused and one stored.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Option, Result } from "effect"
import { applyOnSession } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { Db } from "#adapter/public/db.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import type { Law, RefusedLaw } from "#compiler/public/changeset.ts"
import { constraintNamesOf, lawsOf } from "#compiler/public/schema.ts"
import {
	Attribute,
	byCheck,
	checkLaw,
	checksOn,
	holds,
	inValidate,
	keyOf,
	lawsNamed,
	levelRecord,
	levelsAt,
	type LoginsFeature,
	migrationCase,
	type MigrationFeature,
	named,
	probeKeys,
	readsMatch,
	type Row,
	steeredLogins
} from "#test/pg/levels/level-checks.fixtures.ts"
import {
	openMigrator,
	parsedTarget,
	type TextTarget,
	writtenTexts
} from "#test/pg/migrate/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { installedCodes, levelNameAt } from "#test/support/compile.ts"
import {
	installMigrated,
	installMigratedThrough,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import { atName, namesOf } from "#test/support/kernel/naming.ts"
import {
	compile,
	draftCodes,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A level's row check over a lower relation on PostgreSQL 19rc2 stores exactly the rows every check holds on, and each login names the checks a row breaks as its level states them.
 *
 * Its pre-conversion budget: runs 8, coverage cases 24 (test/pg/levels/level-checks.test.ts at d8eed1786).
 */
export const aLevelsRowCheckOverALowerRelationOnPostgreSQL19rc2StoresExactlyTheRowsEveryCheckHoldsOnAndEachLoginNamesTheChecksARowBreaksAsItsLevelStatesThem =
	property.explore(steered(steeredLogins), {
		needs: { substrate: Substrate.installing },
		situations: [
			"an unbounded text matched by a pattern",
			"a row a level's match refuses",
			"a row stored through both logins",
			"refused through the editor",
			"two checks broken at once",
			"the author refused by its own check, a level's broken too",
			"the author refused by a level's check, its own broken too",
			"the author refused by a level's check alone"
		] satisfies ReadonlyArray<Reached<LoginsFeature>>,
		check:
			({ substrate }, c: Case<LoginsFeature>) =>
			(k) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const own = named("Own", k.own)
							const level = named("Level", k.level)
							const declared = levelsAt("LevelChecks", own, level)
							const done = yield* installMigratedThrough(
								[
									{
										schema: declared.base,
										logins: [declared.authorApp],
										declarations: noDeclarations
									},
									{
										schema: declared.media,
										logins: [declared.authorApp, declared.editorApp],
										declarations: noDeclarations
									}
								],
								{
									label: "level_checks",
									extensions: [],
									ambient: ordinarySession,
									compile: compileInstallation,
									review: noPlaceholders
								}
							)
							const at = levelsAt(done.schema, own, level)
							const names = namesOf(done)
							const constraintNameOf = constraintNamesOf(at.media)
							const table = names.tableIdent(Attribute)
							const above = levelNameAt(done.schema, 1)
							const installedChecks = yield* checksOn(names)
							unorderedEqual(
								installedChecks,
								Arr.map([...own, ...level], (s) => constraintNameOf(checkLaw(s.name))),
								"Attribute's table holds exactly the CHECKs of Base's checks and Media's"
							)
							const ids = lawsOf(at.media)
							const idOf = (name: string) =>
								defined(
									Option.getOrUndefined(
										Arr.findFirst(ids, (l) => Option.isNone(exact(l.law, checkLaw(name))))
									),
									`lawsOf lists the check ${name}`
								).id
							const baseLaws = levelRecord(done.snapshot, 0).laws
							const mediaLaws = levelRecord(done.snapshot, 1).laws
							for (const s of level) {
								const id = idOf(s.name)
								assert.ok(
									Arr.some(mediaLaws, (l) => l === id) && !Arr.some(baseLaws, (l) => l === id),
									`the snapshot lists ${s.name} under Media alone`
								)
							}
							if (Arr.some(level, (s) => readsMatch(s.pred))) {
								c.note("an unbounded text matched by a pattern")
							}
							const authorServed = yield* servedFixture(done, at.authorApp)
							const editorServed = yield* servedFixture(done, at.editorApp)
							const authorContext = yield* Layer.build(authorServed.layer)
							const editorContext = yield* Layer.build(editorServed.layer)
							const author = yield* Db.open(authorServed.login.roles.author, {}).pipe(
								Effect.provideContext(authorContext)
							)
							const editor = yield* Db.open(editorServed.login.roles.editor, {}).pipe(
								Effect.provideContext(editorContext)
							)
							const constraintOf = (name: string) => constraintNameOf(checkLaw(name))
							/** Whether each law a refusal names is a check refused by its own CHECK. */
							const eachByItsCheck = (laws: ReadonlyArray<RefusedLaw<Law>>): boolean =>
								Arr.every(laws, (l) => {
									const stated = l.law.kind === "above" ? l.law.law : l.law
									return stated.kind === "check" && byCheck(l.by, table, constraintOf(stated.name))
								})
							for (const [i, row] of k.rows.entries()) {
								const where = `row ${i}, ${Formatter.format(row)}`
								const brokenOwn = Arr.filter(own, (s) => !holds(s.pred, row))
								const brokenLevel = Arr.filter(level, (s) => !holds(s.pred, row))
								const broken = [...brokenOwn, ...brokenLevel]
								const authorId = 2 * i
								const editorId = 2 * i + 1
								const byAuthor = yield* answered(
									author.workload.add.once({
										params: {},
										facts: {
											insert: { Attribute: [{ id: authorId, value: row.value, n: row.n }] }
										}
									})
								)
								const byEditor = yield* answered(
									editor.workload.add.once({
										params: {},
										facts: {
											insert: { Attribute: [{ id: editorId, value: row.value, n: row.n }] }
										}
									})
								)
								if (broken.length === 0) {
									assert.equal(byAuthor.kind, "accepted", `${where} through the author`)
									assert.equal(byEditor.kind, "accepted", `${where} through the editor`)
									c.note("a row stored through both logins")
									continue
								}
								if (Arr.some(brokenLevel, (s) => readsMatch(s.pred))) {
									c.note("a row a level's match refuses")
								}
								if (byEditor.kind !== "refused") {
									return assert.fail(
										`${where} through the editor answered ${Formatter.format(byEditor)}`
									)
								}
								assert.equal(
									byEditor.refused.kind,
									"every",
									`${where}: the editor judges every check`
								)
								unorderedEqual(
									lawsNamed(byEditor.refused.laws),
									Arr.map(broken, (s) => checkLaw(s.name)),
									`${where}: the editor names every check the row breaks`
								)
								assert.ok(
									eachByItsCheck(byEditor.refused.laws),
									`${where}: each check the editor names refused by its own CHECK`
								)
								assert.deepEqual(
									byEditor.witness,
									keyOf(editorId),
									`${where}: the editor's refusal witnessed by the row's key`
								)
								c.note("refused through the editor")
								if (broken.length > 1) {
									c.note("two checks broken at once")
								}
								if (byAuthor.kind !== "refused") {
									return assert.fail(
										`${where} through the author answered ${Formatter.format(byAuthor)}`
									)
								}
								const refused = byAuthor.refused
								const ownNamed = Arr.map(brokenOwn, (s) => checkLaw(s.name))
								assert.ok(
									eachByItsCheck(refused.laws),
									`${where}: each check the author names refused by its own CHECK`
								)
								switch (refused.kind) {
									case "every":
										assert.ok(
											brokenOwn.length > 0,
											`${where}: the author names its own checks only where the row breaks one`
										)
										unorderedEqual(
											lawsNamed(refused.laws),
											ownNamed,
											`${where}: the author names every own check the row breaks`
										)
										assert.deepEqual(byAuthor.witness, keyOf(authorId), where)
										if (brokenLevel.length > 0) {
											c.note("the author refused by its own check, a level's broken too")
										}
										break
									case "above": {
										const [first, ...rest] = refused.laws
										const law = first.law
										assert.ok(
											law.level === above &&
												Arr.some(brokenLevel, (s) =>
													Option.isNone(exact(law.law, checkLaw(s.name)))
												),
											`${where}: one check of Media's the row breaks, named by Media: ${Formatter.format(law)}`
										)
										unorderedEqual(
											lawsNamed(rest),
											ownNamed,
											`${where}: beside it, every own check the row breaks`
										)
										if (brokenOwn.length > 0) {
											assert.equal(refused.own, "every", where)
											assert.deepEqual(byAuthor.witness, keyOf(authorId), where)
											c.note("the author refused by a level's check, its own broken too")
										} else {
											assert.equal(refused.own, "none", where)
											assert.deepEqual(byAuthor.witness, { kind: "unreported" }, where)
											c.note("the author refused by a level's check alone")
										}
										break
									}
									case "first":
									case "some":
										return assert.fail(
											`${where}: the author judges every own check, ${Formatter.format(refused)}`
										)
								}
							}
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the checks' predicates on the host, each match by ECMAScript's own test (holds): every check the row breaks through the editor; through the author, every own check it breaks, and Media's only as the one PostgreSQL named"
		},
		budget: { runs: 8, steered: 24 },
		kept: [],
		kills: []
	})

/**
 * A level's row check over a lower relation on PostgreSQL 19rc2 validates a level's checks against the stored rows when a migration adds them, drops them when one removes them, and leaves the lower level as it is without them.
 *
 * Its pre-conversion budget: runs 6, coverage cases 12 (test/pg/levels/level-checks.test.ts at d8eed1786).
 */
export const aLevelsRowCheckOverALowerRelationOnPostgreSQL19rc2ValidatesALevelsChecksAgainstTheStoredRowsWhenAMigrationAddsThemDropsThemWhenOneRemovesThemAndLeavesTheLowerLevelAsItIsWithoutThem =
	property.explore(migrationCase, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a migration refused by a stored row",
			"a migration applied over stored rows",
			"a probe refused",
			"a probe stored"
		] satisfies ReadonlyArray<Reached<MigrationFeature>>,
		check:
			({ substrate }, c: Case<MigrationFeature>) =>
			(k) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const s = yield* Substrate
							const level = named("Level", k.level)
							const done = yield* installMigrated(levelsAt("LevelChecks", [], []).base, {
								ambient: ordinarySession,
								label: "level_checks_migrate",
								logins: [],
								extensions: []
							})
							const names = namesOf(done)
							const table = names.table(Attribute)
							const columns = Arr.join(
								Arr.map(["id", "value", "n"] as const, (f) => names.column(Attribute, f)),
								", "
							)
							const insert = (id: number, row: Row) =>
								s.admin.query(`INSERT INTO ${table} (${columns}) VALUES ($1, $2, $3)`, [
									id,
									row.value,
									row.n
								])
							const contents = Effect.map(
								s.admin.queryValues(
									`SELECT ROW(${columns})::text AS r FROM ${table} ORDER BY r`,
									[]
								),
								(rows) => Arr.map(rows, (r) => String(r[0]))
							)
							const alone = yield* checksOn(names)
							assert.deepEqual(alone, [], "Base alone holds no CHECK on Attribute")
							for (const [i, row] of k.seeds.entries()) {
								yield* insert(i, row)
							}
							const stacked = levelsAt(done.schema, [], level).media
							const bare = levelsAt(done.schema, [], []).media
							const constraintNameOf = constraintNamesOf(stacked)
							const draft = (next: typeof stacked, previous: DeploySnapshot, timestamp: string) => {
								const codes = succeeded(draftCodes(next, fromSnapshot(previous), noDeclarations))
								return succeeded(
									generate({
										declared: noDeclarations,
										previous: fromSnapshot(previous),
										installation: compile(next, {
											schema: atName(done.schema),
											extensions: [],
											codes: installedCodes(codes)
										}),
										name: "levels",
										timestamp,
										workload: noWorkload
									})
								)
							}
							const added = draft(stacked, done.snapshot, "20261014000000")
							const addedTarget: TextTarget = {
								snapshot: added.snapshot,
								folders: [...done.folders, writtenTexts(added.folder)]
							}
							const migrator = yield* openMigrator(s, s.owner)
							const breaking = Arr.filter(k.seeds, (row) =>
								Arr.some(level, (l) => !holds(l.pred, row))
							)
							const before = yield* contents
							const first = yield* Effect.result(
								applyOnSession(migrator, [parsedTarget(addedTarget)])
							)
							if (breaking.length === 0) {
								assert.ok(
									Result.isSuccess(first),
									`the migration applies: ${Formatter.format(first)}`
								)
								if (k.seeds.length > 0) {
									c.note("a migration applied over stored rows")
								}
							} else {
								const failure: MigrateError | undefined = Result.isFailure(first)
									? first.failure
									: undefined
								const refusal = defined(failure, "the migration is refused by a stored row")
								const server = refusal.server
								const brokenNames = Arr.flatMap(level, (l) =>
									Arr.some(breaking, (row) => !holds(l.pred, row))
										? [constraintNameOf(checkLaw(l.name))]
										: []
								)
								assert.ok(
									server.by === "server" &&
										server.error.sqlstate === sqlstates.checkViolation &&
										server.error.table === names.tableIdent(Attribute) &&
										server.error.constraint !== undefined &&
										brokenNames.includes(server.error.constraint),
									`refused by the CHECK of a check a stored row breaks: ${Formatter.format(server)}`
								)
								assert.ok(
									inValidate(refusal.place),
									`refused in a Validate file: ${Formatter.format(refusal.place)}`
								)
								const after = yield* contents
								assert.deepEqual(after, before, "the refusal leaves every row as it was")
								c.note("a migration refused by a stored row")
								for (const [i, row] of k.seeds.entries()) {
									if (breaking.includes(row)) {
										yield* s.admin.query(
											`DELETE FROM ${table} WHERE ${names.column(Attribute, "id")} = $1`,
											[i]
										)
									}
								}
								yield* applyOnSession(migrator, [parsedTarget(addedTarget)])
							}
							assert.deepEqual(
								levelRecord(added.snapshot, 0),
								levelRecord(done.snapshot, 0),
								"Base's record is the one it has without Media"
							)
							const stackedChecks = yield* checksOn(names)
							unorderedEqual(
								stackedChecks,
								Arr.map(level, (l) => constraintNameOf(checkLaw(l.name))),
								"Attribute's table holds exactly Media's CHECKs"
							)
							const refused: Array<readonly [number, Row]> = []
							for (const [j, row] of k.probes.entries()) {
								const id = probeKeys + j
								const brokenNames = Arr.flatMap(level, (l) =>
									holds(l.pred, row) ? [] : [constraintNameOf(checkLaw(l.name))]
								)
								const probed = yield* Effect.result(insert(id, row))
								if (brokenNames.length === 0) {
									assert.ok(Result.isSuccess(probed), `probe ${Formatter.format(row)} is stored`)
									c.note("a probe stored")
									continue
								}
								const fields = Result.isFailure(probed) ? pgErrorFields(probed.failure) : undefined
								assert.equal(
									fields?.code,
									sqlstates.checkViolation,
									`probe ${Formatter.format(row)}`
								)
								assert.ok(
									fields?.constraint !== undefined && brokenNames.includes(fields.constraint),
									`probe ${Formatter.format(row)} refused by the CHECK of a check it breaks: ${Formatter.format(fields)}`
								)
								refused.push([id, row])
								c.note("a probe refused")
							}
							const removed = draft(bare, added.snapshot, "20261015000000")
							const removedTarget: TextTarget = {
								snapshot: removed.snapshot,
								folders: [...addedTarget.folders, writtenTexts(removed.folder)]
							}
							yield* applyOnSession(migrator, [parsedTarget(removedTarget)])
							assert.deepEqual(
								levelRecord(removed.snapshot, 0),
								levelRecord(done.snapshot, 0),
								"Base's record is still the one it has without Media's checks"
							)
							const droppedChecks = yield* checksOn(names)
							assert.deepEqual(
								droppedChecks,
								[],
								"the migration removing Media's checks drops their CHECKs"
							)
							for (const [id, row] of refused) {
								yield* insert(id, row)
							}
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the checks' predicates on the host over every stored and probed row (holds): the migration applies exactly when no stored row breaks one, a probe is refused exactly when it breaks one, by its CHECK"
		},
		budget: { runs: 6, steered: 12 },
		kept: [],
		kills: []
	})
