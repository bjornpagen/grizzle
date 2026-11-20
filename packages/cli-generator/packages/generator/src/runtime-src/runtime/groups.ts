import type { Unify } from "effect"
import { Array as Arr, Effect, pipe, String as Str } from "effect"
import { Command } from "effect/cli"

/**
 * The long names of the flags that walk the whole run root (`runtime/describe.ts` `describeFlag`
 * and `effect`'s built-in `--completions`). Any of them in argv loads every group.
 */
export const describeTrigger = "describe"

export const completionsTrigger = "completions"

const triggers: ReadonlyArray<string> = Arr.map(
	[describeTrigger, completionsTrigger],
	(name) => `--${name}`
)

/**
 * A command whose error and requirement types are `E` and `R`, whatever its name and input.
 */
type Grouped<E, R> = Command.Command<string, never, unknown, E, R>

/**
 * A top-level group command. `E` and `R` are the error and requirement types the generated
 * `services` layer provides, so a group needing anything else fails to type-check in the table.
 * It is a command's members less the unification hooks, which pin a command's own type and so its
 * literal name: every group's name is a different literal, and only `E` and `R` are checked.
 */
export type Group<E, R> = Omit<
	Grouped<E, R>,
	typeof Unify.ignoreSymbol | typeof Unify.typeSymbol | typeof Unify.unifySymbol
>

/**
 * The header fields a group's `Command.make` sets: the only fields root help reads of a child.
 */
export interface Header {
	readonly name: string
	readonly alias?: string
	readonly description?: string
	readonly shortDescription?: string
	readonly unlisted?: boolean
}

/**
 * One row of the group table in `cli/root.ts`: the group's header and a thunk importing its module.
 */
export interface Entry<E, R> extends Header {
	readonly load: () => Promise<{ readonly group: Group<E, R> }>
}

const isTrigger = (arg: string) =>
	Arr.some(triggers, (trigger) => arg === trigger || Str.startsWith(`${trigger}=`)(arg))

const loadsAll = (args: readonly string[]) => Arr.some(args, isTrigger)

/**
 * Whether argv can select the group: its name or alias equals a whole element, or any element is a
 * whole-tree trigger. A superset of what the parser selects; no global-flag table, no `--` rule.
 */
export const selected = (header: Header, args: readonly string[]): boolean =>
	loadsAll(args) ||
	Arr.some(
		args,
		(arg) => arg === header.name || (header.alias !== undefined && arg === header.alias)
	)

const stub = (header: Header): Group<never, never> =>
	pipe(
		Command.make(header.name),
		(command) => (header.alias === undefined ? command : Command.withAlias(command, header.alias)),
		(command) =>
			header.description === undefined
				? command
				: Command.withDescription(command, header.description),
		(command) =>
			header.shortDescription === undefined
				? command
				: Command.withShortDescription(command, header.shortDescription),
		(command) => (header.unlisted === true ? Command.unlisted(command) : command)
	)

/**
 * The group of one table entry: its loaded module's group when argv selects it, else its
 * header-only stub.
 */
const groupFor =
	(args: readonly string[]) =>
	<E, R>(entry: Entry<E, R>): Effect.Effect<Group<E, R>> =>
		selected(entry, args)
			? Effect.map(
					Effect.promise(() => entry.load()),
					(module) => module.group
				)
			: Effect.succeed(stub(entry))

/**
 * Builds the root: every table entry in order, the loaded group module for a selected entry and a
 * header-only stub elsewhere, handed to `header`, which places them before the root's other
 * commands and adds its global flags.
 */
export const root = <E, R, C>(
	table: readonly Entry<E, R>[],
	header: (groups: readonly Group<E, R>[]) => C,
	args: readonly string[]
): Effect.Effect<C> => Effect.map(Effect.forEach(table, groupFor(args)), header)
