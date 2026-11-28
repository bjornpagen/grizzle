/**
 * Net.within, Net.strictlyWithin and Net.overlaps on PostgreSQL 19 (scalar/compute/registry.ts netContainment): over a
 * batch of drawn pairs of network values, IPv4 and IPv6, each operand an inet or a cidr, the SQL a query's filter holds
 * (`a <<= b`, `a << b`, `a && b`), PostgreSQL's value of it, the host evaluator's over the values grizzle holds (their
 * one text, inet_out's or cidr_out's), and a second implementation of address prefixes, Node's (test/support/oracle/
 * reference/net.ts), are one value for every pair, bit for bit. A pair's second value is drawn related to its first, its
 * address the first's on a drawn prefix and its mask about that prefix and the first's, or unrelated, or of the other
 * family, where every test is false as PostgreSQL defines it.
 *
 * Oracle: Node's BlockList, a second implementation of an address's subnet, and PostgreSQL's own operators.
 *
 * Features: each pair of operand types; each test held and failed; a pair of two families; a value of no mask.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { admitCidr, admitInet } from "#compiler/scalar/values/net.ts"
import {
	cases,
	type Feature,
	featuresOf,
	hostHolds,
	netFns,
	type NetType,
	containmentSql,
	termsOf,
	textOf
} from "#test/pg/net/containment.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { netHolds } from "#test/support/oracle/reference/net.ts"
import { textCell } from "#test/support/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A drawn text as grizzle holds the value it spells: the one text inet_out or cidr_out prints of it. */
const heldText = (type: NetType, text: string): string =>
	succeeded(type === "inet" ? admitInet(text) : admitCidr(text), `${text} is a ${type}`)

/** Network containment on PostgreSQL 19, PostgreSQL's, the host's and a second implementation's values of within, strictly within and overlap are one value for every pair, false across the address families. */
export const netContainmentOnPostgreSQL19PostgreSQLsTheHostsAndASecondImplementationsValuesOfWithinStrictlyWithinAndOverlapAreOneValueForEveryPairFalseAcrossTheAddressFamilies =
	property.explore(cases, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"inet and inet",
			"inet and cidr",
			"cidr and inet",
			"cidr and cidr",
			"within held",
			"within failed",
			"strictly within held",
			"overlap held",
			"overlap failed",
			"two families",
			"no mask"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ tx }, k: CaseOf<Feature>) =>
			(c) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					k.note(`${c.a} and ${c.b}`)
					const texts = Arr.map(c.pairs, (p) => ({ a: textOf(p.a), b: textOf(p.b) }))
					const rows = yield* db.values(containmentSql(c.a, c.b), [
						jsonText(Arr.map(texts, ({ a, b }, ord) => ({ ord, a, b })))
					])
					const terms = termsOf(c.a, c.b)
					for (const [at, fn] of netFns.entries()) {
						yield* agree<ReadonlyArray<boolean>>(
							[
								[
									"PostgreSQL",
									Arr.map(rows, (row) => {
										const cell = textCell(row, at)
										assert.ok(cell === "true" || cell === "false", `${fn} is a boolean`)
										return cell === "true"
									})
								],
								[
									"the host",
									Arr.map(texts, ({ a, b }) =>
										hostHolds(terms[fn], heldText(c.a, a), heldText(c.b, b))
									)
								],
								["Node's BlockList", Arr.map(texts, ({ a, b }) => netHolds(fn, a, b))]
							],
							ordered(exact)
						)
					}
					for (const [at, pair] of c.pairs.entries()) {
						const row = rows[at] ?? []
						for (const feature of featuresOf(
							pair,
							textCell(row, 0) === "true",
							textCell(row, 1) === "true",
							textCell(row, 2) === "true"
						)) {
							k.note(feature)
						}
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "Node's BlockList's subnet of an address, beside PostgreSQL's own operators"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/net.ts",
				original:
					"\ta.family === b.family && a.bits >= b.bits && bitncmp(a.address, b.address, b.bits) === 0",
				replacement: "\ta.bits >= b.bits && bitncmp(a.address, b.address, b.bits) === 0",
				why: "The host's within holds across the address families: an IPv4 value of no mask within an IPv6 network of none, where PostgreSQL and Node say false."
			},
			{
				file: "packages/engine/src/scalar/values/net.ts",
				original:
					"\ta.family === b.family && a.bits > b.bits && bitncmp(a.address, b.address, b.bits) === 0",
				replacement:
					"\ta.family === b.family && a.bits >= b.bits && bitncmp(a.address, b.address, b.bits) === 0",
				why: "The host's strictly within holds of a network and itself, where PostgreSQL's `<<` is false."
			},
			{
				file: "packages/engine/src/scalar/values/net.ts",
				original: "\tif (n % 8 === 0) {\n\t\treturn 0\n\t}",
				replacement: "\tif (n % 8 !== 8) {\n\t\treturn 0\n\t}",
				why: "The host compares whole bytes of a mask alone, never its bits past the last whole byte, so a /25 holds every address of its /24."
			}
		]
	})
