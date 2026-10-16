#!/usr/bin/env node
import { runRecruiterPackageGuards } from "./verify-guards.mjs";

runRecruiterPackageGuards("[verify-package]");
console.log("[verify-package] scoped recruiter package guard checks passed.");
