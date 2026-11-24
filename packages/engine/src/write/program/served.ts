/**
 * A compiled write as a served file holds it (runtime/write/flight.ts ServedWrite): `projectWrite` takes from the
 * compiled program exactly what an application reads, and `flightOf` loads it as an application of a write compiled in
 * process runs it, so every application runs the served form.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { prepared } from "#compiler/core/prepared.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type CallerParamDecl, callerParams, type ClockParamDecl } from "#compiler/ir/products.ts"
import type {
	RelationColumn,
	ServedSlot,
	SlotColumn,
	WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import { oneForm, type StatementForms } from "#compiler/runtime/lower/forms.ts"
import type { HostBinding } from "#compiler/runtime/write/bind.ts"
import { type Binding, prepareBinding } from "#compiler/runtime/write/binding.ts"
import type { ClosedTable } from "#compiler/runtime/write/fill.ts"
import {
	type FlightWrite,
	loadWrite,
	type ServedPartedForm,
	type ServedStandUp,
	type ServedStatement,
	type ServedWrite,
	type ServedWriteChoice,
	type ServedWriteForm,
	type WriteExclusion
} from "#compiler/runtime/write/flight.ts"
import type { PreparedStaged, Staged } from "#compiler/runtime/write/staged.ts"
import type { OwnStep, UniqueAbort } from "#compiler/runtime/write/steps.ts"
import { CompilePatterns, type PatternReads } from "#compiler/scalar/regex/patterns.ts"
import type { ServedReadBack } from "#compiler/served/read.ts"
import { servedReadBacks } from "#compiler/served/spine.ts"
import type { EmittedText, SqlStatement } from "#compiler/sql/ast.ts"
import type { CarrierColumn } from "#compiler/write/carriers/carriers.ts"
import type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
import type {
	ArtifactForms,
	ArtifactStatement,
	FormText,
	SentForm
} from "#compiler/write/program/artifact.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { decideBinding } from "#compiler/write/program/decide.ts"
import { partedOf } from "#compiler/write/program/single.ts"

/** A relation input's column as its encoder reads it: its name and type. */
const slotColumn = (column: RelationColumn): SlotColumn =>
	Object.freeze({ name: column.name, type: column.type })

/** A placeholder as a served file holds it (ServedSlot): each column of a relation input its name and type. */
const servedWriteSlot = (slot: WriteParamSlot): ServedSlot<WriteParamSlot> => {
	switch (slot.kind) {
		case "scalar":
			return slot
		case "relation":
		case "member":
		case "nestedRows":
			return Object.freeze({ ...slot, columns: Object.freeze(slot.columns.map(slotColumn)) })
	}
}

/** A statement's staged form with each of its texts named, where generate serves its write. */
const preparedStaged = (staged: Staged): PreparedStaged =>
	staged.kind === "none"
		? staged
		: Object.freeze({
				kind: "carriers",
				carriers: mapNonEmpty(staged.carriers, (carrier) =>
					Object.freeze({
						empty: prepared(carrier.empty),
						fill: prepared(carrier.fill),
						columns: carrier.columns
					})
				),
				sql: prepared(staged.sql),
				kept: staged.kept
			})

/** A form's data: its text, named here (core/prepared.ts), and its placeholders. */
const servedWriteForm = (form: {
	readonly sql: EmittedText
	readonly params: ReadonlyArray<WriteParamSlot>
}): ServedWriteForm =>
	Object.freeze({
		text: prepared(form.sql),
		params: Object.freeze(form.params.map(servedWriteSlot))
	})

/** A statement's forms as data: one, or the choices that pick between its own form and its whole-relation one, each
 * form as `served` serves it. */
const servedForms = <F>(
	forms: ArtifactForms,
	served: (large: SentForm) => F
): StatementForms<ServedWriteChoice, F> =>
	forms.kind === "one"
		? oneForm
		: Object.freeze({
				kind: "chosen",
				choices: mapNonEmpty(forms.choices, (c) =>
					Object.freeze({ source: c.source, threshold: c.threshold })
				),
				large: served(forms.large)
			})

