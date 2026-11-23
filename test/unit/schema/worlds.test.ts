/**
 * The world builders' admission (context, role, login) and ownership of their decoded descriptions (ownRole,
 * ownLogin), against the rules of roles restated as the oracle:
 *
 * - a context's fields are claims of scalar types: text, uuid, boolean, the integer types, inet, cidr, a contract over
 *   one of them, or a closed handle, which its caller writes. Each case draws a context of one to three fields of any drawn type
 *   (field-sketch.ts), or drawn(natural), which grizzle writes though its type, natural, is a claim's: the builder
 *   refuses it at the first field no claim is, a description at any field whose type no claim's is;
 * - a role relation is a whole relation of the base under its own name, or a query built over the base or one of its
 *   levels that reads only the base's relations, reads no parameter, attaches nothing, searches nothing approximately
 *   and is a Query, not an Ordered; a role writes whole ordinary relations and query entries the writable-entry rule
 *   admits, at most one per base relation. Each case draws a healthy role (drawn whole entries, a stored derived one
 *   among them, writable query entries over drawn relations, drawn writes) and at most one defect,
 *   each with its drawn target: the builder refuses it by the rule it breaks, with that rule's fields, and ownership of
 *   its description, where a description can state it, by the same rule; the healthy role is admitted by both;
 * - a query entry's definition may hold whatever a program's may: over the derived oracle's generated definitions
 *   (drawn levels, aggregates, unions, takes, negations), each lowers as a program, and as a role's query entry it is
 *   admitted and a query reading it lowers;
 * - a login's roles share its base, are named apart from it, and each role is in exactly one login. Each case draws a
 *   sequence of logins over a pool of roles of drawn bases and names: each login is refused at its first role breaking
 *   a rule, in the order base, name, a login already holding it, and admitted otherwise, its description owned.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { lowerQuery } from "#compiler/program/describe.ts"
import { drawn, natural } from "#compiler/public/fields.ts"
import { queryOver, queryValueDesc, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { ownLogin, ownRole } from "#compiler/schema/own.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import {
	admitContext,
	loginBuilder as login,
	roleBuilder as role,
	roleDescOf
} from "#compiler/schema/world.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"
import { buildSchema, caseSketchGen } from "#test/pg/derived/oracle/gen.ts"
import { refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import { queryFromDesc } from "#test/support/describe.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { upTo } from "#test/support/up-to.ts"
import { type DrawnRoster, fieldOf } from "#test/unit/schema/field-sketch.ts"
import { descOf } from "#test/unit/schema/support.ts"
import {
	admitted,
	claimable,
	claimDescribed,
	contextCaseGen,
	type ContextFeature,
	describedOf,
	type EntryCase,
	type EntryFeature,
	isQuery,
	type LoginFeature,
	loginName,
	loginOutcomes,
	loginProgramGen,
	Note,
	Other,
	Post,
	Reports,
	roleCaseGen,
	type RoleFeature,
	roleName,
	statedOf,
	tagOf
} from "#test/unit/schema/worlds.fixtures.ts"

/** Context admission admits a context of scalar claims its caller states, and refuses one at the first field no claim is. Its budget is its suite's before it was a property (test/unit/schema/worlds.test.ts at 4ca3036a): 100 runs and 200 steered cases. */
export const contextAdmissionAdmitsAContextOfScalarClaimsItsCallerStatesAndRefusesOneAtTheFirstFieldNoClaimIs =
	property.explore(contextCaseGen, {
		needs: {},
		budget: { runs: 100, steered: 200 },
		situations: [
			"admitted",
			"refused",
			"a contract over a claim",
			"a later field refused",
			"a field grizzle writes, whose type a claim's is"
		] satisfies ReadonlyArray<Reached<ContextFeature>>,
		check: (_, k: Case<ContextFeature>) => (c) =>
			Effect.sync(() => {
				const rosters: Arr.NonEmptyReadonlyArray<DrawnRoster> = Arr.map(c.rosters, (count, i) =>
					closedBuilder(
						`K${i}`,
						Arr.prepend(
							Arr.map(
								upTo(count - 1, (i) => i + 1),
								(h) => `h${h}`
							),
							"h0"
						),
						"ordered",
						[]
					)
				)
				const fields = Rec.fromEntries(
					Arr.map(
						c.fields,
						(f) =>
							[
								f.name,
								f.field.kind === "caller" ? fieldOf(f.field.type, rosters) : drawn(natural)
							] as const
					)
				)
				const options = c.claim ? { claim: "o" } : undefined
				const refusedAt = Arr.findFirstIndex(c.fields, (f) => !claimable(f.field))
				for (const f of c.fields) {
					if (f.field.kind === "drawn") {
						k.note("a field grizzle writes, whose type a claim's is")
					} else if (f.field.type.kind === "contract" && claimDescribed(f.field.type)) {
						k.note("a contract over a claim")
					}
				}
				if (Option.isNone(refusedAt)) {
					k.note("admitted")
					admitContext("Claims", fields, options, [])
				} else {
					k.note("refused")
					if (refusedAt.value > 0) {
						k.note("a later field refused")
					}
					const e = throwsRefused(
						() => admitContext("Claims", fields, options, []),
						"ContextRefused"
					)
					assert.deepEqual(e.reason._tag === "ContextRefused" ? e.reason.rule : undefined, {
						kind: "claimType",
						field: defined(c.fields[refusedAt.value]).name
					})
				}
				/** A description holds each field's type alone, drawn(natural)'s natural, which writes nothing. */
				const described = decodeDesc("context", {
					name: "Claims",
					fields: Rec.fromEntries(
						Arr.map(
							c.fields,
							(f) =>
								[
									f.name,
									descOf(f.field.kind === "caller" ? fieldOf(f.field.type, rosters) : natural)
								] as const
						)
					),
					source: { kind: "token", claim: undefined }
				})
				if (Arr.every(c.fields, (f) => f.field.kind === "drawn" || claimDescribed(f.field.type))) {
					succeeded(described, "a description of claim types")
				} else {
					refused(described, "MalformedDescription")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a claim is text, uuid, boolean, an integer type, inet, cidr, a contract over one or a closed handle, and its caller writes it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/world.ts",
				original: "() => noClaim(field)).desc",
				replacement: '() => malformed(label, "a field")).desc',
				why: "A context field grizzle writes, drawn(natural), refused as a malformed field rather than as no claim (schema/world.ts admitContext)."
			}
		]
	})

/** Role admission refuses every planted breach of a role's rules by that rule at the builder and at ownership, and admits its healthy twin. Its budget is its suite's before it was a property (test/unit/schema/worlds.test.ts at 4ca3036a): 200 runs and 400 steered cases. */
export const roleAdmissionRefusesEveryPlantedBreachOfARolesRulesByThatRuleAtTheBuilderAndAtOwnershipAndAdmitsItsHealthyTwin =
	property.explore(roleCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 400 },
		situations: [
			"none",
			"described",
			"wholeEntryName",
			"wholeEntryUndeclared",
			"entryOverAnother",
			"entryOutsideBase",
			"entryParameters",
			"entryAttaches",
			"entryApproximate",
			"entryOrdered",
			"entryContext",
			"writeOutside",
			"writeKind",
			"writeUnwritable",
			"writeTwice"
		] satisfies ReadonlyArray<Reached<RoleFeature>>,
		check: (_, k: Case<RoleFeature>) => (c) =>
			Effect.sync(() => {
				const described = describedOf(c)
				if (Option.isNone(c.broken)) {
					k.note("none")
					assert.equal(admitted("planted", c.planted).desc.name, "planted")
					const desc = defined(Option.getOrUndefined(described), "the healthy description")
					succeeded(Result.flatMap(decodeDesc("role", desc), ownRole))
					return
				}
				const { feature, stated: expected } = c.broken.value
				k.note(feature)
				const e = throwsRefused(() => admitted("planted", c.planted), tagOf(expected))
				assert.deepEqual(statedOf(e), expected)
				if (Option.isNone(described)) {
					return
				}
				k.note("described")
				const owned = Result.flatMap(decodeDesc("role", described.value), ownRole)
				if (feature === "entryOrdered") {
					refused(owned, "MalformedDescription", "decoding refuses an Ordered entry by its shape")
					return
				}
				assert.deepEqual(statedOf(refused(owned, tagOf(expected))), expected)
			}),
		oracle: {
			kind: "specification",
			name: "the role rules: whole entries of the base under their names, parameterless flat Query entries over it matching only the contexts the role declares, writes of ordinary relations and writable entries once per relation"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/world.ts",
				original: '\t\tif (draft !== undefined || kind === "relation" || kind === "closed") {',
				replacement: '\t\tif (draft === undefined || kind === "relation" || kind === "closed") {',
				why: "Operator mutant 23023a52cc at packages/engine/src/schema/world.ts:334 in admitRole: `!==` becomes `===`; the property fails (the census, lane TESTPOLICY2)."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\tconst contextBreak = entryContextBreak(desc.contexts, uses.contexts)\n",
				replacement: "\t\tconst contextBreak = entryContextBreak(desc.contexts, new Map())\n",
				why: "ownership admits a query entry matching a context its role does not declare: the planted entryContext's description is owned."
			}
		]
	})

