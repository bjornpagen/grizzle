/**
 * A conjunction of patterns (str.and) across the engines that decide it: for drawn pairs and triples of patterns of
 * every regex family, on texts drawn over the family's alphabet and walked over each member's own automaton, five
 * answers agree on every text:
 *
 * 1. ECMAScript's membership of every member (test/support/regex.ts jsMatcher), the oracle;
 * 2. the host's membership of the conjunction (scalar/regex/patterns.ts), which the evaluator and the witness read;
 * 3. the canonical DFA of the members' intersection, where the analysis builds one, which keys the conjunction;
 * 4. PostgreSQL's own CHECK verdict: the domain the analysis's enforcement installs (an IN list, `VALUE ~ p AND VALUE ~
 *    q`, or no domain for a tautology), asked through pg_input_is_valid;
 * 5. every member's ARE alone under PostgreSQL's `~`, joined by AND.
 *
 * A conjunction no drawn text holds while its product proves it empty is refused, and a case reaches a text the first
 * member holds and the conjunction does not, so a CHECK of the first member alone fails here.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { everyProperty } from "#compiler/core/canonical.ts"
import { domainDigest } from "#compiler/core/fingerprint.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { createDomain } from "#compiler/physical/ddl/domains.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { emit, costChosen } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { textDomainDefinition } from "#compiler/text/membership.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import {
	caseGen,
	type ConjunctionFeature,
	dfaAccepts,
	jsAll,
	truth
} from "#test/pg/text/conjunction.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { textInfo } from "#test/support/text.ts"

/**
 * A conjunction of patterns: ECMAScript, host, product DFA and PostgreSQL's CHECK agree on drawn pairs and triples of every family's patterns.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/text/conjunction.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/text/conjunction.test.ts` at its budget
 *   before, `{ runs: 200, steered: 200 }`, each kill's verdict printed with where its witnesses went red (judgedLine
 *   with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget
 *   run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on case 3 of its floor stream
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 4 cases: 13; no headroom:
 *   a kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const aConjunctionOfPatternsECMAScriptHostProductDFAAndPostgreSQLsCHECKAgreeOnDrawnPairsAndTriplesOfEveryFamilysPatterns =
	property.explore(caseGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a pair",
			"a triple",
			"a domain of several patterns",
			"an IN list of the intersection",
			"keyed by the intersection's automaton",
			"a text the first member holds and the conjunction does not",
			"a text of the conjunction",
			"refused as matching no text"
		] satisfies ReadonlyArray<Reached<ConjunctionFeature>>,
		budget: { runs: 13, steered: 200 },
		check:
			({ tx }, k: Case<ConjunctionFeature>) =>
			({ family, patterns, texts }) =>
				Effect.gen(function* () {
					const { session: db, schema: allocate } = yield* tx
					const schema = yield* allocate("conjunction")
					yield* db.query(`CREATE SCHEMA ${quoteIdent(schema)}`, [])

					const label = `${family} ${Formatter.format(patterns)}`
					k.note(patterns.length === 2 ? "a pair" : "a triple")
					const loc = SourceLoc("str.and", [family])
					const analyzed = analyzeText(patterns, loc)
					const ofAll = jsAll(patterns)
					if (!analyzed.ok) {
						if (
							Arr.every(patterns, (p) => analyzeText([p], loc).ok) &&
							analyzed.error.reason._tag === "UnsupportedOperation"
						) {
							k.note("refused as matching no text")
							assert.ok(
								Arr.every(texts, (t) => !ofAll(t)),
								`${label} is refused as empty, and holds no drawn text`
							)
						}
						return
					}
					const r = analyzed.value
					if (r.known.kind === "automaton") {
						k.note("keyed by the intersection's automaton")
					}
					if (r.check.kind === "regex" && r.check.ares.length > 1) {
						k.note("a domain of several patterns")
					}
					if (r.check.kind === "finite") {
						k.note("an IN list of the intersection")
					}
					const regex = textInfo(r)
					const host = new CompilePatterns()
					const named = identity.textDomain(domainDigest({ label }, everyProperty))
					const domainType =
						r.check.kind === "tautology"
							? "text"
							: `${quoteIdent(schema)}.${quoteIdent(named.identifier)}`
					if (r.check.kind !== "tautology") {
						const ddl = createDomain(
							textDomainDefinition(r.check),
							{ schema, name: named.identifier },
							() => identity.domainCheck(named).identifier
						)
						yield* db.query(succeeded(emit(ddl, emptyNameMap, costChosen)).text, [])
					}
					const all = ["", ...texts]
					const rows = yield* db.values(
						`SELECT pg_input_is_valid(c.v, $2::text)::text,
									   (SELECT bool_and(c.v COLLATE pg_catalog.pg_c_utf8 ~ a.are)
									    FROM jsonb_array_elements_text($3::text::jsonb) AS a(are))::text
									 FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord`,
						[
							jsonText(Arr.map(all, (v, ord) => ({ ord, v }))),
							domainType,
							jsonText(Arr.map(r.members, (m) => m.are))
						]
					)
					assert.equal(rows.length, all.length, label)
					const ofFirst = jsAll([patterns[0]])
					for (const [i, row] of rows.entries()) {
						const t = defined(all[i], "a drawn text")
						const where = `${label} on ${Formatter.format(t)}`
						const expected = ofAll(t)
						if (expected) {
							k.note("a text of the conjunction")
						} else if (ofFirst(t)) {
							k.note("a text the first member holds and the conjunction does not")
						}
						assert.equal(
							typeof regex === "string" || host.member(regex, t),
							expected,
							`${where}: the host`
						)
						if (r.known.kind === "automaton") {
							assert.equal(dfaAccepts(r.known.dfa, t), expected, `${where}: the intersection's DFA`)
						}
						assert.equal(truth(row[0]), expected, `${where}: the domain's CHECK`)
						assert.equal(truth(row[1]), expected, `${where}: every member's ARE`)
					}
				}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's domain CHECK, beside ECMAScript's membership of every member"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/text/membership.ts",
				original:
					'\t\t\treturn mapNonEmpty(check.ares, (are) => binary("~", value, lit.text(are, types.text)))',
				replacement: '\t\t\treturn [binary("~", value, lit.text(check.ares[0], types.text))]',
				why: "A conjunction's domain CHECK holding its first member alone."
			}
		]
	})