/** A single statement's form as data: its text by its units (write/program/single.ts partedOf), each placeholder's slot
 * as data. A single statement's every form is sent by its units. */
const servedPartedForm = (form: {
	readonly ast: SqlStatement
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly text: FormText
}): ServedPartedForm => {
	if (form.text.kind !== "parted") {
		throw defect("a single statement's every form is sent by its units")
	}
	const parted = partedOf(form.ast, form.params.map(servedWriteSlot), form.text.units)
	return Object.freeze({ units: mapNonEmpty(parted.units, (unit) => Object.freeze(unit)) })
}

/**
 * The unique violations that abort a role's apply at `isolation` among the compiled `aborts` (write/program/compile.ts
 * uniqueAbortsOf), which hold every one SERIALIZABLE meets: all of them; or, under READ COMMITTED, which generate
 * certifies only where no other call's rows change a call's output, all but each UnseenOccupant. An occupant its
 * snapshot did not see there is refused at that object in the serial order with its writer first, so the violation is
 * the object's law, as the classifier reads it.
 */
const uniqueAbortsAt = (
	aborts: ReadonlyArray<UniqueAbort>,
	isolation: Isolation
): ReadonlyArray<UniqueAbort> =>
	isolation === "serializable" ? aborts : aborts.filter((a) => a.reason !== "UnseenOccupant")

/** A step as a role of `isolation` runs it: a write's and a single statement's with the aborts it meets there. */
const servedStep = (step: OwnStep, isolation: Isolation): OwnStep => {
	switch (step.kind) {
		case "write":
			return { ...step, uniqueAborts: uniqueAbortsAt(step.uniqueAborts, isolation) }
		case "single":
			return {
				...step,
				parts: step.parts.map((p) => ({
					...p,
					step: { ...p.step, uniqueAborts: uniqueAbortsAt(p.step.uniqueAborts, isolation) }
				})),
				uniqueAborts: uniqueAbortsAt(step.uniqueAborts, isolation)
			}
		case "carrier":
		case "check":
		case "familyWrite":
		case "admission":
			return step
	}
}

/** A statement of the artifact as its served write holds it, its step with the aborts it meets at `level`: none of a
 * read-back's, which the read-back's own program runs; a single statement's by its units, any other's whole. */
const servedStatements = (
	s: ArtifactStatement,
	level: Isolation
): ReadonlyArray<ServedStatement> => {
	const step = s.step
	if (step.kind === "readBack") {
		return []
	}
	switch (s.text.kind) {
		case "whole":
			return [
				Object.freeze({
					kind: "whole",
					step: servedStep(step, level),
					form: servedWriteForm({ sql: s.spec.sql, params: s.spec.paramSlots }),
					forms: servedForms(s.forms, servedWriteForm),
					staged: preparedStaged(s.staged)
				})
			]
		case "parted":
			return [
				Object.freeze({
					kind: "parted",
					step: servedStep(step, level),
					form: servedPartedForm({ ast: s.ast, params: s.spec.paramSlots, text: s.text }),
					forms: servedForms(s.forms, servedPartedForm)
				})
			]
	}
}

/**
 * A compiled write as everything past its compile reads it: its application and the served file that holds it
 * (projectWrite, flightOf; adapter/served/project.ts), the installation's grants (program/workload/compile.ts
 * servedCarriers) and its role's classifier (adapter/served/project.ts refusalsOf). Its level and its
 * exclusion; its statements as its application runs them at that level, but the read-backs', which their own programs
 * run, each step with the aborts it meets there, every form its text, parts and slots (ServedStatement); its read-backs
 * as its served file holds them (served/spine.ts servedReadBacks); its stand-ups, every text named
 * (runtime/write/flight.ts StandUp), whether one makes a carrier and the columns of its program carriers; its declared and clocked
 * parameters, its binding; and of its front end the schema it compiled against, the relations it writes and the codes it reads. A compiled write's
 * artifact holds each statement's SQL AST beside its text, which its certification's facts read and nothing after
 * (program/isolation/member-facts.ts), so the servable write holds no AST, no schedule, no placement and no analysis.
 */
