/**
 * The canonical serializer (core/canonical.ts): one text per value, the JSON Canonicalization Scheme (RFC 8785) over
 * the value's JSON form, and a refusal, at the offending value's path, of everything outside the value model.
 *
 * The values are drawn: JSON without null plus bigints, NaN and the infinities, and vectors, their keys and strings
 * from a dictionary of the spellings where JavaScript's own key order, a code-point order, a naive tagging scheme or
 * the prototype accessor goes wrong. The oracle is the format's specification, written here apart from the serializer
 * (the module header): the JSON form holds a bigint as "~n:<integer>", a number that is not finite as "~f:" and the
 * text String writes of it, -0 as "~f:-0", a Float32Array as "~v:[c1,...,cn]", each component as JSON.stringify writes
 * it (-0 as 0),
 * and a plain string beginning with "~" with that "~" doubled, and the text is RFC 8785 over it, keys
 * ordered by UTF-16 code units and every number and string written as JSON.stringify writes it (ECMAScript's shortest
 * round trip, -0 as 0; well-formed escaping).
 *
 * Keys: drawn text, and the spellings where an order goes wrong: integer-like keys, which JavaScript lists first;
 * "__proto__", which assignment would take for the prototype; a key above ASCII; and a BMP key beyond the surrogates
 * beside a supplementary one, which UTF-16 code units order the other way round from code points.
 *
 * - Text: encode, toJson, writeCanonicalJson, arrayText and encodeOver are RFC 8785 over the specified JSON form,
 *   whatever the key insertion order.
 * - Round trip: the JSON form and the text read back (fromJson, decode) as the value, -0 as -0 and a vector as the
 *   protocol value of its text.
 * - Outside the model: each named kind of value outside it, planted at a drawn path, is refused at that path in the
 *   direction it arises, MalformedDescription for the caller's value and MalformedArtifact for text read back.
 * - Nesting and cycles: any depth is read and written without the call stack, and a container that holds itself is
 *   refused as a cycle where it meets itself.
 * - Omission: an undefined member is left out, and omitSourceLocs leaves out exactly a SourceLoc under "loc".
 * - Now: a value is read as it is when it is written, frozen or not, so nothing is remembered.
 * - Comparison: canonicalEquals and sameContent are equality of specified text, and canonicalSortKeyed sorts by it,
 *   refusing a member outside the model at its place.
 * - Tokens: canonicalTokens spell the text, are one list exactly when the texts are one, and order as the texts do,
 *   over two values drawn apart or alike but for one leaf, so two numbers whose texts begin one another meet before the
 *   end, a comma or a closing bracket.
 *
 * Oracle: the format's specification above, written here apart from the serializer (jsonForm, rfc8785), a
 * specification turned into a checker; a round trip for the readers.
 *
 * Features: the spellings the format must get right (SpellingFeature), each kind outside the model (Outside), each
 * container and direction of a nesting and a cycle, each omitted member, each freezing, a repeated member, and what
 * stands where two token lists first differ (TokenFeature).
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { chunksOf } from "@bjornpagen/grizzle-text/chunks"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import {
	arrayText,
	canonicalEquals,
	canonicalSortKeyed,
	type CanonicalToken,
	canonicalTokens,
	compareCanonicalTokens,
	decode,
	encode,
	encodeOver,
	everyProperty,
	fromJson,
	type Json,
	noRevivers,
	omitSourceLocs,
	sameContent,
	toJson,
	withoutSourceLocs,
	writeCanonicalJson
} from "#compiler/core/canonical.ts"
import { isRecord } from "#compiler/core/record.ts"
import { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
import { artifactRefusal, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { isList } from "#test/support/list.ts"
import {
	build,
	compareGen,
	cycle,
	cycleGen,
	decodedForm,
	freezeDeeply,
	Exact,
	type Freezing,
	firstDifference,
	jsonForm,
	memoGen,
	nestedText,
	nestingGen,
	type OmittedFeature,
	omittedGen,
	type OutsideKind,
	outsideGen,
	outsides,
	permute,
	placed,
	planted,
	revivers,
	rfc8785,
	sameSequence,
	type SpellingFeature,
	specified,
	spellingsOf,
	textGen,
	textOf,
	type TokenFeature,
	tokensSpace,
	tokenText,
	value
} from "#test/unit/core/canonical.fixtures.ts"

/** The canonical text is RFC 8785 over the specified JSON form, whatever the key insertion order Its budget is its suite's before it was a property (test/unit/core/canonical.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const theCanonicalTextIsRFC8785OverTheSpecifiedJSONFormWhateverTheKeyInsertionOrder =
	property.explore(textGen, {
		needs: {},
		budget: { runs: 1000, steered: 1000 },
		situations: [
			"a bigint",
			"a vector",
			"a vector component of -0",
			"a Canonicalizable value",
			"a string beginning with ~",
			"an integer-like key",
			"a __proto__ key",
			"keys code points order otherwise",
			"negative zero",
			"an exponent-form number",
			"a number that is not finite"
		] satisfies ReadonlyArray<Reached<SpellingFeature>>,
		check:
			(_, c: Case<SpellingFeature>) =>
			([v, draws]) =>
				Effect.sync(() => {
					spellingsOf(v, c.note)
					const permuted = permute(v, draws)
					const form = jsonForm(v)
					assert.deepEqual(succeeded(toJson(permuted, everyProperty)), form)
					assert.equal<string>(succeeded(encode(permuted, everyProperty)), rfc8785(form))
					assert.equal<string>(succeeded(writeCanonicalJson(form)), rfc8785(form))
					if (isList(permuted)) {
						assert.equal<string>(
							arrayText(Arr.map(permuted, (item) => succeeded(encode(item, everyProperty)))),
							rfc8785(form),
							"the text of the list written from its items' own"
						)
					}
					if (
						isRecord(permuted) &&
						!(permuted instanceof Exact) &&
						!(permuted instanceof Float32Array) &&
						!isList(permuted)
					) {
						const texts = new Map(
							Arr.map(
								Rec.toEntries(permuted),
								([k, child]) => [k, succeeded(encode(child, everyProperty))] as const
							)
						)
						for (const [k, text] of texts) {
							assert.equal<string>(
								succeeded(encodeOver(permuted, everyProperty, new Map([[k, text]]))),
								rfc8785(form),
								`the text with member ${k} written from its own`
							)
						}
						assert.equal<string>(
							succeeded(encodeOver(permuted, everyProperty, texts)),
							rfc8785(form),
							"the text with every member written from its own"
						)
					}
				}),
		oracle: { kind: "specification", name: "RFC 8785 over the specified JSON form" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\tsortKeys(keys)\n",
				replacement: "\tkeys.sort((a, b) => a.localeCompare(b))\n",
				why: "a record's keys in locale order, not UTF-16 code unit order; the text property fails."
			}
		]
	})

/** The canonical text round-trips the JSON form and the text, bigints, tagged values and tilde strings included Its budget is its suite's before it was a property (test/unit/core/canonical.test.ts at 4ca3036a): 500 runs and 500 steered cases. */
export const theCanonicalTextRoundTripsTheJSONFormAndTheTextBigintsTaggedValuesAndTildeStringsIncluded =
	property.explore(value, {
		needs: {},
		budget: { runs: 500, steered: 500 },
		situations: [
			"a bigint",
			"a vector",
			"a vector component of -0",
			"a Canonicalizable value",
			"a string beginning with ~",
			"a __proto__ key",
			"negative zero",
			"a number that is not finite"
		] satisfies ReadonlyArray<Reached<SpellingFeature>>,
		check: (_, c: Case<SpellingFeature>) => (v) =>
			Effect.sync(() => {
				spellingsOf(v, c.note)
				const json = succeeded(toJson(v, everyProperty))
				const parsed = trustedJson<unknown>(jsonText(json))
				const viaJson = succeeded(fromJson(parsed, revivers))
				const viaText = succeeded(decode(chunksOf(succeeded(encode(v, everyProperty))), revivers))
				assert.equal<string>(succeeded(encode(viaJson, everyProperty)), specified(v))
				assert.equal<string>(succeeded(encode(viaText, everyProperty)), specified(v))
				assert.deepEqual(viaText, decodedForm(v))
			}),
		oracle: {
			kind: "universal",
			name: "decode ∘ encode and fromJson ∘ toJson, against the specified text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t\t\treturn value.slice(1)",
				replacement: "\t\t\treturn value",
				why: "a doubled tilde read back doubled; the round trip property fails."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: '\t\t\t\tthis.#read(top.value[i], "")',
				replacement: "\t\t\t\t{}",
				why: "An array's items are never read back, so decode and fromJson restore every array empty; the round trip property fails."
			}
		]
	})

