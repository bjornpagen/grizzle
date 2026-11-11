import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, pipe, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, generated, pg, Uuid, uuid } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
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

const Tier = closed("Tier", tiers)
const Rate = closed.relation(
	"Rate",
	{ tier: closedId(Tier), rate: pg.integer },
	["tier"],
	[
		{ tier: "bronze", rate: 100 },
		{ tier: "silver", rate: 500 }
	]
)
const Units = contract("Units", pg.integer, (x) => x.le(1000))
/** The pattern an account's code and its alias share, so one domain types both columns, each field its own law. */
const codeSource = "^[a-z]{1,8}$"
const Account = relation.generated(
	"Account",
	{
		id: uuid,
		tier: closedId(Tier),
		units: Units,
		code: str.regex(codeSource, "u"),
		alias: str.regex(codeSource, "u")
	},
	["id"],
	(r) => ({ rate: generated(pg.integer, Rate.at("rate", r.tier)) })
)
const positive = check("Positive", Account, (x) => x.gt(x.units, 0))
const withinRate = check("WithinRate", Account, (x) => x.le(Compute.base(x.units), x.rate))
const Accounts = schema("Accounts", [Tier, Rate, Account], [positive, withinRate])

/** The full role's workload: accounts inserted, and accounts put, each from its call's facts. */
const programs = {
	insertAccounts: ChangeSet.empty(Accounts).insert(Account, []),
	putAccounts: ChangeSet.empty(Accounts).put(Account, [])
} as const

/** Every law a stated account can break, as an outcome names it. */
const lawOf = {
	positive: { kind: "check", relation: "Account", name: "Positive" },
	withinRate: { kind: "check", relation: "Account", name: "WithinRate" },
	units: { kind: "contract", contract: "Units" },
	code: {
		kind: "pattern",
		relation: "Account",
		field: "code",
		patterns: [{ source: codeSource, flags: "u" }]
	},
	alias: {
		kind: "pattern",
		relation: "Account",
		field: "alias",
		patterns: [{ source: codeSource, flags: "u" }]
	},
	rate: { kind: "generated", relation: "Account", field: "rate" }
} as const satisfies Readonly<Record<string, Law>>
type Broken = keyof typeof lawOf

/** The rules of the one domain the code and the alias share. */
const patternRules = ["code", "alias"] as const satisfies ReadonlyArray<Broken>

/** An account as a case draws it, its id its position's. */
interface Stated {
	readonly tier: TierHandle
	readonly units: number
	readonly code: string
	readonly alias: string
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
	alias: source.draw(aliasGen)
})

/** A case: one write of one to four accounts, inserted or put. */
interface Case {
	readonly op: "insert" | "put"
	readonly accounts: ReadonlyArray<Stated>
}

const caseGen: Gen<Case> = (source) => ({
	op: source.draw(element(["insert", "put"] as const)),
	accounts: source.draw(array(statedGen, { min: 1, max: 4 }))
})

const idOf = (n: number): Uuid =>
	succeeded(
		Uuid.parse(`00000000-0000-4000-8000-${pipe((0x7000 + n).toString(16), Str.padStart(12, "0"))}`),
		"a version 4 uuid's text"
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
	return out
}

type Feature =
	| `refused by ${Broken}`
	| "accepted"
	| "witnessed among several breaking accounts"
	| "refused by the code and the alias at once"

/**
 * A native refusal witnessed on the host, against PostgreSQL 19.
 *
 * Accounts holds, on one relation, every native refusal the host judges a stated fact against: a row CHECK over a
 * written field (Positive), a row CHECK over a generated field (WithinRate, units at most the rate), a contract's domain
 * (Units, at most 1000), a pattern's domain (^[a-z]{1,8}$), which the code and the alias share, each its own law, and a
 * generated column's NOT NULL (rate, Rate.at("rate", tier), which Rate holds no row of for gold). Each case writes one
 * to four accounts, inserted or put, each drawn inside or outside each rule.
 *
 * The oracle is the rules restated over the drawn fields: a write none of whose accounts breaks a rule is accepted;
 * any other is invariant-rejected, `every`, its witness the key of an account that breaks what it names, never
 * `unreported`: every account is stated, so the host holds it. It names one law, one of those the account breaks, as
 * PostgreSQL met first; or, where PostgreSQL met the pattern's domain, which names no column, exactly the pattern laws
 * of the account's fields it refuses, the code's, the alias's or both, in their columns' canonical order.
 */
