/** What the properties of param-domains.test.ts read: its spaces, models and helpers. */

import type { Reached } from "@bjornpagen/testing/features"
import { boolean, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import type { CreateDomain } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { paramsOver } from "#test/support/compile.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	firstStored,
	passedOver,
	type Stored,
	versionOf
} from "#test/support/migrate/param-domains.ts"

export type Feature =
	| "an own CHECK moved over a text domain created for the parameters"
	| "an own CHECK moved over a stored text domain"
	| "a text domain staying for a parameter once its stored field is dropped"
	| "a text domain under a parameter that stays stored"

/** The target drawn: which of the two patterns it stores (Stored), the frozen first version storing Code alone. */
export const caseGen: Gen<Stored> = (source) => ({
	code: source.draw(boolean),
	slug: source.draw(boolean)
})

/** What a draft to a version storing `stored` declares: Coded dropped where the version no longer stores Code. */
export const declaredFor = (stored: Stored): Declarations => ({
	renames: [],
	drops:
		firstStored.code && !stored.code ? [{ kind: "relation", relation: parsedName("Coded") }] : []
})

/** The installer extension of a version's one program: its parameters' types, nothing else of its workload. */
export const servedParams = (value: ReturnType<typeof versionOf>) =>
	paramsOver([{ login: "server", workloads: [workload(value, { passed: passedOver(value) })] }])

/** The domains `objects` create, by name. */
export const domainsOf = (
	objects: Installation["manifest"]["objects"]
): ReadonlyMap<string, CreateDomain> =>
	new Map(
		Arr.flatMap(objects, (o) =>
			Arr.flatMap(o.ddl, (st) =>
				st.kind === "createDomain" ? [[printObjectName(st.name), st] as const] : []
			)
		)
	)

/** Whether a printed domain name is a parameter's pattern domain, and the parameter's, `code` or `slug`. */
export const isParamDomain = Str.includes(`."__param_`)

export const ofParam = (param: "code" | "slug") => Str.includes(`."__param_${param}_`)

/** A domain's CHECK body: its base, its collation and its predicates. */
export const bodyOf = (d: CreateDomain) => ({
	base: d.base,
	collation: d.collation,
	checks: Arr.map(d.constraints, (c) => c.predicate)
})

export const required: Arr.NonEmptyReadonlyArray<Reached<Feature>> = [
	"an own CHECK moved over a text domain created for the parameters",
	"an own CHECK moved over a stored text domain",
	"a text domain staying for a parameter once its stored field is dropped",
	"a text domain under a parameter that stays stored"
]
