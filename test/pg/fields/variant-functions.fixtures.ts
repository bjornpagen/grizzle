/**
 * What variant-functions.test.ts reads: a library level's functions over its variant, each body spelling it
 * (V.of, V.code, V.attribute), and two applications over the library, one migrated to it and one installed fresh; and
 * a library level's variant of an exact integer arm, with a function making its values, whose domain holds the arm to
 * its scale.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Fn } from "#compiler/public/compute.ts"
import { Numeric, exactInteger, variant, bool, int4, numeric } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, fn, login, relation, role, schema } from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { installedName } from "#test/support/declared-functions.ts"
import { installGenerated, type Version } from "#test/support/install-migrate.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** The two applications over the library: `one`, migrated to it from a roster without b; `two`, installed fresh. */
export type Application = "one" | "two"

/** The root under `name`: Base(id), which the library level extends. */
const rootOf = (name: string) => schema(name, [relation("Base", { id: int4 }, ["id"])], [])

/**
 * The application's own level's relation, App(id). Each level above the root is declared under the name a test's
 * installation allocates it (test/support/compile.ts allocatedLevels), `<root>_<depth>`, so the served file a login is
 * compiled to under its declared names names the roles the installation holds; the two applications are two
 * installations, of two histories.
 */
const appRelation = () => relation("App", { id: int4 }, ["id"])

/**
 * The first version of the application `one`: the library level's roster Kind of c alone, an unordered roster, so c
 * takes code 0, its variant Value of the one arm c, a boolean, and Held, one value per id; no function; and the login
 * `desk` of a writer of Held, which the library's version gives its workload.
 */
const beforeLibrary = (name: string): Version => {
	const Kind = closed.unordered("Kind", ["c"])
	const Value = variant("Value", Kind, { c: { flag: bool } })
	const Held = relation("Held", { id: int4, value: Value }, ["id"])
	const library = schema.extend([rootOf(name)], `${name}_1`, [Kind, Held], [])
	const app = schema.extend([library], `${name}_2`, [appRelation()], [])
	const writer = role(app, "writer", { Held }, { insert: ["Held"] })
	return { schema: app, logins: [login(app, "desk", [writer])] }
}

/**
 * The library's version of an application under `name`: a root of Base(id); over it the library level, the roster Kind
 * of b and c, an unordered roster, its variant Value, b an integer and c a boolean, Held, one value per id, and the
 * functions whose bodies spell Value: make_b and make_c (V.of), is_b (V.code) and n_of (V.attribute), a PL/pgSQL body;
 * over that the application's own level, App(id); and the login `desk` of a writer of Held, which reads it back. A
 * fresh install codes b 0 and c 1; one migrated from beforeLibrary keeps c at 0 and appends b at 1.
 */
const libraryOf = (name: string) => {
	const Kind = closed.unordered("Kind", ["b", "c"])
	const Value = variant("Value", Kind, { b: { n: int4 }, c: { flag: bool } })
	const Held = relation("Held", { id: int4, value: Value }, ["id"])
	const functions = [
		fn("make_b", {
			calls: [],
			args: { n: int4 },
			returns: Value,
			volatility: "immutable",
			nullInput: "strict",
			language: "sql",
			body: fn.body`SELECT ${Value.of("b", { n: "n" })}`
		}),
		fn("make_c", {
			calls: [],
			args: { flag: bool },
			returns: Value,
			volatility: "immutable",
			nullInput: "strict",
			language: "sql",
			body: fn.body`SELECT ${Value.of("c", { flag: "flag" })}`
		}),
		fn("is_b", {
			calls: [],
			args: { value: Value },
			returns: bool,
			volatility: "immutable",
			nullInput: "strict",
			language: "sql",
			body: fn.body`SELECT (value).tag = ${Value.code("b")}`
		}),
		fn("n_of", {
			calls: [],
			args: { value: Value },
			returns: int4,
			volatility: "immutable",
			nullInput: "strict",
			language: "plpgsql",
			body: fn.body`
BEGIN
  RETURN (value).${Value.attribute("b", "n")};
END
`
		})
	]
	const library = schema.extend([rootOf(name)], `${name}_1`, [Kind, Held, ...functions], [])
	const app = schema.extend([library], `${name}_2`, [appRelation()], [])
	const writer = role(app, "writer", { Held }, { insert: ["Held"] })
	const programs = {
		held: ChangeSet.empty(writer).insert(Held, []),
		all: query(writer).rule((r) => {
			const { id, value } = v(Held, "h")
			return r.match(Held, { id, value }).find({ id, value })
		})
	}
	const desk = login(app, "desk", [writer], { workload: [workload(writer, programs)] })
	const version: Version = { schema: app, logins: [desk] }
	return { version, desk }
}

