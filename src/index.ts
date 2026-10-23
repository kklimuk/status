#!/usr/bin/env bun
import { run } from "@src/cli";

const result = run(process.argv.slice(2));
const stream = result.exitCode === 0 ? process.stdout : process.stderr;
const text = stream.isTTY ? result.output : Bun.stripANSI(result.output);
stream.write(`${text}\n`);
process.exitCode = result.exitCode;
