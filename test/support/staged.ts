import { Array as Arr } from "effect"
import { parseLength } from "#adapter/wire/batch.ts"
import { type EmittedText, explainOf } from "#compiler/plan/common.ts"
import type { FlightWrite } from "#compiler/runtime/write/flight.ts"

/**
 * Every text a statement of `flight` sends, by whether explain plans it (adapter/served/explain.ts): its form and its
 * large form, and its staged form's statement and its carriers' fills, which explain sends as their EXPLAIN, and its
 * carriers' creations and ANALYZE, which explain runs as they are.
 */
const textsOf = (
	flight: FlightWrite
): {
	readonly planned: ReadonlyArray<EmittedText>
	readonly run: ReadonlyArray<EmittedText>
} => ({
	planned: Arr.flatMap(flight.statements, (s) => [
		s.form.sql,
		...(s.forms.kind === "chosen" ? [s.forms.large.sql] : []),
		...(s.staged.kind === "carriers"
			? [s.staged.sql, ...Arr.map(s.staged.carriers, (k) => k.fill)]
			: [])
	]),
	run: Arr.flatMap(flight.statements, (s) =>
		s.staged.kind === "carriers"
			? [s.staged.analyze, ...Arr.map(s.staged.carriers, (k) => k.create)]
			: []
	)
})

/** The longest Parse message (adapter/wire/batch.ts parseLength) of `texts`. */
const longest = (texts: ReadonlyArray<string>): number =>
	Arr.reduce(texts, 0, (most, text) => Math.max(most, parseLength(text)))

/**
 * The message bound a test plants on a staged write's session (Session.messageMaxBytes): the longest Parse message of
 * any text a statement of `flight` sends, its form and its large form, and its staged form's statement, carriers'
 * creations and fills, and ANALYZE, so every statement's text fits the bound and only the rows' arrays of its Bind
 * messages meet it.
 */
export const textBound = (flight: FlightWrite): number => {
	const texts = textsOf(flight)
	return Math.max(longest(texts.planned), longest(texts.run))
}

/**
 * The message bound a test plants on the session explain plans a staged write on: the longest Parse message of any text
 * explain sends of `flight`, each text it plans as its EXPLAIN (explainOf), which is longer than the text the
 * application sends, so every text explain and the application send fits the bound and only the rows' arrays of their
 * Bind messages meet it.
 */
export const explainedTextBound = (flight: FlightWrite): number => {
	const texts = textsOf(flight)
	return Math.max(longest(Arr.map(texts.planned, explainOf)), longest(texts.run))
}
