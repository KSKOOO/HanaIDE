import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronScheduler, DEFAULT_CRON_EXECUTION_TIMEOUT_MS } from "../lib/desk/cron-scheduler.ts";

function createStore(job) {
  const calls = {
    runs: [],
    marks: [],
  };

  return {
    calls,
    store: {
      listJobs() {
        return [job];
      },
      logRun(id, run) {
        calls.runs.push({ id, run });
      },
      markRun(id) {
        calls.marks.push(id);
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cron-scheduler", () => {
  it("默认把 cron 执行超时上限设为 20 分钟", () => {
    expect(DEFAULT_CRON_EXECUTION_TIMEOUT_MS).toBe(20 * 60 * 1000);
  });

  it("执行成功时记录 success", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_1",
      label: "测试任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {},
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    } as any);

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_1");
    expect(calls.runs[0].run.status).toBe("success");
    expect(calls.marks).toEqual(["job_1"]);
    expect(done).toEqual([{ id: "job_1", result: { status: "success" } }]);
  });

  it("执行成功时把 executor 结果写入 run history 和 done event", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_direct",
      label: "通知任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const executionResult = {
      executorKind: "direct_action",
      action: "notify",
      delivery: { ok: true, deliveries: [{ channel: "desktop", status: "sent" }] },
    };
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => executionResult,
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    } as any);

    await scheduler.checkJobs();

    expect(calls.runs[0].run).toMatchObject({
      status: "success",
      executorKind: "direct_action",
      action: "notify",
      delivery: { ok: true, deliveries: [{ channel: "desktop", status: "sent" }] },
    });
    expect(done).toEqual([{ id: "job_direct", result: { status: "success", ...executionResult } }]);
  });

  it("执行抛错时记录 error 和错误信息", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_2",
      label: "失败任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {
        throw new Error("boom");
      },
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    } as any);

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_2");
    expect(calls.runs[0].run.status).toBe("error");
    expect(calls.runs[0].run.error).toBe("boom");
    expect(calls.marks).toEqual(["job_2"]);
    expect(done).toEqual([{ id: "job_2", result: { status: "error", error: "boom" } }]);
  });

  it("executeJob 抛 skipped 错误时记录 skipped，不推进 nextRunAt", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_3",
      label: "跳过任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {
        const err = new Error("agent 正在执行另一个 cron");
        (err as any).skipped = true;
        throw err;
      },
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    } as any);

    await scheduler.checkJobs();

    // 应该记录 skipped 状态
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_3");
    expect(calls.runs[0].run.status).toBe("skipped");

    // 关键：markRun 不应被调用（不推进 nextRunAt，下次重试）
    expect(calls.marks).toEqual([]);

    expect(done).toEqual([{ id: "job_3", result: { status: "skipped" } }]);
  });

  it("执行超过上限时 abort job 并记录 timeout 错误", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_timeout",
      label: "超时任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const abortJob = vi.fn();
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: () => new Promise(() => {}),
      abortJob,
      onJobDone: (j, result) => done.push({ id: j.id, result }),
      executionTimeoutMs: 100,
    });

    const check = scheduler.checkJobs();
    await vi.advanceTimersByTimeAsync(100);
    await check;

    expect(abortJob).toHaveBeenCalledWith("job_timeout");
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].run.status).toBe("error");
    expect(calls.runs[0].run.error).toBe("execution timeout (100ms)");
    expect(calls.marks).toEqual(["job_timeout"]);
    expect(done).toEqual([
      { id: "job_timeout", result: { status: "error", error: "execution timeout (100ms)" } },
    ]);
  });
});
