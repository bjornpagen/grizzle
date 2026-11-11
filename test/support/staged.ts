import { Array as Arr } from "effect"
import { oneShotStatement, parseLength, preparedStatement } from "#adapter/wire/batch.ts"
import type { Prepared } from "#compiler/core/prepared.ts"
import { type EmittedText, explainOf } from "#compiler/plan/common.ts"
import type { FlightWrite } from "#compiler/runtime/write/flight.ts"

/**
 * Every text a statement of `flight` sends, by whether explain plans it (adapter/served/explain.ts): its form and its
 * large form, and its staged form's statement and its carriers' fills, which explain sends as their EXPLAIN, and its
 * carriers' creations and their ANALYZE where the staged statement needs one, which explain runs as they are. Each is a served text, named.
 */
const textsOf = (
	flight: FlightWrite
): {
	readonly planned: ReadonlyArray<Prepared<EmittedText>>
	readonly run: ReadonlyArray<Prepared<EmittedText>>
} => ({
	planned: Arr.flatMap(flight.statements, (s) => [
		s.form.text,
		...(s.forms.kind === "chosen" ? [s.forms.large.text] : []),
		...(s.staged.kind === "carriers"
			? [s.staged.sql, ...Arr.map(s.staged.carriers, (k) => k.fill)]
			: [])
	]),
	run: Arr.flatMap(flight.statements, (s) =>
		s.staged.kind === "carriers"
			? [
					...(s.staged.analyze.kind === "needed" ? [s.staged.analyze.text] : []),
					...Arr.map(s.staged.carriers, (k) => k.create)
				]
			: []
	)
})

/** The Parse message (adapter/wire/batch.ts parseLength) of a served text, under its name. */
const servedParse = (text: Prepared<EmittedText>): number =>
	parseLength(preparedStatement(text, []))

/** The Parse message of a served text's EXPLAIN (explainOf), which explain sends one-shot, unnamed. */
const explainParse = (text: Prepared<EmittedText>): number =>
	parseLength(oneShotStatement(explainOf(text.sql), []))

/** The longest of `lengths`. */
const longest = (lengths: ReadonlyArray<number>): number =>
	Arr.reduce(lengths, 0, (most, length) => Math.max(most, length))

/**
 * The message bound a test plants on a staged write's session (Session.messageMaxBytes): the longest Parse message of
 * any text a statement of `flight` sends, under its name, its form and its large form, and its staged form's
 * statement, carriers' creations and fills, and ANALYZE, so every statement's text fits the bound and only the rows'
 * arrays of its Bind messages meet it.
 */
export const textBound = (flight: FlightWrite): number => {
	const texts = textsOf(flight)
	return longest(Arr.map([...texts.planned, ...texts.run], servedParse))
}

/**
 * The message bound a test plants on the session explain plans a staged write on: the longest Parse message of any text
 * explain or the application sends of `flight`, each text explain plans as its EXPLAIN (explainOf), one-shot, and each
 * it runs as it is, under its name, as the application sends every one, so every text explain and the application send
 * fits the bound and only the rows' arrays of their Bind messages meet it.
 */
export const explainedTextBound = (flight: FlightWrite): number =>
	Math.max(textBound(flight), longest(Arr.map(textsOf(flight).planned, explainParse)))
