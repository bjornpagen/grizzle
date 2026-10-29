import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, boolean, constant, type Gen, int, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { splitRenames } from "#compiler/deploy/render/chosen.ts"
import { readDecisions } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { fromFirstToken, splitStatements } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import {
	declaredRosterRebuild,
	fieldsBetweenRebuiltRosters,
	hoppedRosterDeclaredAgain,
	jointDrawGen,
	type RenamedDraw,
	referencedRenamedFirst,
	renamedDrawGen,
	resolveRenamedDraw,
	revivedRosterRebuild,
	type Version
} from "#test/pg/migrate-gen/support.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import {
	asDrafted,
	compile,
	fromEmpty,
	fromSnapshot,
	generate,
	type Previous
} from "#test/support/migrate/kit.ts"

import {
	type Decisions,
	decided,
	renderReviewed,
	review,
	reviewWritten,
	type Written
} from "#test/support/migrate/review.ts"

/** Each version drafted against the snapshot before it, every candidate kept; any refusal but the one named below fails
 * the property.
 *
 * The choices a draft offers, recorded in meta.json, and the split decisions `grizzle check` refuses, generated over
 * the migration paths' schemas with renames (`renamedDrawGen`), drafted on the host and
 * reviewed by the one reviewer:
 *
 * - meta.json records every candidate the draft marks and every statement a candidate decides; a draft without
 *   candidates records no choice. The reviewer follows the record through the text, and throws when the two disagree;
 * - a group of statements the reviewer confirms under one marker is one decision: a review that keeps a strict part of
 *   it is refused, one that keeps all of it or removes all of it is not;
 * - a review that decides every candidate one way at every statement it marks, chosen or kept, and chooses none without
 *   the candidates it requires, spells the reviewed plan's statements and is no split decision, two chosen candidates
 *   that decide one statement alike (each deleting it, or each replacing it with the same statements) included;
 * - a review that writes one statement of a candidate otherwise than its others is refused, unless that statement is
 *   the candidate's only one, or is nested in a rename the review keeps, which writes it not at all. Writing a
 *   statement for a candidate means writing its offer's alternative, or deleting the statement when the offer says
 *   delete both, or keeping it;
 * - the draft of every version succeeds, but for the step the drafting rules refuse by name, a field moved between two
 *   rosters the step rebuilds (`fieldsBetweenRebuiltRosters`, test/unit/deploy/drafting.test.ts), which is refused as
 *   UnsupportedOperation and ends the path there. */
const drafted = (versions: ReadonlyArray<Version>): ReadonlyArray<GenerateResult> => {
	const out: Array<GenerateResult> = []
	let previous: Previous = fromEmpty
	for (const [i, v] of versions.entries()) {
		const g = generate({
			previous,
			name: `version_${i}`,
			installation: compile(v.desc, asDrafted),
			timestamp: `2026101500000${i}`,
			workload: noWorkload
		})
		const prior = versions[i - 1]
		if (prior !== undefined && fieldsBetweenRebuiltRosters(prior, v).size > 0) {
			refused(g, "UnsupportedOperation", `version ${i}: a field moved between two rebuilt rosters`)
			return out
		}
		const d = succeeded(g)
		if (d.change !== "none") {
			out.push(d)
		}
		previous = fromSnapshot(d.snapshot)
	}
	return out
}

type Feature =
	| "a group confirmed as one"
	| "a roster rebuilt"
	| "a draft with candidates"
	| "an offer that deletes"
	| "an offer that replaces"
	| "a split decision"
	| "a flip of a candidate's only statement"
	| "a flip inside a kept rename"
	| "a consistent choice of a rename"
	| "two chosen candidates deciding one statement alike"
	| "every candidate kept"

/** The statements of a text, as check compares them. */
const statementsOf = (text: string): ReadonlyArray<string> =>
	Arr.map(splitStatements(text), fromFirstToken)

