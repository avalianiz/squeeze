import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [jobs, setJobs] = useState<CompressionJob[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recursive, setRecursive] = useState(true);
  const [replaceOriginals, setReplaceOriginals] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [liveProgress, setLiveProgress] = useState<JobProgress | null>(null);

  const replaceRef = useRef(replaceOriginals);
  const recursiveRef = useRef(recursive);
  const busyRef = useRef(busy);
  const mediaRef = useRef(media);
  const trimStartRef = useRef(trimStart);
  const trimEndRef = useRef(trimEnd);
  replaceRef.current = replaceOriginals;
  recursiveRef.current = recursive;
  busyRef.current = busy;
  mediaRef.current = media;
  trimStartRef.current = trimStart;
  trimEndRef.current = trimEnd;

  useEffect(() => {
    let alive = true;

    invoke<CompressionJob[]>("list_jobs")
      .then((list) => {
        if (alive) setJobs(list);
      })
      .catch(() => {});

    const unlistenUpdated = listen<CompressionJob[]>("job-updated", (event) => {
      setJobs(event.payload);
    });

    const unlistenProgress = listen<JobProgress>("job-progress", (event) => {
      setLiveProgress(event.payload);
      setJobs((prev) =>
        prev.map((job) =>
          job.id === event.payload.job_id
            ? { ...job, progress_percent: event.payload.percentage }
            : job,
        ),
      );
    });

    return () => {
      alive = false;
      unlistenUpdated.then((fn) => fn());
      unlistenProgress.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

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
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }

      if (e.key === "Escape") {
        setError("");
        return;
      }

      const currentMedia = mediaRef.current;
      if (e.key === " " && currentMedia) {
        e.preventDefault();
        const video = videoRef.current;
        if (!video) {
          return;
        }
        const start = trimStartRef.current;
        const end = trimEndRef.current;
        if (video.paused) {
          if (video.currentTime < start || video.currentTime >= end) {
            video.currentTime = start;
          }
          void video.play();
          setPlaying(true);
        } else {
          video.pause();
          setPlaying(false);
        }
        return;
      }

      if (e.key === "Enter" && currentMedia && !busyRef.current) {
        e.preventDefault();
        void (async () => {
          setBusy(true);
          setError("");
          try {
            const start = trimStartRef.current;
            const end = trimEndRef.current;
            const trim =
              start > 0.05 || end < currentMedia.duration_seconds - 0.05
                ? { start_seconds: start, end_seconds: end }
                : null;
            await invoke<CompressionJob>("enqueue_job", {
              path: currentMedia.path,
              replace: replaceRef.current,
              trim,
            });
            setJobs(await invoke<CompressionJob[]>("list_jobs"));
          } catch (err) {
            setError(typeof err === "string" ? err : "failed to queue video");
          } finally {
            setBusy(false);
          }
        })();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function loadPreview(probed: Media) {
    setMedia(probed);
    setTrimStart(0);
    setTrimEnd(probed.duration_seconds);
    setCurrentTime(0);
    setPlaying(false);
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

  async function pickVideos() {
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

  async function addCurrentToQueue() {
    if (!media) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      const trim =
        trimStart > 0.05 || trimEnd < media.duration_seconds - 0.05
          ? { start_seconds: trimStart, end_seconds: trimEnd }
          : null;

      await invoke<CompressionJob>("enqueue_job", {
        path: media.path,
        replace: replaceOriginals,
        trim,
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
    if (!video) {
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
    if (!video) {
      return;
    }
    video.currentTime = seconds;
    setCurrentTime(seconds);
  }

  function onStartChange(value: number) {
    const next = Math.min(value, trimEnd - 0.1);
    setTrimStart(next);
    seekTo(next);
  }

  function onEndChange(value: number) {
    const next = Math.max(value, trimStart + 0.1);
    setTrimEnd(next);
  }

  const previewSrc = media ? convertFileSrc(media.path) : "";
  const hasFinished = jobs.some(
    (j) =>
      j.status === "succeeded" ||
      j.status === "failed" ||
      j.status === "cancelled",
  );
  const hasActive = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );

  return (
    <main className={`container${dragging ? " dragging" : ""}`}>
      <header className="hero">
        <h1>Squeeze</h1>
        <p className="tagline">
          Compress videos under Discord&apos;s 20&nbsp;MB limit. Local only.
        </p>
      </header>

      <div className="options">
        <label>
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
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

      <div className="row">
        <button type="button" onClick={pickVideos} disabled={busy}>
          {busy ? "Working..." : "Add videos"}
        </button>
        <button type="button" onClick={pickFolder} disabled={busy}>
          {busy ? "Working..." : "Add folder"}
        </button>
      </div>

      {!media && jobs.length === 0 && (
        <div className="empty" role="status">
          <p className="empty-title">Drop videos here</p>
          <p className="empty-copy">
            Or use the buttons above. One file opens the trimmer; folders go
            straight into the queue.
          </p>
          <p className="empty-keys">
            Shortcuts: Space play/pause · Enter add to queue · Esc dismiss error
          </p>
        </div>
      )}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop to add
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {media && (
        <div className="preview">
          <p className="meta-name">{fileName(media.path)}</p>
          <video
            ref={videoRef}
            key={media.path}
            src={previewSrc}
            className="preview-video"
            onTimeUpdate={onTimeUpdate}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
          />

          <div className="trim-controls">
            <div className="row play-row">
              <button type="button" onClick={togglePlay}>
                {playing ? "Pause" : "Play"}
              </button>
              <span>
                {formatDuration(currentTime)} /{" "}
                {formatDuration(media.duration_seconds)}
              </span>
            </div>

            <label className="trim-label">
              Start {formatDuration(trimStart)}
              <input
                type="range"
                min={0}
                max={media.duration_seconds}
                step={0.05}
                value={trimStart}
                onChange={(e) => onStartChange(Number(e.target.value))}
              />
            </label>

            <label className="trim-label">
              End {formatDuration(trimEnd)}
              <input
                type="range"
                min={0}
                max={media.duration_seconds}
                step={0.05}
                value={trimEnd}
                onChange={(e) => onEndChange(Number(e.target.value))}
              />
            </label>

            <p className="trim-summary">
              Keep {formatDuration(trimEnd - trimStart)} ·{" "}
              {formatSize(media.size_bytes)} · {media.width ?? "?"}×
              {media.height ?? "?"}
            </p>

            <div className="row">
              <button type="button" onClick={addCurrentToQueue} disabled={busy}>
                Add to queue
              </button>
            </div>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="queue">
          <div className="queue-header">
            <h2>Queue ({jobs.length})</h2>
            <div className="row queue-toolbar">
              {hasActive && (
                <button type="button" onClick={cancelAll}>
                  Cancel all
                </button>
              )}
              {hasFinished && (
                <button type="button" onClick={clearFinished}>
                  Clear finished
                </button>
              )}
            </div>
          </div>
          <ul>
            {jobs.map((job) => {
              const progress =
                liveProgress?.job_id === job.id ? liveProgress : null;
              return (
                <li key={job.id} className={`queue-item status-${job.status}`}>
                  <div className="queue-top">
                    <strong>{fileName(job.input_path)}</strong>
                    <span className="status">
                      {statusLabel(job.status)}
                      {job.output_mode === "replace" ? " · replace" : " · copy"}
                      {job.trim ? " · trim" : ""}
                    </span>
                  </div>
                  {(job.status === "running" || progress) && (
                    <div className="bar">
                      <div
                        className="bar-fill"
                        style={{ width: `${job.progress_percent}%` }}
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
                      <button type="button" onClick={() => cancel(job.id)}>
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
        </div>
      )}
    </main>
  );
}

export default App;
