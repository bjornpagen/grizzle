import { Array as Arr, Option, pipe, Record as Rec, Result, Schema, String as Str } from "effect"
import { decodeMeta, readMeta } from "#adapter/boundary/meta.ts"
import {
	type Action,
	type Candidate,
	type CandidatePath,
	candidateLabel,
	candidatesOf,
	type Choice,
	type Confirm,
	type Draft,
	type EndsPath,
	headOf,
	type LossDecision,
	type MigrationPlan,
	type Offer,
	pathOf,
	type RelationStep,
	samePath
} from "#compiler/deploy/diff/plan.ts"
import { type DraftFile, planFiles } from "#compiler/deploy/phases/files.ts"
import {
	chosenIn,
	type LossDecided,
	lossDecisions,
	type SplitRename,
	splitRenames
} from "#compiler/deploy/render/chosen.ts"
import {
	type MetaNestedRename,
	type MetaPlainOffer,
	type MetaRelationStep,
	type MetaSealedStep,
	type MetaStep,
	type MetaTopOffer,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	fromFirstToken,
	isNoTransaction,
	lossMarker,
	placeholderMarker,
	renameMarker,
	splitStatements
} from "#compiler/deploy/render/markers.ts"
import { offerInstruction, renderFile } from "#compiler/deploy/render/sql.ts"
import type { ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { placeholderToken, printStatement } from "#compiler/sql/print.ts"
import { whereIndex } from "#test/support/oracle/pick.ts"

/** A drafted action that needs a value from the reviewer.
 *
 * The reviewer of a drafted migration folder: the one implementation of what a person does with grizzle generate's
 * draft, for every test that reviews a folder before checking or applying it.
 *
 * Rule: a review decides each candidate rename once, chosen or kept, decides each loss of stored data that no chosen
 * candidate carries, its statement written in or left commented, and gives every placeholder a value. It is done twice,
 * and the two must spell the same statements (`renderReviewed` prints the first for the comparison):
 *
 * - On the plan (`reviewPlan`): each drafted choice becomes its kept action, or what the chosen offer says (a rename's
 *   alternative, a rewrite's statements, nothing for a delete), followed by what the kept action renders after the
 *   statement it decides: a placeholder column's DROP DEFAULT, which a chosen rename leaves in place. This is the
 *   reviewed migration as the draft means it.
 * - On the files' text (`review`), exactly as the markers instruct a person: each file's marked steps, in the draft's
 *   order (a choice, a loss, a confirmed group), are met one by one in the text, each in its place, a chosen rename's
 *   own marked steps met in its uncommented alternative in turn. Above each statement a choice decides, the file holds
 *   one marker block per offer, in the choice's order: the marker, its instruction line and the commented alternative.
 *   Each block's marker and instruction lines go, and its commented alternative stays as a comment. Kept, the statement
 *   stays; chosen, the chosen offer's alternative is uncommented in place and the statement goes, or, for a delete, the
 *   statement just goes. A confirm marker (a closed handle renamed in place) is confirmed: its two lines go. A loss
 *   carried by a chosen candidate goes whole, its two marker lines and its commented statement; one written in loses
 *   its two lines and its statement is uncommented; one left keeps its lines, so `grizzle check` refuses it as
 *   unresolved. Each is decided as its own step says, never looked up by its text. Then each placeholder marker line
 *   goes and the token below it takes the value of the placeholder, the placeholders of the SQL being met in the plan's
 *   order; a token in a commented alternative stays as it is.
 *
 * A statement two chosen candidates decide in different ways has no form for both, since each offer applies one
 * candidate's renames: the review is inexpressible, a defect of the draft (every candidate must be decidable on its
 * own), and is returned as such, never resolved by guessing one of them. Two that decide it the same way, each
 * deleting it or each replacing it with the same statements, are one decision. A text that disagrees with meta.json or with the plan is
 * a defect of the draft too, thrown as DraftTextDefect.
 *
 * A review can also be written split (`reviewWritten`): one marked statement written the other way than the decisions
 * decide it, as a person who decided a candidate at one statement and not at another writes the folder. Its text is
 * the split one, its placeholders those of the statements it writes; its plan stays the decided one. */
export type Placeholder = Extract<
	Action,
	{
		readonly kind:
			| "placeholderColumn"
			| "placeholderDefault"
			| "placeholderRetype"
			| "placeholderHandles"
	}
>

/** How a review decides each loss of stored data no chosen candidate carries: its statement written in, so the data is
 * lost, or left commented, so the loss stays unresolved. */
export type LossReview = "written" | "left"

/** What a review decides: the candidates it chooses, the plan's own records (every other one is kept), how it decides
 * each loss no chosen candidate carries, and the SQL text it writes for each placeholder. */
export interface Decisions {
	readonly chosen: ReadonlySet<Candidate>
	readonly losses: LossReview
	readonly value: (placeholder: Placeholder) => string
}

/** What a review writes for a loss: nothing when a chosen candidate carries its data or the review leaves it, else its
 * statement. */
const lossWritten = (
	loss: LossDecision,
	chosen: ReadonlySet<Candidate>,
	losses: LossReview
): ReadonlyArray<Action> =>
	Arr.some(loss.carriers, (c) => chosen.has(c)) || losses === "left"
		? []
		: [{ kind: "statement", statement: loss.statement }]

/** One file of the reviewed plan: the drafted file and its reviewed actions. */
export interface ReviewedFile {
	readonly draft: DraftFile
	readonly actions: ReadonlyArray<Action>
}

/** The review of one statement that two or more chosen candidates decide. */
interface Inexpressible {
	readonly kind: "inexpressible"
	readonly file: string
	readonly candidates: ReadonlyArray<Candidate>
}

/** The defect of a draft whose text the reviewer cannot follow: the text, meta.json and the plan disagree. */
class DraftTextDefect extends Schema.TaggedError<
	DraftTextDefect,
	{ readonly brand: unique symbol }
>()("DraftTextDefect", { defect: Schema.String }) {}

const isPlaceholder = (a: Action): a is Placeholder =>
	a.kind === "placeholderColumn" ||
	a.kind === "placeholderRetype" ||
	a.kind === "placeholderHandles"

/** What an offer replaces the statement it decides with: its actions, a rename's head first, and the choices nested in
 * a rename's alternative. */
const offerSteps = (offer: Offer): ReadonlyArray<RelationStep> => {
	switch (offer.kind) {
		case "rename":
		case "relation rename":
		case "nested rename":
			return [{ kind: "statement", statement: headOf(offer.candidate) }, ...offer.alternative]
		case "rewrite":
			return Arr.map(offer.statements, (statement): Action => ({ kind: "statement", statement }))
		case "delete":
			return []
		case "convert":
			return [offer.conversion]
	}
}

/** Every action an offer may write: its own, and every action of the choices and losses nested in it, kept or offered. */
const offerActions = (offer: Offer): ReadonlyArray<Action> =>
	Arr.flatMap(offerSteps(offer), (s) =>
		s.kind === "choice" || s.kind === "loss" ? draftActions(s) : [s]
	)

/** Every action a draft holds, the kept and the offered ones alike, a loss's statement among them. */
export const draftActions = (d: Draft | RelationStep): ReadonlyArray<Action> => {
	switch (d.kind) {
		case "choice":
			return [d.keep, ...Arr.flatMap(d.offers, (o: Offer) => offerActions(o))]
		case "confirm":
			return Arr.map(d.keep, (statement): Action => ({ kind: "statement", statement }))
		case "loss":
			return [{ kind: "statement", statement: d.statement }]
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "placeholderHandles":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return [d]
	}
}

/** Every action a plan drafts, the kept and the offered ones alike. */
const planActions = (plan: MigrationPlan): ReadonlyArray<Action> =>
	Arr.flatMap(plan.steps, (step) => draftActions(step.draft))

/** Every statement a plan drafts, the kept and the offered ones alike. */
export const planStatements = (plan: MigrationPlan): ReadonlyArray<SqlStatement> =>
	Arr.flatMap(planActions(plan), (a) => (a.kind === "statement" ? [a.statement] : []))

/** What a kept action renders after the statement a choice decides, which stays whichever way the choice goes: a
 * placeholder column's DROP DEFAULT. */
const afterDecided = (keep: Action): ReadonlyArray<Action> =>
	keep.kind === "placeholderColumn"
		? [
				{
					kind: "statement",
					statement: {
						kind: "alterTable",
						table: keep.table,
						actions: [{ kind: "dropDefault", column: keep.column.name }]
					}
				}
			]
		: []

/** What a review writes at a statement a choice decides: the offers it takes, by their place among the choice's offers;
 * none keeps the statement. Both the plan and the text of a review read the one pick, so they decide every statement
 * alike. */
type Pick = (choice: Choice<Offer>) => ReadonlyArray<number>

/** Each statement decided by the chosen candidates: the offers of the chosen ones taken. */
const decidedPick =
	(chosen: ReadonlySet<Candidate>): Pick =>
	(choice) =>
		Arr.flatMap(choice.offers, (o, n) => (chosen.has(o.candidate) ? [n] : []))

/** Whether two statement lists are one text, statement by statement. */
const sameText = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (x, i) => x === b[i])

