/**
 * Dependent-sum keys on closed relations, read by PostgreSQL through every reader grizzle installs, over an exhaustive
 * box of small dependent spaces: the alias bar.
 *
 * Each case installs a count relation Model over the owner prefix (Version, Kind), Kind holding a hole at code 1 so a
 * live owner's code lies past its declared position, each live owner counting 1 or 2 slots of Position or holding no
 * row; and a slotted relation Slotted of one of three shapes (two slots; one slot; a closed id of Label before a slot),
 * holding the points of its dependent space whose codes sum to an even number, each with a payload of its own. Every key
 * of the product of the key fields' live codes is then read four ways. The keys include every slot code at or past its
 * owner's count, at which a mixed radix without the range check would land on another key's cell, and each read is
 * judged against the model, Slotted's rows, a second implementation that shares nothing with the packing or the
 * reads:
 *
 * - **the containment CHECK:** a row of CheckProbe holding the key is accepted exactly where Slotted holds the key, and
 *   elsewhere refused by the containment's law, 23514 on the CHECK that reports it;
 * - **C.at in a generated field:** a row of AtProbe is accepted with exactly the key's own payload where Slotted holds
 *   the key, and elsewhere refused by the generated field's law, `{ kind: "generated", relation, field }`: an absent key
 *   reads NULL, which every domain admits, so the generated column's NOT NULL refuses it, 23502 on that column;
 * - **C.row in a generated field:** each prefix's set in RowProbe is exactly the codes Slotted's rows complete it with,
 *   the empty set for a prefix past its owner's count, as Position's bits domain stores it, whole hex digits wide;
 * - **R07's membership read:** a query matching Item against Slotted on every key field delivers exactly the items
 *   whose key Slotted holds; that R07 read its key set, its certificate recorded, is a required feature, never an
 *   assertion of which rewrite the optimizer chose;
 * - **a containment into a projection:** a row of ProjProbe holding an owner and a slot code is accepted exactly where
 *   some row of Slotted holds both, the side (version, parent, last field) a dependent space of its own, and elsewhere
 *   refused by that containment's law.
 *
 * A refusal is judged by the law PostgreSQL's report names, as grizzle's writer names it, never by its SQLSTATE alone: a
 * roster domain's 23514 names no law, grizzle's own defect, and is no refusal any probe expects.
 *
 * No two distinct keys share a cell: an alias would read another key's presence, payload or completions. Each case
 * installs every closed constant, the owner functions' too, as its hex literal, padded with 0 bits to whole digits, so
 * a read past the last cell reads the padding, absent. The box: 3 shapes and every assignment of no row, 1 or 2 slots
 * to the 4 live owners, 243 installations.
 *
 * Features: an aliasing slot digit, an owner with no row, an empty relation, every live owner counting slots, each
 * shape, and R07's read, each required of the space.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { generatedLaw } from "#compiler/plan/change.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import {
	aliases,
	blockOf,
	cases,
	codes,
	type FinCase,
	type FinFeature,
	heldKeys,
	idCode,
	insertSql,
	type Key,
	keyCodes,
	keyText,
	outcomeOf,
	owners,
	payloadState,
	probesOf,
	type Refusal,
	schemaOf
} from "#test/pg/closed/fin.fixtures.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { setText } from "#test/support/closed/bit-text.ts"
import { codecFor } from "#test/support/closed/generate.ts"
import {
	compileTemplate,
	installationSql,
	installedCodes,
	paramTexts,
	testCompile
} from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { ownedInput } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Dependent keys on PostgreSQL every reader reads each key's own cell, and a slot code past its count reads absent.
 */
