/**
 * A level's row check over a relation of the level below it, on PostgreSQL 19rc1.
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
 *    test, test/unit/text/generators.ts jsMatcher):
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
 *
 * Plants (~/.cache/grizzle-release/LEVELCHECK/plants): levelcheck-lower-level (a level's check over a lower relation
 * stated at that relation's level, so the installation without the level would hold it), levelcheck-negated (a row
 * check's CHECK holds the negation of its predicate), levelcheck-dropped-on-migrate (a migration adds no CHECK to a
 * table that stands), levelcheck-unvalidated (a CHECK a migration adds over stored rows is never validated),
 * levelcheck-valid-inline (a CHECK a migration adds over stored rows is validated in its Structure file, not its
 * Validate file), levelcheck-own-dropped (a lower login's own checks go unnamed when a level's check refused the row),
 * levelcheck-refused (a row check over a lower relation refused as LevelRefused).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { exact } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Result, String as Str } from "effect"
import { applyOnSession } from "#adapter/migrate/apply.ts"
import type { MigrateError, MigrationPlace } from "#adapter/migrate/errors.ts"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import { Db } from "#adapter/public/db.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import {
	ChangeSet,
	type Law,
	type RefusedLaw,
	type RefusingObject,
	type Witness
} from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	check,
	constraintNamesOf,
	lawIdsOf,
	login,
	relation,
	role,
	type Statement,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
import { folderSource, openMigrator } from "#test/pg/migrate/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { installedCodes, levelNameAt } from "#test/support/compile.ts"
import { installMigrated, installMigratedThrough } from "#test/support/install-migrate.ts"
import { atName, type Names, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	compile,
	draftCodes,
	fromSnapshot,
	generate,
	noDeclarations,
	ownedBy
} from "#test/support/migrate/kit.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	admittedPatternOver,
	families,
	jsMatcher,
	stringsOver
} from "#test/unit/text/generators.ts"

/** Text of no byte bound: a query matches no pattern over it, and a row check matches any. */
const Wild = str.regex("^.*$", "su")
const Attribute = relation("Attribute", { id: pg.integer, value: Wild, n: pg.integer }, ["id"])
/** Media's own relation, which no check reads. */
const Note = relation("Note", { id: pg.integer }, ["id"])

type AttributeRow = RowScalars<typeof Attribute>

/** A leaf of a check's predicate: a match of the row's unbounded text, or its integer compared with a literal. */
type Leaf =
	| { readonly kind: "matches"; readonly pattern: string }
	| { readonly kind: "compare"; readonly op: "le" | "ge"; readonly n: number }

/** A check's predicate: a leaf, or NOT, AND and OR over predicates. */
type Pred =
	| Leaf
	| { readonly kind: "not"; readonly arg: Pred }
	| { readonly kind: "and" | "or"; readonly left: Pred; readonly right: Pred }

/** A row a case inserts: its text and its integer, its key the case's own. */
interface Row {
	readonly value: string
	readonly n: number
}

