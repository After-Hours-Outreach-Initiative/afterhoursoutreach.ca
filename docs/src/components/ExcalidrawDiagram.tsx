import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");
type Scene = Awaited<ReturnType<ExcalidrawModule["loadFromBlob"]>>;
type Theme = "light" | "dark";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string;
  }
}

export default function ExcalidrawDiagram({
  src,
  title,
  description,
  caption,
}: {
  src: string;
  title: string;
  description: string;
  caption?: string;
}) {
  const [library, setLibrary] = useState<ExcalidrawModule | null>(null);
  const [original, setOriginal] = useState<Scene | null>(null);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<Theme>("light");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [revision, setRevision] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedScene = useRef<Scene | null>(null);
  const filename = src.split("/").pop()!;
  const saveEndpoint = `/__docs/diagrams/${encodeURIComponent(filename)}`;
  const descriptionId = useId();

  useEffect(() => {
    return () => {
      if (copyTimeout.current !== null) clearTimeout(copyTimeout.current);
    };
  }, []);

  useEffect(() => {
    const updateTheme = () => {
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
    };
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setError(null);

    async function load() {
      // Set this before importing Excalidraw so its fonts never need a CDN.
      window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";
      const [module, response] = await Promise.all([
        import("@excalidraw/excalidraw"),
        fetch(import.meta.env.DEV ? saveEndpoint : src, {
          signal: controller.signal,
          cache: "no-store",
        }),
        import("@excalidraw/excalidraw/index.css"),
      ]);
      if (!response.ok) throw new Error("Diagram source could not be loaded.");
      const scene = await module.loadFromBlob(
        await response.blob(),
        null,
        null,
      );
      if (cancelled) return;
      savedScene.current = scene;
      setOriginal(scene);
      setLibrary(module);
      setRevision(response.headers.get("ETag"));
    }

    load().catch(() => {
      if (!cancelled) setError("Could not load this diagram. Try again.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [src, saveEndpoint, attempt]);

  // Keep the initial scene stable so saving does not remount or reset the editor.
  const initialData = useMemo(
    () =>
      original
        ? {
            ...structuredClone(original),
            scrollToContent: true,
          }
        : null,
    [original],
  );

  useEffect(() => {
    if (!editor) return;
    const frame = requestAnimationFrame(() => {
      editor.scrollToContent(undefined, {
        fitToViewport: true,
        viewportZoomFactor: 0.75,
        animate: false,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [editor]);

  function fit() {
    editor?.scrollToContent(undefined, {
      fitToViewport: true,
      viewportZoomFactor: 0.75,
      animate: false,
    });
  }

  function reset() {
    const scene = savedScene.current;
    if (!editor || !library || !scene || saving) return;
    clearSaveFeedback();
    editor.addFiles(Object.values(scene.files));
    editor.updateScene({
      elements: structuredClone(scene.elements),
      appState: {
        selectedElementIds: {},
        selectedGroupIds: {},
        viewBackgroundColor: scene.appState.viewBackgroundColor,
      },
      // Reset itself can be undone using the editor's normal undo command.
      captureUpdate: library.CaptureUpdateAction.IMMEDIATELY,
    });
    fit();
    setNotice("Restored the last saved diagram. Undo can restore your edits.");
  }

  function clearSaveFeedback() {
    if (saving) return;
    setSaveMessage("");
    setSaveFailed(false);
  }

  async function copyFilename() {
    if (copyTimeout.current !== null) clearTimeout(copyTimeout.current);
    try {
      await navigator.clipboard.writeText(filename);
      setCopyState("copied");
      setNotice(`Copied ${filename} to the clipboard.`);
    } catch {
      setCopyState("failed");
      setNotice(
        "Could not copy the filename. Check your browser's clipboard permissions.",
      );
    }
    copyTimeout.current = setTimeout(() => setCopyState("idle"), 2000);
  }

  async function save() {
    if (!import.meta.env.DEV || !editor || !library || !revision || saving)
      return;
    setSaving(true);
    setSaveFailed(false);
    setSaveMessage("");
    setNotice("");
    try {
      const contents = library.serializeAsJSON(
        editor.getSceneElements(),
        editor.getAppState(),
        editor.getFiles(),
        "local",
      );
      const snapshot = await library.loadFromBlob(
        new Blob([contents], { type: "application/json" }),
        null,
        null,
      );
      const response = await fetch(saveEndpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": revision },
        body: contents,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          result?.error || "Could not save this diagram. Try again.",
        );
      const nextRevision = response.headers.get("ETag");
      if (!nextRevision)
        throw new Error(
          "The docs server did not confirm the saved file version.",
        );
      savedScene.current = snapshot;
      setRevision(nextRevision);
      setSaveMessage(`Saved ${filename}`);
    } catch (error) {
      setSaveFailed(true);
      setSaveMessage(
        error instanceof Error
          ? error.message
          : "Could not save this diagram. Your edits are still on the canvas.",
      );
    } finally {
      setSaving(false);
    }
  }

  const Excalidraw = library?.Excalidraw;
  const MainMenu = library?.MainMenu;

  return (
    <figure
      className="diagram not-content"
      aria-label={title}
      aria-describedby={descriptionId}
    >
      <p id={descriptionId} className="sr-only">
        {description}
      </p>
      <div
        className="diagram-controls"
        role="group"
        aria-label={`${title} controls`}
      >
        <button
          type="button"
          className="diagram-filename"
          onClick={copyFilename}
          aria-label={`Copy filename ${filename}`}
          title="Copy filename"
        >
          <span className="diagram-filename-label">{filename}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            {copyState === "copied" ? (
              <path d="m5 12 4 4L19 6" />
            ) : (
              <>
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </>
            )}
          </svg>
          {copyState !== "idle" && (
            <span className="diagram-copy-feedback">
              {copyState === "copied" ? "Copied" : "Copy failed"}
            </span>
          )}
        </button>
        <span
          className="diagram-save-feedback"
          role="status"
          data-error={saveFailed}
        >
          {saveMessage}
        </span>
        <button type="button" disabled={!editor || saving} onClick={fit}>
          Fit diagram
        </button>
        <button type="button" disabled={!editor || saving} onClick={reset}>
          Reset to saved
        </button>
        {import.meta.env.DEV && (
          <button
            type="button"
            disabled={!editor || !revision || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <div
        className="diagram-canvas"
        role="group"
        aria-label={`${title} canvas`}
        aria-busy={saving || (!original && !error)}
        onPointerDownCapture={clearSaveFeedback}
        onKeyDownCapture={clearSaveFeedback}
      >
        {Excalidraw && MainMenu && original ? (
          <Excalidraw
            initialData={initialData}
            excalidrawAPI={setEditor}
            name={filename.replace(/\.excalidraw$/, "")}
            theme={theme}
            viewModeEnabled={saving}
            handleKeyboardGlobally={false}
            autoFocus={false}
            aiEnabled={false}
            validateEmbeddable={false}
          >
            <MainMenu>
              <MainMenu.DefaultItems.LoadScene />
              <MainMenu.DefaultItems.ClearCanvas />
            </MainMenu>
          </Excalidraw>
        ) : error ? (
          <p role="alert">
            {error}{" "}
            <button type="button" onClick={() => setAttempt(attempt + 1)}>
              Retry
            </button>
          </p>
        ) : (
          <p role="status">Loading diagram…</p>
        )}
      </div>
      <p className="sr-only" role="status">
        {notice}
      </p>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
