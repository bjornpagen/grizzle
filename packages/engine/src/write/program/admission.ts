/**
 * A write's admission, folded into its flight: no statement of its own, but an entry of each statement a call may send
 * first.
 *
 * A write's caller parameters whose types PostgreSQL checks beyond their bases (lower/conservative/admission.ts
 * checkedParams) are each bound, through a placeholder cast to its domain, by an unreferenced CTE that leads the
 * statement carrying it, its placeholders the statement's first (lower/conservative/admission.ts admissionCte):
 *
 *   WITH "r31"("c40") AS (SELECT ($1::"<schema>"."__param_p_…")::text AS "c39"),
 *        <the statement's own CTEs, its placeholders from $2> ...
 *
 * PostgreSQL types each placeholder by its first use as it parses the statement, and converts every value through its
 * type's input as it binds it, $1 first, before the statement runs (PostgreSQL 19 parser/parse_param.c
 * variable_coerce_param_hook, tcop/postgres.c exec_bind_message): so a value outside its type is refused, ParamRejected
 * at its parameter, by the Bind of the statement that carries it, whether or not anything reads the CTE, before any
 * other placeholder of that statement and before the statement runs.
 *
 * Which statements carry a parameter is decided by when its value may be one its type refuses (`exposure`): a scalar's
 * in every call, a relation parameter's where it holds a fact. Each parameter rides every statement before the first one
 * the flight sends wherever its exposure holds, and that one (its lead), so whichever of them a call sends first binds
 * it, and a call that exposes it sends one of them: no statement before them runs while it is unchecked, and no
 * statement is added for it. A parameter no statement is sent wherever its exposure holds rides the flight's first
 * statement of its own, which is sent there besides (`widened`): its rows need no more, and the call that sends it for
 * the admission alone writes nothing. A read-back is sent after the flight's own statements, and carries none of
 * theirs: a ChangeSet of reads alone holds no statement of its own, and its first read-back, the first statement its
 * call sends, in every call, admits every parameter as its own, as a query's statement does (lower/conservative/types.ts
 * ReadBackAdmission `own`).
 *
 * Each of the admission's placeholders is an admission slot (lower/conservative/types.ts AdmissionParamSlot), the
 * declared parameter's placeholder it admits, so a statement of member inserts carrying one is cut into batched
 * executions as one carrying none is, each execution binding it whole (runtime/write/flight.ts sharedWhole): every
 * execution's Bind admits the parameter again, before anything of it runs.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { always, covers, either, needing, type Needs, never } from "#compiler/ir/needs.ts"
import type { CallerParamDecl } from "#compiler/ir/products.ts"
import { admissionCte, checkedParams } from "#compiler/lower/conservative/admission.ts"
import {
	type LowerContext,
	StatementParams,
	withLeading
} from "#compiler/lower/conservative/context.ts"
import type {
	AdmissionParamSlot,
	DeclaredParamSlot,
	WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import { type OwnStep, sentWhere } from "#compiler/runtime/write/steps.ts"
import type { Cte, SqlStatement } from "#compiler/sql/ast.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { namesPast, NameSupply } from "#compiler/sql/naming.ts"
import { ownStatement } from "#compiler/write/insert/statement.ts"
import type { FormText, PlacedStatement, SentForm } from "#compiler/write/program/artifact.ts"
import type { UnitShape } from "#compiler/write/program/single.ts"
import { relationsPast, renumberedStatement } from "#compiler/write/program/slot-carriers.ts"

/** A placed statement of the program's own. */
type OwnPlaced = Extract<PlacedStatement, { readonly kind: "own" }>

/**
 * Where a checked parameter's value may be one its type refuses (see the header): a scalar's in every call, a relation
 * parameter's where it holds a fact; an empty relation parameter holds no value to refuse.
 */
const exposure = (p: CallerParamDecl): Needs =>
	p.kind === "scalar" ? always : needing({ kind: "declared", param: p.id })

/**
 * Where a unit sends its single statement (runtime/write/parted.ts sentUnits): a part where its needs hold, a unit sent
 * with every part in every call where it delivers rows, and nowhere where it delivers none.
 */
const unitSends = (unit: UnitShape): Needs => {
	switch (unit.kind) {
		case "part":
			return unit.needs
		case "always":
			return unit.arms > 0 ? always : never
	}
}

/** Where a call sends a single statement by its units: wherever one of them sends it (`unitSends`). */
const unitsSent = (units: ReadonlyArray<UnitShape>): Needs => either(units.map(unitSends))

