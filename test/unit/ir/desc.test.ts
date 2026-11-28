/**
 * Descriptions (ir/desc.ts), the boundary every artifact a JavaScript author writes is decoded at, over the samples of
 * every kind, a corpus of them and generated expressions.
 *
 * - Locations: every node an author leaves unlocated is located by its path, and a stated location is kept.
 * - Combinators: a query keeps the order of its combinators; two chains are one description exactly when they are one
 *   chain, and each round-trips JSON.
 * - Ordered: an Ordered is admitted exactly where a whole query stands.
 * - Arms: a scale and an aggregate's argument decode exactly where their arm states them, refused at their own path
 *   anywhere else.
 * - Corruptions: a description broken at one part or one rule is refused, and every other decodes.
 * - Nesting: an in-memory description of any depth decodes without deepening the stack, a cyclic one is refused, and a
 *   shared value is no cycle.
 * - Literals: bigint, Decimal, Money and Vector travel as tagged strings and a leading tilde is escaped; generated
 *   expressions round-trip JSON to one canonical text; an empty and or or is its builder's constant.
 *
 * Oracles: each rule of the boundary as a checker, the round trip through JSON, and the builders' own constants.
 *
 * Features: as each search names them: every kind located and stated, chains told apart (by a take's count alone among
 * them) and alike, every position of an Ordered, each arm decoded and refused, live and every corruption, each nesting,
 * each tag, each empty connective in each place.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, containsText, lacksText, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import {
	aimed,
	boolean,
	constant,
	element,
	finite,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { type CorruptedFeature, corruptedFeature } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { decodeDesc, descText, descToJson } from "#compiler/ir/desc.ts"
import { Logic } from "#compiler/public/compute.ts"
import { predicateExpr } from "#compiler/scalar/compute/term.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { refusalLoc, succeeded } from "#test/support/assert.ts"
import { descFromJson } from "#test/support/describe.ts"
import type { AuthoredExprDesc as ExprDesc } from "#test/support/fixtures/ir/desc.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { fail } from "#test/support/unit/ir/fixture.ts"
import {
	budgetRule,
	chain,
	chained,
	corpusGen,
	corruptionAims,
	countSwapped,
	decodeHanded,
	descCaseGen,
	descCorruptions,
	type DescRule,
	editedAt,
	emptied,
	emptiedGen,
	type EmptyFeature,
	exprsGen,
	literalsOf,
	located,
	type LocatedFeature,
	locatedKinds,
	type Nesting,
	notChain,
	ownedGen,
	queryPlaceOf,
	queried,
	queriesIn,
	type QueryPlace,
	reach,
	refuses,
	sampleCaseGen,
	roundTrips,
	rule,
	rules,
	sameChain,
	space,
	stated,
	statedAt,
	type TagFeature,
	tagOf,
	throughJson,
	top,
	versioned,
	wholePlaces
} from "#test/unit/ir/desc.fixtures.ts"

/**
 * Descriptions locates every node a JavaScript author leaves unlocated by its path, and keeps a stated location.
 *
 * Budget: 300 runs and 2000 steered cases, what its suite stated before it became a property
 * (test/unit/ir/desc.test.ts:781 at 8cad5bce, its runs and its coverage's cases).
 */
