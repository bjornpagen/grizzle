import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result, String as Str } from "effect"
import { type Candidate, type Offer, pathOf, rivals, samePath } from "#compiler/deploy/diff/plan.ts"
import { chosenIn, lossDecisions, splitRenames } from "#compiler/deploy/render/chosen.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { fromFirstToken, splitStatements } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
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
	rivalsOntoOne,
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
	choosable,
	type Decisions,
	decisionText,
	draftChoices,
	readsBack,
	recordFaults,
	renderReviewed,
	review,
	reviewSites,
	reviewWritten,
	type Written
} from "#test/support/migrate/review.ts"

/** Each version drafted against the snapshot before it, every candidate kept; any refusal but the one named below fails
 * the property.
 *
 * The decision record a draft writes to meta.json, and the reviews `grizzle check` reads against it, generated over the
 * migration paths' schemas with renames (`renamedDrawGen`), drafted on the host and reviewed by the one reviewer:
 *
 * - meta.json is the complete record of the draft: it decodes, proves, writes back byte for byte, and holds every
 *   statement each file holds uncommented, in order (`recordFaults`);
 * - a group of statements the reviewer confirms under one marker is one decision: a review that keeps a strict part of
 *   it is refused, one that keeps all of it or removes all of it is not;
 * - every decision the documented rules allow (`choosable`) reads back as itself, by path, with nothing refused, its
 *   text spelling the reviewed plan, two chosen candidates that decide one statement alike (each deleting it, or each
 *   replacing it with the same statements) included;
 * - a review mutated from one, each a named arm: one statement a choice decides written the other way (a split), which
 *   check refuses unless the folder is then exactly the review of the decision it reads back as; one statement the
 *   decision excludes (a branch it does not take, or a statement inside a rename it does not choose) written in, which
 *   check refuses in that file; one statement at the top of a file that no candidate decides deleted, or replaced by
 *   the reviewer's own, and one statement of the reviewer's own added, none of which check refuses or reads as another
 *   decision;
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
	| "a consistent choice of a rename"
	| "two chosen candidates deciding one statement alike"
	| "every candidate kept"
	| "a split decision refused"
	| "a flip read back as another decision"
	| "an excluded statement written in refused"
	| "a statement inside a rename not chosen written in refused"
	| "a free statement deleted"
	| "a free statement replaced by the reviewer's own"
	| "a statement of the reviewer's own added"
	| "a field's rename nested under two rival relation renames, one chosen"

/** The statements of a text, as check compares them. */
const statementsOf = (text: string): ReadonlyArray<string> =>
	Arr.map(splitStatements(text), fromFirstToken)

type Files = ReadonlyArray<{ readonly name: string; readonly text: string }>

/** Reviewed files with one file's statements that `gone` holds removed, each once, the others kept as they are, and
 * `added` appended to it. */
const edited = (
	files: Files,
	file: string,
	gone: ReadonlyArray<string>,
	added: ReadonlyArray<string>
): Files =>
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
				Arr.map([...kept, ...added], (s) => `${s};\n`),
				"\n"
			)
		}
	})

/** How a case mutates the review of its decision, each a named arm: none; one statement a choice decides written the
 * other way; one excluded statement written in; one free statement deleted or replaced by the reviewer's own; one
 * statement of the reviewer's own added. Each picks its site by an index modulo the sites there are. */
type Mutation =
	| { readonly kind: "none" }
	| { readonly kind: "split"; readonly written: Written }
	| { readonly kind: "excluded"; readonly at: number }
	| { readonly kind: "free deleted"; readonly at: number }
	| { readonly kind: "free replaced"; readonly at: number }
	| { readonly kind: "added" }

/** The reviewer's own statement, which no draft records. */
const ownStatement = "SELECT 1"

/** Which choosable decision a case reviews: every candidate kept, the one choosing the most, or one by its place. */
type Pick =
	| { readonly kind: "kept" }
	| { readonly kind: "widest" }
	| { readonly kind: "at"; readonly at: number }

