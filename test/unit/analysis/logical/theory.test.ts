/**
 * Theory normalization: CheckedTheory from an owned schema, judged by properties over the differential oracle's
 * generated schemas and drawn field types, the lawful Work facts and every combination of planted violations, and small
 * fact spaces exhausted against the laws' meaning.
 *
 * - every law is one Forbid node over its violation query, and the violation queries mean what the laws say: evaluated
 *   by the reference evaluator they are empty on lawful facts and name exactly the violating witnesses, a model of each
 *   law's meaning written from its statement;
 * - union-find classes over containment pairings keep carrier, contract and roster identity, refuse incompatible
 *   pairings, and keep a typmod or a refinement inside one class, over pairs of generated field types;
 * - evidence carries its validity context: keys and checks immediate, a containment into a closed relation immediate,
 *   every other containment committed-snapshot only unless law specialization says otherwise;
 * - law identities are deterministic, independent of declaration order and of unrelated statements, come from the
 *   lawId option, must be distinct, and equivalent declarations, however often stated, are one law of one statement;
 * - a containment pairing more than one span field is UnsupportedLawFamily (the span law families themselves are
 *   unit/laws/recognition's).
 *
 * Features: each search's verdicts, pairings and contexts.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, finite, int, shuffled, subarray } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { immediateEvidence, lawIdentityOf } from "#compiler/analysis/theory/theory.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { FieldId } from "#compiler/core/ids.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import * as G from "#test/support/fixtures/golden/work.ts"
import {
	closed,
	contained,
	f,
	on,
	relation,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import { declaredGen } from "#test/support/unit/ir/types.ts"
import { upTo } from "#test/support/up-to.ts"
import { noImmediate, theoryResultOf, theoryUnder } from "#test/unit/analysis/logical/support.ts"
import {
	base,
	byText,
	checkLaw,
	type ClassFeature,
	declaration,
	type DeclaredFeature,
	type EvidenceFeature,
	evidenceSchemaGen,
	extra,
	factsGen,
	carrierOf,
	idsNeed,
	kt,
	type LawName,
	manager,
	model,
	named,
	nameKey,
	pairedGen,
	people,
	rt,
	sided,
	type SpanFeature,
	t,
	violatedSorted
} from "#test/unit/analysis/logical/theory.fixtures.ts"

/** Span laws refuses a containment pairing more than one span field, whatever else it pairs, and admits one. */
export const spanLawsRefusesAContainmentPairingMoreThanOneSpanFieldWhateverElseItPairsAndAdmitsOne =
	property.exhaust(
		finite((source) => {
			const spans = source.draw(int(0, 3))
			return [spans, source.draw(int(spans === 0 ? 1 : 0, 2))] as const
		}),
		{
			needs: {},
			situations: [
				"no span field",
				"one span field",
				"several span fields"
			] satisfies ReadonlyArray<Reached<SpanFeature>>,
			check:
				(_, c: Case<SpanFeature>) =>
				([spans, uuids]) =>
					Effect.sync(() => {
						const span = f.span(f.bigint, undefined)
						const spanFields = Arr.map(
							upTo(spans, (i) => i + 1),
							(i) => `s${i}`
						)
						const uuidFields = Arr.map(
							upTo(uuids, (i) => i + 1),
							(i) => `u${i}`
						)
						const fields = [...spanFields, ...uuidFields]
						const declared = Rec.fromEntries([
							...Arr.map(spanFields, (name) => [name, span] as const),
							...Arr.map(uuidFields, (name) => [name, f.uuid] as const)
						])
						const desc: SchemaDesc = {
							name: "Spans",
							relations: [
								relation("Two", { id: f.uuid, ...declared }, ["id"]),
								relation("Other", { id: f.uuid, ...declared }, ["id"])
							],
							statements: [contained(on("Two", fields), on("Other", fields))],
							bases: []
						}
						if (spans > 1) {
							c.note("several span fields")
							refused(theoryResultOf(desc), "UnsupportedLawFamily")
							return
						}
						c.note(spans === 1 ? "one span field" : "no span field")
						succeeded(theoryResultOf(desc))
					}),
			oracle: { kind: "specification", name: "a coverage law pairs one span field" },
			box: "a containment of zero to three span fields beside zero to two uuid fields",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/laws.ts",
					original: "\t\tif (more.length > 0) {",
					replacement: "\t\tif (more.length > 1) {",
					why: "A containment pairing two span fields admitted (analysis/theory/laws.ts); the span pairings property fails."
				}
			]
		}
	)

