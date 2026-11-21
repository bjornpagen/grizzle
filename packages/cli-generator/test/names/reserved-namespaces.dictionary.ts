import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr, Order } from "effect"
import { reservedCommandNames, reservedFlagNames } from "#names/reserved.ts"

/** The sorted members of a reserved set behind `first`, the member a counterexample shrinks to. */
const membersAfter = (
	first: string,
	names: ReadonlySet<string>
): Arr.NonEmptyReadonlyArray<string> => Arr.prepend(Arr.sort([...names], Order.String), first)

/** The reserved sets are the generator's own vocabulary of what it holds back, read as dictionaries. */
export const reservedFlags = dictionary(membersAfter("follow", reservedFlagNames))

export const reservedCommands = dictionary(membersAfter("help", reservedCommandNames))
