import { assert, defined } from "@bjornpagen/testing/assert"
import {
	aimed,
	array,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	recorded,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { type Case as PropertyCase } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, pipe, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Logic, Type } from "#compiler/public/compute.ts"
import {
	closedId,
	contract,
	generated,
	mintOf,
	Uuid,
	Vector,
	int4,
	vector
} from "#compiler/public/fields.ts"
import { check, closed, mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { derivedLaw } from "#compiler/runtime/law-entry.ts"
import { succeeded } from "#test/support/assert.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { Id, type IdValue, toId } from "#test/support/ids.ts"
import { type Generated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { fixtureTemplate, openedIn } from "#test/support/pg/reads/support.ts"
import { refusedLaws } from "#test/support/refused.ts"
import type { SubstrateCase } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

const tiers = ["bronze", "silver", "gold"] as const
type TierHandle = (typeof tiers)[number]

/** Each tier's rate, as the closed relation Rate holds it: gold holds none, so a gold account's rate is NULL. */
const rates: Readonly<Record<TierHandle, number | undefined>> = {
	bronze: 100,
	silver: 500,
	gold: undefined
}

const Tier = closed.ordered("Tier", tiers)
const Rate = closed.relation(
	"Rate",
	{ tier: closedId(Tier), rate: int4 },
	["tier"],
	[
		{ tier: "bronze", rate: 100 },
		{ tier: "silver", rate: 500 }
	]
)
const unitsKey = Symbol("Units")
const Units = contract<typeof unitsKey>()("Units", int4, (x) => Logic.le(x, 1000))
const toUnits = mintOf(unitsKey)
/** The pattern an account's code and its alias share, so one domain types both columns, each field its own law. */
const codeSource = "^[a-z]{1,8}$"
const Account = relation.generated(
	"Account",
	{
		id: Id,
		tier: closedId(Tier),
		units: Units,
		code: str.regex(codeSource, "u"),
		alias: str.regex(codeSource, "u"),
		from: vector(2),
		to: vector(2)
	},
	["id"],
	(r) => ({ rate: generated(int4, Rate.at("rate", r.tier)) })
)
const positive = check("Positive", Account, (x) => x.gt(x.units, 0))
const withinRate = check("WithinRate", Account, (x) => x.le(Type.base(x.units), x.rate))
/** An account's two vectors differ: a row CHECK over vector fields, which the host judges by vector_cmp's order. */
const distinct = check("Distinct", Account, (x) => x.ne(x.from, x.to))
/** Each account's row its own unit: accounts are put, so Account is mutable. */
const Accounts = schema(
	"Accounts",
	[Tier, Rate, Account],
	[positive, withinRate, distinct, mutable(Account), unit("Holder", { id: Id })]
)

/** The vectors an account's two fields hold: east in both, or east and north. */
const east = succeeded(Vector.from(Float32Array.from([1, 0]), 2), "a unit vector")
const north = succeeded(Vector.from(Float32Array.from([0, 1]), 2), "a unit vector")

/** The full role's workload: accounts inserted, and accounts put, each from its call's facts. */
const programs = {
	insertAccounts: ChangeSet.empty(Accounts).insert(Account, []),
	putAccounts: ChangeSet.empty(Accounts).put(Account, [])
} as const

/** Every law a stated account can break, as an outcome names it. */
const lawOf = {
	positive: derivedLaw({ kind: "check", relation: "Account", name: "Positive" }),
	withinRate: derivedLaw({ kind: "check", relation: "Account", name: "WithinRate" }),
	distinct: derivedLaw({ kind: "check", relation: "Account", name: "Distinct" }),
	units: derivedLaw({ kind: "contract", contract: "Units" }),
	code: derivedLaw({
		kind: "pattern",
		relation: "Account",
		field: "code",
		patterns: [{ source: codeSource, flags: "u" }]
	}),
	alias: derivedLaw({
		kind: "pattern",
		relation: "Account",
		field: "alias",
		patterns: [{ source: codeSource, flags: "u" }]
	}),
	rate: derivedLaw({ kind: "generated", relation: "Account", field: "rate" })
} as const satisfies Readonly<Record<string, Law>>
type Broken = keyof typeof lawOf

/** The rules of the one domain the code and the alias share. */
const patternRules = ["code", "alias"] as const satisfies ReadonlyArray<Broken>

/** The rules of Account's row CHECKs, every one of which the host judges, so a refusal by one names each its row breaks. */
const checkRules = ["positive", "withinRate", "distinct"] as const satisfies ReadonlyArray<Broken>

/** An account as a case draws it, its id its position's. */
interface Stated {
	readonly tier: TierHandle
	readonly units: number
	readonly code: string
	readonly alias: string
	/** Whether its two vectors point apart, or the same way, which Distinct refuses. */
	readonly heading: "apart" | "same"
}

/** A code inside the pattern about half the time: lowercase letters, or printable ASCII of any length up to twelve. */
const codeGen: Gen<string> = oneOf([
	string(codePoint(0x61, 0x7a), { min: 1, max: 8 }),
	string(codePoint(0x20, 0x7e), { min: 0, max: 12 })
])

/**
 * An alias inside the pattern three times in four, so an account breaks the code alone, the alias alone and both, and
 * a write of every account inside every rule stays common.
 */
const aliasGen: Gen<string> = weighted([
	[3, string(codePoint(0x61, 0x7a), { min: 1, max: 8 })],
	[1, codeGen]
])

const statedGen: Gen<Stated> = (source) => ({
	tier: source.draw(element(tiers)),
	units: source.draw(oneOf([int(-3, 0), int(1, 120), int(400, 1000), int(1001, 1100)])),
	code: source.draw(codeGen),
	alias: source.draw(aliasGen),
	heading: source.draw(
		weighted([
			[3, constant("apart" as const)],
			[1, constant("same" as const)]
		])
	)
})

/** A case: one write of one to four accounts, inserted or put. */
export interface AccountCase {
	readonly op: "insert" | "put"
	readonly accounts: ReadonlyArray<Stated>
}

const accountCaseGen: Gen<AccountCase> = (source) => ({
	op: source.draw(element(["insert", "put"] as const)),
	accounts: source.draw(array(statedGen, { min: 1, max: 4 }))
})

/** A code in the pattern, one to eight lowercase letters, and one outside it, one to eight uppercase ones. */
const inPattern = string(codePoint(0x61, 0x7a), { min: 1, max: 8 })
const outsidePattern = string(codePoint(0x41, 0x5a), { min: 1, max: 8 })

/** Units a bronze account holds inside its rate of 100, past it inside Units, past Units, and at most 0. */
const withinBronze = int(1, 100)
const pastBronze = int(101, 1000)
const pastUnits = int(1001, 1100)
const notPositive = int(-3, 0)

/** An account of `tier` whose units, code and alias each `units`, `code` and `alias` draw, its vectors `heading`. */
const accountGen =
	(
		tier: TierHandle,
		units: Gen<number>,
		code: Gen<string>,
		alias: Gen<string>,
		heading: Stated["heading"]
	): Gen<Stated> =>
	(source) => ({
		tier,
		units: source.draw(units),
		code: source.draw(code),
		alias: source.draw(alias),
		heading
	})

/** A bronze account inside every rule. */
const lawful = accountGen("bronze", withinBronze, inPattern, inPattern, "apart")

/** A write, inserted or put, of the accounts `accounts` draws. */
const writeOf =
	(accounts: Gen<ReadonlyArray<Stated>>): Gen<AccountCase> =>
	(source) => ({
		op: source.draw(element(["insert", "put"] as const)),
		accounts: source.draw(accounts)
	})

/** A write of one account `account` draws. */
const one = (account: Gen<Stated>): Gen<AccountCase> => writeOf((source) => [source.draw(account)])

/**
 * The case a witness whose turn aims at a situation draws (aimed), each a write constructed to reach it, where a drawn
 * write meets it seldom: four drawn accounts are rarely all inside every rule, and the pattern's and Units' domains,
 * which PostgreSQL meets as it casts a row, refuse most drawn accounts before any row CHECK is read. One account
 * breaking each rule alone (gold's rate, NULL, refused by the generated column's NOT NULL), the code and the alias
 * both, two row CHECKs at once (past its rate, its vectors alike), one to four accounts inside every rule, and two
 * accounts breaking one rule.
 */
const accountAims: ReadonlyArray<readonly [AccountFeature, Gen<AccountCase>]> = [
	["accepted", writeOf(array(lawful, { min: 1, max: 4 }))],
	["refused by rate", one(accountGen("gold", withinBronze, inPattern, inPattern, "apart"))],
	["refused by units", one(accountGen("bronze", pastUnits, inPattern, inPattern, "apart"))],
	["refused by positive", one(accountGen("bronze", notPositive, inPattern, inPattern, "apart"))],
	["refused by withinRate", one(accountGen("bronze", pastBronze, inPattern, inPattern, "apart"))],
	["refused by distinct", one(accountGen("bronze", withinBronze, inPattern, inPattern, "same"))],
	["refused by code", one(accountGen("bronze", withinBronze, outsidePattern, inPattern, "apart"))],
	["refused by alias", one(accountGen("bronze", withinBronze, inPattern, outsidePattern, "apart"))],
	[
		"refused by the code and the alias at once",
		one(accountGen("bronze", withinBronze, outsidePattern, outsidePattern, "apart"))
	],
	[
		"refused by two row CHECKs at once",
		one(accountGen("bronze", pastBronze, inPattern, inPattern, "same"))
	],
	[
		"witnessed among several breaking accounts",
		writeOf(
			array(accountGen("bronze", pastBronze, inPattern, inPattern, "apart"), { min: 2, max: 4 })
		)
	]
]

const idOf = (n: number): IdValue =>
	toId(
		succeeded(
			Uuid.parse(
				`00000000-0000-4000-8000-${pipe((0x7000 + n).toString(16), Str.padStart(12, "0"))}`
			),
			"a version 4 uuid's text"
		)
	)

/** The rule an outcome's law is, among the accounts' rules; undefined for any other law. */
const brokenOf = (law: Law): Broken | undefined => {
	switch (law.kind) {
		case "check":
			return law.relation !== "Account"
				? undefined
				: law.name === "Positive"
					? "positive"
					: law.name === "WithinRate"
						? "withinRate"
						: law.name === "Distinct"
							? "distinct"
							: undefined
		case "contract":
			return law.contract === "Units" ? "units" : undefined
		case "pattern":
			return law.relation !== "Account"
				? undefined
				: law.field === "code"
					? "code"
					: law.field === "alias"
						? "alias"
						: undefined
		case "generated":
			return law.relation === "Account" && law.field === "rate" ? "rate" : undefined
		case "primaryKey":
		case "key":
		case "contained":
		case "coverage":
		case "family":
		case "tree":
		case "above":
		case "fold":
		case "variant":
		case "sealed":
			return undefined
	}
}

/** Whether a code is in ^[a-z]{1,8}$: one to eight ASCII lowercase letters. */
const isCode = (code: string): boolean =>
	code.length >= 1 &&
	code.length <= 8 &&
	Arr.every(
		upTo(code.length, (i) => i),
		(i) => Option.exists(Str.charCodeAt(code, i), (unit) => unit >= 0x61 && unit <= 0x7a)
	)

/** The laws an account breaks, by the model: each rule restated over its fields alone. */
const brokenBy = (a: Stated): ReadonlySet<Broken> => {
	const out = new Set<Broken>()
	const rate = rates[a.tier]
	if (rate === undefined) {
		out.add("rate")
	}
	if (a.units > 1000) {
		out.add("units")
	}
	if (a.units <= 0) {
		out.add("positive")
	}
	if (rate !== undefined && a.units <= 1000 && a.units > rate) {
		out.add("withinRate")
	}
	if (!isCode(a.code)) {
		out.add("code")
	}
	if (!isCode(a.alias)) {
		out.add("alias")
	}
	if (a.heading === "same") {
		out.add("distinct")
	}
	return out
}

export type AccountFeature =
	| `refused by ${Broken}`
	| "accepted"
	| "witnessed among several breaking accounts"
	| "refused by the code and the alias at once"
	| "refused by two row CHECKs at once"

/**
 * A native refusal witnessed on the host, against PostgreSQL 19.
 *
 * Accounts holds, on one relation, every native refusal the host judges a stated fact against: a row CHECK over a
 * written field (Positive), a row CHECK over a generated field (WithinRate, units at most the rate), a row CHECK over two
 * vector fields (Distinct, from <> to), which the host evaluates over the vectors' own host values, a contract's domain
 * (Units, at most 1000), a pattern's domain (^[a-z]{1,8}$), which the code and the alias share, each its own law, and a
 * generated column's NOT NULL (rate, Rate.at("rate", tier), which Rate holds no row of for gold). Each case writes one
 * to four accounts, inserted or put, each drawn inside or outside each rule.
 *
 * The oracle is the rules restated over the drawn fields: a write none of whose accounts breaks a rule is accepted;
 * any other is invariant-rejected, `every`, its witness the key of an account that breaks what it names, never
 * `unreported`: every account is stated, so the host holds it. Where PostgreSQL met a row CHECK, every one of which the
 * host judges, it names every row CHECK's law the account breaks, whichever PostgreSQL tried first; where it met the
 * pattern's domain, which names no column, exactly the pattern laws of the account's fields it refuses, the code's, the
 * alias's or both, in their columns' canonical order; and where it met any other object, one law the account breaks.
 */
export const hostCase = (
	taken: SubstrateCase<Generated>,
	k: AccountCase,
	c: PropertyCase<AccountFeature>
) =>
	Effect.gen(function* () {
		const o = yield* openedIn(Accounts, {}, accountsInstall, taken)
		const names = namesOf(o.installed)

		return yield* Effect.gen(function* () {
			const db = yield* Db.open(o.served.login.roles.app, {})
			const facts = Arr.map(k.accounts, (a, i) => ({
				id: idOf(i),
				tier: a.tier,
				units: toUnits(a.units),
				code: a.code,
				alias: a.alias,
				from: east,
				to: a.heading === "same" ? east : north
			}))
			const applied = yield* Effect.result(
				k.op === "insert"
					? writeAnswerOf(
							db.workload.insertAccounts.once({
								params: {},
								facts: { insert: { Account: facts } }
							})
						)
					: writeAnswerOf(
							db.workload.putAccounts.once({
								params: {},
								facts: { put: { Account: facts } }
							})
						)
			)
			assert.ok(Result.isSuccess(applied), "the write is an outcome")
			const outcome = applied.success
			const broken = Arr.map(k.accounts, brokenBy)
			if (Arr.every(broken, (b) => b.size === 0)) {
				assert.equal(outcome._tag, "accepted")
				c.note("accepted")
				return
			}
			if (outcome._tag !== "refused") {
				return assert.fail(`a write that breaks a rule is refused, not ${outcome._tag}`)
			}
			assert.equal(
				outcome.refused.kind,
				"every",
				"every account is stated, so the host judges the refused one"
			)
			const named: ReadonlyArray<Broken> = Arr.map(refusedLaws(outcome.refused), (law): Broken => {
				const rule = brokenOf(law)
				if (rule === undefined) {
					return assert.fail(`the law ${Formatter.format(law)} is one of the accounts' rules`)
				}
				assert.deepEqual(law, lawOf[rule])
				return rule
			})
			const witness = outcome.witness
			if (witness.kind !== "key") {
				return assert.fail("every account is stated, so the host witnesses it")
			}
			assert.equal(witness.relation, "Account")
			const at = Arr.findFirstIndex(facts, (f) => f.id === witness.values["id"])
			if (Option.isNone(at)) {
				return assert.fail("the witness is a stated account's key")
			}
			const breaks = defined(broken[at.value], "the witnessed account's rules")
			const patterns = Arr.filter(named, (rule) => Arr.contains(patternRules, rule))
			const checks = Arr.filter(named, (rule) => Arr.contains(checkRules, rule))
			if (checks.length > 0) {
				assert.deepEqual(
					Arr.sort(named, Order.String),
					Arr.sort(
						Arr.filter(checkRules, (rule) => breaks.has(rule)),
						Order.String
					),
					"a row CHECK's refusal names every row CHECK's law the witnessed account breaks"
				)
				if (checks.length > 1) {
					c.note("refused by two row CHECKs at once")
				}
			} else if (patterns.length === 0) {
				assert.equal(named.length, 1, "one law")
				assert.ok(
					Arr.every(named, (rule) => breaks.has(rule)),
					"the witnessed account breaks the law"
				)
			} else {
				assert.deepEqual(
					named,
					Arr.sortWith(
						Arr.filter(patternRules, (rule) => breaks.has(rule)),
						(rule) => names.columnIdent(Account, rule),
						Order.String
					),
					"the pattern's domain names exactly the witnessed account's fields it refuses, in their columns' canonical order"
				)
				if (patterns.length > 1) {
					c.note("refused by the code and the alias at once")
				}
			}
			for (const rule of named) {
				c.note(`refused by ${rule}`)
			}
			if (Arr.filter(broken, (b) => Arr.some(named, (rule) => b.has(rule))).length > 1) {
				c.note("witnessed among several breaking accounts")
			}
		}).pipe(Effect.scoped, withLayer(o.served.layer))
	})

/** Accounts with its programs, installed once per member as a read fixture, where the suite installed it. */
const accountsInstall = { label: "real", programs } as const

export const accountsTemplate = fixtureTemplate(import.meta, Accounts, accountsInstall)

/**
 * The cases kept by value the suite's space draws beyond toolchain-test keep, each a red it once caught, recorded beside
 * its space (gen.ts recorded).
 */
const recordedAccounts: Arr.NonEmptyReadonlyArray<AccountCase> = [
	{
		op: "insert",
		accounts: [{ tier: "bronze", units: 10, code: "a", alias: "A1", heading: "apart" }]
	},
	{
		op: "put",
		accounts: [{ tier: "silver", units: 5, code: "Q", alias: "", heading: "apart" }]
	}
]

/** The suite's space: drawn writes beside its recorded values, each situation's turn aimed at it (accountAims). */
export const accountCases = aimed(recorded(accountCaseGen, recordedAccounts), accountAims)
