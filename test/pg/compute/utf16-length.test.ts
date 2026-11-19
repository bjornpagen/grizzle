/**
 * Compute.utf16Length on PostgreSQL 19, against JavaScript's String.length: the UTF-16 code units Effect Schema's
 * isMinLength, isMaxLength and isLengthBetween count of a string.
 *
 * 1. The SQL a check holds (lower/conservative/expr/ops.ts utf16Units), over a batch of drawn texts in one round trip:
 *    PostgreSQL's value of it, and the host evaluator's over each text, are String.length of the text. A text's code
 *    points are drawn under per-case weights over the widths UTF-8 and UTF-16 write them in: ASCII, two bytes, three
 *    bytes up to U+FFFF itself, and the supplementary planes, two UTF-16 units each, the first plane and every one past
 *    it.
 * 2. Admission and storage: a relation Texts whose generated field `units` is utf16Length of its text, under a guard of
 *    the text's bytes, Compute.when(Compute.within(Compute.octetLength(text), low, high), () =>
 *    Compute.utf16Length(text), -1), or alone, the text's own type of no bound, a pattern's or a byte bound of its own,
 *    each bound drawn small or about regexTextMaxBytes. The schema compiles exactly when the bytes the guard or the
 *    text's own type bounds the text to are within regexTextMaxBytes; a refusal is PartialOperation of the bounded
 *    precondition whose remedy is the guard of the text's bytes at regexTextMaxBytes; and, installed, every drawn text of
 *    the text's own type is inserted, and its field holds String.length where the guard holds it and -1 elsewhere.
 *
 * Oracle: JavaScript's String.length, a second implementation of UTF-16's code units, and for admission the bounds the
 * case states.
 *
 * Features: each width of code point, U+FFFF, a code point past the first supplementary plane and the empty text in
 * the SQL's batches; each bound of the text's type and each side of the guard, a refusal, and an admission at the limit.
 */

import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { regexTextMaxBytes } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { textCell } from "#test/pg/compute/support.ts"
import {
	batch,
	type BoundFeature,
	boundOf,
	caseGen,
	hostUnits,
	inInstallation,
	interval,
	schemaOf,
	sourceBytes,
	sourceHolds,
	sql,
	type SqlFeature,
	sqlNotes,
	term
} from "#test/pg/compute/utf16-length.fixtures.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { assert } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { ownedInput } from "#test/support/policy.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Compute.utf16Length on PostgreSQL 19 PostgreSQL's and the host's count of a text's UTF-16 units are String.length.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/compute/utf16-length.test.ts at 22a8e17e9).
 */
export const computeUtf16LengthOnPostgreSQL19PostgreSQLsAndTheHostsCountOfATextsUTF16UnitsAreStringLength =
	property.explore(batch, {
		needs: { substrate: Substrate.installing },
		situations: [
			"an ASCII character",
			"a character of two bytes",
			"a character of three bytes",
			"U+FFFF",
			"a supplementary character",
			"a character past the first supplementary plane",
			"the empty text"
		] satisfies ReadonlyArray<Reached<SqlFeature>>,
		check:
			({ substrate }, k: CaseOf<SqlFeature>) =>
			(texts: ReadonlyArray<string>) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const db = yield* s.session(ownerSession())

						for (const feature of sqlNotes(texts)) {
							k.note(feature)
						}
						const rows = yield* db.values(sql, [jsonText(Arr.map(texts, (v, ord) => ({ ord, v })))])
						yield* agree<ReadonlyArray<bigint>>(
							[
								["String.length", Arr.map(texts, (text) => BigInt(text.length))],
								["PostgreSQL", Arr.map(rows, (row) => BigInt(textCell(row, 0)))],
								["the host", Arr.map(texts, (text) => hostUnits(term, text))]
							],
							ordered(exact)
						)
					}),
					Substrate,
					substrate
				),
		oracle: { kind: "second-implementation", name: "JavaScript's String.length" },
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: []
	})