/** Whether two chosen offers decide a statement the same way: each deletes it, or each replaces it with the same
 * statements. Two renames' alternatives never do. */
const sameDecision = (a: Offer, b: Offer): boolean =>
	(a.kind === "delete" && b.kind === "delete") ||
	(a.kind === "rewrite" &&
		b.kind === "rewrite" &&
		sameText(Arr.map(a.statements, printStatement), Arr.map(b.statements, printStatement)))

/** How a review decides what no pick decides: the candidates it chooses, which carry the losses they carry, and the
 * losses no chosen candidate carries. */
interface LossPolicy {
	readonly chosen: ReadonlySet<Candidate>
	readonly losses: LossReview
}

/** A choice as `pick` decides it, and the choices nested in the offer it takes as `pick` decides them, the losses in it
 * as `policy` decides them. */
const reviewChoice = (
	file: string,
	draft: Choice<Offer>,
	pick: Pick,
	policy: LossPolicy
): Result.Result<ReadonlyArray<Action>, Inexpressible> => {
	const picked = pick(draft)
	const [offer, ...more] = whereIndex(draft.offers, (n) => picked.includes(n))
	if (offer === undefined) {
		return Result.succeed([draft.keep])
	}
	if (Arr.some(more, (o) => !sameDecision(o, offer))) {
		return Result.fail({
			kind: "inexpressible",
			file,
			candidates: Arr.map([offer, ...more], (o) => o.candidate)
		})
	}
	const actions: Array<ReadonlyArray<Action>> = []
	for (const step of offerSteps(offer)) {
		if (step.kind === "loss") {
			actions.push(lossWritten(step, policy.chosen, policy.losses))
			continue
		}
		if (step.kind !== "choice") {
			actions.push([step])
			continue
		}
		const nested = reviewChoice(file, step, pick, policy)
		if (Result.isFailure(nested)) {
			return nested
		}
		actions.push(nested.success)
	}
	return Result.succeed([...Arr.flatten(actions), ...afterDecided(draft.keep)])
}

