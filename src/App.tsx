import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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

  function loadPreview(probed: Media) {
    setMedia(probed);
    setTrimStart(0);
    setTrimEnd(probed.duration_seconds);
    setCurrentTime(0);
    setPlaying(false);
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
    if (paths.length === 0) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      if (paths.length === 1) {
        // one file: preview + trim first, user hits add to queue
        const probed = await invoke<Media>("probe_media", { path: paths[0] });
        loadPreview(probed);
      } else {
        for (const path of paths) {
          await invoke<CompressionJob>("enqueue_job", {
            path,
            replace: replaceOriginals,
            trim: null,
          });
        }
        const probed = await invoke<Media>("probe_media", {
          path: paths[paths.length - 1],
        });
        loadPreview(probed);
        setJobs(await invoke<CompressionJob[]>("list_jobs"));
      }
    } catch (err) {
      setError(typeof err === "string" ? err : "failed to add jobs");
    } finally {
      setBusy(false);
    }
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

    setBusy(true);
    setError("");
    try {
      const added = await invoke<CompressionJob[]>("enqueue_folder", {
        path,
        recursive,
        replace: replaceOriginals,
      });
      if (added.length > 0) {
        const probed = await invoke<Media>("probe_media", {
          path: added[added.length - 1].input_path,
        });
        loadPreview(probed);
      }
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "failed to add folder");
    } finally {
      setBusy(false);
    }
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

  return (
    <main className="container">
      <h1>Squeeze</h1>
      <p>Queue videos, trim if you want, then compress for Discord.</p>

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

      {error && <p className="error">{error}</p>}

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
            <div className="row">
              <button type="button" onClick={togglePlay}>
                {playing ? "Pause" : "Play"}
              </button>
              <span>
                {formatDuration(currentTime)} / {formatDuration(media.duration_seconds)}
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
              Keep {formatDuration(trimEnd - trimStart)} · {formatSize(media.size_bytes)} ·{" "}
              {media.width ?? "?"}×{media.height ?? "?"}
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
          <h2>Queue ({jobs.length})</h2>
          <ul>
            {jobs.map((job) => (
              <li key={job.id} className="queue-item">
                <div className="queue-top">
                  <strong>{fileName(job.input_path)}</strong>
                  <span className="status">
                    {job.status}
                    {job.output_mode === "replace" ? " · replace" : " · copy"}
                    {job.trim ? " · trim" : ""}
                  </span>
                </div>
                {job.status === "running" && (
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
                  {(job.status === "failed" || job.status === "cancelled") && (
                    <button type="button" onClick={() => retry(job.id)}>
                      Retry
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

export default App;
