/**
 * Key inheritance for derived relations: a derived relation needs no declared key and admits none. Its keys are the
 * keys its definition proves, each in heading order, narrowest first and then by heading position, none implied by a
 * narrower one; the whole heading when nothing narrower is proven; and for a definition of at most one fact its first
 * representable column. Each becomes a unique index, so each must fit PostgreSQL's B-tree entry and column limits, and
 * a definition a stored table cannot hold is refused.
 *
 * - Key rules: over the derived oracle's unit-local generated schemas (drawn levels, aggregates, a level over the one
 *   below), whose stored relations the derived analysis keys, every stored relation's keys keep those rules, a level is
 *   one above the derived relations it reads, and queries over a relation see its keys. Oracle: the rules as a checker (keyRules). Features: the whole heading, at most one fact, a level over a
 *   derived relation, and a negation over a level whose conditional count is numeric (sum(cond(flag, 1, 0)), an exact
 *   numeric the generator must type as one, or it binds that count to a bigint field: test/pg/derived/oracle/gen.ts
 *   aggregated).
 * - Join keys: over generated joins of relations keyed by primary and candidate keys, each matched once, their heads
 *   in a drawn order, every key the view indexes is a minimal set of head columns whose closure, under each relation's
 *   keys bound whole, holds the head, and the keys the view states, each key's factors chosen among its alternatives,
 *   are exactly those minimal sets. Oracle: the closure of the head's variables, a second implementation. Features:
 *   JoinFeature, and two pairs of them.
 * - Product keys: over products of relations keyed by either of two fields, through projections, joins, several rules
 *   and a level above, the view indexes one unique index per alternative of a factor and states exactly its minimal
 *   keys. Oracle: the minimal sets by closure and their finest product partition, found by brute force. Features:
 *   ProductFeature, and two pairs of them.
 * - Storable: over generated definitions of one relation of drawn field types (uuid, integer, bounded and wildcard
 *   text, vectors of drawn dimensions): a plain head in a drawn order, possibly empty; a grouped count; a global
 *   aggregate; a head with an attachment; a union of two heading groups; and a head of a drawn number of integer
 *   columns around INDEX_MAX_KEYS. The model: the spine's obstacle, then the empty heading, then the key the
 *   definition proves (the primary key when the head or the group holds it, the group, the head, or the first
 *   representable column of one fact) refused at the first whose unique index layout faults, as wholeHeading,
 *   inheritedKey or oneFact with that fault, and admitted with exactly those keys otherwise. Oracle: that model, a
 *   specification. Features: each refusal kind and fault, admitted, and one fact keyed past its first column. The
 *   faults themselves (unbounded text, B-tree entry bytes, column count) are the representability suite's, against
 *   PostgreSQL's own sizes.
 * - Named key: every view of a relation keyed by its id that names the id one to three times, beside its other field
 *   or not, and a level reading the view whole, state each name as a key alone. Oracle: every name of the key is one
 *   column of every row, each a key alone: the view states the other names as the key's members, the columns its
 *   definition makes equal to its field (classMembers), not as alternatives of a factor. Features: one, two and three
 *   names.
 * - Call keys: a stored relation over a row of lists and the rows a call returns at it, a token split of its list
 *   (r.tokens), a separator split of it (r.split), a series from its low to its high (r.series) or a declared
 *   function's rows (Fn.rows), each place in the head, fixed to a literal or dropped, or its rest after a prefix
 *   (r.rest), is keyed as the call's rows are at their argument (ir/rel.ts callNumbering): a split's and a series' by their
 *   place, a rest's by the argument alone, a declared function's by its whole heading. edullm's stored walks over a
 *   pantry attribute's tokens (WalkCategory, WalkLiteralPair) proved no key narrower than their whole heading, a token
 *   of no byte bound, and were refused. Oracle: the call's rows keyed as their source numbers them, a specification.
 *   Features: each call and each use of its place.
 *
 * That the keys are sound, a stored relation never holding two facts under one, is the stored relations' equality
 * oracle's (test/pg/derived), whose tables hold their unique indexes.
 */

