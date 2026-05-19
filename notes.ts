#!/usr/bin/env bun
import { main } from "./src/index.ts";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
