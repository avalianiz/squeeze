import {
  useEffect,
  useRef,
  useState,
  startTransition,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { UpdateBanner, useAppUpdater } from "./updater";
import "./App.css";

function safeFileSrc(path: string) {
  try {
    return convertFileSrc(path);
  } catch {
    return path.startsWith("data:") || path.startsWith("http") ? path : "";
  }
}

type Media = {
  path: string;
  duration_seconds: number;
  size_bytes: number;
  width: number | null;
  height: number | null;
  frame_rate: number | null;
  video_codec: string | null;
  audio_codec: string | null;
};

type JobStatus =
  | "draft"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

type OutputMode = "copy_beside" | "replace";
type JobKind = "squeeze" | "trim";

type TrimRange = {
  start_seconds: number;
  end_seconds: number;
};

type FitPreset = "original" | "1080p" | "720p";
type FpsCap = "unlimited" | "60" | "30";

type JobSettingsInput = {
  targetSizeBytes: number;
  muteAudio: boolean;
  maxWidth: number | null;
  maxHeight: number | null;
  maxFps: number | null;
};

type PlanPreview = {
  ok: boolean;
  duration_seconds: number;
  target_size_bytes: number;
  video_bitrate_bps: number | null;
  audio_bitrate_bps: number;
  message: string;
  squeeze_blocked: boolean;
  suggested_fit_label: string | null;
  suggested_max_width: number | null;
  suggested_max_height: number | null;
  suggested_max_fps: number | null;
  suggested_mute: boolean;
  suggested_target_mb: number | null;
};

type JobSettings = {
  target_size_bytes: number;
  mute_audio: boolean;
  max_width: number | null;
  max_height: number | null;
  max_fps: number | null;
  audio_bitrate_kbps?: number;
};

type CompressionJob = {
  id: string;
  input_path: string;
  output_path: string | null;
  status: JobStatus;
  error: string | null;
  progress_percent: number;
  output_size_bytes: number | null;
  settings: JobSettings;
  output_mode: OutputMode;
  trim: TrimRange | null;
  kind: JobKind;
  output_name: string | null;
  skipped?: boolean;
  note?: string | null;
  retried?: boolean;
};

type JobProgress = {
  job_id: string;
  elapsed_seconds: number;
  duration_seconds: number;
  percentage: number;
};

type DropIngestResult = {
  jobs_added: number;
  preview_path: string | null;
};

type PersistedPrefs = {
  targetSizeMb: number;
  replaceOriginals: boolean;
  muteAudio: boolean;
  fitPreset: FitPreset;
  fpsCap: FpsCap;
  skipReplaceConfirm: boolean;
};

const DEFAULT_TARGET_SIZE_MB = 25;
const TARGET_PRESETS = [10, 25, 50] as const;
/** Min inner width for side-by-side preview + export sidebar (queue column still needs 1280). */
const WORKBENCH_MIN_WIDTH = 1100;
const PREFS_KEY = "squeeze.prefs.v2";

function fitLimits(fit: FitPreset, fps: FpsCap): {
  maxWidth: number | null;
  maxHeight: number | null;
  maxFps: number | null;
} {
  const maxFps = fps === "unlimited" ? null : Number(fps);
  if (fit === "1080p") {
    return { maxWidth: 1920, maxHeight: 1080, maxFps };
  }
  if (fit === "720p") {
    return { maxWidth: 1280, maxHeight: 720, maxFps };
  }
  return { maxWidth: null, maxHeight: null, maxFps };
}

function fitFromLimits(
  maxWidth: number | null,
  maxHeight: number | null,
  maxFps: number | null,
): { fitPreset: FitPreset; fpsCap: FpsCap } {
  let fitPreset: FitPreset = "original";
  if (maxHeight != null && maxHeight <= 720) {
    fitPreset = "720p";
  } else if (maxHeight != null && maxHeight <= 1080) {
    fitPreset = "1080p";
  } else if (maxWidth != null && maxWidth <= 1280) {
    fitPreset = "720p";
  } else if (maxWidth != null && maxWidth <= 1920) {
    fitPreset = "1080p";
  }
  const fpsCap: FpsCap =
    maxFps === 30 ? "30" : maxFps === 60 ? "60" : "unlimited";
  return { fitPreset, fpsCap };
}

function loadPrefs(): PersistedPrefs {
  const defaults: PersistedPrefs = {
    targetSizeMb: DEFAULT_TARGET_SIZE_MB,
    replaceOriginals: false,
    muteAudio: false,
    fitPreset: "original",
    fpsCap: "unlimited",
    skipReplaceConfirm: false,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedPrefs>;
    const fitPreset =
      parsed.fitPreset === "1080p" || parsed.fitPreset === "720p"
        ? parsed.fitPreset
        : "original";
    const fpsCap =
      parsed.fpsCap === "60" || parsed.fpsCap === "30"
        ? parsed.fpsCap
        : "unlimited";
    const target = Number(parsed.targetSizeMb);
    return {
      targetSizeMb: Number.isFinite(target)
        ? Math.min(2048, Math.max(1, Math.round(target)))
        : DEFAULT_TARGET_SIZE_MB,
      replaceOriginals: Boolean(parsed.replaceOriginals),
      muteAudio: Boolean(parsed.muteAudio),
      fitPreset,
      fpsCap,
      skipReplaceConfirm: Boolean(parsed.skipReplaceConfirm),
    };
  } catch {
    return defaults;
  }
}

function savePrefs(prefs: PersistedPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
  }
}

function mbToBytes(mb: number) {
  return Math.round(mb * 1024 * 1024);
}

function formatSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Whole-second timecode for display and editable fields */
function formatTimecode(seconds: number) {
  return formatDuration(seconds);
}

function parseTimecode(text: string, maxSeconds: number): number | null {
  const raw = text.trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(
    /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$|^(\d+(?:\.\d+)?)$/,
  );
  if (!match) {
    return null;
  }
  let seconds = 0;
  if (match[5] != null) {
    seconds = Number(match[5]);
  } else {
    const h = match[1] != null ? Number(match[1]) : 0;
    const m = Number(match[2]);
    const s = Number(match[3]);
    const frac = match[4] != null ? Number(`0.${match[4]}`) : 0;
    if (![h, m, s, frac].every((n) => Number.isFinite(n)) || m >= 60 || s >= 60) {
      return null;
    }
    seconds = h * 3600 + m * 60 + s + frac;
  }
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return clamp(seconds, 0, maxSeconds);
}

function formatBitrate(bps: number | null | undefined) {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) {
    return null;
  }
  const mbps = bps / 1_000_000;
  if (mbps >= 10) {
    return `${Math.round(mbps)} Mbps`;
  }
  if (mbps >= 1) {
    return `${mbps.toFixed(1)} Mbps`;
  }
  return `${Math.round(bps / 1000)} kbps`;
}

function fileExt(path: string) {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function isTargetPreset(mb: number): mb is (typeof TARGET_PRESETS)[number] {
  return (TARGET_PRESETS as readonly number[]).includes(mb);
}

function formatEta(elapsedSeconds: number, percentage: number) {
  if (percentage <= 1) {
    return null;
  }
  const remaining = elapsedSeconds * ((100 - percentage) / percentage);
  return `~${formatDuration(remaining)} left`;
}

function fileName(path: string) {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function fileStem(path: string) {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function pathKey(path: string) {
  return path.replace(/\//g, "\\").toLowerCase();
}

function sameMediaPath(a: string, b: string) {
  return pathKey(a) === pathKey(b);
}

function jobDisplayName(job: CompressionJob) {
  return job.output_name?.trim() || fileName(job.input_path);
}

function defaultOutputStem(path: string) {
  // Capture tools often bake ".DVR" into the stem before the real extension.
  const stem = fileStem(path).replace(/\.dvr$/i, "");
  return `${stem}-compressed`;
}

function outputExtFor(path: string) {
  const ext = fileExt(path).toLowerCase();
  if ([".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(ext)) {
    return ext;
  }
  return ".mp4";
}

function statusLabel(status: JobStatus) {
  switch (status) {
    case "draft":
      return "ready";
    case "queued":
      return "ready";
    case "running":
      return "encoding";
    case "succeeded":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
  }
}

function resolutionShortLabel(
  height: number | null,
  width: number | null,
): string {
  if (height != null && height > 0) {
    return `${height}p`;
  }
  if (width != null && height != null) {
    return `${width}×${height}`;
  }
  return "—";
}

function targetResolutionLabel(fit: FitPreset, media: Media | null): string {
  if (fit === "720p") {
    return "720p";
  }
  if (fit === "1080p") {
    return "1080p";
  }
  return media ? resolutionShortLabel(media.height, media.width) : "Original";
}

function queueMetaSummary(job: CompressionJob): string {
  const parts: string[] = [];
  if (job.trim) {
    parts.push(
      `${formatDuration(job.trim.start_seconds)}–${formatDuration(job.trim.end_seconds)}`,
    );
  }
  if (job.settings.mute_audio) {
    parts.push("Muted");
  }
  if (job.status === "succeeded" && job.output_size_bytes != null && !job.skipped) {
    parts.push(formatSize(job.output_size_bytes));
  } else if (
    job.output_size_bytes != null &&
    job.status !== "succeeded"
  ) {
    parts.push(formatSize(job.output_size_bytes));
  }
  if (job.skipped && job.status === "succeeded") {
    parts.push("Kept original");
  } else if (job.output_path) {
    parts.push(fileName(job.output_path));
  }
  return parts.join(" · ");
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M8 5.5v13l11-6.5L8 5.5z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M7 5h3.5v14H7V5zm6.5 0H17v14h-3.5V5z" />
    </svg>
  );
}

function IconSkipBack() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

function IconSkipForward() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
    </svg>
  );
}

function IconPrevVideo() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.2 12 18 17.5v-11L11.2 12zM6 6.5h2.2v11H6v-11z"
      />
    </svg>
  );
}

