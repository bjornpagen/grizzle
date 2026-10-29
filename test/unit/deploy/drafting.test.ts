import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore, type Kept } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, oneOf, weighted } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	Record,
	Result,
	String as Str
} from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { isNoTransaction } from "#compiler/deploy/render/markers.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema as schemaOf } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	chosenRenames,
	declaredRosterRebuild,
	extensionsOf,
	fieldBackOntoRenamedRoster,
	fieldOntoRemoved,
	fieldsBetweenRebuiltRosters,
	type FreshRelations,
	hoppedRosterDeclaredAgain,
	type IntentSketch,
	intentSketchGen,
	keyCarriedOverRetyped,
	keyRenamedOntoPrimary,
	type LegalIntent,
	type LegalIntentKind,
	planOf,
	type RenamedDraw,
	type RenamedPath,
	referencedRenamedFirst,
	referencingRenamedFirst,
	referrerRetypedAway,
	referrerRetypedWithKey,
	relationOntoRemoved,
	removedUnderRenamedHandles,
	renamedDrawGen,
	renamedWithRetype,
	resolveIntents,
	resolveRenamedDraw,
	revivedRosterRebuild,
	serialUnderAliasedRelation,
	statisticsOfRenamedRelation,
	statisticsOverRenamedField,
	statisticsOverRetyped,
	swappedAndRespelled,
	type TracedSchema,
	typedValue,
	type Version
} from "#test/pg/migrate-gen/support.ts"
import { assert, defined, refusalLoc, refused } from "#test/support/assert.ts"
import {
	type AuthoredStatementDesc,
	contained,
	f,
	relation as fixtureRelation,
	key,
	on,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	checkOf,
	chosenFor,
	type Drafted,
	type DraftedLoss,
	draftAttempt,
	draftOf,
	type Finding,
	freshStateOf,
	integerRows,
	loadIntegers,
	noRowValue,
	plainReviewOf,
	type ReviewChoices,
	type ReviewedFolder,
	reviewOf,
	type TextFile
} from "#test/support/migrate/draft.ts"
import { catalogOf, emptyState, type State } from "#test/support/migrate/interpret.ts"
import { fromEmpty, type Previous } from "#test/support/migrate/kit.ts"
import { indices } from "#test/support/oracle/pick.ts"

/** Generated migration paths drafted and reviewed with no database, judged by what a draft writes: its folder's SQL
 * files and meta.json as the command line writes them, `grizzle check`'s reading of a reviewed folder, and the reviewed
 * SQL run on the catalog model of PostgreSQL, through the drafting door. No plan is
 * read.
 *
 * A renamed path (`renamedDrawGen`) is a schema A, its successor B and B's successor C,
 * with the renames a user makes along the way: relations and fields, swaps, chains and renames back, a field with its
 * type changed, a relation renamed with a field's type changed, a hop of a name across a relation and a type, aliases,
 * dictionary names (63-byte identifiers, reserved words), a name taken again after the previous migration dropped it,
 * closed rosters reordered, shortened or renamed in place, statistics, serial fields declared, dropped and retyped, and
 * keys over retyped fields. The chains A, B, C and A, C are each drafted step by step from the snapshot before, as
 * `grizzle generate` drafts them, and each draft is reviewed by the one reviewer twice: every candidate kept, and the
 * path's own renames chosen where the draft offers them (`chosenCandidates`), every loss of stored data no chosen
 * candidate carries written in. Properties, for every step of every chain:
 *
 * (a) the draft succeeds, but for the one documented refusal the generator names (support.ts
 *     fieldsBetweenRebuiltRosters): a field whose type moves from one closed roster to another while the step rebuilds
 *     both, which the draft refuses with UnsupportedOperation at the closed relation of a roster a field leaves, ending
 *     the chain; any other refusal is a defect;
 * (b) each review is expressible, or is the one documented inexpressible case, two chosen candidates that decide one
 *     statement differently, which ends the chain;
 * (c) `grizzle check` accepts every reviewed folder: no marker left, no decision split, no loss unresolved;
 * (d) the draft is idempotent: drafting the same version again from the snapshot it wrote changes nothing;
 * (e) the snapshot is history-free: the fingerprint a chain reaches for a version is the fingerprint of that version
 *     drafted from the empty snapshot, whatever renames, drops and reviews led there;
 * (f) the reviewed SQL runs on the catalog model of PostgreSQL from the catalog the
 *     chain reached so far, every statement's preconditions holding at its position, and reaches the catalog of the
 *     step's snapshot installed from nothing;
 * (g) the folder keeps the documented phase contract: its files are `NN-<phase>.sql`, numbered from 01 without a gap, in the
 *     phase order setup, structure, indexes, validate, publish, and only a setup or an indexes file runs without a
 *     transaction;
 * (h) every loss of stored data meta.json records is a decision: the review that leaves each one commented is refused
 *     by `grizzle check` with one unresolved loss per loss it decides that no chosen candidate carries, and nothing else.
 *
 * Then the identities suite: a few relations of pairwise different headings, renamed, swapped, chained, removed, a
 * field removed, a relation added, by named intents, each relation of B knowing the relation of A it is (its origin).
 * The oracle is the intents and the documented rules, never the drafter: a relation whose name is gone, or whose kept
 * name now holds another heading while a relation of B, added or changed, has the heading it held, is a loss of its
 * rows, under the door's aside name (identity.aside) when set aside; a field removed from a kept relation is a loss of
 * its values; each rename an intent makes is a candidate the draft offers. So:
 *
 * - left undecided, `grizzle check` refuses exactly those losses; written in, it accepts the folder;
 * - every rename, swap and chain is expressible: choosing the intents' renames, each relation of B holds the rows of the
 *   relation of A it is, a removed field's values gone, and every other relation is empty;
 * - keeping every candidate, a relation keeps its rows only under its own name, unmoved;
 * - a loss written in while a candidate that carries it is chosen is refused as decided both ways;
 * - two relations of one heading swapped are no change at all (the named indistinguishable case).
 *
 * Bite: drafting a loss as a live statement (the decision silently skipped) leaves no unresolved finding, which (h) and
 * the identities suite's first property refuse; setting aside only holders of another kind drafts a swap or a chain in
 * place, which the identities suite refuses: no candidate for the intent's rename, and the rows under the old names. */
/** The name every drafted version is installed under, its schema identity, and its PostgreSQL schema. */
const draftingName = "gz_drafting"
const drafting = identity.schema(parsedSchemaName(draftingName))
const schema: string = identifierOf(drafting)
const owner = "grizzle_dev"

