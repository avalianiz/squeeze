import { useEffect, useRef, useState, startTransition, type PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

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

type CompressionJob = {
  id: string;
  input_path: string;
  output_path: string | null;
  status: JobStatus;
  error: string | null;
  progress_percent: number;
  output_size_bytes: number | null;
  output_mode: OutputMode;
  trim: TrimRange | null;
  kind: JobKind;
  output_name: string | null;
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
  folder_roots: string[];
};

const VIDEO_FILTERS = [
  {
    name: "Video",
    extensions: ["mp4", "mkv", "mov", "webm", "avi", "m4v", "wmv", "flv"],
  },
];

function formatSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
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

function statusLabel(status: JobStatus) {
  switch (status) {
    case "queued":
      return "waiting";
    case "running":
      return "encoding";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
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

type DragKind = "start" | "end" | "seek" | null;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [jobs, setJobs] = useState<CompressionJob[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recursive, setRecursive] = useState(false);
  const [replaceOriginals, setReplaceOriginals] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [liveProgress, setLiveProgress] = useState<JobProgress | null>(null);
  const [scrubDrag, setScrubDrag] = useState<DragKind>(null);
  const [outputName, setOutputName] = useState("");
  const [maximized, setMaximized] = useState(false);
  const [folderRoots, setFolderRoots] = useState<string[]>([]);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const scrubRef = useRef<HTMLDivElement | null>(null);

  const replaceRef = useRef(replaceOriginals);
  const recursiveRef = useRef(recursive);
  const busyRef = useRef(busy);
  const mediaRef = useRef(media);
  const folderRootsRef = useRef(folderRoots);
  replaceRef.current = replaceOriginals;
  recursiveRef.current = recursive;
  busyRef.current = busy;
  mediaRef.current = media;
  folderRootsRef.current = folderRoots;

  useEffect(() => {
    const win = getCurrentWindow();
    void win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      void win.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      void unlisten.then((fn) => fn());
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
        .catch(() => {
          // Browser preview / non-Tauri shell — drag-drop stays unavailable.
        });
    } catch {
      // getCurrentWebview throws outside the Tauri runtime.
    }

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function loadPreview(probed: Media) {
    setMedia(probed);
    setTrimStart(0);
    setTrimEnd(probed.duration_seconds);
    setCurrentTime(0);
    setPlaying(false);
    setOutputName(fileStem(probed.path));
    setPreviewExpanded(false);
  }

  async function previewPath(path: string) {
    const probed = await invoke<Media>("probe_media", { path });
    loadPreview(probed);
  }

  async function handleDroppedPaths(paths: string[]) {
    if (paths.length === 0 || busyRef.current) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      const result = await invoke<DropIngestResult>("ingest_paths", {
        paths,
        recursive: recursiveRef.current,
        replace: replaceRef.current,
      });

      if (result.folder_roots.length > 0) {
        setFolderRoots((prev) => {
          const next = new Set(prev);
          for (const root of result.folder_roots) {
            next.add(root);
          }
          return [...next];
        });
        // folder batch: queue only — never open the trim player
        if (result.jobs_added > 0) {
          setJobs(await invoke<CompressionJob[]>("list_jobs"));
        }
        return;
      }

      if (result.preview_path) {
        await previewPath(result.preview_path);
      }
      if (result.jobs_added > 0) {
        setJobs(await invoke<CompressionJob[]>("list_jobs"));
      }
    } catch (err) {
      setError(typeof err === "string" ? err : "drop failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRecursiveChange(next: boolean) {
    setRecursive(next);
    recursiveRef.current = next;
    if (!next || folderRootsRef.current.length === 0 || busyRef.current) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      const result = await invoke<DropIngestResult>("ingest_paths", {
        paths: folderRootsRef.current,
        recursive: true,
        replace: replaceRef.current,
      });
      if (result.jobs_added > 0) {
        setJobs(await invoke<CompressionJob[]>("list_jobs"));
      } else {
        const list = await invoke<CompressionJob[]>("list_jobs");
        setJobs(list);
        if (list.length === 0) {
          setError("no videos found in those subfolders either");
        }
      }
    } catch (err) {
      setError(typeof err === "string" ? err : "couldnt add subfolder videos");
    } finally {
      setBusy(false);
    }
  }

  async function openJobInTrim(path: string) {
    setBusy(true);
    setError("");
    try {
      await previewPath(path);
    } catch (err) {
      setError(typeof err === "string" ? err : "couldnt open that video");
    } finally {
      setBusy(false);
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
      if (e.code === "Escape" && previewExpanded) {
        e.preventDefault();
        setPreviewExpanded(false);
        return;
      }
      if (e.code !== "Enter" || busyRef.current || mediaRef.current) {
        return;
      }
      e.preventDefault();
      void openVideoPicker();
    }

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [previewExpanded]);

  async function openVideoPicker() {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Pick videos",
      filters: VIDEO_FILTERS,
    });

    if (selected === null) {
      return;
    }

    const paths = Array.isArray(selected) ? selected : [selected];
    await handleDroppedPaths(paths);
  }

  async function pickVideos() {
    await openVideoPicker();
  }

  async function pickFolder() {
    const selected = await open({
      multiple: false,
      directory: true,
      title: "Pick a folder of videos",
    });

    if (selected === null) {
      return;
    }

    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) {
      return;
    }

    await handleDroppedPaths([path]);
  }

  async function enqueueCurrent(kind: JobKind) {
    if (!media) {
      return;
    }

    const trimmed =
      trimStart > 0.05 || trimEnd < media.duration_seconds - 0.05
        ? { start_seconds: trimStart, end_seconds: trimEnd }
        : null;

    if (kind === "trim" && !trimmed) {
      setError("Move the trim handles before trimming.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const name = outputName.trim();
      await invoke<CompressionJob>("enqueue_job", {
        path: media.path,
        replace: replaceOriginals,
        trim: trimmed,
        kind,
        outputName: name.length > 0 ? name : null,
      });
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "failed to queue video");
    } finally {
      setBusy(false);
    }
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
    try {
      await invoke("clear_finished_jobs");
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
      setLiveProgress(null);
    } catch (err) {
      setError(typeof err === "string" ? err : "clear failed");
    }
  }

  async function cancelAll() {
    try {
      await invoke("cancel_all_jobs");
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "cancel all failed");
    }
  }

  async function reveal(path: string) {
    try {
      await revealItemInDir(path);
    } catch (err) {
      setError(typeof err === "string" ? err : "couldnt open that in explorer");
    }
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
    setCurrentTime(video.currentTime);
    if (video.currentTime >= trimEnd) {
      video.pause();
      video.currentTime = trimEnd;
      setPlaying(false);
    }
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

  const previewSrc = media ? convertFileSrc(media.path) : "";
  const duration = media?.duration_seconds ?? 0;
  const startPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const endPct = duration > 0 ? (trimEnd / duration) * 100 : 100;
  const playPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const hasTrim =
    !!media &&
    (trimStart > 0.05 || trimEnd < media.duration_seconds - 0.05);
  const hasFinished = jobs.some(
    (j) =>
      j.status === "succeeded" ||
      j.status === "failed" ||
      j.status === "cancelled",
  );
  const hasActive = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );
  const isHome = !media && jobs.length === 0 && folderRoots.length === 0;
  const folderPending =
    folderRoots.length > 0 && !media && jobs.length === 0;

  async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
    const win = getCurrentWindow();
    try {
      if (action === "minimize") {
        await win.minimize();
      } else if (action === "toggleMaximize") {
        await win.toggleMaximize();
        setMaximized(await win.isMaximized());
      } else {
        await win.close();
      }
    } catch {
      // ignore — outside Tauri shell
    }
  }

  return (
    <div
      className={`app-shell${dragging ? " dragging" : ""}${
        isHome ? " is-home" : " is-work"
      }`}
    >
      {isHome && <div className="ambiance" aria-hidden="true" />}
      <div className="titlebar" data-tauri-drag-region>
        <img
          className="titlebar-mark"
          src="/files/icon-fullbleed.svg"
          width={20}
          height={20}
          alt=""
          draggable={false}
          decoding="async"
        />
      </div>
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
            <section className="toolbar" aria-label="Import">
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  onClick={pickVideos}
                  disabled={busy}
                >
                  {busy ? "Working…" : "Add videos"}
                </button>
                <button type="button" onClick={pickFolder} disabled={busy}>
                  {busy ? "Working…" : "Add folder"}
                </button>
              </div>

              <div className="options">
                <label>
                  <input
                    type="checkbox"
                    checked={recursive}
                    onChange={(e) => void onRecursiveChange(e.target.checked)}
                  />
                  Include subfolders
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={replaceOriginals}
                    onChange={(e) => setReplaceOriginals(e.target.checked)}
                  />
                  Replace originals (safe)
                </label>
              </div>
            </section>

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

            {folderPending && (
              <div className="folder-hint" role="status">
                <p>
                  No videos in that folder yet. Turn on{" "}
                  <strong>Include subfolders</strong> to look deeper.
                </p>
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
          <div className="preview-top">
            <label className="rename-field">
              <span>Output name</span>
              <input
                type="text"
                value={outputName}
                onChange={(e) => setOutputName(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              className="ghost preview-expand-btn"
              onClick={() => setPreviewExpanded((v) => !v)}
              aria-pressed={previewExpanded}
              title={
                previewExpanded
                  ? "Exit large preview (Esc)"
                  : "Open large preview"
              }
            >
              {previewExpanded ? "Exit large view" : "Large view"}
            </button>
          </div>

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

          <div className="trim-controls">
            <div className="transport">
              <button
                type="button"
                className="transport-btn"
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? <IconPause /> : <IconPlay />}
              </button>
              <span className="time-readout" aria-live="off">
                {formatDuration(currentTime)}
                <span className="time-sep">/</span>
                {formatDuration(media.duration_seconds)}
              </span>
            </div>

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
              aria-valuetext={formatDuration(currentTime)}
              tabIndex={0}
            >
              <div className="scrub-track" />
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
            </div>

            <div className="scrub-times">
              <span>
                Start <strong>{formatDuration(trimStart)}</strong>
              </span>
              <span>
                Duration <strong>{formatDuration(trimEnd - trimStart)}</strong>
              </span>
              <span>
                End <strong>{formatDuration(trimEnd)}</strong>
              </span>
            </div>

            <p className="trim-summary">
              Keep {formatDuration(trimEnd - trimStart)} ·{" "}
              {formatSize(media.size_bytes)} · {media.width ?? "?"}×
              {media.height ?? "?"}
              {hasTrim ? " · trim on" : ""}
            </p>

            <div className="row trim-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void enqueueCurrent("squeeze")}
                disabled={busy}
              >
                Squeeze
              </button>
              <button
                type="button"
                onClick={() => void enqueueCurrent("trim")}
                disabled={busy || !hasTrim}
                title={
                  hasTrim
                    ? "Cut the selected range without compressing"
                    : "Move the trim handles first"
                }
              >
                Trim only
              </button>
              <button
                type="button"
                className="ghost trim-close"
                onClick={() => {
                  setPreviewExpanded(false);
                  setMedia(null);
                  setPlaying(false);
                }}
                disabled={busy}
              >
                Close preview
              </button>
            </div>
          </div>
        </section>
      )}

      {jobs.length > 0 && (
        <section className="queue" aria-label="Compression queue">
          <div className="queue-header">
            <h2>
              Queue <span className="queue-count">({jobs.length})</span>
            </h2>
            <div className="row queue-toolbar">
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
                <button type="button" className="ghost" onClick={clearFinished}>
                  Clear finished
                </button>
              )}
            </div>
          </div>
          <ul>
            {jobs.map((job) => {
              const progress =
                liveProgress?.job_id === job.id ? liveProgress : null;
              const flags = [
                job.kind === "trim" ? "trim" : "squeeze",
                job.output_mode === "replace" ? "replace" : "copy beside",
                job.trim ? "range set" : null,
                job.output_name ? `as ${job.output_name}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={job.id} className={`queue-item status-${job.status}`}>
                  <div className="queue-top">
                    <div>
                      <button
                        type="button"
                        className="queue-open"
                        onClick={() => void openJobInTrim(job.input_path)}
                        disabled={busy}
                        title="Open in trim preview"
                      >
                        {fileName(job.input_path)}
                      </button>
                      {flags && <div className="job-flags">{flags}</div>}
                    </div>
                    <span className="status">{statusLabel(job.status)}</span>
                  </div>
                  {(job.status === "running" || progress) && (
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
                  <div className="queue-meta">
                    {job.status === "running" && (
                      <span>{job.progress_percent.toFixed(0)}%</span>
                    )}
                    {progress && (
                      <span>
                        {formatDuration(progress.elapsed_seconds)} /{" "}
                        {formatDuration(progress.duration_seconds)}
                      </span>
                    )}
                    {job.trim && (
                      <span>
                        {formatDuration(job.trim.start_seconds)}–
                        {formatDuration(job.trim.end_seconds)}
                      </span>
                    )}
                    {job.output_size_bytes != null && (
                      <span>{formatSize(job.output_size_bytes)}</span>
                    )}
                    {job.output_path && (
                      <span>{fileName(job.output_path)}</span>
                    )}
                    {job.error && <span className="error">{job.error}</span>}
                  </div>
                  <div className="row queue-actions">
                    {(job.status === "queued" || job.status === "running") && (
                      <button
                        type="button"
                        className="ghost danger-ghost"
                        onClick={() => cancel(job.id)}
                      >
                        Cancel
                      </button>
                    )}
                    {(job.status === "failed" ||
                      job.status === "cancelled") && (
                      <button type="button" onClick={() => retry(job.id)}>
                        Retry
                      </button>
                    )}
                    {job.output_path && job.status === "succeeded" && (
                      <button
                        type="button"
                        onClick={() => reveal(job.output_path!)}
                      >
                        Show in Explorer
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
    </div>
  );
}

export default App;
