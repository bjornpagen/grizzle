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
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { type Prepared, prepared, type StatementName } from "#compiler/core/prepared.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { NeededInput } from "#compiler/ir/needs.ts"
import type { CallerParamDecl, WriteSlot } from "#compiler/ir/products.ts"
import type { ServedSlot, WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { oneForm, type StatementForms } from "#compiler/runtime/lower/forms.ts"
import { writeSlotOf } from "#compiler/runtime/lower/slots.ts"
import {
	type Binding,
	type PreparedBinding,
	prepareBinding
} from "#compiler/runtime/write/binding.ts"
import type { ClosedTable } from "#compiler/runtime/write/fill.ts"
import {
	type OutcomeContext,
	type WrittenHeading,
	writtenOutcome
} from "#compiler/runtime/write/outcome.ts"
import {
	assembled,
	type Parted,
	sentUnits,
	type WriteText
} from "#compiler/runtime/write/parted.ts"
import type { PreparedStaged } from "#compiler/runtime/write/staged.ts"
import type { OwnStep } from "#compiler/runtime/write/steps.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"

/** A form of a write statement as an execution sends it: its text with its name (core/prepared.ts), and what fills
 * each placeholder, $n by `params[n - 1]`. */
export interface ServedWriteForm {
	readonly text: Prepared<EmittedText>
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

/** A single statement's form as data: its text by its units, each placeholder's slot as data (parted.ts). */
export type ServedPartedForm = Parted<ServedSlot<WriteParamSlot>>

/**
 * One statement of a write's flight: its step, which says what its rows are and when an application skips it, its own
 * form, and its whole-relation form beside it when per-execution choices pick between the two; each form `whole`, one
 * text, with how its nested rows travel past one Bind message (staged.ts PreparedStaged), or `parted`, a single
 * statement's by its units, which reads no nested rows (parted.ts).
 */
export type ServedStatement =
	| {
			readonly kind: "whole"
			readonly step: OwnStep
			readonly form: ServedWriteForm
			readonly forms: StatementForms<ServedWriteChoice, ServedWriteForm>
			readonly staged: PreparedStaged
	  }
	| {
			readonly kind: "parted"
			readonly step: OwnStep
			readonly form: ServedPartedForm
			readonly forms: StatementForms<ServedWriteChoice, ServedPartedForm>
	  }

/**
 * What a write's transaction locks before any of its statements takes the transaction's snapshot: nothing, or the
 * relations its login fences that its flight writes (analysis/isolation/certify.ts Fence), each IN EXCLUSIVE MODE by
 * one LOCK TABLE, named as a served statement is, the relations in the order of their qualified table names, the one
 * order every fenced write locks in. The login sends it itself, between its prologue's fence and the statement that
 * takes the snapshot (adapter wire/batch.ts Frame), since a LOCK takes no snapshot (PostgreSQL 19 tcop/pquery.c
 * PlannedStmtRequiresSnapshot), and SET ROLE could not precede it as a served text: a role's installed name is a
 * variable of the installation, and set_config, which enters it, is a SELECT that takes the snapshot. The installation
 * grants the login MAINTAIN on each fenced relation, which permits the lock.
 */
export type WriteExclusion =
	| { readonly kind: "none" }
	| {
			readonly kind: "lock"
			readonly relations: NonEmptyReadonlyArray<string>
			readonly text: Prepared<EmittedText>
	  }

/** A write that locks nothing before its snapshot. */
export const noExclusion: WriteExclusion = Object.freeze({ kind: "none" })

/**
 * A session object a write's flight reads or writes, which the session's stand-up of the write makes, `T` each of its
 * texts: `carrier`, a carrier's table and its emptying, a session function of the carrier's own name
 * (write/carriers/carriers.ts carrierStandUp), each made as the write's role, which alone may empty it; or `judged`, the
 * call of the rule judge's stand-up of a table the write writes (physical/ddl/rules.ts addStandUps), which makes the
 * judge's session tables a write of the table needs, as the judge's definer.
 *
 * A session runs a write's stand-ups once, in one transaction of its own before its first call of the write, the ones it
 * has not run yet (adapter apply/stand-up.ts): no transaction of a call makes a relation, so the plans its statements
 * make outlive their call, where a relation made inside the call's transaction is a catalog change the session reads
 * at its next transaction, which made every plan over it again (metis's assign planned 98 statements again at its second
 * call). A session keeps the stand-ups it ran by their first text's name (`standUpName`), so one two writes share runs
 * once a session.
 */
export type StandUp<T> =
	| { readonly kind: "carrier"; readonly table: T; readonly emptying: T }
	| { readonly kind: "judged"; readonly call: T }

/** A stand-up as a served write holds it (StandUp), every text named (core/prepared.ts). */
export type ServedStandUp = StandUp<Prepared<EmittedText>>

/** The texts a stand-up sends, in order: a carrier's table, then its emptying; a judged table's call. */
export const standUpTexts = <T>(standUp: StandUp<T>): NonEmptyReadonlyArray<T> =>
	standUp.kind === "carrier" ? [standUp.table, standUp.emptying] : [standUp.call]

/** The name a session keeps a stand-up it ran by: its first text's (`standUpTexts`). */
export const standUpName = (standUp: ServedStandUp): StatementName => standUpTexts(standUp)[0].name

/**
 * A write as its flight runs it, as data: its declared parameters, which an application admits and its read-backs
 * read; what binding an application reads besides its values (binding.ts Binding); what its transaction locks before
 * its snapshot; the session objects its flight reads and writes, which its session stands up once before its first call
 * (StandUp), carriers first, in the order its statements name them, then the judged tables it writes, in code point
 * order; its statements, in the order the flight sends them; and the relations it writes, in code point order, whose
 * facts its rows net by identity.
 */
export interface ServedWrite {
	readonly params: ReadonlyArray<CallerParamDecl>
	readonly binding: Binding
	readonly exclusion: WriteExclusion
	readonly standUps: ReadonlyArray<ServedStandUp>
	readonly statements: ReadonlyArray<ServedStatement>
	readonly written: ReadonlyArray<WrittenHeading>
}

/** A form of a statement as an application sends it: its named text and the encoder of each placeholder. */
export interface FlightForm {
	readonly text: Prepared<WriteText>
	readonly paramSlots: ReadonlyArray<WriteSlot>
}

/**
 * A single statement's form loaded: the form a call sends where `holdsFact` says which of its inputs hold a fact, of
 * the units it sends (parted.ts sentUnits), none where it sends none.
 */
export interface PartedFlight {
	readonly sentFor: (holdsFact: (input: NeededInput) => boolean) => FlightForm | undefined
	/**
	 * Whether a call's facts may be cut into executions of a share each (bind.ts batchedExecutions): every unit sent
	 * with every part, a shared sub-query or a riding read-back, reads no fact of the call and delivers no row, so each
	 * execution's parts read what the whole statement's would of their own facts.
	 */
	readonly cuttable: boolean
}

/**
 * The loaded form of `parted`, its units each placeholder with its encoder: each set of units a call sends assembles
 * into its form (parted.ts assembled), named as every served text is (core/prepared.ts), once, the first time a call
 * sends it, and kept for every later call that sends the same units.
 */
const partedFlight = (parted: Parted<WriteSlot>): PartedFlight => {
	const forms = new Map<string, FlightForm>()
	return Object.freeze({
		cuttable: parted.units.every(
			(unit) =>
				unit.kind === "part" ||
				(unit.arms.length === 0 && unit.params.every((slot) => slot.kind === "scalar"))
		),
		sentFor: (holdsFact: (input: NeededInput) => boolean): FlightForm | undefined => {
			const sent = sentUnits(parted, holdsFact)
			if (sent === undefined) {
				return undefined
			}
			const known = forms.get(sent.key)
			if (known !== undefined) {
				return known
			}
			const { text, params } = assembled(sent.units)
			const form: FlightForm = Object.freeze({ text: prepared(text), paramSlots: params })
			forms.set(sent.key, form)
			return form
		}
	})
}

/** A statement of a loaded write: its position in the flight, its step, and its forms with their encoders (ServedStatement). */
export type FlightStatement =
	| {
			readonly kind: "whole"
			readonly index: number
			readonly step: OwnStep
			readonly form: FlightForm
			readonly forms: StatementForms<ServedWriteChoice, FlightForm>
			readonly staged: PreparedStaged
	  }
	| {
			readonly kind: "parted"
			readonly index: number
			readonly step: OwnStep
			readonly form: PartedFlight
			readonly forms: StatementForms<ServedWriteChoice, PartedFlight>
	  }

/**
 * A ServedWrite loaded under the installation's codes: its declared parameters, its binding and the binding's closures
 * (binding.ts prepareBinding), the codes its values are parsed and encoded under, what its transaction locks before its
 * snapshot, the session objects its session stands up before its first call (StandUp), its statements with their
 * encoders, and what reads its rows.
 */
export interface FlightWrite {
	readonly params: ReadonlyArray<CallerParamDecl>
	readonly binding: Binding
	readonly exclusion: WriteExclusion
	readonly standUps: ReadonlyArray<ServedStandUp>
	readonly prepared: PreparedBinding
	readonly codes: Codebook
	readonly statements: ReadonlyArray<FlightStatement>
	readonly outcome: OutcomeContext
}

/** A served write as an application runs it under the installation's codes, closed table and patterns: its binding's
 * closures, each placeholder with its encoder (lower/template.ts writeSlotOf), each written relation with its facts'
 * identity. */
export const loadWrite = (
	served: ServedWrite,
	codes: Codebook,
	closed: ClosedTable,
	patterns: PatternReads
): FlightWrite => {
	const slotOf = writeSlotOf(codes)
	const loaded = (form: ServedWriteForm): FlightForm =>
		Object.freeze({ text: form.text, paramSlots: Object.freeze(form.params.map(slotOf)) })
	const loadedParted = (form: ServedPartedForm): PartedFlight =>
		partedFlight(
			Object.freeze({
				units: mapNonEmpty(form.units, (unit) =>
					Object.freeze({ ...unit, params: Object.freeze(unit.params.map(slotOf)) })
				)
			})
		)
	/** A served statement at `index` of its flight, loaded: its forms with their encoders. */
	const loadedStatement = (s: ServedStatement, index: number): FlightStatement => {
		switch (s.kind) {
			case "whole":
				return Object.freeze({
					kind: "whole",
					index,
					step: s.step,
					form: loaded(s.form),
					forms: formsOf(s.forms, loaded),
					staged: s.staged
				})
			case "parted":
				return Object.freeze({
					kind: "parted",
					index,
					step: s.step,
					form: loadedParted(s.form),
					forms: formsOf(s.forms, loadedParted)
				})
		}
	}
	const formsOf = <F, L>(
		forms: StatementForms<ServedWriteChoice, F>,
		load: (form: F) => L
	): StatementForms<ServedWriteChoice, L> =>
		forms.kind === "one"
			? oneForm
			: Object.freeze({ kind: "chosen", choices: forms.choices, large: load(forms.large) })
	return Object.freeze({
		params: served.params,
		binding: served.binding,
		exclusion: served.exclusion,
		standUps: served.standUps,
		prepared: prepareBinding(served.binding, codes, closed, patterns),
		codes,
		statements: Object.freeze(served.statements.map(loadedStatement)),
		outcome: Object.freeze({
			written: Object.freeze(served.written.map(writtenOutcome(codes))),
			codes
		})
	})
}

/** The form of a statement an application sends: its whole-relation form when it runs some per-execution choice large
 * (`runsLarge`, by the distinct fact count of the relation parameter the choice reads), its own otherwise. */
export const sentForm = <F>(
	statement: {
		readonly form: F
		readonly forms: StatementForms<ServedWriteChoice, F>
	},
	runsLarge: (choice: ServedWriteChoice) => boolean
): F =>
	statement.forms.kind === "chosen" && statement.forms.choices.some((c) => runsLarge(c))
		? statement.forms.large
		: statement.form
