/**
 * The query builder's untyped core, handed Live, Stale and Wild arguments at every argument position, and the values it
 * branches on, as a JavaScript caller may hand them (G-lsw).
 *
 * Every argument position of the builder (the schema of query(S), a rule's callback, a match's source, a scope's name,
 * a match's bindings and one binding's value, a filter's predicate, each side of a comparison, a parameter's name and
 * descriptor, a negation's source and bindings, the head and one head term, an order pair, a take bound, an
 * attachment's name, child and delivery, a stage's name, approximateNearest's column and bound, an Allen left operand,
 * a pointIn point, a vector-valued binding) is given either its Live argument, inside an otherwise valid query, or a Wild value of every
 * kind the library draws (@bjornpagen/testing/lsw). A Stale argument is a value that was live in another scope of the builder: a
 * variable, a rule builder, a Finished, an interior stage, a parent variable or a self of another rule, attachment or
 * recursive definition, each named by where it comes from. A near miss is a value the builder branches on, one call
 * each at the position it names: a take bound, an order pair, an attachment name, a binding's value, a binding of a
 * match or a negation naming no field of its source, an empty conjunction, an aggregate over a carrier PostgreSQL does
 * not define it for. The contract:
 *
 * - a Live argument builds a query whose Description has a canonical text;
 * - a Stale argument is refused at build time with exactly MalformedDescription;
 * - a Wild argument either builds such a query (a Wild string may well be a valid name) or throws a CompileError
 *   whose reason is one of the builder's own: MalformedDescription, Refused (a rule the types name too, stated by its
 *   roster member) or UnsupportedOperation; it never throws anything else, and never builds a query whose Description
 *   has no canonical text;
 * - a near miss is refused with one of the builder's own reasons, or builds a query with a canonical text that
 *   compiles to a template or to a CompileError, and never throws while it compiles.
 *
 * Every stale source, every wild kind, every position and every near miss is a required feature. A hostile proxy and
 * an object whose getter throws are refused at the entry that receives them (query/build/host.ts), before any read of
 * the builder's own reaches them.
 *
 * Named scopes, exhausted over three scope shapes twice and two name pairs: a rule's two scopes of two names compile,
 * its Description spelling each variable by its scope and field; one name given twice is DuplicateIdentity of that
 * name, reported at the later call and naming the earlier, the calls told apart by their call sites, never by the
 * spelling of their labels.
 *
 * Oracles: the contract above, a specification over the drawn argument's kind; for named scopes, the two calls' own
 * sites.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed, finite } from "@bjornpagen/testing/gen"
import { drawnFeature } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { readSite } from "#compiler/core/loc.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { assert, defined, refused } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import {
	admitted,
	aims,
	callOf,
	caseGen,
	compiledOf,
	type MisuseFeature,
	outcomeOf,
	shown,
	situations,
	twoScoped,
	twoScopes
} from "#test/unit/query/misuse.fixtures.ts"

/** The query builder's untyped core builds a canonical Description from a Live argument, refuses a Stale one, and from any other refuses with a typed error or builds one. */
export const theQueryBuildersUntypedCoreBuildsACanonicalDescriptionFromALiveArgumentRefusesAStaleOneAndFromAnyOtherRefusesWithATypedErrorOrBuildsOne =
	property.explore(aimed(caseGen, aims), {
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<MisuseFeature>>,
		check: (_, c: Case<MisuseFeature>) => (misuse) =>
			Effect.sync(() => {
				switch (misuse.kind) {
					case "position": {
						const { position, argument } = misuse
						c.note(drawnFeature(argument))
						const outcome = outcomeOf(callOf(position, argument))
						switch (argument.kind) {
							case "live":
								c.note(`position ${position.name}`)
								if (outcome.kind !== "built") {
									assert.fail(`the Live argument at ${position.name}: ${shown(outcome)}`)
								}
								break
							case "stale":
								if (outcome.kind !== "refused" || outcome.reason !== "MalformedDescription") {
									assert.fail(
										`stale ${argument.from}: expected a MalformedDescription refusal, ${shown(outcome)}`
									)
								}
								break
							case "wild": {
								c.note(`position ${position.name}`)
								const at = `${position.name}, ${drawnFeature(argument)}`
								if (outcome.kind === "defect") {
									assert.fail(`${at}: ${shown(outcome)}`)
								}
								if (outcome.kind === "refused") {
									assert.ok(admitted.has(outcome.reason), `${at} is ${shown(outcome)}`)
								}
								break
							}
						}
						return
					}
					case "near": {
						const { name, call } = misuse.near
						c.note(`near ${name}`)
						const outcome = outcomeOf(call)
						switch (outcome.kind) {
							case "defect":
								return assert.fail(`near ${name}: ${shown(outcome)}`)
							case "refused":
								assert.ok(admitted.has(outcome.reason), `near ${name} is ${shown(outcome)}`)
								return
							case "built": {
								/**
								 * A built near miss compiles to a template or to a CompileError; compiling it never throws.
								 */
								const compiled = compiledOf(outcome.query)
								if (compiled.kind === "threw") {
									assert.fail(`near ${name} built a query, and compiling it threw ${compiled.what}`)
								}
								return
							}
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "Live builds, Stale is MalformedDescription, Wild and near misses refuse typed or build canonically"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/query/build/host.ts",
				original: "\tif (!read.ok || !read.value) {",
				replacement: "\tif (read.ok && !read.value) {",
				why: "The entry's guarded read refuses a getter or setter but lets an argument whose reading throws past the builder's entry; the misuse search fails."
			},
			{
				file: "packages/engine/src/query/build/rule.ts",
				original:
					'\t\t\tthrow builderRefusal(label, "not a field of the arms the bindings select")',
				replacement: '\t\t\tthrow new Error("not a field of the arms the bindings select")',
				why: "A binding naming no field of its source thrown as an untyped Error rather than the builder's refusal; the misuse search's near misses fail."
			}
		]
	})

/** Named scopes a rule's two scopes of two names compile, one relation's and a field of another's included, its Description spelling each variable by its scope; one name given twice is DuplicateIdentity naming both calls. */
export const namedScopesARulesTwoScopesOfTwoNamesCompileOneRelationsAndAFieldOfAnothersIncludedItsDescriptionSpellingEachVariableByItsScopeOneNameGivenTwiceIsDuplicateIdentityNamingBothCalls =
	property.exhaust(finite(twoScopes), {
		needs: {},
		situations: [],
		check: () => (c) =>
			Effect.sync(() => {
				const built = twoScoped(c)
				const [name, again] = c.names
				if (name !== again) {
					assert.ok(
						built.ok && compileTemplate(built.value, undefined, testCompile).ok,
						"two scopes of two names compile"
					)
					const stage = queryValueDesc(built.value)?.stage
					const spelled: ReadonlyArray<string> =
						stage?.kind === "rules" ? Arr.map(stage.arms[0].vars, (d) => d.id) : []
					assert.deepEqual(
						spelled,
						[`${name}.${c.first.field}`, `${again}.${c.second.field}`],
						"the Description names each variable by its scope and field"
					)
					return
				}
				const reason = refused(built, "DuplicateIdentity").reason
				if (reason._tag !== "DuplicateIdentity" || reason.duplicate.kind !== "scope") {
					return assert.fail("a DuplicateIdentity of a scope")
				}
				assert.equal(reason.duplicate.name, name)
				const later = defined(readSite(reason.at.site), "the later call's site")
				const earlier = defined(readSite(reason.duplicate.earlier.site), "the earlier call's site")
				assert.equal(later.file, earlier.file, "both calls are the rule's")
				assert.ok(
					later.line > earlier.line,
					"one name given twice is DuplicateIdentity at the second call, the first its earlier"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the scopes' names and the two calls' own sites"
		},
		box: "every pair of three scope shapes, under two names and under one name twice",
		show: (c) =>
			`${c.first.label}@${c.first.column} ${c.second.label}@${c.second.column} ${Arr.join(c.names, "/")}`,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/query/build/rule.ts",
				original:
					'\t\t\t\t\tat: ref.scope.loc,\n\t\t\t\t\tduplicate: { kind: "scope", name: ref.scope.name, earlier: prior.loc }',
				replacement:
					'\t\t\t\t\tat: prior.loc,\n\t\t\t\t\tduplicate: { kind: "scope", name: ref.scope.name, earlier: ref.scope.loc }',
				why: "A duplicate scope name reported at the earlier call, naming the later; the named-scopes search fails."
			}
		]
	})