/** The drafted files of a generated folder, in the folder's order: none when nothing changed. */
export const draftFiles = (g: GenerateResult): ReadonlyArray<DraftFile> =>
	g.change === "none" ? [] : planFiles(g.plan)

/** The one drafted file that runs a folder's validation statements, the refined constants' casts to their domains: the
 * file whose drafts hold every statement of the target snapshot's validation object, each as it prints. */
export const validationFile = (g: GenerateResult): DraftFile => {
	const [object, ...others] = Arr.filter(
		g.snapshot.manifest.objects,
		(o) => o.kind === "validation"
	)
	if (object === undefined || others.length > 0) {
		throw new Error(`the snapshot of ${g.folder.name} holds one validation`)
	}
	const holding = Arr.filter(draftFiles(g), (f) => {
		const printed = new Set(
			Arr.flatMap(f.drafts, (d) => (d.kind === "statement" ? [printStatement(d.statement)] : []))
		)
		return Arr.every(object.ddl, (v) => printed.has(printStatement(v)))
	})
	const [only, ...more] = holding
	if (only === undefined || more.length > 0) {
		throw new Error(`${g.folder.name} drafts its validation in ${holding.length} files`)
	}
	return only
}

/** The plan of a generated folder reviewed as `pick` writes each statement a choice decides and `policy` each loss, file
 * by file. */
const reviewFiles = (
	g: GenerateResult,
	pick: Pick,
	policy: LossPolicy
): Result.Result<ReadonlyArray<ReviewedFile>, Inexpressible> => {
	const out: Array<ReviewedFile> = []
	for (const draft of draftFiles(g)) {
		const actions: Array<Action> = []
		for (const d of draft.drafts) {
			switch (d.kind) {
				case "choice": {
					const reviewed = reviewChoice(draft.name, d, pick, policy)
					if (Result.isFailure(reviewed)) {
						return Result.fail(reviewed.failure)
					}
					for (const a of reviewed.success) {
						actions.push(a)
					}
					break
				}
				case "confirm":
					for (const statement of d.keep) {
						actions.push({ kind: "statement", statement })
					}
					break
				case "loss":
					for (const a of lossWritten(d, policy.chosen, policy.losses)) {
						actions.push(a)
					}
					break
				case "statement":
				case "placeholderColumn":
				case "placeholderRetype":
				case "placeholderHandles":
				case "violation":
				case "analyze":
				case "dropStatistics":
					actions.push(d)
					break
			}
		}
		out.push({ draft, actions })
	}
	return Result.succeed(out)
}

/** The reviewed plan of a generated folder, file by file. */
const reviewPlan = (
	g: GenerateResult,
	policy: LossPolicy
): Result.Result<ReadonlyArray<ReviewedFile>, Inexpressible> =>
	reviewFiles(g, decidedPick(policy.chosen), policy)

/** The reviewed plan of a folder that offers no candidate, each loss written in. */
export const plainPlan = (g: GenerateResult): ReadonlyArray<ReviewedFile> => {
	const offered = candidatesOf(g.plan).length
	if (offered > 0) {
		throw DraftTextDefect.make({ defect: `a draft taken as plain offers ${offered} candidates` })
	}
	const plan = reviewPlan(g, { chosen: new Set(), losses: "written" })
	if (Result.isFailure(plan)) {
		throw DraftTextDefect.make({ defect: "a draft without candidates is inexpressible" })
	}
	return plan.success
}

/** The placeholders of a reviewed file, in order. */
export const placeholdersOf = (file: ReviewedFile): ReadonlyArray<Placeholder> =>
	Arr.filter(file.actions, isPlaceholder)

/** A text with each placeholder marker line deleted and each placeholder token of its SQL replaced by its value, in
 * order. A drafted file comments a line out whole, so a line of SQL is one that does not start a comment. */
const resolvePlaceholders = (
	where: string,
	lines: ReadonlyArray<string>,
	values: ReadonlyArray<string>
): string => {
	const out: Array<string> = []
	let next = 0
	for (const line of lines) {
		if (pipe(Str.trimStart(line), Str.startsWith(placeholderMarker))) {
			continue
		}
		if (!Str.includes(placeholderToken)(line) || pipe(Str.trimStart(line), Str.startsWith("--"))) {
			out.push(line)
			continue
		}
		const value = values[next++]
		if (value === undefined) {
			throw DraftTextDefect.make({
				defect: `${where}: more placeholders than the reviewed plan holds`
			})
		}
		out.push(Str.replace(placeholderToken, value)(line))
	}
	if (next !== values.length) {
		throw DraftTextDefect.make({
			defect: `${where}: ${values.length} placeholders in the reviewed plan, ${next} in the text`
		})
	}
	return Arr.join(out, "\n")
}

/** A reviewed file of the plan printed as the drafter prints a file, its placeholders resolved by `value`. */
export const renderReviewed = (
	file: ReviewedFile,
	value: (placeholder: Placeholder) => string
): string => {
	const text = renderFile({ ...file.draft, drafts: file.actions })
	if (!text.ok) {
		throw DraftTextDefect.make({ defect: `${file.draft.name}: ${text.error.message}` })
	}
	return resolvePlaceholders(
		file.draft.name,
		Str.split(text.value, "\n"),
		Arr.map(placeholdersOf(file), value)
	)
}

/** The instruction line below an offer's marker, one per offer kind (`renderOffer`). */
const offerInstructions: ReadonlySet<string> = new Set(Rec.values(offerInstruction))

/** A drafted step the text marks: a choice's offers above the statement it decides, a loss, a confirmed group. */
type Marked = Choice<Offer> | LossDecision | Confirm