/** What a case draws: a renamed path, which decision the reviewer makes of each draft, and how the review is mutated. */
interface Sketch<P> {
	readonly path: P
	readonly pick: Pick
	readonly mutation: Mutation
}

const pickGen: Gen<Pick> = weighted<Pick>([
	[1, constant({ kind: "kept" })],
	[1, constant({ kind: "widest" })],
	[4, (source) => ({ kind: "at", at: source.draw(int(0, 255)) })]
])

const mutationGen: Gen<Mutation> = weighted<Mutation>([
	[3, constant({ kind: "none" })],
	[
		2,
		(source) => ({
			kind: "split",
			written: { kind: "split", choice: source.draw(int(0, 200)), offer: source.draw(int(0, 3)) }
		})
	],
	[2, (source) => ({ kind: "excluded", at: source.draw(int(0, 200)) })],
	[1, (source) => ({ kind: "free deleted", at: source.draw(int(0, 200)) })],
	[1, (source) => ({ kind: "free replaced", at: source.draw(int(0, 200)) })],
	[1, constant({ kind: "added" })]
])

/** A renamed path, reviewed as `pick` decides, every statement written as decided or mutated. */
const renamedCaseGen: Gen<Sketch<RenamedDraw>> = (source) => ({
	path: source.draw(renamedDrawGen),
	pick: source.draw(pickGen),
	mutation: source.draw(mutationGen)
})

/**
 * Two relations linked by a containment, both renamed with their contained fields converted, whose two candidates
 * decide one statement alike, which the renamed paths draw about one case in 2,600: reviewed choosing the widest
 * decision, which chooses both.
 */
const jointCaseGen: Gen<Sketch<RenamedDraw>> = (source) => ({
	path: source.draw(jointDrawGen),
	pick: { kind: "widest" },
	mutation: source.draw(mutationGen)
})

const kept: ReadonlyArray<Kept<Sketch<RenamedDraw>, Feature>> = [
	{
		note: "R0 and its roster K0 renamed and both candidates kept, then renamed back with K0's last handle removed (a rebuild of a roster renamed away and back)",
		sketch: {
			path: { kind: "stated", path: revivedRosterRebuild },
			pick: { kind: "kept" },
			mutation: { kind: "none" }
		},
		draws: "",
		reaches: ["a draft with candidates"]
	},
	{
		note: "R0's field a of K0 removed, then K0's last handle removed: the roster is rebuilt once the column is gone",
		sketch: {
			path: { kind: "stated", path: declaredRosterRebuild },
			pick: { kind: "kept" },
			mutation: { kind: "none" }
		},
		draws: "",
		reaches: ["a roster rebuilt"]
	},
	{
		note: "K0 renamed and R0 given its old name, so the enum is set aside, then both renamed back with K0's last handle removed: K0 is a new enum, drafted, though a model that ignores the aside expects the refusal",
		sketch: {
			path: { kind: "stated", path: hoppedRosterDeclaredAgain },
			pick: { kind: "kept" },
			mutation: { kind: "none" }
		},
		draws: "",
		reaches: ["a draft with candidates", "a group confirmed as one"]
	},
	{
		note: "R0 and R1, whose containment references R0, both renamed with their fields converted, both chosen: both delete Publish's drop of R1's foreign key, one decision, which check refused as two",
		sketch: {
			path: { kind: "stated", path: referencedRenamedFirst },
			pick: { kind: "widest" },
			mutation: { kind: "none" }
		},
		draws: "",
		reaches: ["two chosen candidates deciding one statement alike"]
	},
	{
		note: "issue #8: R0 and R1 both removed, Q0 of their primary key added with R0's field b renamed to c, so each rival offers its own nested rename of b to c, spelt alike; R0's chosen with its field's (generate died with an internal error, and check misattributed the rival's)",
		sketch: {
			path: { kind: "stated", path: rivalsOntoOne },
			pick: { kind: "widest" },
			mutation: { kind: "none" }
		},
		draws: "",
		reaches: ["a field's rename nested under two rival relation renames, one chosen"]
	}
]

