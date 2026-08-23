import { useEffect, useMemo, useRef, useState } from "react";

function dashboardUrl(resumeSessionId) {
  const params = new URLSearchParams();
  if (resumeSessionId) params.set("resume", resumeSessionId);
  const query = params.toString();
  return `/hermes/chat${query ? `?${query}` : ""}`;
}

export default function HermesDashboard({ resumeSessionId, onStatusChange }) {
  const shellRef = useRef(null);
  const [frameKey, setFrameKey] = useState(0);
  const [loadedFrame, setLoadedFrame] = useState("");
  const [failure, setFailure] = useState(null);
  const [dashboardScale, setDashboardScale] = useState(1);
  const src = useMemo(() => dashboardUrl(resumeSessionId), [resumeSessionId]);
  const frameId = `${src}:${frameKey}`;
  const error = failure?.frameId === frameId ? failure.message : "";
  const loading = loadedFrame !== frameId && !error;

  useEffect(() => {
    const controller = new AbortController();
    onStatusChange?.("connecting");

    fetch("/hermes/api/status", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Hermes 상태 확인 실패 (${response.status})`);
        onStatusChange?.("online");
      })
      .catch((requestError) => {
        if (requestError.name === "AbortError") return;
        setFailure({
          frameId,
          message: requestError.message || "Hermes Dashboard에 연결할 수 없습니다.",
        });
        onStatusChange?.("error");
      });

    return () => controller.abort();
  }, [frameId, onStatusChange]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const fitDashboard = () => {
      const { width, height } = shell.getBoundingClientRect();
      const nextScale = width < 900
        ? 1
        : Math.min(1, Math.max(0.74, height / 920));
      setDashboardScale((current) => (
        Math.abs(current - nextScale) < 0.005 ? current : nextScale
      ));
    };
    const observer = new ResizeObserver(fitDashboard);
    observer.observe(shell);
    fitDashboard();
    return () => observer.disconnect();
  }, []);

  const reload = () => {
    setFrameKey((value) => value + 1);
  };

  return (
    <section ref={shellRef} className="hermes-dashboard-shell" aria-label="Hermes 공식 운영 대시보드">
      {loading && !error && (
        <div className="hermes-dashboard-loading" role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>Hermes Dashboard를 불러오는 중입니다.</span>
        </div>
      )}
      {error && (
        <div className="hermes-dashboard-error" role="alert">
          <strong>대시보드를 열지 못했습니다.</strong>
          <span>{error}</span>
          <button type="button" onClick={reload}>다시 불러오기</button>
        </div>
      )}
      <iframe
        key={frameId}
        className="hermes-dashboard-frame"
        src={src}
        title="Hermes Agent Dashboard"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="same-origin"
        style={dashboardScale < 1 ? {
          width: `${100 / dashboardScale}%`,
          height: `${100 / dashboardScale}%`,
          transform: `scale(${dashboardScale})`,
          transformOrigin: "top left",
        } : undefined}
        onLoad={() => {
          setLoadedFrame(frameId);
          setFailure(null);
          onStatusChange?.("online");
        }}
      />
    </section>
  );
}
