/**
 * A write as its one flight runs it, as data, and as an application runs it.
 *
 * A compiled write (compile.ts CompiledWrite) holds its whole front end, every statement's AST and the plan it was
 * built from; an application reads only part of it. `ServedWrite` is that part as data: records, arrays, strings,
 * numbers, booleans, bigints, Maps, Sets and ScalarTypes, no function, AST or Codebook, so a served file holds it
 * (served/forms.ts ServedChange) and a running layer reads nothing else. `FlightWrite` is a ServedWrite loaded under the
 * installation's codes (`loadWrite`): every encoder and identity it runs, rebuilt from the data by the constructors the
 * compile path runs it through too. Every application loads its write so, a write compiled in process as much as a
 * served one, so what the file holds is exactly what an application reads.
 *
 * A write whose family work the host plans from a read flight (bind.ts Flights `read`) is no served write: its plan reads
 * the compiled front end itself. `servedWrite` refuses it, naming each such shape (`UnservedShape`).
 */
import { maxOf } from "#compiler/core/array.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { ParamDecl, WriteSlot } from "#compiler/ir/products.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { oneForm, type StatementForms } from "#compiler/lower/shapes/index.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { writeSlotOf } from "#compiler/lower/template.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { ArtifactForms, OwnStep } from "#compiler/write/program/artifact.ts"
import type { Binding } from "#compiler/write/program/binding.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import {
	type OutcomeContext,
	type WrittenHeading,
	writtenOutcome
} from "#compiler/write/program/outcome.ts"
import type { Staged } from "#compiler/write/program/staged.ts"

/** A form of a write statement as an execution sends it: its text, and what fills each placeholder, $n by
 * `params[n - 1]`. */
export interface ServedWriteForm {
	readonly sql: EmittedText
	readonly params: ReadonlyArray<WriteParamSlot>
}

/**
 * A per-execution choice of a statement's form: the relation parameter whose distinct fact count decides it, and the
 * threshold above which the statement's whole-relation form is sent (lower/shapes/take runsLargeForm).
 */
export interface ServedWriteChoice {
	readonly source: RelationInput
	readonly threshold: number
}

/**
 * One statement of a write's flight: its step, which says what its rows are and when an application skips it, its own
 * form, and its whole-relation form beside it when per-execution choices pick between the two.
 */
export interface ServedStatement {
	readonly step: OwnStep
	readonly form: ServedWriteForm
	readonly forms: StatementForms<ServedWriteChoice, ServedWriteForm>
	/** How its nested rows travel past one Bind message (staged.ts Staged). */
	readonly staged: Staged
}

/**
 * A write as its flight runs it, as data: its declared parameters, which an application admits and its read-backs
 * read; what binding an application reads besides its values (binding.ts Binding); its statements, in the order the
 * flight sends them; and the relations it writes, in code point order, whose facts its rows net by identity.
 */
export interface ServedWrite {
	readonly params: ReadonlyArray<ParamDecl>
	readonly binding: Binding
	readonly statements: ReadonlyArray<ServedStatement>
	readonly written: ReadonlyArray<WrittenHeading>
}

/** A form of a statement as an application sends it: its text and the encoder of each placeholder. */
export interface FlightForm {
	readonly sql: EmittedText
	readonly paramSlots: ReadonlyArray<WriteSlot>
}

/** A statement of a loaded write: its position in the flight, its step, and its forms with their encoders. */
export interface FlightStatement {
	readonly index: number
	readonly step: OwnStep
	readonly form: FlightForm
	readonly forms: StatementForms<ServedWriteChoice, FlightForm>
	readonly staged: Staged
}

/** A ServedWrite loaded under the installation's codes: its statements with their encoders, and what reads its rows. */
export interface FlightWrite {
	readonly params: ReadonlyArray<ParamDecl>
	readonly binding: Binding
	readonly statements: ReadonlyArray<FlightStatement>
	readonly outcome: OutcomeContext
}

/**
 * A family write the host plans from a read flight, which no served write holds: a stratum's edit of a member relation;
 * a stratum's refill, with the families it draws again, whether a path of it reads a tree, and the most owner axes one
 * path of it rides; or a stratum's nested writes whose families the host plans.
 */
export type UnservedShape =
	| { readonly kind: "edit"; readonly stratum: StratumAt; readonly relation: string }
	| {
			readonly kind: "refill"
			readonly stratum: StratumAt
			readonly families: ReadonlyArray<FamilyId>
			readonly tree: boolean
			readonly hops: number
	  }
	| { readonly kind: "nested"; readonly stratum: StratumAt }

/** A write no served file holds: each shape of it the host plans from a read flight. */
export interface UnservedMember {
	readonly _tag: "UnservedMember"
	readonly shapes: NonEmptyReadonlyArray<UnservedShape>
}

/** A form's data: its text and placeholders. */
const servedWriteForm = (form: {
	readonly sql: EmittedText
	readonly params: ReadonlyArray<WriteParamSlot>
}): ServedWriteForm => Object.freeze({ sql: form.sql, params: form.params })

