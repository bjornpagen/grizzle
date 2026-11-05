import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { type Claims, claimsOf, type TypedContext, typedContext } from "#adapter/db/claims.ts"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { claimsText, payloadFacts } from "#test/support/worlds/model/session/claims.ts"
import type { ContextSpec, FieldSpec, RoleSpec } from "#test/support/worlds/model/types.ts"

/**
 * The host claims decoder (packages/grizzle/src/adapter/db/claims.ts claimsOf) decodes a verified payload exactly as
 * README "Permissions" and "Security model" say, over the shapes a `verify` can return that JSON cannot: a claim or a
 * field on the payload's prototype chain rather than its own, a getter, a non-object claim. The worlds model's host
 * decoder (test/support/worlds/model/session/claims.ts payloadFacts) is the specification, written apart from the
 * implementation; a payload whose reading does not throw must decode through grizzle to exactly the facts the model
 * reads, and refuse exactly when the model does.
 *
 * The attacker never holds a token's signature (the login is the boundary), so the hostile input here is the object
 * `verify` returns, not a signed claim: the suite's value over the worlds errors suite, which drives only JSON-text
 * tokens end to end, is the non-JSON object shapes and the own-versus-inherited placement the end-to-end suite never
 * draws. A context reads its fields from the payload's own top level or own claim object, so an inherited claim or
 * field is no fact; grizzle must read the same own properties the model reads, and no inherited one.
 *
 * The role is the documents base's `member`, whose relations read Session (a text subject at the top level) and Tenant
 * (a uuid organization and an int8 seat count in the claim object `t`). A refined claim (the subject's pattern) is
 * PostgreSQL's to judge after admission, so the host decoder admits it; the model marks it and the suite compares the
 * decoded facts, which are the same whether or not PostgreSQL will later refuse the pattern.
 */

/** Installs an own enumerable property on `object` whose read throws, as a misbehaving verify's object does. */
const defineThrowing = (object: object, key: string): void => {
	Object.defineProperty(object, key, {
		get: () => {
			throw new Error("the claim property's read throws on purpose")
		},
		enumerable: true,
		configurable: true
	})
}

/** The member role's spec, whose contexts the model decodes through. */
const memberSpec: RoleSpec = Option.getOrThrowWith(
	Arr.findFirst(docsInstall.roles, (r) => r.name === "member"),
	() => new Error("the documents install has no member role")
)

/**
 * Grizzle's own typed contexts for the member role, built from its public role value through the engine, as Db.open
 * builds them: no PostgreSQL, so claimsOf is driven on the host alone.
 */
const memberContexts: ReadonlyArray<TypedContext> = (() => {
	const role = Effect.runSync(Effect.orDie(buildInstall(docsInstall, docsBase.name))).roles[
		"member"
	]
	const input = parseSchemaInput(role)
	if (!input.ok || input.value.kind !== "role") {
		throw new Error("the member role did not parse as a role")
	}
	const artifacts = schemaArtifacts(input.value, {
		installation: undefined,
		vectorSchema: undefined,
		codes: firstCodebook(rostersOf(owning(role)))
	})
	if (!artifacts.ok) {
		throw new Error(`the member role did not compile: ${artifacts.error.message}`)
	}
	const world = artifacts.value.world
	const contexts = world.kind === "role" ? Rec.values(world.role.contexts) : []
	const checked = checkedSchema(artifacts.value.owned)
	if (!checked.ok) {
		throw new Error(`the member role's schema did not check: ${checked.error.message}`)
	}
	return Arr.map(contexts, (context) =>
		typedContext(
			context,
			(field) => checked.value.fieldType(field, SourceLoc(`context ${context.name}`, [])),
			artifacts.value.names.codes
		)
	)
})()

/** The member role's contexts as the model declares them, by name. */
const contextsByName: ReadonlyArray<ContextSpec> = Arr.filter(docsBase.contexts, (c) =>
	Arr.some(["Session", "Tenant"], (name) => name === c.name)
)

const sessionSpec = Option.getOrThrowWith(
	Arr.findFirst(contextsByName, (c) => c.name === "Session"),
	() => new Error("no Session context")
)

const tenantSpec = Option.getOrThrowWith(
	Arr.findFirst(contextsByName, (c) => c.name === "Tenant"),
	() => new Error("no Tenant context")
)

/** Where a member is placed in an object: as its own property, on the object's prototype, or not at all. */
type Placement = "own" | "inherited" | "absent"
const placements: Arr.NonEmptyReadonlyArray<Placement> = ["own", "inherited", "absent"]

