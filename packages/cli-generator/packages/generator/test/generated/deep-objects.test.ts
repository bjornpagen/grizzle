/**
 * A generated CLI sends a `deepObject` value as its schema and the author config's two switches say, and has no way to
 * send one they leave undefined. A form body's Encoding entries and a query's parameters share the rules:
 *
 * - An object of scalars is the standard case, `name[key]=value`, under every config.
 * - A nested object or an array goes in brackets, `name[a][b]=value` with an array item by its index, only under
 *   `nonStandard.deepObjectBrackets`.
 * - A scalar of a schema that also admits objects is one `name=value` pair only under `nonStandard.deepObjectScalars`;
 *   a schema with both a scalar branch and a nested one needs both switches.
 * - A schema with a branch no switch covers, such as `null`, is refused under every config.
 *
 * A refused field has no flag, is named on its command's REFUSED help line and in `--describe`'s `refusedFields`, and
 * `--body` holding it is a usage error that names the field and never shows its value. A refused parameter has no flag
 * and is named on REFUSED. An operation whose required field is refused has no command.
 *
 * One package per config: neither switch, each alone, and both. Per config:
 *
 * - A check of `--describe` and help against the rules: the commands, the field and parameter flags, the refused fields
 *   and the REFUSED lines.
 * - A property over three kinds of run, one per case. An update gives each field the config admits or not, by its flags
 *   or in `--body`, with text past ASCII and text needing encoding, numbers past 2^53 and empty objects. A list gives
 *   each query parameter or not. A planted fault is a refused field in `--body`, a refused element's flag, or a value
 *   outside its field's schema. Oracles: the pairs the rules give, in property and member order, read back off the
 *   wire by each wire's own rules (a form body as the WHATWG URL Standard reads it, where `+` is a space; a query as
 *   RFC 3986 percent-encoding, where `+` is a plus); and exit 2 with no connection for each fault.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, family, type Kill, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import {
	caseFeatures,
	CONFIGS,
	decodeDescription,
	done,
	expectedOf,
	expectedSurface,
	type Feature,
	invocationOf,
	LIST,
	type Mode,
	type Outcome,
	receivedOf,
	refusedNamesOf,
	sorted,
	type Surface,
	UPDATE,
	utf8
} from "#test/generated/deep-objects.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"

/** A config's kill of its surface: the refusal its switches leave in place, taken away. */
const surfaceKill = (mode: Mode): Kill =>
	Arr.contains(mode.switches, "brackets")
		? {
				file: "packages/generator/src/normalize/bodies.ts",
				original: '\treturn ctx.site.nonStandard?.deepObjectBrackets === true ? "mark" : "refuse"',
				replacement: '\treturn "refuse"',
				why: "A nested body field is refused though the bracket switch marks it, so it loses its flags and the update lists it under REFUSED; the property fails."
			}
		: {
				file: "packages/generator/src/normalize/parameters.ts",
				original:
					"\t\t\treturn strictNested && !brackets\n\t\t\t\t? Option.none()\n\t\t\t\t: Option.some({ nested: strictNested, scalars: false })",
				replacement: "\t\t\treturn Option.some({ nested: strictNested, scalars: false })",
				why: "A nested deepObject parameter is sent without the bracket switch, where it has no flag and is named on REFUSED; the property fails."
			}