export const dependentKeysOnPostgreSQLEveryReaderReadsEachKeysOwnCellAndASlotCodePastItsCountReadsAbsent =
	property.exhaust(finite(cases), {
		needs: { substrate: Substrate.installing },
		situations: [
			"an aliasing slot digit",
			"an owner with no row",
			"an empty relation",
			"every live owner counting slots",
			"two slots",
			"one slot",
			"a closed id before a slot",
			"R07 read the key set"
		] satisfies ReadonlyArray<Reached<FinFeature>>,
		check:
			({ substrate }, notes: Case<FinFeature>) =>
			(c: FinCase) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const name = yield* s.schema({ create: false, label: "fin" })
						const installation = identity.schema(parsedSchemaName(name))
						const built = schemaOf(name, c)
						const owned = succeeded(ownedInput(built.base))
						const compiled = succeeded(
							compileInstallation(owned, {
								...completeInstallOptions(owned, [installation], [], [], codes),
								owner: s.owner.role
							})
						)
						yield* transaction(s.admin, installationSql(compiled, s.database))
						const names = compiled.names
						const lawNames = installationNamesOf(compiled)
						const rejected = (law: Law): Option.Option<Refusal> =>
							Option.some({ kind: "rejected", law })
						const checkRefused = rejected(lawNames.described(lawNames.lawOf(built.laws.checked)))
						const projectionRefused = rejected(
							lawNames.described(lawNames.lawOf(built.laws.projected))
						)
						const atRefused = rejected(
							generatedLaw(
								defined(compiled.checked.relations.get("AtProbe"), "AtProbe, the probe relation")
									.name,
								"w"
							)
						)
						const block = blockOf(c.shape)
						const fields = ["id", "version", "kind", ...Arr.map(block, (b) => b.field)]
						const probes = probesOf(c.shape)
						const held = heldKeys(c)
						const payloadAt = new Map(Arr.map(held, (key, at) => [keyText(key), at] as const))
						const valuesOf = (key: Key, n: number) => [idCode(n), ...keyCodes(key)]
						for (const [n, key] of probes.entries()) {
							const at = payloadAt.get(keyText(key))
							const check = yield* outcomeOf(
								compiled,
								"CheckProbe",
								s.admin.query(insertSql(names, "CheckProbe", fields, valuesOf(key, n)), [])
							)
							assert.deepEqual(
								check,
								at === undefined ? checkRefused : Option.none(),
								`the containment CHECK at ${keyText(key)}`
							)
							const read = yield* outcomeOf(
								compiled,
								"AtProbe",
								s.admin.query(insertSql(names, "AtProbe", fields, valuesOf(key, n)), [])
							)
							assert.deepEqual(
								read,
								at === undefined ? atRefused : Option.none(),
								`C.at's generated field at ${keyText(key)}`
							)
							if (aliases(c, key)) {
								notes.note("an aliasing slot digit")
							}
						}
						const stored = yield* s.admin.queryValues(
							`SELECT ${quoteIdent(names.column("AtProbe", "id"))}, ${quoteIdent(names.column("AtProbe", "w"))} FROM ${printObjectName(names.relation("AtProbe"))}`,
							[]
						)
						const payloadCode = (at: number) => codeOf(codecFor(payloadState), `w${at}`)
						assert.deepEqual(
							Arr.sort(
								Arr.map(stored, (row) => `${String(row[0])}:${String(row[1])}`),
								Order.String
							),
							Arr.sort(
								Arr.flatMap(probes, (key, n) => {
									const at = payloadAt.get(keyText(key))
									return at === undefined ? [] : [`${idCode(n)}:${payloadCode(at)}`]
								}),
								Order.String
							),
							"each held key's generated field holds its own payload"
						)
						const prefixFields = fields.slice(0, -1)
						const lastCodes = defined(block[block.length - 1]).codes
						const prefixes = [
							...new Map(
								Arr.map(probes, (key): readonly [string, Key] => {
									const prefix = { owner: key.owner, block: key.block.slice(0, -1) }
									return [keyText(prefix), prefix]
								})
							).values()
						]
						for (const [n, prefix] of prefixes.entries()) {
							yield* s.admin.query(
								insertSql(names, "RowProbe", prefixFields, valuesOf(prefix, n)),
								[]
							)
						}
						const rows = yield* s.admin.queryValues(
							`SELECT ${quoteIdent(names.column("RowProbe", "id"))}, ${quoteIdent(names.column("RowProbe", "next"))}::text FROM ${printObjectName(names.relation("RowProbe"))}`,
							[]
						)
						const completionsOf = (prefix: Key): string =>
							setText(
								lastCodes,
								Arr.filter(
									Array.from({ length: lastCodes }, (_, code) => code),
									(code) =>
										payloadAt.has(keyText({ owner: prefix.owner, block: [...prefix.block, code] }))
								)
							)
						assert.deepEqual(
							Arr.sort(
								Arr.map(rows, (row) => `${String(row[0])}:${String(row[1])}`),
								Order.String
							),
							Arr.sort(
								Arr.map(prefixes, (prefix, n) => `${idCode(n)}:${completionsOf(prefix)}`),
								Order.String
							),
							"each prefix's generated set holds exactly its completions"
						)
						for (const [n, key] of probes.entries()) {
							yield* s.admin.query(insertSql(names, "Item", fields, valuesOf(key, n)), [])
						}
						const projected = new Set(
							Arr.map(held, (key) => `${key.owner}:${defined(key.block[key.block.length - 1])}`)
						)
						for (const owner of Arr.map(owners, (_, o) => o)) {
							for (const last of [0, 1, 2]) {
								const n = owner * 3 + last
								const verdict = yield* outcomeOf(
									compiled,
									"ProjProbe",
									s.admin.query(
										insertSql(
											names,
											"ProjProbe",
											["id", "version", "kind", "last"],
											[idCode(n), ...defined(owners[owner]).codes, last]
										),
										[]
									)
								)
								assert.deepEqual(
									verdict,
									projected.has(`${owner}:${last}`) ? Option.none() : projectionRefused,
									`the containment into Slotted's projection at owner ${owner}, ${last}`
								)
							}
						}
						const template = succeeded(
							compileTemplate(built.membership, built.base, {
								...testCompile,
								installation,
								codes: installedCodes(codes)
							})
						)
						const [optimized] = template.optimized
						const delivered = yield* s.admin.queryValues(
							defined(optimized).sql,
							paramTexts(defined(optimized), {}, { params: template.params, codes })
						)
						assert.deepEqual(
							Arr.sort(
								Arr.map(delivered, (row) => String(row[0])),
								Order.String
							),
							Arr.sort(
								Arr.flatMap(probes, (key, n) =>
									payloadAt.has(keyText(key)) ? [String(idCode(n))] : []
								),
								Order.String
							),
							`the membership read delivers exactly the items whose key Slotted holds:\n${defined(optimized).sql}`
						)
						if (Arr.some(template.certificates, (cert) => cert.rule === "R07.closedMembership")) {
							notes.note("R07 read the key set")
						}
						if (c.held.includes("none")) {
							notes.note("an owner with no row")
						}
						if (held.length === 0) {
							notes.note("an empty relation")
						}
						if (Arr.every(c.held, (h) => h !== "none")) {
							notes.note("every live owner counting slots")
						}
						notes.note(
							c.shape === "follow"
								? "two slots"
								: c.shape === "last"
									? "one slot"
									: "a closed id before a slot"
						)
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "Slotted's rows: the keys it holds, each key's payload and each prefix's completions"
		},
		box: "3 shapes, each of 4 live owners (a hole among Kind's codes) holding no row or counting 1 or 2 slots, every key of the live codes' product",
		kept: [],
		kills: []
	})