/**
 * Field-compatibility classes admit a containment's pairing of two fields exactly when their base carriers are one,
 * keeping a contract, a typmod and a refinement inside one class: natural or a contract over pg.bigint pairs with
 * pg.bigint, either side refining the other, and int4 never with int8, nor a closed id with another roster's.
 *
 * Budget: 300 runs and 1000 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/theory.test.ts:284 at 8cad5bce, its runs and its coverage's cases).
 */
export const fieldCompatibilityClassesAdmitAContainmentsPairingOfTwoFieldsExactlyWhenTheirBaseCarriersAreOneKeepingAContractATypmodAndARefinementInsideOneClass =
	property.explore(
		(source) => {
			const a = sided(source.draw(declaredGen), "a")
			return [a, ...source.draw(pairedGen(a))] as const
		},
		{
			needs: {},
			budget: { runs: 300, steered: 1000 },
			situations: [
				"one carrier",
				"another carrier",
				"a twin",
				"another typmod or refinement",
				"another roster",
				"a contract over it or its base",
				"drawn apart"
			] satisfies ReadonlyArray<Reached<ClassFeature>>,
			check:
				(_, c: Case<ClassFeature>) =>
				([a, pairing, b]) =>
					Effect.sync(() => {
						c.note(pairing)
						const rosters = { ...a.rosters, ...b.rosters }
						const result = theoryResultOf({
							name: "R",
							relations: [
								...Arr.map(Rec.toEntries(rosters), ([name, handles]) =>
									closed.ordered(name, handles)
								),
								relation("A", { id: f.uuid, x: a.desc }, ["id"]),
								relation("B", { id: f.uuid, y: b.desc }, ["id"])
							],
							statements: [contained(on("A", ["x"]), on("B", ["y"]))],
							bases: []
						})
						if (carrierOf(a.desc) !== carrierOf(b.desc)) {
							c.note("another carrier")
							const e = refused(result, "Refused")
							assert.equal(
								e.reason._tag === "Refused" ? e.reason.refusal : undefined,
								"the sides' field types differ"
							)
							return
						}
						c.note("one carrier")
						const t = succeeded(result)
						assert.deepEqual(
							Option.map(
								Arr.findFirst(t.classes, (x) => x.fields.includes(FieldId("A", "x"))),
								(x) => Arr.map(x.members, (m) => m.field)
							),
							Option.some([FieldId("A", "x"), FieldId("B", "y")])
						)
					}),
			oracle: {
				kind: "specification",
				name: "a containment's class keeps a base carrier and roster identity, its contracts stripped, never a typmod or a refinement"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/theory.ts",
					original: "\t\t\t\t\t\tk.tracked,\n\t\t\t\t\t\tsameCarrier,\n",
					replacement: "\t\t\t\t\t\tk.tracked,\n\t\t\t\t\t\tcompatible,\n",
					why: "A containment pairs fields of one nominal identity, as a family does: natural or a contract over a type is refused against the type, where their base carrier is one; the classes property fails."
				},
				{
					file: "packages/engine/src/scalar/compute/types.ts",
					original:
						"export const sameCarrier = (a: ScalarType, b: ScalarType): boolean => sameCore(baseOf(a), baseOf(b))",
					replacement:
						"export const sameCarrier = (a: ScalarType, b: ScalarType): boolean => baseOf(a).carrier === baseOf(b).carrier",
					why: "A containment pairs two fields of one carrier whatever their roster: a closed id is paired with another roster's; the classes property fails."
				}
			]
		}
	)

/**
 * Violation queries mean what their laws say every law's violation query names exactly the witnesses its statement's
 * meaning gives, over drawn facts of Work.
 *
 * Budget: 300 runs and 2000 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/theory.test.ts:539 at 8cad5bce, its runs and its coverage's cases).
 */
