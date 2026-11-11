import { Array as Arr, Option } from "effect"
declare const todos: ReadonlyArray<number>
declare const found: Option.Option<number>
export const index = Option.getOrElse(Arr.findFirstIndex(todos, (todo) => todo > 1), () => -1) // violation
export const code = Option.getOrElse(found, () => Number.NaN) // violation
export const block = Option.getOrElse(found, () => { return NaN }) // violation
export const fn = Option.getOrElse(found, function () { return -1 }) // violation
export const count = Option.getOrElse(found, () => 0)
export const missing = Option.getOrUndefined(found)