const featureNames = [
	"a step drafted",
	"a step that changes nothing",
	"a draft with candidates",
	"every candidate kept",
	"the path's renames chosen",
	"an inexpressible review",
	"a folder with a confirmed group",
	"a loss left and refused",
	"a loss carried by a chosen candidate",
	"a relation renamed in B",
	"a field renamed in B",
	"a field retyped in B",
	"names swapped in B",
	"a closed roster renamed in B",
	"a name hopped across kinds in B",
	"a roster rebuilt in C",
	"a handle renamed in place in C",
	"a name taken again in C after B dropped it",
	"a chain renamed in C",
	"a roster rebuilt with its field retyped",
	"a dropped name taken in C",
	"a rename onto a taken name refused at the boundary",
	"two candidates for one removed name refused when both are chosen",
	"one of two candidates for one removed name chosen",
	"a field moved between two rebuilt rosters refused"
] as const
type Feature = (typeof featureNames)[number] | `the intent ${LegalIntentKind}`

/** The rename kinds a path made, by successor, as features. */
const noteRenames = (c: Case<Feature>, p: RenamedPath): void => {
	const b = new Set(p.renames.toB)
	const k = new Set(p.renames.toC)
	if (b.has("relation") || b.has("relationRetyped")) {
		c.note("a relation renamed in B")
	}
	if (b.has("column")) {
		c.note("a field renamed in B")
	}
	if (b.has("retyped") || b.has("relationRetyped")) {
		c.note("a field retyped in B")
	}
	if (b.has("swapRelations") || b.has("swapColumns")) {
		c.note("names swapped in B")
	}
	if (b.has("closed")) {
		c.note("a closed roster renamed in B")
	}
	if (b.has("hop")) {
		c.note("a name hopped across kinds in B")
	}
	if (k.has("reorderRoster") || k.has("removeHandle")) {
		c.note("a roster rebuilt in C")
	}
	if (k.has("handle")) {
		c.note("a handle renamed in place in C")
	}
	if (k.has("ontoRemoved")) {
		c.note("a name taken again in C after B dropped it")
	}
	if (p.chained) {
		c.note("a chain renamed in C")
	}
}

/** The draft of `version` from `previous`, as `grizzle generate` drafts it; (a): any refusal fails. */
const draft = (version: Version, previous: Previous, name: string): Drafted =>
	draftOf(version.desc, extensionsOf(version), drafting, previous, name)

/** (a)'s named refusal: the draft of `version` from `previous`, a step moving a field away from each roster of `leaves`
 * (`fieldsBetweenRebuiltRosters`, by enum identifier) while both its rosters are rebuilt, is refused as
 * unsupported at the closed relation of one of them. */
const refusedBetweenRosters = (
	version: Version,
	previous: Previous,
	leaves: ReadonlySet<string>,
	at: string
): void => {
	const refusal = refused(
		draftAttempt(version.desc, extensionsOf(version), drafting, previous, "refused"),
		"UnsupportedOperation",
		`${at}: a field moved between two rebuilt rosters`
	)
	assert.ok(
		Arr.some(
			[...leaves],
			(k) =>
				refusalLoc(refusal).label ===
				`closed relation of enum ${quoteIdent(schema)}.${quoteIdent(k)}`
		),
		`${at}: the refusal is at ${refusalLoc(refusal).label}, not at a roster a field leaves`
	)
}

/** (f): the reviewed folder runs on the catalog model from `state`, and reaches the catalog of the snapshot `d` wrote,
 * installed from nothing. */
const reaches = (state: State, reviewed: ReviewedFolder, d: Drafted, at: string): State => {
	const ran = reviewed.run(schema, state, noRowValue)
	if (Result.isFailure(ran)) {
		return assert.fail(
			`${at}: ${ran.failure.file}, action ${ran.failure.action}, fails: ${ran.failure.reason}`
		)
	}
	const fresh = freshStateOf(schema, d)
	if (Result.isFailure(fresh)) {
		return assert.fail(`${at}: the snapshot installed from nothing fails: ${fresh.failure.reason}`)
	}
	assert.deepEqual(
		catalogOf(ran.success),
		catalogOf(fresh.success),
		`${at}: the catalog the draft reaches is not the snapshot's installed from nothing`
	)
	return ran.success
}

/** The phases in the documented order, and those whose files may run without a transaction. */
const phaseOrder: ReadonlyArray<string> = ["setup", "structure", "indexes", "validate", "publish"]
const noTransactionPhases: ReadonlySet<string> = new Set(["setup", "indexes"])

/** (g): the folder's files keep the phase contract. */
const phaseContract = (files: ReadonlyArray<TextFile>, at: string): void => {
	let last = 0
	for (const [i, file] of files.entries()) {
		const dash = Str.indexOf("-")(file.name)
		assert.ok(
			Option.isSome(dash) && dash.value === 2,
			`${at}: ${file.name} is not file ${i + 1} of a phase`
		)
		const ordinal = Number(Str.slice(0, dash.value)(file.name))
		const phase = Str.slice(dash.value + 1, -".sql".length)(file.name)
		const rank = phaseOrder.indexOf(phase)
		assert.ok(
			Str.endsWith(".sql")(file.name) && ordinal === i + 1 && rank >= 0,
			`${at}: ${file.name} is not file ${i + 1} of a phase`
		)
		assert.ok(rank >= last, `${at}: ${file.name} comes after a later phase's file`)
		last = rank
		if (isNoTransaction(file.text)) {
			assert.ok(noTransactionPhases.has(phase), `${at}: ${file.name} runs without a transaction`)
		}
	}
}

/** The findings of a kind. */
const ofKind = (found: ReadonlyArray<Finding>, kind: Finding["kind"]): ReadonlyArray<Finding> =>
	Arr.filter(found, (finding) => finding.kind === kind)

/** Whether a review choosing `chosen` decides a loss: one at the top of its file, or in a chosen candidate's
 * alternative; and whether it leaves it to the reviewer, no chosen candidate carrying it. */
const decides = (l: DraftedLoss, chosen: ReadonlySet<number>): boolean =>
	l.within.kind === "top" || chosen.has(l.within.candidate)

const leftTo = (l: DraftedLoss, chosen: ReadonlySet<number>): boolean =>
	decides(l, chosen) && !Arr.some(l.carriers, (k) => chosen.has(k))

/** (h): left undecided, every loss the review decides that no chosen candidate carries is refused once, and nothing
 * else is. */
const lossesDecided = (
	c: Case<Feature>,
	d: Drafted,
	chosen: ReadonlySet<number>,
	value: ReviewChoices["value"],
	at: string
): void => {
	if (d.losses.length === 0) {
		return
	}
	const left = reviewOf(d, { chosen, losses: "left", value })
	if (Result.isFailure(left)) {
		assert.fail(`${at}: a review leaving the losses is inexpressible`)
	}
	const found = checkOf(d, left.success.files)
	const expected = Arr.filter(d.losses, (l) => leftTo(l, chosen))
	assert.deepEqual(
		Arr.sort(
			Arr.map(found, (finding) => `${finding.kind} ${finding.file}`),
			Order.String
		),
		Arr.sort(
			Arr.map(expected, (l) => `unresolved loss ${l.file}`),
			Order.String
		),
		`${at}: check's refusal of the losses left`
	)
	if (expected.length > 0) {
		c.note("a loss left and refused")
	}
	if (Arr.some(d.losses, (l) => decides(l, chosen) && !leftTo(l, chosen))) {
		c.note("a loss carried by a chosen candidate")
	}
}

