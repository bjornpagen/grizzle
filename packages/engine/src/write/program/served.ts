/**
 * A compiled write as a served file holds it (runtime/write/flight.ts ServedWrite): `projectWrite` takes from the
 * compiled program exactly what an application reads, and `flightOf` loads it as an application of a write compiled in
 * process runs it, so every application runs the served form.
 *
 * A write whose family work the host plans from a read flight (bind.ts Flights `read`) is no served write: its plan reads
 * the compiled front end itself. `servedWrite` refuses it, naming each such shape (served/unserved.ts `UnservedReason`).
 */
import { maxOf } from "#compiler/core/array.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type FamilyId, familyKey } from "#compiler/ir/law.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { oneForm, type StatementForms } from "#compiler/runtime/lower/forms.ts"
import {
	type FlightWrite,
	loadWrite,
	type ServedStatement,
	type ServedWrite,
	type ServedWriteChoice,
	type ServedWriteForm
} from "#compiler/runtime/write/flight.ts"
import type { UnservedMember, UnservedReason } from "#compiler/served/unserved.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { ArtifactForms } from "#compiler/write/program/artifact.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"

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

/** Every family the nested writes of `stratum` reach, each once. */
const nestedFamilies = (compiled: CompiledWrite, stratum: StratumAt): ReadonlyArray<FamilyId> => [
	...new Map(
		compiled.frontend.nested
			.filter((n) => n.stratum === stratum)
			.flatMap((n) =>
				n.nesting.reached.map((r): readonly [string, FamilyId] => [
					familyKey(r.family.id),
					r.family.id
				])
			)
	).values()
]

/**
 * The shapes of `compiled` the host plans from a read flight: each edit and refill program, and each stratum with
 * family steps the host plans that neither names, its nested writes'.
 */
const unservedShapes = (compiled: CompiledWrite): ReadonlyArray<UnservedReason> => {
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
		...compiled.edits.map((e): UnservedReason => ({
			kind: "edit",
			stratum: e.edit.stratum,
			relation: e.target.relation.name,
			families: e.target.families.map((f) => f.family.id)
		})),
		...compiled.refills.map((r): UnservedReason => ({
			kind: "refill",
			stratum: r.stratum,
			families: r.refill.closure.refills.map((f) => f.id),
			tree: r.refill.closure.paths.some((p) => p.reader.family.members.kind === "tree"),
			hops: maxOf(
				r.refill.closure.paths.map((p) => p.copies.length),
				0
			)
		})),
		...[...planned].map((stratum): UnservedReason => ({
			kind: "nested",
			stratum,
			families: nestedFamilies(compiled, stratum)
		}))
	]
}

/** `compiled` as a served file holds it, or its refusal where the host plans some of its family work from a read
 * flight (`UnservedMember`). */
export const servedWrite = (
	compiled: CompiledWrite
): Result.Result<ServedWrite, UnservedMember> => {
	const reasons = unservedShapes(compiled)
	return isNonEmpty(reasons)
		? Result.err({ _tag: "UnservedMember", reasons })
		: Result.ok(projectWrite(compiled))
}

/** A write compiled in process as an application runs it: projected and loaded, as a served one is. */
export const flightOf = (compiled: CompiledWrite, codes: Codebook): FlightWrite =>
	loadWrite(projectWrite(compiled), codes)
