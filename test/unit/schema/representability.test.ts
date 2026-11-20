/**
 * Key representability: every primary and candidate key
 * must fit its index entry for every value its fields admit, or ownership refuses it with UnrepresentableKey naming the
 * key and the bound that failed.
 *
 * The oracles restate PostgreSQL rather than read src: the B-tree item limit and the per-type datum sizes and alignments
 * of pg_type, numeric.c's numeric_maximum_size, btree_gist's key representations, and the longest match of a pattern
 * computed from the pattern as drawn, witnessed by the host's own RegExp over the same language spelled greedy and
 * widest first.
 *
 * PostgreSQL's INDEX_MAX_KEYS (pg_config_manual.h), restated: the most columns an index, and so a key, holds.
 *
 * Features: as each search names them: bounded and unbounded patterns and lengths, each key layout, entries at and past
 * their limits, spans and vectors in keys.
 */

import { maxOf } from "@bjornpagen/grizzle-text/base/array"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, int, map, weighted } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { regex as arkregex } from "arkregex"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import type { KeyFault } from "#compiler/core/causes.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { keyTextBytes } from "#compiler/public/text.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import {
	btreeMaxItemSize,
	btreeEntryBytes,
	type DatumBound,
	gistEntryBytes,
	keyLayout,
	lengthBound,
	textByteBound
} from "#compiler/schema/representability.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { keyBuilder, onBuilder } from "#compiler/schema/statements.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { Id } from "#test/support/ids.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import {
	armOf,
	boundOf,
	boundsAbove,
	btreeTupleBytes,
	budgetCaseGen,
	type BudgetFeature,
	budgetOf,
	conjunctExpr,
	fieldDescsOf,
	fixedTyplens,
	gistDatumGen,
	type GistFeature,
	keyedDatums,
	gistKeyBytes,
	gistTupleBytes,
	greedyAlternatives,
	hasItem,
	installed,
	keyFeatures,
	keyFieldDescriptor,
	keyFieldGen,
	type KeySizeFeature,
	type KeySizeSketch,
	Kind,
	lengthConjunctGen,
	type LengthFeature,
	type LengthSketch,
	modelBound,
	nonEmptyOf,
	ownOne,
	ownValue,
	patternSketchGen,
	patternSource,
	plantedAlternatives,
	postgresBtreeMaxItem,
	postgresGistMaxItem,
	postgresIndexMaxKeys,
	type RegexFeature,
	scalars,
	sequenceBytes,
	sequenceWitness,
	sizedFields,
	type SpanKeyFeature,
	spanScalarFamily,
	spanScalarGen,
	utf8Bytes,
	type VectorKeyFeature,
	vectorKeySketchGen
} from "#test/unit/schema/representability.fixtures.ts"
import { bareContract, descOf, rawPg, rawSpan, regex } from "#test/unit/schema/support.ts"