function IconNextVideo() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12.8 12 6 6.5v11L12.8 12zM15.8 6.5H18v11h-2.2v-11z"
      />
    </svg>
  );
}

function IconBack() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 5L8 12l7 7"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M6 6l12 12M18 6L6 18"
      />
    </svg>
  );
}


function IconExpand() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"
      />
    </svg>
  );
}

function IconCollapse() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 9H5V5M15 9h4V5M9 15H5v4M15 15h4v4"
      />
    </svg>
  );
}

function IconVolume() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5H4zm10.2 1.1a2.6 2.6 0 0 1 0 2.8l-1.1-1a1.2 1.2 0 0 0 0-.8l1.1-1zm2.1-2.3a5.2 5.2 0 0 1 0 7.4l-1.15-1.05a3.7 3.7 0 0 0 0-5.3l1.15-1.05z"
      />
    </svg>
  );
}

function IconVolumeMuted() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5H4zm11.3-.4 1.4 1.4 1.4-1.4 1.1 1.1-1.4 1.4 1.4 1.4-1.1 1.1-1.4-1.4-1.4 1.4-1.1-1.1 1.4-1.4-1.4-1.4 1.1-1.1z"
      />
    </svg>
  );
}

type DragKind = "start" | "end" | "seek" | null;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function App() {
  const [prefs] = useState(loadPrefs);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [jobs, setJobs] = useState<CompressionJob[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replaceOriginals, setReplaceOriginals] = useState(prefs.replaceOriginals);
  const [targetSizeMb, setTargetSizeMb] = useState(prefs.targetSizeMb);
  const [muteAudio, setMuteAudio] = useState(prefs.muteAudio);
  const [fitPreset, setFitPreset] = useState<FitPreset>(prefs.fitPreset);
  const [fpsCap, setFpsCap] = useState<FpsCap>(prefs.fpsCap);
  const [planPreview, setPlanPreview] = useState<PlanPreview | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [liveProgress, setLiveProgress] = useState<JobProgress | null>(null);
  const [scrubDrag, setScrubDrag] = useState<DragKind>(null);
  const [outputName, setOutputName] = useState("");
  const [maximized, setMaximized] = useState(false);
  /** Side-by-side workbench when the window is wide enough (not only when maximized). */
  const [workbench, setWorkbench] = useState(
    () =>
      typeof window !== "undefined" && window.innerWidth >= WORKBENCH_MIN_WIDTH,
  );
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [filmstripFrames, setFilmstripFrames] = useState<string[]>([]);
  const [filmstripLoading, setFilmstripLoading] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [targetCustom, setTargetCustom] = useState(
    () => !isTargetPreset(prefs.targetSizeMb),
  );
  const [startDraft, setStartDraft] = useState("0:00.00");
  const [endDraft, setEndDraft] = useState("0:00.00");
  const [durationDraft, setDurationDraft] = useState("0:00.00");
  const [chromeVisible, setChromeVisible] = useState(true);
  const [playbackVolume, setPlaybackVolume] = useState(1);
  const [playbackMuted, setPlaybackMuted] = useState(false);
  const [skipReplaceConfirm, setSkipReplaceConfirm] = useState(
    prefs.skipReplaceConfirm,
  );
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    dontAskAgainKey?: "replace";
    resolve: (result: { ok: boolean; dontAskAgain: boolean }) => void;
  } | null>(null);
  const [confirmDontAskAgain, setConfirmDontAskAgain] = useState(false);
  const updater = useAppUpdater();
  const scrubRef = useRef<HTMLDivElement | null>(null);
  const chromeTimerRef = useRef(0);
  const lastEscRef = useRef(0);

  function askConfirm(
    message: string,
    opts?: {
      confirmLabel?: string;
      danger?: boolean;
      dontAskAgainKey?: "replace";
    },
  ): Promise<{ ok: boolean; dontAskAgain: boolean }> {
    return new Promise((resolve) => {
      setConfirmDontAskAgain(false);
      setConfirmDialog({
        message,
        confirmLabel: opts?.confirmLabel,
        danger: opts?.danger,
        dontAskAgainKey: opts?.dontAskAgainKey,
        resolve,
      });
    });
  }

  function closeConfirm(ok: boolean) {
    const dontAskAgain = confirmDontAskAgain;
    setConfirmDialog((current) => {
      if (current) {
        current.resolve({ ok, dontAskAgain });
      }
      return null;
    });
    setConfirmDontAskAgain(false);
  }

  const replaceRef = useRef(replaceOriginals);
  const settingsRef = useRef<JobSettingsInput>({
    targetSizeBytes: mbToBytes(prefs.targetSizeMb),
    muteAudio: prefs.muteAudio,
    ...fitLimits(prefs.fitPreset, prefs.fpsCap),
  });
  const busyRef = useRef(busy);
  const mediaRef = useRef(media);
  const jobsRef = useRef(jobs);
  const previewExpandedRef = useRef(previewExpanded);
  const trimStartRef = useRef(trimStart);
  const trimEndRef = useRef(trimEnd);
  const outputNameRef = useRef(outputName);
  const editingJobIdRef = useRef(editingJobId);
  const saveTimerRef = useRef(0);
  const ingestingRef = useRef(false);
  const pendingOpenPathsRef = useRef<string[]>([]);
  const handleDroppedPathsRef = useRef<(paths: string[]) => Promise<void>>(
    async () => {},
  );
  replaceRef.current = replaceOriginals;
  busyRef.current = busy;
  mediaRef.current = media;
  jobsRef.current = jobs;
  previewExpandedRef.current = previewExpanded;
  trimStartRef.current = trimStart;
  trimEndRef.current = trimEnd;
  outputNameRef.current = outputName;
  editingJobIdRef.current = editingJobId;

  function buildSettings(
    targetMb = targetSizeMb,
    mute = muteAudio,
    fit = fitPreset,
    fps = fpsCap,
  ): JobSettingsInput {
    return {
      targetSizeBytes: mbToBytes(targetMb),
      muteAudio: mute,
      ...fitLimits(fit, fps),
    };
  }

  settingsRef.current = buildSettings();

  useEffect(() => {
    savePrefs({
      targetSizeMb,
      replaceOriginals,
      muteAudio,
      fitPreset,
      fpsCap,
      skipReplaceConfirm,
    });
  }, [
    targetSizeMb,
    replaceOriginals,
    muteAudio,
    fitPreset,
    fpsCap,
    skipReplaceConfirm,
  ]);

  // Dev-only layout mock: /?mock=workbench (&max=1 workbench+maximized, &fs=1 cinema)
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("mock") !== "workbench") {
      return;
    }
    if (params.get("max") === "1") {
      setMaximized(true);
      setWorkbench(true);
    }
    const mockPath =
      "C:\\Videos\\example-clip.mp4";
    const probed: Media = {
      path: mockPath,
      duration_seconds: 60,
      size_bytes: Math.round(54.45 * 1024 * 1024),
      width: 1920,
      height: 1080,
      frame_rate: 60,
      video_codec: "h264",
      audio_codec: "aac",
    };
    setMedia(probed);
    setOutputName(defaultOutputStem(mockPath));
    setTrimStart(39);
    setTrimEnd(48);
    setCurrentTime(47);
    setTargetSizeMb(5);
    setTargetCustom(true);
    setFitPreset("original");
    setFpsCap("unlimited");
    setReplaceOriginals(false);
    setPlanPreview({
      ok: true,
      duration_seconds: 9,
      target_size_bytes: Math.round(5 * 1024 * 1024),
      video_bitrate_bps: 4_500_000,
      audio_bitrate_bps: 128_000,
      message: "9s · about 4.5 Mbps video · about 5 MB",
      squeeze_blocked: false,
      suggested_fit_label: null,
      suggested_max_width: null,
      suggested_max_height: null,
      suggested_max_fps: null,
      suggested_mute: false,
      suggested_target_mb: null,
    });
    // Solid JPEG strip frames (1x1 scaled by CSS object-fit) for layout QA.
    const tones = [
      "#1a2330",
      "#203040",
      "#243848",
      "#1c2a38",
      "#2a3c4c",
      "#223446",
      "#1e3040",
      "#263a4a",
      "#1a2836",
      "#2c4050",
      "#203648",
      "#182430",
    ];
    const frames = tones.map((hex) => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return "";
      }
      ctx.fillStyle = hex;
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = "rgba(7,187,254,0.35)";
      ctx.fillRect(0, 70, 160, 20);
      return canvas.toDataURL("image/jpeg", 0.85);
    });
    setFilmstripFrames(frames.filter(Boolean));
    setFilmstripLoading(false);
    const mockSettings: JobSettings = {
      target_size_bytes: 10 * 1024 * 1024,
      mute_audio: false,
      max_width: 1280,
      max_height: 720,
      max_fps: null,
    };
    setJobs([
      {
        id: "mock-1",
        input_path: "C:\\Videos\\example-batch.mp4",
        output_path: null,
        status: "queued",
        error: null,
        progress_percent: 0,
        output_size_bytes: null,
        settings: mockSettings,
        output_mode: "copy_beside",
        trim: { start_seconds: 31, end_seconds: 60 },
        kind: "squeeze",
        output_name: "example-batch",
      },
      {
        id: "mock-2",
        input_path: mockPath,
        output_path: null,
        status: "queued",
        error: null,
        progress_percent: 0,
        output_size_bytes: null,
        settings: mockSettings,
        output_mode: "copy_beside",
        trim: { start_seconds: 42, end_seconds: 54 },
        kind: "squeeze",
        output_name: "example-clip",
      },
    ]);
    if (params.get("fs") === "1") {
      setPreviewExpanded(true);
    }
  }, []);

  useEffect(() => {
    if (scrubDrag) {
      return;
    }
    setStartDraft(formatTimecode(trimStart));
    setEndDraft(formatTimecode(trimEnd));
    setDurationDraft(formatTimecode(Math.max(0, trimEnd - trimStart)));
  }, [trimStart, trimEnd, scrubDrag]);

  useEffect(() => {
    if (!previewExpanded) {
      setChromeVisible(true);
      return;
    }
    if (!playing) {
      setChromeVisible(true);
      window.clearTimeout(chromeTimerRef.current);
      return;
    }
    window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = window.setTimeout(() => {
      setChromeVisible(false);
    }, 1800);
    return () => window.clearTimeout(chromeTimerRef.current);
  }, [playing, previewExpanded, currentTime]);

  useEffect(() => {
    void (async () => {
      try {
        const granted = await isPermissionGranted();
        if (!granted) {
          await requestPermission();
        }
      } catch {
      }
    })();
  }, []);

  // Never leave a finished-only queue without a preview — that dead-end screen is gone.
  useEffect(() => {
    if (media || jobs.length === 0) {
      return;
    }
    const finishedOnly = jobs.every(
      (j) =>
        j.status === "succeeded" ||
        j.status === "failed" ||
        j.status === "cancelled",
    );
    if (!finishedOnly) {
      return;
    }
    setJobs([]);
    setLiveProgress(null);
    void invoke("clear_finished_jobs").catch(() => {});
  }, [media, jobs]);

  useEffect(() => {
    if (!media) {
      setPlanPreview(null);
      return;
    }
    if (
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).get("mock") === "workbench"
    ) {
      return;
    }
    const duration = Math.max(0.1, trimEnd - trimStart);
    const settings = {
      targetSizeBytes: mbToBytes(targetSizeMb),
      muteAudio,
      ...fitLimits(fitPreset, fpsCap),
    };
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke<PlanPreview>("preview_plan", {
        durationSeconds: duration,
        settings,
      })
        .then((plan) => {
          if (!cancelled) {
            setPlanPreview(plan);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setPlanPreview(null);
          }
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [media, trimStart, trimEnd, targetSizeMb, muteAudio, fitPreset, fpsCap]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    function syncWorkbenchFromSize() {
      if (disposed) {
        return;
      }
      setWorkbench(window.innerWidth >= WORKBENCH_MIN_WIDTH);
    }

    syncWorkbenchFromSize();
    window.addEventListener("resize", syncWorkbenchFromSize);

    try {
      const win = getCurrentWindow();

      async function syncWindowChrome() {
        try {
          const isMax = await win.isMaximized();
          let isFs = false;
          try {
            isFs = await win.isFullscreen();
          } catch {
          }
          if (!disposed) {
            setMaximized(isMax || isFs);
          }
        } catch {
        }
        syncWorkbenchFromSize();
      }

      void syncWindowChrome();
      void win.onResized(() => {
        void syncWindowChrome();
      }).then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      });
    } catch {
    }
    return () => {
      disposed = true;
      window.removeEventListener("resize", syncWorkbenchFromSize);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;

    invoke<CompressionJob[]>("list_jobs")
      .then((list) => {
        if (alive) setJobs(list);
      })
      .catch(() => {});

    const unlistenUpdated = listen<CompressionJob[]>("job-updated", (event) => {
      startTransition(() => {
        setJobs(event.payload);
      });
    }).catch(() => undefined);

    let progressFrame = 0;
    let pendingProgress: JobProgress | null = null;

    const unlistenProgress = listen<JobProgress>("job-progress", (event) => {
      pendingProgress = event.payload;
      if (progressFrame !== 0) {
        return;
      }
      progressFrame = requestAnimationFrame(() => {
        progressFrame = 0;
        const payload = pendingProgress;
        pendingProgress = null;
        if (!payload) {
          return;
        }
        setLiveProgress(payload);
        setJobs((prev) =>
          prev.map((job) =>
            job.id === payload.job_id
              ? { ...job, progress_percent: payload.percentage }
              : job,
          ),
        );
      });
    }).catch(() => undefined);

    return () => {
      alive = false;
      if (progressFrame !== 0) {
        cancelAnimationFrame(progressFrame);
      }
      void unlistenUpdated.then((fn) => fn?.());
      void unlistenProgress.then((fn) => fn?.());
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            void handleDroppedPaths(event.payload.paths);
          }
        })
        .then((fn) => {
          if (cancelled) {
            fn();
            return;
          }
          unlisten = fn;
        })
        .catch(() => {});
    } catch {
    }

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const pull = () => {
      void invoke<string[]>("take_pending_open_paths")
        .then((paths) => {
          if (!cancelled && paths.length > 0) {
            void handleDroppedPathsRef.current(paths);
          }
        })
        .catch(() => undefined);
    };

    void listen("open-paths", () => {
      pull();
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
        pull();
      })
      .catch(() => {
        pull();
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function loadPreview(probed: Media) {
    setEditingJobId(null);
    editingJobIdRef.current = null;
    setMedia(probed);
    setTrimStart(0);
    setTrimEnd(probed.duration_seconds);
    setCurrentTime(0);
    setPlaying(false);
    setOutputName(defaultOutputStem(probed.path));
    setPreviewExpanded(false);
    setFilmstripFrames([]);
    setFilmstripLoading(true);
  }

  function applyJobEditorState(job: CompressionJob, probed: Media) {
    setMedia(probed);
    setPlaying(false);
    setPreviewExpanded(false);
    setFilmstripFrames([]);
    setFilmstripLoading(true);

    if (job.status !== "queued" && job.status !== "draft") {
      setEditingJobId(null);
      editingJobIdRef.current = null;
      setTrimStart(0);
      setTrimEnd(probed.duration_seconds);
      setCurrentTime(0);
      setOutputName(defaultOutputStem(probed.path));
      return;
    }

    setEditingJobId(job.id);
    editingJobIdRef.current = job.id;
    const start = job.trim?.start_seconds ?? 0;
    const end = job.trim?.end_seconds ?? probed.duration_seconds;
    setTrimStart(start);
    setTrimEnd(end);
    setCurrentTime(start);
    setOutputName(job.output_name ?? fileStem(job.input_path));
    {
      const mb = Math.min(
        2048,
        Math.max(1, Math.round(job.settings.target_size_bytes / (1024 * 1024))),
      );
      setTargetSizeMb(mb);
      setTargetCustom(!isTargetPreset(mb));
    }
    setMuteAudio(job.settings.mute_audio);
    setReplaceOriginals(job.output_mode === "replace");
    const next = fitFromLimits(
      job.settings.max_width,
      job.settings.max_height,
      job.settings.max_fps,
    );
    setFitPreset(next.fitPreset);
    setFpsCap(next.fpsCap);
  }

  useEffect(() => {
    const isMock =
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).get("mock") === "workbench";
    if (isMock) {
      return;
    }
    if (!media) {
      setFilmstripFrames([]);
      setFilmstripLoading(false);
      return;
    }
    let cancelled = false;
    setFilmstripLoading(true);
    void invoke<{ frames: string[] }>("extract_filmstrip", {
      path: media.path,
      count: 12,
    })
      .then((result) => {
        if (!cancelled) {
          // Backend returns data: URLs (or legacy file paths).
          setFilmstripFrames(
            result.frames.map((frame) =>
              frame.startsWith("data:") ? frame : safeFileSrc(frame),
            ),
          );
          setFilmstripLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFilmstripFrames([]);
          setFilmstripLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [media?.path]);

  function bumpChrome() {
    if (!previewExpanded) {
      return;
    }
    setChromeVisible(true);
    window.clearTimeout(chromeTimerRef.current);
    if (playing) {
      chromeTimerRef.current = window.setTimeout(() => {
        setChromeVisible(false);
      }, 1800);
    }
  }

  async function previewPath(path: string) {
    const probed = await invoke<Media>("probe_media", { path });
    loadPreview(probed);
  }

  async function handleDroppedPaths(paths: string[]) {
    if (paths.length === 0) {
      return;
    }
    // Queue a second open/drop instead of discarding it while a probe is in flight.
    if (ingestingRef.current) {
      pendingOpenPathsRef.current.push(...paths);
      return;
    }

    if (editingJobIdRef.current) {
      try {
        await saveCurrentJobEdits("squeeze");
      } catch {
        // Keep ingesting even if a quiet save fails.
      }
    }

    window.clearTimeout(saveTimerRef.current);
    ingestingRef.current = true;
    setEditingJobId(null);
    editingJobIdRef.current = null;
    setBusy(true);
    setError("");
    let openFirst: CompressionJob | null = null;
    try {
      const result = await invoke<DropIngestResult>("ingest_paths", {
        paths,
        replace: replaceRef.current,
        settings: settingsRef.current,
      });

      const nextJobs = await invoke<CompressionJob[]>("list_jobs");
      setJobs(nextJobs);

      if (result.jobs_added > 0 || result.preview_path) {
        openFirst =
          (result.preview_path
            ? nextJobs.find((j) =>
                sameMediaPath(j.input_path, result.preview_path!),
              )
            : undefined) ??
          nextJobs.find((j) => j.status === "draft") ??
          nextJobs[0] ??
          null;
        if (!openFirst && result.preview_path) {
          await previewPath(result.preview_path);
        }
      }

      if (paths.length > 1 && result.jobs_added < paths.length) {
        const skipped = paths.length - result.jobs_added;
        setError(
          skipped === 1
            ? "one of those videos was already in the queue"
            : `${skipped} of those videos were already in the queue`,
        );
      }
    } catch (err) {
      setError(typeof err === "string" ? err : "drop failed");
    } finally {
      ingestingRef.current = false;
      setBusy(false);
    }
    if (openFirst) {
      await openJobInTrim(openFirst);
    }
    const queued = pendingOpenPathsRef.current.splice(0);
    if (queued.length > 0) {
      await handleDroppedPaths(queued);
    }
  }

  handleDroppedPathsRef.current = handleDroppedPaths;

  async function openJobInTrim(job: CompressionJob) {
    window.clearTimeout(saveTimerRef.current);
    const currentId = editingJobIdRef.current;
    if (currentId && currentId !== job.id) {
      try {
        await saveCurrentJobEdits("squeeze");
      } catch {
        // Prefer opening the next video over blocking on a quiet save.
      }
    }
    setBusy(true);
    setError("");
    try {
      const nextJobs = await invoke<CompressionJob[]>("list_jobs");
      setJobs(nextJobs);
      const target =
        nextJobs.find((j) => j.id === job.id) ??
        nextJobs.find((j) => sameMediaPath(j.input_path, job.input_path)) ??
        job;
      const probed = await invoke<Media>("probe_media", {
        path: target.input_path,
      });
      applyJobEditorState(target, probed);
    } catch (err) {
      setEditingJobId(null);
      editingJobIdRef.current = null;
      setError(typeof err === "string" ? err : "couldnt open that video");
    } finally {
      setBusy(false);
    }
  }

  async function openVideoPicker() {
    setError("");
    let paths: string[] | null;
    try {
      paths = await invoke<string[] | null>("pick_videos");
    } catch (err) {
      setError(
        typeof err === "string"
          ? err
          : "couldnt open the file picker. try dropping a video instead",
      );
      return;
    }

    if (!paths || paths.length === 0) {
      return;
    }

    await handleDroppedPaths(paths);
  }

  async function pickVideos() {
    await openVideoPicker();
  }

  async function pickFolder() {
    setError("");
    let path: string | null;
    try {
      path = await invoke<string | null>("pick_folder");
    } catch (err) {
      setError(
        typeof err === "string"
          ? err
          : "couldnt open the folder picker. try dropping a folder instead",
      );
      return;
    }

    if (!path) {
      return;
    }

    await handleDroppedPaths([path]);
  }

  function currentJobPayload(kind: JobKind) {
    const currentMedia = mediaRef.current;
    const start = trimStartRef.current;
    const end = trimEndRef.current;
    const name = outputNameRef.current.trim();
    const trimmed =
      currentMedia &&
      (start > 0.05 || end < currentMedia.duration_seconds - 0.05)
        ? { start_seconds: start, end_seconds: end }
        : null;
    const originalStem = currentMedia
      ? fileStem(currentMedia.path).replace(/\.dvr$/i, "")
      : "";
    // Only treat a real rename as custom; unchanged stem stays null so
    // the backend can apply its default -squeezed / -trimmed suffix.
    const customName =
      name.length > 0 && name !== originalStem ? name : null;
    return {
      replace: replaceRef.current,
      trim: trimmed,
      kind,
      outputName: customName,
      settings: settingsRef.current,
    };
  }

  async function saveCurrentJobEdits(kind: JobKind = "squeeze") {
    const jobId = editingJobIdRef.current;
    if (!jobId || !mediaRef.current) {
      return null;
    }
    const updated = await invoke<CompressionJob>("update_queued_job", {
      jobId,
      ...currentJobPayload(kind),
    });
    setJobs((prev) =>
      prev.map((job) => (job.id === updated.id ? updated : job)),
    );
    return updated;
  }

  function scheduleSaveCurrentJob() {
    if (!editingJobIdRef.current || !mediaRef.current) {
      return;
    }
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void saveCurrentJobEdits("squeeze").catch(() => undefined);
    }, 350);
  }

  // Keep each draft's trim/name/settings on the job so switching videos restores them.
  useEffect(() => {
    if (!editingJobId || scrubDrag) {
      return;
    }
    scheduleSaveCurrentJob();
    return () => window.clearTimeout(saveTimerRef.current);
  }, [
    editingJobId,
    trimStart,
    trimEnd,
    outputName,
    targetSizeMb,
    muteAudio,
    fitPreset,
    fpsCap,
    replaceOriginals,
    scrubDrag,
  ]);

  async function enqueueCurrent(kind: JobKind) {
    if (!media) {
      return;
    }

    window.clearTimeout(saveTimerRef.current);

    const payload = currentJobPayload(kind);

    if (kind === "trim" && !payload.trim && !muteAudio) {
      setError("Move the trim handles or turn on Mute audio.");
      return;
    }

    if (kind === "squeeze" && !editingJobId && planPreview?.squeeze_blocked) {
      setError(planPreview.message);
      return;
    }

    if (
      kind === "squeeze" &&
      media &&
      (planPreview?.target_size_bytes ?? mbToBytes(targetSizeMb)) >
        media.size_bytes
    ) {
      setError("Target is larger than the source file.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const draftCount = jobsRef.current.filter(
        (j) => j.status === "draft",
      ).length;
      const jobId = editingJobIdRef.current;
      if (jobId) {
        await invoke<CompressionJob>("update_queued_job", {
          jobId,
          ...payload,
        });
        if (kind === "squeeze") {
          // Batch: save current edits, then start every staged video.
          if (draftCount > 0) {
            await invoke<number>("start_all_drafts");
          }
        } else {
          await invoke<boolean>("start_draft", { jobId });
        }
        setEditingJobId(null);
        editingJobIdRef.current = null;
      } else {
        await invoke<CompressionJob>("enqueue_job", {
          path: media.path,
          ...payload,
        });
        if (kind === "squeeze" && draftCount > 0) {
          await invoke<number>("start_all_drafts");
        }
      }
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "failed to queue video");
    } finally {
      setBusy(false);
    }
  }

  function applySuggestedFit() {
    if (!planPreview) {
      return;
    }
    const next = fitFromLimits(
      planPreview.suggested_max_width,
      planPreview.suggested_max_height,
      planPreview.suggested_max_fps,
    );
    setFitPreset(next.fitPreset);
    setFpsCap(next.fpsCap);
  }

  function applySuggestedTarget() {
    if (planPreview?.suggested_target_mb) {
      const mb = planPreview.suggested_target_mb;
      setTargetSizeMb(mb);
      setTargetCustom(!isTargetPreset(mb));
    }
  }

  async function setReplaceOriginalsSafe(next: boolean) {
    if (next && !skipReplaceConfirm) {
      const { ok, dontAskAgain } = await askConfirm(
        "Replace originals permanently overwrites your source files after encoding. Continue?",
        {
          confirmLabel: "Replace",
          danger: true,
          dontAskAgainKey: "replace",
        },
      );
      if (!ok) {
        return;
      }
      if (dontAskAgain) {
        setSkipReplaceConfirm(true);
      }
    }
    setReplaceOriginals(next);
  }

  function commitStartDraft() {
    if (!media) {
      return;
    }
    const parsed = parseTimecode(startDraft, media.duration_seconds);
    if (parsed == null) {
      setStartDraft(formatTimecode(trimStart));
      return;
    }
    onStartChange(parsed);
  }

  function commitEndDraft() {
    if (!media) {
      return;
    }
    const parsed = parseTimecode(endDraft, media.duration_seconds);
    if (parsed == null) {
      setEndDraft(formatTimecode(trimEnd));
      return;
    }
    onEndChange(parsed);
  }

  function commitDurationDraft() {
    if (!media) {
      return;
    }
    const parsed = parseTimecode(durationDraft, media.duration_seconds);
    if (parsed == null) {
      setDurationDraft(formatTimecode(Math.max(0, trimEnd - trimStart)));
      return;
    }
    const nextEnd = Math.min(media.duration_seconds, trimStart + Math.max(0.1, parsed));
    onEndChange(nextEnd);
  }

  async function cancel(jobId: string) {
    try {
      await invoke("cancel_job", { jobId });
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "cancel failed");
    }
  }

  async function retry(jobId: string) {
    try {
      await invoke("retry_job", { jobId });
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "retry failed");
    }
  }

  async function clearFinished() {
    const current = jobsRef.current;
    const allSucceeded =
      current.length > 0 &&
      current.every((job) => job.status === "succeeded");
    if (allSucceeded) {
      const { ok } = await askConfirm(
        "Everything's done. Clear the queue and go back to home?",
        { confirmLabel: "Go home" },
      );
      if (!ok) {
        return;
      }
      await resetToHome();
      return;
    }

    const { ok } = await askConfirm("Clear finished jobs from the queue?", {
      confirmLabel: "Clear",
    });
    if (!ok) {
      return;
    }
    try {
      await invoke("clear_finished_jobs");
      const next = await invoke<CompressionJob[]>("list_jobs");
      setJobs(next);
      setLiveProgress(null);
      if (next.length === 0) {
        dismissPreview();
      }
    } catch (err) {
      setError(typeof err === "string" ? err : "clear failed");
    }
  }

  async function goHome() {
    if (jobsRef.current.length > 0) {
      const { ok } = await askConfirm(
        "Clear the queue and go home? This cancels running jobs.",
        { confirmLabel: "Clear & go home", danger: true },
      );
      if (!ok) {
        return;
      }
      void resetToHome();
      return;
    }
    dismissPreview();
  }

  async function cancelAll() {
    try {
      await invoke("cancel_all_jobs");
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "cancel all failed");
    }
  }

  /** Same confirm as Home whenever anything is still in the queue. */
  async function closePreview() {
    if (jobsRef.current.length > 0) {
      const { ok } = await askConfirm(
        "Clear the queue and go home? This cancels running jobs.",
        { confirmLabel: "Clear & go home", danger: true },
      );
      if (!ok) {
        return;
      }
      void resetToHome();
      return;
    }
    dismissPreview();
  }

  function dismissPreview() {
    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
    }
    setPreviewExpanded(false);
    setPlaying(false);
    setCurrentTime(0);
    setEditingJobId(null);
    editingJobIdRef.current = null;
    setMedia(null);
    setOutputName("");
  }

  async function resetToHome() {
    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
    }
    setPreviewExpanded(false);
    setEditingJobId(null);
    setMedia(null);
    setPlaying(false);
    setCurrentTime(0);
    setOutputName("");
    setError("");
    setLiveProgress(null);
    try {
      if (
        jobsRef.current.some(
          (j) =>
            j.status === "draft" ||
            j.status === "queued" ||
            j.status === "running",
        )
      ) {
        await invoke("cancel_all_jobs");
      }
      await invoke("clear_finished_jobs");
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "couldnt reset");
      setJobs([]);
    }
  }

  useEffect(() => {
    function isTypingTarget(el: EventTarget | null) {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    }

    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (e.code === "Escape") {
        e.preventDefault();
        if (previewExpandedRef.current) {
          setPreviewExpanded(false);
          lastEscRef.current = 0;
          return;
        }
        if (mediaRef.current) {
          const now = performance.now();
          if (now - lastEscRef.current < 500) {
            lastEscRef.current = 0;
            void closePreview();
          } else {
            lastEscRef.current = now;
          }
        }
        return;
      }

      const current = mediaRef.current;
      if (current) {
        const video = videoRef.current;
        const start = trimStartRef.current;
        const end = trimEndRef.current;
        if (e.code === "Space") {
          e.preventDefault();
          if (!video) {
            return;
          }
          if (video.paused) {
            if (video.currentTime < start || video.currentTime >= end) {
              video.currentTime = start;
              setCurrentTime(start);
            }
            void video.play();
            setPlaying(true);
          } else {
            video.pause();
            setPlaying(false);
          }
          return;
        }
        if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
          e.preventDefault();
          nudgePlayback(e.code === "ArrowLeft" ? -1 : 1, e.shiftKey ? 1 : 5);
          return;
        }
        if (e.code === "KeyI") {
          e.preventDefault();
          if (!video) {
            return;
          }
          const next = Math.min(video.currentTime, end - 0.1);
          setTrimStart(Math.max(0, next));
          video.currentTime = Math.max(0, next);
          setCurrentTime(Math.max(0, next));
          return;
        }
        if (e.code === "KeyO") {
          e.preventDefault();
          if (!video) {
            return;
          }
          const next = Math.max(video.currentTime, start + 0.1);
          setTrimEnd(Math.min(current.duration_seconds, next));
          return;
        }
      }

      if (e.code !== "Enter" || busyRef.current || mediaRef.current) {
        return;
      }
      e.preventDefault();
      void openVideoPicker();
    }

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  async function reveal(path: string) {
    try {
      await revealItemInDir(path);
    } catch (err) {
      setError(typeof err === "string" ? err : "couldnt open that in explorer");
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.volume = playbackVolume;
    video.muted = playbackMuted;
  }, [playbackVolume, playbackMuted, media?.path]);

  function nudgePlayback(direction: -1 | 1, stepSeconds = 1) {
    const video = videoRef.current;
    const current = mediaRef.current;
    if (!video || !current) {
      return;
    }
    const next = clamp(
      video.currentTime + direction * stepSeconds,
      0,
      current.duration_seconds,
    );
    video.currentTime = next;
    setCurrentTime(next);
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video || !media) {
      return;
    }
    if (video.paused) {
      if (video.currentTime < trimStart || video.currentTime >= trimEnd) {
        video.currentTime = trimStart;
      }
      void video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  function onTimeUpdate() {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.currentTime >= trimEnd) {
      video.currentTime = trimStart;
      setCurrentTime(trimStart);
      if (!video.paused) {
        void video.play();
        setPlaying(true);
      }
      return;
    }
    setCurrentTime(video.currentTime);
  }

  function seekTo(seconds: number) {
    const video = videoRef.current;
    if (!video || !media) {
      return;
    }
    const next = clamp(seconds, 0, media.duration_seconds);
    video.currentTime = next;
    setCurrentTime(next);
  }

  function onStartChange(value: number) {
    const next = Math.min(value, trimEnd - 0.1);
    setTrimStart(Math.max(0, next));
    seekTo(Math.max(0, next));
  }

  function onEndChange(value: number) {
    const next = Math.max(value, trimStart + 0.1);
    setTrimEnd(
      media ? Math.min(media.duration_seconds, next) : next,
    );
  }

  function timeFromPointer(clientX: number) {
    const el = scrubRef.current;
    if (!el || !media) {
      return 0;
    }
    const rect = el.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * media.duration_seconds;
  }

  function beginScrub(
    kind: Exclude<DragKind, null>,
    event: ReactPointerEvent<HTMLElement>,
  ) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubDrag(kind);
    const t = timeFromPointer(event.clientX);
    if (kind === "start") {
      onStartChange(t);
    } else if (kind === "end") {
      onEndChange(t);
    } else {
      seekTo(t);
    }
  }

  function moveScrub(event: ReactPointerEvent<HTMLElement>) {
    if (!scrubDrag) {
      return;
    }
    const t = timeFromPointer(event.clientX);
    if (scrubDrag === "start") {
      onStartChange(t);
    } else if (scrubDrag === "end") {
      onEndChange(t);
    } else {
      seekTo(t);
    }
  }

  function endScrub(event: ReactPointerEvent<HTMLElement>) {
    if (!scrubDrag) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setScrubDrag(null);
  }

  const previewSrc = media ? safeFileSrc(media.path) : "";
  const duration = media?.duration_seconds ?? 0;
  const startPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const endPct = duration > 0 ? (trimEnd / duration) * 100 : 100;
  const playPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const hasTrim =
    !!media &&
    (trimStart > 0.05 || trimEnd < media.duration_seconds - 0.05);
  const directLabel =
    hasTrim && muteAudio ? "Trim & mute" : hasTrim ? "Trim only" : "Mute only";
  const directButtonLabel = editingJobId
    ? `Update as ${directLabel.toLowerCase()}`
    : directLabel;
  const directTitle = hasTrim
    ? muteAudio
      ? "Cut to the handles and drop the audio. Does not squeeze to a target size."
      : "Cut to the handles. Does not squeeze to a target size."
    : muteAudio
      ? "Drop the audio. Does not squeeze to a target size."
      : "Set a trim range or mute audio first";
  const hasFinished = jobs.some(
    (j) =>
      j.status === "succeeded" ||
      j.status === "failed" ||
      j.status === "cancelled",
  );
  const hasActive = jobs.some(
    (j) =>
      j.status === "draft" ||
      j.status === "queued" ||
      j.status === "running",
  );
  const isHome = !media && jobs.length === 0;
  const keepSeconds = media ? Math.max(0, trimEnd - trimStart) : 0;
  const outputExt = media ? outputExtFor(media.path) : "";
  const estimateBytes = planPreview?.target_size_bytes ?? mbToBytes(targetSizeMb);
  const savingPct =
    media && media.size_bytes > 0
      ? Math.round((1 - estimateBytes / media.size_bytes) * 100)
      : null;
  const estimateLargerThanSource =
    !!media && estimateBytes > media.size_bytes;
  const dragTooltipTime =
    scrubDrag === "start"
      ? trimStart
      : scrubDrag === "end"
        ? trimEnd
        : scrubDrag === "seek"
          ? currentTime
          : null;
  const targetPresetActive = !targetCustom && isTargetPreset(targetSizeMb);
  const mediaJob = !media
    ? undefined
    : jobs.find(
        (job) =>
          sameMediaPath(job.input_path, media.path) &&
          (job.status === "running" ||
            job.status === "queued" ||
            job.status === "draft"),
      ) ??
      jobs.find(
        (job) =>
          sameMediaPath(job.input_path, media.path) &&
          (job.status === "succeeded" || job.status === "failed"),
      );
  const mediaJobProgress =
    mediaJob && liveProgress?.job_id === mediaJob.id ? liveProgress : null;
  // Navigate by job id so path-format mismatches can't reopen the same clip.
  const playlistJobs = (() => {
    const seen = new Set<string>();
    const list: CompressionJob[] = [];
    for (const job of jobs) {
      const key = pathKey(job.input_path);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      list.push(job);
    }
    return list;
  })();
  const playlistIndex = (() => {
    if (editingJobId) {
      const byId = playlistJobs.findIndex((job) => job.id === editingJobId);
      if (byId >= 0) {
        return byId;
      }
    }
    if (!media) {
      return -1;
    }
    return playlistJobs.findIndex((job) =>
      sameMediaPath(job.input_path, media.path),
    );
  })();
  const hasPlaylistNav = playlistJobs.length > 1 && playlistIndex >= 0;

  async function openPlaylistAt(index: number) {
    const job = playlistJobs[index];
    if (!job || busy) {
      return;
    }
    await openJobInTrim(job);
  }

  async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
    try {
      const win = getCurrentWindow();
      if (action === "minimize") {
        await win.minimize();
      } else if (action === "toggleMaximize") {
        await win.toggleMaximize();
        setMaximized(await win.isMaximized());
      } else {
        await win.close();
      }
    } catch {
    }
  }

  return (
    <div
      className={`app-shell${dragging ? " dragging" : ""}${
        isHome ? " is-home" : " is-work"
      }${maximized ? " is-maximized" : ""}${
        workbench ? " is-workbench" : ""
      }${previewExpanded && media ? " is-fullscreen-preview" : ""}`}
    >
      {isHome && <div className="ambiance" aria-hidden="true" />}
      <div className="titlebar" data-tauri-drag-region>
        {!(previewExpanded && media) && (
          <img
            className="titlebar-mark"
            src="/files/icon-fullbleed.svg"
            width={20}
            height={20}
            alt=""
            draggable={false}
            decoding="async"
          />
        )}
      </div>
      <UpdateBanner
        updater={updater}
        jobsRunning={jobs.some((job) => job.status === "running")}
        suppressed={previewExpanded && media != null}
      />
      <div className="window-controls">
        <button
          type="button"
          className="win-btn"
          aria-label="Minimize"
          onClick={() => void windowAction("minimize")}
        >
          <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true">
            <path
              d="M2.5 6h7"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="win-btn"
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => void windowAction("toggleMaximize")}
        >
          {maximized ? (
            <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true">
              <path
                d="M3.5 4.5h5v5h-5zM4.5 3.5h5v5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true">
              <rect
                x="2.75"
                y="2.75"
                width="6.5"
                height="6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                rx="0.4"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="win-btn win-close"
          aria-label="Close"
          onClick={() => void windowAction("close")}
        >
          <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true">
            <path
              d="M3 3l6 6M9 3L3 9"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <main className={`container${isHome ? " is-home" : ""}`}>
        {isHome ? (
          <section className="home" aria-label="Start">
            <div className="home-brand">
              <img
                className="home-mark"
                src="/files/icon-fullbleed.svg"
                width={40}
                height={40}
                alt=""
                draggable={false}
                decoding="async"
              />
              <h1 className="home-wordmark">Squeeze</h1>
            </div>

            {error && (
              <div className="error-banner" role="alert">
                <p>{error}</p>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setError("")}
                  aria-label="Dismiss error"
                >
                  Dismiss
                </button>
              </div>
            )}

            <button
              type="button"
              className="empty"
              onClick={() => void pickVideos()}
              disabled={busy}
            >
              <span className="empty-title">Drop videos</span>
              <span className="empty-copy">or browse files</span>
              <span className="empty-keys">
                <kbd>Enter</kbd>
              </span>
            </button>

            <button
              type="button"
              className="ghost home-folder"
              onClick={() => void pickFolder()}
              disabled={busy}
            >
              <svg
                className="home-folder-icon"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
              >
                <path
                  fill="currentColor"
                  d="M3.5 6.75A2.25 2.25 0 0 1 5.75 4.5h3.1c.4 0 .78.16 1.06.44l1.15 1.15c.28.28.66.44 1.06.44h6.13A2.25 2.25 0 0 1 20.5 8.78v8.47a2.25 2.25 0 0 1-2.25 2.25H5.75A2.25 2.25 0 0 1 3.5 17.25V6.75Z"
                />
              </svg>
              Add a folder instead
            </button>
          </section>
        ) : (
          <>
            {error && (
              <div className="error-banner" role="alert">
                <p>{error}</p>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setError("")}
                  aria-label="Dismiss error"
                >
                  Dismiss
                </button>
              </div>
            )}
          </>
        )}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop to add</span>
        </div>
      )}

      {media && (
        <section
          className={`preview${previewExpanded ? " is-expanded" : ""}`}
          aria-label="Preview and trim"
        >
          {previewExpanded && (
            <button
              type="button"
              className="preview-back"
              onClick={() => setPreviewExpanded(false)}
              title="Exit fullscreen (Esc)"
              aria-label="Exit fullscreen preview"
            >
              <IconBack />
            </button>
          )}

          <div
            className="preview-workbench"
            onMouseMove={bumpChrome}
            onPointerDown={bumpChrome}
          >
            <div className="preview-main">
              <div className="preview-stage">
                <video
                  ref={videoRef}
                  key={media.path}
                  src={previewSrc}
                  className="preview-video"
                  onTimeUpdate={onTimeUpdate}
                  onPause={() => setPlaying(false)}
                  onPlay={() => setPlaying(true)}
                  onClick={togglePlay}
                />
              </div>

              <div
                className={`timeline-panel${
                  previewExpanded ? " is-cinema" : ""
                }${previewExpanded && !chromeVisible ? " is-hidden" : ""}`}
              >
                <div className="scrub-row">
                  <span className="scrub-time scrub-time-now" aria-live="off">
                    {formatTimecode(currentTime)}
                  </span>
                  <div
                    className={`scrub${scrubDrag ? " scrub-active" : ""}`}
                    ref={scrubRef}
                    onPointerDown={(e) => {
                      if (
                        (e.target as HTMLElement).dataset.handle === "start" ||
                        (e.target as HTMLElement).dataset.handle === "end"
                      ) {
                        return;
                      }
                      beginScrub("seek", e);
                    }}
                    onPointerMove={moveScrub}
                    onPointerUp={endScrub}
                    onPointerCancel={endScrub}
                    role="slider"
                    aria-label="Timeline"
                    aria-valuemin={0}
                    aria-valuemax={media.duration_seconds}
                    aria-valuenow={currentTime}
                    aria-valuetext={formatTimecode(currentTime)}
                    tabIndex={0}
                  >
                    <div className="scrub-track" aria-hidden="true" />
                    <div
                      className="scrub-dim left"
                      style={{ width: `${startPct}%` }}
                    />
                    <div
                      className="scrub-dim right"
                      style={{ width: `${Math.max(0, 100 - endPct)}%` }}
                    />
                    <div
                      className="scrub-range"
                      style={{
                        left: `${startPct}%`,
                        width: `${Math.max(0, endPct - startPct)}%`,
                      }}
                    />
                    <div
                      className="scrub-playhead"
                      style={{ left: `${playPct}%` }}
                    />
                    <button
                      type="button"
                      className="scrub-handle start"
                      data-handle="start"
                      aria-label="Trim start"
                      style={{ left: `${startPct}%` }}
                      onPointerDown={(e) => beginScrub("start", e)}
                      onPointerMove={moveScrub}
                      onPointerUp={endScrub}
                      onPointerCancel={endScrub}
                    />
                    <button
                      type="button"
                      className="scrub-handle end"
                      data-handle="end"
                      aria-label="Trim end"
                      style={{ left: `${endPct}%` }}
                      onPointerDown={(e) => beginScrub("end", e)}
                      onPointerMove={moveScrub}
                      onPointerUp={endScrub}
                      onPointerCancel={endScrub}
                    />
                    {dragTooltipTime != null && (
                      <div
                        className="scrub-tooltip"
                        style={{
                          left: `${
                            scrubDrag === "start"
                              ? startPct
                              : scrubDrag === "end"
                                ? endPct
                                : playPct
                          }%`,
                        }}
                      >
                        {formatTimecode(dragTooltipTime)}
                      </div>
                    )}
                  </div>
                  <span className="scrub-time scrub-time-end">
                    {formatDuration(media.duration_seconds)}
                  </span>
                </div>

                <div className="transport-row">
                  <div className="transport-side transport-side-left" />
                  <div className="transport-center">
                    {hasPlaylistNav && (
                      <button
                        type="button"
                        className="transport-icon-btn"
                        onClick={() =>
                          void openPlaylistAt(
                            (playlistIndex - 1 + playlistJobs.length) %
                              playlistJobs.length,
                          )
                        }
                        disabled={busy}
                        aria-label="Previous video"
                        title="Previous video"
                      >
                        <IconPrevVideo />
                      </button>
                    )}
                    <button
                      type="button"
                      className="transport-icon-btn transport-skip"
                      onClick={() => nudgePlayback(-1, 5)}
                      aria-label="Skip back 5 seconds"
                      title="Back 5 seconds"
                    >
                      <IconSkipBack />
                    </button>
                    <button
                      type="button"
                      className="transport-btn"
                      onClick={togglePlay}
                      aria-label={playing ? "Pause" : "Play"}
                    >
                      {playing ? <IconPause /> : <IconPlay />}
                    </button>
                    <button
                      type="button"
                      className="transport-icon-btn transport-skip"
                      onClick={() => nudgePlayback(1, 5)}
                      aria-label="Skip forward 5 seconds"
                      title="Forward 5 seconds"
                    >
                      <IconSkipForward />
                    </button>
                    {hasPlaylistNav && (
                      <button
                        type="button"
                        className="transport-icon-btn"
                        onClick={() =>
                          void openPlaylistAt(
                            (playlistIndex + 1) % playlistJobs.length,
                          )
                        }
                        disabled={busy}
                        aria-label="Next video"
                        title="Next video"
                      >
                        <IconNextVideo />
                      </button>
                    )}
                  </div>
                  <div className="transport-side transport-side-right">
                    <div className="volume-control">
                      <button
                        type="button"
                        className="transport-icon-btn"
                        onClick={() => setPlaybackMuted((m) => !m)}
                        aria-label={playbackMuted || playbackVolume === 0 ? "Unmute" : "Mute"}
                        title={playbackMuted || playbackVolume === 0 ? "Unmute" : "Mute"}
                      >
                        {playbackMuted || playbackVolume === 0 ? (
                          <IconVolumeMuted />
                        ) : (
                          <IconVolume />
                        )}
                      </button>
                      <input
                        type="range"
                        className="volume-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={playbackMuted ? 0 : playbackVolume}
                        style={
                          {
                            "--vol": `${(playbackMuted ? 0 : playbackVolume) * 100}%`,
                          } as CSSProperties
                        }
                        onChange={(e) => {
                          const next = Number(e.target.value);
                          setPlaybackVolume(next);
                          setPlaybackMuted(next === 0);
                        }}
                        aria-label="Volume"
                      />
                    </div>
                    <button
                      type="button"
                      className="transport-icon-btn"
                      onClick={() => setPreviewExpanded((v) => !v)}
                      aria-label={
                        previewExpanded
                          ? "Exit fullscreen preview"
                          : "Open fullscreen preview"
                      }
                      title={previewExpanded ? "Exit fullscreen (Esc)" : "Fullscreen"}
                    >
                      {previewExpanded ? <IconCollapse /> : <IconExpand />}
                    </button>
                  </div>
                </div>

                {previewExpanded && (
                  <div className="row cinema-actions">
                    {estimateLargerThanSource ? (
                      <div
                        className="action-primary action-blocked"
                        role="status"
                        aria-disabled="true"
                      >
                        <span className="action-primary-label">
                          Target larger than source
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void enqueueCurrent("squeeze")}
                        disabled={
                          busy ||
                          (!editingJobId && !!planPreview?.squeeze_blocked)
                        }
                      >
                        {editingJobId && mediaJob?.status === "queued"
                          ? "Update queue"
                          : jobs.filter((j) => j.status === "draft").length > 1
                            ? "Compress all"
                            : "Compress"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void enqueueCurrent("trim")}
                      disabled={busy || (!hasTrim && !muteAudio)}
                      title={directTitle}
                    >
                      {directButtonLabel}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {!previewExpanded && (
              <aside className="preview-sidebar" aria-label="Export settings">
                <div className="sidebar-top">
                  <button
                    type="button"
                    className="icon-btn ghost"
                    onClick={() => void closePreview()}
                    disabled={busy}
                    aria-label="Close preview"
                    title="Close preview"
                  >
                    <IconClose />
                  </button>
                </div>
                <div className="sidebar-scroll">
                <section className="sidebar-block">
                  <label className="rename-field">
                    <span className="control-label" id="output-label">
                      Output filename
                    </span>
                    <div className="filename-input">
                      <input
                        type="text"
                        value={outputName}
                        onChange={(e) => setOutputName(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        aria-labelledby="output-label"
                      />
                      {outputExt && (
                        <span className="filename-ext" title={outputExt}>
                          {outputExt}
                        </span>
                      )}
                    </div>
                  </label>
                </section>

                <section className="sidebar-block">
                  <div className="controls-grid">
                    <div className="control-section">
                      <span className="control-label" id="resolution-label">
                        Resolution
                      </span>
                      <div
                        className="segment"
                        role="radiogroup"
                        aria-labelledby="resolution-label"
                      >
                        {(
                          [
                            ["original", "Original"],
                            ["1080p", "1080p"],
                            ["720p", "720p"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            className={`segment-item${fitPreset === value ? " is-selected" : ""}`}
                            aria-checked={fitPreset === value}
                            onClick={() => setFitPreset(value)}
                            disabled={busy}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="control-section">
                      <span className="control-label" id="framerate-label">
                        Framerate
                      </span>
                      <div
                        className="segment"
                        role="radiogroup"
                        aria-labelledby="framerate-label"
                      >
                        {(
                          [
                            ["unlimited", "Full"],
                            ["60", "60"],
                            ["30", "30"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            className={`segment-item${fpsCap === value ? " is-selected" : ""}`}
                            aria-checked={fpsCap === value}
                            onClick={() => setFpsCap(value)}
                            disabled={busy}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="control-section">
                    <span className="control-label" id="target-label">
                      Target size
                    </span>
                    <div
                      className="segment target-segment"
                      role="radiogroup"
                      aria-labelledby="target-label"
                    >
                      {TARGET_PRESETS.map((mb) => (
                        <button
                          key={mb}
                          type="button"
                          role="radio"
                          className={`segment-item${targetPresetActive && targetSizeMb === mb ? " is-selected" : ""}`}
                          aria-checked={targetPresetActive && targetSizeMb === mb}
                          onClick={() => {
                            setTargetCustom(false);
                            setTargetSizeMb(mb);
                          }}
                          disabled={busy}
                        >
                          {mb} MB
                        </button>
                      ))}
                      <button
                        type="button"
                        role="radio"
                        className={`segment-item${targetCustom ? " is-selected" : ""}`}
                        aria-checked={targetCustom}
                        onClick={() => setTargetCustom(true)}
                        disabled={busy}
                      >
                        Custom
                      </button>
                    </div>
                    {targetCustom && (
                      <label className="target-custom">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={2048}
                          step={1}
                          value={targetSizeMb}
                          onChange={(e) => {
                            const next = Number(e.target.value);
                            if (!Number.isFinite(next)) {
                              return;
                            }
                            setTargetSizeMb(
                              Math.min(2048, Math.max(1, Math.round(next))),
                            );
                          }}
                          disabled={busy}
                          aria-label="Custom target size in megabytes"
                        />
                        <span>MB</span>
                      </label>
                    )}
                  </div>
                </section>

                <section className="sidebar-block">
                  <span className="control-label">Options</span>
                  <div className="option-toggles" role="group">
                    <label className="replace-check">
                      <input
                        type="checkbox"
                        checked={replaceOriginals}
                        onChange={(e) =>
                          void setReplaceOriginalsSafe(e.target.checked)
                        }
                      />
                      Replace originals
                    </label>
                    <label className="replace-check">
                      <input
                        type="checkbox"
                        checked={muteAudio}
                        onChange={(e) => setMuteAudio(e.target.checked)}
                      />
                      Mute audio
                    </label>
                  </div>
                  <p
                    className={`replace-hint${replaceOriginals ? "" : " is-hidden"}`}
                    role="status"
                    aria-hidden={!replaceOriginals}
                  >
                    Source files will be overwritten after a successful encode.
                  </p>
                </section>

                {(planPreview?.squeeze_blocked ||
                  planPreview?.suggested_fit_label ||
                  planPreview?.suggested_mute ||
                  planPreview?.suggested_target_mb != null) && (
                  <div
                    className={`plan-alert${planPreview.squeeze_blocked ? " is-blocked" : " is-warn"}`}
                    role="alert"
                  >
                    <p>
                      {planPreview.squeeze_blocked
                        ? "This target is too small for the selected length, resolution, and framerate."
                        : "Quality settings may struggle to hit this target."}
                    </p>
                    <div className="plan-levers">
                      {planPreview.suggested_mute && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => setMuteAudio(true)}
                        >
                          Mute audio
                        </button>
                      )}
                      {planPreview.suggested_target_mb != null && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={applySuggestedTarget}
                        >
                          Use {planPreview.suggested_target_mb} MB
                        </button>
                      )}
                      {planPreview.suggested_fit_label && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={applySuggestedFit}
                        >
                          Try {planPreview.suggested_fit_label}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {mediaJob && mediaJob.status === "running" && (
                  <div className="job-status-inline" role="status">
                    <div className="job-status-top">
                      <span className="status-chip is-encoding">
                        Encoding {Math.round(mediaJob.progress_percent)}%
                      </span>
                      {mediaJobProgress && (
                        <span className="job-status-eta">
                          {formatEta(
                            mediaJobProgress.elapsed_seconds,
                            mediaJobProgress.percentage,
                          ) ?? ""}
                        </span>
                      )}
                    </div>
                    <div
                      className="bar"
                      role="progressbar"
                      aria-valuenow={Math.round(mediaJob.progress_percent)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="bar-fill"
                        style={{
                          transform: `scaleX(${Math.min(100, Math.max(0, mediaJob.progress_percent)) / 100})`,
                        }}
                      />
                    </div>
                  </div>
                )}
                </div>

                <div className="export-actions">
                  <div
                    className={`estimate-summary${
                      planPreview?.squeeze_blocked || estimateLargerThanSource
                        ? " is-blocked"
                        : ""
                    }`}
                    role="status"
                  >
                    <p className="estimate-line-primary">
                      <span>{formatSize(media.size_bytes)}</span>
                      <span className="estimate-arrow" aria-hidden="true">
                        →
                      </span>
                      <span>{formatSize(estimateBytes)}</span>
                      {savingPct != null && (
                        <span
                          className={`estimate-delta${
                            savingPct < 0 ? " is-worse" : ""
                          }`}
                        >
                          {savingPct >= 0
                            ? `−${savingPct}%`
                            : `+${Math.abs(savingPct)}%`}
                        </span>
                      )}
                    </p>
                    <p className="estimate-line-secondary">
                      {resolutionShortLabel(media.height, media.width)} →{" "}
                      {targetResolutionLabel(fitPreset, media)} ·{" "}
                      {formatDuration(keepSeconds)}
                    </p>
                  </div>
                  <div className="export-primary-row">
                    {estimateLargerThanSource ? (
                      <div
                        className="action-primary action-blocked"
                        role="status"
                        aria-disabled="true"
                        title="Lower the target size below the source file to compress"
                      >
                        <span className="action-primary-label">
                          Target larger than source
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={`primary action-primary${
                          mediaJob?.status === "running" ? " is-busy" : ""
                        }`}
                        onClick={() => void enqueueCurrent("squeeze")}
                        disabled={
                          busy ||
                          (!editingJobId && !!planPreview?.squeeze_blocked)
                        }
                        title={
                          editingJobId
                            ? "Update this queued job"
                            : planPreview?.squeeze_blocked
                              ? "Choose a larger target or lower quality"
                              : "Re-encode to the target size (exact trim)"
                        }
                      >
                        <span className="action-primary-label">
                          {planPreview?.squeeze_blocked && !editingJobId
                            ? "Target too small"
                            : mediaJob?.status === "running"
                              ? `Encoding ${Math.round(mediaJob.progress_percent)}%`
                              : editingJobId && mediaJob?.status === "queued"
                                ? "Update queue"
                                : jobs.filter((j) => j.status === "draft")
                                      .length > 1
                                  ? "Compress all"
                                  : "Compress"}
                        </span>
                        {mediaJob?.status === "running" && (
                          <span
                            className="action-progress"
                            style={{
                              transform: `scaleX(${Math.min(100, Math.max(0, mediaJob.progress_percent)) / 100})`,
                            }}
                          />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost action-secondary"
                      onClick={() => void enqueueCurrent("trim")}
                      disabled={busy || (!hasTrim && !muteAudio)}
                      title={directTitle}
                    >
                      {directButtonLabel}
                    </button>
                  </div>
                </div>
              </aside>
            )}
          </div>
        </section>
      )}

      {jobs.length > 0 && (
        <section className="queue" aria-label="Compression queue">
          <div className="queue-header">
            <div className="row queue-toolbar">
              <button
                type="button"
                className="ghost"
                onClick={() => void pickVideos()}
                disabled={busy}
              >
                Add videos
              </button>
              {hasActive && (
                <button
                  type="button"
                  className="ghost danger-ghost"
                  onClick={cancelAll}
                >
                  Cancel all
                </button>
              )}
              {hasFinished && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void clearFinished()}
                >
                  Clear finished
                </button>
              )}
            </div>
            <div className="queue-heading">
              <button
                type="button"
                className="icon-btn ghost"
                onClick={() => void goHome()}
                disabled={busy}
                aria-label="Clear queue and go home"
                title="Clear queue and go home"
              >
                <IconBack />
              </button>
              <h2>
                Queue <span className="queue-count">({jobs.length})</span>
              </h2>
            </div>
          </div>
          <ul>
            {jobs.map((job) => {
              const progress =
                liveProgress?.job_id === job.id ? liveProgress : null;
              const eta =
                progress && job.status === "running"
                  ? formatEta(progress.elapsed_seconds, progress.percentage)
                  : null;
              const displayName = jobDisplayName(job);
              const metaLine = queueMetaSummary(job);
              const chipLabel =
                job.skipped && job.status === "succeeded"
                  ? "Skipped"
                  : job.status === "running"
                    ? `Encoding ${Math.round(job.progress_percent)}%`
                    : statusLabel(job.status);
              return (
                <li key={job.id} className={`queue-item status-${job.status}`}>
                  <div className="queue-top">
                    <button
                      type="button"
                      className="queue-title"
                      onClick={() => void openJobInTrim(job)}
                      disabled={busy}
                      title={displayName}
                    >
                      {displayName}
                    </button>
                    <div className="queue-top-actions">
                      <span
                        className={`status-chip status-chip-${job.status}${
                          job.skipped && job.status === "succeeded"
                            ? " is-skipped"
                            : ""
                        }`}
                      >
                        {chipLabel}
                      </span>
                      {(job.status === "draft" ||
                        job.status === "queued" ||
                        job.status === "running") && (
                        <button
                          type="button"
                          className="icon-btn ghost queue-remove"
                          onClick={() => cancel(job.id)}
                          aria-label={
                            job.status === "draft"
                              ? "Remove from queue"
                              : "Cancel job"
                          }
                          title={job.status === "draft" ? "Remove" : "Cancel"}
                        >
                          <IconClose />
                        </button>
                      )}
                    </div>
                  </div>
                  {metaLine ? (
                    <p className="queue-meta-line">{metaLine}</p>
                  ) : null}
                  {job.status === "running" && (
                    <div
                      className="bar"
                      role="progressbar"
                      aria-valuenow={Math.round(job.progress_percent)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="bar-fill"
                        style={{
                          transform: `scaleX(${Math.min(100, Math.max(0, job.progress_percent)) / 100})`,
                        }}
                      />
                    </div>
                  )}
                  {(progress || eta || job.error || job.note) && (
                    <div className="queue-meta-extra">
                      {progress && job.status === "running" && (
                        <span>
                          {formatDuration(progress.elapsed_seconds)} /{" "}
                          {formatDuration(progress.duration_seconds)}
                        </span>
                      )}
                      {eta && <span>{eta}</span>}
                      {job.error && (
                        <span
                          className={
                            job.error.includes("after retry")
                              ? "error size-over"
                              : "error"
                          }
                        >
                          {job.error}
                        </span>
                      )}
                      {job.note && <span className="job-note">{job.note}</span>}
                    </div>
                  )}
                  {(job.status === "failed" ||
                    job.status === "cancelled" ||
                    (job.output_path && job.status === "succeeded")) && (
                    <div className="row queue-actions">
                      {(job.status === "failed" ||
                        job.status === "cancelled") && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => retry(job.id)}
                        >
                          Retry
                        </button>
                      )}
                      {job.output_path && job.status === "succeeded" && (
                        <>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => reveal(job.output_path!)}
                          >
                            {job.skipped ? "Show original" : "Show in Explorer"}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(job.output_path!)
                                .catch(() => {
                                  setError("couldnt copy path");
                                });
                            }}
                          >
                            Copy path
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>

      {confirmDialog && (
        <div
          className="confirm-backdrop"
          role="presentation"
          onClick={() => closeConfirm(false)}
        >
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <p id="confirm-title" className="confirm-message">
              {confirmDialog.message}
            </p>
            {confirmDialog.dontAskAgainKey && (
              <label className="confirm-option">
                <input
                  type="checkbox"
                  checked={confirmDontAskAgain}
                  onChange={(e) => setConfirmDontAskAgain(e.target.checked)}
                />
                Don&apos;t ask me again
              </label>
            )}
            <div className="confirm-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => closeConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={confirmDialog.danger ? "danger" : "primary"}
                onClick={() => closeConfirm(true)}
                autoFocus
              >
                {confirmDialog.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
