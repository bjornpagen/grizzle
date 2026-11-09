import { Array as Arr } from "effect"
import { parseLength } from "#adapter/wire/batch.ts"
import type { FlightWrite } from "#compiler/runtime/write/flight.ts"

/**
 * The message bound a test plants on a staged write's session (Session.messageMaxBytes): the longest Parse message
 * (adapter/wire/batch.ts parseLength) of any text a statement of `flight` sends, its form and its large form, and its
 * staged form's statement, carriers' creations and fills, and ANALYZE, so every statement's text fits the bound and only
 * the rows' arrays of its Bind messages meet it.
 */
export const textBound = (flight: FlightWrite): number =>
	Arr.reduce(
		Arr.flatMap(flight.statements, (s) => [
			s.form.sql,
			...(s.forms.kind === "chosen" ? [s.forms.large.sql] : []),
			...(s.staged.kind === "carriers"
				? [
						s.staged.sql,
						s.staged.analyze,
						...Arr.flatMap(s.staged.carriers, (k) => [k.create, k.fill])
					]
				: [])
		]),
		0,
		(most, text) => Math.max(most, parseLength(text))
	)