export const violationQueriesMeanWhatTheirLawsSayEveryLawsViolationQueryNamesExactlyTheWitnessesItsStatementsMeaningGivesOverDrawnFactsOfWork =
	property.explore(factsGen, {
		needs: {},
		budget: { runs: 300, steered: 2000 },
		situations: [
			"Account's key",
			"Task's key",
			"AutomaticTask's key",
			"ManualTask's key",
			"TaskNote's key",
			"a task's account",
			"a note's task",
			"the Automatic arm",
			"the Manual arm",
			"Automatic's reverse",
			"Manual's reverse",
			"Cents",
			"lawful",
			"several at once"
		] satisfies ReadonlyArray<Reached<LawName | "lawful" | "several at once">>,
		check: (_, c: Case<LawName | "lawful" | "several at once">) => (facts) =>
			Effect.sync(() => {
				const expected = new Map(
					Arr.flatMap(model, ([name, law, witnesses]) => {
						const rows = witnesses(facts)
						if (rows.length > 0) {
							c.note(name)
						}
						return rows.length > 0 ? [[law, Arr.sort(rows, byText)] as const] : []
					})
				)
				if (expected.size === 0) {
					c.note("lawful")
				}
				if (expected.size > 1) {
					c.note("several at once")
				}
				assert.deepEqual(violatedSorted(t, facts), expected)
			}),
		oracle: {
			kind: "second-implementation",
			name: "each law's witnesses, read from its statement over the host facts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/laws.ts",
				original:
					'\tconst pred = b.connective("and", [\n\t\t...overlaps,\n\t\tb.connective("or", differsElsewhere(b, r, join, shared))\n\t])',
				replacement: '\tconst pred = b.connective("and", [...overlaps])',
				why: "A key's violation pairs any two facts sharing the key, a fact with itself (analysis/theory/laws.ts keyViolation); the Work violations and the candidate key fail."
			}
		]
	})

/** Violation queries mean what their laws say a row check's witnesses are exactly the keys of the rows its predicate refuses. */
export const violationQueriesMeanWhatTheirLawsSayARowChecksWitnessesAreExactlyTheKeysOfTheRowsItsPredicateRefuses =
	property.exhaust(
		finite((source) => [source.draw(manager), source.draw(manager), source.draw(manager)] as const),
		{
			needs: {},
			situations: ["a self-managed employee", "lawful"] satisfies ReadonlyArray<
				Reached<"a self-managed employee" | "lawful">
			>,
			check: (_, c: Case<"a self-managed employee" | "lawful">) => (managers) =>
				Effect.sync(() => {
					const rows = Arr.flatMap(managers, (m, i) =>
						m === "none" ? [] : [{ employee: defined(people[i]), manager: m }]
					)
					const own = Arr.map(
						Arr.filter(rows, (r) => r.employee === r.manager),
						(r) => [r.employee]
					)
					c.note(own.length > 0 ? "a self-managed employee" : "lawful")
					assert.deepEqual(
						violatedSorted(rt, { Report: rows }),
						own.length > 0 ? new Map([[checkLaw.id, Arr.sort(own, byText)]]) : new Map()
					)
				}),
			oracle: {
				kind: "specification",
				name: "the row check's meaning: exactly the employees who are their own manager violate it"
			},
			box: "three employees of a report, each managed by none, by themselves or by another",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/laws.ts",
					original: "\tconst filtered = b.filter(lowered.region, b.not(lowered.predicate))",
					replacement: "\tconst filtered = b.filter(lowered.region, lowered.predicate)",
					why: "A row check's violation names the rows it holds of (analysis/theory/laws.ts checkViolation); the row check fails."
				}
			]
		}
	)