/** One chain of a path's versions, each traced with where its names came from, drafted and reviewed step by step:
 * (a) to (h) at every step that changes something. */
const chain = (
	c: Case<Feature>,
	steps: ReadonlyArray<TracedSchema & { readonly version: Version }>,
	choose: boolean
) => {
	let previous: Previous = fromEmpty
	let state: State = emptyState
	for (const [i, step] of steps.entries()) {
		const at = `step ${i + 1} (${choose ? "choosing the path's renames" : "keeping every candidate"})`
		const prior = steps[i - 1]
		/** (a)'s named refusal ends the chain. */
		const leaves =
			prior === undefined ? undefined : fieldsBetweenRebuiltRosters(prior.version, step.version)
		if (leaves !== undefined && leaves.size > 0) {
			refusedBetweenRosters(step.version, previous, leaves, at)
			c.note("a field moved between two rebuilt rosters refused")
			return
		}
		const d = draft(step.version, previous, `step_${i + 1}`)
		previous = d.next
		assert.equal(
			d.fingerprint,
			draft(step.version, fromEmpty, "fresh").fingerprint,
			`${at}: the snapshot a chain reaches is the fresh draft's`
		)
		if (d.change === "none") {
			c.note("a step that changes nothing")
			state = reaches(state, plainReviewOf(d), d, at)
			continue
		}
		c.note("a step drafted")
		phaseContract(d.files, at)
		if (prior === undefined) {
			state = reaches(state, plainReviewOf(d), d, at)
			continue
		}
		if (d.candidates.length > 0) {
			c.note("a draft with candidates")
		}
		if (d.confirms > 0) {
			c.note("a folder with a confirmed group")
		}
		const before = planOf(prior.version, draftingName, owner)
		const after = planOf(step.version, draftingName, owner)
		const chosen = choose
			? chosenFor(d, chosenRenames(prior, step), before, after)
			: new Set<number>()
		c.note(chosen.size > 0 ? "the path's renames chosen" : "every candidate kept")
		const value = typedValue({ plan: after, version: step.version })
		/** (b) */
		const reviewed = reviewOf(d, { chosen, losses: "written", value })
		if (Result.isFailure(reviewed)) {
			assert.ok(
				reviewed.failure.candidates.length > 1,
				`${at}: an inexpressible review chooses two candidates`
			)
			c.note("an inexpressible review")
			return
		}
		assert.deepEqual(
			checkOf(d, reviewed.success.files),
			[],
			`${at}: check refuses the reviewed folder`
		)
		lossesDecided(c, d, chosen, value, at)
		assert.equal(
			draft(step.version, d.next, "again").change,
			"none",
			`${at}: drafting the version again changes something`
		)
		state = reaches(state, reviewed.success, d, at)
	}
}

const planted = (path: RenamedDraw, note: string): Kept<RenamedDraw, Feature> => ({
	note,
	sketch: path,
	draws: "",
	reaches: ["a step drafted"]
})

const kept: ReadonlyArray<Kept<RenamedDraw, Feature>> = [
	planted(
		{ kind: "stated", path: revivedRosterRebuild },
		"M29: a roster renamed away and back, then rebuilt"
	),
	planted(
		{ kind: "stated", path: declaredRosterRebuild },
		"a roster rebuilt once its field is dropped"
	),
	planted(
		{ kind: "stated", path: hoppedRosterDeclaredAgain },
		"M40: a roster's name hopped to a relation and back"
	),
	planted(
		{ kind: "stated", path: removedUnderRenamedHandles },
		"a field dropped while its roster's handles rename"
	),
	planted({ kind: "stated", path: swappedAndRespelled }, "M39: names swapped and respelled"),
	planted(
		{ kind: "stated", path: referencedRenamedFirst },
		"M49: two relation renames referencing each other"
	),
	planted(
		{ kind: "stated", path: referencingRenamedFirst },
		"M49: the referencing relation renamed first"
	),
	planted(
		{ kind: "stated", path: keyCarriedOverRetyped },
		"M48: a key carried over a retyped field"
	),
	planted(
		{ kind: "stated", path: keyRenamedOntoPrimary },
		"a key over a field renamed onto the primary key a new reference reads"
	),
	planted(
		{ kind: "stated", path: relationOntoRemoved },
		"a relation renamed onto a dropped one's name"
	),
	planted({ kind: "stated", path: fieldOntoRemoved }, "a field renamed onto a dropped one's name"),
	planted(
		{ kind: "stated", path: renamedWithRetype },
		"M36: a field renamed with its type changed"
	),
	planted({ kind: "stated", path: statisticsOverRetyped }, "M51: statistics over a retyped field"),
	planted(
		{ kind: "stated", path: statisticsOfRenamedRelation },
		"M51: statistics of a renamed relation"
	),
	planted(
		{ kind: "stated", path: statisticsOverRenamedField },
		"M51: statistics over a renamed field"
	),
	planted(
		{ kind: "stated", path: serialUnderAliasedRelation },
		"an aliased relation's serial field: its identity sequence renamed with its table kept"
	),
	planted(
		{ kind: "stated", path: fieldBackOntoRenamedRoster },
		"a field renamed back onto its renamed roster: the field's rename chosen with the type's it requires"
	),
	planted(
		{ kind: "stated", path: referrerRetypedAway },
		"a referencing field renamed with its type changed: its foreign key dropped before the conversion"
	),
	planted(
		{ kind: "stated", path: referrerRetypedWithKey },
		"the same with the referenced key converted too: the key's conversion drops the foreign key first"
	)
]

/** The planted intents: the residual double conversion, a removed column of a rebuilt roster's type that a chosen
 * candidate converts, as a field's rename and as its relation's, each chosen (before one fate per column decided the
 * conversion at the rebuild's own step, the chosen review converted the column twice and (f) refused it); and R2's
 * swap and chain over the hazard base, chosen. */
const plantedIntent = (
	kind: "retypedOffRebuilt" | "relationRetypedOffRebuilt" | "swapRelations" | "chainRelations",
	note: string
): Kept<IntentSketch, Feature> => ({
	note,
	sketch: {
		kind: "legal",
		toB: [{ kind }],
		toC: [],
		takeDropped: false,
		choose: true,
		freshRelations: "before"
	},
	draws: "",
	reaches: [`the intent ${kind}`, "the path's renames chosen"]
})

