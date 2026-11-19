import { Array as Arr } from "effect"
import { oneShotStatement, parseLength, preparedStatement } from "#adapter/wire/batch.ts"
import type { Prepared } from "#compiler/core/prepared.ts"
import { explainOf } from "#compiler/plan/common.ts"
import type { FlightWrite } from "#compiler/runtime/write/flight.ts"
import type { WriteText } from "#compiler/runtime/write/parted.ts"
import { wholeForms } from "#test/support/whole-forms.ts"

/**
 * Every text a statement of `flight` sends, by whether explain plans it (adapter/served/explain.ts): its form and its
 * large form, and its staged form's statement and its carriers' fills, which explain sends as their EXPLAIN, and its
 * carriers' creations, which explain runs as they are. Each is a served text, named.
 */
const textsOf = (
	flight: FlightWrite
): {
	readonly planned: ReadonlyArray<Prepared<WriteText>>
	readonly run: ReadonlyArray<Prepared<WriteText>>
} => ({
	planned: Arr.flatMap(flight.statements, (s) => [
		...Arr.map(wholeForms(s), (form) => form.text),
		...(s.kind === "whole" && s.staged.kind === "carriers"
			? [s.staged.sql, ...Arr.map(s.staged.carriers, (k) => k.fill)]
			: [])
	]),
	run: Arr.flatMap(flight.statements, (s) =>
		s.kind === "whole" && s.staged.kind === "carriers"
			? Arr.map(s.staged.carriers, (k) => k.create)
			: []
	)
})

/** The Parse message (adapter/wire/batch.ts parseLength) of a served text, under its name. */
const servedParse = (text: Prepared<WriteText>): number => parseLength(preparedStatement(text, []))

/** The Parse message of a served text's EXPLAIN (explainOf), which explain sends one-shot, unnamed. */
const explainParse = (text: Prepared<WriteText>): number =>
	parseLength(oneShotStatement(explainOf(text.sql), []))

/** The longest of `lengths`. */
const longest = (lengths: ReadonlyArray<number>): number =>
	Arr.reduce(lengths, 0, (most, length) => Math.max(most, length))

/**
 * The message bound a test plants on a staged write's session (Session.messageMaxBytes): the longest Parse message of
 * any text a statement of `flight` sends, under its name, its form and its large form, and its staged form's
 * statement and its carriers' creations and fills, so every statement's text fits the bound and only the rows'
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
