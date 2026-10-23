#!/usr/bin/env bun
import { createApp } from "@src/app";
import { run } from "@src/cli";

const result = await run(process.argv.slice(2), () => createApp(process.env));
const stream = result.exitCode === 0 ? process.stdout : process.stderr;
const text = stream.isTTY ? result.output : Bun.stripANSI(result.output);
stream.write(`${text}\n`);
process.exitCode = result.exitCode;