/** The decision a pick makes of a draft, among the decisions the documented rules allow. */
const decisionOf = (g: GenerateResult, pick: Pick): ReadonlySet<Candidate> => {
	const all = choosable(g)
	switch (pick.kind) {
		case "kept":
			return new Set()
		case "widest":
			return Arr.reduce(all, new Set<Candidate>(), (widest: ReadonlySet<Candidate>, d) =>
				d.size > widest.size ? d : widest
			)
		case "at":
			return Arr.reduce(all, new Set<Candidate>(), (found: ReadonlySet<Candidate>, d, i) =>
				i === pick.at % all.length ? d : found
			)
	}
}

/** The candidates a folder reads back as chosen, as the plan's records, by path. */
const readAs = (g: GenerateResult, files: Files): ReadonlySet<Candidate> => {
	const read = Arr.map([...chosenIn(g.record, files)], (c) => c.path)
	return new Set(
		Arr.filter(
			Arr.flatMap(draftChoices(g), ({ choice }) =>
				Arr.map(choice.offers, (o: Offer) => o.candidate)
			),
			(c) => Arr.some(read, (p) => samePath(pathOf(c), p))
		)
	)
}

/** The perception notes of a draft and its decision. */
const noted = (
	c: { readonly note: (f: Feature) => void },
	g: GenerateResult,
	chosen: ReadonlySet<Candidate>
): void => {
	if (
		Arr.some(
			g.plan.steps,
			(s) => s.draft.kind === "confirm" && Arr.some(s.draft.keep, (k) => k.kind === "createEnum")
		)
	) {
		c.note("a roster rebuilt")
	}
	const choices = draftChoices(g)
	if (choices.length === 0) {
		return
	}
	c.note("a draft with candidates")
	for (const { choice } of choices) {
		for (const o of choice.offers) {
			if (o.kind === "delete") {
				c.note("an offer that deletes")
			}
			if (o.kind === "rewrite" || o.kind === "convert") {
				c.note("an offer that replaces")
			}
		}
		if (Arr.filter(choice.offers, (o: Offer) => chosen.has(o.candidate)).length > 1) {
			c.note("two chosen candidates deciding one statement alike")
		}
	}
	c.note(chosen.size > 0 ? "a consistent choice of a rename" : "every candidate kept")
	const offered = Arr.flatMap(choices, ({ choice }) =>
		Arr.map(choice.offers, (o: Offer) => o.candidate)
	)
	for (const x of chosen) {
		if (
			x.kind === "nested field" &&
			Arr.some(offered, (y) => y !== x.parent && y.kind === "relation" && rivals(y, x.parent))
		) {
			c.note("a field's rename nested under two rival relation renames, one chosen")
		}
	}
}