import { indices, maxOf } from "@bjornpagen/grizzle-text/base/array"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, deepEquals, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, boolean, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { derivedKeyLayout } from "#compiler/analysis/derived/keys.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder as runtimeDerived } from "#compiler/schema/relation.ts"
import { schemaBuilder as runtimeSchema } from "#compiler/schema/schema.ts"
import {
	buildSchema,
	unitLocalCondNegationSketchGen,
	unitLocalSketchGen
} from "#test/pg/derived/oracle/gen.ts"
import { succeeded } from "#test/support/assert.ts"
import { analysesOf } from "#test/support/derived.ts"
import { checkedIn } from "#test/support/policy.ts"
import {
	aboveOf,
	type CallKeyCase,
	callKeyCase,
	callKeyModel,
	callKeySchema,
	callSources,
	headName,
	type JoinFeature,
	joinFeatures,
	joinOf,
	joinSketchGen,
	Keyed,
	keyedBase,
	type KeyFeature,
	keyName,
	keyRules,
	minimalKeys,
	type NamedKey,
	ordinalUses,
	pastFirstColumnCaseGen,
	productAims,
	type ProductFeature,
	productFeatures,
	productLaws,
	productMinimal,
	productOf,
	productSketchGen,
	storableCaseGen,
	type StorableFeature,
	storableModel,
	storableOf,
	twoFactorSketchGen,
	viewStated
} from "#test/unit/derived/keys.fixtures.ts"