export const descriptionsLocatesEveryNodeAJavaScriptAuthorLeavesUnlocatedByItsPathAndKeepsAStatedLocation =
	property.explore(
		(source) => {
			const [kind, value] = source.draw(corpusGen)
			const sites = Arr.map(located(succeeded(decodeHanded(kind, value)), []), (l) => l.path)
			const site = source.draw(pickGen)
			return {
				kind,
				value,
				site: pickFrom<"none" | ReadonlyArray<string | number>>(["none", ...sites], site)
			}
		},
		{
			needs: {},
			budget: { runs: 300, steered: 2000 },
			situations: Arr.flatMap(locatedKinds, (kind): Arr.NonEmptyReadonlyArray<LocatedFeature> => [
				`located ${kind}`,
				`stated ${kind}`
			]) satisfies ReadonlyArray<Reached<LocatedFeature>>,
			check:
				(_, c: Case<LocatedFeature>) =>
				({ kind, value, site }) =>
					Effect.sync(() => {
						const input = site === "none" ? value : statedAt(value, site, stated)
						assert.equal(succeeded(descText(input)), succeeded(descText(value)))
						if (site !== "none") {
							assert.notDeepEqual(succeeded(descToJson(input)), succeeded(descToJson(value)))
						}
						/** One label names the description every unstated location lies in; the path is the node's own. */
						const labels = new Set<unknown>()
						for (const l of located(succeeded(decodeHanded(kind, input)), [])) {
							const isStated =
								site !== "none" &&
								l.path.length === site.length &&
								Arr.every(l.path, (p, i) => p === site[i])
							c.note(isStated ? `stated ${kind}` : `located ${kind}`)
							if (isStated) {
								assert.deepEqual(l.loc, stated)
								continue
							}
							assert.ok(l.loc !== null && typeof l.loc === "object", "a location")
							assert.deepEqual(Reflect.get(l.loc, "path"), l.path)
							labels.add(Reflect.get(l.loc, "label"))
						}
						assert.ok(
							labels.size <= 1,
							`one description label: ${Arr.join(
								Arr.map([...labels], (label) => String(label)),
								", "
							)}`
						)
					}),
			oracle: { kind: "universal", name: "a node's location is its path, a stated one kept" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/shape.ts",
					original:
						'\t\t\t("loc" in out ? parseSourceLoc(out.loc) : undefined) ?? SourceLoc(path.subject, path.keys)',
					replacement:
						'\t\t\t("loc" in out ? parseSourceLoc(out.loc) : undefined) ?? SourceLoc(path.subject, path.keys.slice(0, -1))',
					why: "A node its author leaves unlocated is located at its parent's path, not its own; the locations property fails."
				}
			]
		}
	)

/**
 * Descriptions keeps the order of a query's combinators: two chains are one description exactly when they are one
 * chain.
 *
 * Budget: 500 runs and 500 steered cases, what its suite stated before it became a property
 * (test/unit/ir/desc.test.ts:922 at 8cad5bce, its runs and its coverage's cases).
 */
export const descriptionsKeepsTheOrderOfAQuerysCombinatorsTwoChainsAreOneDescriptionExactlyWhenTheyAreOneChain =
	property.explore(
		(source) => {
			const overRecursion = source.draw(boolean)
			const a = source.draw(chain)
			/** Another chain, or the same one with its takes' counts swapped: told apart by its counts alone. */
			const b = source.draw(oneOf([chain, constant(Arr.map(a, countSwapped))]))
			return [overRecursion, a, b] as const
		},
		{
			needs: {},
			budget: { runs: 500, steered: 500 },
			situations: [
				"two chains told apart",
				"two chains told apart by a take's count alone",
				"one chain",
				"over a recursion",
				"a chain refused"
			] satisfies ReadonlyArray<
				Reached<
					| "two chains told apart"
					| "two chains told apart by a take's count alone"
					| "one chain"
					| "over a recursion"
					| "a chain refused"
				>
			>,
			check:
				(
					_,
					c: Case<
						| "two chains told apart"
						| "two chains told apart by a take's count alone"
						| "one chain"
						| "over a recursion"
						| "a chain refused"
					>
				) =>
				([overRecursion, a, b]) =>
					Effect.sync(() => {
						const start = overRecursion ? reach : rules(budgetRule)
						if (overRecursion) {
							c.note("over a recursion")
						}
						const [qa, qb] = [versioned(chained(start, a)), versioned(chained(start, b))]
						const [da, db] = [decodeDesc("query", qa), decodeDesc("query", qb)]
						if (!da.ok || !db.ok) {
							c.note("a chain refused")
							return
						}
						const same = sameChain(a, b)
						c.note(same ? "one chain" : "two chains told apart")
						if (!same && sameChain(Arr.map(a, countSwapped), b)) {
							c.note("two chains told apart by a take's count alone")
						}
						assert.equal(roundTrips(qa) === roundTrips(qb), same)
					}),
			oracle: {
				kind: "specification",
				name: "two chains of combinators are one description exactly when they are one chain"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/desc.ts",
					original: "encode(desc, withoutSourceLocs)",
					replacement:
						'encode(desc, { omit: (key, value) => withoutSourceLocs.omit(key, value) || key === "k" })',
					why: "The identity text omits a take's count, so take(2) and take(5) are one description; the combinators property fails."
				}
			]
		}
	)

