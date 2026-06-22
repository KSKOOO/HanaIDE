/**
 * cron-scheduler.js — Cron 调度器
 *
 * 确定性代码层：每分钟检查一次到期任务，到期时回调执行。
 * 调度逻辑不涉及 LLM，只有执行回调才会创建 session 调 LLM。
 *
 * 参考 OpenClaw 的 Gateway 级调度器设计：
 * 调度器和 Agent Runtime 分开，定时逻辑不跟 LLM 调用耦合。
 */

import { debugLog, createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("cron");
export const DEFAULT_CRON_EXECUTION_TIMEOUT_MS = 20 * 60 * 1000;

function normalizeExecutionTimeoutMs(value) {
  if (value === undefined) return DEFAULT_CRON_EXECUTION_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("executionTimeoutMs must be a positive finite number");
  }
  return value;
}

function formatTimeoutMs(ms) {
  if (ms % 60_000 === 0) return `${ms / 60_000}min`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * 创建 Cron 调度器
 *
 * @param {object} opts
 * @param {import('./cron-store.ts').CronStore} opts.cronStore
 * @param {(job: object) => Promise<void>} opts.executeJob - 执行回调（由 engine 提供）
 * @param {(jobId: string) => void} [opts.abortJob] - 超时时 abort 正在执行的任务
 * @param {(job: object, result: object) => void} [opts.onJobDone] - 执行完成通知
 * @param {number} [opts.executionTimeoutMs] - 单次任务执行超时，默认 20 分钟
 * @returns {{ start, stop, checkJobs }}
 */
export function createCronScheduler({ cronStore, executeJob, abortJob, onJobDone, executionTimeoutMs }) {
  const CHECK_INTERVAL = 60_000; // 每分钟检查一次
  const effectiveExecutionTimeoutMs = normalizeExecutionTimeoutMs(executionTimeoutMs);
  let _timer = null;
  let _checking = false;
  let _checkPromise = null;

  /**
   * 检查所有到期任务并执行
   */
  async function checkJobs() {
    if (_checking) return;
    _checking = true;
    const p = _doCheck();
    _checkPromise = p;
    await p;
  }

  async function _doCheck() {
    try {
      const now = Date.now();
      const jobs = cronStore.listJobs();

      for (const job of jobs) {
        if (!job.enabled) continue;
        if (!job.nextRunAt) continue;

        const nextRunTime = new Date(job.nextRunAt).getTime();
        if (now < nextRunTime) continue;

        // 到期了，执行
        log.log(`执行任务: ${job.label} (${job.id})`);
        debugLog()?.log("cron", `run ${job.id} (${job.label})`);
        const startedAt = new Date().toISOString();

        try {
          let executionResult;
          {
            let timer;
            try {
              executionResult = await Promise.race([
                executeJob(job),
                new Promise((_, reject) => {
                  timer = setTimeout(() => {
                    abortJob?.(job.id);
                    reject(new Error(`execution timeout (${formatTimeoutMs(effectiveExecutionTimeoutMs)})`));
                  }, effectiveExecutionTimeoutMs);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          const finishedAt = new Date().toISOString();

          // 记录成功
          cronStore.logRun(job.id, {
            status: "success",
            startedAt,
            finishedAt,
            ...(executionResult && typeof executionResult === "object" && !Array.isArray(executionResult)
              ? executionResult
              : {}),
          });
          cronStore.markRun(job.id, { success: true });
          debugLog()?.log("cron", `job success ${job.id}`);

          onJobDone?.(job, {
            status: "success",
            ...(executionResult && typeof executionResult === "object" && !Array.isArray(executionResult)
              ? executionResult
              : {}),
          });
        } catch (err) {
          const finishedAt = new Date().toISOString();

          if (err.skipped) {
            // 跳过：不推进 nextRunAt，下次 check 时重试
            cronStore.logRun(job.id, { status: "skipped", startedAt, finishedAt });
            debugLog()?.log("cron", `job skipped ${job.id}: ${err.message}`);
            onJobDone?.(job, { status: "skipped" });
          } else {
            // 真正失败：记录并推进 nextRunAt（含退避）
            cronStore.logRun(job.id, { status: "error", startedAt, finishedAt, error: err.message });
            cronStore.markRun(job.id, { success: false });

            log.error(`任务失败 ${job.id}: ${err.message}`);
            debugLog()?.error("cron", `job failed ${job.id}: ${err.message}`);
            onJobDone?.(job, { status: "error", error: err.message });
          }
        }
      }
    } catch (err) {
      log.error(`checkJobs 错误: ${err.message}`);
      debugLog()?.error("cron", `checkJobs error: ${err.message}`);
    } finally {
      _checking = false;
    }
  }

  function start() {
    if (_timer) return;
    _timer = setInterval(() => checkJobs(), CHECK_INTERVAL);
    // 不 unref：cron 是核心功能，空闲时也必须可靠触发
    log.log("调度器已启动（间隔 60 秒）");
  }

  async function stop() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    if (_checkPromise) {
      await _checkPromise.catch(() => {});
      _checkPromise = null;
    }
  }

  return { start, stop, checkJobs };
}