/** The patterns a case's matches draw from: admitted ones over its family's alphabet, by construction. */
const patternGen = (alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	admittedPatternOver(alphabet)

const small = int(-3, 3)

/** A predicate nested at most `depth` levels over the alphabet's patterns: a leaf three times in five at each level. */
const predGen = (alphabet: Arr.NonEmptyReadonlyArray<number>, depth: number): Gen<Pred> => {
	const leaf = weighted<Pred>([
		[3, map(patternGen(alphabet), (pattern): Pred => ({ kind: "matches", pattern }))],
		[
			2,
			(source) => ({
				kind: "compare",
				op: source.draw(element<"le" | "ge">(["le", "ge"])),
				n: source.draw(small)
			})
		]
	])
	if (depth === 0) {
		return leaf
	}
	const inner = predGen(alphabet, depth - 1)
	return weighted<Pred>([
		[3, leaf],
		[1, (source) => ({ kind: "not", arg: source.draw(inner) })],
		[
			1,
			(source) => ({
				kind: source.draw(element<"and" | "or">(["and", "or"])),
				left: source.draw(inner),
				right: source.draw(inner)
			})
		]
	])
}

/** How deep a check's predicate nests. */
const predDepth = 2

/** A family's alphabet, by its index among the text generators' families. */
const alphabetOf = (family: number): Arr.NonEmptyReadonlyArray<number> =>
	defined(families[family], `the text family ${family}`).alphabet

const familyGen = int(0, families.length - 1)

const rowGen =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<Row> =>
	(source) => ({ value: source.draw(stringsOver(element(alphabet), 6)), n: source.draw(small) })

/** The predicate as a row check's callback writes it. */
const build = (p: Pred, a: AttributeRow): Predicate => {
	switch (p.kind) {
		case "matches":
			return Compute.matches(a.value, Compute.pattern(p.pattern))
		case "compare":
			return a.n[p.op](p.n)
		case "not":
			return a.not(build(p.arg, a))
		case "and":
		case "or":
			return a[p.kind](build(p.left, a), build(p.right, a))
	}
}

/** The predicate on a row, in two-valued logic over its NOT NULL fields, each match by ECMAScript's own test. */
const holds = (p: Pred, row: Row): boolean => {
	switch (p.kind) {
		case "matches":
			return jsMatcher(p.pattern, "u")(row.value)
		case "compare":
			return p.op === "le" ? row.n <= p.n : row.n >= p.n
		case "not":
			return !holds(p.arg, row)
		case "and":
			return holds(p.left, row) && holds(p.right, row)
		case "or":
			return holds(p.left, row) || holds(p.right, row)
	}
}

/** Whether a predicate matches the unbounded text. */
const readsMatch = (p: Pred): boolean => {
	switch (p.kind) {
		case "matches":
			return true
		case "compare":
			return false
		case "not":
			return readsMatch(p.arg)
		case "and":
		case "or":
			return readsMatch(p.left) || readsMatch(p.right)
	}
}

/** A check a case states: its declared name and its predicate. */
interface Stated {
	readonly name: string
	readonly pred: Pred
}

/**
 * The initial a check's name starts with, which orders its installed name among the table's others: PostgreSQL tries a
 * table's CHECKs in the order of their names, so Base's and Media's interleave as the draws fall.
 */
const initials = ["A", "M", "Z"] as const

/** A check as a case draws it: the initial of its name and its predicate. */
interface Drawn {
	readonly initial: (typeof initials)[number]
	readonly pred: Pred
}

const drawnGen =
	(pred: Gen<Pred>): Gen<Drawn> =>
	(source) => ({ initial: source.draw(element(initials)), pred: source.draw(pred) })

/** Checks named by their initial, `stem` and their position, one per drawn predicate. */
const named = (stem: string, drawn: ReadonlyArray<Drawn>): ReadonlyArray<Stated> =>
	Arr.map(drawn, (d, i) => ({ name: `${d.initial}${stem}${i}`, pred: d.pred }))

const statementsOf = (checks: ReadonlyArray<Stated>): Array<Statement> =>
	Arr.map(checks, (c) => check(c.name, Attribute, (a) => build(c.pred, a)))

/** A check of Attribute as an outcome names it. */
const checkLaw = (name: string): Extract<Law, { readonly kind: "check" }> => ({
	kind: "check",
	relation: "Attribute",
	name
})

/**
 * The two levels under `name`, the upper one under its allocated name (levelNameAt): Base with Attribute and its own
 * checks, Media over it with Note and its checks over Attribute; the author over Base and the editor over Media, each
 * inserting Attribute.
 */
const levelsAt = (name: string, own: ReadonlyArray<Stated>, level: ReadonlyArray<Stated>) => {
	const base = schema(name, { Attribute }, statementsOf(own))
	const media = schema.extend(base, levelNameAt(name, 1), { Note }, statementsOf(level))
	const author = role(base, "author", wholeEntriesOf(base), { write: writableNamesOf(base) })
	const editor = role(media, "editor", wholeEntriesOf(media), { write: ["Attribute"] })
	return {
		base,
		media,
		author,
		editor,
		authorApp: login(base, "author_app", [author], {
			workload: [workload(author, { add: ChangeSet.empty(base).insert(Attribute, []) })]
		}),
		editorApp: login(media, "editor_app", [editor], {
			workload: [workload(editor, { add: ChangeSet.empty(media).insert(Attribute, []) })]
		})
	}
}

/** Every CHECK constraint on Attribute's table, by name, as the owner reads the catalog. */
const checksOn = (names: Names) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rows = yield* s.admin.queryValues(
			"SELECT conname::text FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'",
			[names.table(Attribute)]
		)
		return Arr.map(rows, (r) => String(r[0]))
	})