/** The planted compositions: two chosen candidates whose alternatives each drop R1's foreign key into R0's key before
 * they convert or drop what it is over, B's intents `toB` and C's `toC`, B's dropped name taken in C as `takeDropped`
 * says, the relations' fresh names sorting as `freshRelations` says, which decides whose alternative runs first. Before
 * a later alternative's drop of a part an earlier one dropped was offered its deletion, the chosen review dropped the
 * foreign key twice, the second time by its old table's name, and (f) refused it. */
const plantedComposition = (
	toB: readonly [LegalIntent, ...Array<LegalIntent>],
	toC: ReadonlyArray<LegalIntent>,
	takeDropped: boolean,
	freshRelations: FreshRelations,
	note: string
): Kept<IntentSketch, Feature> => ({
	note,
	sketch: { kind: "legal", toB, toC, takeDropped, choose: true, freshRelations },
	draws: "",
	reaches: [
		"the path's renames chosen",
		...Arr.map([...toB, ...toC], (i): Feature => `the intent ${i.kind}`)
	]
})

const keptIntents: ReadonlyArray<Kept<IntentSketch, Feature>> = [
	plantedComposition(
		[{ kind: "retypeKey" }, { kind: "renameKeyField" }, { kind: "hop" }],
		[],
		false,
		"before",
		"R0's key renamed with its type changed while R1 takes K0's name: R1's rename drops its foreign key, then the key's would again by R1's old name"
	),
	plantedComposition(
		[{ kind: "retypeKey" }, { kind: "renameKeyField" }, { kind: "renameReferencing" }],
		[],
		false,
		"after",
		"the same with R1 renamed after R0 in the install order: the key's rename drops the foreign key, then R1's would again"
	),
	plantedComposition(
		[{ kind: "renameHandle" }],
		[{ kind: "retypeKey" }, { kind: "renameKeyField" }],
		true,
		"before",
		"both sides of the containment renamed with their types changed in C, R1's r onto the name B dropped: each field's rename drops the foreign key"
	),
	plantedComposition(
		[{ kind: "renameHandle" }],
		[{ kind: "retypeKey" }, { kind: "renameReferenced" }],
		true,
		"before",
		"R0 renamed with its key's type changed while R1's r is renamed onto the name B dropped: R0's rename drops the foreign key into the key it drops, then r's rename would again"
	),
	plantedIntent(
		"retypedOffRebuilt",
		"a removed field of a rebuilt roster's type renamed with its type changed, chosen"
	),
	plantedIntent(
		"relationRetypedOffRebuilt",
		"a relation renamed with its rebuilt roster's field retyped, chosen"
	),
	plantedIntent(
		"swapRelations",
		"two relations swapped, drafted as in-place changes with the rows under the old names"
	),
	plantedIntent(
		"chainRelations",
		"a chain whose first relation was dropped with its rows, unmarked"
	)
]

/** The ambiguous pair: A to B removes `removed` and adds two relations of its heading. The draft offers a candidate of
 * each for `removed`'s rename; `grizzle check` refuses a review choosing both (meta.json says what each renames), unless
 * the review is already inexpressible; a review choosing either alone passes check's reading and reaches B's catalog. */
const ambiguous = (c: Case<Feature>, a: Version, b: Version, removed: string): void => {
	const first = draft(a, fromEmpty, "first")
	const state = reaches(emptyState, plainReviewOf(first), first, "the ambiguous pair's A")
	const d = draft(b, first.next, "second")
	const name = `${quoteIdent(schema)}.${quoteIdent(identifierOf(identity.table(parsedName(removed))))}`
	const pair = Arr.flatMap(d.candidates, (x, n) =>
		x.kind === "relation" && x.removed === name ? [n] : []
	)
	assert.ok(
		pair.length >= 2,
		`the draft offers ${pair.length} candidates for the removed ${name}, not two`
	)
	const value = typedValue({ plan: planOf(b, draftingName, owner), version: b })
	const both = reviewOf(d, { chosen: new Set(pair), losses: "written", value })
	assert.ok(
		Result.isFailure(both) || ofKind(checkOf(d, both.success.files), "twice").length > 0,
		`two candidates for ${name} both chosen pass check`
	)
	c.note("two candidates for one removed name refused when both are chosen")
	for (const one of pair) {
		const reviewed = reviewOf(d, { chosen: new Set([one]), losses: "written", value })
		if (Result.isFailure(reviewed)) {
			assert.fail(`one candidate for ${name} chosen alone is inexpressible`)
		}
		assert.deepEqual(
			checkOf(d, reviewed.success.files),
			[],
			`one candidate for ${name} chosen alone is refused`
		)
		reaches(state, reviewed.success, d, `one candidate for ${name} chosen alone`)
		c.note("one of two candidates for one removed name chosen")
	}
}

describe("generated migration paths, drafted and reviewed with no database", () => {
	it.effect(
		"draft, review, pass check, draft again as nothing, and reach the fresh snapshot",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/drafting",
						draw: drawn(renamedDrawGen),
						literal: Formatter.format,
						features: features<Feature>([
							"a step drafted",
							"a draft with candidates",
							"every candidate kept",
							"the path's renames chosen",
							"a relation renamed in B",
							"a field renamed in B",
							"a field retyped in B",
							"a loss left and refused"
						]),
						kept,
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(drawnPath, c) =>
						Effect.sync(() => {
							const p = c.draw(resolveRenamedDraw(drawnPath))
							noteRenames(c, p)
							const a = { ...p.path.a, version: p.path.a, origins: p.origins.a }
							const b = { ...p.path.b, version: p.path.b, origins: p.origins.b }
							const k = { ...p.path.c, version: p.path.c, origins: p.origins.c }
							for (const choose of p.choose ? [true, false] : [false]) {
								chain(c, [a, b, k], choose)
								chain(c, [a, k], choose)
							}
						})
				)
			)
	)

	it.effect(
		"adversarial rename intents: legal paths draft, review and reach their catalogs; invalid ones are refused by name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/drafting-intents",
						draw: drawn(intentSketchGen),
						literal: Formatter.format,
						features: features<Feature>([
							"a step drafted",
							"the path's renames chosen",
							"a rename onto a taken name refused at the boundary",
							"two candidates for one removed name refused when both are chosen",
							"the intent retypedOffRebuilt",
							"the intent relationRetypedOffRebuilt",
							"the intent swapRelations",
							"the intent chainRelations",
							"a loss carried by a chosen candidate"
						]),
						kept: keptIntents,
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(sketch, c) =>
						Effect.sync(() => {
							const resolved = resolveIntents(sketch)
							switch (resolved.kind) {
								case "ontoTaken":
									assert.ok(
										!parseSchemaInput(resolved.version.desc).ok,
										"a relation renamed onto the name another relation keeps is admitted at the boundary"
									)
									c.note("a rename onto a taken name refused at the boundary")
									return
								case "ambiguousPair": {
									const p = c.draw(resolveRenamedDraw({ kind: "stated", path: resolved.path }))
									ambiguous(c, p.path.a, p.path.b, resolved.removed)
									return
								}
								case "legal": {
									const kinds = new Set(Arr.map(resolved.intents, (i) => i.kind))
									for (const kind of kinds) {
										c.note(`the intent ${kind}`)
									}
									if (kinds.has("rebuildRoster") && kinds.has("retypeRosterField")) {
										c.note("a roster rebuilt with its field retyped")
									}
									if (sketch.kind === "legal" && sketch.takeDropped) {
										c.note("a dropped name taken in C")
									}
									const p = c.draw(resolveRenamedDraw({ kind: "stated", path: resolved.path }))
									noteRenames(c, p)
									const a = { ...p.path.a, version: p.path.a, origins: p.origins.a }
									const b = { ...p.path.b, version: p.path.b, origins: p.origins.b }
									const k = { ...p.path.c, version: p.path.c, origins: p.origins.c }
									for (const choose of p.choose ? [true, false] : [false]) {
										chain(c, [a, b, k], choose)
										chain(c, [a, k], choose)
									}
									return
								}
							}
						})
				)
			)
	)
})