describe("the decision record a draft writes and the reviews check reads against it, generated", () => {
	it.effect(
		"records every drafted statement, reads every allowed decision back as itself, and refuses exactly a review that writes another",
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
						coverage: required<Feature>(
							[
								"a group confirmed as one",
								"a roster rebuilt",
								"a draft with candidates",
								"an offer that deletes",
								"an offer that replaces",
								"a consistent choice of a rename",
								"two chosen candidates deciding one statement alike",
								"every candidate kept",
								"a split decision refused",
								"an excluded statement written in refused",
								"a statement inside a rename not chosen written in refused",
								"a free statement deleted",
								"a free statement replaced by the reviewer's own",
								"a statement of the reviewer's own added"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept,
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ path: drawnPath, pick, mutation }, c) =>
						Effect.sync(() => {
							const path = c.draw(resolveRenamedDraw(drawnPath))
							for (const g of drafted([path.path.a, path.path.b, path.path.c])) {
								assert.deepEqual(recordFaults(g), [], "meta.json is the complete record")
								const chosen = decisionOf(g, pick)
								noted(c, g, chosen)
								const decisions: Decisions = { chosen, losses: "written", value: () => "0" }
								const reviewed = review(g, decisions)
								if (Result.isFailure(reviewed)) {
									return assert.fail(
										`${decisionText(chosen)}: ${decisionText(new Set(reviewed.failure.candidates))} decide one statement of ${reviewed.failure.file} in different ways`
									)
								}
								const files = reviewed.success.files
								assert.deepEqual(
									Arr.map(files, (f) => statementsOf(f.text)),
									Arr.map(reviewed.success.plan, (f) =>
										statementsOf(renderReviewed(f, decisions.value))
									),
									"the reviewed text spells the reviewed plan"
								)
								assert.deepEqual(
									readsBack(g, chosen, files),
									[],
									`${decisionText(chosen)}: the review reads back as made`
								)
								for (const f of g.folder.meta.files) {
									for (const step of f.steps) {
										if (step.kind !== "confirm" || step.statements.length < 2) {
											continue
										}
										c.note("a group confirmed as one")
										assert.deepEqual(
											splitRenames(g.record, edited(files, f.name, step.statements, [])),
											[],
											"a group removed whole is no split"
										)
										for (const [k, s] of step.statements.entries()) {
											const others = Arr.remove(step.statements, k)
											for (const gone of [[s], others]) {
												assert.ok(
													splitRenames(g.record, edited(files, f.name, gone, [])).length > 0,
													`a group kept in part is refused: ${Arr.join(gone, "; ")} removed`
												)
											}
										}
									}
								}
								const sites = reviewSites(g, chosen)
								switch (mutation.kind) {
									case "none":
										break
									case "split": {
										const written = succeeded(reviewWritten(g, decisions, mutation.written)).files
										if (
											splitRenames(g.record, written).length > 0 ||
											Arr.some(lossDecisions(g.record, written), (d) => d.kind === "unresolved")
										) {
											c.note("a split decision refused")
											break
										}
										/** Accepted, the folder is exactly the review of the decision it reads back as. */
										const as = readAs(g, written)
										assert.deepEqual(
											readsBack(g, as, written),
											[],
											"an accepted flip reads back as the decision it writes"
										)
										const again = succeeded(review(g, { ...decisions, chosen: as })).files
										assert.deepEqual(
											Arr.map(written, (f) => statementsOf(f.text)),
											Arr.map(again, (f) => statementsOf(f.text)),
											"an accepted flip writes exactly the review of the decision it reads back as"
										)
										c.note("a flip read back as another decision")
										break
									}
									case "excluded": {
										const candidates = Arr.filter(
											sites.excluded,
											(x) => !Str.includes(placeholderToken)(x.statement)
										)
										const site = candidates[mutation.at % Math.max(candidates.length, 1)]
										if (site === undefined) {
											break
										}
										const refusals = splitRenames(
											g.record,
											edited(files, site.file, [], [site.statement])
										)
										assert.ok(
											Arr.some(
												refusals,
												(r) => r.file === site.file && (r.kind === "split" || r.kind === "orphan")
											),
											`${decisionText(chosen)}: an excluded statement written in passes check: ${site.statement}`
										)
										c.note(
											site.refused === "orphan"
												? "a statement inside a rename not chosen written in refused"
												: "an excluded statement written in refused"
										)
										break
									}
									case "free deleted":
									case "free replaced": {
										const free = Arr.filter(
											sites.free,
											(x) => !Str.includes(placeholderToken)(x.statement)
										)
										const site = free[mutation.at % Math.max(free.length, 1)]
										if (site === undefined) {
											break
										}
										const changed = edited(
											files,
											site.file,
											[site.statement],
											mutation.kind === "free deleted" ? [] : [ownStatement]
										)
										assert.deepEqual(
											readsBack(g, chosen, changed),
											[],
											`${decisionText(chosen)}: a free statement edited changes the decision read: ${site.statement}`
										)
										c.note(
											mutation.kind === "free deleted"
												? "a free statement deleted"
												: "a free statement replaced by the reviewer's own"
										)
										break
									}
									case "added": {
										const [first] = files
										if (first === undefined) {
											break
										}
										assert.deepEqual(
											readsBack(g, chosen, edited(files, first.name, [], [ownStatement])),
											[],
											`${decisionText(chosen)}: a statement of the reviewer's own changes the decision read`
										)
										c.note("a statement of the reviewer's own added")
										break
									}
								}
							}
						})
				)
			)
	)
})