/** Violation queries mean what their laws say a candidate key's witnesses are the values two facts share, and a pure set's key has nothing to differ on. */
export const violationQueriesMeanWhatTheirLawsSayACandidateKeysWitnessesAreTheValuesTwoFactsShareAndAPureSetsKeyHasNothingToDifferOn =
	property.exhaust(
		finite(
			(source) =>
				[
					[source.draw(named), source.draw(named), source.draw(named)] as const,
					source.draw(subarray(["x", "y"]))
				] as const
		),
		{
			needs: { idsNeed },
			situations: ["a shared name", "lawful", "labels"] satisfies ReadonlyArray<
				Reached<"a shared name" | "lawful" | "labels">
			>,
			check:
				({ idsNeed }, c: Case<"a shared name" | "lawful" | "labels">) =>
				([names, labels]) =>
					Effect.gen(function* () {
						const ids = yield* idsNeed
						return yield* Effect.sync(() => {
							const accounts = Arr.flatMap(names, (n, i) =>
								n === "none" ? [] : [{ id: defined(ids[i]), name: n }]
							)
							if (labels.length > 0) {
								c.note("labels")
							}
							const shared = Arr.map(
								Arr.filter(
									[...new Set(Arr.map(accounts, (a) => a.name))],
									(n) => Arr.filter(accounts, (a) => a.name === n).length > 1
								),
								(n) => [n]
							)
							c.note(shared.length > 0 ? "a shared name" : "lawful")
							assert.deepEqual(
								violatedSorted(kt, {
									Account: accounts,
									Label: Arr.map(labels, (label) => ({ account: G.a1, label }))
								}),
								shared.length > 0 ? new Map([[nameKey, Arr.sort(shared, byText)]]) : new Map()
							)
						})
					}),
			oracle: {
				kind: "specification",
				name: "the candidate key's meaning: two accounts sharing a name violate it, witnessed by the name; a pure set's key has nothing to differ on"
			},
			box: "three accounts, each named none, acme or beta, beside any set of labels",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/laws.ts",
					original:
						'\tconst pred = b.connective("and", [\n\t\t...overlaps,\n\t\tb.connective("or", differsElsewhere(b, r, join, shared))\n\t])',
					replacement: '\tconst pred = b.connective("and", [...overlaps])',
					why: "A key's violation pairs any two facts sharing the key, a fact with itself (analysis/theory/laws.ts keyViolation); the Work violations and the candidate key fail."
				}
			]
		}
	)

/**
 * Evidence and its validity context keys and checks are immediate storage facts under ownership's constraint names, a
 * containment into a closed relation holds at every statement and any other in committed snapshots.
 *
 * Budget: 150 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/theory.test.ts:795 at 8cad5bce, its runs and its coverage's cases).
 */
