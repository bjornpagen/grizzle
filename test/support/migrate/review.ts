import { Array as Arr, Option, pipe, Record as Rec, Result, Schema, String as Str } from "effect"

import type {
	Action,
	AlternativeStep,
	Choice,
	Draft,
	LossDecision,
	MigrationPlan,
	Offer
} from "#compiler/deploy/diff/plan.ts"
import { type DraftFile, planFiles } from "#compiler/deploy/phases/files.ts"
import type { MetaChoice, MetaLoss } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	fromFirstToken,
	isNoTransaction,
	lossMarker,
	placeholderMarker,
	placeholderToken,
	renameMarker
} from "#compiler/deploy/render/markers.ts"
import { offerInstruction, renderFile } from "#compiler/deploy/render/sql.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
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
 * - On the files' text (`review`), exactly as the markers instruct a person: meta.json records every statement a
 *   candidate decides, file by file in order (`MetaChoice`), and above each one the file holds one marker
 *   block per offer, in the record's order: the marker, its instruction line and the commented alternative. Each
 *   block's marker and instruction lines go, and its commented alternative stays as a comment. Kept, the statement
 *   stays; chosen, the chosen offer's alternative is uncommented in place and the statement goes, or, for a delete,
 *   the statement just goes. A confirm marker (a closed handle renamed in place) is confirmed: its two lines go. A loss
 *   (meta.json's `losses`, recorded by the statement it writes in) carried by a chosen candidate goes whole, its two
 *   marker lines and its commented statement; one written in loses its two lines and its statement is uncommented; one
 *   left keeps its lines, so `grizzle check` refuses it as unresolved. Then
 *   each placeholder marker line goes and the token below it takes the value of the placeholder, the placeholders of
 *   the SQL being met in the plan's order; a token in a commented alternative stays as it is.
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

/** What a review decides: the candidates it chooses, by index into the plan's candidates (every other one is kept), how
 * it decides each loss no chosen candidate carries, and the SQL text it writes for each placeholder. */
export interface Decisions {
	readonly chosen: ReadonlySet<number>
	readonly losses: LossReview
	readonly value: (placeholder: Placeholder) => string
}

/** What a review writes for a loss: nothing when a chosen candidate carries its data or the review leaves it, else its
 * statement. */
const lossWritten = (
	loss: LossDecision,
	chosen: ReadonlySet<number>,
	losses: LossReview
): ReadonlyArray<Action> =>
	Arr.some(loss.carriers, (c) => chosen.has(c.candidate)) || losses === "left"
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
	readonly candidates: ReadonlyArray<number>
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

/** What an offer replaces the statement it decides with: its actions, and the choices nested in a rename's alternative. */
const offerSteps = (offer: Offer): ReadonlyArray<AlternativeStep> => {
	switch (offer.kind) {
		case "rename":
			return offer.alternative
		case "rewrite":
			return Arr.map(offer.statements, (statement): Action => ({ kind: "statement", statement }))
		case "delete":
			return []
		case "convert":
			return [offer.conversion]
	}
}

/** Every action an offer may write: its own, and every action of the choices and losses nested in it, kept or offered. */
export const offerActions = (offer: Offer): ReadonlyArray<Action> =>
	Arr.flatMap(offerSteps(offer), (s) =>
		s.kind === "choice" || s.kind === "loss" ? draftActions(s) : [s]
	)

/** Every action a draft holds, the kept and the offered ones alike, a loss's statement among them. */
export const draftActions = (d: Draft): ReadonlyArray<Action> => {
	switch (d.kind) {
		case "choice":
			return [d.keep, ...Arr.flatMap(d.offers, offerActions)]
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

/** What a review writes at the k-th statement a choice decides, in the folder's order (meta.json's record order): the
 * offers it takes, by index, among its offers' candidates in order; none keeps the statement. Both the plan and the
 * text of a review read the one pick, so they decide every statement alike. */
type Pick = (candidates: ReadonlyArray<number>, k: number) => ReadonlyArray<number>

/** Each statement decided by the chosen candidates: the offers of the chosen ones taken. */
const decidedPick =
	(chosen: ReadonlySet<number>): Pick =>
	(candidates) =>
		Arr.flatMap(candidates, (c, n) => (chosen.has(c) ? [n] : []))

/** Each choice a draft holds, its own and those nested in its renames' alternatives, with its index among the folder's
 * records: meta.json records a choice and then, offer by offer, the choices nested in it (`fileChoices`). */
const indexChoices = (d: Choice, next: { n: number }, out: Map<Choice, number>): void => {
	out.set(d, next.n++)
	for (const o of d.offers) {
		if (o.kind === "rename") {
			for (const a of o.alternative) {
				if (a.kind === "choice") {
					indexChoices(a, next, out)
				}
			}
		}
	}
}

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
	readonly chosen: ReadonlySet<number>
	readonly losses: LossReview
}

/** A choice as `pick` decides it, and the choices nested in the offer it takes as `pick` decides them, the losses in it
 * as `policy` decides them. */
const reviewChoice = (
	file: string,
	draft: Choice,
	index: ReadonlyMap<Choice, number>,
	pick: Pick,
	policy: LossPolicy
): Result.Result<ReadonlyArray<Action>, Inexpressible> => {
	const k = index.get(draft)
	if (k === undefined) {
		throw DraftTextDefect.make({ defect: `${file}: a choice the folder's records do not index` })
	}
	const picked = pick(
		Arr.map(draft.offers, (o) => o.candidate),
		k
	)
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
	const actions: Array<Action> = []
	for (const step of offerSteps(offer)) {
		if (step.kind === "loss") {
			actions.push(...lossWritten(step, policy.chosen, policy.losses))
			continue
		}
		if (step.kind !== "choice") {
			actions.push(step)
			continue
		}
		const nested = reviewChoice(file, step, index, pick, policy)
		if (Result.isFailure(nested)) {
			return nested
		}
		actions.push(...nested.success)
	}
	return Result.succeed([...actions, ...afterDecided(draft.keep)])
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
	const next = { n: 0 }
	const index = new Map<Choice, number>()
	for (const draft of draftFiles(g)) {
		for (const d of draft.drafts) {
			if (d.kind === "choice") {
				indexChoices(d, next, index)
			}
		}
	}
	for (const draft of draftFiles(g)) {
		const actions: Array<Action> = []
		for (const d of draft.drafts) {
			switch (d.kind) {
				case "choice": {
					const reviewed = reviewChoice(draft.name, d, index, pick, policy)
					if (Result.isFailure(reviewed)) {
						return Result.fail(reviewed.failure)
					}
					actions.push(...reviewed.success)
					break
				}
				case "confirm":
					for (const statement of d.keep) {
						actions.push({ kind: "statement", statement })
					}
					break
				case "loss":
					actions.push(...lossWritten(d, policy.chosen, policy.losses))
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
	if (g.plan.candidates.length > 0) {
		throw DraftTextDefect.make({
			defect: `a draft taken as plain offers ${g.plan.candidates.length} candidates`
		})
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

type Record = { readonly record: MetaChoice; readonly k: number }

/** The records from `start` that a choice holds, its own first: the records after it nested within one of its offers'
 * candidates, or within a candidate of a record so held (meta.json records them right after the choice that holds them). */
const heldBy = (
	records: ReadonlyArray<Record>,
	start: number,
	candidates: ReadonlySet<number>
): number => {
	const within = new Set(candidates)
	let end = start
	for (const r of records.slice(start)) {
		const w = r.record.within
		if (w.kind !== "within" || !within.has(w.candidate)) {
			break
		}
		for (const o of r.record.offers) {
			within.add(o.candidate)
		}
		end++
	}
	return end
}

/** One file's text, or a chosen alternative's uncommented lines, with its choices written as `pick` writes them, as
 * meta.json's `choices` record them in order, each with its index among the folder's records: a chosen rename's
 * alternative is written in its turn, with the records nested within that rename; the records nested in an offer not
 * taken go with its commented alternative. */
const decideText = (
	file: string,
	text: string,
	choices: ReadonlyArray<Record>,
	pick: Pick,
	loss: LossText
): Result.Result<ReadonlyArray<string>, Inexpressible> =>
	decideLines(file, Str.split(text, "\n"), choices, pick, loss)

/** How a review writes a loss its file holds, by the statement it writes in: in, out with its lines, or left as drafted. */
type LossText = (file: string, statement: string) => "written" | "carried" | "left"

/** A confirm marker: the marker and its instruction go, the statements below stay.
 *
 * Kept, every block's commented alternative stays above the statement, which stays.
 *
 * The decided statement goes: the first the kept action renders, after its placeholder marker. */
const decideLines = (
	file: string,
	lines: ReadonlyArray<string>,
	choices: ReadonlyArray<Record>,
	pick: Pick,
	loss: LossText
): Result.Result<ReadonlyArray<string>, Inexpressible> => {
	const at = (k: number): string => lines[k] ?? ""
	const decided: Array<string> = []
	let choice = 0
	let i = 0
	while (i < lines.length) {
		const line = at(i)
		if (Str.startsWith(lossMarker)(line)) {
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
			switch (loss(file, fromFirstToken(Str.slice(0, -";".length)(statement)))) {
				case "written":
					decided.push(statement)
					break
				case "carried":
					break
				case "left":
					decided.push(...lines.slice(i, end + 1))
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
			i += 2
			continue
		}
		const recorded = choices[choice]
		if (recorded === undefined) {
			throw DraftTextDefect.make({
				defect: `${file}: a marked statement past the ${choices.length} meta.json records`
			})
		}
		const { record, k } = recorded
		const end = heldBy(choices, choice + 1, new Set(Arr.map(record.offers, (o) => o.candidate)))
		const nested = choices.slice(choice + 1, end)
		choice = end
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
		if (blocks.length !== record.offers.length) {
			throw DraftTextDefect.make({
				defect: `${file}: a marked statement with ${blocks.length} offers, which meta.json records with ${record.offers.length}`
			})
		}
		const candidates = Arr.map(record.offers, (o) => o.candidate)
		const picked = pick(candidates, k)
		const [one, ...more] = picked
		const statementsAt = (n: number): ReadonlyArray<string> => {
			const offer = record.offers[n]
			if (offer === undefined) {
				throw DraftTextDefect.make({
					defect: `${file}: offer ${n} of a marked statement with ${record.offers.length} offers`
				})
			}
			return offer.statements
		}
		if (one !== undefined && Arr.some(more, (n) => !sameText(statementsAt(n), statementsAt(one)))) {
			return Result.fail({
				kind: "inexpressible",
				file,
				candidates: whereIndex(candidates, (n) => picked.includes(n))
			})
		}
		if (one === undefined) {
			for (const block of blocks) {
				decided.push(...block.rest)
			}
			continue
		}
		const chosenBlock = blocks[one]
		const taken = record.offers[one]
		if (chosenBlock === undefined || taken === undefined) {
			throw DraftTextDefect.make({
				defect: `${file}: offer ${one} of a marked statement with ${blocks.length} offers`
			})
		}
		for (const block of blocks.slice(0, one)) {
			decided.push(...block.rest)
		}
		/** The choices nested in the taken alternative, which its uncommented lines now mark. */
		const within = whereIndex(nested, (n) => {
			const start = Arr.findFirstIndex(
				nested,
				(r) => r.record.within.kind === "within" && r.record.within.candidate === taken.candidate
			)
			return (
				Option.isSome(start) &&
				n >= start.value &&
				n < heldBy(nested, start.value, new Set([taken.candidate]))
			)
		})
		const written = decideLines(file, chosenBlock.alternative, within, pick, loss)
		if (Result.isFailure(written)) {
			return written
		}
		decided.push(...written.success)
		for (const block of blocks.slice(one + 1)) {
			decided.push(...block.rest)
		}
		if (pipe(Str.trimStart(at(i)), Str.startsWith(placeholderMarker))) {
			i++
		}
		while (i < lines.length && !pipe(at(i), Str.endsWith(";"))) {
			i++
		}
		i++
	}
	if (choice !== choices.length) {
		throw DraftTextDefect.make({
			defect: `${file}: meta.json records ${choices.length} marked statements, the file holds ${choice}`
		})
	}
	return Result.succeed(decided)
}

/** A reviewed folder: its files' text as the reviewer leaves them, and the reviewed plan they must spell. */
export interface Reviewed {
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
	readonly plan: ReadonlyArray<ReviewedFile>
}

/** How a reviewer writes the folder: every marked statement as the decisions decide it, or one of them, the record at
 * `choice` (modulo meta.json's choices), written the other way: kept where the decisions choose a candidate it
 * offers, else replaced by its offer at `offer` (modulo its offers). */
export type Written =
	| { readonly kind: "decided" }
	| { readonly kind: "split"; readonly choice: number; readonly offer: number }

export const decided: Written = { kind: "decided" }

/** What a review writes at each statement a choice decides, as `written` says. */
const writtenPick = (g: GenerateResult, chosen: ReadonlySet<number>, written: Written): Pick => {
	const decide = decidedPick(chosen)
	switch (written.kind) {
		case "decided":
			return decide
		case "split": {
			const records = g.folder.meta.decisions.choices.length
			if (records === 0) {
				throw DraftTextDefect.make({
					defect: "a split review writes a marked statement the other way; this folder marks none"
				})
			}
			const flipped = written.choice % records
			return (candidates, k) => {
				if (k !== flipped) {
					return decide(candidates, k)
				}
				return decide(candidates, k).length > 0 ? [] : [written.offer % candidates.length]
			}
		}
	}
}

/** The review of a generated folder written as `written` says: its text decided against meta.json's record of the
 * choices, its placeholders given the values `decisions` gives the placeholders of the statements it writes; its
 * plan, the decided one. */
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
	const records = Arr.map(g.folder.meta.decisions.choices, (record, k) => ({ record, k }))
	const lossRecords: ReadonlyArray<MetaLoss> = g.folder.meta.decisions.losses
	const loss: LossText = (file, statement) => {
		const record = Option.getOrUndefined(
			Arr.findFirst(lossRecords, (l) => l.file === file && l.statement === statement)
		)
		if (record === undefined) {
			throw DraftTextDefect.make({
				defect: `${file}: a loss meta.json does not record: ${statement}`
			})
		}
		if (Arr.some(record.carriers, (c) => decisions.chosen.has(c))) {
			return "carried"
		}
		return decisions.losses
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
		const text = decideText(
			f.name,
			f.text,
			Arr.filter(records, (r) => r.record.file === f.name),
			pick,
			loss
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
	chosen: ReadonlySet<number>,
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
