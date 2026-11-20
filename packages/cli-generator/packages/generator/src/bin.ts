#!/usr/bin/env node
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { main } from "#main.ts"

NodeRuntime.runMain(main.pipe(Effect.provide([NodeServices.layer, NodeCrypto.layerDigest])))
