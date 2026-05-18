import * as core from "@actions/core";
import { main } from "./main.ts";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
});
