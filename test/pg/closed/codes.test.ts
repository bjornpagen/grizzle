/**
 * Closed ids as codes on PostgreSQL 19: a roster's smallint domain, its names constant, the decoded column of a role
 * view, and a set's bit string, each judged against A8's model of the roster's history (test/support/closed/generate.ts),
 * a list of code slots replayed command by command that shares no code with the engine's codebook.
 *
 * The rosters are every hole pattern of a 5-code roster: 31 rosters, mask m live exactly at the codes whose bit m sets,
 * each reached as a deployment reaches it, by installing every code and then migrating with the holes' handles removed
 * (patternHistory), installed once per member as two templates, before the migration and after it
 * (codes.fixtures.ts codesInstalledTemplate, codesMigratedTemplate). Each pattern's codes hold plain names in an order its mask rotates, so no name says its code and
 * no two rosters agree on which name a code holds.
 *
 * Properties, and the oracle each is checked against:
 *
 * 1. The view's decoded column `<f>_name`, PostgreSQL's decode of a stored code through the names constant, equals the
 *    host's decode of the same code (the column's codec), for every row: two implementations of one decode, and both the
 *    model's handle.
 * 2. A direct writer's code is accepted exactly when the model says it is live; every other code of −1 … size, and
 *    400, is refused with 23514 on the roster domain's CHECK, the domain its data type. PostgreSQL is the judge. Bound:
 *    every code from −1 to size, then 400, for every hole pattern of a 5-code roster, exhausted (248 cases).
 * 3. A migration that removes a handle a row still holds fails at the domain's VALIDATE with 23514, naming the table and
 *    the column; once a data step removes those rows it applies. Every table holding a removed code is named once, and no
 *    other: set equality against the model.
 * 4. A roster's constants are never dropped under what reads them: DROP FUNCTION … RESTRICT on the live-codes constant,
 *    which the domain's CHECK depends on by pg_depend (8), and on the names constant, which the view's decoded column
 *    does, fails with 2BP01, and RESTRICT keeps each.
 * 5. A backend that cached a domain's CHECK before a migration swapped it judges the next write by the new one: the
 *    same session, open across the migration, answers (2) exactly as a fresh one. Each pattern is a case of its own, on
 *    a clone of its own of the installation, so the session it holds across the migration is the case's own.
 * 6. A role without EXECUTE on the constant its use of a roster's codes reads is refused with 42501, a writer without the
 *    live-codes constant at the domain's CHECK and a reader without the names constant at its view's decoded column;
 *    with the installed grants both pass, every role that writes a roster's codes holding EXECUTE on its live-codes
 *    constant and every role that decodes them on its names constant.
 * 7. A set round-trips through its bit(n) column, n its codes rounded up to whole bytes: the text the writer
 *    sends is X then the hex digits of the model's positional text (setText), PostgreSQL stores the positional text,
 *    and the host decodes it to the set sent. After the roster grows, the column is a domain over bit(n′), every stored
 *    set padded with 0s to it, and decodes unchanged; after a removal, VALIDATE names the column of every set that still
 *    holds the removed handle, the data step clears its bit, and the domain then refuses a set holding it.
 * 8. The live-codes constant is the model's live codes as a set's bits, the one function its domain's CHECK depends on;
 *    the names constant is the model's names in code order, a hole the empty name, a 1-based name[] of `size` elements,
 *    the one name[] function its view's decoded column depends on: each an IMMUTABLE function of no argument and no SET
 *    clause. After a migration the schema holds exactly the names constants its views read, as a set, every replaced
 *    one dropped.
 *
 * The bar's mixed-radix alias: a column typed bare smallint, with the roster domain left off (the mutant that drops the
 * domain from a column), accepts 400, which (2) refuses, so (2) kills it.
 *
 * Features: each code's cause (below, past, a hole, the alias), a literal aligned and shifted, and patterns of no hole,
 * one and more; the VALIDATE search's named tables; the bits histories' growth past and within a byte, a removal
 * refused until its data step, and two migrations.
 */
