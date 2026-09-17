import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; version: string; notes: string }
  | {
      status: "downloading";
      version: string;
      received: number;
      total: number | null;
    }
  | { status: "ready"; version: string }
  | { status: "installing"; version: string }
  | { status: "error"; message: string };

export type AppUpdater = {
  phase: Phase;
  dismissed: boolean;
  checkForUpdate: (manual: boolean) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installAndRestart: () => Promise<void>;
  installNow: () => Promise<void>;
  dismiss: () => void;
};

function briefNotes(body: string | undefined): string {
  if (!body) {
    return "";
  }
  const line = body
    .split(/\r?\n/)
    .map((part) => part.replace(/^[#>*\-\s]+/, "").trim())
    .find((part) => part.length > 0);
  if (!line) {
    return "";
  }
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function friendlyUpdateError(err: unknown): string {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : "couldn't check for updates";
  const lower = raw.toLowerCase();
  if (
    lower.includes("404") ||
    lower.includes("not found") ||
    lower.includes("could not fetch a valid release") ||
    lower.includes("release json")
  ) {
    return "No signed update is published yet.";
  }
  if (
    lower.includes("network") ||
    lower.includes("offline") ||
    lower.includes("timed out") ||
    lower.includes("dns") ||
    lower.includes("connection")
  ) {
    return "Couldn't reach GitHub to check for updates.";
  }
  if (
    lower.includes("invoke") ||
    lower.includes("__tauri") ||
    lower.includes("not allowed") ||
    lower.includes("plugin")
  ) {
    return "Update checks run in the installed Squeeze app.";
  }
  return raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useAppUpdater(): AppUpdater {
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const updateRef = useRef<Update | null>(null);
  const busyRef = useRef(false);
  const downloadedRef = useRef(false);

  async function releaseUpdate() {
    const current = updateRef.current;
    updateRef.current = null;
    if (!current) {
      return;
    }
    try {
      await current.close();
    } catch {
      // Already installed or released.
    }
  }

  async function checkForUpdate(manual: boolean) {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setDismissed(false);
    downloadedRef.current = false;
    setPhase({ status: "checking" });
    await releaseUpdate();
    try {
      const update = await check();
      if (!update) {
        setDismissed(false);
        setPhase({ status: "current" });
        return;
      }
      updateRef.current = update;
      setDismissed(false);
      setPhase({
        status: "available",
        version: update.version,
        notes: briefNotes(update.body),
      });
    } catch (err) {
      setPhase(
        manual
          ? { status: "error", message: friendlyUpdateError(err) }
          : { status: "idle" },
      );
    } finally {
      busyRef.current = false;
    }
  }

  async function downloadUpdate() {
    const update = updateRef.current;
    if (!update || busyRef.current) {
      return;
    }
    busyRef.current = true;
    const version = update.version;
    setPhase({ status: "downloading", version, received: 0, total: null });
    try {
      let received = 0;
      let total: number | null = null;
      await update.download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          received = 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
        }
        setPhase({ status: "downloading", version, received, total });
      });
      downloadedRef.current = true;
      setPhase({ status: "ready", version });
    } catch (err) {
      setPhase({ status: "error", message: friendlyUpdateError(err) });
    } finally {
      busyRef.current = false;
    }
  }

  async function installNow() {
    const update = updateRef.current;
    if (!update || busyRef.current) {
      return;
    }
    busyRef.current = true;
    const version = update.version;
    try {
      if (!downloadedRef.current) {
        setPhase({ status: "downloading", version, received: 0, total: null });
        let received = 0;
        let total: number | null = null;
        await update.download((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? null;
            received = 0;
          } else if (event.event === "Progress") {
            received += event.data.chunkLength;
          }
          setPhase({ status: "downloading", version, received, total });
        });
        downloadedRef.current = true;
      }
      setPhase({ status: "installing", version });
      await update.install({ restartAfterInstall: true });
      await relaunch();
    } catch (err) {
      busyRef.current = false;
      setPhase({ status: "error", message: friendlyUpdateError(err) });
    }
  }

  async function installAndRestart() {
    const update = updateRef.current;
    if (!update || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setPhase({ status: "installing", version: update.version });
    try {
      // Windows launches the installer and exits. macOS and Linux return
      // here, then relaunch into the installed build.
      await update.install({ restartAfterInstall: true });
      await relaunch();
    } catch (err) {
      busyRef.current = false;
      setPhase({ status: "error", message: friendlyUpdateError(err) });
    }
  }

  function dismiss() {
    setDismissed(true);
    setPhase({ status: "idle" });
    void releaseUpdate();
  }

  useEffect(() => {
    if (import.meta.env.DEV) {
      return;
    }
    const timer = window.setTimeout(() => {
      void checkForUpdate(false);
    }, 1200);
    return () => window.clearTimeout(timer);
    // Startup check only. Manual checks go through the returned function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    phase,
    dismissed,
    checkForUpdate,
    downloadUpdate,
    installAndRestart,
    installNow,
    dismiss,
  };
}

function bannerCopy(phase: Phase): string {
  switch (phase.status) {
    case "available":
    case "ready":
      return "New update available";
    case "downloading":
      if (phase.total && phase.total > 0) {
        const pct = Math.min(100, Math.round((phase.received / phase.total) * 100));
        return `Downloading update · ${pct}%`;
      }
      return `Downloading update · ${formatBytes(phase.received)}`;
    case "installing":
      return "Installing update";
    case "error":
      return phase.message;
    default:
      return "";
  }
}

function GiftIcon() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
      <rect
        x="2.25"
        y="6.35"
        width="11.5"
        height="7.4"
        rx="0.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M2.25 6.35h11.5M8 6.35v7.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M8 6.35c-.15-1.7-1.15-2.85-2.45-2.85-1.05 0-1.7.7-1.55 1.45.2.95 1.35 1.4 3.99 1.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.35c.15-1.7 1.15-2.85 2.45-2.85 1.05 0 1.7.7 1.55 1.45-.2.95-1.35 1.4-3.99 1.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UpdateBanner({
  updater,
  jobsRunning,
  suppressed,
}: {
  updater: AppUpdater;
  jobsRunning: boolean;
  suppressed: boolean;
}) {
  const { phase, dismissed } = updater;
  const visible =
    !suppressed &&
    !dismissed &&
    (phase.status === "available" ||
      phase.status === "downloading" ||
      phase.status === "ready" ||
      phase.status === "installing" ||
      phase.status === "error");

  useEffect(() => {
    if (!visible) {
      return;
    }
    document.documentElement.classList.add("has-update-bar");
    return () => document.documentElement.classList.remove("has-update-bar");
  }, [visible]);

  if (!visible) {
    return null;
  }

  const downloading = phase.status === "downloading";
  const total = downloading ? phase.total : null;
  const received = downloading ? phase.received : 0;
  const known = downloading && total != null && total > 0;
  const pct = known ? Math.min(100, Math.round((received / (total as number)) * 100)) : 0;
  const canAct = phase.status !== "downloading" && phase.status !== "installing";
  const installLabel = phase.status === "error" ? "Try again" : "Install Now";

  return (
    <div className="update-bar" role="status" aria-live="polite">
      <div className="update-bar-lead">
        <GiftIcon />
        <p>{bannerCopy(phase)}</p>
      </div>
      {canAct && (
        <div className="update-bar-actions">
          <button type="button" className="update-later" onClick={updater.dismiss}>
            Later
          </button>
          <button
            type="button"
            className="update-install"
            onClick={() =>
              void (phase.status === "error"
                ? updater.checkForUpdate(true)
                : updater.installNow())
            }
            title={
              jobsRunning && phase.status !== "error"
                ? "Restarting stops the squeeze in progress"
                : undefined
            }
          >
            {installLabel}
          </button>
        </div>
      )}
      {downloading && (
        <div
          className={`update-bar-progress${known ? "" : " is-unknown"}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={known ? pct : undefined}
          aria-label="Update download progress"
        >
          <span style={{ width: known ? `${pct}%` : undefined }} />
        </div>
      )}
    </div>
  );
}
