import { Array as Arr, Order, Result, Schema } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Identity } from "#compiler/core/identity.ts"
import * as EngineResult from "#compiler/core/result.ts"
import { type CandidatePath, candidatesOf, pathOf, samePath } from "#compiler/deploy/diff/plan.ts"
import { lossDecisions, splitRenames } from "#compiler/deploy/render/chosen.ts"
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
	choosable,
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
 * the fields a reviewer's decisions name (each candidate by its path, each loss of stored data where it stands, with
 * its carriers by path), and its snapshot's fingerprint. A review is the one reviewer's, whose files are text; it runs on the catalog
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

/** Where a loss is: at the top of its file, or in the alternative of a candidate rename, by its path. */
export type LossWithin =
	| { readonly kind: "top" }
	| { readonly kind: "within"; readonly candidate: CandidatePath }

/** A loss as meta.json records it: its file, where it is, what it loses, its statement, and the candidates that carry it
 * instead, by path. */
export interface DraftedLoss {
	readonly file: string
	readonly within: LossWithin
	readonly loses: LossView
	readonly statement: string
	readonly carriers: ReadonlyArray<CandidatePath>
}

/** Whether a decision, by path, holds a candidate. */
export const holdsPath = (chosen: ReadonlyArray<CandidatePath>, path: CandidatePath): boolean =>
	Arr.some(chosen, (p) => samePath(p, path))

/** A drafted folder as the command line writes it. */
interface DraftedView {
	readonly change: "none" | "schema"
	readonly fingerprint: string
	/** The committed snapshot the next draft continues. */
	readonly next: Previous
	readonly folder: string
	readonly files: ReadonlyArray<TextFile>
	readonly candidates: ReadonlyArray<CandidatePath>
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
	readonly candidates: ReadonlyArray<CandidatePath>
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
const Ends = { removed: Text, added: Text } as const
const RelationPathRead = Schema.Struct({ kind: Schema.Literal("relation"), ...Ends })
const PathRead = Schema.Union([
	RelationPathRead,
	Schema.Struct({ kind: Schema.Literal("type"), ...Ends }),
	Schema.Struct({ kind: Schema.Literal("login"), ...Ends }),
	Schema.Struct({ kind: Schema.Literal("field"), relation: Text, ...Ends }),
	Schema.Struct({ kind: Schema.Literal("nested field"), parent: RelationPathRead, ...Ends })
])

/** What a root's rename offer renames that is no relation, as the door reads it. */
const RootRenamesRead = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("type"), ...Ends }),
	Schema.Struct({ kind: Schema.Literal("login"), ...Ends }),
	Schema.Struct({ kind: Schema.Literal("field"), relation: Text, ...Ends })
])

const LossesRead = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("relation"), relation: Text }),
	Schema.Struct({ kind: Schema.Literal("field"), relation: Text, field: Text }),
	Schema.Struct({ kind: Schema.Literal("schema"), schema: Text })
])

const PlainRead = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("replace") }),
	Schema.Struct({ kind: Schema.Literal("delete") })
])

/** The steps of one place of meta.json's record as the door reads them: only what a reviewer's decisions name. */
const stepsRead = <O, E>(offer: Schema.Codec<O, E>) =>
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("statement") }),
		Schema.Struct({ kind: Schema.Literal("choice"), offers: Schema.Array(offer) }),
		Schema.Struct({
			kind: Schema.Literal("loss"),
			loses: LossesRead,
			statement: Text,
			carriers: Schema.Array(PathRead)
		}),
		Schema.Struct({ kind: Schema.Literal("confirm") })
	])

const SealedRead = stepsRead(PlainRead)
const NestedRead = Schema.Struct({
	kind: Schema.Literal("nested rename"),
	...Ends,
	alternative: Schema.Array(SealedRead)
})
const RelationStepsRead = stepsRead(Schema.Union([NestedRead, PlainRead]))
const TopRead = stepsRead(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("rename"),
			renames: RootRenamesRead,
			alternative: Schema.Array(SealedRead)
		}),
		Schema.Struct({
			kind: Schema.Literal("relation rename"),
			...Ends,
			alternative: Schema.Array(RelationStepsRead)
		}),
		PlainRead
	])
)

const MetaRead = Schema.Struct({
	files: Schema.Array(Schema.Struct({ name: Text, steps: Schema.Array(TopRead) }))
})
const decodeMeta = Schema.decodeUnknownResult(Schema.fromJsonString(MetaRead))

/** What meta.json's record names that a reviewer decides, walked in draft order: every candidate by its path, the
 * confirmed groups, and every loss where it stands. */
interface MetaView {
	readonly candidates: ReadonlyArray<CandidatePath>
	readonly confirms: number
	readonly losses: ReadonlyArray<DraftedLoss>
}

type FilesRead = (typeof MetaRead.Type)["files"]