export const evidenceAndItsValidityContextKeysAndChecksAreImmediateStorageFactsUnderOwnershipsConstraintNamesAContainmentIntoAClosedRelationHoldsAtEveryStatementAndAnyOtherInCommittedSnapshots =
	property.explore(evidenceSchemaGen, {
		needs: {},
		budget: { runs: 150, steered: 300 },
		situations: [
			"a candidate key",
			"a primary key alone",
			"a check",
			"a containment into a closed relation",
			"a committed-snapshot containment"
		] satisfies ReadonlyArray<Reached<EvidenceFeature>>,
		check: (_, c: Case<EvidenceFeature>) => (desc) =>
			Effect.sync(() => {
				const owned = ownedFixture(desc).owned
				const t = theoryUnder(desc, noImmediate)
				for (const r of Rec.values(t.relations)) {
					if (r.kind !== "relation") {
						continue
					}
					const keys = Option.match(Rec.get(owned.relations, r.name), {
						onNone: () => [],
						onSome: (o) => o.keys
					})
					c.note(keys.length > 1 ? "a candidate key" : "a primary key alone")
					unorderedEqual(
						Arr.map(
							Arr.filter(t.evidence.keys, (k) => k.relation === r.name),
							(k) => [k.fields, k.kind, k.constraint, k.context] as const
						),
						Arr.map(
							keys,
							(k) =>
								[k.fields, k.primary ? "primaryKey" : "unique", k.constraint, "immediate"] as const
						)
					)
				}
				for (const check of t.evidence.checks) {
					c.note("a check")
					assert.equal(check.context, "immediate")
				}
				const immediate = immediateEvidence(t.evidence)
				assert.deepEqual(immediate.keys, t.evidence.keys)
				for (const containment of t.evidence.containments) {
					const intoClosed = t.relations[containment.to.relation]?.kind === "closed"
					c.note(
						intoClosed ? "a containment into a closed relation" : "a committed-snapshot containment"
					)
					assert.equal(containment.context, intoClosed ? "immediate" : "committedSnapshot")
					assert.equal(immediate.containments.includes(containment), intoClosed)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "ownership's keys and the containment's target kind"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original:
					'\t\t\t\t\t\td.to.rel.kind === "closed" || immediate.has(law.id) ? "immediate" : "committedSnapshot"',
				replacement: '\t\t\t\t\t\timmediate.has(law.id) ? "immediate" : "committedSnapshot"',
				why: "A containment into a closed relation only committed-snapshot evidence (analysis/theory/theory.ts); the evidence context fails."
			}
		]
	})

/**
 * Evidence and its validity context law specialization states which containments are immediate through the immediate
 * set theoryEvidence reads.
 *
 * Budget: 100 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/theory.test.ts:867 at 8cad5bce, its runs and its coverage's cases).
 */
export const evidenceAndItsValidityContextLawSpecializationStatesWhichContainmentsAreImmediateThroughTheImmediateSetTheoryEvidenceReads =
	property.explore(
		(source) => {
			const desc = source.draw(evidenceSchemaGen)
			const containedLaws = Arr.map(
				Arr.filter(theoryUnder(desc, noImmediate).laws, (l) => l.source.kind === "contained"),
				(l) => l.id
			)
			return [desc, source.draw(subarray(containedLaws))] as const
		},
		{
			needs: {},
			budget: { runs: 100, steered: 200 },
			situations: ["none named", "some named"] satisfies ReadonlyArray<
				Reached<"none named" | "some named">
			>,
			check:
				(_, c: Case<"none named" | "some named">) =>
				([desc, named]) =>
					Effect.sync(() => {
						c.note(named.length === 0 ? "none named" : "some named")
						const t = theoryUnder(desc, new Set(named))
						/** A containment into a closed relation is immediate whatever the immediate set says. */
						const intoClosed = (k: (typeof t.evidence.containments)[number]) =>
							t.relations[k.to.relation]?.kind === "closed"
						for (const k of t.evidence.containments) {
							if (intoClosed(k)) {
								continue
							}
							assert.equal(
								k.context,
								Arr.some(named, (n) => n === k.law) ? "immediate" : "committedSnapshot",
								k.from.relation
							)
						}
						unorderedEqual(
							Arr.map(
								Arr.filter(
									immediateEvidence(t.evidence).containments,
									(k) => k.context === "immediate"
								),
								(k) => k.law
							),
							Arr.map(
								Arr.filter(
									t.evidence.containments,
									(k) => intoClosed(k) || Arr.some(named, (n) => n === k.law)
								),
								(k) => k.law
							)
						)
					}),
			oracle: {
				kind: "specification",
				name: "theoryEvidence's immediate set, a closed target aside"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/theory.ts",
					original:
						'\t\t\t\t\t\td.to.rel.kind === "closed" || immediate.has(law.id) ? "immediate" : "committedSnapshot"',
					replacement: '\t\t\t\t\t\td.to.rel.kind === "closed" ? "immediate" : "committedSnapshot"',
					why: "Law specialization's immediate set unread (analysis/theory/theory.ts); the containment context fails."
				}
			]
		}
	)

/** Whether two laws come from the same statements, by index. */
const sameStatements = Arr.makeEquivalence((a: number, b: number) => a === b)

/**
 * Law identities are deterministic, independent of declaration order and of unrelated statements. The schema orders
 * its statements canonically, so a permutation leaves every law's statement index as it was; an unrelated statement
 * ordered before a law's (`extra`'s mutable Account) moves that index, and the law keeps its identity.
 *
 * Budget: 50 runs and 50 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/theory.test.ts:942 at 8cad5bce, its runs and its coverage's cases).
 */
