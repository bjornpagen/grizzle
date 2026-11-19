import { defined } from "@bjornpagen/testing/assert"
import type { FlightForm, FlightStatement } from "#compiler/runtime/write/flight.ts"

/**
 * Each form a loaded statement sends where its inputs give every part rows (runtime/write/flight.ts): a whole
 * statement's own form and its large one, and a single statement's every unit of each of its forms
 * (runtime/write/parted.ts), its texts the longest it sends.
 */
export const wholeForms = (statement: FlightStatement): ReadonlyArray<FlightForm> => {
	switch (statement.kind) {
		case "whole":
			return statement.forms.kind === "chosen"
				? [statement.form, statement.forms.large]
				: [statement.form]
		case "parted": {
			const every = (form: typeof statement.form): FlightForm =>
				defined(
					form.sentFor(() => true),
					"a single statement sends every unit where its inputs give every part rows"
				)
			return statement.forms.kind === "chosen"
				? [every(statement.form), every(statement.forms.large)]
				: [every(statement.form)]
		}
	}
}