/** An application installed at the library: `one` through its first version, whose roster lacks b, then the library's,
 * which appends b at the next code; `two` at the library's at once. */
const installed = (application: Application) =>
	Effect.gen(function* () {
		const built: Array<ReturnType<typeof libraryOf>> = []
		const library = (name: string): Version => {
			const b = libraryOf(name)
			built.push(b)
			return b.version
		}
		const m = yield* migrated({
			label: `variant_fn_${application}`,
			schemaName: { kind: "unique" },
			first: application === "one" ? beforeLibrary : library,
			later: application === "one" ? [library] : [],
			apply: { kind: "noPlaceholders" },
			declared: () => noDeclarations,
			observe: noObservation
		})
		return { m, desk: defined(built[0], "the library's version").desk }
	})

/** A case: the integer and the boolean each application makes a value of with its functions. */
export interface FunctionsCase {
	readonly n: number
	readonly flag: boolean
}

/** Each integer at an edge of its type and each boolean. */
export const functionsCases: Gen<FunctionsCase> = element<FunctionsCase>([
	{ n: 0, flag: true },
	{ n: -2147483648, flag: false },
	{ n: 2147483647, flag: true }
])

/**
 * What one application answers of a case, each as text: b's code under its codes; each value its functions made, as a
 * Db reads it back; and what its functions read of the value a Db wrote.
 */
interface Answers {
	readonly code: string
	readonly made: ReadonlyArray<string>
	readonly read: ReadonlyArray<string>
}

/** A value of Value as a Db reads it, as text: its arm, then its field. */
const valueText = (
	value: { readonly tag: "b"; readonly n: number } | { readonly tag: "c"; readonly flag: boolean }
): string => (value.tag === "b" ? `b ${value.n}` : `c ${value.flag}`)

/**
 * A case over one application: its library level's functions make a value of each arm, which the owner stores in Held
 * as a direct writer; a Db of the writer reads both back as the tagged values they are and writes a value of b, which
 * the functions read as b and its integer, and a value of c, which they read as no b. What it answers is the
 * application's, which the property compares with the other's.
 */