/** The headings a relation may hold, pairwise different, each keyed by its first field: three a relation of A holds,
 * the first with a field `c` a removal takes off (its own heading then, `trimmed`), and one only an added relation
 * holds. Every field is an integer of one of two widths. */
type Heading = "h0" | "trimmed" | "h1" | "h2" | "h3"
const fieldsOf: { readonly [H in Heading]: ReadonlyArray<string> } = {
	h0: ["id", "a", "c"],
	trimmed: ["id", "a"],
	h1: ["key", "b"],
	h2: ["code", "d", "e"],
	h3: ["tag", "f", "g", "h"]
}

/** A relation of `heading` under `name`, built by the public builders. */
const relationOf = (name: string, heading: Heading) => {
	switch (heading) {
		case "h0":
			return relation(name, { id: pg.integer, a: pg.bigint, c: pg.integer }, ["id"])
		case "trimmed":
			return relation(name, { id: pg.integer, a: pg.bigint }, ["id"])
		case "h1":
			return relation(name, { key: pg.bigint, b: pg.integer }, ["key"])
		case "h2":
			return relation(name, { code: pg.integer, d: pg.bigint, e: pg.bigint }, ["code"])
		case "h3":
			return relation(name, { tag: pg.bigint, f: pg.integer, g: pg.integer, h: pg.integer }, [
				"tag"
			])
	}
}

/** A relation of a version: its name, its heading, and the relation of A it is (its origin, an index into A), none for
 * one B adds. */
type Rel = { readonly name: string; readonly heading: Heading } & (
	| { readonly kind: "of"; readonly origin: number }
	| { readonly kind: "added" }
)

/** A's relations: the first `count` of three, each its own heading. */
const relationsA: ReadonlyArray<Rel> = [
	{ name: "Alpha", heading: "h0", kind: "of", origin: 0 },
	{ name: "Beta", heading: "h1", kind: "of", origin: 1 },
	{ name: "Gamma", heading: "h2", kind: "of", origin: 2 }
]
const freshNames: ReadonlyArray<string> = ["Delta", "Epsilon", "Zeta", "Eta"]

/** What B does to A, each relation of A taking part in one intent at most: a relation renamed to a fresh name; two
 * exchanging names; a chain, the first taking the second's name while the second is renamed fresh; a relation removed;
 * `c` removed from the relation of heading h0; a relation added. */
type Intent =
	| { readonly kind: "rename" | "remove"; readonly of: number }
	| { readonly kind: "swap" | "chain"; readonly of: number; readonly with: number }
	| { readonly kind: "removeField" }
	| { readonly kind: "add" }

/** A drawn case: A's relation count, B's intents, each relation of A's rows by drawn values, and the named
 * indistinguishable case, two relations of one heading swapped. */
type IdentityCase =
	| {
			readonly kind: "intents"
			readonly count: 2 | 3
			readonly intents: ReadonlyArray<Intent>
			readonly rows: readonly [ReadonlyArray<bigint>, ReadonlyArray<bigint>, ReadonlyArray<bigint>]
	  }
	| { readonly kind: "sameHeadingSwap" }

/** B's relations, the intents applied in turn. An intent on a relation an earlier one took part in, or on one A does not
 * hold, does nothing: the case's own reading, never drawn into another meaning. */
const relationsOfB = (
	a: ReadonlyArray<Rel>,
	intents: ReadonlyArray<Intent>
): ReadonlyArray<Rel> => {
	let b = [...a]
	const touched = new Set<number>()
	let used = 0
	const nextFresh = (): string => defined(freshNames[used++], "a fresh name for each intent")
	const at = (origin: number) =>
		Arr.findFirstIndex(b, (r) => r.kind === "of" && r.origin === origin)
	for (const intent of intents) {
		switch (intent.kind) {
			case "rename":
			case "remove": {
				const i = at(intent.of)
				if (Option.isNone(i) || touched.has(intent.of)) {
					continue
				}
				touched.add(intent.of)
				const renamed = nextFresh()
				b =
					intent.kind === "remove"
						? Arr.remove(b, i.value)
						: Arr.map(b, (r, n) => (n === i.value ? { ...r, name: renamed } : r))
				continue
			}
			case "swap":
			case "chain": {
				const i = at(intent.of)
				const j = at(intent.with)
				if (
					Option.isNone(i) ||
					Option.isNone(j) ||
					i.value === j.value ||
					touched.has(intent.of) ||
					touched.has(intent.with)
				) {
					continue
				}
				touched.add(intent.of)
				touched.add(intent.with)
				const ni = defined(b[i.value], "the first relation").name
				const nj = defined(b[j.value], "the second relation").name
				const away = intent.kind === "chain" ? nextFresh() : ni
				b = Arr.map(b, (r, n) =>
					n === i.value ? { ...r, name: nj } : n === j.value ? { ...r, name: away } : r
				)
				continue
			}
			case "removeField": {
				const i = Arr.findFirstIndex(
					b,
					(r) => r.heading === "h0" && r.kind === "of" && !touched.has(r.origin)
				)
				if (Option.isNone(i)) {
					continue
				}
				const r = b[i.value]
				if (r?.kind !== "of") {
					continue
				}
				touched.add(r.origin)
				b = Arr.map(b, (x, n) => (n === i.value ? { ...x, heading: "trimmed" } : x))
				continue
			}
			case "add":
				if (Arr.some(b, (r) => r.heading === "h3")) {
					continue
				}
				b = [...b, { name: nextFresh(), heading: "h3", kind: "added" }]
				continue
		}
	}
	return b
}