import { assert, defined, nonEmpty, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { scalarReader } from "#compiler/codec/read.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { codebookOf } from "#compiler/deploy/snapshot/build.ts"
import { type Codebook, codecOf } from "#compiler/ir/codes.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	applyNext,
	type BitsFeature,
	bitsHistories,
	causeOf,
	codeCaseGen,
	type CodeFeature,
	codeType,
	columnTypeOf,
	decodedColumn,
	domainCheckOf,
	domainOf,
	type Drafted,
	draftNext,
	grantCases,
	type Grantee,
	granteeRole,
	holeDrops,
	insertCode,
	installedProbes,
	codesInstalledTemplate,
	installFirst,
	judgeCode,
	membersOf,
	migratedProbes,
	codesMigratedTemplate,
	modelNames,
	modelText,
	namesHeld,
	nextOf,
	noteReached,
	patternCases,
	patterns,
	probeOf,
	probesOf,
	probeTable,
	serverOf,
	sessionOf,
	setsOf,
	setType,
	sortedHandles,
	stepped,
	subsetsOf,
	useCodes,
	validateCaseGen,
	type ValidateFeature,
	validateFeatures,
	wireText,
	ownerSessionOf
} from "#test/pg/closed/codes.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { setText, setWidth } from "#test/support/closed/bit-text.ts"
import {
	liveConstantOf,
	liveHeld,
	modelLive,
	namesConstantOf
} from "#test/support/closed/constants.ts"
import {
	type RosterFeature,
	type RosterState,
	codeAt,
	everyCode,
	holeFeature,
	holesOf,
	literalFeature,
	liveOf,
	patternHistory,
	sizeOf
} from "#test/support/closed/generate.ts"
import { parsedName, roleNamesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { expectConstraint, expectSqlstate, inTransaction } from "#test/support/substrate/expect.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { outputText } from "#test/support/wire.ts"

/**
 * A roster's domain admits exactly its live codes in a fresh backend, each case on the worker's seat of the migrated
 * installation, whose drafted codebook holds the model's codes.
 *
 * Its pre-conversion budget: the box (test/pg/closed/codes.test.ts at 5124bea5d), whose cases a backend that had
 * cached the CHECK before the migration judged too (aStaleBackendJudgesByTheCheckTheMigrationSwappedIn).
 */
export const aRostersDomainAdmitsExactlyItsLiveCodes = property.exhaust(finite(codeCaseGen), {
	needs: { codes: Substrate.seat(codesMigratedTemplate) },
	situations: [
		"below",
		"past",
		"hole",
		"alias",
		"literal aligned",
		"literal shifted",
		"holes 0",
		"holes 1",
		"holes 2+"
	] satisfies ReadonlyArray<Reached<CodeFeature>>,
	check:
		({ codes }, kase: Case<CodeFeature>) =>
		(c) =>
			Effect.scoped(
				Effect.flatMap(codes, (seat) =>
					Effect.provideService(
						Effect.gen(function* () {
							const m = seat.value
							noteReached(
								kase,
								c.live === undefined
									? [holeFeature(c.state), causeOf(c.state, c.code)]
									: literalFeature(c.state, c.live)
							)
							assert.deepEqual(
								codecOf(
									codebookOf(m.snapshot),
									Roster.of(c.state.closed, "ordered", liveOf(c.state))
								).names,
								modelNames(c.state),
								"the drafted codebook holds the model's codes"
							)
							const fresh = yield* sessionOf(m, migratedProbes(m.declared).writer, "fresh writer")
							yield* judgeCode(m, fresh, c)
						}),
						Substrate,
						seat.substrate
					)
				)
			),
	oracle: {
		kind: "postgresql",
		name: "the domain accepts exactly the codes the history model holds live"
	},
	box: "every code from −1 to size, then 400, of every hole pattern of a 5-code roster",
	kept: [],
	kills: []
})

/**
 * A backend that cached a roster's CHECK before the migration swapped it judges every code of the roster by the new
 * one, each pattern a case on a clone of its own of the installation, where the session opens, judges every installed
 * code, and stays open across the migration.
 *
 * Its pre-conversion budget: the box of every pattern's codes (test/pg/closed/codes.test.ts at 5124bea5d), judged there
 * by one backend open across one migration of every pattern; here each pattern's case migrates its own clone.
 */
export const aStaleBackendJudgesByTheCheckTheMigrationSwappedIn = property.exhaust(
	finite(patternCases),
	{
		needs: { codes: Substrate.freshOf(codesInstalledTemplate) },
		situations: ["holes 0", "holes 1", "holes 2+"] satisfies ReadonlyArray<Reached<RosterFeature>>,
		check:
			({ codes }, kase: Case<RosterFeature>) =>
			(state) =>
				Effect.scoped(
					Effect.flatMap(codes, (clone) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = clone.value
								kase.note(holeFeature(state))
								const history = patternHistory(state)
								const stale = yield* sessionOf(
									m,
									installedProbes(m.declared).writer,
									"cached writer"
								)
								for (const code of upTo(sizeOf(history.installed), (c) => c)) {
									yield* judgeCode(m, stale, {
										state: history.installed,
										code,
										live: Arr.getUnsafe(liveOf(history.installed), code)
									})
								}
								yield* applyNext(m, [yield* nextOf(m)])
								for (const entry of everyCode(state)) {
									yield* judgeCode(m, stale, { state, code: entry.code, live: entry.live })
								}
							}),
							Substrate,
							clone.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "the domain accepts exactly the codes the history model holds live"
		},
		box: "every hole pattern of a 5-code roster, each judged at every code from −1 to size, then 400",
		kept: [],
		kills: []
	}
)

