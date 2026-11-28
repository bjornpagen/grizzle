/**
 * A login's every answer is the same under any database defaults: its own defaults pin what its sessions resolve names
 * and print values under, and every session of its pool sends them again as startup options, so a login one of whose
 * pins is gone answers the same.
 *
 * Each case runs in a database of its own (Substrate.fresh), because a case sets that database's own defaults
 * (ALTER DATABASE ... SET), which every session that starts in the database while they stand starts under, and resets
 * each once its run ends: no other file's session starts there. Its cases run one at a time.
 *
 * The installation names its relations as PostgreSQL names its types, `Text`, `Uuid` and `Money`, so each relation's
 * row type shadows the builtin type of its name wherever the installation's schema comes first on a path. A case draws
 * an ambient session (test/support/ambient.ts), here the database's defaults: the installation's schemas first on the
 * search path or PostgreSQL's own path, and each print setting unset or at a value of its own; whether every pin of the
 * login stands, or one of them, its search_path's or a print setting's (physical/ddl/roles.ts roleDefaultSettings), is
 * reset (ALTER ROLE ... RESET); and a program of writes and reads through the
 * members of the login's full role's served workload, each write's rows its call's facts: the texts inserted twice, the second an exact repeat, links into them, perhaps one into no text,
 * which the containment refuses, amounts put twice over a mutable relation, money and both float widths among their
 * fields, then the links joined to their texts, every amount, the amounts at a money parameter and from a double one,
 * one amount by its key, and every page of the amounts ordered by the double.
 *
 * Property: with every pin standing or one reset, the program's every outcome and answer under the drawn defaults is exactly
 * its outcome and answer under the database's own defaults, from the same stored state; the amounts read under the
 * defaults are the facts the puts left.
 *
 * Every setting at every value it is drawn at is a required situation, beside the installation-first path, every pin
 * standing and each pin reset, a refused write and a later page.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Money, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { paged } from "#compiler/public/workload.ts"
import {
	absentText,
	aimedCaseGen,
	amountFacts,
	byId,
	danglingLink,
	databaseAmbient,
	type Feature,
	MoneyRelation,
	pinFeature,
	pinReset,
	type Program,
	sameId,
	settingFeature,
	Shadowed,
	situations,
	TextRelation,
	UuidRelation,
	walk
} from "#test/pg/adapter/login-ambient.fixtures.ts"
import { ambientFeatures } from "#test/support/ambient.ts"
import { writeAnswerOf, oneOf, rowsOf } from "#test/support/calls.ts"
import { installedSchemas, replaceMigrated } from "#test/support/install-migrate.ts"
import { installed } from "#test/support/pg/reads/support.ts"
import { pickFrom } from "#test/support/pick.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A login under hostile database defaults answers exactly as under the database's own defaults, with every pin or without one of them.
 *
 * Its pre-conversion budget: runs 16, coverage cases 64 (test/pg/adapter/login-ambient.test.ts at d8eed1786).
 */
