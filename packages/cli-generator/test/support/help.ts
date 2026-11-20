import { Array as Arr, Option, String as Str } from "effect"

/**
 * The token a built CLI's `--help` shows after `left` on the ARGUMENTS or FLAGS row that begins with it: the value
 * name of a flag or positional that takes a value (`--qf json …`, `o json …`); none when no row begins with it.
 */
export const metavarOf = (help: string, left: string): Option.Option<string> =>
	Option.flatMap(
		Arr.findFirst(Arr.map(Str.split("\n")(help), Str.trimStart), Str.startsWith(`${left} `)),
		(row) => Arr.head(Arr.filter(Str.split(" ")(Str.slice(left.length)(row)), Str.isNonEmpty))
	)