/** The marked steps of a list of drafted steps, in draft order. */
const markedIn = (steps: ReadonlyArray<Draft | RelationStep>): ReadonlyArray<Marked> =>
	Arr.flatMap(steps, (d): ReadonlyArray<Marked> => {
		switch (d.kind) {
			case "choice":
			case "loss":
			case "confirm":
				return [d]
			case "statement":
			case "placeholderColumn":
			case "placeholderRetype":
			case "placeholderHandles":
			case "violation":
			case "analyze":
			case "dropStatistics":
				return []
		}
	})

/** The marked steps of an offer's alternative: a rename's own; a rewrite's, a conversion's and a deletion's none. */
const offerMarked = (offer: Offer): ReadonlyArray<Marked> => {
	switch (offer.kind) {
		case "rename":
		case "relation rename":
		case "nested rename":
			return markedIn(offer.alternative)
		case "rewrite":
		case "delete":
		case "convert":
			return []
	}
}

/** One file's text, or a chosen alternative's uncommented lines, with its marked steps met in order and decided as
 * `pick` writes each choice and `policy` each loss: a chosen rename's alternative is written in its turn, with that
 * rename's own marked steps; an offer not taken keeps its commented alternative as it is. Each loss marker is the next
 * marked step's loss, decided by that loss's own carriers, never by its text.
 *
 * A confirm marker: the marker and its instruction go, the statements below stay.
 *
 * Kept, every block's commented alternative stays above the statement, which stays.
 *
 * The decided statement goes: the first the kept action renders, after its placeholder marker. */
const decideLines = (
	file: string,
	lines: ReadonlyArray<string>,
	marked: ReadonlyArray<Marked>,
	pick: Pick,
	policy: LossPolicy
): Result.Result<ReadonlyArray<string>, Inexpressible> => {
	const at = (k: number): string => lines[k] ?? ""
	const decided: Array<string> = []
	const keep = (kept: ReadonlyArray<string>): void => {
		for (const line of kept) {
			decided.push(line)
		}
	}
	let next = 0
	const nextMarked = (what: string): Marked => {
		const step = marked[next]
		if (step === undefined) {
			throw DraftTextDefect.make({
				defect: `${file}: ${what} past the ${marked.length} marked steps the draft holds here`
			})
		}
		next++
		return step
	}
	let i = 0
	while (i < lines.length) {
		const line = at(i)
		if (Str.startsWith(lossMarker)(line)) {
			const loss = nextMarked("a loss marker")
			if (loss.kind !== "loss") {
				throw DraftTextDefect.make({
					defect: `${file}: a loss marker where the draft holds a ${loss.kind}`
				})
			}
			/** A loss: its marker, its instruction, and its statement commented line by line to its terminator. */
			const start = i + 2
			let end = start
			while (
				end < lines.length &&
				pipe(at(end), Str.startsWith("-- ")) &&
				!pipe(at(end), Str.endsWith(";"))
			) {
				end++
			}
			const commented = lines.slice(start, end + 1)
			const statement = Arr.join(
				Arr.map(commented, (l) => Str.slice("-- ".length)(l)),
				"\n"
			)
			if (Arr.some(loss.carriers, (c) => policy.chosen.has(c))) {
				i = end + 1
				continue
			}
			switch (policy.losses) {
				case "written":
					decided.push(statement)
					break
				case "left":
					keep(lines.slice(i, end + 1))
					break
			}
			i = end + 1
			continue
		}
		if (!Str.startsWith(renameMarker)(line)) {
			decided.push(line)
			i++
			continue
		}
		if (!offerInstructions.has(at(i + 1))) {
			const group = nextMarked("a confirm marker")
			if (group.kind !== "confirm") {
				throw DraftTextDefect.make({
					defect: `${file}: a confirm marker where the draft holds a ${group.kind}`
				})
			}
			i += 2
			continue
		}
		const choice = nextMarked("a marked statement")
		if (choice.kind !== "choice") {
			throw DraftTextDefect.make({
				defect: `${file}: a marked statement where the draft holds a ${choice.kind}`
			})
		}
		/** One marker block per offer, each its marker, its instruction and its commented alternative, the blocks and the
		 * statement apart by blank lines. The marker and instruction lines go; what follows them is the block's rest. */
		const blocks: Array<{
			readonly alternative: ReadonlyArray<string>
			readonly rest: ReadonlyArray<string>
		}> = []
		while (pipe(at(i), Str.startsWith(renameMarker)) && offerInstructions.has(at(i + 1))) {
			i += 2
			const start = i
			while (i < lines.length && pipe(at(i), Str.startsWith("-- "))) {
				i++
			}
			const alternative = Arr.map(lines.slice(start, i), (l) => Str.slice("-- ".length)(l))
			while (i < lines.length && at(i) === "") {
				i++
			}
			blocks.push({ alternative, rest: lines.slice(start, i) })
		}
		if (blocks.length !== choice.offers.length) {
			throw DraftTextDefect.make({
				defect: `${file}: a marked statement with ${blocks.length} offers, which the draft holds with ${choice.offers.length}`
			})
		}
		const picked = pick(choice)
		const takenOffers = whereIndex(choice.offers, (n) => picked.includes(n))
		const [first, ...more] = takenOffers
		if (first !== undefined && Arr.some(more, (o) => !sameDecision(o, first))) {
			return Result.fail({
				kind: "inexpressible",
				file,
				candidates: Arr.map(takenOffers, (o) => o.candidate)
			})
		}
		const takenAt = Arr.findFirstIndex(choice.offers, (_, n) => picked.includes(n))
		if (Option.isNone(takenAt)) {
			for (const block of blocks) {
				keep(block.rest)
			}
			continue
		}
		const taken = takenAt.value
		const chosenBlock = blocks[taken]
		const one = choice.offers[taken]
		if (chosenBlock === undefined || one === undefined) {
			throw DraftTextDefect.make({
				defect: `${file}: offer ${taken} of a marked statement with ${blocks.length} offers`
			})
		}
		for (const block of blocks.slice(0, taken)) {
			keep(block.rest)
		}
		const written = decideLines(file, chosenBlock.alternative, offerMarked(one), pick, policy)
		if (Result.isFailure(written)) {
			return written
		}
		keep(written.success)
		for (const block of blocks.slice(taken + 1)) {
			keep(block.rest)
		}
		if (pipe(Str.trimStart(at(i)), Str.startsWith(placeholderMarker))) {
			i++
		}
		while (i < lines.length && !pipe(at(i), Str.endsWith(";"))) {
			i++
		}
		i++
	}
	if (next !== marked.length) {
		throw DraftTextDefect.make({
			defect: `${file}: the draft holds ${marked.length} marked steps here, the text ${next}`
		})
	}
	return Result.succeed(decided)
}

