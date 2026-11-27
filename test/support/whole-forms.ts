import { defined } from "@bjornpagen/testing/assert"
import type { FlightForm, FlightStatement } from "#compiler/runtime/write/flight.ts"

/**
 * The form a loaded statement sends where its inputs give every part rows (runtime/write/flight.ts): a whole
 * statement's form, and a single statement's every unit (runtime/write/parted.ts), its text the longest it sends.
 */
export const wholeForm = (statement: FlightStatement): FlightForm => {
	switch (statement.kind) {
		case "whole":
			return statement.form
		case "parted":
			return defined(
				statement.form.sentFor(() => true),
				"a single statement sends every unit where its inputs give every part rows"
			)
	}
}