/** Where a call sends a statement of the program's own: a whole one's by its step, a single statement's by its units. */
const sentWhereOf = (p: OwnPlaced): Needs => {
	switch (p.text.kind) {
		case "whole":
			return sentWhere(p.step)
		case "parted":
			return unitsSent(p.text.units)
	}
}

/** `step` sent wherever `needs` holds besides where it is: a write's or a check's needs widened by them; any other step
 * is sent in every call already. */
const widenedStep = (step: OwnStep, needs: Needs): OwnStep => {
	switch (step.kind) {
		case "write":
			return { ...step, needs: either([step.needs, needs]) }
		case "check":
			return { ...step, needs: either([step.needs, needs]) }
		case "carrier":
		case "single":
		case "familyWrite":
			return step
	}
}

/** A single statement's units with its first part sent wherever `needs` holds besides where its own needs hold. */
const widenedUnits = (
	units: NonEmptyReadonlyArray<UnitShape>,
	needs: Needs
): NonEmptyReadonlyArray<UnitShape> => {
	const first = units.findIndex((unit) => unit.kind === "part")
	if (first < 0) {
		defect("a single statement holds a part")
	}
	return mapNonEmpty(units, (unit, at) =>
		at === first && unit.kind === "part"
			? Object.freeze({ ...unit, needs: either([unit.needs, needs]) })
			: unit
	)
}

/** A form's text sent wherever `needs` holds besides where it is sent (`widenedUnits`); a whole text by its step. */
const widenedText = (text: FormText, needs: Needs): FormText =>
	text.kind === "parted"
		? Object.freeze({ kind: "parted", units: widenedUnits(text.units, needs) })
		: text

/** `p` sent wherever `needs` holds besides where it is: its step's needs or its units' widened by them. */
const widened = (p: OwnPlaced, needs: Needs): OwnPlaced => ({
	...p,
	step: p.text.kind === "whole" ? Object.freeze(widenedStep(p.step, needs)) : p.step,
	text: widenedText(p.text, needs),
	forms:
		p.forms.kind === "chosen"
			? Object.freeze({
					...p.forms,
					large: Object.freeze({ ...p.forms.large, text: widenedText(p.forms.large.text, needs) })
				})
			: p.forms
})

/** `ast` with `cte` first among its WITH's entries: a write statement is DML, whose WITH leads it. */
const leading = (ast: SqlStatement, cte: Cte): SqlStatement => {
	if (ast.kind === "select") {
		return withLeading(ast, [cte])
	}
	if (
		ast.kind === "insert" ||
		ast.kind === "update" ||
		ast.kind === "delete" ||
		ast.kind === "merge"
	) {
		return {
			...ast,
			with:
				ast.with === undefined
					? { recursive: false, ctes: [cte] }
					: { ...ast.with, ctes: [cte, ...ast.with.ctes] }
		}
	}
	defect(`a write statement is DML, not ${ast.kind}`)
}

/** A form's text with the admission's unit first, sent with every part: a single statement's, whose units hold its
 * WITH's entries in order; a whole text as it is. */
const admittedText = (text: FormText): FormText =>
	text.kind === "parted"
		? Object.freeze({
				kind: "parted",
				units: extendNonEmpty<UnitShape>(
					[Object.freeze({ kind: "always", ctes: 1, arms: 0 })],
					text.units
				)
			})
		: text

/**
 * The admission placeholder of `slot`, a placeholder the admission's entry allocated (lower/conservative/types.ts
 * AdmissionParamSlot): what it carries, at its number.
 */
const admissionSlot = (slot: DeclaredParamSlot): AdmissionParamSlot => {
	const { placeholder, number, ...admits } = slot
	return Object.freeze({ kind: "admission", placeholder, number, admits })
}

/**
 * `p` carrying the admission of `carried` (see the header): in each of its forms, the admission's CTE first among its
 * WITH's entries under names past every one the statement defines, its placeholders $1 onwards, each an admission's
 * (`admissionSlot`), and the statement's own numbered after them. The entry is lowered as a statement of declared
 * placeholders alone, which allocates no member slot or nested rows.
 */
