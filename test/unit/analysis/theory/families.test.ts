/**
 * The theory's families (fin.md §4, w4-w7 §2.1 to §2.3, §3.7): every family and tree statement resolves to one Family
 * IR; a containment rides a family axis exactly when §2.1's rule holds, its pairs beyond the axis's key joining the
 * axis's; every drawn and every accumulated field is named by exactly one statement; and the theory refuses what §3.7
 * names. The oracles are §2.1's rule written again over SideDescs, a second implementation the riding box is judged
 * against, and the statements themselves, read as the specification of the IR they resolve to.
 *
 * - Riding: every containment over the box's two relations of at most three typed pairs, each side selected or not,
 *   exhausted, rides exactly the axis §2.1's rule names, carrying its pairs after the key.
 * - The theory's riding: one or two drawn containments of distinct terms on each side (freshPairs: a statement lists
 *   each term of a side once, constructed, never filtered), or two that ride one axis by construction, lower onto the
 *   axis §2.1's rule names, its axes carrying exactly the riding pairs, an accumulated field filled by exactly one
 *   statement.
 * - A tree's riding: a tree's parent copy rides its owner axis exactly when its selection is one comparison of start
 *   with zero that selects the members, over drawn comparisons.
 * - Resolution: ordered and counted families of group width 1 to 3 over uuid and bigint keys, with no fold, a hidden
 *   or a named sum, and a tree, each lawful or under each refusal it offers, exhausted.
 *
 * Features: each verdict and near miss of the riding rule, a pair two laws carry, a key carried alone, an accumulated
 * field filled by none, one or two statements, each comparison's verdict for a tree, and each lawful shape and refusal
 * for the resolution.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, boolean, finite, weighted } from "@bjornpagen/testing/gen"
import { corrupted, corruptedFeature } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import {
	riddenFamily,
	ridesOf,
	type RidingPair,
	treeShape
} from "#compiler/analysis/theory/families.ts"
import type { LawDetail, TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import { type TermDesc, termText } from "#compiler/ir/desc.ts"
import { refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { contained } from "#test/support/fixtures/ir/desc.ts"
import { relationsOf, theoryOf, theoryResult } from "#test/support/unit/analysis/theory/support.ts"
import {
	axisOf,
	columnText,
	comparisonGen,
	conjunctOf,
	containmentText,
	extendedCases,
	familyCaseGen,
	type FamilyFeature,
	field,
	fieldOf,
	partsOf,
	refusals,
	resolvesAsStated,
	type RideCase,
	rideCase,
	type RideFeature,
	ridingCase,
	ridingSchema,
	ridingSide,
	ruleOf,
	ruleTags,
	schemaOfParts,
	selectsMembers,
	shape,
	sideOf,
	type TheoryRideFeature,
	treeDesc,
	treeStatementOf
} from "#test/unit/analysis/theory/families.fixtures.ts"

/** Riding a family axis (§2.1) a containment rides an axis exactly when §2.1's rule holds, carrying its pairs beyond the key. */
export const ridingAFamilyAxis21AContainmentRidesAnAxisExactlyWhen21sRuleHoldsCarryingItsPairsBeyondTheKey =
	property.exhaust(finite(rideCase), {
		needs: {},
		situations: [
			"rides owner",
			"rides predecessor",
			"rides last",
			"a wrong selection",
			"a reordered key",
			"a carried pred term",
			"no axis"
		] satisfies ReadonlyArray<Reached<RideFeature>>,
		check: (_, k: Case<RideFeature>) => (c) =>
			Effect.sync(() => {
				const pairs = Arr.map(c.pairs, ([l, r]): RidingPair => ({
					from: { ...l, column: fieldOf(c.left, l.field) },
					to: { ...r, column: fieldOf(c.right, r.field) }
				}))
				const [first, ...rest] = pairs
				const ride = ridesOf(
					[riddenFamily(shape)],
					ridingSide(c.left, c.leftSelected),
					ridingSide(c.right, c.rightSelected),
					[defined(first), ...rest]
				)
				const verdict = ruleOf(c)
				if (verdict.kind === "own") {
					k.note(verdict.near)
					assert.equal(ride, undefined, `${Formatter.format(c)} rides no axis`)
					return
				}
				k.note(`rides ${verdict.axis}`)
				assert.equal(ride?.axis, verdict.axis, `${Formatter.format(c)} rides ${verdict.axis}`)
				assert.deepEqual(
					Arr.map(ride?.carried ?? [], (p) => `${p.from.field}→${p.to.field}`),
					Arr.map(Arr.drop(c.pairs, verdict.width), ([l, r]) => `${l.field}→${r.field}`),
					"it carries its pairs after the key"
				)
			}),
		oracle: { kind: "specification", name: "§2.1's riding rule over SideDescs" },
		box: "every containment over O and F of at most three typed pairs, each side selected or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original: "\t\tpairs.length >= width &&",
				replacement: "\t\tpairs.length > width &&",
				why: "A containment rides only beside a carried pair, so its key alone rides nothing (families.ts ridesOf); the riding box and the theory's riding fail."
			}
		]
	})