/** A value for a field, and whether its read throws: the shapes a verify's object can carry at a claim field. */
type ValueKind =
	| "valid"
	| "wrong-type"
	| "nul"
	| "surrogate"
	| "pattern-miss"
	| "unsafe-int"
	| "int8-string"
	| "int8-out-of-range"
	| "huge"
	| "getter"

/** A text value of each kind, or none when the kind does not apply to a text field. */
const textValue = (kind: ValueKind): Option.Option<unknown> => {
	switch (kind) {
		case "valid":
			return Option.some("u_abc")
		case "wrong-type":
			return Option.some(5)
		case "nul":
			return Option.some("u_a\u0000b")
		case "surrogate":
			return Option.some(`u_${String.fromCharCode(0xd800)}`)
		case "pattern-miss":
			return Option.some("U_NOT")
		case "huge":
			return Option.some(Str.repeat(100_000)("u"))
		case "getter":
			return Option.some("u_get")
		case "unsafe-int":
		case "int8-string":
		case "int8-out-of-range":
			return Option.none()
	}
}

/** A uuid value of each kind, or none when the kind does not apply to a uuid field. */
const uuidValue = (kind: ValueKind): Option.Option<unknown> => {
	switch (kind) {
		case "valid":
			return Option.some("00000000-0000-4000-8000-00000000000a")
		case "wrong-type":
			return Option.some(true)
		case "pattern-miss":
			return Option.some("not-a-uuid")
		case "getter":
			return Option.some("00000000-0000-4000-8000-00000000000b")
		case "nul":
		case "surrogate":
		case "huge":
		case "unsafe-int":
		case "int8-string":
		case "int8-out-of-range":
			return Option.none()
	}
}

/** An integer value of each kind, or none when the kind does not apply to an integer, serial or contract field. */
const integerValue = (kind: ValueKind): Option.Option<unknown> => {
	switch (kind) {
		case "valid":
			return Option.some(5)
		case "wrong-type":
			return Option.some("nope")
		case "int8-string":
			return Option.some("123")
		case "unsafe-int":
			return Option.some(Number.MAX_SAFE_INTEGER + 2)
		case "int8-out-of-range":
			return Option.some("9223372036854775808")
		case "getter":
			return Option.some(7)
		case "nul":
		case "surrogate":
		case "pattern-miss":
		case "huge":
			return Option.none()
	}
}

/** A value of each kind for a field of `domain`; none when the kind does not apply to the domain. */
const valueOf = (domain: FieldSpec["domain"], kind: ValueKind): Option.Option<unknown> => {
	switch (domain.kind) {
		case "text":
			return textValue(kind)
		case "uuid":
			return uuidValue(kind)
		case "integer":
		case "serial":
		case "contract":
			return integerValue(kind)
		case "boolean":
			return kind === "valid"
				? Option.some(true)
				: kind === "wrong-type"
					? Option.some("x")
					: Option.none()
		case "handle":
			return kind === "valid"
				? Option.some(domain.members[0])
				: kind === "wrong-type"
					? Option.some(0)
					: Option.none()
		case "span":
			return Option.none()
	}
}

/** A member of an object: a plain value, or a stable getter that returns it (a shape JSON cannot carry). */
type Member = { readonly key: string; readonly value: unknown; readonly getter: boolean }

/** A fresh object with no prototype, the sanctioned null-prototype literal, never the __proto__ accessor. */
const nullObject = (): Record<string, unknown> => ({ __proto__: null })

/** Defines `m` on `object`, as a value or a getter that returns its value, as an own enumerable property. */
const defineMember = (object: object, m: Member): void => {
	const descriptor: PropertyDescriptor = m.getter
		? { get: () => m.value, enumerable: true, configurable: true }
		: { value: m.value, enumerable: true, writable: true, configurable: true }
	Object.defineProperty(object, m.key, descriptor)
}

/** The object with `members` as own properties and `inherited` on a null-prototype prototype, never through __proto__. */
const objectWith = (
	members: ReadonlyArray<Member>,
	inherited: ReadonlyArray<Member>
): Readonly<Record<string, unknown>> => {
	const proto = nullObject()
	for (const m of inherited) {
		defineMember(proto, m)
	}
	const object = nullObject()
	Object.setPrototypeOf(object, proto)
	for (const m of members) {
		defineMember(object, m)
	}
	return object
}

/** How a context's claim object sits in the payload (meaningful only for an object claim like Tenant). */
type ObjectPlacement = "own" | "inherited" | "absent" | "null" | "array" | "non-object"
const objectPlacements: Arr.NonEmptyReadonlyArray<ObjectPlacement> = [
	"own",
	"inherited",
	"absent",
	"null",
	"array",
	"non-object"
]