/** The schema value of a version's relations. */
const schemaValue = (rels: ReadonlyArray<Rel>) =>
	schemaOf(
		"Ident",
		Record.fromEntries(Arr.map(rels, (r) => [r.name, relationOf(r.name, r.heading)] as const)),
		[]
	)

/** The schema identity the identities suite drafts under, and its PostgreSQL schema. */
const identities = identity.schema(parsedSchemaName("gz_identities"))
const identSchema: string = identifierOf(identities)
/** A relation's table as meta.json names it, schema-qualified and quoted; and set aside, under the name the naming
 * door sets the table aside under (identity.aside). */
const tableIdent = (name: string): string => identifierOf(identity.table(parsedName(name)))
const table = (name: string): string => `${quoteIdent(identSchema)}.${quoteIdent(tableIdent(name))}`
const asideTable = (name: string): string =>
	`${quoteIdent(identSchema)}.${quoteIdent(identifierOf(identity.aside(tableIdent(name))))}`

/** Whether a relation of A is set aside going to B: B keeps its name
 * with another heading, while a relation of B, added or changed, has the heading it held. */
const movedTo = (a: ReadonlyArray<Rel>, b: ReadonlyArray<Rel>, r: Rel): boolean => {
	const named = (rels: ReadonlyArray<Rel>, name: string) =>
		Arr.findFirst(rels, (x) => x.name === name)
	const now = named(b, r.name)
	const open = Arr.filter(
		b,
		(x) => !Option.exists(named(a, x.name), (was) => was.heading === x.heading)
	)
	return (
		Option.exists(now, (n) => n.heading !== r.heading) &&
		Arr.some(open, (o) => o.name !== r.name && o.heading === r.heading)
	)
}

/** The losses the documented rules give a step from `a` to `b`, as `<kind> <what>`: each relation of A whose name B no
 * longer has; each set aside, under its aside name; and `c` of a kept relation that lost it. */
const expectedLosses = (a: ReadonlyArray<Rel>, b: ReadonlyArray<Rel>): ReadonlyArray<string> =>
	Arr.flatMap(a, (r) => {
		const now = Arr.findFirst(b, (x) => x.name === r.name)
		if (Option.isNone(now)) {
			return [`relation ${table(r.name)}`]
		}
		if (movedTo(a, b, r)) {
			return [`relation ${asideTable(r.name)}`]
		}
		return r.heading === "h0" && now.value.heading === "trimmed"
			? [`field ${table(r.name)}.${quoteIdent("c")}`]
			: []
	})

/** A loss as the comparison reads it. */
const lossText = (l: DraftedLoss): string => {
	switch (l.loses.kind) {
		case "relation":
			return `relation ${l.loses.relation}`
		case "field":
			return `field ${l.loses.relation}.${l.loses.field}`
		case "schema":
			return `schema ${l.loses.schema}`
	}
}

/** The rows a relation of heading `h` is loaded with: one per drawn value, keyed by its position, every other field the
 * value plus its position among the fields. */
const rowsFor = (
	h: Heading,
	values: ReadonlyArray<bigint>
): ReadonlyArray<ReadonlyMap<string, bigint>> =>
	Arr.map(
		values,
		(v, n) =>
			new Map(
				Arr.map(
					fieldsOf[h],
					(field, i) => [field, i === 0 ? BigInt(n + 1) : v + BigInt(i)] as const
				)
			)
	)

/** Rows as integerRows prints them, projected to heading `h`'s fields. */
const printed = (
	rows: ReadonlyArray<ReadonlyMap<string, bigint>>,
	h: Heading
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (row) =>
			Arr.join(
				Arr.map(
					Arr.sort([...fieldsOf[h]], Order.String),
					(field) => `${field}=${String(row.get(field))}`
				),
				","
			)
		),
		Order.String
	)

type IdentityFeature =
	| "an intent rename"
	| "an intent swap"
	| "an intent chain"
	| "an intent remove"
	| "an intent removeField"
	| "an intent add"
	| "a relation set aside"
	| "a loss carried"
	| "a loss decided both ways refused"
	| "two relations of one heading swapped"

const origin = int(0, 2)
const intentGen: Gen<Intent> = oneOf<Intent>([
	(source) => ({
		kind: source.draw(element(["rename", "remove"] as const)),
		of: source.draw(origin)
	}),
	(source) => ({
		kind: source.draw(element(["swap", "chain"] as const)),
		of: source.draw(origin),
		with: source.draw(origin)
	}),
	constant({ kind: "removeField" }),
	constant({ kind: "add" })
])
const valuesGen = array(bigint(-9n, 9n), { min: 0, max: 2 })
const identityGen: Gen<IdentityCase> = weighted<IdentityCase>([
	[
		9,
		(source) => ({
			kind: "intents",
			count: source.draw(element([2, 3] as const)),
			intents: source.draw(array(intentGen, { min: 1, max: 3 })),
			rows: [source.draw(valuesGen), source.draw(valuesGen), source.draw(valuesGen)]
		})
	],
	[1, constant({ kind: "sameHeadingSwap" })]
])

/** The planted swap and chain of the review that found them, every relation holding a row. */
const plantedIdentity = (
	intent: Intent,
	note: string,
	reaches: IdentityFeature
): Kept<IdentityCase, IdentityFeature> => ({
	note,
	sketch: { kind: "intents", count: 2, intents: [intent], rows: [[1n], [2n], [3n]] },
	draws: "",
	reaches: [reaches, "a relation set aside"]
})

const keptIdentities: ReadonlyArray<Kept<IdentityCase, IdentityFeature>> = [
	plantedIdentity(
		{ kind: "swap", of: 0, with: 1 },
		"a swap drafted as in-place changes",
		"an intent swap"
	),
	plantedIdentity(
		{ kind: "chain", of: 0, with: 1 },
		"a chain dropping its first relation unmarked",
		"an intent chain"
	)
]

/** The candidates of a step from A to B a reviewer making the intents' renames chooses: for each relation of B that is
 * a relation of A under another table, the candidate from that one's table, or its aside name when set aside. */
const intentCandidates = (
	d: Drafted,
	a: ReadonlyArray<Rel>,
	b: ReadonlyArray<Rel>,
	at: string
): ReadonlySet<number> =>
	new Set(
		Arr.flatMap(b, (r) => {
			if (r.kind === "added") {
				return []
			}
			const was = defined(a[r.origin], `the relation of A of origin ${r.origin}`)
			const source = movedTo(a, b, was) ? asideTable(was.name) : table(was.name)
			if (source === table(r.name)) {
				return []
			}
			const n = Arr.findFirstIndex(
				d.candidates,
				(x) => x.kind === "relation" && x.removed === source && x.added === table(r.name)
			)
			assert.ok(
				Option.isSome(n),
				`${at}: the draft offers no candidate for the rename of ${source} to ${table(r.name)}`
			)
			return [n.value]
		})
	)