/**
 * Riding a family axis (§2.1) the theory lowers each containment onto the axis §2.1's rule names, its axes carrying
 * exactly the riding pairs, and fills an accumulated field by exactly one.
 *
 * Budget: 200 runs and 2000 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/theory/families.test.ts:509 at 8cad5bce, its runs and its coverage's cases).
 */
export const ridingAFamilyAxis21TheTheoryLowersEachContainmentOntoTheAxis21sRuleNamesItsAxesCarryingExactlyTheRidingPairsAndFillsAnAccumulatedFieldByExactlyOne =
	property.explore(
		(source) => {
			const was = source.draw(boolean)
			return [
				was,
				source.draw(
					weighted([
						[2, array(ridingCase(was), { min: 1, max: 2 })],
						[1, extendedCases(was)]
					])
				)
			] as const
		},
		{
			needs: {},
			budget: { runs: 200, steered: 2000 },
			situations: [
				"rides owner",
				"rides predecessor",
				"rides last",
				"a wrong selection",
				"a reordered key",
				"a carried pred term",
				"no axis",
				"a pair two laws carry",
				"a key carried alone",
				"an accumulated field one statement fills",
				"an accumulated field no statement fills",
				"an accumulated field two statements fill",
				"an accumulated field its filler copies from its own predecessor"
			] satisfies ReadonlyArray<Reached<TheoryRideFeature>>,
			check:
				(_, k: Case<TheoryRideFeature>) =>
				([was, cases]) =>
					Effect.sync(() => {
						const verdicts = Arr.map(cases, ruleOf)
						const carriedBy = (i: number): ReadonlyArray<readonly [TermDesc, TermDesc]> => {
							const v = defined(verdicts[i])
							return v.kind === "rides" ? Arr.drop(defined(cases[i]).pairs, v.width) : []
						}
						const result = theoryResult(
							ridingSchema(
								was,
								Arr.map(cases, (c) =>
									contained(
										sideOf(
											c.left,
											c.leftSelected,
											Arr.map(c.pairs, ([l]) => l)
										),
										sideOf(
											c.right,
											c.rightSelected,
											Arr.map(c.pairs, ([, r]) => r)
										)
									)
								)
							)
						)
						const fills = new Set(
							Arr.flatMap(cases, (c, i) =>
								Arr.some(carriedBy(i), ([l]) => l.field === "was") ? [containmentText(c)] : []
							)
						)
						if (was && fills.size !== 1) {
							k.note(
								fills.size === 0
									? "an accumulated field no statement fills"
									: "an accumulated field two statements fill"
							)
							assert.deepEqual(
								Arr.takeRight(refusalLoc(refused(result, "MalformedDescription")).path, 2),
								["fields", "was"],
								"refused at the accumulated field"
							)
							return
						}
						if (was) {
							k.note("an accumulated field one statement fills")
						}
						/**
						 * A filler riding the predecessor axis that carries `was` onto `was` copies each member's was
						 * from the member before, whose was is that same copy again: a chain, which every member holds
						 * at was's start (analysis/theory/fill.ts), admitted as any filler is.
						 */
						const selfCopied = Arr.some(
							verdicts,
							(v, i) =>
								v.kind === "rides" &&
								v.axis === "predecessor" &&
								Arr.some(carriedBy(i), ([l, r]) => l.field === "was" && r.field === "was")
						)
						if (was && selfCopied) {
							k.note("an accumulated field its filler copies from its own predecessor")
						}
						const theory = succeeded(result)
						const family = defined(theory.families[0])
						const containments = Arr.filter(theory.laws, (law) => law.detail.kind === "containment")
						const termsText = (terms: ReadonlyArray<TermDesc>): string =>
							Arr.join(Arr.map(terms, termText), ", ")
						const states = (detail: LawDetail, c: RideCase): boolean =>
							detail.kind === "containment" &&
							detail.from.relation === c.left &&
							detail.to.relation === c.right &&
							detail.from.selection.conjuncts.length > 0 === c.leftSelected &&
							detail.to.selection.conjuncts.length > 0 === c.rightSelected &&
							termsText(detail.from.terms) === termsText(Arr.map(c.pairs, ([l]) => l)) &&
							termsText(detail.to.terms) === termsText(Arr.map(c.pairs, ([, r]) => r))
						const lawOf = (i: number): TheoryLaw => {
							const [law, ...more] = Arr.filter(containments, (l) =>
								states(l.detail, defined(cases[i]))
							)
							assert.equal(more.length, 0, "each containment is one law")
							return defined(law)
						}
						for (const [i, v] of verdicts.entries()) {
							const law = lawOf(i)
							if (v.kind === "own") {
								k.note(v.near)
								assert.equal(axisOf(law.detail), "own", "it keeps its own native")
								continue
							}
							k.note(`rides ${v.axis}`)
							if (carriedBy(i).length === 0) {
								k.note("a key carried alone")
							}
							assert.equal(axisOf(law.detail), v.axis, `it rides the ${v.axis} axis`)
						}
						for (const axis of ["owner", "predecessor", "last"] as const) {
							const expected = new Map<string, ReadonlySet<string>>()
							for (const [i, v] of verdicts.entries()) {
								if (v.kind !== "rides" || v.axis !== axis) {
									continue
								}
								for (const [l, r] of carriedBy(i)) {
									const pair = `${l.field}→${r.field}`
									expected.set(pair, new Set([...(expected.get(pair) ?? []), lawOf(i).id]))
								}
							}
							const carried = new Map(
								Arr.map(family.axes[axis], (p) => [
									`${columnText(p.from)}→${columnText(p.to)}`,
									new Set<string>(p.laws)
								])
							)
							if (Arr.some(family.axes[axis], (p) => p.laws.length > 1)) {
								k.note("a pair two laws carry")
							}
							assert.deepEqual<ReadonlyMap<string, ReadonlySet<string>>>(
								carried,
								expected,
								`the ${axis} axis carries exactly its riding containments' pairs, each with its laws`
							)
						}
					}),
			oracle: { kind: "specification", name: "§2.1's riding rule and §3.7's one filler" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/families.ts",
					original: "\t\tpairs.length >= width &&",
					replacement: "\t\tpairs.length > width &&",
					why: "A containment rides only beside a carried pair, so its key alone rides nothing (families.ts ridesOf); the riding box and the theory's riding fail."
				}
			]
		}
	)

