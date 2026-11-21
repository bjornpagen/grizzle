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
import { Effect, Formatter, Record } from "effect"
import { everyProperty, withoutSourceLocs } from "#compiler/core/canonical.ts"
import {
	digest,
	IdentityDigests,
	identityDigest,
	schemaFingerprint
} from "#compiler/core/fingerprint.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { specified } from "#test/unit/core/canonical.fixtures.ts"
import {
	type Change,
	changed,
	changes,
	contentWith,
	allocatedBy,
	chainGen,
	chainLevel,
	type DigestFeature,
	digestGen,
	type DomainFeature,
	domainGen,
	framedText,
	identitySpecified,
	longLength,
	longString,
	longStringGen,
	platformDigest,
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
				const schema = (q: Parts) =>
					succeeded(schemaFingerprint(new IdentityDigests(withoutSourceLocs), q.content))
				const schemaParts: ReadonlySet<Change> = new Set(["content", "a non-SourceLoc loc"])
				assert.equal(
					schema(after) !== schema(before),
					schemaParts.has(change),
					"the schema fingerprint"
				)
				assert.equal(schema({ ...before, content: stripped(before.content) }), schema(before))
				const above = { ...Record.fromEntries(entries), loc: there, bases: [before.content] }
				assert.equal<string>(
					schema({ content: above }),
					platformDigest(framedText("schema", identitySpecified({ content: stripped(above) }))),
					"a level over its base: SHA-256 of its frame and its content's identity text, its base by its token"
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
				"\tResult.map(identities.framed(schemaDomain, { content: level }), SchemaFingerprint)",
			replacement:
				"\tResult.map(identities.framed(rosterDomain, { content: level }), SchemaFingerprint)",
			why: "a level framed under another domain; the parts property's specified fingerprint differs."
		},
		{
			file: "packages/engine/src/core/fingerprint.ts",
			original:
				"\tResult.map(identities.framed(schemaDomain, { content: level }), SchemaFingerprint)",
			replacement: "\tResult.map(identities.framed(schemaDomain, level), SchemaFingerprint)",
			why: "a level's fingerprint hashes the level where its content's record holds it; the specified fingerprint differs."
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
				original: "\tout.text(formatLine)\n\tout.text(domain)\n",
				replacement: "\tout.text(formatLine)\n",
				why: "the domain left out of the hashed text; the domains property fails."
			},
			{
				file: "packages/engine/src/core/fingerprint.ts",
				original: '\tdomain.length === 0 || domain.includes("\\n") || !isWellFormedText(domain)',
				replacement: "\tdomain.length === 0 || !isWellFormedText(domain)",
				why: "a domain of two lines admitted; the domains property fails."
			}
		]
	}
)

/** A digest is SHA-256 of its frame and the value's specified canonical text, and an identity digest SHA-256 of the identity text its header specifies, each container once. */
export const aDigestIsSHA256OfItsFrameAndTheSpecifiedCanonicalTextAndAnIdentityDigestOfTheIdentityTextItsHeaderSpecifies =
	property.explore(digestGen, {
		needs: {},
		situations: ["a container", "a scalar", "a container shared twice"] satisfies ReadonlyArray<
			Reached<DigestFeature>
		>,
		check:
			(_, c: Case<DigestFeature>) =>
			([drawn, domain, shared]) =>
				Effect.sync(() => {
					const v = shared ? [drawn, drawn] : drawn
					assert.equal(
						succeeded(digest(domain, v, everyProperty)),
						platformDigest(framedText(domain, specified(v))),
						"the digest of the framed specified text"
					)
					assert.equal<string>(
						succeeded(identityDigest(v, everyProperty)),
						platformDigest(identitySpecified(v)),
						"the identity digest of the specified identity text"
					)
					c.note(
						shared ? "a container shared twice" : typeof v === "object" ? "a container" : "a scalar"
					)
				}),
		oracle: {
			kind: "specification",
			name: "the frame and the identity text the module's header specifies, over RFC 8785's text (canonical.fixtures.ts specified), hashed by the platform"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: '\t\tif (i > 0) {\n\t\t\tout.ascii(",")\n\t\t}\n\t\tconst token = taken[i]\n',
				replacement: "\t\tconst token = taken[i]\n",
				why: "An array's members are written with no comma between them in its identity text; the identity digest differs."
			},
			{
				file: "packages/engine/src/core/fingerprint.ts",
				original: "\tout.text(domain)\n\tout.text(newline)\n",
				replacement: "\tout.text(domain)\n",
				why: "The frame's domain is not ended by its newline; every digest differs."
			}
		]
	})