/** A reviewed folder: its files' text as the reviewer leaves them, and the reviewed plan they must spell. */
export interface Reviewed {
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
	readonly plan: ReadonlyArray<ReviewedFile>
}

/** How a reviewer writes the folder: every marked statement as the decisions decide it, or one of them, the choice at
 * `choice` among the draft's choices in folder order (modulo their count), written the other way: kept where the
 * decisions choose a candidate it offers, else replaced by its offer at `offer` (modulo its offers). */
export type Written =
	| { readonly kind: "decided" }
	| { readonly kind: "split"; readonly choice: number; readonly offer: number }

const decided: Written = { kind: "decided" }

/** Every choice a draft holds, in folder order: each, then those nested in its offers' alternatives. */
const choicesIn = (steps: ReadonlyArray<Draft | RelationStep>): ReadonlyArray<Choice<Offer>> =>
	Arr.flatMap(steps, (d): ReadonlyArray<Choice<Offer>> =>
		d.kind === "choice" ? [d, ...Arr.flatMap(d.offers, (o: Offer) => choicesIn(offerSteps(o)))] : []
	)

/** Every choice a generated folder drafts, in folder order (its own, then those nested in its offers' alternatives),
 * each with its file: what a split review's `choice` counts among. */
export const draftChoices = (
	g: GenerateResult
): ReadonlyArray<{ readonly file: DraftFile; readonly choice: Choice<Offer> }> =>
	Arr.flatMap(draftFiles(g), (file) =>
		Arr.map(choicesIn(file.drafts), (choice) => ({ file, choice }))
	)

/** What a review writes at each statement a choice decides, as `written` says. */
const writtenPick = (g: GenerateResult, chosen: ReadonlySet<Candidate>, written: Written): Pick => {
	const decide = decidedPick(chosen)
	switch (written.kind) {
		case "decided":
			return decide
		case "split": {
			const choices = Arr.map(draftChoices(g), (x) => x.choice)
			const flipped = choices[written.choice % Math.max(choices.length, 1)]
			if (flipped === undefined) {
				throw DraftTextDefect.make({
					defect: "a split review writes a marked statement the other way; this folder marks none"
				})
			}
			return (choice) => {
				if (choice !== flipped) {
					return decide(choice)
				}
				return decide(choice).length > 0 ? [] : [written.offer % choice.offers.length]
			}
		}
	}
}

/** The review of a generated folder written as `written` says: its text decided step by step as the draft marks it,
 * its placeholders given the values `decisions` gives the placeholders of the statements it writes; its plan, the
 * decided one. */
export const reviewWritten = (
	g: GenerateResult,
	decisions: Decisions,
	written: Written
): Result.Result<Reviewed, Inexpressible> => {
	const policy: LossPolicy = { chosen: decisions.chosen, losses: decisions.losses }
	const plan = reviewPlan(g, policy)
	if (Result.isFailure(plan)) {
		return Result.fail(plan.failure)
	}
	const pick = writtenPick(g, decisions.chosen, written)
	const writes = reviewFiles(g, pick, policy)
	if (Result.isFailure(writes)) {
		return Result.fail(writes.failure)
	}
	const files: Array<{ readonly name: string; readonly text: string }> = []
	for (const [n, f] of g.folder.files.entries()) {
		const reviewed = writes.success[n]
		if (reviewed === undefined || reviewed.draft.name !== f.name) {
			throw DraftTextDefect.make({ defect: `${f.name}: the folder's files are not the plan's` })
		}
		if (isNoTransaction(f.text) === reviewed.draft.transaction) {
			throw DraftTextDefect.make({ defect: `${f.name}: its transaction mode is not the plan's` })
		}
		const text = decideLines(
			f.name,
			Str.split(f.text, "\n"),
			markedIn(reviewed.draft.drafts),
			pick,
			policy
		)
		if (Result.isFailure(text)) {
			return Result.fail(text.failure)
		}
		files.push({
			name: f.name,
			text: resolvePlaceholders(
				f.name,
				text.success,
				Arr.map(placeholdersOf(reviewed), decisions.value)
			)
		})
	}
	if (g.folder.files.length !== writes.success.length) {
		throw DraftTextDefect.make({
			defect: `the folder holds ${g.folder.files.length} files, the plan ${writes.success.length}`
		})
	}
	return Result.succeed({ files, plan: plan.success })
}

/** The review of a generated folder, every marked statement written as the decisions decide it. */
export const review = (
	g: GenerateResult,
	decisions: Decisions
): Result.Result<Reviewed, Inexpressible> => reviewWritten(g, decisions, decided)