export interface ServableWrite {
	readonly level: Isolation
	readonly exclusion: WriteExclusion
	readonly statements: ReadonlyArray<ServedStatement>
	readonly readBacks: ReadonlyArray<ServedReadBack>
	readonly standUps: ReadonlyArray<ServedStandUp>
	readonly carriers: {
		readonly creates: boolean
		readonly columns: ReadonlyArray<CarrierColumn>
	}
	readonly params: ReadonlyArray<CallerParamDecl>
	readonly clocked: ReadonlyArray<ClockParamDecl>
	readonly binding: Binding
	readonly frontend: Pick<WriteFrontend, "schema" | "written" | "codes">
}

/** `compiled` as everything past its compile reads it (ServableWrite), its statements projected at its level. */
export const servableWrite = (compiled: CompiledWrite): ServableWrite => {
	const { artifact } = compiled
	const standUps = Object.freeze(
		compiled.standUps.map((s): ServedStandUp =>
			s.kind === "carrier"
				? Object.freeze({
						kind: "carrier",
						table: prepared(s.table),
						emptying: prepared(s.emptying)
					})
				: Object.freeze({ kind: "judged", call: prepared(s.call) })
		)
	)
	return Object.freeze({
		level: compiled.level,
		exclusion: compiled.exclusion,
		statements: Object.freeze(
			artifact.statements.flatMap((s) => servedStatements(s, compiled.level))
		),
		readBacks: Object.freeze(servedReadBacks(artifact.readBacks)),
		standUps,
		carriers: Object.freeze({
			creates: standUps.some((s) => s.kind === "carrier"),
			columns: Object.freeze(artifact.carriers.flatMap((c) => c.heading))
		}),
		params: compiled.params,
		clocked: compiled.clocked,
		binding: compiled.binding,
		frontend: Object.freeze({
			schema: compiled.frontend.schema,
			written: compiled.frontend.written,
			codes: compiled.frontend.codes
		})
	})
}

/**
 * The data an application of `compiled` reads (`ServedWrite`) at the level it was compiled for (ServableWrite
 * `level`): its declared parameters, its binding, what its transaction locks before its snapshot, its stand-ups, its
 * statements but the
 * read-backs', which the read-backs' own programs run, each step with the aborts it meets at that level, and its written
 * relations' headings.
 */
export const projectWrite = (compiled: ServableWrite): ServedWrite =>
	Object.freeze({
		params: compiled.params,
		binding: compiled.binding,
		exclusion: compiled.exclusion,
		standUps: compiled.standUps,
		statements: compiled.statements,
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

/** A write compiled in process as an application runs it: projected at the level it was compiled for and loaded, as a
 * served one is. */
export const flightOf = (compiled: ServableWrite, codes: Codebook): FlightWrite =>
	loadWrite(
		projectWrite(compiled),
		codes,
		closedTableOf(compiled.frontend.schema),
		new CompilePatterns()
	)

/**
 * A write's host half compiled in process from its front end, no statement built (runtime/write/bind.ts HostBinding):
 * its declared parameters and its binding (decide.ts decideBinding), prepared under the installation's codes, the
 * closed table and the patterns `patterns` as a loaded write's is (runtime/write/binding.ts prepareBinding). What an
 * insertion preview binds its rows by (program/preview.ts), which reads no statement.
 */
export const hostBindingOf = (
	frontend: WriteFrontend,
	codes: Codebook,
	closed: ClosedTable,
	patterns: PatternReads
): HostBinding => {
	const binding = decideBinding(frontend)
	return Object.freeze({
		params: callerParams(frontend.params),
		binding,
		prepared: prepareBinding(binding, codes, closed, patterns),
		codes
	})
}