/**
 * Derived relation keys are proven keys in heading order, narrowest first, none implied by another, the whole heading
 * only alone.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/derived/keys.test.ts:1450 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedRelationKeysAreProvenKeysInHeadingOrderNarrowestFirstNoneImpliedByAnotherTheWholeHeadingOnlyAlone =
	property.explore(
		aimed(unitLocalSketchGen, [
			["a negation over a level whose conditional count is numeric", unitLocalCondNegationSketchGen]
		]),
		{
			needs: {},
			budget: { runs: 100, steered: 100 },
			situations: [
				"the whole heading",
				"at most one fact",
				"a level over a derived relation",
				"a negation over a level whose conditional count is numeric"
			] satisfies ReadonlyArray<Reached<KeyFeature>>,
			check: (_, c: Case<KeyFeature>) => (sketch) =>
				Effect.sync(() => {
					const built = buildSchema(sketch, { name: "Gen" })
					if (Arr.some(built.derived, (d) => d.negationOverCond)) {
						c.note("a negation over a level whose conditional count is numeric")
					}
					const analysis = succeeded(Result.flatMap(checkedIn(built.value), analysesOf))
					for (const r of analysis.order) {
						const name = r.name
						keyRules(r)
						const keys = Arr.map(r.keys, (k) => k.fields)
						if (keys.length > 1) {
							c.note("several keys")
						}
						if (r.wholeHeading) {
							c.note("the whole heading")
							assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(keys, [
								Arr.map(r.heading, (col) => col.name)
							])
						}
						if (r.card === "atMostOne") {
							c.note("at most one fact")
							const first = Arr.findFirst(r.heading, (col) => derivedKeyLayout([col]).ok)
							assert.ok(Option.isSome(first), `${name}'s first representable column`)
							assert.deepEqual(keys, [[first.value.name]])
							assert.equal(r.wholeHeading, false)
						}
						assert.deepEqual(
							Arr.map(r.read.keys, (k) => k.fields),
							keys
						)
						const below = Arr.flatMap(r.reads, (read) => {
							const lower = analysis.relations[read]
							return lower === undefined ? [] : [lower.level]
						})
						if (below.length > 0) {
							c.note("a level over a derived relation")
						}
						assert.equal(r.level, 1 + maxOf(below, 0), `${name}'s level`)
					}
				}),
			oracle: {
				kind: "specification",
				name: "proven keys in heading order, narrowest first, none implied by another, the whole heading only alone, one fact by its first representable column, a level one above what it reads"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/logical/derived.ts",
					original: "\t\tconst single = heading.find((c) => representable(c))",
					replacement: "\t\tconst single = heading.findLast((c) => representable(c))",
					why: "A definition of one fact is keyed by its last representable column; the key rules and the storable property fail."
				}
			]
		}
	)

/**
 * Derived relation keys state exactly the minimal sets of head columns a join's keys determine the head by, through
 * every relation it matches.
 *
 * Budget: 200 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/derived/keys.test.ts:1524 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedRelationKeysStateExactlyTheMinimalSetsOfHeadColumnsAJoinsKeysDetermineTheHeadByThroughEveryRelationItMatches =
	property.explore(
		aimed(joinSketchGen, [["a key of two factors, each with an alternative", twoFactorSketchGen]]),
		{
			needs: {},
			budget: { runs: 200, steered: 300 },
			situations: [
				"the whole heading",
				"a key narrower than the heading",
				"several keys",
				"a key of two factors, each with an alternative",
				"a candidate key determines",
				"a join of several relations",
				"a head out of its variables' order",
				["a join of several relations", "a key narrower than the heading"],
				["a head out of its variables' order", "several keys"]
			] satisfies ReadonlyArray<Reached<JoinFeature>>,
			check: (_, c: Case<JoinFeature>) => (sketch) =>
				Effect.gen(function* () {
					const j = joinOf(sketch)
					return yield* Effect.sync(() => {
						const expected = minimalKeys(j, (r) => r.keys)
						const d = defined(
							succeeded(
								Result.flatMap(
									checkedIn(
										runtimeSchema.extend(
											[j.base.schema],
											"Level5",
											[runtimeDerived("D", j.definition, [])],
											[],
											[]
										)
									),
									analysesOf
								)
							).relations["D"]
						)
						keyRules(d)
						const minimal = Arr.map(expected, (k) => Arr.map(k, headName))
						assert.ok(
							Arr.every(d.keys, (k) =>
								Arr.some(minimal, (m) => deepEquals<ReadonlyArray<string>>(m, k.fields))
							),
							"every key the view indexes is a minimal key of the join"
						)
						unorderedEqual(
							viewStated(d.read.keys),
							Arr.map(minimal, (k) => Arr.sort(k, Order.String))
						)
						const reached = joinFeatures(j, expected)
						c.noteAll(reached)
						if (
							Arr.contains(reached, "a join of several relations") &&
							Arr.contains(reached, "a key narrower than the heading")
						) {
							c.pair("a join of several relations", "a key narrower than the heading")
						}
						if (
							Arr.contains(reached, "a head out of its variables' order") &&
							Arr.contains(reached, "several keys")
						) {
							c.pair("a head out of its variables' order", "several keys")
						}
					})
				}),
			oracle: {
				kind: "second-implementation",
				name: "the closure of the head's variables under each matched relation's keys bound whole, the head's minimal sets whose closure holds it"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/keys.ts",
					original:
						"): KeyFactor => Object.freeze({ key, alternatives: Object.freeze([...alternatives]) })",
					replacement: "): KeyFactor => Object.freeze({ key, alternatives: Object.freeze([]) })",
					why: "No factor's alternatives are listed (ir/keys.ts keyFactor); the join keys and the product keys fail."
				}
			]
		}
	)

/**
 * Derived relation keys index a product of relations keyed by either of two fields once per alternative of a factor,
 * through projections, joins, several rules and a level above, stating exactly its minimal keys.
 *
 * Budget: 200 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/derived/keys.test.ts:1608 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedRelationKeysIndexAProductOfRelationsKeyedByEitherOfTwoFieldsOncePerAlternativeOfAFactorThroughProjectionsJoinsSeveralRulesAndALevelAboveStatingExactlyItsMinimalKeys =
	property.explore(aimed(productSketchGen, productAims), {
		needs: {},
		budget: { runs: 200, steered: 300 },
		situations: [
			"four factors of two minimal keys each",
			"a factor's minimal key of several columns",
			"a projection dropping a column",
			"relations joined on a variable",
			"a level reading the view whole",
			"a level reading the view beside one of its relations",
			"several rules",
			"several rules of four factors of two minimal keys each",
			"rules keying a relation apart",
			"a key no rule's keys hold alone",
			["four factors of two minimal keys each", "a level reading the view whole"],
			["several rules", "a level reading the view whole"]
		] satisfies ReadonlyArray<Reached<ProductFeature>>,
		check: (_, c: Case<ProductFeature>) => (sketch) =>
			Effect.gen(function* () {
				const p = productOf(sketch)
				return yield* Effect.sync(() => {
					const minimal = productMinimal(p)
					const view = runtimeDerived("D", p.definition, [])
					const level = runtimeSchema.extend([p.base.schema], "Level1", [view], [], [])
					const above = aboveOf(p, minimal, view, level)
					const analysis = succeeded(
						Result.flatMap(
							checkedIn(
								above === undefined
									? level
									: runtimeSchema.extend(
											[level],
											"Level6",
											[runtimeDerived("E", above.definition, [])],
											[],
											[]
										)
							),
							analysesOf
						)
					)
					productLaws(defined(analysis.relations["D"]), minimal)
					if (above !== undefined) {
						productLaws(defined(analysis.relations["E"]), above.minimal)
					}
					const reached = productFeatures(p, minimal)
					c.noteAll(reached)
					for (const first of ["four factors of two minimal keys each", "several rules"] as const) {
						if (
							Arr.contains(reached, first) &&
							Arr.contains(reached, "a level reading the view whole")
						) {
							c.pair(first, "a level reading the view whole")
						}
					}
				})
			}),
		oracle: {
			kind: "second-implementation",
			name: "the head's minimal sets whose closure under each matched relation's keys holds it in every rule, beside the rules' tag when there are several, a level above's those with each key of the relation beside the view, and the finest partition of their columns they are the product of, found over every part"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/keys.ts",
				original:
					"): KeyFactor => Object.freeze({ key, alternatives: Object.freeze([...alternatives]) })",
				replacement: "): KeyFactor => Object.freeze({ key, alternatives: Object.freeze([]) })",
				why: "No factor's alternatives are listed (ir/keys.ts keyFactor); the join keys and the product keys fail."
			},
			{
				file: "packages/engine/src/analysis/logical/derived.ts",
				original: "\t\t...root.factors.flatMap((f) =>",
				replacement: "\t\t...root.factors.slice(0, 1).flatMap((f) =>",
				why: "Only the first factor's alternatives are listed; the product keys fail."
			}
		]
	})

/**
 * Derived relation keys refuse a definition no view can store or index with its typed cause, and key every other as it
 * proves.
 *
 * Budget: 200 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/derived/keys.test.ts:1689 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedRelationKeysRefuseADefinitionNoViewCanStoreOrIndexWithItsTypedCauseAndKeyEveryOtherAsItProves =
	property.explore(
		aimed(storableCaseGen, [["one fact keyed past its first column", pastFirstColumnCaseGen]]),
		{
			needs: {},
			budget: { runs: 200, steered: 300 },
			situations: [
				"attachment",
				"headingGroups",
				"emptyHeading",
				"wholeHeading",
				"inheritedKey",
				"oneFact",
				"admitted",
				"fault unboundedText",
				"fault btreeEntry",
				"fault columns",
				"one fact keyed past its first column"
			] satisfies ReadonlyArray<Reached<StorableFeature>>,
			check: (_, k: Case<StorableFeature>) => (c) =>
				Effect.sync(() => {
					const { base, definition } = storableOf(c)
					const analyzed = Result.flatMap(
						checkedIn(
							runtimeSchema.extend([base], "Level2", [runtimeDerived("D", definition, [])], [], [])
						),
						analysesOf
					)
					const expected = storableModel(c)
					if (expected.kind === "named") {
						k.note(expected.feature)
						assert.ok(!analyzed.ok, "a definition no view stores is refused")
						const reason = analyzed.error.reason
						assert.ok(reason._tag === "Refused", analyzed.error.message)
						assert.equal(reason.refusal, expected.refusal)
						return
					}
					if (expected.kind === "refused") {
						k.note(expected.cause.kind)
						if (
							expected.cause.kind === "wholeHeading" ||
							expected.cause.kind === "inheritedKey" ||
							expected.cause.kind === "oneFact"
						) {
							k.note(`fault ${expected.cause.fault.kind}`)
						}
						assert.ok(!analyzed.ok, "a definition no view stores is refused")
						const reason = analyzed.error.reason
						assert.ok(reason._tag === "DerivedRefused", analyzed.error.message)
						assert.deepEqual(reason.cause, expected.cause)
						return
					}
					k.note("admitted")
					const d = defined(succeeded(analyzed).relations["D"])
					keyRules(d)
					assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
						Arr.map(d.keys, (key) => key.fields),
						expected.keys
					)
					assert.equal(d.wholeHeading, expected.wholeHeading)
					if (
						c.shape.kind === "global" &&
						Arr.headNonEmpty(Arr.headNonEmpty(expected.keys)) !== "a0"
					) {
						k.note("one fact keyed past its first column")
					}
				}),
			oracle: {
				kind: "specification",
				name: "the spine's obstacle, the empty heading, then the proven key refused at its first faulting layout"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/logical/derived.ts",
					original: "\t\tconst single = heading.find((c) => representable(c))",
					replacement: "\t\tconst single = heading.findLast((c) => representable(c))",
					why: "A definition of one fact is keyed by its last representable column; the key rules and the storable property fail."
				},
				{
					file: "packages/engine/src/analysis/derived/analyze.ts",
					original: '\t\t\t\t\tkind: wholeHeading ? "wholeHeading" : "inheritedKey",',
					replacement: '\t\t\t\t\tkind: wholeHeading ? "inheritedKey" : "wholeHeading",',
					why: "A faulting key is refused under the other kind, wholeHeading for inheritedKey and back; the storable property fails."
				}
			]
		}
	)

/** Derived relation keys state each name a view's head gives its key's variable as a key, and so does a level reading the view whole. */
export const derivedRelationKeysStateEachNameAViewsHeadGivesItsKeysVariableAsAKeyAndSoDoesALevelReadingTheViewWhole =
	property.exhaust(
		finite((source): NamedKey => ({
			names: source.draw(int(1, 3)),
			other: source.draw(boolean)
		})),
		{
			needs: {},
			situations: ["one name", "two names", "three names"] satisfies ReadonlyArray<
				Reached<"one name" | "two names" | "three names">
			>,
			check: (_, k: Case<"one name" | "two names" | "three names">) => (c) =>
				Effect.sync(() => {
					const names = Arr.map(indices(c.names), keyName)
					const heading = [...names, ...(c.other ? ["other"] : [])]
					const view = runtimeDerived(
						"D",
						queryOver(keyedBase).rule((r: RuleValue) => {
							const keyed = varsOver(Keyed, "keyed")
							return r.match(Keyed, { id: keyed["id"], other: keyed["other"] }).find({
								...Rec.fromEntries(Arr.map(names, (n) => [n, keyed["id"]] as const)),
								...(c.other ? { other: keyed["other"] } : {})
							})
						}),
						[]
					)
					const level = runtimeSchema.extend([keyedBase], "Level3", [view], [], [])
					const above = runtimeDerived(
						"E",
						queryOver(level).rule((r: RuleValue) => {
							const d = varsOver(view, "d")
							const terms = Rec.fromEntries(Arr.map(heading, (n) => [n, d[n]] as const))
							return r.match(view, terms).find(terms)
						}),
						[]
					)
					const analysis = succeeded(
						Result.flatMap(
							checkedIn(runtimeSchema.extend([level], "Level4", [above], [], [])),
							analysesOf
						)
					)
					for (const name of ["D", "E"]) {
						const r = defined(analysis.relations[name], name)
						keyRules(r)
						unorderedEqual(
							viewStated(r.read.keys),
							Arr.map(names, (n) => [n])
						)
					}
					k.note(c.names === 1 ? "one name" : c.names === 2 ? "two names" : "three names")
				}),
			oracle: {
				kind: "specification",
				name: "every name of Keyed's key is one column of every row, each a key alone, and the other field none"
			},
			box: "a view of Keyed naming its key one to three times, beside its other field or not, and a level above reading the view whole",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/derived/analyze.ts",
					original: "\t\tmembers: classMembers(k.proof),",
					replacement: "\t\tmembers: [],",
					why: "A view's key states none of its members (analysis/derived/analyze.ts viewKeysOf), so a name of the key but the first is no key; the named key fails."
				}
			]
		}
	)