/** What a reviewer leaves who writes no value at the placeholders of the SQL, each token kept in place: the review's
 * files, and each line that then holds a placeholder, those where the text differs from `filled`, the review deciding
 * alike that writes a one-line value at each. */
export const leftUnfilled = (
	g: GenerateResult,
	chosen: ReadonlySet<Candidate>,
	filled: Reviewed
): {
	readonly files: Reviewed["files"]
	readonly lines: ReadonlyArray<{ readonly file: string; readonly line: number }>
} => {
	const left = review(g, { chosen, losses: "written", value: () => placeholderToken })
	if (Result.isFailure(left)) {
		throw DraftTextDefect.make({
			defect: "a review that fills its placeholders is expressible, so one that leaves them is too"
		})
	}
	const lines = Arr.flatMap(left.success.files, (f, n) => {
		const other = filled.files[n]
		if (other === undefined || other.name !== f.name) {
			throw DraftTextDefect.make({ defect: `${f.name}: not a file of the filled review` })
		}
		const written = Str.split(other.text, "\n")
		const leaving = Str.split(f.text, "\n")
		if (leaving.length !== written.length) {
			throw DraftTextDefect.make({
				defect: `${f.name}: a value the filled review writes spans lines`
			})
		}
		return Arr.flatMap(leaving, (text, i) =>
			text === written[i] ? [] : [{ file: f.name, line: i + 1 }]
		)
	})
	return { files: left.success.files, lines }
}

/** An end of a candidate rename as the documented rule reads it: a relation's or a type's name, a login's, or a field
 * by the relation that holds it there. */
type End =
	| { readonly kind: "relation" | "type"; readonly name: ObjectName }
	| { readonly kind: "login"; readonly name: string }
	| { readonly kind: "field"; readonly relation: ObjectName; readonly field: string }

const sameName = (a: ObjectName, b: ObjectName): boolean =>
	a.schema === b.schema && a.name === b.name

const sameEnd = (a: End, b: End): boolean => {
	switch (a.kind) {
		case "relation":
		case "type":
			return b.kind === a.kind && sameName(a.name, b.name)
		case "login":
			return b.kind === "login" && a.name === b.name
		case "field":
			return b.kind === "field" && sameName(a.relation, b.relation) && a.field === b.field
	}
}

/** What a candidate takes away and what it gives, as the documented rule names them: a field's rename nested in a
 * relation's takes the removed relation's field away and gives the added relation's. */
const endsIn = (c: Candidate): { readonly removed: End; readonly added: End } => {
	switch (c.kind) {
		case "relation":
		case "type":
			return { removed: { kind: c.kind, name: c.removed }, added: { kind: c.kind, name: c.added } }
		case "login":
			return {
				removed: { kind: "login", name: c.removed },
				added: { kind: "login", name: c.added }
			}
		case "field":
			return {
				removed: { kind: "field", relation: c.relation, field: c.removed },
				added: { kind: "field", relation: c.relation, field: c.added }
			}
		case "nested field":
			return {
				removed: { kind: "field", relation: c.parent.removed, field: c.removed },
				added: { kind: "field", relation: c.parent.added, field: c.added }
			}
	}
}

/** Whether two candidates take one name away or give one name: README's "choose at most one rename for each added and
 * each removed name". */
const collide = (a: Candidate, b: Candidate): boolean => {
	const x = endsIn(a)
	const y = endsIn(b)
	return sameEnd(x.removed, y.removed) || sameEnd(x.added, y.added)
}

/** Every set of `pool` of which no two collide, the empty set included. */
const matchings = (pool: ReadonlyArray<Candidate>): ReadonlyArray<ReadonlyArray<Candidate>> => {
	const out: Array<ReadonlyArray<Candidate>> = []
	const go = (from: number, taken: ReadonlyArray<Candidate>): void => {
		out.push(taken)
		for (const [i, c] of pool.entries()) {
			if (i >= from && Arr.every(taken, (t) => !collide(t, c))) {
				go(i + 1, [...taken, c])
			}
		}
	}
	go(0, [])
	return out
}

/** The fields' renames nested in a relation's: those whose parent it is. */
const nestedUnder = (
	all: ReadonlyArray<Candidate>,
	relation: Candidate
): ReadonlyArray<Candidate> =>
	Arr.filter(all, (c) => c.kind === "nested field" && c.parent === relation)

/** Whether a decision holds every candidate a chosen field's rename requires. */
const closed = (d: ReadonlyArray<Candidate>): boolean =>
	Arr.every(d, (c) =>
		c.kind === "field" || c.kind === "nested field"
			? c.requires.kind === "nothing" || d.includes(c.requires.candidate)
			: true
	)

/** Every decision a reviewer may make of a draft's candidates, written from the documented rules apart from the engine:
 * per kind, a matching of the roots by their ends (no two take one name away or give one name: README's "choose at most
 * one rename for each added and each removed name", for relations, fields of a kept relation, logins, and types, a
 * closed relation's enum and a contract's domain alike); under each chosen relation's rename, a matching of the fields'
 * renames nested in it (SKILL.md: "decided only with its relation's rename"); and closed under `requires`, a field's
 * rename that requires its type's chosen only with it. A group a marker asks the reviewer to confirm (a closed handle
 * renamed in place, a roster rebuilt, a relation set aside) is no candidate: every decision confirms it, as its marker
 * says. The empty decision, every candidate kept, is one. Exhaustive: for the small drafts of the unit suites. */