export const applicationCase = (application: Application, k: FunctionsCase) =>
	Effect.gen(function* () {
		const { m, desk } = yield* installed(application)
		const level = quoteIdent(identifierOf(m.installation.names.levelOf("Held")))
		const call = (name: string, args: ReadonlyArray<string>): string =>
			`${level}.${quoteIdent(installedName(name))}(${Arr.join(args, ", ")})`
		const held = printObjectName(m.names.relation("Held"))
		const id = quoteIdent(m.names.column("Held", "id"))
		const value = quoteIdent(m.names.column("Held", "value"))
		yield* m.sql(
			`INSERT INTO ${held} (${id}, ${value}) VALUES (1, ${call("make_b", [`${k.n}`])}), (2, ${call("make_c", [`${k.flag}`])})`
		)
		const [code] = yield* m.owner.values(`SELECT (${call("make_b", ["0"])}).tag::text`, [])
		const served = yield* servedFixture(m, desk)
		const made = yield* Effect.gen(function* () {
			const db = yield* Db.open(served.login.roles.writer, {})
			const wrote = yield* writeAnswerOf(
				db.workload.held.once({
					params: {},
					facts: {
						insert: {
							Held: [
								{ id: 3, value: { tag: "b", n: k.n } },
								{ id: 4, value: { tag: "c", flag: !k.flag } }
							]
						}
					}
				})
			)
			assert.equal(
				wrote._tag,
				"accepted",
				`the ${application} application's Db writes a value of each arm`
			)
			const rows = yield* rowsOf(db.workload.all.once({ params: {}, facts: {} }))
			return Arr.map(rows, (row) => `${row.id} ${valueText(row.value)}`)
		}).pipe(Effect.scoped, withLayer(served.layer))
		const read = yield* m.owner.values(
			`SELECT ${id}::text || ' ' || ${call("is_b", [value])}::text || ' ' || coalesce(${call("n_of", [value])}::text, '-') FROM ${held} WHERE ${call("is_b", [value])} OR ${id} = 4 ORDER BY ${id}`,
			[]
		)
		return {
			code: String(defined(code, "b's code")[0]),
			made,
			read: Arr.map(read, (row) => String(row[0]))
		} satisfies Answers
	})

/**
 * A version under `name` of a library of an exact integer arm: a root of Base(id); over it the library level, the
 * roster WholeKind of whole and none, unordered, so none codes 0 and whole 1, its variant Amount, whole holding an exact
 * integer as QtiValue's integer arm does (qti-pie's ledger at 7ea6419c), Amounts, one amount per id, and no column of
 * WholeKind, so its writer writes a variant over a roster nothing of its own types, and amount_of, the
 * whole amount of trim_scale(x), x itself at scale 0 where it is integral and its fraction where it is not; over that the
 * application's own level; and the login `desk` of a writer of Amounts, which reads them back and reads amount_of's
 * value, which the call casts to Amount's domain (lower/conservative/call).
 */
const exactArmOf = (name: string) => {
	const WholeKind = closed.unordered("WholeKind", ["whole", "none"])
	const Amount = variant("Amount", WholeKind, { whole: { value: exactInteger }, none: {} })
	const Amounts = relation("Amounts", { id: int4, amount: Amount }, ["id"])
	const amountOf = fn("amount_of", {
		calls: [],
		args: { x: numeric(10, 1) },
		returns: Amount,
		volatility: "immutable",
		nullInput: "strict",
		language: "sql",
		body: fn.body`SELECT ${Amount.of("whole", { value: "pg_catalog.trim_scale(x)" })}`
	})
	const library = schema.extend([rootOf(name)], `${name}_1`, [WholeKind, Amounts, amountOf], [])
	const app = schema.extend([library], `${name}_2`, [appRelation()], [])
	const writer = role(app, "writer", { Amounts }, { insert: ["Amounts"] })
	const programs = {
		all: query(writer).rule((r) => {
			const { id, amount } = v(Amounts, "a")
			return r.match(Amounts, { id, amount }).find({ id, amount })
		}),
		amountOf: query(writer).rule((r) =>
			r.find({ amount: Fn.call(amountOf, { x: r.param("x", numeric(10, 1)) }) })
		)
	}
	const desk = login(app, "desk", [writer], { workload: [workload(writer, programs)] })
	const version: Version = { schema: app, logins: [desk] }
	return { version, desk }
}

/** The whole arm's code, whole after none in UTF-16 order, which a direct writer's record names its tag by. */
const wholeCode = 1

/**
 * The writes of an exact integer arm's value the domain judges (anExactArmIsHeldToItsScaleByItsVariantsDomain): a
 * direct writer's record of the whole arm holding `value`, numeric's text, or amount_of's value of `value`, each admitted
 * exactly where the value is an integer at scale 0, its whole arm then reading back as the integer `read`.
 */