/** Reviewed files with one file's statements that `gone` holds removed, each once, the others kept as they are. */
const without = (
	files: ReadonlyArray<{ readonly name: string; readonly text: string }>,
	file: string,
	gone: ReadonlyArray<string>
): ReadonlyArray<{ readonly name: string; readonly text: string }> =>
	Arr.map(files, (f) => {
		if (f.name !== file) {
			return f
		}
		const left = [...gone]
		const kept = Arr.filter(splitStatements(f.text), (s) => {
			const at = left.indexOf(fromFirstToken(s))
			if (at < 0) {
				return true
			}
			left.splice(at, 1)
			return false
		})
		assert.deepEqual(left, [], `${file} holds every statement removed from it`)
		return {
			name: f.name,
			text: Arr.join(
				Arr.map(kept, (s) => `${s};\n`),
				"\n"
			)
		}
	})

/** What a case draws: a renamed path, which candidates the reviewer chooses, by index modulo, and whether one statement
 * is written otherwise than the decisions decide it. */
interface Sketch<P> {
	readonly path: P
	readonly chosen: ReadonlyArray<boolean>
	readonly written: Written
}

const noneChosen = Array.from({ length: 12 }, () => false)
const everyChosen = Array.from({ length: 12 }, () => true)

/** One statement written otherwise than the decisions decide it: the choice it flips, and the offer it takes there. */
const splitGen: Gen<Written> = (source) => ({
	kind: "split",
	choice: source.draw(int(0, 200)),
	offer: source.draw(int(0, 3))
})

/** A renamed path, reviewed choosing the candidates `chosen` picks, every statement written as decided or one not. */
const renamedCaseGen: Gen<Sketch<RenamedDraw>> = (source) => ({
	path: source.draw(renamedDrawGen),
	chosen: source.draw(array(boolean, { min: 12, max: 12 })),
	written: source.draw(oneOf([constant(decided), splitGen]))
})

/**
 * Two relations linked by a containment, both renamed with their contained fields converted, whose two candidates
 * decide one statement alike, which the renamed paths draw about one case in 2,600: reviewed choosing every candidate,
 * so a review that writes every statement as decided, three in four, chooses both.
 */
const jointCaseGen: Gen<Sketch<RenamedDraw>> = (source) => ({
	path: source.draw(jointDrawGen),
	chosen: everyChosen,
	written: source.draw(
		weighted([
			[3, constant(decided)],
			[1, splitGen]
		])
	)
})

/** Each reviewed with every candidate kept. */
const kept: ReadonlyArray<Kept<Sketch<RenamedDraw>, Feature>> = [
	{
		note: "R0 and its roster K0 renamed and both candidates kept, then renamed back with K0's last handle removed (a rebuild of a roster renamed away and back)",
		sketch: {
			path: { kind: "stated", path: revivedRosterRebuild },
			chosen: noneChosen,
			written: decided
		},
		draws: "",
		reaches: ["a draft with candidates"]
	},
	{
		note: "R0's field a of K0 removed, then K0's last handle removed: the roster is rebuilt once the column is gone",
		sketch: {
			path: { kind: "stated", path: declaredRosterRebuild },
			chosen: noneChosen,
			written: decided
		},
		draws: "",
		reaches: ["a roster rebuilt"]
	},
	{
		note: "K0 renamed and R0 given its old name, so the enum is set aside, then both renamed back with K0's last handle removed: K0 is a new enum, drafted, though a model that ignores the aside expects the refusal",
		sketch: {
			path: { kind: "stated", path: hoppedRosterDeclaredAgain },
			chosen: noneChosen,
			written: decided
		},
		draws: "",
		reaches: ["a draft with candidates", "a group confirmed as one"]
	},
	{
		note: "R0 and R1, whose containment references R0, both renamed with their fields converted, both chosen: both delete Publish's drop of R1's foreign key, one decision, which check refused as two",
		sketch: {
			path: { kind: "stated", path: referencedRenamedFirst },
			chosen: everyChosen,
			written: decided
		},
		draws: "",
		reaches: ["two chosen candidates deciding one statement alike"]
	}
]