export const choosable = (g: GenerateResult): ReadonlyArray<ReadonlySet<Candidate>> => {
	const all = candidatesOf(g.plan)
	const roots = Arr.filter(all, (c) => c.kind !== "nested field")
	return Arr.flatMap(matchings(roots), (picked) => {
		const relations = Arr.filter(picked, (c) => c.kind === "relation")
		const start: ReadonlyArray<ReadonlyArray<Candidate>> = [[]]
		const nested = Arr.reduce(relations, start, (acc, r) =>
			Arr.flatMap(acc, (taken) =>
				Arr.map(matchings(nestedUnder(all, r)), (fields) => [...taken, ...fields])
			)
		)
		return Arr.flatMap(nested, (fields) => {
			const d = [...picked, ...fields]
			return closed(d) ? [new Set(d)] : []
		})
	})
}

/** How a review fails to read back as the decision made: its meta.json unread, the candidates read chosen other than
 * those made (by path), a refusal of the review, or a loss left undecided. */
export type ReadBackFault =
	| { readonly kind: "unread"; readonly reason: string }
	| {
			readonly kind: "chosen apart"
			readonly made: ReadonlyArray<CandidatePath>
			readonly read: ReadonlyArray<CandidatePath>
	  }
	| { readonly kind: "refused"; readonly refusal: SplitRename }
	| { readonly kind: "undecided"; readonly loss: LossDecided }

/** Whether two lists of paths name the same candidates. */
const samePaths = (a: ReadonlyArray<CandidatePath>, b: ReadonlyArray<CandidatePath>): boolean =>
	a.length === b.length &&
	Arr.every(a, (p) => Arr.some(b, (q) => samePath(p, q))) &&
	Arr.every(b, (q) => Arr.some(a, (p) => samePath(p, q)))

/** The read-back oracle (CONTRIBUTING, the decision read back is the decision made): a folder reviewed as the decision
 * `chosen` makes it, every loss written in, is read by `grizzle check` from its meta.json as written (the shell's
 * readMeta) as that decision, by path, with no refusal and no loss left undecided. Every fault found, none when it
 * reads back. */
export const readsBack = (
	g: GenerateResult,
	chosen: ReadonlySet<Candidate>,
	files: ReadonlyArray<{ readonly name: string; readonly text: string }>
): ReadonlyArray<ReadBackFault> => {
	const meta = readMeta(g.folder.metaText)
	if (Result.isFailure(meta)) {
		return [{ kind: "unread", reason: meta.failure.message }]
	}
	if (meta.success.kind !== "drafted") {
		return [
			{ kind: "unread", reason: "a generated folder's meta.json reads as a custom migration's" }
		]
	}
	const record = meta.success.record
	const made = Arr.map([...chosen], (c) => pathOf(c))
	const read = Arr.map([...chosenIn(record, files)], (c) => c.path)
	const apart: ReadonlyArray<ReadBackFault> = samePaths(made, read)
		? []
		: [{ kind: "chosen apart", made, read }]
	return [
		...apart,
		...Arr.map(splitRenames(record, files), (refusal): ReadBackFault => ({
			kind: "refused",
			refusal
		})),
		...Arr.flatMap(lossDecisions(record, files), (loss): ReadonlyArray<ReadBackFault> =>
			loss.kind === "unresolved" ? [{ kind: "undecided", loss }] : []
		)
	]
}

/** A decision's candidates as a failure message names them. */
export const decisionText = (chosen: ReadonlySet<Candidate>): string =>
	chosen.size === 0
		? "every candidate kept"
		: Arr.join(
				Arr.map([...chosen], (c) => candidateLabel(c)),
				"; "
			)

/** A recorded step of any place, and a recorded offer of any place. */
type MetaAnyStep = MetaStep | MetaRelationStep | MetaSealedStep
type MetaAnyOffer = MetaTopOffer | MetaNestedRename | MetaPlainOffer

/** The statements a drafted file holds as drafted, uncommented, in the record's order: each statement at its top, each
 * choice's decided statement and what follows it, and each confirmed group's; a loss, an offer and an alternative are
 * drafted commented. */
const draftedAsRecorded = (steps: ReadonlyArray<MetaStep>): ReadonlyArray<string> =>
	Arr.flatMap(steps, (s): ReadonlyArray<string> => {
		switch (s.kind) {
			case "statement":
				return [s.statement]
			case "choice":
				return [s.keep, ...s.follows]
			case "confirm":
				return s.statements
			case "loss":
				return []
		}
	})

/** The completeness oracle (CONTRIBUTING, the record is complete and proved): a generated folder's meta.json decodes
 * with the shell's boundary decoder, reads as a decision record (decisionRecord's proof), and writes back byte for
 * byte; it records the folder's files in order, and every statement each file holds uncommented appears in the record
 * exactly once, in order. Every fault found, none when the record is complete. */
export const recordFaults = (g: GenerateResult): ReadonlyArray<string> => {
	const decoded = decodeMeta(g.folder.metaText)
	if (Result.isFailure(decoded)) {
		return [`meta.json does not decode: ${decoded.failure.message}`]
	}
	const read = readMeta(g.folder.metaText)
	if (Result.isFailure(read)) {
		return [`meta.json does not read as a decision record: ${read.failure.message}`]
	}
	const written = writeMeta(decoded.success)
	const meta = decoded.success
	if (meta.kind !== "drafted") {
		return ["a generated folder's meta.json is a custom migration's"]
	}
	return [
		...(written.ok && written.value === g.folder.metaText
			? []
			: ["meta.json does not write back byte for byte"]),
		...(meta.files.length === g.folder.files.length &&
		Arr.every(meta.files, (m, i) => m.name === g.folder.files[i]?.name)
			? []
			: ["meta.json records other files than the folder holds"]),
		...Arr.flatMap(g.folder.files, (f): ReadonlyArray<string> => {
			const recorded = Arr.findFirst(meta.files, (m) => m.name === f.name)
			if (Option.isNone(recorded)) {
				return [`meta.json records no file ${f.name}`]
			}
			const held = Arr.map(splitStatements(f.text), (x) => fromFirstToken(x))
			const expected = draftedAsRecorded(recorded.value.steps)
			return held.length === expected.length && Arr.every(held, (x, i) => x === expected[i])
				? []
				: [`${f.name}: the statements it holds are not the record's, in order`]
		})
	]
}