/** A value outside the model is refused at its path, in the direction it arises, and never thrown: the caller's value as MalformedDescription, canonical text read back as MalformedArtifact Its budget is its suite's before it was a property (test/unit/core/canonical.test.ts at 4ca3036a): 600 runs and 600 steered cases. */
export const aValueOutsideTheModelIsRefusedAtItsPathInTheDirectionItArisesAndNeverThrownTheCallersValueAsMalformedDescriptionCanonicalTextReadBackAsMalformedArtifact =
	property.explore(outsideGen, {
		needs: {},
		budget: { runs: 600, steered: 600 },
		situations: outsides satisfies ReadonlyArray<Reached<OutsideKind>>,
		check:
			(_, c: Case<OutsideKind>) =>
			([kind, path, filler]) =>
				Effect.sync(() => {
					const plant = planted[kind]
					const v = placed(path, plant.at, filler)
					const result =
						plant.direction === "encode"
							? encode(v, everyProperty)
							: decode(
									chunksOf(jsonText(trusted<Json>(placed(path, plant.at, jsonForm(filler))))),
									revivers
								)

					if (plant.direction === "encode") {
						assert.deepEqual(refusalLoc(refused(result, "MalformedDescription")).path, [
							...path,
							...plant.extra
						])
					} else {
						const malformed = artifactRefusal(refused(result, "MalformedArtifact"))
						assert.deepEqual(
							[malformed.artifact, malformed.at],
							["canonical", [...path, ...plant.extra]]
						)
					}
					c.note(kind)
				}),
		oracle: {
			kind: "specification",
			name: "the value model, each kind outside it located where it was planted"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t\tObject.getOwnPropertySymbols(value).length === 0",
				replacement: "\t\ttrue",
				why: "a record holding a symbol key of its own is read as a plain record, its symbol member left out of its text; the outside-the-model property fails at its symbol key."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t\t\tconst at = frame.next - 1\n",
				replacement: "\t\t\tconst at = frame.next\n",
				why: "a refusal names the member after the one being read; the outside-the-model property fails at the path it planted."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: '\tif (digits.length > 1 && digits.startsWith("0")) {',
				replacement: '\tif (digits.startsWith("00")) {',
				why: "a bigint text with one leading zero admitted; the outside-the-model property fails."
			}
		]
	})

