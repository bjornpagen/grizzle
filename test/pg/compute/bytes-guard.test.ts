/**
 * A guard of a text's bytes on PostgreSQL 19: a relation whose generated field casts its text into a str.bytes target,
 * under Logic.when(Num.within(Text.octetLength(x), low, high), () => Type.cast(x, target), "") or with no
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
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import {
	admitted,
	caseGen,
	type Feature,
	interval,
	schemaOf,
	sourceBytes,
	sourceHolds
} from "#test/pg/compute/bytes-guard.fixtures.ts"
import { inInstallation } from "#test/pg/compute/support.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { ownedInput } from "#test/support/policy.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A guard of a text's bytes on PostgreSQL 19 admits a cast into str.bytes exactly when the guard's bound is within the target's, and stores what the host computes.
 *
 * Its budget is the runner's (fastcycle's cull): its evidence is its kept case, FULLSUITE3's red, a real bug, and its
 * fix (0baff5d6e) reverted where it still applies, a binary coercion typed by its target itself, no longer reddens it:
 * `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/bytes-guard.test.ts` judged that kill survived
 * every witness (~/.cache/grizzle-release/CULL-COMPUTE/kills-bytes-guard.log, 2026-11-23), so no kill re-plants the
 * catch cleanly and no smaller budget is measured.
 */
export const aGuardOfATextsBytesOnPostgreSQL19AdmitsACastIntoStrBytesExactlyWhenTheGuardsBoundIsWithinTheTargetsAndStoresWhatTheHostComputes =
	property.explore(caseGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a cast under no guard",
			"refused, naming the bound",
			"admitted by the guard's bound",
			"admitted by the text's own bound",
			"a text the guard holds, stored",
			"a text the guard keeps out, stored as the other value"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ tx }, k: CaseOf<Feature>) =>
			(c) =>
				Effect.gen(function* () {
					const { bare, database, schema } = yield* tx
					return yield* Effect.scoped(
						Effect.gen(function* () {
							if (c.guard.kind === "none") {
								k.note("a cast under no guard")
							}
							const { Texts, value } = schemaOf(c)
							const schemaName = yield* schema("bytes")
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
							const problems = yield* inInstallation(
								bare,
								installationSql(installation, database),
								Effect.gen(function* () {
									const refused: Array<string> = []
									for (const [i, text] of texts.entries()) {
										const verdict = yield* probe(
											bare,
											`INSERT INTO ${names.table(Texts)} (${names.column(Texts, "id")}, ${names.column(Texts, "n")}, ${names.column(Texts, "text")}) VALUES (gen_random_uuid(), $1, $2)`,
											[i, text]
										)
										if (verdict.kind === "refused") {
											refused.push(`${Formatter.format(text)}: ${verdict.code}`)
										}
									}
									const rows = yield* bare.queryValues(
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
		oracle: {
			kind: "specification",
			name: "the bounds the case states and the host's guard"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/compute/bytes-guard.test.ts#aGuardOfATextsBytesOnPostgreSQL19AdmitsACastIntoStrBytesExactlyWhenTheGuardsBoundIsWithinTheTargetsAndStoresWhatTheHostComputes:-:2.14.0.0.14.1.0"
				),
				reason:
					"FULLSUITE3's red at TEST_SEED=2458139245: a text of str.bytes(40) cast into its own type under a guard of its bytes within [0, 0], once refused as MalformedDescription at physical names, since the branch's coercion into the conditional's type, the guard's language, named a text domain no field declares",
				since: "2026-11-19"
			}
		],
		kills: []
	})