/** A recorded statement a review of a decision leaves out, which written in is refused: inside a rename the decision
 * does not choose (`orphan`), or a branch of a choice in its scope it does not take (`split`), each by its file and its
 * text from its first token. A head is none: written, it chooses its candidate. */
export interface ExcludedSite {
	readonly file: string
	readonly statement: string
	readonly refused: "split" | "orphan"
}

/** A recorded statement at the top of a file that no candidate decides, which a reviewer may delete or edit: the
 * reviewer's own. */
export interface FreeSite {
	readonly file: string
	readonly statement: string
}

/** The excluded and free statements of a generated folder under a decision, walked through its record as the
 * documented rules place each statement: a statement inside a chosen rename's alternative is required, at the top of a
 * file free, a choice's following statement free; a choice's decided statement excluded where a chosen candidate
 * replaces it, an untaken offer's statements excluded, and everything inside a rename the decision does not choose
 * excluded, its losses and groups included. */
export const reviewSites = (
	g: GenerateResult,
	chosen: ReadonlySet<Candidate>
): { readonly excluded: ReadonlyArray<ExcludedSite>; readonly free: ReadonlyArray<FreeSite> } => {
	const paths = Arr.map([...chosen], (c) => pathOf(c))
	const isChosen = (p: CandidatePath): boolean => Arr.some(paths, (q) => samePath(p, q))
	const excluded: Array<ExcludedSite> = []
	const free: Array<FreeSite> = []
	const exclude = (
		file: string,
		statements: ReadonlyArray<string>,
		refused: ExcludedSite["refused"]
	) => {
		for (const statement of statements) {
			excluded.push({ file, statement, refused })
		}
	}
	/** An offer as the walk reads it: a rename's own offer, by its path, with its alternative's steps; or what another
	 * candidate's choice makes of the statement. */
	type Read =
		| {
				readonly kind: "own"
				readonly path: CandidatePath
				readonly alternative: ReadonlyArray<MetaAnyStep>
		  }
		| { readonly kind: "plain"; readonly offer: MetaPlainOffer }
	/** An offer read, a nested field's under its relation's path. */
	const readOffer = (o: MetaAnyOffer, parent: EndsPath<"relation"> | undefined): Read => {
		switch (o.kind) {
			case "rename":
				return { kind: "own", path: o.renames, alternative: o.alternative }
			case "relation rename":
				return {
					kind: "own",
					path: { kind: "relation", removed: o.removed, added: o.added },
					alternative: o.alternative
				}
			case "nested rename":
				if (parent === undefined) {
					throw DraftTextDefect.make({ defect: "a nested field's rename outside a relation's" })
				}
				return {
					kind: "own",
					path: { kind: "nested field", parent, removed: o.removed, added: o.added },
					alternative: o.alternative
				}
			case "replace":
			case "delete":
				return { kind: "plain", offer: o }
		}
	}
	/** Every statement of steps inside a rename the decision does not choose. */
	const out = (file: string, steps: ReadonlyArray<MetaAnyStep>): void => {
		for (const s of steps) {
			switch (s.kind) {
				case "statement":
				case "loss":
					exclude(file, [s.statement], "orphan")
					break
				case "confirm":
					exclude(file, s.statements, "orphan")
					break
				case "choice":
					exclude(file, [s.keep, ...s.follows], "orphan")
					for (const o of s.offers) {
						switch (o.kind) {
							case "rename":
							case "relation rename":
							case "nested rename":
								out(file, o.alternative)
								break
							case "replace":
								exclude(file, o.statements, "orphan")
								break
							case "delete":
								break
						}
					}
					break
			}
		}
	}
	const walk = (
		file: string,
		steps: ReadonlyArray<MetaAnyStep>,
		top: boolean,
		parent: EndsPath<"relation"> | undefined
	): void => {
		for (const s of steps) {
			switch (s.kind) {
				case "statement":
					if (top) {
						free.push({ file, statement: s.statement })
					}
					break
				case "loss":
				case "confirm":
					break
				case "choice": {
					for (const x of s.follows) {
						free.push({ file, statement: x })
					}
					const offers = Arr.map(s.offers, (o: MetaAnyOffer) => readOffer(o, parent))
					const pathOfRead = (r: Read): CandidatePath =>
						r.kind === "own" ? r.path : r.offer.candidate
					if (Arr.some(offers, (r) => isChosen(pathOfRead(r)))) {
						exclude(file, [s.keep], "split")
					}
					for (const r of offers) {
						switch (r.kind) {
							case "own":
								if (isChosen(r.path)) {
									walk(file, r.alternative, false, r.path.kind === "relation" ? r.path : undefined)
								} else {
									out(file, r.alternative)
								}
								break
							case "plain":
								if (r.offer.kind === "replace" && !isChosen(r.offer.candidate)) {
									exclude(file, r.offer.statements, "split")
								}
								break
						}
					}
					break
				}
			}
		}
	}
	for (const f of g.folder.meta.files) {
		walk(f.name, f.steps, true, undefined)
	}
	return { excluded, free }
}