export const aLoginUnderHostileDatabaseDefaultsAnswersExactlyAsUnderTheDatabasesOwnDefaultsWithEveryPinOrWithoutOneOfThem =
	property.explore(steered(aimedCaseGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, cx: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const o = yield* installed(
							Shadowed,
							{},
							{
								label: "login_ambient",
								programs: {
									addTexts: ChangeSet.empty(Shadowed).insert(TextRelation, []),
									addLinks: ChangeSet.empty(Shadowed).insert(UuidRelation, []),
									putAmounts: ChangeSet.empty(Shadowed).put(MoneyRelation, []),
									linkedNotes: query(Shadowed).rule((r) => {
										const link = v(UuidRelation, "link")
										const text = v(TextRelation, "text")
										return r
											.match(UuidRelation, { id: link.id, text: link.text })
											.match(TextRelation, { id: link.text, note: text.note })
											.find({ id: link.id, note: text.note })
									}),
									everyAmount: query(Shadowed).rule((r) => {
										const { id, amount, ratio, exact, flag } = v(MoneyRelation, "money")
										return r
											.match(MoneyRelation, { id, amount, ratio, exact, flag })
											.find({ id, amount, ratio, exact, flag })
									}),
									atAmount: query(Shadowed).rule((r) => {
										const { id, amount } = v(MoneyRelation, "money")
										return r
											.match(MoneyRelation, { id, amount })
											.where(r.eq(amount, r.param("at", pg.money)))
											.find({ id })
									}),
									fromExact: query(Shadowed).rule((r) => {
										const { id, exact } = v(MoneyRelation, "money")
										return r
											.match(MoneyRelation, { id, exact })
											.where(r.ge(exact, r.param("from", pg["double precision"])))
											.find({ id, exact })
									}),
									byExact: paged(
										query(Shadowed)
											.rule((r) => {
												const { id, amount, ratio, exact } = v(MoneyRelation, "money")
												return r
													.match(MoneyRelation, { id, amount, ratio, exact })
													.find({ id, amount, ratio, exact })
											})
											.orderBy(["exact", "desc"])
									),
									amount: MoneyRelation
								}
							}
						)
						const database = o.installed.database
						const schemas = installedSchemas(o.installed.installation)
						const login = o.installed.as(o.server).role
						/** The program's every outcome and answer, through a Db the login opens on a layer of its own. */
						const run = (p: Program) =>
							Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const texts = Arr.dedupeWith(p.texts, sameId)
								const links = [
									...Arr.map(byId(p.links), (l) => ({
										id: l.id,
										text: pickFrom(texts, l.pick).id
									})),
									...(p.dangling ? [{ id: danglingLink, text: absentText }] : [])
								]
								const writes = [
									yield* writeAnswerOf(
										db.workload.addTexts.once({ params: {}, facts: { insert: { Text: texts } } })
									),
									yield* writeAnswerOf(
										db.workload.addTexts.once({ params: {}, facts: { insert: { Text: texts } } })
									),
									yield* writeAnswerOf(
										db.workload.addLinks.once({ params: {}, facts: { insert: { Uuid: links } } })
									),
									yield* writeAnswerOf(
										db.workload.putAmounts.once({
											params: {},
											facts: { put: { Money: amountFacts(p.amounts) } }
										})
									),
									yield* writeAnswerOf(
										db.workload.putAmounts.once({
											params: {},
											facts: { put: { Money: amountFacts(p.revised) } }
										})
									)
								]
								return {
									writes,
									linked: yield* rowsOf(db.workload.linkedNotes.once({ params: {}, facts: {} })),
									amounts: yield* rowsOf(db.workload.everyAmount.once({ params: {}, facts: {} })),
									at: yield* rowsOf(
										db.workload.atAmount.once({ params: { at: Money.of(p.at) }, facts: {} })
									),
									from: yield* rowsOf(
										db.workload.fromExact.once({ params: { from: p.from }, facts: {} })
									),
									probed: yield* oneOf(
										db.workload.amount.once({ params: { id: p.probe }, facts: {} })
									),
									pages: yield* walk(
										(anchor) =>
											db.workload.byExact.once({
												params: {},
												facts: {},
												window: { anchor, size: p.pageSize }
											}),
										{ kind: "start" }
									)
								}
							}).pipe(withLayer(Layer.fresh(o.served.layer)))

						cx.noteAll(ambientFeatures(c.ambient))
						cx.noteAll(Arr.map(c.ambient.settings, settingFeature))
						cx.note(pinFeature(c.pin))
						yield* replaceMigrated(o.installed, {})
						const ordinary = yield* run(c.program)
						yield* replaceMigrated(o.installed, {})
						const hostile = yield* Effect.scoped(
							Effect.gen(function* () {
								yield* databaseAmbient(database, c.ambient, schemas)
								if (c.pin !== "standing") {
									yield* pinReset(login, c.pin)
								}
								return yield* run(c.program)
							})
						)
						assert.deepEqual(hostile.writes, ordinary.writes)
						unorderedEqual(hostile.linked, ordinary.linked)
						unorderedEqual(hostile.amounts, ordinary.amounts)
						unorderedEqual(hostile.at, ordinary.at)
						unorderedEqual(hostile.from, ordinary.from)
						assert.deepEqual(hostile.probed, ordinary.probed)
						assert.deepEqual(hostile.pages, ordinary.pages)
						unorderedEqual(
							Arr.map(ordinary.amounts, (row) => ({
								id: row.id,
								amount: row.amount,
								ratio: row.ratio,
								exact: row.exact,
								flag: row.flag
							})),
							amountFacts([...byId(c.program.revised), ...byId(c.program.amounts)])
						)
						if (Arr.some(ordinary.writes, (w) => w.kind === "refused")) {
							cx.note("a write refused by a law")
						}
						if (ordinary.pages.length > 1) {
							cx.note("a later page")
						}
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "universal",
			name: "the program under the drawn defaults answers as under the database's own"
		},
		budget: { runs: 16, steered: 64 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/adapter/login-ambient.test.ts#aLoginUnderHostileDatabaseDefaultsAnswersExactlyAsUnderTheDatabasesOwnDefaultsWithEveryPinOrWithoutOneOfThem:-:1.1.2.3.3.2.0.2.0.2.1.0.2.0.0.1.pa8.1.3.0.6.1.2.1.1.3.2.3.0.2.1.5.6.1.1.1.4.0.4.1.4.1.1.0"
				),
				reason:
					"every hostile default with the pin standing: the program's every answer is the defaults' answer",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/adapter/login-ambient.test.ts#aLoginUnderHostileDatabaseDefaultsAnswersExactlyAsUnderTheDatabasesOwnDefaultsWithEveryPinOrWithoutOneOfThem:-:1.1.2.3.3.2.1.0.2.0.2.1.0.2.0.0.1.pa8.1.3.0.6.1.2.1.1.3.2.3.0.2.1.5.6.1.1.1.4.0.4.1.4.1.1.0"
				),
				reason:
					"every hostile default with the search_path pin reset: the startup options pin the path, every answer is the defaults' answer",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/adapter/login-ambient.test.ts#aLoginUnderHostileDatabaseDefaultsAnswersExactlyAsUnderTheDatabasesOwnDefaultsWithEveryPinOrWithoutOneOfThem:-:1.1.2.3.3.2.1.1.2.0.2.1.0.2.0.0.1.pa8.1.3.0.6.1.2.1.1.3.2.3.0.2.1.5.6.1.1.1.4.0.4.1.4.1.1.0"
				),
				reason:
					"every hostile default with the extra_float_digits pin reset: the startup options pin float text to its round trip, every answer is the defaults' answer",
				since: "2026-11-19"
			}
		],
		kills: []
	})
