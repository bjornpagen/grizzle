import { Array as Arr, Data, Option, pipe, Result, String as Str } from "effect"
import { decodeMeta, readMeta } from "#adapter/boundary/meta.ts"
import type {
	Action,
	Confirm,
	Draft,
	LossDecision,
	MigrationPlan
} from "#compiler/deploy/diff/plan.ts"
import { type DraftFile, planFiles } from "#compiler/deploy/phases/files.ts"
import {
	type LossDecided,
	lossDecisions,
	type MetaStep,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	confirmMarker,
	fromFirstToken,
	isNoTransaction,
	lossMarker,
	placeholderMarker,
	splitStatements
} from "#compiler/deploy/render/markers.ts"
import { renderFile } from "#compiler/deploy/render/sql.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { placeholderToken, printStatement } from "#compiler/sql/print.ts"

/**
 * A drafted action that needs a value from the reviewer.
 *
 * The reviewer of a drafted migration folder: the one implementation of what a person does with grizzle generate's
 * draft, for every test that reviews a folder before checking or applying it.
 *
 * Rule: a review decides each loss of stored data, its statement written in or left commented, confirms each confirmed
 * group, and gives every placeholder a value. A rename is declared before the draft (`--rename`, `--drop`), so a draft
 * offers no candidate to choose. It is done twice, and the two must spell the same statements (`renderReviewed` prints
 * the first for the comparison):
 *
 * - On the plan (`reviewPlan`): each loss becomes its statement or nothing, each confirmed group its statements, and
 *   every other drafted action stays. This is the reviewed migration as the draft means it.
 * - On the files' text (`review`), exactly as the markers instruct a person: each file's marked steps, in the draft's
 *   order (a loss, a confirmed group), are met one by one in the text, each in its place. A confirm marker is
 *   confirmed: its two lines go and its statements stay. A loss written in loses its two lines and its statement is
 *   uncommented; one left keeps its lines, so `grizzle check` refuses it as unresolved. Each is decided as its own step
 *   says, never looked up by its text. Then each placeholder marker line goes and the token below it takes the value of
 *   the placeholder, the placeholders of the SQL being met in the plan's order.
 *
 * A text that disagrees with meta.json or with the plan is a defect of the draft, thrown as DraftTextDefect.
 */
export type Placeholder = Extract<
	Action,
	{ readonly kind: "placeholderColumn" | "placeholderRetype" }
>

/**
 * How a review decides each loss of stored data: its statement written in, so the data is lost, or left commented, so
 * the loss stays unresolved.
 */
export type LossReview = "written" | "left"

/** What a review decides: how it decides each loss, and the SQL text it writes for each placeholder. */
export interface Decisions {
	readonly losses: LossReview
	readonly value: (placeholder: Placeholder) => string
}

/** One file of the reviewed plan: the drafted file and its reviewed actions. */
export interface ReviewedFile {
	readonly draft: DraftFile
	readonly actions: ReadonlyArray<Action>
}

/** The defect of a draft whose text the reviewer cannot follow: the text, meta.json and the plan disagree. */
class DraftTextDefect extends Data.TaggedError("DraftTextDefect")<{ readonly defect: string }> {}

const isPlaceholder = (a: Action): a is Placeholder =>
	a.kind === "placeholderColumn" || a.kind === "placeholderRetype"

/** Every action a draft holds, a loss's statement and a confirmed group's among them. */
export const draftActions = (d: Draft): ReadonlyArray<Action> => {
	switch (d.kind) {
		case "confirm":
			return Arr.map(d.keep, (statement): Action => ({ kind: "statement", statement }))
		case "loss":
			return [{ kind: "statement", statement: d.statement }]
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return [d]
	}
}

/** Every statement a plan drafts, a loss's among them. */
export const planStatements = (plan: MigrationPlan): ReadonlyArray<SqlStatement> =>
	Arr.flatMap(plan.steps, (step) =>
		Arr.flatMap(draftActions(step.draft), (a) => (a.kind === "statement" ? [a.statement] : []))
	)

/** The drafted files of a generated folder, in the folder's order: none when nothing changed. */
export const draftFiles = (g: GenerateResult): ReadonlyArray<DraftFile> =>
	g.change === "none" ? [] : planFiles(g.plan)

/**
 * The one drafted file that runs a folder's validation statements, the refined constants' casts to their domains: the
 * file whose drafts hold every statement of the target snapshot's validation object, each as it prints.
 */
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

