import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import {
	type Codebook,
	draftCodebook,
	firstCodebook,
	keptRosters,
	noRenames
} from "#compiler/ir/codes.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { Compute } from "#compiler/public/compute.ts"
import { bits, closedId, contract, generated, pg, uuid } from "#compiler/public/fields.ts"
import { check, closed, relation, type Statement } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { type Owned, rostersOf } from "#compiler/schema/own.ts"
import { materializedDerived } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import { succeeded } from "#test/support/assert.ts"
import { type BuiltSchema, generatedSchemaName } from "#test/support/oracle/public/build.ts"
import type { ProgramSchema } from "#test/support/oracle/public/program.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * A level of laws over a generated public schema, drawn beside it: what the public draw's own vocabulary holds no
 * instance of, an installation's refusals and served files meet. The public draw (generate.ts) is untouched: every
 * suite that draws a case draws exactly what it drew before, and a suite that reads this level extends the case's schema
 * with it (schema.extend), as an application's later level does.
 *
 * The level holds:
 * - a roster whose previous declaration held handles it no longer declares, each one's code a hole that no handle takes
 *   again, so the installation's codes are history (ir/cells.ts rosterCodes): holes before, between or after its live
 *   handles;
 * - a holder relation of a closed id of the roster, a set over it and a checked contract's field, keyed by its id, by
 *   its closed id (a code key) or by both;
 * - a counter relation of a second checked contract's field and an integer, perhaps with a generated column over the
 *   contract's base value, and perhaps a table CHECK on the integer;
 * - the two contracts of one definition, whose one domain then types both relations' columns, or of two;
 * - a materialized derived relation over the case's first relation, each of its facts as it is, which a read of the level
 *   reads as a materialized view and a refresh alone changes.
 *
 * Every count is a search budget.
 */
export interface LawLevel {
	/** Before each live handle of the roster, in code order, how many retired handles' holes; one live handle at least. */
	readonly holes: Arr.NonEmptyReadonlyArray<number>
	/** How many retired handles' holes follow the last live one. */
	readonly trailing: number
	readonly key: "id" | "code" | "both"
	/** The two contracts' least values: one value is one definition, so one domain. */
	readonly least: readonly [number, number]
	readonly generated: boolean
	readonly check: boolean
}

export const lawLevelGen: Gen<LawLevel> = (source) => {
	const first = source.draw(int(-1, 1))
	return {
		holes: [source.draw(int(0, 2)), ...source.draw(array(int(0, 2), { min: 0, max: 2 }))],
		trailing: source.draw(int(0, 2)),
		key: source.draw(element(["id", "code", "both"] as const)),
		least: [first, source.draw(element([first, first + 1]))],
		generated: source.draw(boolean),
		check: source.draw(boolean)
	}
}

/** The features a law level holds, as the suites reading it name them. */
export type LawFeature =
	| "a roster with a hole"
	| "a generated column"
	| "a table CHECK"
	| "contracts sharing one domain"
	| "a code key"

export const lawFeatures = (level: LawLevel): ReadonlyArray<LawFeature> => [
	...(Arr.some([...level.holes, level.trailing], (n) => n > 0)
		? (["a roster with a hole"] as const)
		: []),
	...(level.generated ? (["a generated column"] as const) : []),
	...(level.check ? (["a table CHECK"] as const) : []),
	...(level.least[0] === level.least[1] ? (["contracts sharing one domain"] as const) : []),
	...(level.key === "id" ? [] : (["a code key"] as const))
]

/** `base`, or `base` followed by zeros until it is none of `taken`: a name the case's schema does not declare. */
const fresh = (base: string, taken: ReadonlySet<string>): string =>
	taken.has(base) ? fresh(`${base}0`, taken) : base

/** A relation of the level, by its declared name, with its field descriptors. */
export interface LevelRelation {
	readonly name: string
	readonly value: unknown
	readonly fields: Readonly<Record<string, unknown>>
}

/**
 * The case's schema extended by its law level: the extension, the level's stored relations, its materialized view, and
 * the codes it is installed under.
 */
export interface Laws {
	readonly schema: ReturnType<typeof extendedOf>
	readonly relations: ReadonlyArray<LevelRelation>
	readonly view: { readonly name: string; readonly value: AnyDerived }
	/** The installation's codes over `owned`, the extension owned: every roster's first, the level's with its holes. */
	readonly codes: (owned: Owned) => Codebook
}

const extendedOf = (
	built: BuiltSchema,
	name: string,
	relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>>,
	statements: ReadonlyArray<Statement>
) => schema.extend(built.schema, name, Rec.values(relations), statements, [])

/** The level `level` over the case's schema `s`, built over its values `built` (see the header). */
export const lawsOf = (s: ProgramSchema, built: BuiltSchema, level: LawLevel): Laws => {
	const taken = new Set([s.roster.name, ...Arr.map(s.relations, (r) => r.name)])
	const live = mapNonEmpty(level.holes, (_, i) => `live${i}`)
	const previous = Arr.appendAll(
		Arr.flatMap(level.holes, (count, i) =>
			Arr.append(
				upTo(count, (j) => `gone${i}x${j}`),
				`live${i}`
			)
		),
		upTo(level.trailing, (j) => `goneLast${j}`)
	)
	const kindName = fresh("LawKind", taken)
	const Kind = closed(kindName, live)
	const Count = contract("LawCount", pg.integer, (x) => x.ge(level.least[0]))
	const Tally = contract("LawTally", pg.integer, (x) => x.ge(level.least[1]))
	const holderName = fresh("LawHolder", taken)
	const holderFields = { id: uuid, code: closedId(Kind), marks: bits(Kind), count: Count }
	const Holder =
		level.key === "id"
			? relation(holderName, holderFields, ["id"])
			: level.key === "code"
				? relation(holderName, holderFields, ["code"])
				: relation(holderName, holderFields, ["id", "code"])
	const counterName = fresh("LawCounter", taken)
	const counterFields = { id: uuid, tally: Tally, base: pg.integer }
	const Counter = level.generated
		? relation.generated(counterName, counterFields, ["id"], (r) => ({
				spare: generated(pg.integer, Compute.base(r.tally))
			}))
		: relation(counterName, counterFields, ["id"])
	const viewName = fresh("LawView", taken)
	const [first] = s.relations
	const read = built.relation(first)
	const View = materializedDerived(
		viewName,
		queryOver(built.schema).rule((r: RuleValue) => {
			const fact = varsOver(read, "fact")
			return r.match(read, fact).find(fact)
		}),
		[]
	)
	const value = extendedOf(
		built,
		fresh(`${generatedSchemaName}Laws`, taken),
		{ [kindName]: Kind, [holderName]: Holder, [counterName]: Counter, [viewName]: View },
		level.check ? [check("BaseNotNegative", Counter, (x) => x.ge(x.base, 0))] : []
	)
	return {
		schema: value,
		relations: [
			{ name: holderName, value: Holder, fields: Holder.fields },
			{ name: counterName, value: Counter, fields: Counter.fields }
		],
		view: { name: viewName, value: View },
		codes: (owned) => {
			const declared = rostersOf(owned)
			return succeeded(
				draftCodebook(
					keptRosters(
						firstCodebook(
							Arr.map(declared, (r) => (r.closed === kindName ? Roster.of(r.closed, previous) : r))
						)
					),
					noRenames,
					declared
				),
				"the level's codes"
			)
		}
	}
}