/** A value outside the model is read and written nested to any depth in every direction, the call stack no deeper for it, and the same text comes back */
export const aValueOutsideTheModelIsReadAndWrittenNestedToAnyDepthInEveryDirectionTheCallStackNoDeeperForItAndTheSameTextComesBack =
	property.exhaust(finite(nestingGen), {
		box: "no container, one, and 100,000 nested, of each container, in each direction",
		needs: {},
		situations: [],
		check:
			() =>
			([depth, container, direction]) =>
				Effect.sync(() => {
					sameSequence(
						succeeded(textOf(direction, depth, container)),
						nestedText(depth, container),
						"the nested text"
					)
				}),
		oracle: { kind: "specification", name: "the nested text written out directly" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t#enter(container: object): void {",
				replacement:
					'\t#enter(container: object): void {\n\t\tif (this.#frames.length >= 10_000) {\n\t\t\tstop(this.#path, "a nesting at most 10000 deep")\n\t\t}',
				why: "the walk refuses a value nested ten thousand containers deep as a depth; the nesting property fails, and the cycle property, which a cycle through more containers reaches."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\treturn fromJson(parsed.value, revivers)",
				replacement:
					'\tlet depth = 0\n\tlet deepest = 0\n\tfor (const unit of text.join("")) {\n\t\tdepth += unit === "[" || unit === "{" ? 1 : unit === "]" || unit === "}" ? -1 : 0\n\t\tdeepest = Math.max(deepest, depth)\n\t}\n\tif (deepest > 1000) {\n\t\treturn Result.err(malformedArtifact("canonical", [], "JSON text nested at most 1000 deep"))\n\t}\n\treturn fromJson(parsed.value, revivers)',
				why: "decode refuses a text nested more than a thousand brackets deep as a depth; the nesting property fails in its decode direction."
			}
		]
	})

