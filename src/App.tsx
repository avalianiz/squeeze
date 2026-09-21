import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

function formatSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function App() {
  const [path, setPath] = useState("");
  const [media, setMedia] = useState<Media | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function probe() {
    setBusy(true);
    setError("");
    setMedia(null);
    try {
      const result = await invoke<Media>("probe_media", { path });
      setMedia(result);
    } catch (err) {
      setError(typeof err === "string" ? err : "probe failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <h1>Squeeze</h1>
      <p>Paste a video path and probe it with ffprobe.</p>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          probe();
        }}
      >
        <input
          id="greet-input"
          value={path}
          onChange={(e) => setPath(e.currentTarget.value)}
          placeholder="C:\Videos\clip.mp4"
        />
        <button type="submit" disabled={busy || !path.trim()}>
          {busy ? "Probing..." : "Probe"}
        </button>
      </form>

      {error && <p>{error}</p>}

      {media && (
        <ul>
          <li>
            {media.width ?? "?"}×{media.height ?? "?"}
          </li>
          <li>{media.duration_seconds.toFixed(2)}s</li>
          <li>{formatSize(media.size_bytes)}</li>
          <li>video: {media.video_codec ?? "none"}</li>
          <li>audio: {media.audio_codec ?? "none"}</li>
          <li>
            fps: {media.frame_rate != null ? media.frame_rate.toFixed(2) : "?"}
          </li>
        </ul>
      )}
    </main>
  );
}

export default App;