/**
 * Descriptions admits an Ordered exactly where a whole query stands.
 *
 * Budget: 200 runs and 2000 steered cases, what its suite stated before it became a property
 * (test/unit/ir/desc.test.ts:1127 at 8cad5bce, its runs and its coverage's cases).
 */
export const descriptionsAdmitsAnOrderedExactlyWhereAWholeQueryStands = property.explore(
	(source) => [pickFrom(queried, source.draw(pickGen)), source.draw(pickGen)] as const,
	{
		needs: {},
		budget: { runs: 200, steered: 2000 },
		situations: [
			"a page's query",
			"an attachment child",
			"a read-back",
			"a workload program",
			"an imported source",
			"a ChangeSet member",
			"a derived definition"
		] satisfies ReadonlyArray<Reached<QueryPlace>>,
		check:
			(_, c: Case<QueryPlace>) =>
			([[kind, value], pick]) =>
				Effect.sync(() => {
					const path = pickFrom(nonEmpty(queriesIn(value), "a query's place"), pick)
					const place = queryPlaceOf(kind, value, path)
					if (place === undefined) {
						return assert.fail(
							`a query description at a place of no name: ${Formatter.format(path)}`
						)
					}
					c.note(place)
					const placed = editedAt(value, path, () => top)
					if (wholePlaces.includes(place)) {
						succeeded(decodeHanded(kind, placed))
						return
					}
					refuses(kind, placed)
				}),
		oracle: {
			kind: "specification",
			name: "an Ordered stands where a whole query does: a page, a child, a read-back, a program"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\t\t\t(m) => m >= 1 && m <= allenMaskMax,",
				replacement: "\t\t\t(m) => m >= 1 && m > allenMaskMax,",
				why: "Operator mutant (comparison) at packages/engine/src/ir/desc.ts:1718 in <module>: `<=` becomes `>`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}
)

/** Descriptions decodes a scale and an aggregate's argument exactly where their arm states them, and refuses each anywhere else. */
export const descriptionsDecodesAScaleAndAnAggregatesArgumentExactlyWhereTheirArmStatesThemAndRefusesEachAnywhereElse =
	property.exhaust(finite(space), {
		needs: {},
		situations: [
			"scale refused",
			"scale decoded",
			"aggregate refused",
			"aggregate decoded"
		] satisfies ReadonlyArray<
			Reached<"scale refused" | "scale decoded" | "aggregate refused" | "aggregate decoded">
		>,
		check:
			(_, n: Case<"scale refused" | "scale decoded" | "aggregate refused" | "aggregate decoded">) =>
			(c) =>
				Effect.sync(() => {
					switch (c.kind) {
						case "compute": {
							const args = Arr.map(indices(c.args), (i) => ({
								kind: "field",
								field: `f${i}`
							}))
							const decoded = decodeDesc(
								"expr",
								Option.match(c.scale, {
									onNone: () => ({ kind: "compute", fn: c.fn, args }),
									onSome: (scale) => ({ kind: "compute", fn: c.fn, args, scale })
								})
							)
							const admitted = Option.isNone(c.scale) || c.fn === "round" || c.fn === "trunc"
							assert.equal(decoded.ok, admitted, `${c.fn} with scale ${Formatter.format(c.scale)}`)
							if (decoded.ok) {
								n.note("scale decoded")
								return
							}
							n.note("scale refused")
							assert.equal(decoded.error.reason._tag, "MalformedDescription")
							assert.ok(
								refusalLoc(decoded.error).path.includes("scale"),
								`${c.fn}: refused at its scale`
							)
							return
						}
						case "aggregate": {
							const term = c.arg
								? { kind: "aggregate", fn: c.fn, arg: { kind: "var", var: "v1" } }
								: { kind: "aggregate", fn: c.fn }
							const decoded = decodeDesc("rule", { ...rule, head: { n: term } })
							assert.equal(decoded.ok, c.arg === (c.fn !== "count"), `${c.fn} with arg ${c.arg}`)
							n.note(decoded.ok ? "aggregate decoded" : "aggregate refused")
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "a scale where round and trunc state one, an argument where an aggregate reads one"
		},
		box: "every function of the catalogue on 1 to 4 arguments with no scale or a scale of -2 to 4, and every aggregate with an argument or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\tadd: unscaledCompute,",
				replacement: "\tadd: scaledCompute,",
				why: "add decodes a scale; the arms property fails."
			}
		]
	})

/**
 * Descriptions refuses every description broken at one part or one rule, and decodes every other.
 *
 * Budget: 500 runs and 3000 steered cases, what its suite stated before it became a property
 * (test/unit/ir/desc.test.ts:1554 at 8cad5bce, its runs and its coverage's cases).
 */
export const descriptionsRefusesEveryDescriptionBrokenAtOnePartOrOneRuleAndDecodesEveryOther =
	property.explore(aimed(descCaseGen, corruptionAims), {
		needs: {},
		budget: { runs: 500, steered: 3000 },
		situations: [
			"live",
			...Arr.map(descCorruptions, (c): CorruptedFeature<DescRule> => `${c.from} ${c.rule}`)
		] satisfies ReadonlyArray<Reached<CorruptedFeature<DescRule>>>,
		check: (_, n: Case<CorruptedFeature<DescRule>>) => (c) =>
			Effect.sync(() => {
				n.note(corruptedFeature(c))
				if (c.kind === "live") {
					succeeded(decodeHanded(c.value[0], c.value[1]))
					return
				}
				refuses(c.refusal, c.value)
			}),
		oracle: {
			kind: "specification",
			name: "each rule of the Description boundary, broken at its site"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: '\t\t\t\t\t\tS.uniqueArray(orderDescShape, (o) => o.column, "order columns"),',
				replacement: "\t\t\t\t\t\tS.array(orderDescShape),",
				why: "An order naming a column twice decodes; the corruptions property fails."
			}
		]
	})

/** Descriptions refuses every sample broken at any site of any rule, and decodes every sample. */
export const descriptionsRefusesEverySampleBrokenAtAnySiteOfAnyRuleAndDecodesEverySample =
	property.exhaust(finite(sampleCaseGen), {
		needs: {},
		situations: [
			"live",
			...Arr.map(descCorruptions, (c): CorruptedFeature<DescRule> => `${c.from} ${c.rule}`)
		] satisfies ReadonlyArray<Reached<CorruptedFeature<DescRule>>>,
		check: (_, n: Case<CorruptedFeature<DescRule>>) => (c) =>
			Effect.sync(() => {
				n.note(corruptedFeature(c))
				if (c.kind === "live") {
					succeeded(decodeHanded(c.value[0], c.value[1]))
					return
				}
				refuses(c.refusal, c.value)
			}),
		oracle: {
			kind: "specification",
			name: "each rule of the Description boundary, broken at its site"
		},
		box: "every sample description, live and broken at each site of each rule",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original:
					'\tnamed: notOrdered(S.located(S.structWith({ input: stageInput, name }, loc)), "named"),',
				replacement: "\tnamed: S.located(S.structWith({ input: stageInput, name }, loc)),",
				why: 'named is admitted over an Ordered; the corruptions property fails at "on an Ordered, only take: no named".'
			}
		]
	})