/**
 * Compute.utf16Length on PostgreSQL 19 admits a count exactly over a text bounded within the regex engine's bytes, and stores String.length.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/compute/utf16-length.test.ts at 22a8e17e9).
 */
export const computeUtf16LengthOnPostgreSQL19AdmitsACountExactlyOverATextBoundedWithinTheRegexEnginesBytesAndStoresStringLength =
	property.explore(caseGen, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"a count under no guard",
			"refused, naming the bound",
			"admitted at the limit",
			"admitted by the guard's bound",
			"admitted by the text's own bound",
			"a text the guard holds, counted",
			"a text the guard keeps out, stored as the other value"
		] satisfies ReadonlyArray<Reached<BoundFeature>>,
		check:
			({ substrate2 }, k: CaseOf<BoundFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								if (c.guard.kind === "none") {
									k.note("a count under no guard")
								}
								const { Texts, value } = schemaOf(c)
								const schemaName = yield* substrate.schema({ create: false, label: "units" })
								const compiled = Result.flatMap(ownedInput(value), (owned) =>
									compileInstallation(owned, {
										...installOptions(owned),
										levels: [identity.schema(parsedSchemaName(schemaName))]
									})
								)
								const bound = boundOf(c)
								if (bound > regexTextMaxBytes) {
									assert.ok(
										!compiled.ok,
										"a count over a text past the regex engine's bytes is refused"
									)
									const reason = compiled.error.reason
									assert.ok(reason._tag === "PartialOperation", `refused as ${reason._tag}`)
									assert.equal(reason.precondition, "bounded")
									assert.deepEqual(reason.guard.remedy, {
										kind: "octets",
										bytes: regexTextMaxBytes
									})
									k.note("refused, naming the bound")
									return
								}
								assert.ok(
									compiled.ok,
									`a count over a bounded text compiles: ${compiled.ok ? "" : compiled.error.message}`
								)
								if (bound === regexTextMaxBytes) {
									k.note("admitted at the limit")
								}
								k.note(
									sourceBytes(c.source) <= interval(c.guard)[1]
										? "admitted by the text's own bound"
										: "admitted by the guard's bound"
								)
								const installation = compiled.value
								const names = installationNamesOf(installation)
								const texts = Arr.filter(c.texts, (t) => sourceHolds(c.source, t))
								const pinned = yield* substrate.admin.pin
								const problems = yield* inInstallation(
									pinned,
									installationSql(installation, substrate.database),
									Effect.gen(function* () {
										const refused: Array<string> = []
										for (const [i, text] of texts.entries()) {
											const verdict = yield* probe(
												pinned,
												`INSERT INTO ${names.table(Texts)} (${names.column(Texts, "id")}, ${names.column(Texts, "n")}, ${names.column(Texts, "text")}) VALUES (gen_random_uuid(), $1, $2)`,
												[i, text]
											)
											if (verdict.kind === "refused") {
												refused.push(`${Formatter.format(text)}: ${verdict.code}`)
											}
										}
										const rows = yield* pinned.queryValues(
											`SELECT ${names.column(Texts, "text")}, ${names.column(Texts, "units")}::text FROM ${names.table(Texts)} ORDER BY ${names.column(Texts, "n")}`,
											[]
										)
										const [low, high] = interval(c.guard)
										const stored = Arr.flatMap(rows, (row) => {
											const [text, units] = Arr.map(row, String)
											const counted = text ?? ""
											const bytes = utf8Length(counted)
											const held = bytes >= low && bytes <= high
											k.note(
												held
													? "a text the guard holds, counted"
													: "a text the guard keeps out, stored as the other value"
											)
											const expected = held ? String(counted.length) : "-1"
											return units === expected
												? []
												: [
														`${Formatter.format(counted)} stored ${Formatter.format(units)}, not ${expected}`
													]
										})
										return [...refused, ...stored]
									})
								)
								assert.deepEqual(problems, [])
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "specification",
			name: "the bounds the case states, and JavaScript's String.length"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: []
	})