/** Whether a refusal's object is the CHECK `name` on the table `table`. */
const byCheck = (by: RefusingObject, table: string, name: string): boolean =>
	by.kind === "constraint" && by.table === table && by.name === name

/** The laws a refusal names, each as an outcome describes it. */
const lawsNamed = (laws: ReadonlyArray<RefusedLaw<Law>>): ReadonlyArray<Law> =>
	Arr.map(laws, (l) => l.law)

/** A key witness of Attribute's row `id`. */
const keyOf = (id: number): Witness => ({ kind: "key", relation: "Attribute", values: { id } })

/** A case of the logins' property: Base's own checks, Media's, and the rows inserted through both logins. */
interface LoginsCase {
	readonly family: number
	readonly own: ReadonlyArray<Drawn>
	readonly level: Arr.NonEmptyReadonlyArray<Drawn>
	readonly rows: ReadonlyArray<Row>
}

const loginsCase: Gen<LoginsCase> = (source) => {
	const family = source.draw(familyGen)
	const alphabet = alphabetOf(family)
	const pred = drawnGen(predGen(alphabet, predDepth))
	return {
		family,
		own: source.draw(array(pred, { min: 0, max: 2 })),
		level: [source.draw(pred), ...source.draw(array(pred, { min: 0, max: 2 }))],
		rows: source.draw(array(rowGen(alphabet), { min: 1, max: 8 }))
	}
}

type LoginsFeature =
	| "an unbounded text matched by a pattern"
	| "a row a level's match refuses"
	| "a row stored through both logins"
	| "refused through the editor"
	| "two checks broken at once"
	| "the author refused by its own check, a level's broken too"
	| "the author refused by a level's check, its own broken too"
	| "the author refused by a level's check alone"

/** Media's checks over every row a migration case stores and probes. */
interface MigrationCase {
	readonly family: number
	readonly level: Arr.NonEmptyReadonlyArray<Drawn>
	readonly seeds: ReadonlyArray<Row>
	readonly probes: Arr.NonEmptyReadonlyArray<Row>
}

const migrationCase: Gen<MigrationCase> = (source) => {
	const family = source.draw(familyGen)
	const alphabet = alphabetOf(family)
	const pred = drawnGen(predGen(alphabet, predDepth))
	const row = rowGen(alphabet)
	return {
		family,
		level: [source.draw(pred), ...source.draw(array(pred, { min: 0, max: 2 }))],
		seeds: source.draw(array(row, { min: 0, max: 4 })),
		probes: [source.draw(row), ...source.draw(array(row, { min: 0, max: 3 }))]
	}
}

type MigrationFeature =
	| "a migration refused by a stored row"
	| "a migration applied over stored rows"
	| "a probe refused"
	| "a probe stored"

/** The first key a migration case's probes take, past every seed's. */
const probeKeys = 1000

/** Whether a migration's refusal stands in a drafted file of the Validate phase. */
const inValidate = (place: MigrationPlace): boolean =>
	(place.kind === "file" || place.kind === "statement") && Str.endsWith("-validate.sql")(place.file)

/** A level's record as the snapshot holds it, laws as their identities, for a comparison as a value. */
const levelRecord = (snapshot: DeploySnapshot, at: number) => {
	const level = defined(snapshot.levels[at], `the snapshot's level ${at}`)
	return {
		name: level.name,
		schema: level.schema,
		fingerprint: level.fingerprint,
		laws: Arr.map(level.laws, (l) => l.law)
	}
}