/** Descriptions decodes an in-memory expression nested to any depth, and refuses a cyclic one. */
export const descriptionsDecodesAnInMemoryExpressionNestedToAnyDepthAndRefusesACyclicOne =
	property.exhaust(
		finite(
			oneOf<Nesting>([
				map(element([0, 1, 2, 100_000]), (depth): Nesting => ({
					kind: "a chain",
					depth
				})),
				(source) => {
					const length = source.draw(int(1, 4))
					return { kind: "a cycle", length, back: source.draw(int(0, length - 1)) }
				},
				constant<Nesting>({ kind: "an array cycle" }),
				map(int(0, 3), (depth): Nesting => ({ kind: "shared", depth }))
			])
		),
		{
			needs: {},
			situations: ["a chain", "a cycle", "an array cycle", "shared"] satisfies ReadonlyArray<
				Reached<Nesting["kind"]>
			>,
			check: (_, c: Case<Nesting["kind"]>) => (n) =>
				Effect.sync(() => {
					c.note(n.kind)
					switch (n.kind) {
						case "a chain": {
							/** The var at the bottom of `depth` r.not lies inside `depth` containers. */
							const chain = notChain(n.depth, { kind: "var", var: "v" })
							succeeded(decodeDesc("expr", chain))
							return
						}
						case "a cycle": {
							/** A chain of `length` r.not whose last argument is the one `back` levels below the root. */
							const nodes = Array.from({ length: n.length }, (): { kind: "not"; arg: unknown } => ({
								kind: "not",
								arg: undefined
							}))
							for (const [i, node] of nodes.entries()) {
								node.arg = i + 1 < nodes.length ? nodes[i + 1] : nodes[n.back]
							}
							assert.equal(fail(decodeDesc("expr", nodes[0])).reason._tag, "MalformedDescription")
							return
						}
						case "an array cycle": {
							const loop: Array<unknown> = []
							loop.push({ kind: "var", var: "v" }, { kind: "and", args: loop })
							assert.equal(
								fail(decodeDesc("expr", { kind: "and", args: loop })).reason._tag,
								"MalformedDescription"
							)
							return
						}
						case "shared": {
							const shared: ExprDesc = { kind: "var", var: "v" }
							succeeded(
								decodeDesc("expr", { kind: "and", args: [notChain(n.depth, shared), shared] })
							)
						}
					}
				}),
			oracle: {
				kind: "specification",
				name: "any depth decodes as its text does, a cycle is MalformedDescription, and a shared value is no cycle"
			},
			box: "chains of r.not 0, 1, 2 and 100,000 deep, every cycle of 1 to 4 parts back to any of them, an array cycle, and a value shared 0 to 3 levels",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/shape.ts",
					original: "\t\t\treturn yield* deferred(shape().parse(value, path))",
					replacement: "\t\t\treturn yield* shape().parse(value, path)",
					why: "ref reads its part on the call stack, not deferred to the driver; the nesting property fails past a small stack."
				}
			]
		}
	)