/** Pattern byte bounds bounds a pattern's key by at least its longest match in UTF-8 bytes, and by nothing when its language is infinite. Its budget is its suite's before it was a property (test/unit/schema/representability.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const patternByteBoundsBoundsAPatternsKeyByAtLeastItsLongestMatchInUTF8BytesAndByNothingWhenItsLanguageIsInfinite =
	property.explore(patternSketchGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"bounded",
			"exact",
			"long run",
			"unanchored",
			"unbounded repetition",
			"back-reference",
			"lookaround",
			"four-byte code point",
			"group alternation"
		] satisfies ReadonlyArray<Reached<RegexFeature>>,
		check: (_, c: Case<RegexFeature>) => (s) =>
			Effect.sync(() => {
				const alternatives = plantedAlternatives(s)
				const source = patternSource(alternatives)
				const patterns: Patterns = [{ source, flags: s.flags }]
				const language = textLookup(patterns)
				/** A pattern the analysis refuses has no descriptor, so nothing it bounds is a key's. */
				const bound = language.ok
					? textByteBound({
							kind: "text",
							patterns,
							bytes: undefined,
							language: language.value
						})
					: Number.POSITIVE_INFINITY
				const anchored = Arr.every(alternatives, (a) => a.start && a.end)
				const longest = maxOf(
					Arr.map(alternatives, (a) => sequenceBytes(a.items)),
					Number.NEGATIVE_INFINITY
				)
				if (Arr.some(alternatives, (a) => hasItem(a.items, (item) => item.kind === "lookaround"))) {
					c.note("lookaround")
				}
				if (s.defect === "back-reference") {
					c.note("back-reference")
					return
				}
				if (!anchored || !Number.isFinite(longest)) {
					c.note(!anchored ? "unanchored" : "unbounded repetition")
					assert.equal(bound, Number.POSITIVE_INFINITY, source)
					return
				}
				const greedy = greedyAlternatives(alternatives)
				const [widest] = greedy
				const witness = sequenceWitness(widest.items)
				assert.equal(utf8Bytes(witness), longest, `the witness of ${source}`)
				const firstPath = patternSource(greedy)
				assert.ok(
					arkregex.as(firstPath, s.flags).test(witness),
					`${source}, spelled greedy and widest first as ${firstPath}, matches its witness`
				)
				if (Arr.some(Arr.fromIterable(witness), (ch) => utf8Bytes(ch) === 4)) {
					c.note("four-byte code point")
				}
				if (
					alternatives.length > 1 ||
					hasItem(widest.items, (item) => item.kind === "quantified" && item.atom.kind === "group")
				) {
					c.note("group alternation")
				}
				c.note(s.defect === "long run" ? "long run" : "bounded")
				assert.ok(bound >= longest, `${source}: bound ${bound} below its longest match ${longest}`)
				if (bound === longest) {
					c.note("exact")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the pattern's longest match in UTF-8 bytes, computed from the pattern as drawn"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/nonempty.ts",
				original:
					"export const isNonEmpty = <A>(xs: ReadonlyArray<A>): xs is NonEmptyReadonlyArray<A> => xs.length > 0",
				replacement:
					"export const isNonEmpty = <A>(xs: ReadonlyArray<A>): xs is NonEmptyReadonlyArray<A> => xs.length <= 0",
				why: "Operator mutant 6d7f81bf34 at packages/text/src/base/nonempty.ts:4 in isNonEmpty: `>` becomes `<=`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** Length bounds reads a charLength bound, four bytes a code point, and an octetLength bound, exact bytes, from a contract predicate. Its budget is its suite's before it was a property (test/unit/schema/representability.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const lengthBoundsReadsACharLengthBoundFourBytesACodePointAndAnOctetLengthBoundExactBytesFromAContractPredicate =
	property.explore(
		(source) => ({
			conjuncts: source.draw(nonEmptyOf(lengthConjunctGen, 3)),
			nested: source.draw(boolean),
			base: source.draw(
				weighted([
					[1, constant<LengthSketch["base"]>({ kind: "wildcard" })],
					[1, map(int(1, 200), (k): LengthSketch["base"] => ({ kind: "letters", k }))]
				])
			)
		}),
		{
			needs: {},
			budget: { runs: 400, steered: 400 },
			situations: [
				"charLength bounded",
				"octetLength bounded",
				"unbounded",
				"both measures",
				"base tighter",
				"charLength tighter",
				"octetLength tighter",
				"mirrored"
			] satisfies ReadonlyArray<Reached<LengthFeature>>,
			check: (_, c: Case<LengthFeature>) => (s) =>
				Effect.sync(() => {
					const [first, ...rest] = s.conjuncts
					const tail = Arr.map(rest, conjunctExpr)
					const predicate: ExprDesc = !Arr.isReadonlyArrayNonEmpty(tail)
						? conjunctExpr(first)
						: s.nested
							? { kind: "and", args: [conjunctExpr(first), { kind: "and", args: tail }] }
							: { kind: "and", args: [conjunctExpr(first), ...tail] }
					if (
						Arr.some(
							s.conjuncts,
							({ form }) => form.kind === "compare" && form.mirrored && boundsAbove(form)
						)
					) {
						c.note("mirrored")
					}
					const chars = modelBound(s.conjuncts, "charLength")
					const octets = modelBound(s.conjuncts, "octetLength")
					assert.equal(lengthBound("charLength", predicate), chars, "the charLength bound")
					assert.equal(lengthBound("octetLength", predicate), octets, "the octetLength bound")
					if (Number.isFinite(chars)) {
						c.note("charLength bounded")
					}
					if (Number.isFinite(octets)) {
						c.note("octetLength bounded")
					}
					if (Number.isFinite(chars) && Number.isFinite(octets)) {
						c.note("both measures")
					}
					const base =
						s.base.kind === "wildcard"
							? textDesc("^.*$", "su")
							: textDesc(`^[A-Z]{${s.base.k}}$`, "u")
					const charBytes = 4 * Math.max(0, chars)
					const octetBytes = Math.max(0, octets)
					const baseBytes = s.base.kind === "wildcard" ? Number.POSITIVE_INFINITY : s.base.k
					const expected = Math.min(charBytes, octetBytes, baseBytes)
					if (!Number.isFinite(expected)) {
						c.note("unbounded")
					} else if (expected === baseBytes && baseBytes < Math.min(charBytes, octetBytes)) {
						c.note("base tighter")
					} else if (expected === charBytes && charBytes < octetBytes) {
						c.note("charLength tighter")
					} else if (expected === octetBytes && octetBytes < charBytes) {
						c.note("octetLength tighter")
					}
					assert.equal(
						textByteBound({ kind: "contract", name: "Memo", base, predicate, facts: [] }),
						expected
					)
				}),
			oracle: {
				kind: "specification",
				name: "charLength at four bytes a code point, octetLength exact"
			},
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/are.ts",
					original: "\t\t\tout.push([lo, hi])",
					replacement: "\t\t\tout.push([hi])",
					why: "Operator mutant 9acfeb612b at packages/text/src/regex/are.ts:21 in printableIntervals: `[lo, ` becomes `[`; the property fails (the census, lane TESTPOLICY2)."
				}
			]
		}
	)