/**
 * Riding a family axis (§2.1) a tree's parent copy rides its owner axis exactly when its selection is one comparison
 * of start with zero that selects the members.
 *
 * Budget: 300 runs and 1000 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/theory/families.test.ts:749 at 8cad5bce, its runs and its coverage's cases).
 */
export const ridingAFamilyAxis21ATreesParentCopyRidesItsOwnerAxisExactlyWhenItsSelectionIsOneComparisonOfStartWithZeroThatSelectsTheMembers =
	property.explore(array(comparisonGen, { min: 0, max: 2 }), {
		needs: {},
		budget: { runs: 300, steered: 1000 },
		situations: [
			"rides",
			"a wrong selection",
			"another spelling of the members"
		] satisfies ReadonlyArray<
			Reached<"rides" | "a wrong selection" | "another spelling of the members">
		>,
		check:
			(_, k: Case<"rides" | "a wrong selection" | "another spelling of the members">) =>
			(conjuncts) =>
				Effect.sync(() => {
					const tt = theoryOf(treeDesc)
					const tree = treeShape(treeStatementOf(treeDesc), relationsOf(tt))
					const column = (name: string) =>
						defined(
							Arr.findFirst(defined(tt.relations["T"]).fields, (x) => x.name === name).pipe(
								Option.getOrUndefined
							)
						)
					const ride = ridesOf(
						[riddenFamily(tree)],
						{
							relation: "T",
							selection: {
								conjuncts: Arr.map(conjuncts, (c) => ({ predicate: conjunctOf(c) }))
							}
						},
						{ relation: "T", selection: { conjuncts: [] } },
						[
							{
								from: { ...field("doc"), column: column("doc") },
								to: { ...field("doc"), column: column("doc") }
							},
							{
								from: { ...field("parent"), column: column("parent") },
								to: { ...field("start"), column: column("start") }
							},
							{
								from: { ...field("kind"), column: column("kind") },
								to: { ...field("kind"), column: column("kind") }
							}
						]
					)
					const [only, ...more] = conjuncts
					const spelled =
						only !== undefined && more.length === 0 && only.field === "start" && only.literal === 0n
					const members = selectsMembers(conjuncts)
					if (members && spelled) {
						k.note("rides")
						assert.equal(ride?.axis, "owner", "the tree's members ride its owner axis")
						return
					}
					k.note(members ? "another spelling of the members" : "a wrong selection")
					assert.equal(ride, undefined, "any other selection rides no axis")
				}),
		oracle: {
			kind: "specification",
			name: "§2.2: a tree's members are select(T, start > 0), evaluated over the naturals"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original:
					"\t\t\tif (carried !== undefined) {\n\t\t\t\treturn { family: f.id, axis: a.axis, carried }\n\t\t\t}",
				replacement: "\t\t\t{}",
				why: "Operator mutant (guard) in ridesOf: no containment rides the axis that admits it (`if (carried !== undefined) { return ... }` becomes `{}`); the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** Resolution and refusals (§3.4, §3.7, rows-first §4) each lawful family and tree resolves to one Family IR as its statement states it, and each named malformation of one is refused where it is stated. */
export const resolutionAndRefusals3437RowsFirst4EachLawfulFamilyAndTreeResolvesToOneFamilyIRAsItsStatementStatesItAndEachNamedMalformationOfOneIsRefusedWhereItIsStated =
	property.exhaust(
		finite((source) => source.draw(corrupted(source.draw(familyCaseGen), refusals))),
		{
			needs: {},
			situations: [
				"live",
				"ordered",
				"counted",
				"tree",
				"no fold",
				"hidden accumulators",
				"named accumulators",
				...Arr.map(refusals, (r): FamilyFeature => `${r.from} ${r.rule}`)
			] satisfies ReadonlyArray<Reached<FamilyFeature>>,
			check: (_, k: Case<FamilyFeature>) => (drawnCase) =>
				Effect.sync(() => {
					k.note(corruptedFeature(drawnCase))
					if (drawnCase.kind === "live") {
						resolvesAsStated(drawnCase.value, theoryOf(schemaOfParts(partsOf(drawnCase.value))), k)
						return
					}
					const at = refusalLoc(
						refused(
							theoryResult(drawnCase.refusal.schema),
							ruleTags[drawnCase.rule],
							`${drawnCase.rule} is refused`
						)
					)
					const stated = drawnCase.refusal.at
					if (stated.kind === "statement") {
						assert.equal(at.path[0], "statements", `${drawnCase.rule} is refused at its statement`)
						return
					}
					assert.deepEqual(
						Arr.takeRight(at.path, 2),
						["fields", stated.field],
						`${drawnCase.rule} is refused at ${stated.field}`
					)
				}),
			oracle: {
				kind: "specification",
				name: "the statement read as the IR it names (§3.4), and §3.7's refusals"
			},
			box: "ordered and counted families of group width 1 to 3 over uuid and bigint keys, with no fold, a hidden or a named sum, and a tree, each lawful or under each refusal it offers",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/fold.ts",
					original:
						'\tif (fold.order === "counted" && fold.pairs.length > 0) {\n\t\treturn namedBreach(\n\t\t\t"a fold over a counted family hides its accumulators: name the step\'s value alone"\n\t\t)\n\t}\n',
					replacement: "",
					why: "A counted family's fold naming its accumulators admitted (check/fold.ts foldRule); the resolution fails."
				}
			]
		}
	)