/**
 * Descriptions carries bigint, Decimal, Money and Vector as tagged strings and escapes a leading tilde.
 *
 * Budget: 500 runs and 500 steered cases, what its suite stated before it became a property
 * (test/unit/ir/desc.test.ts:1848 at 8cad5bce, its runs and its coverage's cases).
 */
export const descriptionsCarriesBigintDecimalMoneyAndVectorAsTaggedStringsAndEscapesALeadingTilde =
	property.explore(
		weighted([
			[4, exprsGen],
			[1, ownedGen]
		]),
		{
			needs: {},
			budget: { runs: 500, steered: 500 },
			situations: [
				"~n",
				"~d",
				"~m",
				"~v",
				"an escaped tilde",
				"an owned value kept"
			] satisfies ReadonlyArray<Reached<TagFeature>>,
			check: (_, c: Case<TagFeature>) => (e) =>
				Effect.sync(() => {
					const text = succeeded(descText(e))
					lacksText(text, "null")
					const owned = succeeded(decodeDesc("expr", e))
					if (e.kind === "in" && owned.kind === "in") {
						for (const [i, value] of e.values.entries()) {
							if (value instanceof Money) {
								c.note("an owned value kept")
								assert.equal(owned.values[i], value)
							}
						}
					}
					for (const literal of literalsOf(e)) {
						const tagged = tagOf(literal)
						if (tagged === "untagged") {
							continue
						}
						c.note(tagged[0])
						containsText(text, tagged[1])
					}
				}),
			oracle: {
				kind: "specification",
				name: "the canonical text's tags, ~n, ~d, ~m and ~v, and a leading tilde doubled"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/canonical.ts",
					original: `const escapeString = (value: string): string => (value.startsWith("~") ? \`~\${value}\` : value)`,
					replacement: "const escapeString = (value: string): string => value",
					why: "A string's leading tilde is written as is, not doubled; the literals property fails."
				}
			]
		}
	)

