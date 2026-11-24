/** What test/unit/schema/empty-roster.test.ts reads: its drawn rosters and their compiled schema. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { closed, relation } from "#compiler/public/dynamic.ts"
import { bits, closedId } from "#compiler/public/fields.ts"
import { login, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { admitValue, type HostValue } from "#compiler/scalar/values/identity.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplateOver, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"
import { compiledLogin } from "#test/support/served-login.ts"

/** A situation the property reaches. */
export type Feature =
	| "an empty roster"
	| "a roster of one handle"
	| "a roster of several handles"
	| "an unordered roster"
	| "a closed id's value admitted"
	| "a closed id's value refused"
	| "a set's value refused"

/** The handles a roster draws from, and the strangers a write's value may be besides them. */
const names = ["grader", "rubric", "probe"] as const
const strangers = ["stranger", ""] as const

/** A drawn roster: its order, its handles, none among them, and the values a write states of its closed id. */
export interface RosterCase {
	readonly order: "ordered" | "unordered"
	readonly handles: ReadonlyArray<string>
	readonly values: ReadonlyArray<string>
}

export const rosterCaseGen: Gen<RosterCase> = (source) => ({
	order: source.draw(boolean) ? "ordered" : "unordered",
	handles: source.draw(subarray(names)),
	values: source.draw(array(element([...names, ...strangers] as const), { min: 1, max: 4 }))
})

/** A drawn roster's schema compiled: its names constant's handles, its set's width, its facts, and its field types. */
export interface CompiledCase {
	readonly names: ReadonlyArray<string>
	readonly bitsWidth: number
	readonly facts: ReadonlyArray<string>
	readonly types: { readonly code: ScalarType; readonly bits: ScalarType }
	readonly codes: Parameters<typeof scalarCodec>[1]
	/** A login over the registry whose one role inserts into Graded, its served file read back as a layer reads it. */
	readonly login: unknown
}

/**
 * The schema of a drawn roster `Graders` and a relation `Graded` of a closed id of it and a set over it, compiled as
 * `grizzle generate` compiles it: its artifacts and its installation, and a read of every handle of the roster and one
 * of none, each as a query template, its lowering checked by the kernel's verification (oracle/verify checkedLowering),
 * the SQL audit's among it: over the empty roster both reads, and over every roster the read of none, are the empty
 * VALUES source over a closed id, which stands on placeholder rows (lower/conservative/closed/index.ts).
 */
export const compiledCase = (drawn: RosterCase): CompiledCase => {
	const Graders =
		drawn.order === "ordered"
			? closed.ordered("Graders", drawn.handles)
			: closed.unordered("Graders", drawn.handles)
	const Graded = relation("Graded", { id: Id, grader: closedId(Graders), graders: bits(Graders) }, [
		"id"
	])
	const value = schema("Registry", [Graders, Graded], [])
	const app = role(value, "app", { Graders, Graded }, { insert: ["Graded"] })
	const grade = changeSetOver.empty(app).insert(Graded, [])
	const artifacts = succeeded(testArtifacts(value, testCompile), "the registry's artifacts")
	const everyHandle = queryOver(value).rule((r: RuleValue) => {
		const g = varsOver(Graders, "g")
		return r.match(Graders, g).find(g)
	})
	const noHandle = queryOver(value).rule((r: RuleValue) => {
		const g = varsOver(Graders, "g")
		return r.match(Graders, g).where(r.or()).find(g)
	})
	succeeded(
		compileTemplateOver(everyHandle, value, artifacts, testCompile),
		"the read of every handle of the roster"
	)
	succeeded(
		compileTemplateOver(noHandle, value, artifacts, testCompile),
		"the read of none of the roster's handles, `.where(r.or())`"
	)
	succeeded(
		compileInstallation(owning(value), {
			...installOptions(owning(value)),
			levels: [identity.schema(parsedSchemaName("registry"))]
		}),
		"the registry's installation"
	)
	const codec = defined(
		artifacts.names.codes.rosters.get(parsedName("Graders")),
		"the codes of Graders"
	)
	const graded = defined(artifacts.derived.schema.relations.get("Graded"), "Graded")
	const typeOf = (field: string): ScalarType =>
		defined(
			Option.getOrUndefined(Arr.findFirst(graded.fields, (f) => f.name === field)),
			`Graded.${field}`
		).type
	return {
		names: Arr.filter(codec.names, (n) => n !== ""),
		bitsWidth: codec.width,
		facts: [...Graders.handles],
		types: { code: typeOf("grader"), bits: typeOf("graders") },
		codes: artifacts.names.codes,
		login: login(value, "registry_app", [app], { workload: [workload(app, { grade })] })
	}
}

/** A write's value of the closed id or the set admitted as the field's host value, or the fault refusing it. */
export const valueAdmitted = (
	compiled: CompiledCase,
	field: "code" | "bits",
	value: unknown
): Result.Result<HostValue | Uint8Array, CodecFault> =>
	admitValue(scalarCodec(compiled.types[field], compiled.codes).spec, value)

/**
 * The served file `grizzle generate` writes for the case's login, read back from its JSON value as a layer loads it
 * (served/json.ts servedFile), and the live handles it holds of Graders: generate and the served reader read one roster.
 */
export const servedHandles = (compiled: CompiledCase) =>
	Effect.map(
		compiledLogin(compiled.login, (owned) => firstCodebook(rostersOf(owned))),
		({ back }) =>
			Arr.flatMap(
				defined(back.rosters.get(parsedName("Graders")), "the served file's codes of Graders"),
				(slot) => (slot.kind === "live" ? [slot.handle] : [])
			)
	)