/** A digest allocates no heap for each character of the strings it encodes: each string is written as its UTF-8 in place, with no text built of it. */
export const aDigestAllocatesNoHeapForEachCharacterOfTheStringsItEncodes = property.explore(
	longStringGen,
	{
		needs: {},
		budget: { runs: 16, steered: 0 },
		situations: [],
		check: () => (unit) =>
			Effect.sync(() => {
				const v = { s: longString(longLength, unit), t: [longString(longLength, unit)] }
				const allocated = allocatedBy(() => digest("allocation", v, everyProperty))
				assert.ok(
					allocated < longLength / 2,
					`a digest of two strings of ${longLength} code units of ${Formatter.format(unit)} allocates ${allocated} heap bytes`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a digest's heap allocation, which no character of its strings adds to"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/utf8.ts",
				original:
					"\t\tconst length = text.length\n\t\tthis.#reserve(length * jsonUnitMaxBytes + 2)\n",
				replacement:
					"\t\tconst length = text.length\n\t\tif (length > 0) {\n\t\t\tthis.text(jsonText(text))\n\t\t\treturn\n\t\t}\n\t\tthis.#reserve(length * jsonUnitMaxBytes + 2)\n",
				why: "A string's literal is built as a text by JSON.stringify and then written as its UTF-8, as the canonical text's strings were before the writer: each string's characters are allocated again, a megabyte and more each digest."
			}
		]
	}
)

/** A schema level's fingerprint hashes bytes linear in its distinct parts: a union chain one level deeper adds as many bytes at every depth, where its canonical text doubles. */
export const aSchemaLevelsFingerprintHashesBytesLinearInItsDistinctPartsAUnionChainOneLevelDeeperAddsAsManyBytesAtEveryDepth =
	property.explore(chainGen, {
		needs: {},
		situations: [],
		check:
			() =>
			([depth, reads]) =>
				Effect.sync(() => {
					/** The bytes the fingerprint of a chain `d` deep hashes. */
					const hashed = (d: number): number => {
						const identities = new IdentityDigests(withoutSourceLocs)
						succeeded(schemaFingerprint(identities, chainLevel(d, reads)))
						return identities.written
					}
					const step = hashed(depth + 1) - hashed(depth)
					assert.equal(
						hashed(depth + 2) - hashed(depth + 1),
						step,
						`a chain of ${reads} reads a level, one level deeper past ${depth + 1}, adds the ${step} bytes it adds past ${depth}`
					)
				}),
		oracle: {
			kind: "specification",
			name: "a Merkle text, each part written once as its token: linear in the parts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/fingerprint.ts",
				original: "\t\tconst digests = Object.isFrozen(container) ? this.#digests : open\n",
				replacement: "\t\tconst digests = new Map<object, IdentityDigest>()\n",
				why: "No container's token is kept, so each is digested at every path that reaches it: a chain one level deeper hashes reads times the bytes."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t\t\tsink.token(tokens.write, token)\n\t\t\tcontinue\n",
				replacement: "",
				why: "A container is written as its canonical text, the tree, where its token stands: the level's text spells the leaf at every path, and a chain one level deeper hashes reads times the bytes."
			}
		]
	})