export const hostWitnessSuite = (): void => {
	layer(Substrate.layer)("a native refusal witnessed on the host, against PostgreSQL 19", (it) => {
		it.effect(
			"a refused write names one law its accounts break and the key of an account that breaks it",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(Accounts, {}, { label: "real", extensions: [], programs })
						const names = namesOf(o.installed)
						const group = installationGroup(names)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* explore(
								{
									suite: "laws/witness/host",
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "each account's rules restated over its drawn fields, and a witness naming an account that breaks the law"
									},
									kept: [
										{
											note: "a bronze account past its rate beside a gold one whose rate is NULL: the gold row's generated NOT NULL refuses it before WithinRate, so WithinRate's witness is the bronze account",
											sketch: {
												op: "insert",
												accounts: [
													{ tier: "bronze", units: 400, code: "b", alias: "b" },
													{ tier: "gold", units: 0, code: "a", alias: "a" }
												]
											},
											draws: "",
											reaches: ["refused by withinRate"]
										},
										{
											note: "qti-pie's shape: one relation whose two fields share one pattern source, the second broken alone, so the refusal names that field and never the other",
											sketch: {
												op: "insert",
												accounts: [{ tier: "bronze", units: 10, code: "a", alias: "A1" }]
											},
											draws: "",
											reaches: ["refused by alias"]
										},
										{
											note: "both fields of one pattern broken in one account: the domain PostgreSQL names refuses the first column it casts, and the refusal names both fields' laws",
											sketch: {
												op: "put",
												accounts: [{ tier: "silver", units: 5, code: "Q", alias: "" }]
											},
											draws: "",
											reaches: ["refused by the code and the alias at once"]
										}
									],
									runs: 60,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<Feature>(
										[
											"refused by rate",
											"refused by units",
											"refused by positive",
											"refused by withinRate",
											"refused by code",
											"refused by alias",
											"refused by the code and the alias at once",
											"accepted",
											"witnessed among several breaking accounts"
										],
										{ cases: 60, sense: notesOnly }
									),
									caseHang
								},
								(k, c) =>
									Effect.gen(function* () {
										yield* replaceRows(s.admin, group, [])
										const facts = Arr.map(k.accounts, (a, i) => ({
											id: idOf(i),
											tier: a.tier,
											units: Units(a.units),
											code: a.code,
											alias: a.alias
										}))
										const applied = yield* Effect.result(
											k.op === "insert"
												? answered(
														db.workload.insertAccounts.once({
															params: {},
															facts: { insert: { Account: facts } }
														})
													)
												: answered(
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
											assert.equal(outcome.kind, "accepted")
											c.note("accepted")
											return
										}
										if (outcome.kind !== "refused") {
											return assert.fail(
												`a write that breaks a rule is refused, not ${outcome.kind}`
											)
										}
										assert.equal(
											outcome.refused.kind,
											"every",
											"every account is stated, so the host judges the refused one"
										)
										const named: ReadonlyArray<Broken> = Arr.map(
											refusedLaws(outcome.refused),
											(law): Broken => {
												const rule = brokenOf(law)
												if (rule === undefined) {
													return assert.fail(
														`the law ${Formatter.format(law)} is one of the accounts' rules`
													)
												}
												assert.deepEqual(law, lawOf[rule])
												return rule
											}
										)
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
										if (patterns.length === 0) {
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
										if (
											Arr.filter(broken, (b) => Arr.some(named, (rule) => b.has(rule))).length > 1
										) {
											c.note("witnessed among several breaking accounts")
										}
									})
							)
						}).pipe(Effect.scoped, withLayer(o.served.layer))
					}).pipe(Effect.scoped)
				)
		)
	})
}
