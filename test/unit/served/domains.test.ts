/**
 * Every domain a served program or an artifact of its installation types a value by is installed, whatever stored field
 * declares it, and none need: one collector for every kind (physical/install/plan.ts artifactDomains, ServedTypes), its
 * structural text refinements' domains and its contracts' alike, so a read of a declared function's result, of
 * r.tokens' token or of a contract only a function's result or a query declares compiles. One source of truth holds a
 * value's physical type: the type a column or a cast of it names (ir/physical.ts fieldColumnType), its refinement's or
 * its contract's domain, which the installation holds and snapshot.json records for a Db's compile. A declared
 * function's row type holds each value field at its base, `text` for a refined text and the contract's base for a
 * contract, since its body returns those, and the read's cast of the call's value to the field's domain is the one
 * check PostgreSQL makes of what the body returned; the decoder trusts the value because that cast ran.
 *
 * - **Property:** a case draws a refined text type (an alternation, a character class, a byte-bounded pattern), where
 *   it and the contract Count are named (by the functions' results alone, or by stored fields too, the control), and
 *   how a served program reads them (a stored derived relation whose definition reads a function's rows and finds
 *   none of their fields, a function's rows, whose Count field no read finds but its cast checks, a field of rows of
 *   its one row, its value of the refinement, its value of the contract, a contract only the query's cast declares, its
 *   rows carried by a ChangeSet's shared sub-query, r.tokens' token found or carried). The login compiles as generate
 *   compiles it and again under its snapshot.json as a Db compiles it; every text and contract domain its statements
 *   and its installation's view definitions name is one its installation creates, and they name one; every row type a
 *   function's signature installs holds no such domain; and a role that creates a carrier holds USAGE on each domain a
 *   carrier's field is typed by.
 * - **Oracle:** the specification: every case compiles; the installation's catalog holds every domain its statements
 *   name.
 * - **Features:** each refinement, place and read.
 *
 * Red on the old naming (main a4434b75f), each function-only case and every token case refused at generate:
 * "MalformedDescription at physical names: physical: no structural text domain for /^(alpha|beta)$/u", and the
 * tokens', "UnsupportedOperation at conservative lowering at shared sub-query n6: the domain name of the text
 * refinement text ~ /^[^\t\n\r ]+$/u, which no stored field declares"; a function-only contract, "UninstalledDomain
 * at physical names: the installation installs no domain of contract Count, which no stored field, context field or
 * served parameter of it is typed by".
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	caseGen,
	checkCase,
	type Placement,
	type Read,
	type Refinement
} from "#test/unit/served/domains.fixtures.ts"

type TextDomainFeature = Refinement | Placement | Read | "a carrier of a text domain"

const situations = [
	"an alternation",
	"a character class",
	"a byte-bounded pattern",
	"a function's result alone",
	"a stored field too",
	"a derived relation over a function's rows found",
	"a function's rows found",
	"a field of a function's row found",
	"a function's value found",
	"a function's contract value found",
	"a query's own contract found",
	"a function's rows carried",
	"a text's tokens found",
	"a text's tokens carried",
	"a carrier of a text domain"
] as const satisfies ReadonlyArray<Reached<TextDomainFeature>>

/**
 * A read of a refined text or a contract a function's result, a token or a query types compiles, its every domain
 * installed, whatever stored field declares it. Each case compiles a fresh login, so its budget is the runner's.
 */
export const everyDomainAServedProgramOrItsInstallationTypesAValueByIsInstalled = property.explore(
	caseGen,
	{
		needs: {},
		situations,
		check: (_, k: Case<TextDomainFeature>) => (c) =>
			Effect.gen(function* () {
				const compiled = yield* Effect.result(checkCase(c))
				if (compiled._tag === "Failure") {
					return assert.fail(
						`the case's login compiles: ${Formatter.format(compiled.failure)}\n${Formatter.format(c)}`
					)
				}
				k.note(c.refinement)
				k.note(c.place)
				k.note(c.read)
				if (compiled.success.carried) {
					k.note("a carrier of a text domain")
				}
			}),
		oracle: {
			kind: "specification",
			name: "every case compiles, and the installation creates every domain its statements name"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original: "\tfor (const regex of refinements) {\n\t\toutside(regex)\n\t}\n",
				replacement: "",
				why: "The installation's text domains are its stored fields' and columns' alone, the old naming: a function's result or a token of a pattern no column carries has no domain, and its read is refused as UninstalledDomain."
			},
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original:
					"[...own.texts, ...fields.flatMap((f) => typeRefinements(f.type)), ...planned.texts]",
				replacement: "[...own.texts, ...fields.flatMap((f) => typeRefinements(f.type))]",
				why: "The served programs' refinements are not installed: a token's domain is uninstalled, and its read is refused."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: "\t\tcolumnDomains(b, carried.columns, use)\n",
				replacement: "",
				why: "A role that creates a carrier of a token or a function's result lacks USAGE on the domain of the carrier's field, which the statements filling the carrier cast into."
			},
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original:
					"\t\t\toutsideContracts(owned, fields, [...planned.contracts, ...planned.typed, ...own.contracts])\n",
				replacement:
					"\t\t\toutsideContracts(owned, fields, [...planned.contracts, ...planned.typed])\n",
				why: "The installation's own artifacts' contracts are not installed, the old piecewise rule: a contract only a function's result declares has no domain where a derived definition's call casts to it, and the installation is refused as UninstalledDomain."
			},
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original: "\t\ttyped: held.contracts,\n",
				replacement: "\t\ttyped: [],\n",
				why: "A served program's contracts are its parameters' alone: a contract only a query's cast declares has no domain, and the read is refused as UninstalledDomain."
			}
		]
	}
)
