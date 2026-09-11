import { test } from "vitest";
import { registerOutreachCases } from "./cases";
registerOutreachCases((name, run) => test(name, run));