/** KeyTextBytes is the most bytes a text holds beside its fields in every index grizzle plans over them, and one byte more is refused where an index's layout meets the bound. Its budget is its suite's before it was a property (test/unit/schema/representability.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const keyTextBytesIsTheMostBytesATextHoldsBesideItsFieldsInEveryIndexGrizzlePlansOverThemAndOneByteMoreIsRefusedWhereAnIndexsLayoutMeetsTheBound =
	property.explore(budgetCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"declared key",
			"key over a selection",
			"ordered axis",
			"tree axis",
			"a contract",
			"str.bytes",
			"tight",
			"slack",
			"text first",
			"text last",
			"text between",
			"a text beside it"
		] satisfies ReadonlyArray<Reached<BudgetFeature>>,
		check: (_, c: Case<BudgetFeature>) => (s) =>
			Effect.sync(() => {
				const arm = armOf(s)
				const budget = keyTextBytes(arm.fields)
				assert.equal(budget, budgetOf(arm.companions), "the budget")
				succeeded(installed(arm.schemaAt(budget)), `the ${s.arm} with a text of ${budget} bytes`)
				const past = arm.entryAt(budget + 1) > postgresBtreeMaxItem
				c.noteAll([s.arm, s.spelling, past ? "tight" : "slack", ...keyFeatures(s)])
				if (past) {
					refused(installed(arm.schemaAt(budget + 1)), "UnrepresentableKey")
				} else {
					succeeded(
						installed(arm.schemaAt(budget + 1)),
						`the ${s.arm}, whose layout leaves room past the budget`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "PostgreSQL's datum sizes and alignments, restated"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\t: r === "numeric"',
				replacement: '\t\t\t: r !== "numeric"',
				why: "Operator mutant 8e1e18ac38 at packages/engine/src/scalar/compute/typing.ts:2160 in <module>: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** B-tree entries (nbtree.h BTMaxItemSize) hold a text no pattern bounds by its digest and refuse a key whose worst-case entry is above the item limit, and admit every other. Its budget is its suite's before it was a property (test/unit/schema/representability.test.ts at 4ca3036a): 150 runs and 150 steered cases. */