layer(Substrate.layer, { excludeTestServices: true })(
	"a level's row check over a lower relation on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"stores exactly the rows every check holds on, and each login names the checks a row breaks as its level states them",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/levels/level-checks logins",
							draw: drawn(loginsCase),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the checks' predicates on the host, each match by ECMAScript's own test (holds): every check the row breaks through the editor; through the author, every own check it breaks, and Media's only as the one PostgreSQL named"
							},
							coverage: required<LoginsFeature>(
								[
									"an unbounded text matched by a pattern",
									"a row a level's match refuses",
									"a row stored through both logins",
									"refused through the editor",
									"two checks broken at once",
									"the author refused by its own check, a level's broken too",
									"the author refused by a level's check, its own broken too",
									"the author refused by a level's check alone"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: { kind: "bounded", candidates: 10 },
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(k, c) =>
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
											label: "level-checks",
											extensions: [],
											ambient: ordinarySession,
											compile: compileInstallation
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
									const ids = lawIdsOf(at.media)
									const idOf = (name: string) =>
										defined(
											Option.getOrUndefined(
												Arr.findFirst(ids, (l) => Option.isNone(exact(l.law, checkLaw(name))))
											),
											`lawIdsOf lists the check ${name}`
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
											return (
												stated.kind === "check" && byCheck(l.by, table, constraintOf(stated.name))
											)
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
							)
					)
				)
		)

		it.effect(
			"validates a level's checks against the stored rows when a migration adds them, drops them when one removes them, and leaves the lower level as it is without them",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/levels/level-checks migrations",
							draw: drawn(migrationCase),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the checks' predicates on the host over every stored and probed row (holds): the migration applies exactly when no stored row breaks one, a probe is refused exactly when it breaks one, by its CHECK"
							},
							coverage: required<MigrationFeature>(
								[
									"a migration refused by a stored row",
									"a migration applied over stored rows",
									"a probe refused",
									"a probe stored"
								],
								{ cases: 12, sense: notesOnly }
							),
							kept: [],
							runs: 6,
							shrink: { kind: "bounded", candidates: 10 },
							concurrency: 1,
							steerEvery: 3,
							caseHang
						},
						(k, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const s = yield* Substrate
									const level = named("Level", k.level)
									const done = yield* installMigrated(levelsAt("LevelChecks", [], []).base, {
										ambient: ordinarySession,
										label: "level-checks-migrate",
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
									const draft = (
										next: typeof stacked,
										previous: DeploySnapshot,
										timestamp: string
									) => {
										const codes = succeeded(
											draftCodes(next, fromSnapshot(previous), noDeclarations)
										)
										return succeeded(
											generate({
												declared: noDeclarations,
												previous: fromSnapshot(previous),
												installation: compile(next, {
													schema: atName(done.schema),
													owner: ownedBy(s.owner.role),
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
									const addedTarget: MigrationTarget = {
										snapshot: added.snapshot,
										folders: [...done.folders, folderSource(added.folder)]
									}
									const migrator = yield* openMigrator(s, s.owner)
									const breaking = Arr.filter(k.seeds, (row) =>
										Arr.some(level, (l) => !holds(l.pred, row))
									)
									const before = yield* contents
									const first = yield* Effect.result(applyOnSession(migrator, [addedTarget]))
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
										yield* applyOnSession(migrator, [addedTarget])
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
											assert.ok(
												Result.isSuccess(probed),
												`probe ${Formatter.format(row)} is stored`
											)
											c.note("a probe stored")
											continue
										}
										const fields = Result.isFailure(probed)
											? pgErrorFields(probed.failure)
											: undefined
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
									const removedTarget: MigrationTarget = {
										snapshot: removed.snapshot,
										folders: [...addedTarget.folders, folderSource(removed.folder)]
									}
									yield* applyOnSession(migrator, [removedTarget])
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
							)
					)
				)
		)
	}
)