/** A value outside the model is refused as a cycle where it meets itself when it holds itself, however long the cycle, never as a depth */
export const aValueOutsideTheModelIsRefusedAsACycleWhereItMeetsItselfWhenItHoldsItselfHoweverLongTheCycleNeverAsADepth =
	property.exhaust(finite(cycleGen), {
		box: "cycles through one, two and 100,000 containers, back to the first or the last, each container, each direction",
		needs: {},
		situations: [],
		check:
			() =>
			([length, back, container, direction]) =>
				Effect.sync(() => {
					const root = cycle(length, back, container)
					/** Where the walk meets the container it is already inside: one segment per container on the way. */
					const where = Arr.map(indices(length), () => (container === "array" ? 0 : "a"))
					switch (direction) {
						case "encode":
							sameSequence(
								refusalLoc(refused(encode(root, everyProperty), "MalformedDescription")).path,
								where,
								"the refusal's path"
							)
							return
						case "toJson":
							sameSequence(
								refusalLoc(refused(toJson(root, everyProperty), "MalformedDescription")).path,
								where,
								"the refusal's path"
							)
							return
						case "fromJson": {
							const malformed = artifactRefusal(
								refused(fromJson(root, noRevivers), "MalformedArtifact")
							)
							assert.equal(malformed.artifact, "canonical")
							sameSequence(malformed.at, where, "the refusal's path")
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the path from the root to where the cycle meets itself"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: '\t\t\tstop(this.#here(), "an acyclic value")',
				replacement: '\t\t\tstop([], "an acyclic value")',
				why: "a cycle refused at the root, not where it meets itself; the cycle property fails."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t#enter(container: object): void {",
				replacement:
					'\t#enter(container: object): void {\n\t\tif (this.#frames.length >= 10_000) {\n\t\t\tstop(this.#path, "a nesting at most 10000 deep")\n\t\t}',
				why: "the walk refuses a value nested ten thousand containers deep as a depth; the nesting property fails, and the cycle property, which a cycle through more containers reaches."
			}
		]
	})

/** The omitted members leave out an undefined property, and under omitSourceLocs exactly a SourceLoc under loc Its budget is its suite's before it was a property (test/unit/core/canonical.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const theOmittedMembersLeaveOutAnUndefinedPropertyAndUnderOmitSourceLocsExactlyASourceLocUnderLoc =
	property.explore(omittedGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"an undefined property",
			"a SourceLoc under loc",
			"another value under loc"
		] satisfies ReadonlyArray<Reached<OmittedFeature>>,
		check:
			(_, c: Case<OmittedFeature>) =>
			([entries, member]) =>
				Effect.sync(() => {
					const bare = build(entries)
					switch (member.kind) {
						case "undefined": {
							const v = build([...entries, ["loc", undefined]])
							assert.equal<string>(succeeded(encode(v, everyProperty)), specified(bare))
							assert.ok(
								canonicalEquals(v, bare),
								"an undefined member is left out of the comparison"
							)
							c.note("an undefined property")
							return
						}
						case "loc": {
							const v = build([...entries, ["loc", member.loc]])
							assert.equal<string>(succeeded(encode(v, { omit: omitSourceLocs })), specified(bare))
							assert.equal<string>(succeeded(encode(v, everyProperty)), specified(v))
							assert.ok(sameContent(v, bare), "sameContent leaves the SourceLoc out")
							assert.equal(canonicalEquals(v, bare), false, "canonicalEquals reads the SourceLoc")
							c.note("a SourceLoc under loc")
							return
						}
						case "other": {
							const v = build([...entries, ["loc", member.other]])
							assert.equal<string>(succeeded(encode(v, { omit: omitSourceLocs })), specified(v))
							assert.equal(sameContent(v, bare), false, "sameContent keeps another value under loc")
							c.note("another value under loc")
							return
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the specified text of the value without the member"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: '\t(key === "loc" && isSourceLoc(value)) ||',
				replacement: '\tkey === "loc" ||',
				why: 'a "loc" member omitted whatever it holds; the omission property fails.'
			}
		]
	})

/** The omitted members read a value as it is now: a changed value is written as changed, a frozen one as it stays Its budget is its suite's before it was a property (test/unit/core/canonical.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const theOmittedMembersReadAValueAsItIsNowAChangedValueIsWrittenAsChangedAFrozenOneAsItStays =
	property.explore(memoGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"unfrozen",
			"frozen at the top",
			"frozen with a mutable loc",
			"deeply frozen"
		] satisfies ReadonlyArray<Reached<Freezing>>,
		check:
			(_, c: Case<Freezing>) =>
			([freezing, v, replacement]) =>
				Effect.sync(() => {
					c.note(freezing)
					switch (freezing) {
						case "unfrozen":
						case "frozen at the top": {
							const inner: Record<string, unknown> = { k: v }
							const holder = freezing === "unfrozen" ? { inner } : Object.freeze({ inner })
							assert.equal<string>(succeeded(encode(holder, everyProperty)), specified(holder))
							inner["k"] = replacement
							assert.equal<string>(succeeded(encode(holder, everyProperty)), specified(holder))
							return
						}
						case "frozen with a mutable loc": {
							/**
							 * The omission reads the member, so the text of a frozen value with a mutable omitted member is not
							 * remembered: once the loc is no SourceLoc, it is written.
							 */
							const loc: Record<string, unknown> = { label: "relation Task", path: ["Work"] }
							const located = Object.freeze({ v, loc })
							assert.equal<string>(
								succeeded(encode(located, { omit: omitSourceLocs })),
								specified({ v })
							)
							loc["extra"] = replacement
							assert.equal<string>(
								succeeded(encode(located, { omit: omitSourceLocs })),
								specified(located)
							)
							return
						}
						case "deeply frozen": {
							const frozen = freezeDeeply({ v })
							assert.equal<string>(succeeded(encode(frozen, everyProperty)), specified(frozen))
							assert.equal<string>(succeeded(encode(frozen, everyProperty)), specified(frozen))
							assert.equal(canonicalEquals(frozen, frozen), true)
							return
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the specified text of the value as it is now"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					"\t\tconst out = new WellFormedWriter()\n\t\tnew Walk(options, new TextSink(out, bound), canonicalOf, rootPath, nothingCarried).of(value)\n\t\treturn out.text()\n\t})",
				replacement:
					'\t\tconst remembered = typeof value === "object" && value !== null && Object.isFrozen(value)\n\t\tconst memo = remembered ? frozenTexts.get(value) : undefined\n\t\tif (memo !== undefined) {\n\t\t\treturn memo\n\t\t}\n\t\tconst out = new WellFormedWriter()\n\t\tnew Walk(options, new TextSink(out, bound), canonicalOf, rootPath, nothingCarried).of(value)\n\t\tif (remembered) {\n\t\t\tfrozenTexts.set(value, out.text())\n\t\t}\n\t\treturn out.text()\n\t})\n\nconst frozenTexts = new WeakMap<object, string>()',
				why: "a frozen value's text remembered, whatever it holds since and whatever the options; the now property fails."
			}
		]
	})

