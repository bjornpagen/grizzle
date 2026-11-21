/** What the properties of environment.test.ts read: its spaces, models and helpers. */

import type { Reached } from "@bjornpagen/testing/features"
import { boolean, constant, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, pipe, String as Str } from "effect"
import { quoteString } from "#compiler/core/text.ts"
import { loginTemplate, roleDefaults } from "#test/pg/adapter/support.ts"
import { variableGen, variableTextGen, type VariableValue } from "#test/support/process-env.ts"

/** A password the environment offers: the login's own, or another. */
export type Offered = "own" | "other"

/** The password the pool is configured with: the login's own, given now or by an Effect; another; or none. */
export type Configured =
	| { readonly kind: "own"; readonly lazy: boolean }
	| { readonly kind: "other" }
	| { readonly kind: "none" }

interface EnvironmentCase {
	readonly configured: Configured
	readonly PGPASSWORD: Offered | "absent"
	readonly passwordFile: Offered | "absent"
	readonly PGOPTIONS: VariableValue
}

const offeredGen: Gen<Offered | "absent"> = weighted<Offered | "absent">([
	[1, constant<Offered | "absent">("absent")],
	[2, constant<Offered | "absent">("own")],
	[1, constant<Offered | "absent">("other")]
])

const configuredGen: Gen<Configured> = weighted<Configured>([
	[1, (source): Configured => ({ kind: "own", lazy: source.draw(boolean) })],
	[1, constant<Configured>({ kind: "other" })],
	[2, constant<Configured>({ kind: "none" })]
])

export const caseGen: Gen<EnvironmentCase> = (source) => ({
	configured: source.draw(configuredGen),
	PGPASSWORD: source.draw(offeredGen),
	passwordFile: source.draw(offeredGen),
	PGOPTIONS: source.draw(variableGen)
})

export type Feature =
	| "none refused beside its own PGPASSWORD"
	| "none refused beside its own password file alone"
	| "another refused beside its own PGPASSWORD"
	| "own admitted beside another PGPASSWORD"
	| "own admitted beside another password file alone"
	| "admitted under PGOPTIONS set"

export const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"none refused beside its own PGPASSWORD",
	"none refused beside its own password file alone",
	"another refused beside its own PGPASSWORD",
	"own admitted beside another PGPASSWORD",
	"own admitted beside another password file alone",
	"admitted under PGOPTIONS set"
]

/**
 * A case that reaches `situation` (featuresOf): its configured password and the sources it names fixed as the
 * situation reads them, every other field drawn as caseGen draws it.
 */
const reaching =
	(situation: Feature): Gen<EnvironmentCase> =>
	(source) => {
		const drawn = source.draw(caseGen)
		switch (situation) {
			case "none refused beside its own PGPASSWORD":
				return { ...drawn, configured: { kind: "none" }, PGPASSWORD: "own" }
			case "none refused beside its own password file alone":
				return { ...drawn, configured: { kind: "none" }, PGPASSWORD: "absent", passwordFile: "own" }
			case "another refused beside its own PGPASSWORD":
				return { ...drawn, configured: { kind: "other" }, PGPASSWORD: "own" }
			case "own admitted beside another PGPASSWORD":
				return {
					...drawn,
					configured: { kind: "own", lazy: source.draw(boolean) },
					PGPASSWORD: "other"
				}
			case "own admitted beside another password file alone":
				return {
					...drawn,
					configured: { kind: "own", lazy: source.draw(boolean) },
					PGPASSWORD: "absent",
					passwordFile: "other"
				}
			case "admitted under PGOPTIONS set":
				return {
					...drawn,
					configured: { kind: "own", lazy: source.draw(boolean) },
					PGOPTIONS: source.draw(variableTextGen)
				}
		}
	}

/**
 * The property's aims: each situation's reaching case, since caseGen reaches the rarest, the login's own configured
 * beside another password file alone, once in 64 cases, which a budget of 40 runs left unreached (the pin's pg tier
 * at bafa0de1c and at 50de8a880: no witness reached).
 */
export const environmentAims: ReadonlyArray<readonly [Reached<Feature>, Gen<EnvironmentCase>]> =
	Arr.map(situations, (situation) => [situation, reaching(situation)] as const)

/** What a case reaches, by what it drew. */
export const featuresOf = (c: EnvironmentCase): ReadonlyArray<Feature> => [
	...(c.configured.kind === "none" && c.PGPASSWORD === "own"
		? ["none refused beside its own PGPASSWORD" as const]
		: []),
	...(c.configured.kind === "none" && c.PGPASSWORD === "absent" && c.passwordFile === "own"
		? ["none refused beside its own password file alone" as const]
		: []),
	...(c.configured.kind === "other" && c.PGPASSWORD === "own"
		? ["another refused beside its own PGPASSWORD" as const]
		: []),
	...(c.configured.kind === "own" && c.PGPASSWORD === "other"
		? ["own admitted beside another PGPASSWORD" as const]
		: []),
	...(c.configured.kind === "own" && c.PGPASSWORD === "absent" && c.passwordFile === "other"
		? ["own admitted beside another password file alone" as const]
		: []),
	...(c.configured.kind === "own" && c.PGOPTIONS.kind === "text"
		? ["admitted under PGOPTIONS set" as const]
		: [])
]

/** A field of a password file's line, its colons and backslashes escaped. */
export const passFileField = (text: string): string =>
	pipe(Str.replaceAll("\\", "\\\\")(text), Str.replaceAll(":", "\\:"))

/** Every pinned default, as one row of the session's current settings. */
export const settingsSql = `SELECT ${Arr.join(
	Arr.map(roleDefaults, (s) => `pg_catalog.current_setting(${quoteString(s.parameter)})`),
	", "
)}`

/** The schema and login `server` whose sessions the cases start, made once per member (support.ts loginTemplate). */
export const serverLogin = loginTemplate(import.meta, "environment server")