export const lawIdentitiesAreDeterministicIndependentOfDeclarationOrderAndOfUnrelatedStatements =
	property.explore(
		(source) =>
			[
				source.draw(
					shuffled([...W.WorkDesc.statements.keys()], {
						min: W.WorkDesc.statements.length,
						max: W.WorkDesc.statements.length
					})
				),
				source.draw(subarray([...extra.keys()])),
				source.draw(
					array(int(0, W.WorkDesc.statements.length), {
						min: extra.length,
						max: extra.length
					})
				)
			] as const,
		{
			needs: {},
			budget: { runs: 50, steered: 50 },
			situations: [
				"reordered",
				"an unrelated statement",
				"a law's statement index moved"
			] satisfies ReadonlyArray<
				Reached<"reordered" | "an unrelated statement" | "a law's statement index moved">
			>,
			check:
				(_, c: Case<"reordered" | "an unrelated statement" | "a law's statement index moved">) =>
				([order, added, at]) =>
					Effect.sync(() => {
						const statements: Array<StatementDesc> = Arr.map(order, (i) =>
							defined(W.WorkDesc.statements[i])
						)
						if (Arr.some(order, (i, j) => i !== j)) {
							c.note("reordered")
						}
						for (const [j, which] of added.entries()) {
							c.note("an unrelated statement")
							statements.splice(
								Math.min(defined(at[j]), statements.length),
								0,
								defined(extra[which])
							)
						}
						const moved = theoryUnder({ ...W.WorkDesc, statements }, noImmediate)
						if (
							Arr.some(base.laws, (law) =>
								Arr.some(
									moved.laws,
									(l) => l.id === law.id && !sameStatements(l.statements, law.statements)
								)
							)
						) {
							c.note("a law's statement index moved")
						}
						for (const law of base.laws) {
							assert.deepEqual(
								Option.map(
									Arr.findFirst(moved.laws, (l) => l.id === law.id),
									(l) => l.shape
								),
								Option.some(law.shape),
								`${law.id} keeps its identity`
							)
						}
						for (const law of moved.laws) {
							const { id, named, loc, ...identity } = law
							assert.ok(
								identifierOf(lawIdentityOf(identity)) === id,
								`${id} is its identity's identifier`
							)
							assert.ok(identifierOf(named) === id, `${id} is its named identity's identifier`)
						}
					}),
			oracle: {
				kind: "universal",
				name: "metamorphic: every law keeps its identity under a permutation of the statements and an unrelated statement inserted"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/theory.ts",
					original: "\tidentity.law(lawStatement(law, ownSpelling))",
					replacement:
						"\tidentity.law({\n\t\t...lawStatement(law, ownSpelling),\n\t\tparts: [...lawStatement(law, ownSpelling).parts, law.statements.map(String)]\n\t})",
					why: "A law's identity names the statement it comes from (analysis/theory/theory.ts lawIdentityOf), its index in the schema's canonical order: a permutation leaves it, but Task declared mutable, ordered before every statement a law of Work comes from, moves it, so every such law takes another identity and the identities' independence fails; the equivalent declarations too, since a restated law would take its later statement's identity."
				}
			]
		}
	)

/** Law identities make equivalent declarations one law of one statement, however many times and in whichever order they are stated. */
export const lawIdentitiesMakeEquivalentDeclarationsOneLawOfOneStatementHoweverManyTimesAndInWhicheverOrderTheyAreStated =
	property.exhaust(finite(array(declaration, { min: 1, max: 3 })), {
		needs: {},
		situations: [
			"one declaration",
			"several declarations",
			"the reverse undeclared"
		] satisfies ReadonlyArray<Reached<DeclaredFeature>>,
		check: (_, c: Case<DeclaredFeature>) => (declared) =>
			Effect.sync(() => {
				c.note(declared.length === 1 ? "one declaration" : "several declarations")
				const statements = Arr.flatten(declared)
				const both = theoryUnder(
					{ ...W.WorkDesc, statements: [...W.WorkDesc.statements, ...statements] },
					noImmediate
				)
				const declaredInto = (from: string, to: string) =>
					Arr.filter(
						both.laws,
						(l) =>
							l.shape === "contained" &&
							l.source.kind === "contained" &&
							l.detail.kind === "containment" &&
							l.detail.from.relation === from &&
							l.detail.to.relation === to
					)
				const reverse = Arr.some(
					statements,
					(st) => st.kind === "contained" && st.left.relation === "Task"
				)
				if (!reverse) {
					c.note("the reverse undeclared")
				}
				assert.deepEqual(
					Arr.map(declaredInto("TaskNote", "Task"), (l) => l.statements.length),
					[1],
					"TaskNote(task) in Task(id) is one law of one statement"
				)
				assert.deepEqual(
					Arr.map(declaredInto("Task", "TaskNote"), (l) => l.statements.length),
					reverse ? [1] : [],
					"its reverse is one law of one statement where it is declared"
				)
			}),
		oracle: {
			kind: "specification",
			name: "a law is its statement's meaning, stated once"
		},
		box: "one to three declarations, each a containment either way or mirrors in either spelling",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/shape.ts",
				original: "out.push(yield* path.at(i, item.parse(child, path)))",
				replacement: "{}",
				why: "Operator mutant 24f5fcff87 at packages/engine/src/ir/shape.ts:660 in itemsOf: `out.push(yield* path.at(i, item.parse(child, path)))` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})
