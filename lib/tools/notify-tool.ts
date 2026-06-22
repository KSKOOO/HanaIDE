/**
 * notify-tool.js — 用户通知工具
 *
 * 让 agent 能主动向用户发送提醒，由通知投递层决定桌面 / Bridge 等通道。
 * 仅在用户明确要求提醒/通知时使用，普通任务完成不调用。
 */

import { Type, StringEnum } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";

/**
 * @param {{ onNotify: (payload: object) => Promise<object|void> | object | void }} opts
 */
export function createNotifyTool({ onNotify }) {
  return {
    name: "notify",
    label: "Notification",
    description: "Send a notification to the user. Choose desktop popup, Bridge owner chat, or the default channel according to the task; pass bridgePlatforms when delivery must go to one or more explicit Bridge platforms such as WeChat, Feishu, Telegram, or QQ.\nUse cases:\n- The user says 'remind me about xxx', 'notify me when...', 'don't let me forget xxx'\n- A scheduled task prompt explicitly includes notification intent or asks to send it through Bridge/WeChat\n- A monitoring/scheduled task discovers something requiring user attention\nIf everything is normal with no issues, do not call this tool. Successful Bridge notifications can be appended to that conversation context according to contextPolicy.",
    parameters: Type.Object({
      title: Type.String({ description: "Notification title (brief)" }),
      body: Type.String({ description: "Notification content" }),
      audience: Type.Optional(StringEnum(["owner"], {
        description: "Notification audience. Use owner for the human user.",
      })),
      channels: Type.Optional(Type.Array(StringEnum(["auto", "desktop", "bridge_owner"], {
        description: "Delivery channels. Use desktop for local popup, bridge_owner for the owner's Bridge chat, or auto for default routing.",
      }), {
        description: "Preferred delivery channels. Do not include a channel unless the user asked for it or the task prompt implies it.",
      })),
      bridgePlatforms: Type.Optional(Type.Array(StringEnum(["wechat", "feishu", "telegram", "qq"], {
        description: "Explicit Bridge platform fan-out targets when channels includes bridge_owner. Provide multiple values to send the same notification to multiple platforms.",
      }), {
        description: "Bridge platforms to send to. If set, Bridge owner notifications are sent to every listed platform with an available owner target.",
      })),
      contextPolicy: Type.Optional(StringEnum(["none", "record_when_delivered"], {
        description: "Whether a successfully delivered Bridge notification should be appended to the Bridge conversation context.",
      })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { title, body } = params;
      try {
        const result = await onNotify?.({
          title,
          body,
          audience: params.audience,
          channels: params.channels,
          bridgePlatforms: params.bridgePlatforms,
          contextPolicy: params.contextPolicy,
        }, {
          sessionPath: typeof ctx?.sessionPath === "string" && ctx.sessionPath.trim() ? ctx.sessionPath.trim() : null,
          bridgeContext: ctx?.bridgeContext?.isBridgeSession === true ? ctx.bridgeContext : null,
          notificationContext: ctx?.notificationContext && typeof ctx.notificationContext === "object"
            ? ctx.notificationContext
            : null,
        });
        const sent = result?.ok !== false;
        const failure = Array.isArray(result?.deliveries)
          ? result.deliveries.find((d) => d?.status === "failed")?.error
          : null;
        return {
          content: [{
            type: "text",
            text: sent
              ? t("error.notifySent", { title })
              : t("error.notifyFailed", { msg: failure || "delivery failed" }),
          }],
          details: { title, body, sent, result },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.notifyFailed", { msg: err.message }) }],
          details: { title, body, sent: false, error: err.message },
        };
      }
    },
  };
}
