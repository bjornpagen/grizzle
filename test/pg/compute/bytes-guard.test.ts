/**
 * A guard of a text's bytes on PostgreSQL 19: a relation whose generated field casts its text into a str.bytes target,
 * under Compute.when(Compute.within(Compute.octetLength(x), low, high), () => Compute.cast(x, target), "") or with no
 * guard, the text's own type drawn of no bound, a pattern's bound, or a byte bound of its own, and the target n bytes
 * of every text.
 *
 * The oracle: the schema compiles exactly when the bytes the guard or the text's own type bounds the text to are at
 * most n, the bounds the case states, four bytes a code point for a pattern's (never the compiler's own reading); a
 * refusal is PartialOperation of the language precondition whose remedy is the guard of the text's bytes at n; and,
 * installed, every drawn text, ASCII to four-byte code points, is inserted, and its generated field holds what the host
 * computes, the text where its bytes lie in the guard's interval and "" elsewhere, which the target's domain holds, so
 * no insert is refused.
 *
 * Features: each bound of the text's type and each side of the guard's interval a case reaches.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import {
	admitted,
	caseGen,
	type Feature,
	inInstallation,
	interval,
	schemaOf,
	sourceBytes,
	sourceHolds
} from "#test/pg/compute/bytes-guard.fixtures.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { ownedInput } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A guard of a text's bytes on PostgreSQL 19 admits a cast into str.bytes exactly when the guard's bound is within the target's, and stores what the host computes.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/compute/bytes-guard.test.ts at c568eb123).
 */
export const aGuardOfATextsBytesOnPostgreSQL19AdmitsACastIntoStrBytesExactlyWhenTheGuardsBoundIsWithinTheTargetsAndStoresWhatTheHostComputes =
	property.explore(caseGen, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"a cast under no guard",
			"refused, naming the bound",
			"admitted by the guard's bound",
			"admitted by the text's own bound",
			"a text the guard holds, stored",
			"a text the guard keeps out, stored as the other value"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, k: CaseOf<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								if (c.guard.kind === "none") {
									k.note("a cast under no guard")
								}
								const { Texts, value } = schemaOf(c)
								const schemaName = yield* substrate.schema({ create: false, label: "bytes" })
								const compiled = Result.flatMap(ownedInput(value), (owned) =>
									compileInstallation(owned, {
										...installOptions(owned),
										levels: [identity.schema(parsedSchemaName(schemaName))]
									})
								)
								if (!admitted(c)) {
									assert.ok(!compiled.ok, "the cast past the target's bytes is refused")
									const reason = compiled.error.reason
									assert.ok(reason._tag === "PartialOperation", `refused as ${reason._tag}`)
									assert.equal(reason.precondition, "language")
									assert.deepEqual(reason.guard.remedy, { kind: "octets", bytes: c.target })
									k.note("refused, naming the bound")
									return
								}
								assert.ok(
									compiled.ok,
									`the cast within the target's bytes compiles: ${compiled.ok ? "" : compiled.error.message}`
								)
								k.note(
									sourceBytes(c.source) <= c.target
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
											`SELECT ${names.column(Texts, "text")}, ${names.column(Texts, "stored")} FROM ${names.table(Texts)} ORDER BY ${names.column(Texts, "n")}`,
											[]
										)
										const [low, high] = interval(c.guard)
										const stored = Arr.flatMap(rows, (row) => {
											const [text, out] = Arr.map(row, String)
											const bytes = utf8Length(text ?? "")
											const held = bytes >= low && bytes <= high
											k.note(
												held
													? "a text the guard holds, stored"
													: "a text the guard keeps out, stored as the other value"
											)
											const expected = held ? text : ""
											return out === expected
												? []
												: [
														`${Formatter.format(text)} stored ${Formatter.format(out)}, not ${Formatter.format(expected)}`
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
			name: "the bounds the case states and the host's guard"
		},
		budget: { runs: 60, steered: 60 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/compute/bytes-guard.test.ts#aGuardOfATextsBytesOnPostgreSQL19AdmitsACastIntoStrBytesExactlyWhenTheGuardsBoundIsWithinTheTargetsAndStoresWhatTheHostComputes:-:3.14.0.0.14.1.0"
				),
				reason:
					"FULLSUITE3's red at TEST_SEED=2458139245: a text of str.bytes(40) cast into its own type under a guard of its bytes within [0, 0], once refused as MalformedDescription at physical names, since the branch's coercion into the conditional's type, the guard's language, named a text domain no field declares",
				since: "2026-11-19"
			}
		],
		kills: []
	})
