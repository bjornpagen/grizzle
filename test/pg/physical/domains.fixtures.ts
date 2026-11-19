/** What the properties of domains.test.ts read: its spaces, models and helpers. */

import { boolean, constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"

type Base = "int4" | "int8"

/** A contract's physical definition: its base and the least value its predicate admits. */
interface Definition {
	readonly base: Base
	readonly least: number
}

/** Contract A under a definition. */
const contractA = (d: Definition) =>
	d.base === "int4"
		? contract("A", pg.integer, (v) => Compute.ge(v, d.least))
		: contract("A", pg.bigint, (v) => Compute.ge(v, BigInt(d.least)))

/** Contract B under a definition. */
const contractB = (d: Definition) =>
	d.base === "int4"
		? contract("B", pg.integer, (v) => Compute.ge(v, d.least))
		: contract("B", pg.bigint, (v) => Compute.ge(v, BigInt(d.least)))

export const schemaOf = (a: Definition, b: Definition) =>
	schema(
		"fin_domains",
		[relation("R", { id: pg.integer, a: contractA(a), b: contractB(b) }, ["id"])],
		[]
	)

/** Two contracts' definitions, and how far above and below each one's least value the written values lie. */
export interface Pair {
	readonly a: Definition
	readonly b: Definition
	readonly above: number
	readonly below: number
}

const definitionGen: Gen<Definition> = (source) => ({
	base: source.draw(boolean) ? "int8" : "int4",
	least: source.draw(int(-1, 1))
})

export const pairGen: Gen<Pair> = (source) => {
	const a = source.draw(definitionGen)
	return {
		a,
		b: source.draw(
			weighted<Definition>([
				[1, constant(a)],
				[2, definitionGen]
			])
		),
		above: source.draw(int(0, 2)),
		below: source.draw(int(1, 3))
	}
}

export type DomainFeature =
	| "one definition shares one domain"
	| "two definitions take two domains"
	| "a shared domain refuses each contract's violation"

export const same = (p: Pair): boolean => p.a.base === p.b.base && p.a.least === p.b.least
