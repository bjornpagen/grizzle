/**
 * A client over a login's OpenAPI document (client/client.ts clientCalls and clientOf): opened under the document's own
 * login, it holds each role's programs; opened under any other login's name, it is ClientDocumentRefused naming the
 * login it was read as and the document's, before any call. The box is Desk's document under its own name and under
 * every declared name the naming door admits. Oracle: the document's own login, whose name a call either names or not.
 *
 * Features: the document opened under its own login, and refused under another.
 */

import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { ClientDocumentRefused, clientCalls, clientOf } from "#client/client.ts"
import { assert } from "#test/support/assert.ts"
import { openedNames } from "#test/unit/client/document.dictionary.ts"
import { Desk, deskDocument } from "#test/unit/client/document.fixtures.ts"

type Opened = "opened under its own login" | "refused under another login"

const url = new URL("https://grizzle.invalid/")

/** A client opens a login's document under the login's own name alone, and refuses it under every other. */
export const aClientOpensALoginsDocumentUnderTheLoginsOwnNameAloneAndRefusesItUnderEveryOther =
	property.exhaust(finite(word(openedNames)), {
		needs: {},
		situations: [
			"opened under its own login",
			"refused under another login"
		] satisfies ReadonlyArray<Reached<Opened>>,
		check: (_, k: Case<Opened>) => (name) =>
			Effect.sync(() => {
				const calls = clientCalls(deskDocument, name, { url })
				if (name === Desk.name) {
					k.note("opened under its own login")
					assert.equal(calls._tag, "Success", "the document opens under its own login")
					assert.equal(
						clientOf<typeof Desk>(deskDocument, Desk.name, { url })._tag,
						"Success",
						"the typed client opens under its own login"
					)
					return
				}
				k.note("refused under another login")
				if (Result.isSuccess(calls)) {
					return assert.fail(`the document of ${Desk.name} opens as ${name}`)
				}
				assert.deepEqual(
					{
						refused: calls.failure instanceof ClientDocumentRefused,
						login: calls.failure.login,
						document: calls.failure.document
					},
					{ refused: true, login: name, document: Desk.name },
					`the document of ${Desk.name} read as ${name}`
				)
			}),
		oracle: { kind: "specification", name: "the document's own login, which a call names or not" },
		box: "Desk's document under its own login's name and under every declared name the naming door admits",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/client/client.ts",
				original: "\tif (read.login !== name) {",
				replacement: '\tif (read.login === "") {',
				why: "A document of another login is read as the login it was opened under, so every cell of another name is opened, never ClientDocumentRefused."
			}
		]
	})
