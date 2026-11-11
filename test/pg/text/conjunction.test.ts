/**
 * A conjunction of patterns (str.and) across the engines that decide it: for drawn pairs and triples of patterns of
 * every regex family, on texts drawn over the family's alphabet and walked over each member's own automaton, five
 * answers agree on every text:
 *
 * 1. ECMAScript's membership of every member (generators.ts jsMatcher), the oracle;
 * 2. the host's membership of the conjunction (scalar/regex/patterns.ts), which the evaluator and the witness read;
 * 3. the canonical DFA of the members' intersection, where the analysis builds one, which keys the conjunction;
 * 4. PostgreSQL's own CHECK verdict: the domain the analysis's enforcement installs (an IN list, `VALUE ~ p AND VALUE ~
 *    q`, or no domain for a tautology), asked through pg_input_is_valid;
 * 5. every member's ARE alone under PostgreSQL's `~`, joined by AND.
 *
 * A conjunction no drawn text holds while its product proves it empty is refused, and a case reaches a text the first
 * member holds and the conjunction does not, so a CHECK of the first member alone fails here.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): conjunction-first-member.patch (a conjunction's domain CHECK holding
 * its first member alone).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { everyProperty } from "#compiler/core/canonical.ts"
import { domainDigest } from "#compiler/core/fingerprint.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { codePoints } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { PatternSource, Patterns } from "#compiler/ir/scalar.ts"
import { has } from "#compiler/scalar/regex/charset.ts"
import type { CanonicalDfa } from "#compiler/scalar/regex/dfa.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { analyzeText, textDomainDdl } from "#compiler/text/refinement.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { textInfo } from "#test/support/text.ts"
import {
	type Family,
	families,
	finiteLanguageOver,
	flagsGen,
	jsMatcher,
	mostFiniteMembers,
	patternOver,
	stringsOver,
	walkGen
} from "#test/unit/text/generators.ts"

/**
 * A member of a drawn conjunction: one of its family's own patterns, one generated over its alphabet, or a finite
 * language over it, which the generated ones rarely spell.
 */
const memberGen =
	(family: Family): Gen<PatternSource> =>
	(source) => {
		const origin = source.draw(element(["written", "generated", "finite"] as const))
		if (origin === "written" && Arr.isReadonlyArrayNonEmpty(family.patterns)) {
			const [written, flags] = source.draw(element(family.patterns))
			return { source: written, flags }
		}
		return {
			source:
				origin === "finite"
					? source.draw(finiteLanguageOver(family.alphabet, mostFiniteMembers)).source
					: source.draw(patternOver(family.alphabet)),
			flags: source.draw(flagsGen)
		}
	}

/** A drawn case: a family, two or three patterns of it, and texts over its alphabet and each member's walks. */
interface ConjunctionCase {
	readonly family: string
	readonly patterns: Patterns
	readonly texts: ReadonlyArray<string>
}

const caseGen: Gen<ConjunctionCase> = (source) => {
	const family = source.draw(element(families))
	const patterns: Patterns = [
		source.draw(memberGen(family)),
		source.draw(memberGen(family)),
		...source.draw(array(memberGen(family), { min: 0, max: 1 }))
	]
	const walks = Arr.flatMap(patterns, (p) => {
		const parsed = parsePattern(p.source, p.flags)
		return parsed.ok && parsed.value.kind !== "never"
			? Arr.flatMap(source.draw(array(walkGen(buildNfa(parsed.value)), { min: 0, max: 12 })), (w) =>
					w === undefined ? [] : [w]
				)
			: []
	})
	return {
		family: family.name,
		patterns,
		texts: [
			...source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 120 })),
			...walks
		]
	}
}

/** Whether ECMAScript finds every member of a conjunction in a text, each member compiled once. */
const jsAll = (patterns: ReadonlyArray<PatternSource>): ((text: string) => boolean) => {
	const matchers = Arr.map(patterns, (p) => jsMatcher(p.source, p.flags))
	return (text) => Arr.every(matchers, (m) => m(text))
}

/** Whether a canonical DFA, which reads whole values, accepts `text`. */
const dfaAccepts = (dfa: CanonicalDfa, text: string): boolean =>
	Option.exists(
		Arr.reduce(codePoints(text), Arr.head(dfa.states), (state, c) =>
			Option.flatMap(state, (s) =>
				Option.flatMap(
					Arr.findFirst(s.edges, (e) => has(e.set, c)),
					(e) => Arr.get(dfa.states, e.to)
				)
			)
		),
		(s) => s.accept
	)

const truth = (value: unknown): boolean => {
	if (value === "true") {
		return true
	}
	if (value === "false") {
		return false
	}
	throw new Error(`expected a boolean text, got ${String(value)}`)
}

type ConjunctionFeature =
	| "a pair"
	| "a triple"
	| "a domain of several patterns"
	| "an IN list of the intersection"
	| "keyed by the intersection's automaton"
	| "a text the first member holds and the conjunction does not"
	| "a text of the conjunction"
	| "refused as matching no text"

layer(Substrate.layer)(
	"a conjunction of patterns: ECMAScript, host, product DFA and PostgreSQL's CHECK",
	(it) => {
		it.effect("agree on drawn pairs and triples of every family's patterns", (ctx) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				const db = yield* s.session(ownerSession())
				return yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "postgresql",
								name: "PostgreSQL 19's domain CHECK, beside ECMAScript's membership of every member"
							},
							suite: "pg/text/conjunction",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<ConjunctionFeature>(
								[
									"a pair",
									"a triple",
									"a domain of several patterns",
									"an IN list of the intersection",
									"keyed by the intersection's automaton",
									"a text the first member holds and the conjunction does not",
									"a text of the conjunction",
									"refused as matching no text"
								],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ family, patterns, texts }, k) =>
							Effect.gen(function* () {
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
								const { regex } = textInfo(r)
								const host = new CompilePatterns()
								yield* db.begin
								yield* Effect.gen(function* () {
									const named = identity.textDomain(domainDigest({ label }, everyProperty))
									const domainType =
										r.check.kind === "tautology"
											? "text"
											: `${quoteIdent(schema)}.${quoteIdent(named.identifier)}`
									if (r.check.kind !== "tautology") {
										const ddl = textDomainDdl(r.check, {
											schema,
											name: named.identifier,
											constraint: identity.domainCheck(named).identifier
										})
										yield* db.query(succeeded(emit(ddl, emptyNameMap)).text, [])
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
											regex === "wildcard" || host.member(regex, t),
											expected,
											`${where}: the host`
										)
										if (r.known.kind === "automaton") {
											assert.equal(
												dfaAccepts(r.known.dfa, t),
												expected,
												`${where}: the intersection's DFA`
											)
										}
										assert.equal(truth(row[0]), expected, `${where}: the domain's CHECK`)
										assert.equal(truth(row[1]), expected, `${where}: every member's ARE`)
									}
								}).pipe(Effect.ensuring(Effect.ignore(db.rollback)))
							})
					)
				)
			})
		)
	}
)