/**
 * A stored relation over a call's rows is keyed as they are at the call's argument: a split's and a series' by their
 * place, a rest's and a split at the last separator's by the argument alone, a declared function's by its whole
 * heading.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aStoredRelationOverACallsRowsIsKeyedByThePlaceThatNumbersThemAtItsArgumentOrByTheirWholeHeading =
	property.exhaust(finite(callKeyCase), {
		needs: {},
		situations: [...callSources, ...ordinalUses] satisfies ReadonlyArray<
			Reached<CallKeyCase["call"] | CallKeyCase["ordinal"]>
		>,
		check: (_, k: Case<CallKeyCase["call"] | CallKeyCase["ordinal"]>) => (c) =>
			Effect.sync(() => {
				const analyzed = Result.flatMap(checkedIn(callKeySchema(c)), analysesOf)
				const expected = callKeyModel(c)
				const label = `${c.call}, ${c.ordinal}`
				if (expected.kind === "refused") {
					assert.ok(!analyzed.ok, `${label}: a key of a token is refused`)
					const reason = analyzed.error.reason
					assert.ok(
						reason._tag === "DerivedRefused" && reason.cause.kind === "wholeHeading",
						`${label}: ${analyzed.error.message}`
					)
				} else {
					assert.ok(analyzed.ok, `${label}: ${analyzed.ok ? "" : analyzed.error.message}`)
					const d = defined(analyzed.value.relations["D"])
					keyRules(d)
					assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
						Arr.map(d.keys, (key) => Arr.sort(key.fields, Order.String)),
						expected.keys,
						label
					)
				}
				k.note(c.call)
				k.note(c.ordinal)
			}),
		oracle: {
			kind: "specification",
			name: "a call's rows keyed at its argument as its source numbers them: a split's and a series' by their place, a rest's and a split at the last separator's by its argument alone, a declared function's by its whole heading"
		},
		box: "a row of lists keyed by its id, beside a token split of its list, a separator split of it, a series from its low to its high or a declared function's rows of its list, each place in the head, fixed to a literal (but a series') or dropped, or its rest after a prefix, or its split at its last comma, or the text after its bounded path's last comma alone",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\t\t\t? [numberedRow([], rows.ordinal, all)]\n",
				replacement: "\t\t\t\t\t? []\n",
				why: "A call's place keys none of its rows: a stored relation of a list's tokens at their places proves only its whole heading, a token of no byte bound, and is refused, as edullm's WalkCategory and WalkLiteralPair were."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: '\t\t\t\t\t\t? [atMostOneRow(all, { kind: "partialSplit" })]\n',
				replacement: "\t\t\t\t\t\t? []\n",
				why: "A rest's one row is keyed by nothing at its arguments: a stored relation of a list's rest proves only its whole heading, a rest of no byte bound, and is refused."
			},
			{
				file: "packages/engine/src/ir/rel.ts",
				original: '\tsplitLast: { kind: "one" }\n',
				replacement: '\tsplitLast: { kind: "set" }\n',
				why: "A split at the last separator's rows are a set nothing numbers at its argument: a stored relation of the text after a list's last comma proves only its whole heading, a text of no byte bound, and is refused."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\tconst bytes = textInfoBounds(text)?.bytes\n\t\tconst language = bytes === undefined ? pattern : languageWithin(pattern, bytes)\n\t\treturn this.schema.queryFieldType(",
				replacement:
					"\t\tconst bytes = undefined\n\t\tconst language = bytes === undefined ? pattern : languageWithin(pattern, bytes)\n\t\treturn this.schema.queryFieldType(",
				why: "The text after a last separator is typed with no byte bound, so a stored relation keyed by the text after a bounded path's last comma keys by a text no B-tree entry holds, and is refused."
			}
		]
	})
