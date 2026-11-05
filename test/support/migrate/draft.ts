import { Array as Arr, Order, Result } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Identity } from "#compiler/core/identity.ts"
import * as EngineResult from "#compiler/core/result.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { lossDecisions, type MetaLosses } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { findMarkers } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type InterpretFailure,
	installState,
	interpret,
	load,
	type PlaceholderValue,
	type State
} from "#test/support/migrate/interpret.ts"

import { installedCodes } from "#test/support/compile.ts"
import {
	compile,
	type DeploySubject,
	draftCodes,
	fromSnapshot,
	noDeclarations,
	generate,
	type Previous,
	unowned
} from "#test/support/migrate/kit.ts"

import {
	type LossReview,
	type Placeholder,
	plainPlan,
	review
} from "#test/support/migrate/review.ts"

/** The drafting door: `grizzle generate`'s folder as the command line writes it, a reviewer's work on it, and `grizzle
 * check`'s reading of it, for the suites that judge a draft by what it writes, never by its plan.
 *
 * A draft is its folder: its SQL files' text, its meta.json as written, read here once by this door's own decoder of
 * the fields a reviewer's decisions name (each confirmed group, each loss of stored data with its file), and its
 * snapshot's fingerprint. A rename is declared before the draft (`--rename`, `--drop`), so a draft offers no candidate. A review is the one reviewer's, whose files are text; it runs on the catalog
 * model of PostgreSQL, which the door hands over as a function of the state, the plan staying inside.
 * `checkOf` is `grizzle check`'s reading of a folder's files against its meta.json: the markers left and the losses
 * unresolved, each by its kind and file. Rows enter and leave the model as integers by column,
 * so a suite never builds or reads src's literals. */
export interface TextFile {
	readonly name: string
	readonly text: string
}

/** A loss as meta.json records it: its file, what it loses, and its statement. */
export interface DraftedLoss {
	readonly file: string
	readonly loses: MetaLosses
	readonly statement: string
}

/** A drafted folder as the command line writes it. */
interface DraftedView {
	readonly change: "none" | "schema"
	readonly fingerprint: string
	/** The committed snapshot the next draft continues. */
	readonly next: Previous
	readonly folder: string
	readonly files: ReadonlyArray<TextFile>
	readonly confirms: number
	readonly losses: ReadonlyArray<DraftedLoss>
}

/**
 * A drafted folder as the command line writes it, and the generator result it was drafted from, which only this door
 * reads; only draftOf makes one.
 */
class Drafted implements DraftedView {
	readonly change: "none" | "schema"
	readonly fingerprint: string
	readonly next: Previous
	readonly folder: string
	readonly files: ReadonlyArray<TextFile>
	readonly confirms: number
	readonly losses: ReadonlyArray<DraftedLoss>
	readonly #result: GenerateResult

	constructor(view: DraftedView, result: GenerateResult) {
		this.change = view.change
		this.fingerprint = view.fingerprint
		this.next = view.next
		this.folder = view.folder
		this.files = view.files
		this.confirms = view.confirms
		this.losses = view.losses
		this.#result = result
	}

	/** The generator result `d` was drafted from. */
	static resultOf(d: Drafted): GenerateResult {
		return d.#result
	}
}

export type { Drafted }

/** One step of meta.json's record as the door reads it: only what a reviewer's decisions name. */
type StepRead =
	| { readonly kind: "statement" }
	| { readonly kind: "loss"; readonly loses: MetaLosses; readonly statement: string }
	| { readonly kind: "confirm" }

/** meta.json's record as the door reads it: a file grizzle drafted in this process, so its text is trusted. */
type MetaRead = {
	readonly files: ReadonlyArray<{ readonly name: string; readonly steps: ReadonlyArray<StepRead> }>
}

/** What meta.json's record names that a reviewer decides, in draft order: the confirmed groups and every loss. */
interface MetaView {
	readonly confirms: number
	readonly losses: ReadonlyArray<DraftedLoss>
}

const metaView = (files: MetaRead["files"]): MetaView => ({
	confirms: Arr.reduce(
		files,
		0,
		(n, f) => n + Arr.filter(f.steps, (s) => s.kind === "confirm").length
	),
	losses: Arr.flatMap(files, (f) =>
		Arr.flatMap(f.steps, (s): ReadonlyArray<DraftedLoss> =>
			s.kind === "loss" ? [{ file: f.name, loses: s.loses, statement: s.statement }] : []
		)
	)
})

/** `grizzle generate`'s answer for `subject`, compiled under the schema identity `installation` with `extensions` and
 * no owner as it compiles it, its codes drafted from `previous`'s (D1's refusal among its answers), named `name`. */
const generated = (
	subject: DeploySubject,
	extensions: ReadonlyArray<InstallExtension>,
	installation: Identity<"schema">,
	previous: Previous,
	name: string
): EngineResult.Result<GenerateResult, CompileError> =>
	EngineResult.flatMap(draftCodes(subject, previous, noDeclarations), (codes) =>
		generate({
			previous,
			installation: compile(subject, {
				schema: { kind: "installed", installation },
				owner: unowned,
				extensions,
				codes: installedCodes(codes)
			}),
			name,
			timestamp: "20261020000000",
			workload: noWorkload,
			declared: noDeclarations
		})
	)

