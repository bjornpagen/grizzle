/** What the properties of oracle.test.ts read: its spaces, models and helpers. */

import { exact, ordered, set, structuralHash } from "@bjornpagen/testing/oracle"
import { Array as Arr, Option } from "effect"
import { spansTemplate } from "#test/pg/spans/allen/support.ts"
import {
	type SpanEndpointKind,
	type SpanQuery,
	type SpanSchema,
	spanEndpointKinds,
	spanSchemaDesc,
	type SpanVariant,
	bySpanVariant
} from "#test/support/oracle/gen/spans.ts"
import type { ScriptInstall } from "#test/support/script-template.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

export const cases = 300

/** The query kinds this suite draws. */
export const kinds = ["allenFilter", "allenJoin", "pointIn"] as const

/** How a query writes the window or the point it compares stored spans with: a parameter or a literal. */
const operandForms = ["param", "literal"] as const

type OperandForm = (typeof operandForms)[number]

/**
 * What a case reaches: its query kind over its endpoint kind, with the form of its operand where the kind has one. A
 * parameter is cast to its declared type as it is bound, a contract's domain for a contract endpoint, which a literal
 * never is, so the two forms lower apart.
 */
type AllenOracleFeature =
	| `allenFilter:${SpanEndpointKind}:${OperandForm}`
	| `allenJoin:${SpanEndpointKind}`
	| `pointIn:${SpanEndpointKind}:${OperandForm}`

/** Every feature the suite must reach. */
export const allenOracleFeatures: Arr.NonEmptyReadonlyArray<AllenOracleFeature> = Arr.flatMap(
	spanEndpointKinds,
	(e): Arr.NonEmptyReadonlyArray<AllenOracleFeature> => [
		`allenJoin:${e}`,
		...Arr.map(operandForms, (f): AllenOracleFeature => `allenFilter:${e}:${f}`),
		...Arr.map(operandForms, (f): AllenOracleFeature => `pointIn:${e}:${f}`)
	]
)

/** The feature a case of `query` over `endpoint` reaches; none for a query kind outside the drawn ones. */
export const featureOf = (
	query: SpanQuery,
	endpoint: SpanEndpointKind
): Option.Option<AllenOracleFeature> => {
	switch (query.kind) {
		case "allenFilter":
			return Option.some<AllenOracleFeature>(`allenFilter:${endpoint}:${query.window.kind}`)
		case "allenJoin":
			return Option.some<AllenOracleFeature>(`allenJoin:${endpoint}`)
		case "pointIn":
			return Option.some<AllenOracleFeature>(`pointIn:${endpoint}:${query.point.kind}`)
		case "intersection":
		case "difference":
		case "pack":
			return Option.none()
	}
}

const schemaOf = (endpoint: SpanEndpointKind, left: boolean, right: boolean): SpanSchema => ({
	endpoint,
	relations: { Left: { name: "Left", spanKeyed: left }, Right: { name: "Right", spanKeyed: right } }
})

export const sameRowSet = set(structuralHash, ordered(exact))

/** Every schema a case can draw, each installed once per member by its variant: the templates the cases' seats clone. */
export const oracleSpans: Readonly<Record<SpanVariant, SubstrateTemplate<ScriptInstall>>> =
	bySpanVariant((endpoint, left, right) =>
		spansTemplate(
			import.meta,
			`spanoracle ${endpoint} ${left} ${right}`,
			spanSchemaDesc(schemaOf(endpoint, left === "span", right === "span")),
			{ label: "spanoracle", extensions: [] }
		)
	)