/**
 * The view decodes every stored code as the host does, and the names constant names each code, a hole the empty name,
 * the one function its domain reads, which RESTRICT keeps, each case on the worker's seat of the migrated installation,
 * which holds exactly the names constants its domains read.
 *
 * Its pre-conversion budget: the box (test/pg/closed/codes.test.ts at 5124bea5d).
 */
export const theViewDecodesEveryStoredCodeAsTheHostDoesAndTheNamesConstantNamesEachCode =
	property.exhaust(finite(patternCases), {
		needs: { codes: Substrate.seat(codesMigratedTemplate) },
		situations: ["holes 0", "holes 1", "holes 2+"] satisfies ReadonlyArray<Reached<RosterFeature>>,
		check:
			({ codes }, c: Case<RosterFeature>) =>
			(state) =>
				Effect.scoped(
					Effect.flatMap(codes, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = seat.value
								const owner = yield* ownerSessionOf
								const last = migratedProbes(m.declared)
								const view = roleNamesOf(m, last.reader)
								const standing = yield* owner.values(
									`SELECT p.proname::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.prorettype = 'pg_catalog.name[]'::regtype`,
									[m.schema]
								)
								const read = yield* Effect.forEach(patterns, (s) =>
									namesConstantOf(owner, view.view(probeOf(s)))
								)
								unorderedEqual(
									Arr.dedupe(Arr.map(standing, (r) => String(r[0]))),
									Arr.dedupe(Arr.map(read, (k) => k.name)),
									"the schema holds exactly the names constants its views read, the migration having dropped every replaced one"
								)
								const writer = yield* sessionOf(m, last.writer, "writer")
								const reader = yield* sessionOf(m, last.reader, "reader")
								c.note(holeFeature(state))
								const live = liveOf(state)
								yield* writer.begin
								for (const [i, handle] of live.entries()) {
									yield* writer.query(insertCode(m, state), [i, defined(codeAt(state, handle))])
								}
								yield* writer.commit
								const codec = scalarReader(codeType(state), codebookOf(m.snapshot))
								const rows = yield* reader.values(
									`SELECT v.${view.column(probeOf(state), "code")}::text, v.${decodedColumn} FROM ${view.view(probeOf(state))} AS v ORDER BY v.${view.column(probeOf(state), "id")}`,
									[]
								)
								assert.deepEqual(
									Arr.map(rows, ([code, decoded]) => ({
										host: codec.convert(outputText(String(code))),
										postgres: String(decoded)
									})),
									Arr.map(live, (handle) => ({ host: handle, postgres: handle })),
									`every stored code of ${state.closed} decodes to its handle, on the host and in the view`
								)
								const columns = yield* owner.values(
									`SELECT a.attname::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = $1::text::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
									[view.view(probeOf(state))]
								)
								assert.deepEqual(
									Arr.map(columns, (r) => String(r[0])),
									[
										m.names.column(probeOf(state), "id"),
										m.names.column(probeOf(state), "code"),
										identifierOf(identity.decodedColumn(parsedName("code")))
									],
									`the view of ${state.closed} decodes its code in the column after it`
								)
								const names = yield* namesConstantOf(owner, view.view(probeOf(state)))
								const held = yield* namesHeld(reader, names.call)
								assert.deepEqual(
									held,
									{ lower: "1", cardinality: sizeOf(state), names: [...modelNames(state)] },
									`the names constant of ${state.closed}`
								)
								const liveConstant = yield* liveConstantOf(owner, domainOf(m, state))
								const bits = yield* liveHeld(writer, liveConstant.call)
								assert.equal(bits, modelLive(state), `the live-codes constant of ${state.closed}`)
								for (const constant of [names, liveConstant]) {
									yield* expectSqlstate(
										owner.query(`DROP FUNCTION ${constant.call} RESTRICT`, []),
										"2BP01"
									)
								}
								const after = yield* namesHeld(reader, names.call)
								assert.deepEqual(
									after,
									held,
									`RESTRICT keeps the names constant of ${state.closed}`
								)
								const kept = yield* liveHeld(writer, liveConstant.call)
								assert.equal(
									kept,
									bits,
									`RESTRICT keeps the live-codes constant of ${state.closed}`
								)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the host's decode of each stored code, and the history model's names in code order"
		},
		box: "every hole pattern of a 5-code roster",
		kept: [],
		kills: []
	})

/**
 * VALIDATE refuses a removed code a row still holds, naming its table and column, and the migration applies after the
 * data step, each case installing its own rosters on the worker's clone, as each case of the search did.
 *
 * Its pre-conversion budget: runs 4, coverage cases 12 (test/pg/closed/codes.test.ts at 5124bea5d).
 */
export const validateRefusesARemovedCodeARowStillHoldsAndTheMigrationAppliesAfterTheDataStep =
	property.explore(validateCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a table holding a removed code named",
			"a table of holes holding only live codes",
			"two tables named in turn"
		] satisfies ReadonlyArray<Reached<ValidateFeature>>,
		check:
			({ substrate }, k: Case<ValidateFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const states = nonEmpty(
								Arr.map(c.rosters, (r) => r.state),
								"a case's rosters"
							)
							const histories = Arr.map(states, patternHistory)
							const { m, first } = yield* installFirst("closed_codes_validate", (name) =>
								probesOf(
									name,
									Arr.map(histories, (h) => h.installed)
								)
							)
							const writer = yield* sessionOf(m, first.writer, "writer")
							yield* writer.begin
							for (const [r, h] of Arr.zip(c.rosters, histories)) {
								for (const code of r.held) {
									yield* writer.query(insertCode(m, h.installed), [code, code])
								}
							}
							yield* writer.commit
							const next = yield* draftNext(
								m,
								m.snapshot,
								probesOf(
									m.declared,
									Arr.map(histories, (h) => h.state)
								).version,
								2,
								holeDrops(states)
							)
							const holding = Arr.filter(c.rosters, (r) =>
								Arr.some(r.held, (code) => holesOf(r.state).includes(code))
							)
							const expected = Arr.map(holding, (r) => ({
								table: m.names.relation(probeOf(r.state)).name,
								column: m.names.column(probeOf(r.state), "code")
							}))
							const named: Array<{ readonly table: string; readonly column: string }> = []
							let applied = false
							for (let attempt = 0; !applied && attempt <= expected.length; attempt += 1) {
								const failure = yield* Effect.match(applyNext(m, [next]), {
									onSuccess: () => undefined,
									onFailure: (e) => e
								})
								if (failure === undefined) {
									applied = true
									continue
								}
								assert.equal(failure.stage, "statement", failure.message)
								const server = serverOf(failure)
								assert.equal(server.sqlstate, sqlstates.checkViolation, failure.message)
								const at = {
									table: defined(server.table, "VALIDATE names the table"),
									column: defined(server.column, "VALIDATE names the column")
								}
								named.push(at)
								const state = defined(
									Arr.findFirst(
										holding,
										(r) => m.names.relation(probeOf(r.state)).name === at.table
									).pipe(
										Option.map((r) => r.state),
										Option.getOrUndefined
									),
									`VALIDATE names a table holding a removed code: ${at.table}`
								)
								const p = probeTable(m, state)
								yield* m.owner.query(
									`DELETE FROM ${p.table} WHERE ${p.code} = ANY ($1::text::smallint[])`,
									[`{${Arr.join(Arr.map(holesOf(state), String), ",")}}`]
								)
							}
							assert.ok(applied, "the migration applies once no row holds a removed code")
							unorderedEqual(
								named,
								expected,
								"VALIDATE names every table holding a removed code, once each"
							)
							for (const r of c.rosters) {
								const p = probeTable(m, r.state)
								const stored = yield* m.owner.values(
									`SELECT ${p.code}::text FROM ${p.table} ORDER BY ${p.code}`,
									[]
								)
								assert.deepEqual(
									Arr.map(stored, (row) => Number(row[0])),
									Arr.filter(r.held, (code) => !holesOf(r.state).includes(code)),
									`${r.state.closed} keeps exactly its live codes' rows`
								)
							}
							k.noteAll(validateFeatures(c, named.length))
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the tables whose rows hold a code the history model removes"
		},
		show: Formatter.format,
		budget: { runs: 4, steered: 12 },
		kept: [],
		kills: []
	})

