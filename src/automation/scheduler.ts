import { Cron } from "croner";

import type { JobStore } from "./job-store.js";
import type { RunLedger } from "./run-ledger.js";
import type { JobDefinition, RunRecord, RunStatus, RunTriggerSpec } from "./types.js";

export interface RunExecutionResult {
  status: "succeeded" | "blocked" | "budget_exhausted";
  reason?: string;
}

export interface RunExecutor {
  execute(run: RunRecord, signal: AbortSignal): Promise<RunExecutionResult>;
}

export interface SchedulerOptions {
  jobs: Pick<JobStore, "loadAll">;
  ledger: RunLedger;
  executor: RunExecutor;
  maxConcurrentRuns: number;
  replaceGraceMs?: number;
  clock?: () => Date;
  onRun?: (run: RunRecord) => void;
  onError?: (error: Error) => void;
}

interface ActiveRun {
  record: RunRecord;
  controller: AbortController;
  completion: Promise<RunRecord>;
}

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #jobs = new Map<string, JobDefinition>();
  readonly #crons = new Map<string, Cron>();
  readonly #active = new Map<string, ActiveRun>();
  #initialized = false;
  #started = false;
  #stopping = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const recovery = await this.#options.ledger.initialize();
    for (const run of recovery.recoveredUnknown) this.#publish(run);
    const jobs = await this.#options.jobs.loadAll();
    for (const job of jobs) {
      if (this.#jobs.has(job.id)) throw new Error(`Duplicate job id: ${job.id}`);
      this.#jobs.set(job.id, job);
    }
    this.#initialized = true;
  }

  async start(): Promise<void> {
    await this.initialize();
    if (this.#started) return;
    this.#started = true;
    for (const queued of this.#options.ledger.list().filter((run) => run.status === "queued")) {
      void this.#launch(queued).catch((error: unknown) => this.#error(error));
    }
    for (const job of this.#jobs.values()) {
      if (!job.enabled) continue;
      const cron = new Cron(
        job.schedule.cron,
        {
          timezone: job.schedule.timezone,
          mode: "5-part",
          unref: true,
          catch: (error) => this.#error(error),
        },
        async (self) => {
          const scheduledFor = self.currentRun() ?? this.#clock();
          await this.triggerJob(job.id, scheduledFor, "cron");
        },
      );
      this.#crons.set(job.id, cron);
    }
    void this.applyMisfires(this.#clock()).catch((error: unknown) => this.#error(error));
  }

  async applyMisfires(now: Date): Promise<void> {
    for (const job of this.#jobs.values()) {
      if (!job.enabled) continue;
      const latest = this.#options.ledger.latestForJob(job.id);
      if (!latest) continue;
      const cron = new Cron(job.schedule.cron, {
        timezone: job.schedule.timezone,
        mode: "5-part",
        paused: true,
      });
      let previous: Date | undefined;
      try {
        previous = cron.previousRuns(1, now)[0];
      } finally {
        cron.stop();
      }
      if (!previous || previous.toISOString() <= latest.scheduledFor || previous.getTime() >= now.getTime()) continue;
      if (job.misfire === "run_once") {
        await this.triggerJob(job.id, previous, "recovery");
      } else {
        const claim = await this.#options.ledger.claim(toTrigger(job, previous, now, "recovery"));
        if (claim.claimed) {
          this.#publish(claim.record);
          this.#publish(
            await this.#options.ledger.transition(claim.record.id, {
              status: "skipped",
              finishedAt: now.toISOString(),
              reason: "misfire policy is skip",
            }),
          );
        }
      }
    }
  }

  async triggerJob(jobId: string, scheduledFor: Date, source: "cron" | "recovery" | "user" = "cron"): Promise<RunRecord> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return this.trigger(toTrigger(job, scheduledFor, this.#clock(), source));
  }

  async trigger(spec: RunTriggerSpec): Promise<RunRecord> {
    if (!this.#initialized) throw new Error("Scheduler is not initialized");
    if (this.#stopping) throw new Error("Scheduler is stopping");
    const claim = await this.#options.ledger.claim(spec);
    if (!claim.claimed) return claim.record;
    this.#publish(claim.record);
    return this.#launch(claim.record);
  }

  async cancel(runId: string, reason = "cancelled by user"): Promise<RunRecord> {
    const active = this.#active.get(runId);
    if (active) {
      active.controller.abort(new Error(reason));
      return active.completion;
    }
    const record = this.#options.ledger.get(runId);
    if (!record) throw new Error(`Unknown run: ${runId}`);
    if (record.status !== "queued") return record;
    const cancelled = await this.#options.ledger.transition(runId, {
      status: "cancelled",
      finishedAt: this.#clock().toISOString(),
      reason,
    });
    this.#publish(cancelled);
    return cancelled;
  }

  listRuns(): RunRecord[] {
    return this.#options.ledger.list();
  }

  listJobs(): JobDefinition[] {
    return [...this.#jobs.values()].map((job) => structuredClone(job));
  }

  async stop(): Promise<void> {
    if (this.#stopping) {
      await Promise.allSettled([...this.#active.values()].map((active) => active.completion));
      return;
    }
    this.#stopping = true;
    for (const cron of this.#crons.values()) cron.stop();
    this.#crons.clear();
    for (const active of this.#active.values()) active.controller.abort(new Error("scheduler shutdown"));
    await Promise.allSettled([...this.#active.values()].map((active) => active.completion));
  }

  async #launch(record: RunRecord): Promise<RunRecord> {
    const jobKey = record.jobId ?? record.slotKey;
    const sameJob = [...this.#active.values()].filter((active) => (active.record.jobId ?? active.record.slotKey) === jobKey);
    if (record.concurrency === "forbid" && sameJob.length > 0) {
      return this.#skip(record, "concurrency policy forbid: another run is active");
    }
    if (record.concurrency === "replace" && sameJob.length > 0) {
      for (const active of sameJob) active.controller.abort(new Error(`replaced by run ${record.id}`));
      const settled = await settlesWithin(
        Promise.allSettled(sameJob.map((active) => active.completion)),
        this.#options.replaceGraceMs ?? 5_000,
      );
      if (!settled) return this.#skip(record, "replace cancellation did not settle before grace deadline");
    }
    if (this.#active.size >= this.#options.maxConcurrentRuns) {
      return this.#skip(record, "global scheduler concurrency budget exhausted");
    }

    const running = await this.#options.ledger.transition(record.id, {
      status: "running",
      startedAt: this.#clock().toISOString(),
    });
    this.#publish(running);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`run timeout after ${running.timeoutMs}ms`));
    }, running.timeoutMs);
    let completion!: Promise<RunRecord>;
    completion = this.#execute(running, controller.signal, () => timedOut).finally(() => {
      clearTimeout(timer);
      const current = this.#active.get(running.id);
      if (current?.completion === completion) this.#active.delete(running.id);
    });
    this.#active.set(running.id, { record: running, controller, completion });
    return completion;
  }

  async #execute(running: RunRecord, signal: AbortSignal, timedOut: () => boolean): Promise<RunRecord> {
    let status: RunStatus;
    let reason: string | undefined;
    let errorMessage: string | undefined;
    try {
      const result = await this.#options.executor.execute(running, signal);
      status = result.status;
      reason = result.reason;
    } catch (error) {
      const normalized = toError(error);
      if (signal.aborted) {
        status = timedOut() ? "budget_exhausted" : "cancelled";
        reason = normalized.message;
      } else {
        status = "failed";
        errorMessage = normalized.message;
      }
    }
    const finished = await this.#options.ledger.transition(running.id, {
      status,
      finishedAt: this.#clock().toISOString(),
      ...(reason === undefined ? {} : { reason }),
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    });
    this.#publish(finished);
    return finished;
  }

  async #skip(record: RunRecord, reason: string): Promise<RunRecord> {
    const skipped = await this.#options.ledger.transition(record.id, {
      status: "skipped",
      finishedAt: this.#clock().toISOString(),
      reason,
    });
    this.#publish(skipped);
    return skipped;
  }

  #publish(run: RunRecord): void {
    try {
      this.#options.onRun?.(structuredClone(run));
    } catch {
      // Observability cannot change run execution or ledger state.
    }
  }

  #error(error: unknown): void {
    try {
      this.#options.onError?.(toError(error));
    } catch {
      // Cron callback errors are already isolated from scheduling.
    }
  }

  #clock(): Date {
    return (this.#options.clock ?? (() => new Date()))();
  }
}

function toTrigger(
  job: JobDefinition,
  scheduledFor: Date,
  receivedAt: Date,
  source: "cron" | "recovery" | "user",
): RunTriggerSpec {
  const scheduled = scheduledFor.toISOString();
  return {
    slotKey: `${source === "user" ? "user" : "cron"}:${job.id}:${scheduled}`,
    source,
    jobId: job.id,
    scheduledFor: scheduled,
    receivedAt: receivedAt.toISOString(),
    objective: job.activity.kind === "agent" ? job.activity.prompt : `Run scheduled command for job ${job.id}`,
    activity: structuredClone(job.activity),
    policyRef: job.policyRef,
    concurrency: job.concurrency,
    timeoutMs: job.timeoutMs,
    budget: structuredClone(job.budget),
    delivery: structuredClone(job.delivery),
  };
}

async function settlesWithin(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([task.then(() => true as const), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
