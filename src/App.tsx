import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

type CompressResult = {
  output_path: string;
  output_size_bytes: number;
  skipped: boolean;
};

const VIDEO_FILTERS = [
  {
    name: "Video",
    extensions: ["mp4", "mkv", "mov", "webm", "avi", "m4v", "wmv", "flv"],
  },
];

function formatSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
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
  const [result, setResult] = useState<CompressResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function pickAndProbe() {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Pick a video",
      filters: VIDEO_FILTERS,
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
    setMedia(null);
    setResult(null);
    try {
      const probed = await invoke<Media>("probe_media", { path });
      setMedia(probed);
    } catch (err) {
      setError(typeof err === "string" ? err : "probe failed");
    } finally {
      setBusy(false);
    }
  }

  async function compress() {
    if (!media) {
      return;
    }

    setBusy(true);
    setError("");
    setResult(null);
    try {
      const compressed = await invoke<CompressResult>("compress_media", {
        path: media.path,
      });
      setResult(compressed);
    } catch (err) {
      setError(typeof err === "string" ? err : "compress failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <h1>Squeeze</h1>
      <p>Pick a video, then squeeze it under Discord's 20 MB limit.</p>

      <div className="row">
        <button type="button" onClick={pickAndProbe} disabled={busy}>
          {busy && !media ? "Probing..." : "Choose video"}
        </button>
        <button
          type="button"
          onClick={compress}
          disabled={busy || !media}
        >
          {busy && media ? "Compressing..." : "Compress for Discord"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {media && (
        <div className="meta">
          <p className="meta-name">{fileName(media.path)}</p>
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
            <dt>Video</dt>
            <dd>{media.video_codec ?? "none"}</dd>
            <dt>Audio</dt>
            <dd>{media.audio_codec ?? "none"}</dd>
            <dt>FPS</dt>
            <dd>
              {media.frame_rate != null ? media.frame_rate.toFixed(2) : "?"}
            </dd>
          </dl>
        </div>
      )}

      {result && (
        <div className="meta">
          <p className="meta-name">
            {result.skipped
              ? "Already under target — no encode needed"
              : "Compressed"}
          </p>
          <dl>
            <dt>Output</dt>
            <dd>{fileName(result.output_path)}</dd>
            <dt>Size</dt>
            <dd>{formatSize(result.output_size_bytes)}</dd>
          </dl>
        </div>
      )}
    </main>
  );
}

export default App;
