import { Array as Arr, Order, Result, Schema } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Identity } from "#compiler/core/identity.ts"
import * as EngineResult from "#compiler/core/result.ts"
import { lossDecisions, splitRenames } from "#compiler/deploy/render/chosen.ts"
import { readDecisions } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { findMarkers } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { chosenCandidates, type Renames } from "#test/pg/migrate-gen/support.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type InterpretFailure,
	installState,
	interpret,
	load,
	type PlaceholderValue,
	type State
} from "#test/support/migrate/interpret.ts"

import {
	compile,
	type DeploySubject,
	fromSnapshot,
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
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"

/** The drafting door: `grizzle generate`'s folder as the command line writes it, a reviewer's work on it, and `grizzle
 * check`'s reading of it, for the suites that judge a draft by what it writes, never by its plan.
 *
 * A draft is its folder: its SQL files' text, its meta.json as written, read here once by this door's own decoder of
 * the fields a reviewer's decisions name (each candidate's renames, each loss of stored data with its carriers), and
 * its snapshot's fingerprint. A review is the one reviewer's, whose files are text; it runs on the catalog
 * model of PostgreSQL, which the door hands over as a function of the state, the plan staying inside.
 * `checkOf` is `grizzle check`'s reading of a folder's files against its meta.json: the markers left, the decisions
 * split, and the losses unresolved, each by its kind and file. Rows enter and leave the model as integers by column,
 * so a suite never builds or reads src's literals. */
export interface TextFile {
	readonly name: string
	readonly text: string
}

/** What a loss of stored data loses, as meta.json writes it. */
export type LossView =
	| { readonly kind: "relation"; readonly relation: string }
	| { readonly kind: "field"; readonly relation: string; readonly field: string }
	| { readonly kind: "schema"; readonly schema: string }

/** Where a loss is: at the top of its file, or in the alternative of a candidate, by index. */
export type LossWithin =
	| { readonly kind: "top" }
	| { readonly kind: "within"; readonly candidate: number }

/** A loss as meta.json records it: its file, where it is, what it loses, its statement, and the candidates that carry it
 * instead, by index. */
export interface DraftedLoss {
	readonly file: string
	readonly within: LossWithin
	readonly loses: LossView
	readonly statement: string
	readonly carriers: ReadonlyArray<number>
}

/** A candidate as meta.json records what it renames. */
interface DraftedCandidate {
	readonly kind: "relation" | "field" | "type"
	readonly removed: string
	readonly added: string
}

/** A drafted folder as the command line writes it. */
interface DraftedView {
	readonly change: "none" | "schema"
	readonly fingerprint: string
	/** The committed snapshot the next draft continues. */
	readonly next: Previous
	readonly folder: string
	readonly files: ReadonlyArray<TextFile>
	readonly candidates: ReadonlyArray<DraftedCandidate>
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
	readonly candidates: ReadonlyArray<DraftedCandidate>
	readonly confirms: number
	readonly losses: ReadonlyArray<DraftedLoss>
	readonly #result: GenerateResult

	constructor(view: DraftedView, result: GenerateResult) {
		this.change = view.change
		this.fingerprint = view.fingerprint
		this.next = view.next
		this.folder = view.folder
		this.files = view.files
		this.candidates = view.candidates
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

const Text = Schema.String
const Index = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const MetaRead = Schema.Struct({
	decisions: Schema.Struct({
		candidates: Schema.Array(
			Schema.Struct({
				renames: Schema.Struct({
					kind: Schema.Literals(["relation", "field", "type"]),
					removed: Text,
					added: Text
				})
			})
		),
		confirms: Schema.Array(Schema.Unknown),
		losses: Schema.Array(
			Schema.Struct({
				file: Text,
				within: Schema.Union([
					Schema.Struct({ kind: Schema.Literal("top") }),
					Schema.Struct({ kind: Schema.Literal("within"), candidate: Index })
				]),
				loses: Schema.Union([
					Schema.Struct({ kind: Schema.Literal("relation"), relation: Text }),
					Schema.Struct({ kind: Schema.Literal("field"), relation: Text, field: Text }),
					Schema.Struct({ kind: Schema.Literal("schema"), schema: Text })
				]),
				statement: Text,
				carriers: Schema.Array(Index)
			})
		)
	})
})
const decodeMeta = Schema.decodeUnknownResult(Schema.fromJsonString(MetaRead))

/** `grizzle generate`'s answer for `subject`, compiled under the schema identity `installation` with `extensions` and
 * no owner as it compiles it, from `previous`, named `name`. */
const generated = (
	subject: DeploySubject,
	extensions: ReadonlyArray<InstallExtension>,
	installation: Identity<"schema">,
	previous: Previous,
	name: string
): EngineResult.Result<GenerateResult, CompileError> =>
	generate({
		previous,
		installation: compile(subject, {
			schema: { kind: "installed", installation },
			owner: unowned,
			extensions
		}),
		name,
		timestamp: "20261020000000",
		workload: noWorkload
	})

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
	const meta = succeeded(decodeMeta(g.folder.metaText), `the meta.json of ${name}`).decisions
	return new Drafted(
		{
			change: g.change,
			fingerprint: g.snapshot.fingerprint,
			next: fromSnapshot(g.snapshot),
			folder: g.folder.name,
			files: g.folder.files,
			candidates: Arr.map(meta.candidates, (c) => c.renames),
			confirms: meta.confirms.length,
			losses: Arr.map(meta.losses, (l) => ({
				file: l.file,
				within: l.within,
				loses: l.loses,
				statement: l.statement,
				carriers: l.carriers
			}))
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

/** What a reviewer decides: the candidates it chooses, by index; each loss no chosen candidate carries, written in or
 * left; and each placeholder's SQL text. */
export interface ReviewChoices {
	readonly chosen: ReadonlySet<number>
	readonly losses: LossReview
	readonly value: (placeholder: Placeholder) => string
}

/** A review two chosen candidates make inexpressible, naming them. */
interface Inexpressible {
	readonly candidates: ReadonlyArray<number>
}

export const reviewOf = (
	d: Drafted,
	choices: ReviewChoices
): Result.Result<ReviewedFolder, Inexpressible> => {
	const reviewed = review(Drafted.resultOf(d), choices)
	if (Result.isFailure(reviewed)) {
		return Result.fail({ candidates: reviewed.failure.candidates })
	}
	const plan = reviewed.success.plan
	return Result.succeed({
		files: reviewed.success.files,
		run: (schema, state, value) => interpret(schema, state, plan, value)
	})
}

/** The review of a draft that offers no candidate, every loss written in. */
export const plainReviewOf = (d: Drafted): ReviewedFolder => {
	const plan = plainPlan(Drafted.resultOf(d))
	return { files: d.files, run: (schema, state, value) => interpret(schema, state, plan, value) }
}

/** The candidates a reviewer who makes `renames` chooses: each whose own rename renames a relation or a field as they do
 * (`chosenCandidates`), by the physical names of the versions drafted from and to. */
export const chosenFor = (
	d: Drafted,
	renames: Renames,
	before: RealInstallPlan,
	after: RealInstallPlan
): ReadonlySet<number> => chosenCandidates(Drafted.resultOf(d), renames, before, after)

/** A finding of `grizzle check` on a reviewed folder: a marker left, a decision split, orphaned or made twice, or a loss
 * unresolved, with its file. */
export interface Finding {
	readonly kind: "marker" | "split" | "orphan" | "twice" | "unresolved loss"
	readonly file: string
}

export const checkOf = (d: Drafted, files: ReadonlyArray<TextFile>): ReadonlyArray<Finding> => {
	const decisions = succeeded(
		readDecisions(Drafted.resultOf(d).folder.meta.decisions),
		`${d.folder}'s meta.json`
	)
	return [
		...Arr.flatMap(files, (f) =>
			Arr.map(findMarkers(f.text), (): Finding => ({ kind: "marker", file: f.name }))
		),
		...Arr.map(splitRenames(decisions, files), (r): Finding => ({ kind: r.kind, file: r.file })),
		...Arr.flatMap(lossDecisions(decisions, files), (l): ReadonlyArray<Finding> =>
			l.kind === "unresolved" ? [{ kind: "unresolved loss", file: l.loss.file }] : []
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
