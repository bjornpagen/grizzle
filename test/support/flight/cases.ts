import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	type Size,
	weighted
} from "@bjornpagen/testing/gen"
import { type Swarm, swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { Array as Arr } from "effect"
import {
	type AlongsideFrame,
	type Call,
	type FlightCase,
	type FrameName,
	fatalStates,
	type Planned,
	type PrologueAnswer,
	refusalStates,
	type StatementKind
} from "#test/support/flight/model.ts"

type CallForm =
	| { readonly kind: "framed"; readonly frame: FrameName }
	| { readonly kind: "alongside"; readonly frame: AlongsideFrame }

const framedForms: Arr.NonEmptyReadonlyArray<CallForm> = [
	{ kind: "framed", frame: "write" },
	{ kind: "framed", frame: "read" },
	{ kind: "framed", frame: "rollback" }
]

const alongsideForms: Arr.NonEmptyReadonlyArray<CallForm> = [
	{ kind: "alongside", frame: "read" },
	{ kind: "alongside", frame: "rollback" }
]

/**
 * Every form a drawn call takes: the exhaustive cases' framed forms, a change of a role generate certified READ
 * COMMITTED and a deferrable member's read, whose flights differ from a write's and a read's only in their BEGIN, and
 * the forms alongside.
 */
const callForms: Arr.NonEmptyReadonlyArray<CallForm> = [
	...framedForms,
	{ kind: "framed", frame: "readCommittedWrite" },
	{ kind: "framed", frame: "deferrableRead" },
	...alongsideForms
]

/**
 * The call of a form, its statements alone given for statements alone in front of a transaction, and what a framed
 * call's prologue answers.
 */
const callOfForm = (
	form: CallForm,
	prologue: PrologueAnswer,
	alone: ReadonlyArray<Planned>,
	statements: ReadonlyArray<Planned>
): Call => {
	const [first, ...rest] = alone
	if (form.kind === "framed" || first === undefined) {
		return { kind: "framed", frame: form.frame, prologue, statements }
	}
	return { kind: "alongside", frame: form.frame, alone: [first, ...rest], statements }
}

const answered: PrologueAnswer = { kind: "answered" }

/** The faults of a prologue: every way each step fails, the lock never with another snapshot's 55Z01. */
const prologueFaults: Arr.NonEmptyReadonlyArray<PrologueAnswer> = [
	{ kind: "fault", step: "lock", fault: "refused" },
	{ kind: "fault", step: "lock", fault: "migrating" },
	{ kind: "fault", step: "lock", fault: "fatal" },
	{ kind: "fault", step: "lock", fault: "lost" },
	{ kind: "fault", step: "guard", fault: "refused" },
	{ kind: "fault", step: "guard", fault: "migrating" },
	{ kind: "fault", step: "guard", fault: "migrated" },
	{ kind: "fault", step: "guard", fault: "fatal" },
	{ kind: "fault", step: "guard", fault: "lost" }
]

/** Every answer a prologue gives, the plain one first. */
const prologueAnswers: Arr.NonEmptyReadonlyArray<PrologueAnswer> = [answered, ...prologueFaults]

/** A statement before its label: what it does, and the SQLSTATE a refusal or a FATAL report carries. */
type Unlabelled =
	| { readonly kind: Exclude<StatementKind, "refused" | "fatal"> }
	| { readonly kind: "refused" | "fatal"; readonly sqlstate: string }

/** A statement of a kind, a refusal or FATAL report carrying the first SQLSTATE of its dictionary. */
const plainStatement = (kind: StatementKind): Unlabelled => {
	switch (kind) {
		case "refused":
			return { kind, sqlstate: refusalStates[0] }
		case "fatal":
			return { kind, sqlstate: fatalStates[0] }
		case "rows":
		case "doomed":
		case "nullCell":
		case "hold":
		case "late":
		case "stuck":
		case "lose":
			return { kind }
	}
}

/** A statement of a kind, a refusal or FATAL report carrying an SQLSTATE drawn from its dictionary. */
const drawnStatement = (kind: StatementKind): Gen<Unlabelled> => {
	switch (kind) {
		case "refused":
			return map(element(refusalStates), (sqlstate): Unlabelled => ({ kind, sqlstate }))
		case "fatal":
			return map(element(fatalStates), (sqlstate): Unlabelled => ({ kind, sqlstate }))
		case "rows":
		case "doomed":
		case "nullCell":
		case "hold":
		case "late":
		case "stuck":
		case "lose":
			return constant(plainStatement(kind))
	}
}

/** Statements labelled by their prefix and their place: a statement's label is its identity in the case. */
const labelled = (prefix: string, statements: ReadonlyArray<Unlabelled>): ReadonlyArray<Planned> =>
	Arr.map(statements, (statement, i): Planned => ({ ...statement, label: `${prefix}${i}` }))

/** The kinds the exhaustive cases hold: every kind but `stuck` (see smallCases). */
const smallKinds: Arr.NonEmptyReadonlyArray<StatementKind> = [
	"rows",
	"refused",
	"doomed",
	"nullCell",
	"hold",
	"late",
	"fatal",
	"lose"
]

/** No statement or one, of a kind of smallKinds. */
const smallStatements: Gen<ReadonlyArray<Unlabelled>> = array(
	map(element(smallKinds), plainStatement),
	{ min: 0, max: 1 }
)

/**
 * Every case with one statement alone in front of a transaction or none, and at most one statement in the
 * transaction, of every kind but `stuck`, in every frame, its prologue answering every way, BEGIN answered or refused,
 * COMMIT answered or its connection lost: a bounded generator an exhaustive check enumerates whole. A stuck statement
 * drains only once an interruption destroys its connection, which the drawn cases reach.
 */
export const smallCases: Gen<FlightCase> = (source) => ({
	call: source.draw(
		oneOf<Call>([
			(framed) =>
				callOfForm(
					framed.draw(element(framedForms)),
					framed.draw(element(prologueAnswers)),
					[],
					labelled("s", framed.draw(smallStatements))
				),
			(alongside) =>
				callOfForm(
					alongside.draw(element(alongsideForms)),
					answered,
					labelled("a", [plainStatement(alongside.draw(element(smallKinds)))]),
					labelled("s", alongside.draw(smallStatements))
				)
		])
	),
	begin: source.draw(element(["answered", "refused"] as const)),
	commit: source.draw(element(["answered", "lost"] as const))
})

/**
 * What a drawn case may hold: the ways its statements fail, the simplest first, and whether BEGIN may be refused and
 * COMMIT's connection lost.
 */
export interface CaseSpace {
	readonly failures: Arr.NonEmptyReadonlyArray<StatementKind>
	readonly serverFaults: boolean
}

/** What a framed call's prologue answers: always answered, or, with server faults, a fault one case in seven. */
const prologueOf = (space: CaseSpace): Gen<PrologueAnswer> =>
	space.serverFaults
		? weighted([
				[6, constant(answered)],
				[1, element(prologueFaults)]
			])
		: constant(answered)

/** What BEGIN answers: always answered, or, with server faults, refused one case in five. */
const beginOf = (space: CaseSpace): Gen<FlightCase["begin"]> =>
	space.serverFaults
		? weighted<FlightCase["begin"]>([
				[4, constant("answered")],
				[1, constant("refused")]
			])
		: constant("answered")

/** What COMMIT answers: always answered, or, with server faults, its connection lost one case in five. */
const commitOf = (space: CaseSpace): Gen<FlightCase["commit"]> =>
	space.serverFaults
		? weighted<FlightCase["commit"]>([
				[4, constant("answered")],
				[1, constant("lost")]
			])
		: constant("answered")

/**
 * Flight cases drawn and enumerated (model.ts): the unit fuzzer's every kind of statement, and the server check's
 * kinds PostgreSQL can be made to answer on demand.
 *
 * A case draws a swarm over its space's failure kinds, then its call form (a read, a write or an EXPLAIN's flight, or
 * statements alone in front of a read's or a write's transaction), what a framed call's prologue answers, its
 * statements and whether each fails, and whether BEGIN and COMMIT answer. A statement that fails fails in a way the
 * case's swarm allows, so a case with few failure kinds on, where those kinds meet each other, is as likely as one
 * with all of them; a refusal or a FATAL report carries an SQLSTATE drawn from its dictionary. A failing case shrinks
 * toward statements that answer their rows and toward the simplest failure, a refusal. A case is plain data, so a kept
 * case is a FlightCase literal.
 */
export const caseGen =
	(space: CaseSpace): Gen<FlightCase> =>
	(source) => {
		const failures: Swarm<StatementKind> = source.draw(swarm(space.failures))
		const statement: Gen<Unlabelled> = (drawing) =>
			drawing.draw(boolean)
				? drawing.draw(drawnStatement(drawing.draw(swarmChoice(failures, space.failures))))
				: plainStatement("rows")
		const statements = (prefix: string, size: Size) =>
			labelled(prefix, source.draw(array(statement, size)))
		const form = source.draw(element(callForms))
		const call =
			form.kind === "framed"
				? callOfForm(form, source.draw(prologueOf(space)), [], statements("s", { min: 0, max: 4 }))
				: callOfForm(
						form,
						answered,
						statements("a", { min: 1, max: 2 }),
						statements("s", { min: 0, max: 4 })
					)
		return { call, begin: source.draw(beginOf(space)), commit: source.draw(commitOf(space)) }
	}