/** A statement's forms as data: one, or the choices that pick between its own form and its whole-relation one. */
const servedForms = (forms: ArtifactForms): StatementForms<ServedWriteChoice, ServedWriteForm> =>
	forms.kind === "one"
		? oneForm
		: Object.freeze({
				kind: "chosen",
				choices: mapNonEmpty(forms.choices, (c) =>
					Object.freeze({ source: c.source, threshold: c.threshold })
				),
				large: servedWriteForm(forms.large)
			})

/**
 * The data an application of `compiled` reads (`ServedWrite`): its declared parameters, its binding, its statements but
 * the read-backs', which the read-backs' own programs run, and its written relations' headings.
 */
export const projectWrite = (compiled: CompiledWrite): ServedWrite =>
	Object.freeze({
		params: compiled.params,
		binding: compiled.binding,
		statements: Object.freeze(
			compiled.artifact.statements.flatMap((s): ReadonlyArray<ServedStatement> => {
				const step = s.step
				return step.kind === "readBack"
					? []
					: [
							Object.freeze({
								step,
								form: servedWriteForm({ sql: s.spec.sql, params: s.spec.paramSlots }),
								forms: servedForms(s.forms),
								staged: s.staged
							})
						]
			})
		),
		written: Object.freeze(
			compiled.frontend.written.map((r) =>
				Object.freeze({
					relation: r.name,
					heading: Object.freeze(
						r.heading.map((f) => Object.freeze({ name: f.name, type: f.type }))
					)
				})
			)
		)
	})

/**
 * The shapes of `compiled` the host plans from a read flight: each edit and refill program, and each stratum with
 * family steps the host plans that neither names, its nested writes'.
 */
const unservedShapes = (compiled: CompiledWrite): ReadonlyArray<UnservedShape> => {
	const programmed = new Set<StratumAt>([
		...compiled.edits.map((e) => e.edit.stratum),
		...compiled.refills.map((r) => r.stratum)
	])
	const planned = new Set(
		compiled.artifact.steps.flatMap((step) =>
			step.kind === "family" && !programmed.has(step.stratum) ? [step.stratum] : []
		)
	)
	return [
		...compiled.edits.map((e): UnservedShape => ({
			kind: "edit",
			stratum: e.edit.stratum,
			relation: e.target.relation.name
		})),
		...compiled.refills.map((r): UnservedShape => ({
			kind: "refill",
			stratum: r.stratum,
			families: r.refill.closure.refills.map((f) => f.id),
			tree: r.refill.closure.paths.some((p) => p.reader.family.members.kind === "tree"),
			hops: maxOf(
				r.refill.closure.paths.map((p) => p.copies.length),
				0
			)
		})),
		...[...planned].map((stratum): UnservedShape => ({ kind: "nested", stratum }))
	]
}

/** `compiled` as a served file holds it, or its refusal where the host plans some of its family work from a read
 * flight (`UnservedMember`). */
export const servedWrite = (
	compiled: CompiledWrite
): Result.Result<ServedWrite, UnservedMember> => {
	const shapes = unservedShapes(compiled)
	return isNonEmpty(shapes)
		? Result.err({ _tag: "UnservedMember", shapes })
		: Result.ok(projectWrite(compiled))
}

/** A served write as an application runs it under the installation's codes: each placeholder with its encoder
 * (lower/template.ts writeSlotOf), each written relation with its facts' identity. */
export const loadWrite = (served: ServedWrite, codes: Codebook): FlightWrite => {
	const slotOf = writeSlotOf(codes)
	const loaded = (form: ServedWriteForm): FlightForm =>
		Object.freeze({ sql: form.sql, paramSlots: Object.freeze(form.params.map(slotOf)) })
	return Object.freeze({
		params: served.params,
		binding: served.binding,
		statements: Object.freeze(
			served.statements.map((s, index): FlightStatement =>
				Object.freeze({
					index,
					step: s.step,
					form: loaded(s.form),
					forms:
						s.forms.kind === "one"
							? oneForm
							: Object.freeze({
									kind: "chosen",
									choices: s.forms.choices,
									large: loaded(s.forms.large)
								}),
					staged: s.staged
				})
			)
		),
		outcome: Object.freeze({
			written: Object.freeze(served.written.map(writtenOutcome(codes))),
			codes
		})
	})
}

/** A write compiled in process as an application runs it: projected and loaded, as a served one is. */
export const flightOf = (compiled: CompiledWrite, codes: Codebook): FlightWrite =>
	loadWrite(projectWrite(compiled), codes)

/** The form of a statement an application sends: its whole-relation form when it runs some per-execution choice large
 * (`runsLarge`, by the distinct fact count of the relation parameter the choice reads), its own otherwise. */
export const sentForm = (
	statement: FlightStatement,
	runsLarge: (choice: ServedWriteChoice) => boolean
): FlightForm =>
	statement.forms.kind === "chosen" && statement.forms.choices.some((c) => runsLarge(c))
		? statement.forms.large
		: statement.form