/**
 * A role without EXECUTE on the constant its use of a roster's codes reads is refused, a writer without the live-codes
 * constant at the domain's CHECK and a reader without the names constant at the view, and the installed grants give
 * each its own, each case on a clone of its own of the installation, whose grant it revokes and gives back.
 *
 * Its pre-conversion budget: the box (test/pg/closed/codes.test.ts at 5124bea5d).
 */
export const aRoleWithoutExecuteOnTheConstantItsCodesReadIsRefusedAndTheInstalledGrantsGiveItEach =
	property.exhaust(finite(grantCases), {
		needs: { codes: Substrate.freshOf(codesInstalledTemplate) },
		situations: ["writer", "reader"] satisfies ReadonlyArray<Reached<Grantee>>,
		check:
			({ codes }, kase: Case<Grantee>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(codes, (clone) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = clone.value
								const owner = yield* ownerSessionOf
								kase.note(c.grantee)
								const constant =
									c.grantee === "writer"
										? yield* liveConstantOf(owner, domainOf(m, c.state))
										: yield* namesConstantOf(
												owner,
												roleNamesOf(m, granteeRole(m, "reader")).view(probeOf(c.state))
											)
								const role = m.role(granteeRole(m, c.grantee))
								const held = yield* owner.values(
									`SELECT pg_catalog.has_function_privilege($1::text, $2::text::regprocedure, 'EXECUTE'), (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a WHERE a.grantee = 0) = 0 FROM pg_catalog.pg_proc AS p WHERE p.oid = $2::text::regprocedure`,
									[role, constant.call]
								)
								assert.deepEqual(
									defined(held[0], "the constant's grants"),
									[true, true],
									`the ${c.grantee} holds EXECUTE on the constant of ${c.state.closed} it reads, and PUBLIC nothing`
								)
								yield* owner.query(
									`REVOKE EXECUTE ON FUNCTION ${constant.call} FROM ${quoteIdent(role)}`,
									[]
								)
								const without = yield* sessionOf(
									m,
									granteeRole(m, c.grantee),
									`${c.grantee} without EXECUTE`
								)
								yield* expectSqlstate(useCodes(m, c.grantee, c.state, without), "42501")
								yield* without.rollback
								yield* owner.query(
									`GRANT EXECUTE ON FUNCTION ${constant.call} TO ${quoteIdent(role)}`,
									[]
								)
								const granted = yield* sessionOf(
									m,
									granteeRole(m, c.grantee),
									`${c.grantee} with EXECUTE`
								)
								yield* useCodes(m, c.grantee, c.state, granted)
							}),
							Substrate,
							clone.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's EXECUTE check of the function a domain's CHECK and a view call"
		},
		box: "every roster of every hole pattern's installation, and both roles that use its codes",
		kept: [],
		kills: []
	})