/** A step of any place, as the door reads it. */
type StepRead = typeof TopRead.Type | typeof RelationStepsRead.Type | typeof SealedRead.Type

const metaView = (files: FilesRead): MetaView => {
	const candidates: Array<CandidatePath> = []
	const losses: Array<DraftedLoss> = []
	let confirms = 0
	/** The steps of one place, each loss within the rename whose alternative holds it, and each offer's own rename at its
	 * path, read by `named`, which reads a relation's alternative in turn. */
	const walk = (file: string, steps: ReadonlyArray<StepRead>, within: LossWithin): void => {
		for (const s of steps) {
			switch (s.kind) {
				case "statement":
					break
				case "confirm":
					confirms++
					break
				case "loss":
					losses.push({
						file,
						within,
						loses: s.loses,
						statement: s.statement,
						carriers: s.carriers
					})
					break
				case "choice":
					for (const o of s.offers) {
						switch (o.kind) {
							case "relation rename": {
								const path: CandidatePath = { kind: "relation", removed: o.removed, added: o.added }
								candidates.push(path)
								for (const a of o.alternative) {
									if (a.kind === "choice") {
										for (const n of a.offers) {
											if (n.kind === "nested rename") {
												const nested: CandidatePath = {
													kind: "nested field",
													parent: path,
													removed: n.removed,
													added: n.added
												}
												candidates.push(nested)
												walk(file, n.alternative, { kind: "within", candidate: nested })
											}
										}
									}
								}
								walk(file, o.alternative, { kind: "within", candidate: path })
								break
							}
							case "rename":
								candidates.push(o.renames)
								walk(file, o.alternative, { kind: "within", candidate: o.renames })
								break
							case "nested rename":
							case "replace":
							case "delete":
								break
						}
					}
					break
			}
		}
	}
	for (const f of files) {
		walk(f.name, f.steps, { kind: "top" })
	}
	return { candidates, confirms, losses }
}

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
	const meta = metaView(succeeded(decodeMeta(g.folder.metaText), `the meta.json of ${name}`).files)
	return new Drafted(
		{
			change: g.change,
			fingerprint: g.snapshot.fingerprint,
			next: fromSnapshot(g.snapshot),
			folder: g.folder.name,
			files: g.folder.files,
			candidates: meta.candidates,
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

/** What a reviewer decides: the candidates it chooses, by path; each loss no chosen candidate carries, written in or
 * left; and each placeholder's SQL text. */
export interface ReviewChoices {
	readonly chosen: ReadonlyArray<CandidatePath>
	readonly losses: LossReview
	readonly value: (placeholder: Placeholder) => string
}

/** A review two chosen candidates make inexpressible, naming them by path. */
interface Inexpressible {
	readonly candidates: ReadonlyArray<CandidatePath>
}

export const reviewOf = (
	d: Drafted,
	choices: ReviewChoices
): Result.Result<ReviewedFolder, Inexpressible> => {
	const g = Drafted.resultOf(d)
	const chosen = new Set(
		Arr.filter(candidatesOf(g.plan), (c) => holdsPath(choices.chosen, pathOf(c)))
	)
	const reviewed = review(g, { chosen, losses: choices.losses, value: choices.value })
	if (Result.isFailure(reviewed)) {
		return Result.fail({
			candidates: Arr.map(reviewed.failure.candidates, (c) => pathOf(c))
		})
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

/** The candidates a reviewer who makes `renames` chooses, by path: each whose own rename renames a relation or a field
 * as they do (`chosenCandidates`), by the physical names of the versions drafted from and to. */
export const chosenFor = (
	d: Drafted,
	renames: Renames,
	before: RealInstallPlan,
	after: RealInstallPlan
): ReadonlyArray<CandidatePath> =>
	Arr.map([...chosenCandidates(Drafted.resultOf(d), renames, before, after)], (c) => pathOf(c))

/** Every decision a reviewer may make of a draft's candidates (the review kit's `choosable`, the documented rules), each
 * by path. */
export const choosableOf = (d: Drafted): ReadonlyArray<ReadonlyArray<CandidatePath>> =>
	Arr.map(choosable(Drafted.resultOf(d)), (chosen) => Arr.map([...chosen], (c) => pathOf(c)))

/** A finding of `grizzle check` on a reviewed folder: a marker left, a decision split, orphaned or made twice, or a loss
 * unresolved, with its file. */
export interface Finding {
	readonly kind: "marker" | "split" | "orphan" | "twice" | "unresolved loss"
	readonly file: string
}

export const checkOf = (d: Drafted, files: ReadonlyArray<TextFile>): ReadonlyArray<Finding> => {
	const record = Drafted.resultOf(d).record
	return [
		...Arr.flatMap(files, (f) =>
			Arr.map(findMarkers(f.text), (): Finding => ({ kind: "marker", file: f.name }))
		),
		...Arr.map(splitRenames(record, files), (r): Finding => ({ kind: r.kind, file: r.file })),
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