export const exactArmWrites = [
	{ by: "direct", value: "2.5", read: "refused", feature: "a direct writer's fraction refused" },
	{
		by: "direct",
		value: "3.0",
		read: "refused",
		feature: "a direct writer's integer at another scale refused"
	},
	{ by: "direct", value: "NaN", read: "refused", feature: "a direct writer's NaN refused" },
	{ by: "direct", value: "-7", read: -7n, feature: "a direct writer's integer admitted" },
	{
		by: "function",
		value: "2.5",
		read: "refused",
		feature: "a function's fraction refused at its cast"
	},
	{ by: "function", value: "3.0", read: 3n, feature: "a function's integer admitted" }
] as const

/** A write of the box. */
export type ExactArmWrite = (typeof exactArmWrites)[number]

/** What a case of the exact arm's property notes it reached. */
export type ExactArmFeature = ExactArmWrite["feature"]

/** A case of the exact arm's property: one of the writes. */
export const exactArmGen: Gen<ExactArmWrite> = (source) => source.draw(element(exactArmWrites))

/**
 * A case over the exact arm's library, installed as `grizzle generate` drafts it, its login's served programs granted
 * EXECUTE on the declared function they reach (program/workload/compile.ts servedCalls): its write, a direct writer's
 * record stored by the owner, refused where the domain's CHECK refuses it (23514) and else read back by a Db, or
 * amount_of's value read by a Db, refused where the call's cast to the domain fails (23514); what the case reads, none
 * where it was refused.
 */
export const exactArmCase = (w: ExactArmWrite) =>
	Effect.gen(function* () {
		const generated = yield* installGenerated(
			(name) => {
				const b = exactArmOf(name)
				return { schema: b.version.schema, logins: b.version.logins }
			},
			{ label: "variant_exact_arm", ambient: ordinarySession }
		)
		const installed = generated.installed
		const desk = exactArmOf(installed.declared).desk
		if (w.by === "direct") {
			const owner = yield* Substrate.pipe(
				Effect.flatMap((s) => s.session({ ...ownerSession(), label: "exact arm direct writer" }))
			)
			const amount = parsedName("Amount")
			const written = yield* Effect.result(
				owner.query(
					`INSERT INTO ${printObjectName(installed.names.relation("Amounts"))} (${quoteIdent(installed.names.column("Amounts", "id"))}, ${quoteIdent(installed.names.column("Amounts", "amount"))}) VALUES (1, ROW(${wholeCode}::int2, '${w.value}'::numeric)::${printObjectName(installed.names.variantRow(amount))}::${printObjectName(installed.names.variantDomain(amount))})`,
					[]
				)
			)
			if (Result.isFailure(written)) {
				const reason = written.failure.reason
				assert.ok(
					reason._tag === "ServerError" && reason.fields.code === sqlstates.checkViolation,
					`a direct writer's ${w.value} is refused by the variant's domain (23514)`
				)
				return Option.none<ReadonlyArray<unknown>>()
			}
		}
		const served = yield* servedFixture(installed, desk)
		return yield* Effect.gen(function* () {
			const db = yield* Db.open(served.login.roles.writer, {})
			if (w.by === "direct") {
				const rows = yield* rowsOf(db.workload.all.once({ params: {}, facts: {} }))
				return Option.some(Arr.map(rows, (row): unknown => row.amount))
			}
			const answered = yield* Effect.result(
				rowsOf(db.workload.amountOf.once({ params: { x: Numeric.of(w.value) }, facts: {} }))
			)
			if (Result.isSuccess(answered)) {
				return Option.some(Arr.map(answered.success, (row): unknown => row.amount))
			}
			assert.ok(
				answered.failure._tag === "failed" &&
					Str.includes("violates check constraint")(answered.failure.message),
				`amount_of's ${w.value} is refused at the call's cast to the variant's domain, not ${Formatter.format(answered.failure)}`
			)
			return Option.none<ReadonlyArray<unknown>>()
		}).pipe(Effect.scoped, withLayer(served.layer))
	})