export const bTreeEntriesNbtreeHBTMaxItemSizeHoldATextNoPatternBoundsByItsDigestAndRefuseAKeyWhoseWorstCaseEntryIsAboveTheItemLimitAndAdmitEveryOther =
	property.explore(
		(source) => ({
			fields: source.draw(nonEmptyOf(keyFieldGen, 4)),
			primary: source.draw(boolean),
			boundary: source.draw(
				weighted([
					[1, constant<KeySizeSketch["boundary"]>({ kind: "none" })],
					[
						1,
						map(
							(inner) => ({ delta: inner.draw(int(-8, 8)), octets: inner.draw(boolean) }),
							({ delta, octets }): KeySizeSketch["boundary"] => ({
								kind: "at",
								delta,
								octets
							})
						)
					]
				])
			)
		}),
		{
			needs: {},
			budget: { runs: 150, steered: 150 },
			situations: [
				"admitted",
				"imaged",
				"refused, over the limit",
				"at the limit, admitted",
				"at the limit, refused",
				"primary",
				"candidate"
			] satisfies ReadonlyArray<Reached<KeySizeFeature>>,
			check: (_, c: Case<KeySizeFeature>) => (s) =>
				Effect.sync(() => {
					const fields = sizedFields(s)
					const planted = fields.length > s.fields.length
					c.note(s.primary ? "primary" : "candidate")
					const keyFields = Rec.fromEntries(
						Arr.map(fields, (f, i) => [`k${i}`, keyFieldDescriptor(f, i)])
					)
					const names = Rec.keys(keyFields)
					const R = s.primary
						? relation("R", keyFields, names, [])
						: relation("R", { id: Id, ...keyFields }, ["id"], [])
					const owned = ownValue(
						schema("Keys", [Kind, R], s.primary ? [] : [keyBuilder(onBuilder(R, names))], [])
					)
					if (Arr.some(fields, (f) => f.kind === "wildcard")) {
						c.note("imaged")
					}
					const admitted = btreeTupleBytes(keyedDatums(fields)) <= postgresBtreeMaxItem
					if (planted) {
						c.note(admitted ? "at the limit, admitted" : "at the limit, refused")
					}
					if (admitted) {
						c.note("admitted")
						succeeded(owned)
					} else {
						c.note("refused, over the limit")
						refused(owned, "UnrepresentableKey")
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "BTMaxItemSize and pg_type's sizes and alignments, restated, a text no pattern bounds held as SHA-256's 32 bytes"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/representability.ts",
					original: ") - alignUp(itemPointerBytes, maxAlign)",
					replacement: ") - alignUp(itemPointerBytes, maxAlign) + 16",
					why: "BTMaxItemSize sixteen bytes past PostgreSQL's."
				},
				{
					file: "packages/engine/src/schema/representability.ts",
					original: 'imagedText(desc) ? "textDigest" : undefined',
					replacement: "undefined",
					why: "A text of no byte bound keyed by itself again, which no entry holds: its key refused."
				},
				{
					file: "packages/engine/src/schema/representability.ts",
					original: 'textDigest: fixed(varlenaHeaderBytes + sha256Bytes, 4, "bytea")',
					replacement: 'textDigest: fixed(varlenaHeaderBytes, 4, "bytea")',
					why: "The digest counted at no byte, so a key the image overfills is admitted."
				}
			]
		}
	)

/** B-tree entries (nbtree.h BTMaxItemSize) refuses a key of more than 32 fields, PostgreSQL's INDEX_MAX_KEYS, and admits one of at most 32, span keys included. Its budget is its suite's before it was a property (test/unit/schema/representability.test.ts at 4ca3036a): 120 runs and 120 steered cases. */
export const bTreeEntriesNbtreeHBTMaxItemSizeRefusesAKeyOfMoreThan32FieldsPostgreSQLsINDEXMAXKEYSAndAdmitsOneOfAtMost32SpanKeysIncluded =
	property.explore(
		(source) => ({
			width: source.draw(int(postgresIndexMaxKeys - 3, postgresIndexMaxKeys + 3)),
			kind: source.draw(element(["primary" as const, "candidate" as const, "span" as const]))
		}),
		{
			needs: {},
			budget: { runs: 120, steered: 120 },
			situations: [
				"primary admitted",
				"primary refused",
				"candidate admitted",
				"candidate refused",
				"span admitted",
				"span refused"
			] satisfies ReadonlyArray<
				Reached<`${"primary" | "candidate" | "span"} ${"admitted" | "refused"}`>
			>,
			check:
				(_, c: Case<`${"primary" | "candidate" | "span"} ${"admitted" | "refused"}`>) =>
				({ width, kind }) =>
					Effect.sync(() => {
						const admitted = width <= postgresIndexMaxKeys
						c.note(`${kind} ${admitted ? "admitted" : "refused"}`)
						const fields: Record<string, FieldBase> =
							kind === "span"
								? { during: rawSpan(rawPg.bigint), ...scalars(width - 1) }
								: scalars(width)
						const names = Rec.keys(fields)
						const R =
							kind === "candidate"
								? relation("Wide", fields, ["f00"], [])
								: relation("Keyed", fields, names, [])
						const result = ownOne(R, kind === "candidate" ? [keyBuilder(onBuilder(R, names))] : [])
						if (admitted) {
							succeeded(result)
						} else {
							refused(result, "UnrepresentableKey")
						}
					}),
			oracle: { kind: "specification", name: "INDEX_MAX_KEYS, restated" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/representability.ts",
					original: "export const indexMaxKeys = 32",
					replacement: "export const indexMaxKeys = 33",
					why: "INDEX_MAX_KEYS one past PostgreSQL's."
				}
			]
		}
	)

