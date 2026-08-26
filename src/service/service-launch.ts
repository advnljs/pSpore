import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SystemServiceLaunchSpec } from "./system-service.js";

export interface ServiceRuntimeIdentity {
  execPath: string;
  argvEntry?: string;
  moduleUrl: string;
  electron?: boolean;
}

/** Build a stable service command for npm, source builds, SEA, or Electron packages. */
export async function serviceLaunchSpec(
  home: string,
  workspace: string,
  identity: ServiceRuntimeIdentity,
): Promise<SystemServiceLaunchSpec> {
  const executable = resolve(identity.execPath);
  if (identity.electron) {
    const cliEntry = fileURLToPath(new URL("../cli/main.js", identity.moduleUrl));
    await requireReadableEntry(cliEntry);
    return {
      executable,
      args: [cliEntry, "--home", resolve(home), "daemon"],
      workingDirectory: resolve(workspace),
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  if (isSingleExecutableRuntime(identity.argvEntry, executable, identity.moduleUrl)) {
    return {
      executable,
      args: ["--home", resolve(home), "daemon"],
      workingDirectory: resolve(workspace),
    };
  }

  const cliEntry = await compiledCliEntry(identity.moduleUrl);
  return {
    executable,
    args: [cliEntry, "--home", resolve(home), "daemon"],
    workingDirectory: resolve(workspace),
  };
}

async function compiledCliEntry(moduleUrl: string): Promise<string> {
  const current = fileURLToPath(moduleUrl);
  if (current.endsWith(".js")) {
    await requireReadableEntry(current);
    return current;
  }
  const built = resolve(dirname(current), "../../dist/cli/main.js");
  await requireReadableEntry(built);
  return built;
}

async function requireReadableEntry(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`The system service entry is not built at ${path}; run \`npm run build\` first`);
  }
}

function isSingleExecutableRuntime(argvEntry: string | undefined, executable: string, moduleUrl: string): boolean {
  if (fileURLToPath(moduleUrl) === executable) return true;
  if (!argvEntry) return false;
  return resolve(argvEntry) === executable;
}
