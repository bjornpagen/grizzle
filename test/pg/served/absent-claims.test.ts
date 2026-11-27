/**
 * A role's entry that reads a context, read by hand as a direct reader reads it (absent-claims.fixtures.ts): a claims
 * setting that holds no claims document is refused, never read as a document of no fact.
 *
 * README, "Direct SQL access": a reader that sets no claims, or sets them to the empty text, or reads after the
 * transaction its claims were set for has ended, meets the context source's refusal of an absent setting (sql/print.ts
 * claimsDocument): SQLSTATE 22P02, the constraint `grizzle.claims`, the DETAIL `c-` (write/refusal.ts). A document of no
 * fact reads no seat, and one naming ann's subject reads hers. A case seats ann's seat, logs in as the login, takes on
 * the role in a transaction, sets the setting as the case says, and counts MySeat's rows.
 *
 * Oracle: the setting's meaning restated (outcomeOf).
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, Result } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { claimsSettingName } from "#compiler/sql/print.ts"
import { claimSettings } from "#test/pg/served/absent-claims.dictionary.ts"
import {
	claimsTemplate,
	outcomeOf,
	seatsAt,
	type Setting,
	settings
} from "#test/pg/served/absent-claims.fixtures.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The statement that sets the claims setting to its one parameter for the transaction. */
const setClaims = "SELECT pg_catalog.set_config('grizzle.claims', $1, true)"

/** The claims setting's name as the refusal names its constraint. */
const settingName: string = claimsSettingName

/** A claims setting that holds no claims document is refused as absent, and a document reads its subject's seats. */
export const aSettingThatHoldsNoClaimsDocumentIsRefusedAsAbsentAndNeverReadAsADocumentOfNoFact =
	property.exhaust(finite(word(claimSettings)), {
		needs: { claims: Substrate.fresh(claimsTemplate) },
		situations: [...settings] satisfies ReadonlyArray<Reached<Setting>>,
		check:
			({ claims }, notes: Case<Setting>) =>
			(setting) =>
				Effect.scoped(
					Effect.flatMap(claims, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								notes.note(setting)
								const installed = taken.value
								const s = yield* Substrate
								const { holder: holderRole, desk } = seatsAt(installed.declared)
								const holder = installed.role(holderRole)
								const seat = installed.names.relation("Seat")
								const owner = yield* s.session({ ...ownerSession(), label: "claims owner" })
								yield* owner.query(
									`INSERT INTO ${quoteIdent(seat.schema)}.${quoteIdent(seat.name)} (${quoteIdent(installed.names.column("Seat", "id"))}, ${quoteIdent(installed.names.column("Seat", "holder"))}) VALUES (1, 'u_ann')`,
									[]
								)
								const [view] = yield* s.admin.queryValues(
									"SELECT pg_catalog.quote_ident(g.table_schema) || '.' || pg_catalog.quote_ident(g.table_name) FROM information_schema.role_table_grants AS g JOIN pg_catalog.pg_views AS w ON w.schemaname = g.table_schema AND w.viewname = g.table_name WHERE g.grantee = $1 AND g.privilege_type = 'SELECT'",
									[holder]
								)
								const mySeat = String(defined(view?.[0], "the view of holder's MySeat"))
								const reader = yield* s.session({
									as: { _tag: "Login", credentials: installed.as(desk) },
									role: Option.none(),
									label: "claims reader"
								})
								if (setting === "emptied by its transaction's end") {
									yield* reader.begin
									yield* reader.query(setClaims, ['{"Session":{"sub":"u_ann"}}'])
									yield* reader.commit
								}
								yield* reader.begin
								yield* reader.query(`SET LOCAL ROLE ${quoteIdent(holder)}`, [])
								switch (setting) {
									case "set to the empty text":
										yield* reader.query(setClaims, [""])
										break
									case "a document of no fact":
										yield* reader.query(setClaims, ["{}"])
										break
									case "a document naming ann":
										yield* reader.query(setClaims, ['{"Session":{"sub":"u_ann"}}'])
										break
									case "never set":
									case "emptied by its transaction's end":
										break
								}
								const expected = outcomeOf(setting)
								const read = yield* Effect.result(
									reader.query(
										`SELECT 1 WHERE (SELECT pg_catalog.count(*) FROM ${mySeat}) = $1::pg_catalog.int8`,
										[expected.kind === "rows" ? expected.count : 0]
									)
								)
								yield* reader.rollback
								if (expected.kind === "rows") {
									assert.ok(Result.isSuccess(read), `MySeat is read under ${setting}`)
									assert.equal(
										read.success.rowCount,
										1,
										`MySeat holds ${expected.count} seat(s) under ${setting}`
									)
									return
								}
								const fields = defined(
									Result.isFailure(read) ? pgErrorFields(read.failure) : undefined,
									`a read under ${setting} is refused by the server`
								)
								assert.equal(fields.code, "22P02", `a read under ${setting} is refused as 22P02`)
								assert.ok(
									fields.constraint === settingName,
									`the refusal names the claims setting under ${setting}`
								)
								assert.equal(
									Option.getOrUndefined(fields.detail),
									"c-",
									`the refusal's DETAIL is the absent claims' under ${setting}`
								)
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: { kind: "specification", name: "the setting's meaning restated (outcomeOf)" },
		box: "every standing of the claims setting a reader of a context-reading entry reads under: never set, empty, emptied by its transaction's end, a document of no fact and one naming the stored seat's holder",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\${inCatalog("to_jsonb")}(\${refuseClaims(refusal, { kind: "absent" })}) END AS "j"`,
				replacement: `'{}'\${castTo("jsonb")} END AS "j"`,
				why: "An absent setting is read as the empty claims document (sql/print.ts claimsDocument), so a reader that set no claims reads no seat and is refused nothing; the property fails."
			}
		]
	})