/**
 * Descriptions round-trips generated expressions.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/ir/desc.test.ts:1903 at 8cad5bce, its runs and its coverage's cases).
 */
export const descriptionsRoundTripsGeneratedExpressions = property.explore(exprsGen, {
	needs: {},
	budget: { runs: 300, steered: 300 },
	situations: ["~n", "~d", "an escaped tilde"] satisfies ReadonlyArray<Reached<TagFeature>>,
	check: (_, c: Case<TagFeature>) => (e) =>
		Effect.sync(() => {
			for (const literal of literalsOf(e)) {
				const tagged = tagOf(literal)
				if (tagged !== "untagged") {
					c.note(tagged[0])
				}
			}
			const back = succeeded(descFromJson("expr", throughJson(e)))
			assert.deepEqual(back, succeeded(decodeDesc("expr", e)))
			assert.equal(succeeded(descText(back)), succeeded(descText(e)))
		}),
	oracle: {
		kind: "universal",
		name: "descFromJson ∘ JSON = decodeDesc, one canonical text"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/canonical.ts",
			original: "\t\t\treturn value.slice(1)",
			replacement: "\t\t\treturn value",
			why: "A doubled leading tilde is read back doubled; the literals property fails."
		}
	]
})

/**
 * Descriptions decodes an empty and or or to the constant its builder builds of no predicate.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/ir/desc.test.ts:1988 at 8cad5bce, its runs and its coverage's cases).
 */
export const descriptionsDecodesAnEmptyAndOrOrToTheConstantItsBuilderBuildsOfNoPredicate =
	property.explore(emptiedGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"an empty conjunction",
			"an empty disjunction",
			"alone",
			"a first operand",
			"a second operand",
			"negated"
		] satisfies ReadonlyArray<Reached<EmptyFeature>>,
		check: (_, c: Case<EmptyFeature>) => (s) =>
			Effect.sync(() => {
				c.note(s.kind === "and" ? "an empty conjunction" : "an empty disjunction")
				c.note(s.place)
				const unit = succeeded(
					decodeDesc("expr", predicateExpr(s.kind === "and" ? Logic.and([]) : Logic.or([])))
				)
				assert.deepEqual<ExprDesc>(unit, {
					kind: "literal",
					value: s.kind === "and",
					type: { kind: "pg", type: "boolean" }
				})
				const [written, meant] = emptied(s, unit, succeeded(decodeDesc("expr", s.beside)))
				assert.deepEqual<ExprDesc>(succeeded(decodeDesc("expr", written)), meant)
			}),
		oracle: {
			kind: "specification",
			name: "the constant the builder builds of no predicate: true for and, false for or"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: '\tvalue: kind === "and",',
				replacement: '\tvalue: kind === "or",',
				why: "An and of no operand decodes as false and an or as true; the literals property fails."
			}
		]
	})
