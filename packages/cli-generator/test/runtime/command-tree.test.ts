/**
 * A generated CLI's command tree is what its operator reaches. The root loads exactly the group modules argv can select
 * (a group's name or alias as a whole token, or any spelling of a whole-tree trigger, which loads them all), keeps the
 * table's order, and stands a header-only stub for every other group, never loading it. `--describe` prints one JSON
 * document listing every bound command in tree order with its path from the root, its flags sorted by name, its media,
 * responses, security and refused fields as declared, and its effective servers (its own override, else the root's from
 * the Servers service, empty without it), every object's fields in alphabetical order.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { readDescription } from "#runtime-src/runtime/describe.ts"
import {
	actualBuilt,
	decodeDescription,
	describeLines,
	expectedBuilt,
	expectedDescription,
	fieldsAlphabetical,
	type SelectionFeature,
	selectionFeatures,
	selections,
	type TreeFeature,
	treeFeatures,
	trees
} from "#test/runtime/command-tree.fixtures.ts"

/**
 * The root loads exactly the groups argv can select and stubs the rest with their header fields, in table order. It
 * replaces 13 example cases (groups.test.ts); its budget is that count, 13 drawn tables and argvs, and up to 20 steered
 * while a situation is unreached.
 */
export const groupSelection = property.explore(
	aimed(selections.space, [
		["a name selects its group", selections.nameSelects],
		["an alias selects its group", selections.aliasSelects],
		["a trigger loads every group", selections.triggerLoadsAll],
		["a token holding a name selects nothing", selections.holdingName],
		["a near-miss trigger loads nothing", selections.nearMissTrigger],
		["a stub keeps its alias", selections.aliasedStub]
	]),
	{
		needs: {},
		situations: [
			"a name selects its group",
			"an alias selects its group",
			"a trigger loads every group",
			"a token holding a name selects nothing",
			"a near-miss trigger loads nothing",
			"no group selected",
			"a stub keeps its alias",
			"a stub keeps its description",
			"a stub keeps its short description",
			"an unlisted stub"
		] satisfies ReadonlyArray<Reached<SelectionFeature>>,
		check: (_, c: Case<SelectionFeature>) => (drawn) =>
			Effect.gen(function* () {
				c.noteAll(selectionFeatures(drawn))
				const built = yield* actualBuilt(drawn)
				assert.deepEqual(built, expectedBuilt(drawn))
			}),
		oracle: {
			kind: "specification",
			name: "selection by a whole name or alias token or any trigger spelling; loaded once if selected, else a header stub"
		},
		kept: [],
		budget: { runs: 13, steered: 20 },
		kills: [
			{
				file: "packages/cli-generator/src/runtime-src/runtime/groups.ts",
				original:
					"(arg) => arg === header.name || (header.alias !== undefined && arg === header.alias)",
				replacement:
					"(arg) => arg === header.name || (header.alias !== undefined && arg !== header.alias)",
				why: "Any token but a group's alias selects it, so an aliased group is loaded on every run; the property fails (CATCH's evidence, mutant 2ed2f7cdf9)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/groups.ts",
				original:
					"(arg) => arg === header.name || (header.alias !== undefined && arg === header.alias)",
				replacement: "(arg) => false",
				why: "No token selects a group by name or alias, so the group the operator named stays a stub; the property fails (CATCH's evidence, mutant 65f120773a)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/groups.ts",
				original: "const loadsAll = (args: readonly string[]) => Arr.some(args, isTrigger)",
				replacement: "const loadsAll = (args: readonly string[]) => Arr.every(args, isTrigger)",
				why: "A trigger loads every group only when every token is one, so `list --describe` loads none; the property fails (CATCH's evidence, mutant 7085c15326)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/groups.ts",
				original: "header.description === undefined",
				replacement: "header.description !== undefined",
				why: "A stub drops the description its header gives and takes none it lacks; the property fails (CATCH's evidence, mutant a6e656700f)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/groups.ts",
				original: `Arr.some(triggers, (trigger) => arg === trigger || Str.startsWith(\`\${trigger}=\`)(arg))`,
				replacement: "false",
				why: "No trigger loads the whole tree, so `--describe` and `--completions` walk stubs; the property fails (CATCH's evidence, mutant 3f4b36eff6)."
			}
		]
	}
)

/**
 * `--describe` prints exactly the model's document for the drawn tree, with alphabetical fields, and its own reader
 * (readDescription) reads the printed text back as that document. It replaces 11 example cases (describe.test.ts); its budget is that count, 11 drawn trees, and up to 18 steered
 * while a situation is unreached.
 */
export const describeDocument = property.explore(
	aimed(trees.space, [
		["a nested bound command", trees.nested],
		["no Servers service", trees.absent]
	]),
	{
		needs: {},
		situations: [
			"an operation-level servers override",
			"root servers inherited",
			"the undeclared root server",
			"no Servers service",
			"a refused field",
			"a constant parameter",
			"an unbound group",
			"a nested bound command",
			"flags out of name order"
		] satisfies ReadonlyArray<Reached<TreeFeature>>,
		check: (_, c: Case<TreeFeature>) => (drawn) =>
			Effect.gen(function* () {
				c.noteAll(treeFeatures(drawn))
				const lines = yield* describeLines(drawn)
				assert.equal(lines.length, 1)
				const text = lines[0] ?? ""
				const decoded = yield* decodeDescription(text)
				const readBack = yield* Effect.fromResult(readDescription(text))
				const alphabetical = yield* fieldsAlphabetical(text)
				assert.deepEqual(decoded, expectedDescription(drawn))
				assert.deepEqual(readBack, expectedDescription(drawn))
				assert.equal(alphabetical, true)
			}),
		oracle: {
			kind: "specification",
			name: "the describe document of the drawn tree: bound commands in tree order, sorted flags, effective servers"
		},
		kept: [],
		budget: { runs: 11, steered: 18 },
		kills: [
			{
				file: "packages/cli-generator/src/runtime-src/runtime/describe.ts",
				original: "walk(child, [...path, child.name], rootServers)",
				replacement: "walk(child, [child.name], rootServers)",
				why: "A nested command's path drops its parents, so `users update` is listed as `update`; the property fails (CATCH's evidence, mutant e0c2dfa947)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/describe.ts",
				original: "\t\tonSome: (binding) => [entryOf(path, binding, rootServers)]",
				replacement: "\t\tonSome: (binding) => []",
				why: "No bound command is listed, so the document is empty; the property fails (CATCH's evidence, mutant 24f5af760f)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/describe.ts",
				original: "\t\t\t\tConsole.log(indentedJsonText(describeTree(command, rootServers)))",
				replacement: "\t\t\t\tEffect.void",
				why: "`--describe` prints nothing; the property fails (CATCH's evidence, mutant 91989cc73f)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/describe.ts",
				original: 'servers: member(object, "servers", array(string))',
				replacement: 'servers: member(object, "requestMedia", array(string))',
				why: "The reader takes a command's request media for its servers, so a document read back names media types where its server URLs were; the property fails."
			}
		]
	}
)
