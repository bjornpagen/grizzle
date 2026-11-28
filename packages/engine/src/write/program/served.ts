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
import {
	type AccessIndexRequest,
	type CallerParamDecl,
	callerParams,
	type ClockParamDecl
} from "#compiler/ir/products.ts"
import type {
	DeclaredValue,
	RelationColumn,
	ServedSlot,
	SlotColumn,
	WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import type { IndexResolver } from "#compiler/physical/indexes/ref.ts"
import type { HostBinding } from "#compiler/runtime/write/bind.ts"
import { type Binding, prepareBinding } from "#compiler/runtime/write/binding.ts"
import type { ClosedTable } from "#compiler/runtime/write/fill.ts"
import {
	type FlightWrite,
	loadWrite,
	type ServedPartedForm,
	type ServedStatement,
	type ServedWrite,
	type ServedWriteForm,
	type WriteExclusion
} from "#compiler/runtime/write/flight.ts"
import type { OwnStep, UniqueAbort } from "#compiler/runtime/write/steps.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import type { ServedReadBack } from "#compiler/served/read.ts"
import { servedReadBacks } from "#compiler/served/spine.ts"
import { type Advice, transactionAdvice } from "#compiler/sql/advice.ts"
import type { EmittedText, Dml } from "#compiler/sql/ast.ts"
import { joinPlans, type ReadPlan } from "#compiler/sql/plan.ts"
import { type Reach, ReachOf } from "#compiler/sql/reach.ts"
import type { CarrierColumn } from "#compiler/write/carriers/carriers.ts"
import type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
import type { ArtifactStatement, FormText } from "#compiler/write/program/artifact.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { decideBinding } from "#compiler/write/program/decide.ts"
import { partedOf } from "#compiler/write/program/single.ts"

/** A relation input's column as its encoder reads it: its name and type. */
const slotColumn = (column: RelationColumn): SlotColumn =>
	Object.freeze({ name: column.name, type: column.type })

/** A declared parameter's placeholder as a served file holds it (ServedSlot): a relation's columns each its name and
 * type. */
const servedDeclared = (value: DeclaredValue): ServedSlot<DeclaredValue> => {
	switch (value.kind) {
		case "scalar":
			return value
		case "relation":
			return Object.freeze({ ...value, columns: Object.freeze(value.columns.map(slotColumn)) })
	}
}

/** A placeholder as a served file holds it (ServedSlot): each column of a relation input its name and type, an
 * admission's the placeholder it admits as one is held. */
const servedWriteSlot = (slot: WriteParamSlot): ServedSlot<WriteParamSlot> => {
	switch (slot.kind) {
		case "scalar":
			return slot
		case "relation":
		case "member":
		case "nestedRows":
			return Object.freeze({ ...slot, columns: Object.freeze(slot.columns.map(slotColumn)) })
		case "admission":
			return Object.freeze({ ...slot, admits: servedDeclared(slot.admits) })
	}
}

/** A form's data: its text, named here (core/prepared.ts), and its placeholders. */
const servedWriteForm = (form: {
	readonly sql: EmittedText
	readonly params: ReadonlyArray<WriteParamSlot>
}): ServedWriteForm =>
	Object.freeze({
		text: prepared(form.sql),
		params: Object.freeze(form.params.map(servedWriteSlot))
	})

/** A single statement's form as data: its text by its units (write/program/single.ts partedOf), each placeholder's slot
 * as data. A single statement is sent by its units. */
const servedPartedForm = (form: {
	readonly ast: Dml
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly text: FormText
}): ServedPartedForm => {
	if (form.text.kind !== "parted") {
		defect("a single statement is sent by its units")
	}
	const parted = partedOf(
		form.ast,
		form.text.bound,
		form.params.map(servedWriteSlot),
		form.text.units
	)
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
					form: servedWriteForm({ sql: s.spec.sql, params: s.spec.paramSlots })
				})
			]
		case "parted":
			return [
				Object.freeze({
					kind: "parted",
					step: servedStep(step, level),
					form: servedPartedForm({ ast: s.ast, params: s.spec.paramSlots, text: s.text })
				})
			]
	}
}

/**
 * A compiled write as everything past its compile reads it: its application and the served file that holds it
 * (projectWrite, flightOf; adapter/served/project.ts), the installation's grants (program/workload/compile.ts
 * servedCarriers) and its role's classifier (adapter/served/project.ts refusalsOf). Its level and its
 * exclusion; its statements as its application runs them at that level, but the read-backs', which their own programs
 * run, each step with the aborts it meets there, each its text, parts and slots (ServedStatement); its read-backs
 * as its served file holds them (served/spine.ts servedReadBacks), and the columns of its program carriers; its declared and clocked
 * parameters, its binding; and of its front end the schema it compiled against, the relations it writes and the codes it reads. A compiled write's
 * artifact holds each statement's SQL AST beside its text, which its certification's facts read and nothing after
 * (program/isolation/member-facts.ts), so the servable write holds no AST, no schedule, no placement and no analysis:
 * what the installation reads of its statements is the plan they were bound with (`plan`), which names aliases,
 * index requests and join methods alone.
 */
