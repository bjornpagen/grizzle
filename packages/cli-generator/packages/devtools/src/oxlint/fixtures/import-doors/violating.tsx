import { Pool } from "pg" // violation
import type { PoolClient } from "pg" // violation
import "pg" // violation
import { makeActionClient } from "@superstarter/todo-protocol/action" // violation
import * as action from "@superstarter/todo-protocol/action" // violation
import { refusalsOf } from "@superstarter/todo-protocol/action"
import type { ActionRejection } from "@superstarter/todo-protocol/action"
export { makeActionClient as make } from "@superstarter/todo-protocol/action" // violation
export { exitCodecOf } from "@superstarter/todo-protocol/action"
export * from "@superstarter/todo-protocol/action" // violation
export * as postgres from "pg" // violation
export type Rejection = ActionRejection
export type Client = PoolClient
export const used = [Pool, makeActionClient, action, refusalsOf]
