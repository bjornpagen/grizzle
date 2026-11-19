/**
 * Compute.translate and Compute.lowerAscii on PostgreSQL 19, against the host.
 *
 * 1. The SQL a check holds for a drawn map, `translate(v, from, to)`, for lowerAscii, for collapse and for
 *    replaceWhitespace, over a batch of texts that mix ASCII, Latin-1, BMP and supplementary code points in one round
 *    trip: PostgreSQL's answer must be the reference evaluator's character by character, lowerAscii's must leave every
 *    character but A to Z as it was, and collapse's, its chain of replace calls, must be XML Schema's (core/text.ts
 *    collapsed) over runs of each of the four white space characters, of three or more among them, at either end and
 *    beside supplementary code points.
 * 2. An installed relation whose generated fields translate a title into xs:normalizedString's value space, fold a
 *    tag's ASCII case and collapse a title's white space, each cast into its declared text type by the inclusion of the
 *    image, and a second relation whose generated field casts a numeral to a bigint: the installer's own DDL, each
 *    drawn row inserted. Three more fields stand a language only compilation proves beside a literal in a conditional:
 *    the translation's and the collapse's images under Compute.cond over a match of the tag, and a match guard's
 *    branch, the tag itself, under Compute.when. The conditional is of that language, which no field declares, so its
 *    branches meet it with no domain of it, and each is stored into a declared type. Every row is admitted, and its
 *    generated fields hold the host's values. No key holds a generated field (README, "How a field is written": no
 *    fact carries its value, so such a schema is refused when it compiles), so neither relation keys one.
 *
 * Oracle: the reference evaluator character by character, and XML Schema's collapse (grizzle-text text.ts collapsed).
 *
 * Features: each map and white space situation the searches name.
 */

import { codePoints, codePointsText, collapsed, translated } from "@bjornpagen/grizzle-text/text"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import {
	aimedSqlCase,
	asciiLower,
	inInstallation,
	translateInstallation,
	type InstalledFeature,
	isXmlSpace,
	judge,
	printed,
	rowGen,
	runNotes,
	type SqlFeature,
	text,
	textColumn,
	variable
} from "#test/pg/compute/translate.fixtures.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	lowerWith,
	plainRender,
	renderSql,
	spelledExpr,
	testPg,
	v
} from "#test/unit/compute/support.ts"

/**
 * Compute's translate and lowerAscii on PostgreSQL translate and lowerAscii agree with the host over mixed texts.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/compute/translate.test.ts at c568eb123).
 */