/** The drafter's refusal of a draft a suite names as one it refuses, for the suite's `refused` to read by its reason and
 * location; a draft it makes is the success that assertion fails. */
export const draftAttempt = (
	subject: DeploySubject,
	extensions: ReadonlyArray<InstallExtension>,
	installation: Identity<"schema">,
	previous: Previous,
	name: string
): EngineResult.Result<void, CompileError> =>
	EngineResult.map(generated(subject, extensions, installation, previous, name), () => undefined)

/** The draft of `subject`, compiled under the schema identity `installation` with `extensions` and no owner as `grizzle
 * generate` compiles it, from `previous`, named `name`; a refusal fails the test. */
export const draftOf = (
	subject: DeploySubject,
	extensions: ReadonlyArray<InstallExtension>,
	installation: Identity<"schema">,
	previous: Previous,
	name: string
): Drafted => {
	const g = succeeded(
		generated(subject, extensions, installation, previous, name),
		`the draft ${name}`
	)
	const meta = metaView(trustedJson<{ readonly meta: MetaRead }>(g.folder.metaText).meta.files)
	return new Drafted(
		{
			change: g.change,
			fingerprint: g.snapshot.fingerprint,
			next: fromSnapshot(g.snapshot),
			folder: g.folder.name,
			files: g.folder.files,
			confirms: meta.confirms,
			losses: meta.losses
		},
		g
	)
}

/** A folder reviewed: its files as the reviewer leaves them, and the reviewed migration run on the catalog model from a
 * state, every placeholder given `value`'s literal. */
export interface ReviewedFolder {
	readonly files: ReadonlyArray<TextFile>
	readonly run: (
		schema: string,
		state: State,
		value: PlaceholderValue
	) => Result.Result<State, InterpretFailure>
}

/** What a reviewer decides: each loss, written in or left; and each placeholder's SQL text. */
export interface ReviewChoices {
	readonly losses: LossReview
	readonly value: (placeholder: Placeholder) => string
}

/** A draft reviewed as `choices` decides: its files as the reviewer leaves them, and its migration run on the model. */
export const reviewOf = (d: Drafted, choices: ReviewChoices): ReviewedFolder => {
	const reviewed = review(Drafted.resultOf(d), choices)
	const plan = reviewed.plan
	return {
		files: reviewed.files,
		run: (schema, state, value) => interpret(schema, state, plan, value)
	}
}

/** The review of a draft, every loss written in. */
export const plainReviewOf = (d: Drafted): ReviewedFolder => {
	const plan = plainPlan(Drafted.resultOf(d))
	return { files: d.files, run: (schema, state, value) => interpret(schema, state, plan, value) }
}

/** A finding of `grizzle check` on a reviewed folder: a marker left, or a loss unresolved, with its file. */
export interface Finding {
	readonly kind: "marker" | "unresolved loss"
	readonly file: string
}

export const checkOf = (d: Drafted, files: ReadonlyArray<TextFile>): ReadonlyArray<Finding> => {
	const record = Drafted.resultOf(d).record
	return [
		...Arr.flatMap(files, (f) =>
			Arr.map(findMarkers(f.text), (): Finding => ({ kind: "marker", file: f.name }))
		),
		...Arr.flatMap(lossDecisions(record, files), (l): ReadonlyArray<Finding> =>
			l.kind === "unresolved" ? [{ kind: "unresolved loss", file: l.file }] : []
		)
	]
}

/** The catalog model of a draft's snapshot installed from nothing into `schema`. */
export const freshStateOf = (schema: string, d: Drafted): Result.Result<State, InterpretFailure> =>
	installState(
		schema,
		Arr.flatMap(Drafted.resultOf(d).snapshot.manifest.objects, (o) => o.ddl)
	)

/** A model state with integer rows loaded into `table`, each row a value per column. */
export const loadIntegers = (
	state: State,
	table: string,
	rows: ReadonlyArray<ReadonlyMap<string, bigint>>
): State =>
	load(
		state,
		table,
		Arr.map(
			rows,
			(row) => new Map(Arr.map([...row], ([c, value]) => [c, { kind: "int", value }] as const))
		)
	)

/** The rows a model state holds in `table`, each `column=value` joined by commas in column-name order, a value its
 * integer, sorted: none when the table is absent. */
export const integerRows = (state: State, table: string): ReadonlyArray<string> => {
	const t = state.tables.get(table)
	if (t === undefined) {
		return []
	}
	const rows = Arr.map(t.rows, (row) =>
		Arr.join(
			Arr.map(
				Arr.sort(
					Arr.fromIterable(row),
					Order.mapInput(Order.String, ([c]: readonly [string, unknown]) => c)
				),
				([c, cell]) =>
					`${c}=${cell.kind === "value" && cell.value.kind === "int" ? String(cell.value.value) : "?"}`
			),
			","
		)
	)
	return Arr.sort(rows, Order.String)
}

/** The placeholder value of a model run that loads no rows a placeholder could ask a value for. */
export const noRowValue: PlaceholderValue = (p) => {
	throw new Error(`a model without such rows asked a ${p.kind} for a row's value`)
}