/** Under each config, the commands, flags and refusals are those its switches give the schemas. */
export const deepObjectSurfaces = family(
	Rec.fromEntries(
		Arr.map(CONFIGS, ({ mode, fixture, described }) => [
			mode.key,
			property.exhaust(described, {
				box: `the package built under ${mode.label}: its --describe and its commands' help`,
				needs: { fixture, checkout: Checkout.dir },
				situations: [],
				check:
					({ fixture }) =>
					() =>
						Effect.gen(function* () {
							const { built, commands } = yield* fixture
							const run = (args: ReadonlyArray<string>) =>
								runBin(built, { args, env: {}, stdin: new Uint8Array(0) })
							const described = yield* run(["--describe"])
							const updateHelp = yield* run(Arr.append(commands.update, "--help"))
							const listHelp = yield* run(Arr.append(commands.list, "--help"))
							const description = yield* decodeDescription(utf8(described.stdout))
							const entryOf = (pointer: string) =>
								Arr.findFirst(description.commands, (command) => command.pointer === pointer)
							const flagsAt = (pointer: string, location: string, field: "name" | "wireName") =>
								Option.match(entryOf(pointer), {
									onNone: () => [],
									onSome: (command) =>
										Arr.map(
											Arr.filter(command.flags, (flag) => flag.location === location),
											(flag) => flag[field]
										)
								})
							assert.deepEqual<Surface>(
								{
									exitCodes: [described.exitCode, updateHelp.exitCode, listHelp.exitCode],
									commands: sorted(Arr.map(description.commands, (command) => command.pointer)),
									updateFlags: sorted(flagsAt(UPDATE, "body", "name")),
									refusedFields: Option.match(entryOf(UPDATE), {
										onNone: () => [],
										onSome: (command) => command.refusedFields
									}),
									listFlags: sorted(flagsAt(LIST, "query", "wireName")),
									updateRefused: sorted(refusedNamesOf(utf8(updateHelp.stdout))),
									listRefused: sorted(refusedNamesOf(utf8(listHelp.stdout)))
								},
								expectedSurface(mode),
								"the commands, flags and refusals are those the switches give the schemas"
							)
						}),
				oracle: {
					kind: "specification",
					name: "design 6.1's deepObject rules under the config's switches: each element's flag, or its refusal on REFUSED and in refusedFields"
				},
				kept: [],
				kills: [surfaceKill(mode)]
			})
		])
	)
)

/**
 * Under each config, each value is sent as its switches say, and a fault sends nothing. Each config's budget is the
 * count its suite stated before the conversion: 6 independent cases, and up to 24 steered while a situation is
 * unreached.
 */
export const deepObjectValues = family(
	Rec.fromEntries(
		Arr.map(CONFIGS, ({ mode, fixture, cases, features }) => [
			mode.key,
			property.explore(cases, {
				needs: { fixture, checkout: Checkout.dir },
				situations: features,
				check:
					({ fixture }, k: Case<Feature>) =>
					(c) =>
						Effect.gen(function* () {
							const { server, built, commands } = yield* fixture
							k.noteAll(caseFeatures(c))
							const { command, args } = invocationOf(c)
							const observed = yield* server.observe(
								() => done,
								runBin(built, {
									args: Arr.flatten([
										commands[command],
										["--base-url", server.origins["127.0.0.1"]],
										args
									]),
									env: {},
									stdin: new Uint8Array(0)
								})
							)
							const stderr = utf8(observed.result.stderr)
							assert.deepEqual<Outcome>(
								{
									exitCode: observed.result.exitCode,
									connections: observed.connections.length,
									requests: Arr.map(observed.requests, receivedOf),
									guard:
										c.kind === "fault"
											? Option.map(c.guard, ({ field, marker }) => ({
													namesField: Str.includes(field)(stderr),
													showsValue: Str.includes(marker)(stderr)
												}))
											: Option.none()
								},
								expectedOf(c),
								"each value is sent as its switches say, and a fault sends nothing"
							)
						}),
				oracle: {
					kind: "second-implementation",
					name: "the pairs the deepObject rules give, read back off the wire by each wire's own rules, and exit 2 with no connection for a fault"
				},
				kept: [],
				budget: { runs: 6, steered: 24 },
				kills: [
					{
						file: "packages/generator/src/runtime-src/runtime/serialize.ts",
						original: `([member, memberText]) => \`\${codec.name(\`\${name}[\${member}]\`)}=\${codec.value(memberText)}\``,
						replacement: `([member, memberText]) => \`\${codec.name(\`\${name}.\${member}\`)}=\${codec.value(memberText)}\``,
						why: "An object's members are sent as name.key, not name[key], the standard deepObject pairs every config sends; the property fails."
					}
				]
			})
		])
	)
)