const admittedIn = (
	p: OwnPlaced,
	cx: LowerContext,
	carried: NonEmptyReadonlyArray<CallerParamDecl>
): OwnPlaced => {
	const large = p.forms.kind === "chosen" ? p.forms.large : undefined
	const supply = new NameSupply({
		relationStart: Math.max(
			relationsPast(p.ast),
			large === undefined ? ownStatement.relationStart : relationsPast(large.ast)
		),
		columnStart: namesPast(p.names, ownStatement).columnStart
	})
	const placeholders = new StatementParams<never>()
	cx.beginStatementWith(supply, placeholders)
	const cte = admissionCte(cx, carried, "admission of the write's parameters")
	const slots: ReadonlyArray<AdmissionParamSlot> = placeholders.slots.map(admissionSlot)
	const count = slots.length
	/** A form's AST and placeholders with the admission first. */
	const formed = (
		ast: SqlStatement,
		params: ReadonlyArray<WriteParamSlot>
	): { readonly ast: SqlStatement; readonly params: ReadonlyArray<WriteParamSlot> } => ({
		ast: leading(
			renumberedStatement(
				ast,
				(number) => number + count,
				() => undefined
			),
			cte
		),
		params: Object.freeze([...slots, ...params.map((s) => ({ ...s, number: s.number + count }))])
	})
	const names = [...p.names, ...supply.map()]
	const own = formed(p.ast, p.spec.paramSlots)
	const largeForm = (form: SentForm): SentForm => {
		const admitted = formed(form.ast, form.params)
		return Object.freeze({
			sql: emitText(admitted.ast, []).text,
			params: admitted.params,
			ast: admitted.ast,
			text: admittedText(form.text)
		})
	}
	return {
		...p,
		ast: own.ast,
		names,
		text: admittedText(p.text),
		spec: Object.freeze({
			...p.spec,
			sql: emitText(own.ast, names).text,
			paramSlots: own.params
		}),
		forms:
			p.forms.kind === "chosen"
				? Object.freeze({ ...p.forms, large: largeForm(p.forms.large) })
				: p.forms
	}
}

/**
 * The flight of a ChangeSet of reads alone, which holds no statement of its own: its read-backs, the first admitting
 * its write's caller parameters as its own (lower/conservative/types.ts ReadBackAdmission `own`), the first statement
 * every call sends.
 */
const readBackAdmitted = (
	placed: ReadonlyArray<PlacedStatement>
): ReadonlyArray<PlacedStatement> => {
	const [lead] = placed
	if (lead?.kind !== "readBack" || lead.admission !== "own") {
		defect(
			"a write's flight of no statement of its own leads with a read-back admitting its parameters"
		)
	}
	return placed
}

/** Whether a call sends `p` wherever `exposed` holds over its inputs. */
const sentWherever = (p: OwnPlaced, exposed: Needs): boolean => covers(sentWhereOf(p), exposed)

/**
 * The position in `flight` of its first statement of its own a call sends wherever `exposed` holds, the end of the lead
 * of a parameter exposed there; none where no statement is.
 */
const leadEnd = (flight: ReadonlyArray<PlacedStatement>, exposed: Needs): number | undefined => {
	const at = flight.findIndex((p) => p.kind === "own" && sentWherever(p, exposed))
	return at < 0 ? undefined : at
}

/**
 * The statements `placed` with the admission of the caller parameters `params` that `cx` checks (see the header): each
 * checked parameter an entry of every statement of its lead, the flight's first statement of its own sent besides
 * wherever a parameter no statement is sent for is exposed. Unchanged where no parameter is checked, and where the
 * flight holds no statement of its own and its first read-back admits them (`readBackAdmitted`).
 */
export const admittedFlight = (
	placed: ReadonlyArray<PlacedStatement>,
	cx: LowerContext,
	params: ReadonlyArray<CallerParamDecl>
): ReadonlyArray<PlacedStatement> => {
	const checked = checkedParams(cx, params)
	if (!isNonEmpty(checked)) {
		return placed
	}
	const first = placed.findIndex((p) => p.kind === "own")
	if (first < 0) {
		return readBackAdmitted(placed)
	}
	const unsent = either(
		checked.flatMap((p) => {
			const exposed = exposure(p)
			return leadEnd(placed, exposed) === undefined ? [exposed] : []
		})
	)
	const flight = isNonEmpty(unsent)
		? placed.map((p, at) => (at === first && p.kind === "own" ? widened(p, unsent) : p))
		: placed
	const leads = checked.map((param) => ({
		param,
		end: defined(
			leadEnd(flight, exposure(param)),
			"a statement sent wherever a parameter is exposed"
		)
	}))
	return flight.map((p, at) => {
		if (p.kind !== "own") {
			return p
		}
		const carried = leads.flatMap((lead) => (at <= lead.end ? [lead.param] : []))
		return isNonEmpty(carried) ? admittedIn(p, cx, carried) : p
	})
}