/** GiST entries for span keys (gist.c gistSplit) lays a span key out over btree_gist's scalar keys and the span, and refuses a key with two span fields. Its budget is its suite's before it was a property (test/unit/schema/representability.test.ts at 4ca3036a): 120 runs and 120 steered cases. */
export const giSTEntriesForSpanKeysGistCGistSplitLaysASpanKeyOutOverBtreeGistsScalarKeysAndTheSpanAndRefusesAKeyWithTwoSpanFields =
	property.explore(
		(source) => ({
			scalars: source.draw(array(spanScalarGen, { min: 0, max: 3 })),
			endpoint: source.draw(element<"integer" | "bigint">(["integer", "bigint"])),
			position: source.draw(pickGen),
			second: source.draw(boolean)
		}),
		{
			needs: {},
			budget: { runs: 120, steered: 120 },
			situations: [
				"two spans",
				"span first",
				"span inside",
				"span last",
				"int4range",
				"int8range"
			] satisfies ReadonlyArray<Reached<SpanKeyFeature>>,
			check: (_, c: Case<SpanKeyFeature>) => (sketch2) =>
				Effect.gen(function* () {
					const resolved = ((s) => s)(sketch2)
					const s = resolved
					return yield* Effect.sync(() => {
						const scalarFields: ReadonlyArray<readonly [string, FieldBase]> = Arr.map(
							s.scalars,
							(f, i): readonly [string, FieldBase] => [
								`s${i}`,
								f.kind === "text" ? regex(`^[a-z]{0,${f.length}}$`, "u") : keyFieldDescriptor(f, i)
							]
						)
						const at = pickIndex(s.position, scalarFields.length + 1)
						const during: readonly [string, FieldBase] = [
							"during",
							rawSpan(s.endpoint === "integer" ? rawPg.integer : rawPg.bigint)
						]
						const ordered = [...scalarFields.slice(0, at), during, ...scalarFields.slice(at)]
						const keyed = s.second
							? [...ordered, ["other", rawSpan(rawPg.bigint)] as const]
							: ordered
						const names = Arr.map(keyed, ([name]) => name)
						const R = relation("Booking", Rec.fromEntries(keyed), names, [])
						const owned = ownValue(schema("Keys", [Kind, R], [], []))
						if (s.second) {
							c.note("two spans")
							refused(owned, "UnrepresentableKey")
							return
						}
						c.note(
							at === 0 ? "span first" : at === scalarFields.length ? "span last" : "span inside"
						)
						c.note(s.endpoint === "integer" ? "int4range" : "int8range")
						succeeded(owned)
						const descs = fieldDescsOf(R)
						const layout = keyLayout(
							Arr.map(names, (field) => ({
								field,
								desc: defined(descs[field], `field ${field}`)
							}))
						)
						if (!layout.ok) {
							return assert.fail(layout.error.kind)
						}
						assert.deepEqual(layout.value.fields, names)
						/**
						 * int4range is 17 bytes at most and int8range 25: a varlena header, the type oid, a flags byte and two bounds.
						 */
						const rangeBytes = s.endpoint === "integer" ? 17 : 25
						const scalarKeys = Arr.map(s.scalars, (f) =>
							f.kind === "text"
								? gistKeyBytes("text", 4 + f.length)
								: gistKeyBytes(spanScalarFamily(f), fixedTyplens[spanScalarFamily(f)])
						)
						const gist = defined(layout.value.gist, "a span key's GiST layout")
						const counted: { readonly span: string; readonly bytes: number } = gist
						assert.deepEqual(counted, {
							span: "during",
							bytes: gistTupleBytes([...scalarKeys, rangeBytes])
						})
					})
				}),
			oracle: {
				kind: "specification",
				name: "btree_gist's scalar keys and the span, laid out"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/schema/representability.test.ts#giSTEntriesForSpanKeysGistCGistSplitLaysASpanKeyOutOverBtreeGistsScalarKeysAndTheSpanAndRefusesAKeyWithTwoSpanFields:-:2.3.4.3.4.1.pa8.0"
					),
					reason: "the span between two text fields",
					since: "2026-10-29"
				}
			],
			kills: [
				{
					file: "packages/engine/src/core/canonical.ts",
					original: "\t\tif (i === frame.value.length) {",
					replacement: "\t\tif (i !== frame.value.length) {",
					why: "Operator mutant 86f785722d at packages/engine/src/core/canonical.ts:763 in <module>: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
				}
			]
		}
	)