describe("losses of stored data, and the identities of swaps and chains", () => {
	it.effect(
		"every loss is a decision check refuses until made; every rename, swap and chain carries its rows when chosen",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/identities",
						draw: drawn(identityGen),
						literal: Formatter.format,
						features: features<IdentityFeature>([
							"an intent rename",
							"an intent swap",
							"an intent chain",
							"an intent remove",
							"an intent removeField",
							"a relation set aside",
							"a loss carried",
							"a loss decided both ways refused",
							"two relations of one heading swapped"
						]),
						kept: keptIdentities,
						runs: 80,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(x, c) =>
						Effect.sync(() => {
							if (x.kind === "sameHeadingSwap") {
								c.note("two relations of one heading swapped")
								const same = (first: string, second: string) =>
									schemaOf(
										"Ident",
										{ [first]: relationOf(first, "h0"), [second]: relationOf(second, "h0") },
										[]
									)
								const before = draftOf(same("Alpha", "Beta"), [], identities, fromEmpty, "a")
								assert.equal(
									draftOf(same("Beta", "Alpha"), [], identities, before.next, "b").change,
									"none",
									"two relations of one heading swapped draft a change"
								)
								return
							}
							const a = relationsA.slice(0, x.count)
							const b = relationsOfB(a, x.intents)
							for (const i of x.intents) {
								c.note(`an intent ${i.kind}`)
							}
							const dA = draftOf(schemaValue(a), [], identities, fromEmpty, "a")
							const dB = draftOf(schemaValue(b), [], identities, dA.next, "b")
							const expected = expectedLosses(a, b)
							if (Arr.some(a, (r) => movedTo(a, b, r))) {
								c.note("a relation set aside")
							}
							const at = `A ${Formatter.format(a)} to B ${Formatter.format(b)}`
							assert.deepEqual(
								Arr.sort(
									Arr.map(
										Arr.filter(dB.losses, (l) => l.within.kind === "top"),
										lossText
									),
									Order.String
								),
								Arr.sort([...expected], Order.String),
								`${at}: the losses drafted`
							)
							/** Left undecided, check refuses exactly the losses. */
							const value = () => "0"
							const left = reviewOf(dB, { chosen: new Set(), losses: "left", value })
							if (Result.isFailure(left)) {
								return assert.fail(`${at}: keeping every candidate is inexpressible`)
							}
							assert.deepEqual(
								Arr.map(checkOf(dB, left.success.files), (finding) => finding.kind),
								Arr.map(expected, (): Finding["kind"] => "unresolved loss"),
								`${at}: check's refusal of the losses left`
							)
							/** A's rows, and each review run from them to B's catalog installed from nothing. */
							const freshA = freshStateOf(identSchema, dA)
							if (Result.isFailure(freshA)) {
								return assert.fail(`${at}: A installed from nothing fails`)
							}
							const freshB = freshStateOf(identSchema, dB)
							if (Result.isFailure(freshB)) {
								return assert.fail(`${at}: B installed from nothing fails`)
							}
							const rowsOfA = (r: Rel & { readonly kind: "of" }) =>
								rowsFor(r.heading, defined(x.rows[r.origin], `the rows of origin ${r.origin}`))
							const start = Arr.reduce(a, freshA.success, (s, r) =>
								r.kind === "of" ? loadIntegers(s, tableIdent(r.name), rowsOfA(r)) : s
							)
							const run = (reviewed: ReviewedFolder, how: string): State => {
								const ran = reviewed.run(identSchema, start, noRowValue)
								if (Result.isFailure(ran)) {
									return assert.fail(
										`${at}, ${how}: ${ran.failure.file} action ${ran.failure.action}: ${ran.failure.reason}`
									)
								}
								assert.deepEqual(
									catalogOf(ran.success),
									catalogOf(freshB.success),
									`${at}, ${how}: the catalog`
								)
								return ran.success
							}
							/** Every candidate kept, every loss written in: a relation keeps its rows only under its own name, unmoved,
							 * a removed field's values gone; every other relation is empty. */
							const keptReview = reviewOf(dB, { chosen: new Set(), losses: "written", value })
							if (Result.isFailure(keptReview)) {
								return assert.fail(`${at}: keeping every candidate is inexpressible`)
							}
							assert.deepEqual(
								checkOf(dB, keptReview.success.files),
								[],
								`${at}: check refuses the kept review`
							)
							const keptState = run(keptReview.success, "every candidate kept")
							for (const r of b) {
								const was = Arr.findFirst(a, (w) => w.name === r.name)
								assert.deepEqual(
									integerRows(keptState, tableIdent(r.name)),
									Option.isNone(was) || was.value.kind !== "of" || movedTo(a, b, was.value)
										? []
										: printed(rowsOfA(was.value), r.heading),
									`${at}, every candidate kept: the rows of ${r.name}`
								)
							}
							/** The intents' renames chosen: each relation of B holds the rows of the relation of A it is. */
							const chosen = intentCandidates(dB, a, b, at)
							const chosenReview = reviewOf(dB, { chosen, losses: "written", value })
							if (Result.isFailure(chosenReview)) {
								return assert.fail(`${at}: the intents' renames are inexpressible`)
							}
							assert.deepEqual(
								checkOf(dB, chosenReview.success.files),
								[],
								`${at}: check refuses the chosen review`
							)
							const chosenState = run(chosenReview.success, "the intents' renames chosen")
							for (const r of b) {
								const was = r.kind === "of" ? a[r.origin] : undefined
								assert.deepEqual(
									integerRows(chosenState, tableIdent(r.name)),
									was?.kind !== "of" ? [] : printed(rowsOfA(was), r.heading),
									`${at}, the intents' renames chosen: the rows of ${r.name}`
								)
							}
							/** A loss its chosen carrier leaves out, written in as well: decided both ways. */
							const carried = Arr.findFirst(
								dB.losses,
								(l) => l.within.kind === "top" && Arr.some(l.carriers, (k) => chosen.has(k))
							)
							if (Option.isNone(carried)) {
								return
							}
							c.note("a loss carried")
							const both = Arr.map(chosenReview.success.files, (file) =>
								file.name === carried.value.file
									? { name: file.name, text: `${file.text}\n${carried.value.statement};\n` }
									: file
							)
							assert.ok(
								ofKind(checkOf(dB, both), "split").length > 0,
								`${at}: a loss written in while its carrier is chosen passes check`
							)
							c.note("a loss decided both ways refused")
						})
				)
			)
	)
})