describe("the choices a draft records and the split decisions check refuses, generated", () => {
	it.effect(
		"records every marked statement, and refuses exactly a candidate decided two ways",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/split-renames",
						draw: drawn(
							weighted([
								[6, renamedCaseGen],
								[1, jointCaseGen]
							])
						),
						literal: Formatter.format,
						/** A flip of a candidate's only statement is noted, not required. A field's rename marks the removed field's
						 * drop as well as the addition (`tableObject`), so every candidate these paths draw marks two
						 * statements at least. */
						features: features<Feature>([
							"a group confirmed as one",
							"a roster rebuilt",
							"a draft with candidates",
							"an offer that deletes",
							"an offer that replaces",
							"a split decision",
							"a consistent choice of a rename",
							"two chosen candidates deciding one statement alike",
							"every candidate kept"
						]),
						kept,
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "mutate", cases: 60, sense: notesOnly },
						caseHang: Duration.minutes(2)
					},
					({ path: drawnPath, chosen, written }, c) =>
						Effect.sync(() => {
							const path = c.draw(resolveRenamedDraw(drawnPath))
							for (const g of drafted([path.path.a, path.path.b, path.path.c])) {
								if (
									Arr.some(
										g.plan.steps,
										(s) =>
											s.draft.kind === "confirm" &&
											Arr.some(s.draft.keep, (k) => k.kind === "createEnum")
									)
								) {
									c.note("a roster rebuilt")
								}
								const recorded = g.folder.meta.decisions
								const read = succeeded(readDecisions(recorded))
								/** Each group of two statements or more: kept whole, removed whole, and kept but for one, or kept only in
								 * one, every candidate kept. */
								const groups = Arr.filter(recorded.confirms, (x) => x.statements.length > 1)
								if (groups.length > 0) {
									const kept = succeeded(
										review(g, { chosen: new Set(), losses: "written", value: () => "0" })
									).files
									assert.deepEqual(
										splitRenames(read, kept),
										[],
										"a review that keeps every group whole is no split"
									)
									for (const group of groups) {
										c.note("a group confirmed as one")
										assert.deepEqual(
											splitRenames(read, without(kept, group.file, group.statements)),
											[],
											"a group removed whole is no split"
										)
										for (const [k, s] of group.statements.entries()) {
											const others = Arr.remove(group.statements, k)
											for (const gone of [[s], others]) {
												assert.ok(
													splitRenames(read, without(kept, group.file, gone)).length > 0,
													`a group kept in part is refused: ${Arr.join(gone, "; ")} removed`
												)
											}
										}
									}
								}
								if (recorded.candidates.length === 0) {
									assert.deepEqual(
										recorded.choices,
										[],
										"a draft without candidates records no choice"
									)
									continue
								}
								c.note("a draft with candidates")
								for (const x of recorded.choices) {
									for (const o of x.offers) {
										c.note(
											o.statements.length === 0 ? "an offer that deletes" : "an offer that replaces"
										)
									}
								}
								/** The chosen candidates: a later candidate sharing a statement with an earlier chosen one is kept,
								 * unless the review writes every statement as decided and the two decide it alike. A review that
								 * writes one statement the other way chooses at most one candidate per statement, the case its
								 * expectation below reads. */
								const sameStatements = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
									a.length === b.length && Arr.every(a, (x, i) => x === b[i])
								/** At most one rename for each added and each removed name, of each kind, as documented. */
								const oneName = (a: number, b: number): boolean => {
									const x = recorded.candidates[a]?.renames
									const y = recorded.candidates[b]?.renames
									return (
										x !== undefined &&
										y !== undefined &&
										x.kind === y.kind &&
										(x.removed === y.removed || x.added === y.added)
									)
								}
								const taken = new Set<number>()
								for (const [candidate] of recorded.candidates.entries()) {
									if (
										chosen[candidate % chosen.length] === true &&
										!Arr.some([...taken], (t) => oneName(t, candidate)) &&
										!Arr.some(recorded.choices, (x) =>
											Option.exists(
												Arr.findFirst(x.offers, (o) => o.candidate === candidate),
												(own) =>
													Arr.some(
														x.offers,
														(o) =>
															taken.has(o.candidate) &&
															(written.kind !== "decided" ||
																!sameStatements(o.statements, own.statements))
													)
											)
										)
									) {
										taken.add(candidate)
									}
								}
								for (const candidate of taken) {
									if (
										Option.exists(Arr.get(recorded.candidates, candidate), (entry) =>
											Arr.some(entry.requires, (r) => !taken.has(r))
										)
									) {
										taken.delete(candidate)
									}
								}
								c.note(taken.size > 0 ? "a consistent choice of a rename" : "every candidate kept")
								if (
									Arr.some(
										recorded.choices,
										(x) => Arr.filter(x.offers, (o) => taken.has(o.candidate)).length > 1
									)
								) {
									c.note("two chosen candidates deciding one statement alike")
								}
								const decisions: Decisions = { chosen: taken, losses: "written", value: () => "0" }
								/** The reviewer throws when the text and meta.json disagree: the record is what the text marks. */
								const reviewed = succeeded(review(g, decisions))
								assert.deepEqual(
									Arr.map(reviewed.files, (f) => statementsOf(f.text)),
									Arr.map(reviewed.plan, (f) => statementsOf(renderReviewed(f, decisions.value))),
									"the reviewed text spells the reviewed plan"
								)
								assert.deepEqual(
									splitRenames(read, reviewed.files),
									[],
									"a consistent review is no split"
								)
								if (written.kind === "decided") {
									continue
								}
								/** The candidate the flipped statement's written decision names: the one its decisions choose there,
								 * which it keeps, else the one whose offer it takes. */
								const flipped = recorded.choices[written.choice % recorded.choices.length]
								assert.ok(flipped !== undefined, "a draft with candidates records a choice")
								const offer = Option.getOrElse(
									Arr.findFirst(flipped.offers, (o) => taken.has(o.candidate)),
									() => flipped.offers[written.offer % flipped.offers.length]
								)
								assert.ok(offer !== undefined, "a recorded choice offers a candidate")
								/** The statements the flip's candidate decides, but one another chosen candidate decides alike: written as
								 * that one decides it, it is written as the flip's candidate decides it too. */
								const alike = (x: (typeof recorded.choices)[number]) =>
									Option.exists(
										Arr.findFirst(x.offers, (o) => o.candidate === offer.candidate),
										(own) =>
											Arr.some(
												x.offers,
												(o) =>
													o.candidate !== offer.candidate &&
													taken.has(o.candidate) &&
													sameStatements(o.statements, own.statements)
											)
									)
								const sites = Arr.filter(
									recorded.choices,
									(x) =>
										Arr.some(x.offers, (o) => o.candidate === offer.candidate) &&
										(x === flipped || !alike(x))
								)
								/** A loss the flip's candidate carries, which the review decides and no other chosen candidate carries, is
								 * a site of it too: the review writes the loss's statement in, while the flip chooses the candidate
								 * that carries it. */
								const losses = Arr.filter(
									recorded.losses,
									(l) =>
										l.carriers.includes(offer.candidate) &&
										!Arr.some(l.carriers, (k) => taken.has(k)) &&
										(l.within.kind === "top" || taken.has(l.within.candidate))
								)
								/** A flip that chooses a candidate renaming a name a chosen one renames too, of its kind, chooses two
								 * renames of one name. */
								const twice =
									!taken.has(offer.candidate) &&
									Arr.some([...taken], (k) => oneName(k, offer.candidate))
								/** A choice nested in a rename the review keeps stays in its commented alternative, so its flip writes
								 * nothing. */
								const visible = flipped.within.kind === "top" || taken.has(flipped.within.candidate)
								const found = splitRenames(
									read,
									succeeded(reviewWritten(g, decisions, written)).files
								)
								assert.equal(
									found.length > 0,
									visible && (sites.length + losses.length > 1 || twice),
									"a split decision or two renames of one name are refused, a flip of the only one or inside a kept rename is none"
								)
								c.note(
									!visible
										? "a flip inside a kept rename"
										: sites.length + losses.length > 1
											? "a split decision"
											: "a flip of a candidate's only statement"
								)
							}
						})
				)
			)
	)
})