export const computesTranslateAndLowerAsciiOnPostgreSQLTranslateAndLowerAsciiAgreeWithTheHostOverMixedTexts =
	property.explore(steered(aimedSqlCase), {
		needs: { substrate: Substrate.installing },
		situations: [
			"a character replaced",
			"a capital lowered",
			"a non-ASCII character kept",
			"a repeated character read by its first",
			"a character deleted",
			"a run of white space folded",
			"white space trimmed at an end",
			"a run of three or more folded",
			"a tab in a run",
			"an LF in a run",
			"a CR in a run",
			"a space in a run",
			"a supplementary character beside white space"
		] satisfies ReadonlyArray<Reached<SqlFeature>>,
		check:
			({ substrate }, k: Case<SqlFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const db = yield* s.session(ownerSession())

						const lower = (desc: ExprDesc) => {
							const lowered = lowerWith("check", desc, { v: textColumn }, false, baseParams)
							if (!lowered.ok) {
								return assert.fail(`lowers: ${lowered.error.message}`)
							}
							return lowered.value.root.expr
						}
						const translation = lower({
							kind: "compute",
							fn: "translate",
							args: [variable("v"), text(codePointsText(c.from)), text(codePointsText(c.to))]
						})
						const folded = lower(spelledExpr(computeCore.lowerAscii(v("v", testPg.text)).expr))
						const collapse = lower(spelledExpr(computeCore.collapse(v("v", testPg.text)).expr))
						const replace = lower(
							spelledExpr(computeCore.replaceWhitespace(v("v", testPg.text)).expr)
						)
						const probes = [translation, folded, collapse, replace]
						const select = Arr.join(
							Arr.map(probes, (p) => `(${renderSql(p, plainRender)})::text`),
							", "
						)
						const rows = yield* db.values(
							`SELECT ${select}, pg_catalog.translate(r0.v, $2::text, $3::text) FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text) ORDER BY r0.ord`,
							[jsonText(Arr.map(c.texts, (value, ord) => ({ ord, v: value }))), c.rawFrom, c.rawTo]
						)
						const rawSources = codePoints(c.rawFrom)
						const rawTargets = codePoints(c.rawTo)
						assert.equal(rows.length, c.texts.length, "a row per input")
						for (const [i, row] of rows.entries()) {
							const input = defined(c.texts[i])
							for (const [j, p] of probes.entries()) {
								const host = evaluate(p, {
									kind: "row",
									column: () => input,
									param: () => undefined,
									regexMember: patternMember
								})
								if (host._tag !== "Success") {
									return assert.fail("the reference evaluates it")
								}
								assert.equal(
									row[j],
									printed(host.success),
									`${defined(["translate", "lowerAscii", "collapse", "replaceWhitespace"][j])} over ${Formatter.format(input)}: PostgreSQL against the host`
								)
							}
							assert.equal(row[1], asciiLower(input), `lowerAscii over ${Formatter.format(input)}`)
							if (row[0] !== input) {
								k.note("a character replaced")
							}
							if (row[1] !== input) {
								k.note("a capital lowered")
							}
							if (Arr.some(codePoints(input), (c) => c > 0x7f)) {
								k.note("a non-ASCII character kept")
							}
							assert.equal(row[2], collapsed(input), `collapse over ${Formatter.format(input)}`)
							const points = codePoints(input)
							if (Arr.some(points, (cp, i) => isXmlSpace(cp) && isXmlSpace(points[i + 1] ?? 0))) {
								k.note("a run of white space folded")
							}
							if (isXmlSpace(points[0] ?? 0) || isXmlSpace(points.at(-1) ?? 0)) {
								k.note("white space trimmed at an end")
							}
							for (const [i, cp] of points.entries()) {
								const before = isXmlSpace(points[i - 1] ?? 0)
								const after = isXmlSpace(points[i + 1] ?? 0)
								if (isXmlSpace(cp) && (before || after)) {
									k.note(runNotes.get(cp) ?? "a space in a run")
								}
								if (isXmlSpace(cp) && before && after) {
									k.note("a run of three or more folded")
								}
								if (cp > 0xffff && (before || after)) {
									k.note("a supplementary character beside white space")
								}
							}
							assert.equal(
								row[4],
								translated(input, c.rawFrom, c.rawTo),
								`translate(${Formatter.format(input)}, ${Formatter.format(c.rawFrom)}, ${Formatter.format(c.rawTo)}): PostgreSQL against the host`
							)
							for (const cp of codePoints(input)) {
								const first = rawSources.indexOf(cp)
								if (first >= 0 && rawSources.lastIndexOf(cp) !== first) {
									k.note("a repeated character read by its first")
								}
								if (first >= rawTargets.length) {
									k.note("a character deleted")
								}
							}
						}
					}),
					Substrate,
					substrate
				),
		oracle: { kind: "second-implementation", name: "the reference evaluator" },
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: []
	})

/**
 * Compute's translate and lowerAscii on PostgreSQL an installed translation, case fold, collapse and numeral cast store exactly the host's values.
 *
 * Its pre-conversion budget: runs 30, coverage cases 30 (test/pg/compute/translate.test.ts at c568eb123).
 */
export const computesTranslateAndLowerAsciiOnPostgreSQLAnInstalledTranslationCaseFoldCollapseAndNumeralCastStoreExactlyTheHostsValues =
	property.explore(rowGen, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"a title normalized",
			"a title collapsed",
			"a tag folded",
			"a numeral's leading zeros dropped",
			"a conditional's image stored, the tag lower case",
			"a conditional's literal stored, the tag not lower case"
		] satisfies ReadonlyArray<Reached<InstalledFeature>>,
		check:
			({ substrate2 }, c: Case<InstalledFeature>) =>
			(drawnRows) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const rows = Arr.map(drawnRows, (r, id) => ({ ...r, id }))
								const installation = yield* translateInstallation
								const pinned = yield* substrate.admin.pin
								const { problems, reached } = yield* inInstallation(
									pinned,
									installationSql(installation, substrate.database),
									judge(pinned, installation, rows)
								)
								c.noteAll(reached)
								assert.deepEqual(problems, [])
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "second-implementation",
			name: "the host's translation, case fold, collapse and numeral cast"
		},
		budget: { runs: 30, steered: 30 },
		kept: [],
		kills: []
	})
