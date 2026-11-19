import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr } from "effect"
import { admittedNames } from "#test/support/kernel/dict.ts"
import { Desk } from "#test/unit/client/document.fixtures.ts"

/**
 * The names a client is opened under over Desk's document: Desk's own, then every declared name the naming door admits
 * (test/support/kernel/dict.ts admittedNames), the logins a document may be read as. The door's own verdicts are the
 * domain, never cases a person chose.
 */
export const openedNames = dictionary([
	Desk.name,
	...Arr.filter(
		Arr.map(admittedNames, (n) => n.declared),
		(n) => n !== Desk.name
	)
])
