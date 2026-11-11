import { Pool } from "pg"
import * as driver from "pg"
import { makeActionClient } from "@superstarter/todo-protocol/action"
export { makeActionClient as make } from "@superstarter/todo-protocol/action"
export const used = [Pool, driver, makeActionClient]
