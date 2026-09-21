import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

type CompressionJob = {
  id: string;
  input_path: string;
  output_path: string | null;
  status: JobStatus;
  error: string | null;
  progress_percent: number;
  output_size_bytes: number | null;
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
  const total = Math.floor(seconds);
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
  const [media, setMedia] = useState<Media | null>(null);
  const [jobs, setJobs] = useState<CompressionJob[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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

  async function pickAndProbe() {
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
      // show metadata for the last picked one, queue gets all of them
      const probed = await invoke<Media>("probe_media", {
        path: paths[paths.length - 1],
      });
      setMedia(probed);

      for (const path of paths) {
        await invoke<CompressionJob>("enqueue_job", { path });
      }
      setJobs(await invoke<CompressionJob[]>("list_jobs"));
    } catch (err) {
      setError(typeof err === "string" ? err : "failed to add jobs");
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

  return (
    <main className="container">
      <h1>Squeeze</h1>
      <p>Queue videos and compress them one at a time for Discord.</p>

      <div className="row">
        <button type="button" onClick={pickAndProbe} disabled={busy}>
          {busy ? "Adding..." : "Add videos"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {media && (
        <div className="meta">
          <p className="meta-name">Last picked: {fileName(media.path)}</p>
          <dl>
            <dt>Resolution</dt>
            <dd>
              {media.width ?? "?"}×{media.height ?? "?"}
            </dd>
            <dt>Duration</dt>
            <dd>
              {formatDuration(media.duration_seconds)} (
              {media.duration_seconds.toFixed(2)}s)
            </dd>
            <dt>Size</dt>
            <dd>{formatSize(media.size_bytes)}</dd>
          </dl>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="queue">
          <h2>Queue</h2>
          <ul>
            {jobs.map((job) => (
              <li key={job.id} className="queue-item">
                <div className="queue-top">
                  <strong>{fileName(job.input_path)}</strong>
                  <span className="status">{job.status}</span>
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
