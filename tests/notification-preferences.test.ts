import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { createPreferencesRoute } from "../server/routes/preferences.ts";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-prefs-notification-"));
  return new PreferencesManager({
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  });
}

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine));
  return app;
}

describe("notification preferences", () => {
  it("defaults turn completion notifications to never", () => {
    const prefs = makePrefs();

    expect(prefs.getNotificationPreferences()).toEqual({
      turnCompletion: "never",
    });
  });

  it("persists normalized turn completion preference", () => {
    const prefs = makePrefs();

    expect(prefs.setNotificationPreferences({ turnCompletion: "when_unfocused" })).toEqual({
      turnCompletion: "when_unfocused",
    });
    expect(prefs.setNotificationPreferences({ turnCompletion: "when_session_unfocused" })).toEqual({
      turnCompletion: "when_session_unfocused",
    });
    expect(prefs.getPreferences().notifications).toEqual({
      turnCompletion: "when_session_unfocused",
    });
    expect(prefs.setNotificationPreferences({ turnCompletion: "sometimes" })).toEqual({
      turnCompletion: "never",
    });
  });

  it("reads and updates notification preferences through the route", async () => {
    let notifications = { turnCompletion: "never" };
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getNotificationPreferences: vi.fn(() => notifications),
      setNotificationPreferences: vi.fn((patch) => {
        notifications = {
          turnCompletion: patch.turnCompletion === "when_unfocused" || patch.turnCompletion === "when_session_unfocused"
            ? patch.turnCompletion
            : "never",
        };
        return notifications;
      }),
    };
    const app = makeApp(engine);

    const initial = await app.request("/api/preferences/notifications");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      notifications: { turnCompletion: "never" },
    });

    const updated = await app.request("/api/preferences/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifications: { turnCompletion: "when_session_unfocused" } }),
    });

    expect(updated.status).toBe(200);
    expect(engine.setNotificationPreferences).toHaveBeenCalledWith({
      turnCompletion: "when_session_unfocused",
    });
    expect(await updated.json()).toEqual({
      ok: true,
      notifications: { turnCompletion: "when_session_unfocused" },
    });
  });
});