/**
 * A set round-trips through its bit(n) column, decodes unchanged after its roster grows, and a removed handle's bit
 * fails VALIDATE until the data step clears it, each case installing its own history on the worker's clone, as each
 * case of the search did.
 *
 * Its pre-conversion budget: runs 4, coverage cases 12 (test/pg/closed/codes.test.ts at 5124bea5d).
 */
export const aSetRoundTripsThroughItsBitColumnDecodesUnchangedAfterGrowthAndARemovedBitFailsValidateUntilTheDataStep =
	property.explore(bitsHistories, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a growth past a byte",
			"a growth within a byte",
			"a removal refused until the data step",
			"two migrations"
		] satisfies ReadonlyArray<Reached<BitsFeature>>,
		check:
			({ substrate }, k: Case<BitsFeature>) =>
			(history) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const { m, first } = yield* installFirst("closed_codes_bits", (name) =>
								setsOf(name, history.installed)
							)
							const writer = yield* sessionOf(m, first.writer, "writer")
							const reader = yield* sessionOf(m, first.reader, "reader")
							const view = roleNamesOf(m, first.reader)
							const table = printObjectName(m.names.relation("Sets"))
							const id = quoteIdent(m.names.column("Sets", "id"))
							const members = quoteIdent(m.names.column("Sets", "members"))
							/** Every stored set, by id, as PostgreSQL's text. */
							const storedTexts = Effect.map(
								m.owner.values(`SELECT ${members}::text FROM ${table} ORDER BY ${id}`, []),
								Arr.map((r) => String(r[0]))
							)
							/** Every set written so far, by id, as the model holds it: its live handles. */
							let stored: ReadonlyArray<ReadonlyArray<string>> = []
							/** Writes every subset of `state`'s live handles after the stored ones, sent as the host encodes them. */
							const writeEvery = (state: RosterState, codes: Codebook) =>
								Effect.gen(function* () {
									const codec = scalarCodec(setType(state), codes)
									const sets = subsetsOf(state)
									yield* writer.begin
									for (const [i, set] of sets.entries()) {
										const text = succeeded(codec.encode(new Set(set)), "a set of live handles")
										assert.equal(
											text,
											wireText(state, set),
											`the wire text of ${Formatter.format(set)}`
										)
										yield* writer.query(
											`INSERT INTO ${table} (${id}, ${members}) VALUES ($1::integer, $2::text::bit(${setWidth(sizeOf(state))}))`,
											[stored.length + i, text]
										)
									}
									yield* writer.commit
									stored = [...stored, ...Arr.map(sets, sortedHandles)]
									const texts = yield* storedTexts
									assert.deepEqual(
										Arr.drop(texts, texts.length - sets.length),
										Arr.map(sets, (set) => modelText(state, set)),
										"PostgreSQL stores each set's positional text"
									)
									assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
										decodes(state, codes, texts),
										stored,
										"every stored set decodes to its live handles"
									)
								})
							const decodes = (state: RosterState, codes: Codebook, texts: ReadonlyArray<string>) =>
								Arr.map(texts, (t) =>
									membersOf(scalarReader(setType(state), codes).convert(outputText(t)))
								)
							yield* writeEvery(history.installed, codebookOf(m.snapshot))
							const viewed = yield* reader.values(
								`SELECT v.${view.column("Sets", "members")}::text FROM ${view.view("Sets")} AS v ORDER BY v.${view.column("Sets", "id")}`,
								[]
							)
							const installedTexts = yield* storedTexts
							assert.deepEqual(
								Arr.map(viewed, (r) => String(r[0])),
								installedTexts,
								"the view reads the stored sets"
							)
							let before = history.installed
							let snapshot = m.snapshot
							const drafted: Array<Drafted> = []
							for (const [i, step] of history.steps.entries()) {
								const after = stepped(before, step)
								const next = yield* draftNext(
									m,
									snapshot,
									setsOf(m.declared, after).version,
									i + 2,
									step.kind === "remove"
										? {
												renames: [],
												drops: [{ kind: "handle", roster: after.closed, handle: step.handle }]
											}
										: noDeclarations
								)
								drafted.push(next)
								const textsBefore = yield* storedTexts
								if (step.kind === "remove") {
									/** Every subset was written, so a stored set holds the removed handle. */
									const failure = yield* Effect.flip(applyNext(m, drafted))
									const server = serverOf(failure)
									assert.deepEqual(
										{ sqlstate: server.sqlstate, table: server.table, column: server.column },
										{
											sqlstate: sqlstates.checkViolation,
											table: m.names.relation("Sets").name,
											column: m.names.column("Sets", "members")
										},
										"VALIDATE names the column of the sets that still hold the removed handle"
									)
									assert.ok(
										Str.includes("change or delete those rows in a data step first")(
											failure.message
										),
										`the refusal names its data step, before the migration or outside it: ${failure.message}`
									)
									/** A person's data step between the attempts: each set deleted and inserted again with the
									 * removed bit cleared, as an immutable relation's rows change outside a migration's bracketed
									 * steps. */
									const dataStep = `WITH gone AS (DELETE FROM ${table} RETURNING ${id}, ${members}) INSERT INTO ${table} (${id}, ${members}) SELECT ${id}, ${members} & $1::text::bit(${setWidth(sizeOf(after))}) FROM gone`
									yield* m.owner.query(dataStep, [
										setText(
											sizeOf(after),
											Arr.flatMap(after.slots, (slot, code) => (slot.kind === "live" ? [code] : []))
										)
									])
									k.note("a removal refused until the data step")
								}
								yield* applyNext(m, drafted)
								const afterType = yield* columnTypeOf(
									m.owner,
									table,
									m.names.column("Sets", "members")
								)
								assert.deepEqual(
									{ kind: afterType.kind, base: afterType.base },
									{ kind: "d", base: `bit(${setWidth(sizeOf(after))})` },
									"the column is a domain over bit(n), n the roster's codes in whole bytes"
								)
								const textsAfter = yield* storedTexts
								if (step.kind === "grow") {
									assert.deepEqual(
										textsAfter,
										Arr.map(textsBefore, (t) => Str.padEnd(setWidth(sizeOf(after)), "0")(t)),
										"the widening pads every stored set with the new code absent"
									)
									k.note(
										setWidth(sizeOf(after)) > setWidth(sizeOf(before))
											? "a growth past a byte"
											: "a growth within a byte"
									)
								} else {
									stored = Arr.map(stored, (set) => Arr.filter(set, (h) => h !== step.handle))
									const check = yield* domainCheckOf(m.owner, afterType.domain)
									const fields = yield* expectConstraint(
										inTransaction(
											writer,
											writer.query(
												`INSERT INTO ${table} (${id}, ${members}) VALUES ($1::integer, $2::text::bit(${setWidth(sizeOf(after))}))`,
												[-1, setText(sizeOf(after), [defined(codeAt(before, step.handle))])]
											)
										),
										check,
										"23514"
									)
									yield* writer.rollback
									assert.deepEqual(
										fields.dataType,
										Option.some(afterType.domain.name),
										"the bits domain refuses a set holding the removed handle"
									)
								}
								assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
									decodes(after, next.codes, textsAfter),
									stored,
									"every stored set decodes to its live handles under the step's codes"
								)
								yield* writeEvery(after, next.codes)
								before = after
								snapshot = next.snapshot
							}
							if (history.steps.length > 1) {
								k.note("two migrations")
							}
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the history model's positional text of each set, and its live handles after each step"
		},
		show: Formatter.format,
		budget: { runs: 4, steered: 12 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/errors.ts",
				original: '\t\t? "; change or delete those rows in a data step first',
				replacement: '\t\t? "; those rows',
				why: "A VALIDATE refused by rows holding a removed code names no data step: the person is never told to change those rows first, or outside the migration by delete and insert."
			}
		]
	})
