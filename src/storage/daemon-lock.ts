import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";

import { atomicWriteJson } from "./atomic.js";

interface LockRecord {
  version: 1;
  pid: number;
  processStart: string;
  instanceId: string;
  createdAt: string;
}

export interface DaemonLock {
  instanceId: string;
  release(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`pSpore daemon is already running with PID ${pid}`);
    this.name = "DaemonAlreadyRunningError";
    this.pid = pid;
  }
}

export async function acquireDaemonLock(path: string, now = new Date()): Promise<DaemonLock> {
  const current: LockRecord = {
    version: 1,
    pid: process.pid,
    processStart: await linuxProcessStart(process.pid),
    instanceId: randomUUID(),
    createdAt: now.toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(current, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      return {
        instanceId: current.instanceId,
        release: async () => {
          const existing = await readLock(path);
          if (existing?.instanceId === current.instanceId) await unlink(path);
        },
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await readLock(path);
      if (existing && (await isSameProcess(existing))) {
        throw new DaemonAlreadyRunningError(existing.pid);
      }
      await unlink(path).catch((unlinkError: unknown) => {
        if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error("Could not acquire daemon lock after stale-lock recovery");
}

export async function writeEndpoint(
  path: string,
  value: { instanceId: string; socket: string; pid: number; state: string; startedAt: string },
): Promise<void> {
  await atomicWriteJson(path, { version: 1, ...value }, 0o600);
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) return undefined;
    if (
      value["version"] !== 1 ||
      typeof value["pid"] !== "number" ||
      typeof value["processStart"] !== "string" ||
      typeof value["instanceId"] !== "string" ||
      typeof value["createdAt"] !== "string"
    ) {
      return undefined;
    }
    return value as unknown as LockRecord;
  } catch {
    return undefined;
  }
}

async function isSameProcess(record: LockRecord): Promise<boolean> {
  try {
    return (await linuxProcessStart(record.pid)) === record.processStart;
  } catch {
    return false;
  }
}

async function linuxProcessStart(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const startTime = tail[19];
  if (!startTime) throw new Error(`Could not read process start identity for PID ${pid}`);
  return startTime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