/** One context's members, placed by field, as own and inherited lists of the object that holds them. */
interface Placed {
	readonly own: ReadonlyArray<Member>
	readonly inherited: ReadonlyArray<Member>
}

/** A context's fields placed into own and inherited members, by a placement and value kind per field. */
const placeFields = (
	context: ContextSpec,
	draw: (field: FieldSpec) => {
		readonly placement: Placement
		readonly kind: ValueKind
		readonly getter: boolean
	}
): Placed => {
	const own: Array<Member> = []
	const inherited: Array<Member> = []
	for (const field of context.fields) {
		const { placement, kind, getter } = draw(field)
		if (placement === "absent") {
			continue
		}
		const value = valueOf(field.domain, kind)
		if (Option.isNone(value)) {
			continue
		}
		const member: Member = { key: field.name, value: value.value, getter }
		if (placement === "own") {
			own.push(member)
		} else {
			inherited.push(member)
		}
	}
	return { own, inherited }
}

/** A draw of one field's placement, value kind and whether it is read through a getter. */
const fieldDraw: Gen<{
	readonly placement: Placement
	readonly kind: ValueKind
	readonly getter: boolean
}> = (source) => ({
	placement: source.draw(element(placements)),
	kind: source.draw(
		element<ValueKind>([
			"valid",
			"wrong-type",
			"nul",
			"surrogate",
			"pattern-miss",
			"unsafe-int",
			"int8-string",
			"int8-out-of-range",
			"huge",
			"getter"
		])
	),
	getter: source.draw(boolean)
})

/** A whole payload draw: the session fields, the tenant object's placement, and the tenant fields when it is an object. */
interface Draw {
	readonly session: ReadonlyArray<{
		readonly field: FieldSpec
		readonly placement: Placement
		readonly kind: ValueKind
		readonly getter: boolean
	}>
	readonly tenantPlacement: ObjectPlacement
	readonly tenant: ReadonlyArray<{
		readonly field: FieldSpec
		readonly placement: Placement
		readonly kind: ValueKind
		readonly getter: boolean
	}>
}

const drawFor =
	(
		fields: Arr.NonEmptyReadonlyArray<FieldSpec>
	): Gen<
		ReadonlyArray<{
			readonly field: FieldSpec
			readonly placement: Placement
			readonly kind: ValueKind
			readonly getter: boolean
		}>
	> =>
	(source) =>
		Arr.map(fields, (field) => ({ field, ...source.draw(fieldDraw) }))

const drawGen: Gen<Draw> = (source) => ({
	session: source.draw(drawFor(sessionSpec.fields)),
	tenantPlacement: source.draw(element(objectPlacements)),
	tenant: source.draw(drawFor(tenantSpec.fields))
})

/**
 * How valid a draw is: free hostility, a clean Session with no Tenant, or both contexts clean. The clean modes make
 * the all-own, all-valid payloads (rare under independent per-field hostility) common, so the decoded verdicts are
 * reached; free hostility dominates.
 */
type Mode = "free" | "clean-session" | "clean-both"
const modeGen: Gen<Mode> = weighted<Mode>([
	[4, constant("free")],
	[1, constant("clean-session")],
	[1, constant("clean-both")]
])

/** A field placed as its own valid property, read directly. */
const cleanField = (
	field: FieldSpec
): {
	readonly field: FieldSpec
	readonly placement: Placement
	readonly kind: ValueKind
	readonly getter: boolean
} => ({
	field,
	placement: "own",
	kind: "valid",
	getter: false
})

/** The draw a mode makes of a raw draw: the clean modes force own, valid fields and the tenant's placement. */
const effective = (mode: Mode, raw: Draw): Draw => {
	switch (mode) {
		case "free":
			return raw
		case "clean-session":
			return {
				session: Arr.map(sessionSpec.fields, cleanField),
				tenantPlacement: "absent",
				tenant: raw.tenant
			}
		case "clean-both":
			return {
				session: Arr.map(sessionSpec.fields, cleanField),
				tenantPlacement: "own",
				tenant: Arr.map(tenantSpec.fields, cleanField)
			}
	}
}