/** How B's key over R0's fields S becomes C's: the
 * candidate key promoted to the primary key; the primary key moved to `id` while a candidate key takes S; the key
 * declared again over S in the other order; or a field of S renamed while the primary key, or a candidate key over S in
 * the other order, takes S under the new name, the rename a candidate the reviewer may choose or keep. */
type Shift = "promoted" | "demoted" | "reordered" | "renamedOntoPrimary" | "renamedOntoKey"
/** What references S from another relation: nothing; R1, in both versions; R1 in B only; R1 in C only; or R1 in B and P1,
 * of R1's heading, in C, a relation rename the reviewer may choose or keep. */
type Reference = "none" | "kept" | "removed" | "added" | "renamedRelation"
/** S: R0's field x, or x and y. */
type KeySize = 1 | 2

const replacedFeatures = [
	"the shift promoted",
	"the shift demoted",
	"the shift reordered",
	"the shift renamedOntoPrimary",
	"the shift renamedOntoKey",
	"the reference none",
	"the reference kept",
	"the reference removed",
	"the reference added",
	"the reference renamedRelation",
	"a review choosing a candidate",
	"a review keeping every candidate"
] as const
type ReplacedFeature = (typeof replacedFeatures)[number]

/** The schema identity the replaced-key suite drafts under, and its PostgreSQL schema. */
const replaced = identity.schema(parsedSchemaName("gz_replaced"))
const replacedSchema: string = identifierOf(replaced)

/** The two versions of a case: R0 (id, x, y) keyed as the shift says, x renamed to u in C when the shift renames, and the
 * relation referencing S, R1 or P1 (id, a, b), as the reference says. */
const replacedVersions = (
	shift: Shift,
	size: KeySize,
	reference: Reference
): readonly [SchemaDesc, SchemaDesc] => {
	const renames = shift === "renamedOntoPrimary" || shift === "renamedOntoKey"
	const keyOf = (renamed: boolean): Arr.NonEmptyReadonlyArray<string> => {
		const x = renamed ? "u" : "x"
		return size === 1 ? [x] : [x, "y"]
	}
	const r0 = (renamed: boolean, primaryKey: ReadonlyArray<string>) =>
		fixtureRelation(
			"R0",
			{ id: f.integer, [renamed ? "u" : "x"]: f.integer, y: f.bigint },
			primaryKey
		)
	const referrer = (name: string) =>
		fixtureRelation(name, { id: f.integer, a: f.integer, b: f.bigint }, ["id"])
	const referencing = (name: string, renamed: boolean) =>
		contained(on(name, size === 1 ? ["a"] : ["a", "b"]), on("R0", keyOf(renamed)))
	const version = (side: "b" | "c"): SchemaDesc => {
		const renamed = side === "c" && renames
		const s = keyOf(renamed)
		const keyed: {
			readonly primaryKey: ReadonlyArray<string>
			readonly keys: ReadonlyArray<AuthoredStatementDesc>
		} =
			side === "b"
				? shift === "demoted"
					? { primaryKey: s, keys: [] }
					: { primaryKey: ["id"], keys: [key("R0", s)] }
				: shift === "promoted" || shift === "renamedOntoPrimary"
					? { primaryKey: s, keys: [] }
					: shift === "demoted"
						? { primaryKey: ["id"], keys: [key("R0", s)] }
						: { primaryKey: ["id"], keys: [key("R0", Arr.reverse(s))] }
		const referrerName = side === "c" && reference === "renamedRelation" ? "P1" : "R1"
		const references =
			reference === "none" ||
			(side === "b" && reference === "added") ||
			(side === "c" && reference === "removed")
				? []
				: [referencing(referrerName, renamed)]
		return {
			name: "Replaced",
			relations: [r0(renamed, keyed.primaryKey), referrer(referrerName)],
			statements: [...keyed.keys, ...references],
			extends: undefined
		}
	}
	return [version("b"), version("c")]
}

/** Every subset of `n` candidates, by index. */
const candidateSubsets = (n: number): ReadonlyArray<ReadonlySet<number>> =>
	Arr.map(
		indices(2 ** n),
		(mask) => new Set(Arr.filter(indices(n), (i) => ((mask >> i) & 1) === 1))
	)

describe("keys replaced over the same fields, whichever way the reviewer decides the renames", () => {
	it.effect(
		"every choice of the candidates passes check, runs from B's catalog and reaches C's installed from nothing",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/replaced-keys",
						generator: (source) =>
							[
								source.draw(
									element<Shift>([
										"promoted",
										"demoted",
										"reordered",
										"renamedOntoPrimary",
										"renamedOntoKey"
									])
								),
								source.draw(element<KeySize>([1, 2])),
								source.draw(
									element<Reference>(["none", "kept", "removed", "added", "renamedRelation"])
								)
							] as const,
						literal: Formatter.format,
						limit: 100,
						features: features<ReplacedFeature>([...replacedFeatures]),
						caseHang: Duration.minutes(2)
					},
					([shift, size, reference], c) =>
						Effect.sync(() => {
							c.note(`the shift ${shift}`)
							c.note(`the reference ${reference}`)
							const [b, k] = replacedVersions(shift, size, reference)
							const dB = draftOf(b, [], replaced, fromEmpty, "b")
							const fromB = plainReviewOf(dB).run(replacedSchema, emptyState, noRowValue)
							if (Result.isFailure(fromB)) {
								return assert.fail(`B fails: ${fromB.failure.reason}`)
							}
							const dC = draftOf(k, [], replaced, dB.next, "c")
							const fresh = freshStateOf(replacedSchema, dC)
							if (Result.isFailure(fresh)) {
								return assert.fail(`C installed from nothing fails: ${fresh.failure.reason}`)
							}
							for (const chosen of candidateSubsets(dC.candidates.length)) {
								const at = `${shift}, S of ${size}, the reference ${reference}, choosing [${Arr.join(
									Arr.map([...chosen], (k) => String(k)),
									", "
								)}]`
								const reviewed = reviewOf(dC, { chosen, losses: "written", value: () => "0" })
								if (Result.isFailure(reviewed)) {
									return assert.fail(`${at}: the review is inexpressible`)
								}
								assert.deepEqual(
									checkOf(dC, reviewed.success.files),
									[],
									`${at}: check refuses the review`
								)
								c.note(
									chosen.size > 0
										? "a review choosing a candidate"
										: "a review keeping every candidate"
								)
								const ran = reviewed.success.run(replacedSchema, fromB.success, noRowValue)
								if (Result.isFailure(ran)) {
									return assert.fail(
										`${at}: ${ran.failure.file}, action ${ran.failure.action}: ${ran.failure.reason}`
									)
								}
								assert.deepEqual(
									catalogOf(ran.success),
									catalogOf(fresh.success),
									`${at}: the catalog reached`
								)
							}
						})
				)
			)
	)
})
