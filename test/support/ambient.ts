import { constant, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Brand, Effect, type Scope } from "effect"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { type RoleDefault, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The ambient session: the defaults an installation's owner sessions start under, its migration, drift and ledger
 * sessions, for the settings that change how PostgreSQL resolves, parses or prints the text grizzle sends and reads.
 * grizzle controls none of them: a database's, a role's or a URL's settings reach its sessions as they are. A suite
 * draws one, and a property's verdict must be the same under every one: migrate's, drift's and the installed catalog,
 * which grizzle reaches by naming everything absolutely and pinning what it reads under.
 *
 * A drawn ambient session is its installation's alone (AmbientOwner): the defaults of a login of the installation's
 * own, in the substrate's database, so every case's owner sessions start under exactly what it drew, whatever its
 * neighbours drew. A database's defaults would reach every installation of the file at once, and a login's sessions, a
 * Db's, start under no drawn default: Db.open refuses a login any default in one database alone
 * (adapter/admission/roles.ts roleDifferences). A login's own defaults pin its search path and its print settings, which
 * outrank a database's: the one suite that draws an ambient session as a database's defaults, and holds a login's every
 * answer to its answer under none, runs in a database of its own (test/pg/adapter/login-ambient.test.ts).
 *
 * The harness's own sessions pin every one of these (test/support/pg.ts), so an oracle never reads under the drawn one.
 */

/**
 * The search_path every owner session of the installation starts with: PostgreSQL's own, or the installation's schemas
 * first, ahead of pg_catalog, where a relation named like a builtin type shadows it for any name resolved through the
 * path.
 */
export type AmbientPath = { readonly kind: "default" } | { readonly kind: "grizzleFirst" }

/** A setting that changes how PostgreSQL parses or prints text, at one of the values a draw gives it. */
export type AmbientSetting =
	| { readonly parameter: "extra_float_digits"; readonly value: "-15" | "0" | "1" | "3" }
	| { readonly parameter: "TimeZone"; readonly value: "UTC" | "Pacific/Chatham" }
	| {
			readonly parameter: "DateStyle"
			readonly value: "ISO, MDY" | "SQL, DMY" | "German, DMY" | "Postgres, YMD"
	  }
	| {
			readonly parameter: "IntervalStyle"
			readonly value: "postgres" | "postgres_verbose" | "sql_standard" | "iso_8601"
	  }
	| { readonly parameter: "bytea_output"; readonly value: "hex" | "escape" }

/** An installation's owner defaults: its search path and the settings it sets, each at most once. */
export interface AmbientSession {
	readonly path: AmbientPath
	readonly settings: ReadonlyArray<AmbientSetting>
}

/** The cluster's own defaults: no owner default at all. */
export const ordinarySession: AmbientSession = { path: { kind: "default" }, settings: [] }

/** The installation's schemas first on the path, and no other setting: the arm a relation named like a type meets. */
export const grizzleFirstSession: AmbientSession = { path: { kind: "grizzleFirst" }, settings: [] }

/** A setting left unset, or drawn at one of its values: unset and each value with a nonzero weight of its own. */
const settingOf = <S extends AmbientSetting>(
	values: Arr.NonEmptyReadonlyArray<S>
): Gen<ReadonlyArray<AmbientSetting>> =>
	weighted([
		[2, constant<ReadonlyArray<AmbientSetting>>([])],
		...Arr.map(values, (s) => [1, constant<ReadonlyArray<AmbientSetting>>([s])] as const)
	])

/** The values a draw gives one setting. */
type SettingValues = Arr.NonEmptyReadonlyArray<AmbientSetting>

/** Every value a draw gives each setting, one list per setting. */
export const ambientSettingValues: Arr.NonEmptyReadonlyArray<SettingValues> = [
	[
		{ parameter: "extra_float_digits", value: "-15" },
		{ parameter: "extra_float_digits", value: "0" },
		{ parameter: "extra_float_digits", value: "1" },
		{ parameter: "extra_float_digits", value: "3" }
	],
	[
		{ parameter: "TimeZone", value: "UTC" },
		{ parameter: "TimeZone", value: "Pacific/Chatham" }
	],
	[
		{ parameter: "DateStyle", value: "ISO, MDY" },
		{ parameter: "DateStyle", value: "SQL, DMY" },
		{ parameter: "DateStyle", value: "German, DMY" },
		{ parameter: "DateStyle", value: "Postgres, YMD" }
	],
	[
		{ parameter: "IntervalStyle", value: "postgres" },
		{ parameter: "IntervalStyle", value: "postgres_verbose" },
		{ parameter: "IntervalStyle", value: "sql_standard" },
		{ parameter: "IntervalStyle", value: "iso_8601" }
	],
	[
		{ parameter: "bytea_output", value: "hex" },
		{ parameter: "bytea_output", value: "escape" }
	]
]

const settingGens: Arr.NonEmptyReadonlyArray<Gen<ReadonlyArray<AmbientSetting>>> = Arr.map(
	ambientSettingValues,
	(values) => settingOf(values)
)

/**
 * An ambient session: the grizzle-first path as often as the default one, the arm that meets a catalog-type name, and
 * each setting unset or at one of its values, each of its values its own nonzero weight.
 */
export const ambientSessionGen: Gen<AmbientSession> = (source) => {
	const path = weighted<AmbientPath>([
		[1, constant<AmbientPath>({ kind: "default" })],
		[1, constant<AmbientPath>({ kind: "grizzleFirst" })]
	])(source)
	const settings: Array<AmbientSetting> = []
	for (const gen of settingGens) {
		for (const s of gen(source)) {
			settings.push(s)
		}
	}
	return { path, settings }
}

/** What a draw of an ambient session reached, as a suite notes it. */
export type AmbientFeature = "grizzle-first path" | "ambient setting"

/** The features an ambient session reaches. */
export const ambientFeatures = (ambient: AmbientSession): ReadonlyArray<AmbientFeature> => [
	...(ambient.path.kind === "grizzleFirst" ? ["grizzle-first path" as const] : []),
	...(Arr.isReadonlyArrayNonEmpty(ambient.settings) ? ["ambient setting" as const] : [])
]

/**
 * The ambient session `ambient` as a role's or a database's defaults, the grizzle-first path listing `schemas`, the
 * installation's own and each role's, in that order. The vector extension's schema is never listed, as no grizzle
 * session's path holds it (test/pg/vector/exact/equality.test.ts).
 */
export const ambientDefaults = (
	ambient: AmbientSession,
	schemas: Arr.NonEmptyReadonlyArray<string>
): ReadonlyArray<RoleDefault> => [
	...(ambient.path.kind === "grizzleFirst"
		? [
				{
					parameter: "search_path",
					value: `${Arr.join(Arr.map(schemas, quoteIdent), ", ")}, pg_catalog, pg_temp`
				}
			]
		: []),
	...Arr.map(ambient.settings, (s): RoleDefault => ({
		parameter: s.parameter,
		value: quoteString(s.value)
	}))
]

/**
 * The owner as one installation's own sessions log in, with the ambient session they start under, one value: an owner
 * login of the substrate (substrate.ts ownerLogin) whose defaults in the substrate's database are `ambient`'s. Every
 * migration, drift and ledger session of the installation logs in as `credentials` and no other session does, so the
 * ambient session is the installation's alone. Built only by ambientOwner.
 */
export type AmbientOwner = {
	readonly ambient: AmbientSession
	readonly credentials: Credentials
} & Brand.Brand<"AmbientOwner">
const AmbientOwner = Brand.nominal<AmbientOwner>()

/**
 * The owner login of an installation under `ambient` for the scope, the grizzle-first path listing `schemas`, the
 * installation's own and each role's: made before its first migration, so every owner session of it starts under
 * `ambient`, and dropped when the scope closes.
 */
export const ambientOwner = (
	ambient: AmbientSession,
	schemas: Arr.NonEmptyReadonlyArray<string>
): Effect.Effect<AmbientOwner, never, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const credentials = yield* substrate.ownerLogin(ambientDefaults(ambient, schemas))
		return AmbientOwner({ ambient, credentials })
	})
