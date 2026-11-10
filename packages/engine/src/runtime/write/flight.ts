/**
 * A write as its one flight runs it, as data, and as an application runs it.
 *
 * `ServedWrite` is what an application of a compiled write reads (write/program/served.ts projectWrite), as data:
 * records, arrays, strings, numbers, booleans, bigints, Maps, Sets and ScalarTypes, no function, AST or Codebook, so a
 * served file holds it (served/forms.ts ServedChange) and a running layer reads nothing else. `FlightWrite` is a
 * ServedWrite loaded under the installation's codes (`loadWrite`): every encoder and identity it runs, rebuilt from the
 * data by the constructors the compile path runs it through too. Every application loads its write so, a write compiled
 * in process as much as a served one, so what the file holds is exactly what an application reads.
 */
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ParamDecl, WriteSlot } from "#compiler/ir/products.ts"
import type { ServedSlot, WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { oneForm, type StatementForms } from "#compiler/runtime/lower/forms.ts"
import { writeSlotOf } from "#compiler/runtime/lower/slots.ts"
import {
	type Binding,
	type PreparedBinding,
	prepareBinding
} from "#compiler/runtime/write/binding.ts"
import {
	type OutcomeContext,
	type WrittenHeading,
	writtenOutcome
} from "#compiler/runtime/write/outcome.ts"
import type { Staged } from "#compiler/runtime/write/staged.ts"
import type { OwnStep } from "#compiler/runtime/write/steps.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"

/** A form of a write statement as an execution sends it: its text, and what fills each placeholder, $n by
 * `params[n - 1]`. */
export interface ServedWriteForm {
	readonly sql: EmittedText
	readonly params: ReadonlyArray<ServedSlot<WriteParamSlot>>
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

/**
 * A ServedWrite loaded under the installation's codes: its declared parameters, its binding and the binding's closures
 * (binding.ts prepareBinding), the codes its values are admitted and encoded under and the patterns its refined values
 * are judged by, its statements with their encoders, and what reads its rows.
 */
export interface FlightWrite {
	readonly params: ReadonlyArray<ParamDecl>
	readonly binding: Binding
	readonly prepared: PreparedBinding
	readonly codes: Codebook
	readonly patterns: PatternReads
	readonly statements: ReadonlyArray<FlightStatement>
	readonly outcome: OutcomeContext
}

/** A served write as an application runs it under the installation's codes: its binding's closures, each placeholder
 * with its encoder (lower/template.ts writeSlotOf), each written relation with its facts' identity. */
export const loadWrite = (
	served: ServedWrite,
	codes: Codebook,
	patterns: PatternReads
): FlightWrite => {
	const slotOf = writeSlotOf(codes, patterns)
	const loaded = (form: ServedWriteForm): FlightForm =>
		Object.freeze({ sql: form.sql, paramSlots: Object.freeze(form.params.map(slotOf)) })
	return Object.freeze({
		params: served.params,
		binding: served.binding,
		prepared: prepareBinding(served.binding, codes, patterns),
		codes,
		patterns,
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

/** The form of a statement an application sends: its whole-relation form when it runs some per-execution choice large
 * (`runsLarge`, by the distinct fact count of the relation parameter the choice reads), its own otherwise. */
export const sentForm = (
	statement: FlightStatement,
	runsLarge: (choice: ServedWriteChoice) => boolean
): FlightForm =>
	statement.forms.kind === "chosen" && statement.forms.choices.some((c) => runsLarge(c))
		? statement.forms.large
		: statement.form