export interface ServableWrite {
	readonly level: Isolation
	readonly exclusion: WriteExclusion
	readonly statements: ReadonlyArray<ServedStatement>
	readonly readBacks: ReadonlyArray<ServedReadBack>
	readonly carried: ReadonlyArray<CarrierColumn>
	readonly params: ReadonlyArray<CallerParamDecl>
	readonly clocked: ReadonlyArray<ClockParamDecl>
	readonly binding: Binding
	readonly frontend: Pick<WriteFrontend, "schema" | "written" | "codes">
	/**
	 * The plan of every statement its flight may send, each bound under its transaction's one scope (sql/bind.ts), so no
	 * two of them share an alias: each statement, the read-backs' own and the admission among them, a single statement's
	 * every unit. The installation asks an index for each of its requests and resolves them (physical/install/compile.ts),
	 * and generate prints its advice, the one its transaction sends whichever of its statements and units a call sends,
	 * since an atom of an unsent one targets no relation of the call's (sql/advice.ts).
	 */
	readonly plan: ReadPlan<AccessIndexRequest>
	/**
	 * What every statement its flight may send reaches as PostgreSQL runs it (sql/reach.ts), read off each statement's
	 * AST before the AST goes: each statement, the read-backs' own and the admission among them, which a bound of the
	 * queries one call plans follows into the installation (program/planned.ts).
	 */
	readonly reach: Reach
}

/** `compiled` as everything past its compile reads it (ServableWrite), its statements projected at its level. */
export const servableWrite = (compiled: CompiledWrite): ServableWrite => {
	const { artifact } = compiled
	const statementAsts = artifact.statements.map((s) => s.ast)
	const reach = new ReachOf()
	for (const ast of statementAsts) {
		reach.statement(ast)
	}
	return Object.freeze({
		level: compiled.level,
		exclusion: compiled.exclusion,
		statements: Object.freeze(
			artifact.statements.flatMap((s) => servedStatements(s, compiled.level))
		),
		readBacks: Object.freeze(servedReadBacks(artifact.readBacks)),
		carried: Object.freeze(artifact.carriers.flatMap((c) => c.heading)),
		params: compiled.params,
		clocked: compiled.clocked,
		binding: compiled.binding,
		frontend: Object.freeze({
			schema: compiled.frontend.schema,
			written: compiled.frontend.written,
			codes: compiled.frontend.codes
		}),
		plan: joinPlans(artifact.statements.map((s) => s.spec.plan)),
		reach: reach.reach()
	})
}

/**
 * The data an application of `compiled` reads (`ServedWrite`) at the level it was compiled for (ServableWrite
 * `level`): its declared parameters, its binding, what its transaction locks before its snapshot, its statements but the read-backs', which the read-backs' own programs run, each step with the aborts it meets at that
 * level, the statements one call sends, its own and its read-backs' after the last stratum, and its written relations'
 * headings.
 */
export const projectWrite = (compiled: ServableWrite, advice: Advice): ServedWrite =>
	Object.freeze({
		params: compiled.params,
		binding: compiled.binding,
		exclusion: compiled.exclusion,
		statements: compiled.statements,
		sends:
			compiled.statements.length +
			compiled.readBacks.filter((read) => read.carried.kind === "sent").length,
		written: Object.freeze(
			compiled.frontend.written.map((r) =>
				Object.freeze({
					relation: r.name,
					heading: Object.freeze(
						r.heading.map((f) => Object.freeze({ name: f.name, type: f.type }))
					)
				})
			)
		),
		advice
	})

/**
 * What a write of `compiled` is planned under (runtime/write/flight.ts ServedWrite `advice`): the plan of every
 * statement its flight may send (ServableWrite `plan`), each read resolved by the installation that serves it
 * (`resolve`).
 */
export const writeAdvice = (compiled: ServableWrite, resolve: IndexResolver): Advice =>
	transactionAdvice([compiled.plan], resolve)

/** A write compiled in process as an application runs it: projected at the level it was compiled for, planned under
 * `advice` (`writeAdvice`), and loaded, as a served one is. */
export const flightOf = (compiled: ServableWrite, codes: Codebook, advice: Advice): FlightWrite =>
	loadWrite(
		projectWrite(compiled, advice),
		codes,
		closedTableOf(compiled.frontend.schema),
		compiled.frontend.schema.patterns
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
