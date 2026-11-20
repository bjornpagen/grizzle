/**
 * Fingerprints (core/fingerprint.ts): SHA-256 over the domain-separated canonical text, blind to source locations,
 * covering every part the contract names.
 *
 * - Parts: a schema level's fingerprint changes with its content and with a "loc" member that holds no SourceLoc, and
 *   not with its SourceLocs moved; stripping every SourceLoc leaves it as it was; and a level over a base is the text
 *   of the level encoded whole, the base's text standing for its content among its bases.
 * - Domains: two different one-line domains digest one value apart, and an empty domain or one of two lines is refused.
 *
 * Oracle: the fingerprint's contract as a specification: which change of the parts it names must move the digest, and
 * which must not; the level encoded whole as the differential for the level over its base.
 *
 * Features: each change of the parts (content, a non-SourceLoc loc, SourceLocs moved); two domains, an empty domain, a
 * domain of two lines.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Record } from "effect"
import { encode, everyProperty, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { digest, schemaLevel } from "#compiler/core/fingerprint.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	type Change,
	changed,
	changes,
	contentWith,
	type DomainFeature,
	domainGen,
	located,
	type Parts,
	partsGen,
	stripped
} from "#test/unit/core/fingerprint.fixtures.ts"

/** Fingerprints cover every part the contract names and nothing else. Its budget is its suite's before it was a property (test/unit/core/fingerprint.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const fingerprintsCoverEveryPartTheContractNamesAndNothingElse = property.explore(partsGen, {
	needs: {},
	budget: { runs: 400, steered: 400 },
	situations: changes satisfies ReadonlyArray<Reached<Change>>,
	check:
		(_, c: Case<Change>) =>
		([{ entries, locs }, change]) =>
			Effect.sync(() => {
				const [first, second] = locs
				const here = located(defined(first, "a location"))
				const there = located(defined(second, "a location"))
				const p: Parts = { content: contentWith(entries, here) }
				/** A non-SourceLoc loc is compared with another one, as content: Paris against Rome. */
				const before: Parts =
					change === "a non-SourceLoc loc"
						? { ...p, content: { ...Record.fromEntries(entries), loc: "Paris" } }
						: p
				const after = changed(before, change, there, entries)
				const schema = (q: Parts) => succeeded(schemaLevel(q.content, [])).fingerprint
				const schemaParts: ReadonlySet<Change> = new Set(["content", "a non-SourceLoc loc"])
				assert.equal(
					schema(after) !== schema(before),
					schemaParts.has(change),
					"the schema fingerprint"
				)
				assert.equal(schema({ ...before, content: stripped(before.content) }), schema(before))
				const above = { ...Record.fromEntries(entries), loc: there, bases: [before.content] }
				const written: string = succeeded(
					schemaLevel(above, [succeeded(schemaLevel(before.content, []))])
				).text
				assert.equal(
					written,
					succeeded(encode(above, withoutSourceLocs)),
					"a level over its base, its base written from the base's text, as it is encoded whole"
				)
				c.note(change)
			}),
	oracle: { kind: "specification", name: "the parts the fingerprint's contract names" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/canonical.ts",
			original: '\t(key === "loc" && isSourceLoc(value)) ||',
			replacement: '\tkey === "loc" ||',
			why: 'a "loc" member omitted whatever it holds, a SourceLoc or not; the parts property fails.'
		},
		{
			file: "packages/engine/src/core/fingerprint.ts",
			original:
				'\t\tencodeOver(level, withoutSourceLocs, new Map([["bases", arrayText(bases.map((b) => b.text))]])),',
			replacement:
				'\t\tencodeOver(level, { omit: () => false }, new Map([["bases", arrayText(bases.map((b) => b.text))]])),',
			why: "a level encoded with every property, its SourceLocs kept in the text; the parts property fails."
		},
		{
			file: "packages/engine/src/core/fingerprint.ts",
			original:
				'\t\tencodeOver(level, withoutSourceLocs, new Map([["bases", arrayText(bases.map((b) => b.text))]])),',
			replacement:
				'\t\tencodeOver(level, withoutSourceLocs, new Map([["bases", arrayText(bases.map((b) => b.fingerprint))]])),',
			why: "a level over a base written with the base's fingerprint in place of its text; the parts property's base differential fails."
		}
	]
})

/** Fingerprints separate their domains, and refuse a domain of no single line. Its budget is its suite's before it was a property (test/unit/core/fingerprint.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const fingerprintsSeparateTheirDomainsAndRefuseADomainOfNoSingleLine = property.explore(
	domainGen,
	{
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: ["two domains", "an empty domain", "a domain of two lines"] satisfies ReadonlyArray<
			Reached<DomainFeature>
		>,
		check:
			(_, c: Case<DomainFeature>) =>
			([value, a, b, tail]) =>
				Effect.sync(() => {
					if (a !== b) {
						assert.notEqual(
							succeeded(digest(a, value, everyProperty)),
							succeeded(digest(b, value, everyProperty))
						)
						c.note("two domains")
					}
					refused(digest("", value, everyProperty), "MalformedArtifact")
					c.note("an empty domain")
					refused(digest(`${a}\n${tail}`, value, everyProperty), "MalformedArtifact")
					c.note("a domain of two lines")
				}),
		oracle: { kind: "specification", name: "a one-line domain, separated" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/fingerprint.ts",
				original: "\tsha256Hex(joinWellFormed(formatLine, domain, newline, text))",
				replacement: "\tsha256Hex(joinWellFormed(formatLine, text))",
				why: "the domain left out of the hashed text; the domains property fails."
			},
			{
				file: "packages/engine/src/core/fingerprint.ts",
				original:
					'\tif (domain.length === 0 || domain.includes("\\n") || !isWellFormedText(domain)) {',
				replacement: "\tif (domain.length === 0 || !isWellFormedText(domain)) {",
				why: "a domain of two lines admitted; the domains property fails."
			}
		]
	}
)