/** Query entry totality admits every definition a program admits as a query entry, and lowers a query reading it. Its budget is its suite's before it was a property (test/unit/schema/worlds.test.ts at 4ca3036a): 40 runs and 100 steered cases. */
export const queryEntryTotalityAdmitsEveryDefinitionAProgramAdmitsAsAQueryEntryAndLowersAQueryReadingIt =
	property.explore((source) => ({ sketch: source.draw(caseSketchGen), at: source.draw(pickGen) }), {
		needs: {},
		budget: { runs: 40, steered: 100 },
		situations: [
			"a union",
			"a take",
			"an aggregate",
			"a negation",
			"over a derived relation"
		] satisfies ReadonlyArray<Reached<EntryFeature>>,
		check: (_, k: Case<EntryFeature>) => (sketch2) =>
			Effect.gen(function* () {
				const { gen, at } = (({ sketch, at }): EntryCase => ({
					gen: buildSchema(sketch, { name: "Gen" }),
					at
				}))(sketch2)
				return yield* Effect.sync(() => {
					const d = pickFrom(nonEmpty(gen.derived, "a derived relation"), at)
					const definition = d.value.definition
					succeeded(lowerQuery(definition), `${d.name} as a program`)
					if (d.form === "union") {
						k.note("a union")
					}
					if (d.form === "take") {
						k.note("a take")
					}
					if (d.aggregates.length > 0) {
						k.note("an aggregate")
					}
					if (d.negation) {
						k.note("a negation")
					}
					if (Arr.some(d.reads, (read) => Arr.some(gen.derived, (o) => o.name === read))) {
						k.note("over a derived relation")
					}
					const rebuilt = succeeded(
						queryFromDesc(defined(queryValueDesc(definition)), gen.value),
						"the definition rebuilt from its Description"
					)
					assert.ok(isQuery(rebuilt), `${d.name}'s definition is a Query`)
					const entries: AnyRole = role(gen.value, "entries", { Entry: rebuilt })
					const entry = defined(Option.getOrUndefined(Rec.get(entries.relations, "Entry")))
					succeeded(
						lowerQuery(
							queryOver(entries).rule((r: RuleValue) => {
								const vars = varsOver(entry, "entry")
								return r.match(entry, vars).find(vars)
							})
						),
						`${d.name} in a query entry`
					)
				})
			}),
		oracle: {
			kind: "second-implementation",
			name: "the program's lowering of the same definition"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/parse.ts",
				original:
					'\t\tif (this.#is("?", 0)) {\n\t\t\tthis.#pos += 1\n\t\t\treturn { min: 0, max: 1 }',
				replacement: '\t\tif (this.#is("?", 0)) {\n\t\t\t{}\n\t\t\treturn { min: 0, max: 1 }',
				why: "Operator mutant 881b240abf at packages/text/src/regex/parse.ts:383 in <module>: `this.#pos += 1` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** Login admission refuses each login at its first role breaking a login rule, by that rule, and admits the rest. Its budget is its suite's before it was a property (test/unit/schema/worlds.test.ts at 4ca3036a): 100 runs and 200 steered cases. */
export const loginAdmissionRefusesEachLoginAtItsFirstRoleBreakingALoginRuleByThatRuleAndAdmitsTheRest =
	property.explore(loginProgramGen, {
		needs: {},
		budget: { runs: 100, steered: 200 },
		situations: [
			"admitted",
			"roleBase",
			"roleName",
			"roleTwice",
			"malformed"
		] satisfies ReadonlyArray<Reached<LoginFeature>>,
		check: (_, k: Case<LoginFeature>) => (p) =>
			Effect.sync(() => {
				const roles = Arr.map(p.roles, (r) =>
					r.other
						? role(Other, roleName(r.name), { Post })
						: role(Reports, roleName(r.name), { Note })
				)
				const expected = loginOutcomes(p)
				for (const [i, l] of p.logins.entries()) {
					const outcome = defined(expected[i])
					const held = nonEmpty(
						Arr.map(l.roles, (at) => defined(roles[at])),
						"a login's roles"
					)
					const attempt = () => login(Reports, loginName(l.name), held, [])
					switch (outcome.kind) {
						case "admitted": {
							k.note("admitted")
							const value = attempt()
							assert.equal(value.name, loginName(l.name))
							succeeded(
								Result.flatMap(
									decodeDesc("login", {
										name: loginName(l.name),
										base: schemaDescOf(Reports),
										roles: Arr.map(held, (r) => roleDescOf(r)),
										loc: SourceLoc("a described login", [])
									}),
									ownLogin
								)
							)
							break
						}
						case "malformed":
							k.note("malformed")
							throwsRefused(attempt, "MalformedDescription")
							break
						case "refused": {
							k.note(outcome.rule.kind)
							const e = throwsRefused(attempt, "LoginRefused")
							assert.deepEqual(
								e.reason._tag === "LoginRefused" ? e.reason.rule : undefined,
								outcome.rule
							)
							break
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "each role over the login's base, named apart from it, in one login"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/literal.ts",
				original:
					'return typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")\n\t\tcase "numeric":\n\t\t\tif (typeof value === "number") {\n\t\t\t\treturn Result.err("decimalNumber")\n\t\t\t}\n\t\t\treturn Decimal.parse(value)',
				replacement:
					'if (typeof value === "number") {     return Result.err("decimalNumber")    }    return Decimal.parse(value)   case "numeric":    return typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")',
				why: 'Operator mutant 74ae3ef517 at packages/engine/src/scalar/literal.ts:83 in hostLiteral: `return typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")   case "numeric":    if (typeof value === "number") {     return Result.err("decimalNumber")    }    return Decimal.parse(value)` becomes `if (typeof value === "number") {     return Result.err("decimalNumber")    }    return Decimal.parse(value)   case "numeric":    return typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})