/** The payload a draw builds: Session at the top level, Tenant under `t` as the draw places it. */
const payloadOf = (draw: Draw): unknown => {
	const session = placeFields(sessionSpec, (field) => {
		const d = Option.getOrThrowWith(
			Arr.findFirst(draw.session, (s) => s.field.name === field.name),
			() => new Error(`no draw for ${field.name}`)
		)
		return d
	})
	const tenant = placeFields(tenantSpec, (field) => {
		const d = Option.getOrThrowWith(
			Arr.findFirst(draw.tenant, (s) => s.field.name === field.name),
			() => new Error(`no draw for ${field.name}`)
		)
		return d
	})
	const tenantObject = objectWith(tenant.own, tenant.inherited)
	const topInherited: Array<Member> = [...session.inherited]
	const topOwn: Array<Member> = [...session.own]
	switch (draw.tenantPlacement) {
		case "own":
			topOwn.push({ key: "t", value: tenantObject, getter: false })
			break
		case "inherited":
			topInherited.push({ key: "t", value: tenantObject, getter: false })
			break
		case "absent":
			break
		case "null":
			topOwn.push({ key: "t", value: null, getter: false })
			break
		case "array":
			topOwn.push({ key: "t", value: [], getter: false })
			break
		case "non-object":
			topOwn.push({ key: "t", value: 42, getter: false })
			break
	}
	return objectWith(topOwn, topInherited)
}

/** The closed feature vocabulary: the tenant object's placement, each field's placement and value kind, and the verdict. */
type Feature =
	| `tenant:${ObjectPlacement}`
	| `field:${Placement}`
	| `value:${ValueKind}`
	| "verdict:refused"
	| "verdict:session-only"
	| "verdict:both-contexts"

const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	...Arr.map(objectPlacements, (p): Feature => `tenant:${p}`),
	"field:own",
	"field:inherited",
	"field:absent",
	"value:valid",
	"value:wrong-type",
	"value:nul",
	"value:surrogate",
	"value:pattern-miss",
	"value:unsafe-int",
	"value:int8-string",
	"value:int8-out-of-range",
	"value:huge",
	"value:getter",
	"verdict:refused",
	"verdict:session-only",
	"verdict:both-contexts"
]

describe("the host claims decoder", () => {
	it.effect(
		"decodes a verify's object to exactly the own-property facts the model reads, and refuses exactly when it does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/security/claims",
						draw: drawn((source) => ({ mode: source.draw(modeGen), raw: source.draw(drawGen) })),
						literal: Formatter.format,
						coverage: required<Feature>(situations, { cases: 2000, sense: notesOnly }),
						kept: [],
						runs: 2000,
						shrink: { kind: "bounded", candidates: 200 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ mode, raw }, c) =>
						Effect.sync(() => {
							const draw = effective(mode, raw)
							c.note(`tenant:${draw.tenantPlacement}`)
							for (const s of [...draw.session, ...draw.tenant]) {
								c.note(`field:${s.placement}`)
								c.note(`value:${s.kind}`)
							}
							const payload = payloadOf(draw)
							const model = payloadFacts(docsBase, memberSpec, payload)
							const grizzle: Result.Result<Claims, unknown> = claimsOf(memberContexts, payload)
							if (model.kind === "refused") {
								c.note("verdict:refused")
								assert.ok(
									Result.isFailure(grizzle),
									"the model refuses the payload, so grizzle refuses it"
								)
								return
							}
							c.note(
								Rec.keys(model.facts).length > 1 ? "verdict:both-contexts" : "verdict:session-only"
							)
							assert.ok(
								Result.isSuccess(grizzle),
								"the model decodes the payload, so grizzle decodes it"
							)
							assert.equal(
								grizzle.success.text,
								claimsText(model.facts),
								"grizzle's claims setting is the model's facts in the setting's order"
							)
						})
				)
			)
	)

	it.effect(
		"refuses a payload whose property read throws, as a ClaimRefused, never escaping as a defect",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/security/claims-throws",
						generator: element(["session", "tenant"] as const),
						literal: (at: "session" | "tenant") => Formatter.format(at),
						limit: 2,
						coverage: requiredInSpace<"at:session" | "at:tenant">(["at:session", "at:tenant"]),
						caseHang
					},
					(at, c) =>
						Effect.sync(() => {
							c.note(`at:${at}`)
							const top = nullObject()
							if (at === "session") {
								defineThrowing(top, "sub")
							} else {
								const tenant = nullObject()
								defineThrowing(tenant, "org")
								defineMember(tenant, { key: "seats", value: 1, getter: false })
								defineMember(top, { key: "t", value: tenant, getter: false })
								defineMember(top, { key: "sub", value: "u_x", getter: false })
							}
							const grizzle: Result.Result<Claims, unknown> = claimsOf(memberContexts, top)
							assert.ok(
								Result.isFailure(grizzle),
								"a payload whose read throws is refused, never a defect"
							)
						})
				)
			)
	)
})
