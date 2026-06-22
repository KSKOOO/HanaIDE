/**
 * stop-task-tool.js — 终止后台任务
 *
 * 通过 TaskRegistry 终止任何类型的后台任务（子代理、生图、生视频等）。
 */

import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";

export function createStopTaskTool(deps) {
  return {
    name: "stop_task",
    label: "Stop background task",
    description: "Stop a running background task. Pass the task_id to terminate it. Supported task types include sub-agent tasks, image/video generation tasks, etc.",
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to stop" }),
    }),
    execute: async (_toolCallId, params) => {
      const taskId = params.task_id?.trim();
      if (!taskId) {
        return { content: [{ type: "text", text: "task_id is required" }] };
      }

      const registry = deps.getTaskRegistry?.();
      if (!registry) {
        return { content: [{ type: "text", text: "task registry unavailable" }] };
      }

      const result = registry.abort(taskId);

      if (result === "not_found") {
        return { content: [{ type: "text", text: t("error.stopTaskNotFound", { taskId }) }] };
      }
      if (result === "already_aborted") {
        return { content: [{ type: "text", text: t("error.stopTaskAlready", { taskId }) }] };
      }
      if (result === "no_handler") {
        return { content: [{ type: "text", text: t("error.stopTaskNoHandler", { taskId }) }] };
      }

      return { content: [{ type: "text", text: t("error.stopTaskDone", { taskId }) }] };
    },
  };
}