/** Canonical comparison is equality of specified text, sameContent's too, and sorts a set by it, refusing a member outside the model at its place Its budget is its suite's before it was a property (test/unit/core/canonical.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const canonicalComparisonIsEqualityOfSpecifiedTextSameContentsTooAndSortsASetByItRefusingAMemberOutsideTheModelAtItsPlace =
	property.explore(compareGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: ["a repeated member", "two distinct members"] satisfies ReadonlyArray<
			Reached<"a repeated member" | "two distinct members">
		>,
		check:
			(_, c: Case<"a repeated member" | "two distinct members">) =>
			([distinct, picks, at]) =>
				Effect.sync(() => {
					const items = [
						...distinct,
						...Arr.map(picks, (p) => defined(distinct[p % distinct.length], "a member"))
					]
					for (const a of items) {
						for (const b of items) {
							const same = specified(a) === specified(b)
							assert.equal(canonicalEquals(a, b), same)
							assert.equal(
								sameContent(a, b),
								succeeded(encode(a, withoutSourceLocs)) === succeeded(encode(b, withoutSourceLocs))
							)
							c.note(same && a !== b ? "a repeated member" : "two distinct members")
						}
					}
					const sorted = succeeded(canonicalSortKeyed(items, everyProperty))
					assert.deepEqual(
						Arr.map(sorted, (k) => specified(k.item)),
						Arr.sort(Arr.map(items, specified), Order.String)
					)
					const place = at % (items.length + 1)
					const withOutside = [...items.slice(0, place), null, ...items.slice(place)]
					assert.deepEqual(
						refusalLoc(
							refused(canonicalSortKeyed(withOutside, everyProperty), "MalformedDescription")
						).path,
						[place]
					)
				}),
		oracle: {
			kind: "specification",
			name: "equality and code unit order of the specified text"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/core/canonical.test.ts#canonicalComparisonIsEqualityOfSpecifiedTextSameContentsTooAndSortsASetByItRefusingAMemberOutsideTheModelAtItsPlace:-:2.1.1.0.5.1.1.1.0.5.1.0.0"
				),
				reason: "[1] beside another [1]",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/core/canonical.test.ts#canonicalComparisonIsEqualityOfSpecifiedTextSameContentsTooAndSortsASetByItRefusingAMemberOutsideTheModelAtItsPlace:-:2.0.0.1.0.0.1.0.2.2.3.2j.1d.2l.0.0"
				),
				reason: "a vector beside the protocol value of its text",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/unit/core/canonical.test.ts#canonicalComparisonIsEqualityOfSpecifiedTextSameContentsTooAndSortsASetByItRefusingAMemberOutsideTheModelAtItsPlace:-:2.0.8.0.0.8.0.0.0"
				),
				reason: "NaN beside NaN, one text though no number equals NaN",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/unit/core/canonical.test.ts#canonicalComparisonIsEqualityOfSpecifiedTextSameContentsTooAndSortsASetByItRefusingAMemberOutsideTheModelAtItsPlace@small-stack:-:2.0.5.0.0.7.0.0.0"
				),
				reason: "0 beside -0, two texts though 0 === -0",
				since: "2026-11-28"
			}
		],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t\t\tif (Object.is(x, y)) {\n\t\t\t\tcontinue\n\t\t\t}",
				replacement: "\t\t\tif (x === y) {\n\t\t\t\tcontinue\n\t\t\t}",
				why: "two values one by ===, so 0 is one value with -0, whose texts are two; the comparison property fails at its kept case."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					"\t\tkeyed.sort(mapInput(compareStrings, (k: { readonly text: string }) => k.text))",
				replacement: "\t\tkeyed.sort((x, y) => x.text.length - y.text.length)",
				why: "a set sorted by its members' text length; the comparison property fails."
			}
		]
	})

/** Canonical tokens spell the canonical text, are one list exactly when the texts are one, and order as the texts do by code unit Its budget is its suite's before it was a property (test/unit/core/canonical.test.ts at 4ca3036a): 3000 runs and 3000 steered cases. */
export const canonicalTokensSpellTheCanonicalTextAreOneListExactlyWhenTheTextsAreOneAndOrderAsTheTextsDoByCodeUnit =
	property.explore(tokensSpace, {
		needs: {},
		budget: { runs: 3000, steered: 3000 },
		situations: [
			"equal texts",
			"two strings",
			"two numbers",
			"two numbers, one's text beginning the other's, nothing after it",
			"two numbers, one's text beginning the other's, a comma after it",
			"two numbers, one's text beginning the other's, a closing bracket after it",
			"a string and another token",
			"two other tokens"
		] satisfies ReadonlyArray<Reached<TokenFeature>>,
		check:
			(_, c: Case<TokenFeature>) =>
			([a, b]) =>
				Effect.sync(() => {
					const ta = succeeded(canonicalTokens(a, everyProperty))
					const tb = succeeded(canonicalTokens(b, everyProperty))
					const sa = specified(a)
					const sb = specified(b)
					c.note(firstDifference(ta, tb))
					assert.equal(Arr.join(Arr.map(ta, tokenText), ""), sa, "the tokens spell the text")
					assert.equal(
						new TupleMap<ReadonlyArray<CanonicalToken>, true>().set(ta, true).has(tb),
						sa === sb,
						"two token lists are one exactly when their texts are"
					)
					assert.equal(
						Math.sign(compareCanonicalTokens(ta, tb)),
						Math.sign(Order.String(sa, sb)),
						"the tokens order as their texts by code unit"
					)
				}),
		oracle: {
			kind: "specification",
			name: "the specified canonical text (RFC 8785 over the JSON form), its spelling, its equality and its UTF-16 code unit order"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					"\t\t\treturn after === undefined ? -1 : compareStrings(firstUnit(after), ys.charAt(xs.length))\n\t\t}\n\t\tif (xs.startsWith(ys)) {\n\t\t\tconst after = b[i + 1]\n\t\t\treturn after === undefined ? 1 : compareStrings(xs.charAt(ys.length), firstUnit(after))",
				replacement:
					"\t\t\treturn -1\n\t\t}\n\t\tif (xs.startsWith(ys)) {\n\t\t\tconst after = b[i + 1]\n\t\t\treturn 1",
				why: "a number whose text begins another's ordered first, whatever follows it, a closing bracket included; the tokens property fails where it requires that bracket."
			}
		]
	})