/** The plan of a generated folder reviewed as `losses` decides each loss, file by file. */
const reviewPlan = (g: GenerateResult, losses: LossReview): ReadonlyArray<ReviewedFile> =>
	Arr.map(draftFiles(g), (draft) => ({
		draft,
		actions: Arr.flatMap(draft.drafts, (d): ReadonlyArray<Action> => {
			switch (d.kind) {
				case "loss":
					return losses === "written" ? draftActions(d) : []
				case "confirm":
				case "statement":
				case "placeholderColumn":
				case "placeholderRetype":
				case "violation":
				case "analyze":
				case "dropStatistics":
					return draftActions(d)
			}
		})
	}))

/** The reviewed plan of a folder, each loss written in. */
export const plainPlan = (g: GenerateResult): ReadonlyArray<ReviewedFile> =>
	reviewPlan(g, "written")

/** The placeholders of a reviewed file, in order. */
export const placeholdersOf = (file: ReviewedFile): ReadonlyArray<Placeholder> =>
	Arr.filter(file.actions, isPlaceholder)

/**
 * A text with each placeholder marker line deleted and each placeholder token of its SQL replaced by its value, in
 * order. A drafted file comments a line out whole, so a line of SQL is one that does not start a comment.
 */
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
			throw new DraftTextDefect({
				defect: `${where}: more placeholders than the reviewed plan holds`
			})
		}
		out.push(Str.replace(placeholderToken, value)(line))
	}
	if (next !== values.length) {
		throw new DraftTextDefect({
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
		throw new DraftTextDefect({ defect: `${file.draft.name}: ${text.error.message}` })
	}
	return resolvePlaceholders(
		file.draft.name,
		Str.split(text.value, "\n"),
		Arr.map(placeholdersOf(file), value)
	)
}

/** A drafted step the text marks: a loss, a confirmed group. */
type Marked = LossDecision | Confirm

/** The marked steps of a file's drafts, in draft order. */
const markedIn = (drafts: ReadonlyArray<Draft>): ReadonlyArray<Marked> =>
	Arr.filter(drafts, (d): d is Marked => d.kind === "loss" || d.kind === "confirm")

/**
 * One file's text with its marked steps met in order and decided as `losses` decides each loss. A loss marker is the
 * next marked step's loss: its marker, its instruction, and its statement commented line by line to its terminator. A
 * confirm marker is the next marked step's group: the marker and its instruction go, the statements below stay.
 */
const decideLines = (
	file: string,
	lines: ReadonlyArray<string>,
	marked: ReadonlyArray<Marked>,
	losses: LossReview
): ReadonlyArray<string> => {
	const at = (k: number): string => lines[k] ?? ""
	const decided: Array<string> = []
	let next = 0
	const nextMarked = (what: string): Marked => {
		const step = marked[next]
		if (step === undefined) {
			throw new DraftTextDefect({
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
				throw new DraftTextDefect({
					defect: `${file}: a loss marker where the draft holds a ${loss.kind}`
				})
			}
			const start = i + 2
			let end = start
			while (
				end < lines.length &&
				pipe(at(end), Str.startsWith("-- ")) &&
				!pipe(at(end), Str.endsWith(";"))
			) {
				end++
			}
			switch (losses) {
				case "written":
					decided.push(
						Arr.join(
							Arr.map(lines.slice(start, end + 1), (l) => Str.slice("-- ".length)(l)),
							"\n"
						)
					)
					break
				case "left":
					for (const kept of lines.slice(i, end + 1)) {
						decided.push(kept)
					}
					break
			}
			i = end + 1
			continue
		}
		if (Str.startsWith(confirmMarker)(line)) {
			const group = nextMarked("a confirm marker")
			if (group.kind !== "confirm") {
				throw new DraftTextDefect({
					defect: `${file}: a confirm marker where the draft holds a ${group.kind}`
				})
			}
			i += 2
			continue
		}
		decided.push(line)
		i++
	}
	if (next !== marked.length) {
		throw new DraftTextDefect({
			defect: `${file}: the draft holds ${marked.length} marked steps here, the text ${next}`
		})
	}
	return decided
}

/** A reviewed folder: its files' text as the reviewer leaves them, and the reviewed plan they must spell. */
export interface Reviewed {
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
	readonly plan: ReadonlyArray<ReviewedFile>
}

/**
 * The review of a generated folder: its text decided step by step as the draft marks it, its placeholders given the
 * values `decisions` gives the placeholders of the statements it writes; its plan, the decided one.
 */
export const review = (g: GenerateResult, decisions: Decisions): Reviewed => {
	const plan = reviewPlan(g, decisions.losses)
	if (g.folder.files.length !== plan.length) {
		throw new DraftTextDefect({
			defect: `the folder holds ${g.folder.files.length} files, the plan ${plan.length}`
		})
	}
	const files = Arr.map(g.folder.files, (f, n) => {
		const reviewed = plan[n]
		if (reviewed === undefined || reviewed.draft.name !== f.name) {
			throw new DraftTextDefect({ defect: `${f.name}: the folder's files are not the plan's` })
		}
		if (isNoTransaction(f.text) === reviewed.draft.transaction) {
			throw new DraftTextDefect({ defect: `${f.name}: its transaction mode is not the plan's` })
		}
		const text = decideLines(
			f.name,
			Str.split(f.text, "\n"),
			markedIn(reviewed.draft.drafts),
			decisions.losses
		)
		return {
			name: f.name,
			text: resolvePlaceholders(f.name, text, Arr.map(placeholdersOf(reviewed), decisions.value))
		}
	})
	return { files, plan }
}

/**
 * What a reviewer leaves who writes no value at the placeholders of the SQL, each token kept in place: the review's
 * files, and each line that then holds a placeholder, those where the text differs from `filled`, the review deciding
 * alike that writes a one-line value at each.
 */
export const leftUnfilled = (
	g: GenerateResult,
	filled: Reviewed
): {
	readonly files: Reviewed["files"]
	readonly lines: ReadonlyArray<{ readonly file: string; readonly line: number }>
} => {
	const left = review(g, { losses: "written", value: () => placeholderToken })
	const lines = Arr.flatMap(left.files, (f, n) => {
		const other = filled.files[n]
		if (other === undefined || other.name !== f.name) {
			throw new DraftTextDefect({ defect: `${f.name}: not a file of the filled review` })
		}
		const written = Str.split(other.text, "\n")
		const leaving = Str.split(f.text, "\n")
		if (leaving.length !== written.length) {
			throw new DraftTextDefect({
				defect: `${f.name}: a value the filled review writes spans lines`
			})
		}
		return Arr.flatMap(leaving, (text, i) =>
			text === written[i] ? [] : [{ file: f.name, line: i + 1 }]
		)
	})
	return { files: left.files, lines }
}

/** How a review fails to read back as the decision made: its meta.json unread, or a loss left undecided. */
export type ReadBackFault =
	| { readonly kind: "unread"; readonly reason: string }
	| { readonly kind: "undecided"; readonly loss: LossDecided }

/**
 * The read-back oracle (CONTRIBUTING, the decision read back is the decision made): a folder reviewed with every loss
 * written in is read by `grizzle check` from its meta.json as written (the shell's readMeta) with no loss left
 * undecided. Every fault found, none when it reads back.
 */
export const readsBack = (
	g: GenerateResult,
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
	return Arr.flatMap(
		lossDecisions(meta.success.record, files),
		(loss): ReadonlyArray<ReadBackFault> =>
			loss.kind === "unresolved" ? [{ kind: "undecided", loss }] : []
	)
}

/**
 * The statements a drafted file holds as drafted, uncommented, in the record's order: each statement, and each
 * confirmed group's; a loss is drafted commented.
 */
const draftedAsRecorded = (steps: ReadonlyArray<MetaStep>): ReadonlyArray<string> =>
	Arr.flatMap(steps, (s): ReadonlyArray<string> => {
		switch (s.kind) {
			case "statement":
				return [s.statement]
			case "confirm":
				return s.statements
			case "loss":
				return []
		}
	})

/**
 * The completeness oracle (CONTRIBUTING, the record is complete and proved): a generated folder's meta.json decodes
 * with the shell's boundary decoder, reads as a decision record (decisionRecord's proof), and writes back byte for
 * byte; it records the folder's files in order, and every statement each file holds uncommented appears in the record
 * exactly once, in order. Every fault found, none when the record is complete.
 */
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

/** A recorded statement of a file, which a reviewer may delete or edit: the reviewer's own. */
export interface FreeSite {
	readonly file: string
	readonly statement: string
}

/**
 * The free statements of a generated folder, walked through its record: every recorded statement of a file, each by
 * its file and its text from its first token. A loss's statement and a confirmed group's are decisions, never free.
 */
export const reviewSites = (g: GenerateResult): ReadonlyArray<FreeSite> =>
	Arr.flatMap(g.folder.meta.files, (f) =>
		Arr.flatMap(f.steps, (s): ReadonlyArray<FreeSite> =>
			s.kind === "statement" ? [{ file: f.name, statement: s.statement }] : []
		)
	)