/** GiST entries for span keys (gist.c gistSplit) bounds a GiST entry by btree_gist's two-bound key representation, refusing a vector. Its budget is its suite's before it was a property (test/unit/schema/representability.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const giSTEntriesForSpanKeysGistCGistSplitBoundsAGiSTEntryByBtreeGistsTwoBoundKeyRepresentationRefusingAVector =
	property.explore(array(gistDatumGen, { min: 0, max: 5 }), {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"vector refused",
			"within a GiST page",
			"above a GiST page"
		] satisfies ReadonlyArray<Reached<GistFeature>>,
		check: (_, c: Case<GistFeature>) => (sketch2) =>
			Effect.gen(function* () {
				const resolved = ((datums) => datums)(sketch2)
				const drawnDatums = resolved
				return yield* Effect.sync(() => {
					const datums: ReadonlyArray<DatumBound> = Arr.map(drawnDatums, ({ family, bytes }) => ({
						family,
						bytes,
						align: 4
					}))
					const result = gistEntryBytes(Arr.map(datums, (datum, i) => ({ field: `f${i}`, datum })))
					const firstVector = Arr.findFirstIndex(datums, (d) => d.family === "vector")
					if (Option.isSome(firstVector)) {
						c.note("vector refused")
						assert.deepEqual(result, Result.err(`f${firstVector.value}`))
						return
					}
					const keys = Arr.map(datums, (d) =>
						d.family === "vector" ? 0 : gistKeyBytes(d.family, d.bytes)
					)
					const bytes = gistTupleBytes(keys)
					c.note(bytes <= postgresGistMaxItem ? "within a GiST page" : "above a GiST page")
					assert.deepEqual(result, Result.ok(bytes))
				})
			}),
		oracle: {
			kind: "second-implementation",
			name: "btree_gist's two-bound key representation, restated"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/schema/representability.test.ts#giSTEntriesForSpanKeysGistCGistSplitBoundsAGiSTEntryByBtreeGistsTwoBoundKeyRepresentationRefusingAVector:-:2.a.2b7.a.2b7"
				),
				reason: "two text datums of 3,000 bytes",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/text/src/regex/nfa.ts",
				original: "this.#copy(task.node, task.chain, task.to, tasks)",
				replacement: "{}",
				why: "Operator mutant a7546f2f39 at packages/text/src/regex/nfa.ts:129 in <module>: `this.#copy(task.node, task.chain, task.to, tasks)` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** A vector field is a key field like any other: every vector has one form, so its equality is identity admits a key holding a vector where its B-tree entry fits, and refuses one beside a span, which btree_gist cannot index. Its budget is its suite's before it was a property (test/unit/schema/representability.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const aVectorFieldIsAKeyFieldLikeAnyOtherEveryVectorHasOneFormSoItsEqualityIsIdentityAdmitsAKeyHoldingAVectorWhereItsBTreeEntryFitsAndRefusesOneBesideASpanWhichBtreeGistCannotIndex =
	property.explore(vectorKeySketchGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"vector in the primary key",
			"vector in a candidate key",
			"contract over a vector",
			"vector beside a span refused",
			"a vector key admitted",
			"a vector key above the B-tree limit"
		] satisfies ReadonlyArray<Reached<VectorKeyFeature>>,
		check: (_, c: Case<VectorKeyFeature>) => (s) =>
			Effect.sync(() => {
				const others: Array<readonly [string, FieldBase]> = Arr.map(
					s.scalars,
					(field, i): readonly [string, FieldBase] => [`k${i}`, field]
				)
				if (s.span) {
					others.push(["during", rawSpan(rawPg.bigint)])
				}
				const vector = s.contract
					? bareContract("Embedding", rawPg.vector(s.dimensions))
					: rawPg.vector(s.dimensions)
				const keyFields: ReadonlyArray<readonly [string, FieldBase]> = [...others, ["v", vector]]
				const fields = Rec.fromEntries(keyFields)
				const scalarKey = Arr.map(others, ([name]) => name)
				const vectorKey = Arr.map(keyFields, ([name]) => name)
				const keyed = relation("R", fields, s.primary ? vectorKey : scalarKey, [])
				const owned = ownValue(
					schema("Keys", [keyed], s.primary ? [] : [keyBuilder(onBuilder(keyed, vectorKey))], [])
				)
				const layout = keyLayout(
					Arr.map(keyFields, ([field, descriptor]) => ({ field, desc: descOf(descriptor) }))
				)
				const columns = Arr.map(keyFields, ([name, descriptor]) => ({
					name,
					datum: boundOf(descriptor),
					nullable: false
				}))
				const bytes = btreeEntryBytes(columns)
				c.note(s.primary ? "vector in the primary key" : "vector in a candidate key")
				if (s.contract) {
					c.note("contract over a vector")
				}
				if (s.span) {
					assert.deepEqual(layout, Result.err<KeyFault>({ kind: "gistOperatorClass", field: "v" }))
					refused(owned, "UnrepresentableKey")
					c.note("vector beside a span refused")
				} else if (bytes > btreeMaxItemSize) {
					assert.deepEqual(
						layout,
						Result.err<KeyFault>({
							kind: "btreeEntry",
							bytes,
							limit: btreeMaxItemSize,
							datums: Arr.map(columns, (col) => ({ field: col.name, bytes: col.datum.bytes }))
						})
					)
					refused(owned, "UnrepresentableKey")
					c.note("a vector key above the B-tree limit")
				} else {
					assert.ok(layout.ok, "the key's layout")
					succeeded(owned)
					c.note("a vector key admitted")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the B-tree entry of a vector key, restated, and btree_gist's refusal of a vector beside a span"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/charset.ts",
				original: "\t\t\thi = mid - 1",
				replacement: "\t\t\thi = mid - 0",
				why: "Operator mutant cd0910928b at packages/text/src/regex/charset.ts:108 in has: `1` becomes `0`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})
