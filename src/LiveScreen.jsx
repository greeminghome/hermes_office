import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { LIVE_ACTIVITY_KEY, LIVE_CHANNEL, liveViewerUrl, readLiveActivity } from "./liveScreenState.js";
import { liveScreenStreamKey, subscribeLiveScreenStream } from "./liveScreenHub.js";
import { TEAM_META } from "./officeData.js";
import { loadLiveScreen } from "./hermes.js";
import { useModalFocus } from "./useModalFocus.js";
import {
  clampRelayText,
  LIVE_SCREEN_CANONICAL_VIEWPORT,
  liveScreenAspectRatio,
  liveScreenBlocksFrame,
  liveScreenConnectionIdentity,
  liveTicketExpired,
  relayPoint,
  relayReconnectDelay,
} from "./liveScreenUi.js";

function formatViewTime(value) {
  if (!value) return "방금";
  return new Intl.DateTimeFormat("ko", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function socketUrl(path) {
  const url = new URL(path, window.location.origin);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function base64JpegBlob(data) {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}

function ChromeRelay({ view, title, profileName, sessionId, fixedAspectRatio = 0 }) {
  const instructionsId = useId();
  const canvasRef = useRef(null);
  const inputRef = useRef(null);
  const socketRef = useRef(null);
  const controlSocketRef = useRef(null);
  const callIdRef = useRef(1);
  const controlCallIdRef = useRef(1);
  const pageSessionIdRef = useRef("");
  const controlSessionIdRef = useRef("");
  const attachCallIdRef = useRef(0);
  const controlAttachCallIdRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const frameSequenceRef = useRef(0);
  const lastViewportRef = useRef("");
  const remoteViewportRef = useRef({ width: 1600, height: 900 });
  const touchPointsRef = useRef(new Map());
  const lastPointerMoveAtRef = useRef(0);
  const wheelFrameRef = useRef(0);
  const pendingWheelRef = useRef(null);
  const statusRef = useRef("connecting");
  const latestViewRef = useRef(view);
  const hubRef = useRef(null);
  const mountedRef = useRef(true);
  const decodeInFlightRef = useRef(false);
  const pendingFrameBlobRef = useRef(null);
  const [status, setStatus] = useState("connecting");
  const [hasFrame, setHasFrame] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [isProducer, setIsProducer] = useState(false);
  const [producerEpoch, setProducerEpoch] = useState(0);
  const [controlState, setControlState] = useState({ owned: false, busy: false, expiresAt: 0 });
  const connectionIdentity = liveScreenConnectionIdentity(view, profileName, sessionId);
  const streamKey = liveScreenStreamKey(profileName, sessionId, view);
  const [receivedFrameAspect, setReceivedFrameAspect] = useState({ identity: "", ratio: 0 });
  const frameAspectRatio = fixedAspectRatio
    ? liveScreenAspectRatio(fixedAspectRatio)
    : receivedFrameAspect.identity === connectionIdentity
      ? receivedFrameAspect.ratio
      : liveScreenAspectRatio(view?.aspectRatio);

  useEffect(() => {
    latestViewRef.current = view;
  }, [view]);

  const applyStatus = useCallback((next) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const updateStatus = useCallback((next) => {
    applyStatus(next);
    hubRef.current?.publishStatus(next);
  }, [applyStatus]);

  const send = useCallback((method, params = {}) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const message = { id: callIdRef.current++, method, params };
    if (pageSessionIdRef.current && !method.startsWith("Target.")) {
      message.sessionId = pageSessionIdRef.current;
    }
    socket.send(JSON.stringify(message));
    return message.id;
  }, []);

  const sendControlLocal = useCallback((method, params = {}) => {
    const socket = controlSocketRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !controlSessionIdRef.current) return send(method, params);
    const message = { id: controlCallIdRef.current++, method, params, sessionId: controlSessionIdRef.current };
    socket.send(JSON.stringify(message));
    return message.id;
  }, [send]);

  const sendControl = useCallback((method, params = {}) => (
    hubRef.current?.sendControl(method, params)
  ), []);

  const startScreencast = useCallback((viewport) => {
    send("Page.startScreencast", {
      format: "jpeg",
      quality: 45,
      maxWidth: Math.min(720, Math.round(viewport.width * viewport.deviceScaleFactor)),
      maxHeight: Math.min(405, Math.round(viewport.height * viewport.deviceScaleFactor)),
      everyNthFrame: 1,
      transport: "binary",
    });
  }, [send]);

  const syncViewport = useCallback((restart = false) => {
    if (!pageSessionIdRef.current) return;
    const viewport = LIVE_SCREEN_CANONICAL_VIEWPORT;
    const signature = `${viewport.width}:${viewport.height}:${viewport.deviceScaleFactor}`;
    if (!restart && signature === lastViewportRef.current) return;
    lastViewportRef.current = signature;
    remoteViewportRef.current = viewport;
    send("Emulation.setDeviceMetricsOverride", viewport);
    if (restart) send("Page.stopScreencast");
    startScreencast(viewport);
  }, [send, startScreencast]);

  const clearFrame = useCallback(() => {
    setHasFrame(false);
    lastFrameAtRef.current = 0;
    frameSequenceRef.current += 1;
    pendingFrameBlobRef.current = null;
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const drawLatestFrame = useCallback(async () => {
    if (!mountedRef.current || decodeInFlightRef.current || !pendingFrameBlobRef.current) return;
    decodeInFlightRef.current = true;
    try {
      while (mountedRef.current && pendingFrameBlobRef.current) {
        const blob = pendingFrameBlobRef.current;
        pendingFrameBlobRef.current = null;
        const frameSequence = frameSequenceRef.current;
        let bitmap;
        try {
          bitmap = await window.createImageBitmap(blob);
          if (!mountedRef.current || frameSequence !== frameSequenceRef.current) continue;
          const canvas = canvasRef.current;
          if (!canvas) continue;
          const nextAspectRatio = liveScreenAspectRatio(bitmap.width / bitmap.height);
          setReceivedFrameAspect((current) => current.identity === connectionIdentity
            && Math.abs(current.ratio - nextAspectRatio) < 0.001
            ? current
            : { identity: connectionIdentity, ratio: nextAspectRatio });
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
          canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
          lastFrameAtRef.current = Date.now();
          setHasFrame(true);
          if (statusRef.current !== "live") applyStatus("live");
        } finally {
          bitmap?.close();
        }
      }
    } catch {
      if (mountedRef.current) applyStatus("reconnecting");
    } finally {
      decodeInFlightRef.current = false;
    }
  }, [applyStatus, connectionIdentity]);

  const receiveSharedFrame = useCallback((blob) => {
    if (!blob) {
      clearFrame();
      return;
    }
    lastFrameAtRef.current = Date.now();
    pendingFrameBlobRef.current = blob;
    void drawLatestFrame();
  }, [clearFrame, drawLatestFrame]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      frameSequenceRef.current += 1;
      pendingFrameBlobRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!streamKey) return undefined;
    let receivedCachedFrame = false;
    const resetTimer = window.setTimeout(() => {
      if (!receivedCachedFrame) clearFrame();
    }, 0);
    const subscription = subscribeLiveScreenStream(streamKey, {
      onFrame: (frame) => {
        if (frame) receivedCachedFrame = true;
        receiveSharedFrame(frame);
      },
      onStatus: applyStatus,
      onControlChange: setControlState,
      onProducerChange: (next) => {
        setIsProducer(next);
        if (next) setProducerEpoch((value) => value + 1);
      },
    });
    hubRef.current = subscription;
    return () => {
      window.clearTimeout(resetTimer);
      if (hubRef.current === subscription) hubRef.current = null;
      subscription?.release();
    };
  }, [applyStatus, clearFrame, receiveSharedFrame, streamKey]);

  useEffect(() => {
    const initialView = latestViewRef.current;
    if (!isProducer || !initialView?.viewerSocketUrl || !connectionIdentity) return undefined;
    let disposed = false;
    let reconnectTimer = 0;
    let reconnectAttempt = 0;
    let attachTimer = 0;
    let controlReconnectTimer = 0;
    let controlReconnectAttempt = 0;
    let connectionWatchdog = 0;
    let attachedAt = 0;
    let hasReceivedFrame = false;
    let heartbeatCallId = 0;
    let heartbeatSentAt = 0;
    let activeSocketUrl = initialView.viewerSocketUrl;
    let activePageId = initialView.pageId;
    let refreshUrl = initialView.viewerRefreshUrl || "";
    let ticketExpiresAt = initialView.viewerTicketExpiresAt;
    let ticketReady = !refreshUrl;

    const enqueueFrame = (blob, sessionId) => {
      if (sessionId != null) send("Page.screencastFrameAck", { sessionId });
      if (!blob?.size || disposed) return;
      hasReceivedFrame = true;
      hubRef.current?.publishFrame(blob);
      if (statusRef.current !== "live") updateStatus("live");
    };

    const refreshViewer = async () => {
      if (!refreshUrl) return activeSocketUrl;
      const response = await fetch(refreshUrl, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Live Screen 연결 정보를 새로 받지 못했습니다.");
      const payload = await response.json();
      const nextView = payload?.activity?.view;
      if (!nextView?.viewerSocketUrl) throw new Error("Live Screen 연결 정보가 비어 있습니다.");
      activeSocketUrl = nextView.viewerSocketUrl;
      activePageId = nextView.pageId || activePageId;
      refreshUrl = nextView.viewerRefreshUrl || refreshUrl;
      ticketExpiresAt = nextView.viewerTicketExpiresAt;
      ticketReady = true;
      return activeSocketUrl;
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      reconnectAttempt += 1;
      updateStatus(reconnectAttempt >= 6 ? "error" : "reconnecting");
      reconnectTimer = window.setTimeout(connect, relayReconnectDelay(reconnectAttempt));
    };

    const scheduleControlReconnect = () => {
      if (disposed || !pageSessionIdRef.current) return;
      controlReconnectAttempt += 1;
      window.clearTimeout(controlReconnectTimer);
      controlReconnectTimer = window.setTimeout(connectControl, relayReconnectDelay(controlReconnectAttempt));
    };

    const connectControl = async () => {
      if (disposed || !pageSessionIdRef.current || !refreshUrl) return;
      let controlView;
      try {
        const response = await fetch(refreshUrl, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("control viewer refresh failed");
        controlView = (await response.json())?.activity?.view;
        if (!controlView?.viewerSocketUrl || controlView.pageId !== activePageId) throw new Error("control viewer mismatch");
        refreshUrl = controlView.viewerRefreshUrl || refreshUrl;
      } catch {
        scheduleControlReconnect();
        return;
      }
      if (disposed) return;
      let controlSocket;
      try {
        controlSocket = new WebSocket(socketUrl(controlView.viewerSocketUrl));
      } catch {
        scheduleControlReconnect();
        return;
      }
      controlSocketRef.current = controlSocket;
      controlSocket.addEventListener("open", () => {
        const id = controlCallIdRef.current++;
        controlAttachCallIdRef.current = id;
        controlSocket.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId: activePageId, flatten: true } }));
      });
      controlSocket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id === controlAttachCallIdRef.current) {
          const controlSessionId = message.result?.sessionId || "";
          if (!controlSessionId) {
            controlSocket.close();
            return;
          }
          controlSessionIdRef.current = controlSessionId;
          controlReconnectAttempt = 0;
          return;
        }
        if (message.id === heartbeatCallId) {
          heartbeatCallId = 0;
          heartbeatSentAt = 0;
          if (hasReceivedFrame && statusRef.current !== "live") updateStatus("live");
        }
      });
      controlSocket.addEventListener("close", () => {
        if (disposed || controlSocketRef.current !== controlSocket) return;
        controlSocketRef.current = null;
        controlSessionIdRef.current = "";
        scheduleControlReconnect();
      });
      controlSocket.addEventListener("error", () => controlSocket.close());
    };

    const connect = async () => {
      if (disposed) return;
      updateStatus(reconnectAttempt ? "reconnecting" : "connecting");
      if (reconnectAttempt) frameSequenceRef.current += 1;
      pageSessionIdRef.current = "";
      const previousControlSocket = controlSocketRef.current;
      controlSocketRef.current = null;
      controlSessionIdRef.current = "";
      previousControlSocket?.close();
      lastViewportRef.current = "";
      window.clearTimeout(attachTimer);
      try {
        if (liveTicketExpired(ticketExpiresAt) && !refreshUrl) {
          updateStatus("expired");
          return;
        }
        if (!ticketReady || reconnectAttempt > 0 || liveTicketExpired(ticketExpiresAt)) await refreshViewer();
      } catch {
        scheduleReconnect();
        return;
      }
      if (disposed) return;
      let socket;
      try {
        socket = new WebSocket(socketUrl(activeSocketUrl));
      } catch {
        scheduleReconnect();
        return;
      }
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        attachCallIdRef.current = send("Target.attachToTarget", { targetId: activePageId, flatten: true }) || 0;
        attachTimer = window.setTimeout(() => socket.close(), 8000);
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (event.data.byteLength < 5) return;
          const frameId = new DataView(event.data, 0, 4).getUint32(0);
          enqueueFrame(new Blob([event.data.slice(4)], { type: "image/jpeg" }), frameId);
          return;
        }
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id === attachCallIdRef.current) {
          window.clearTimeout(attachTimer);
          const pageSessionId = message.result?.sessionId || "";
          if (!pageSessionId) {
            socket.close();
            return;
          }
          pageSessionIdRef.current = pageSessionId;
          reconnectAttempt = 0;
          attachedAt = Date.now();
          hasReceivedFrame = false;
          heartbeatCallId = 0;
          heartbeatSentAt = 0;
          updateStatus("live");
          send("Page.enable");
          syncViewport(false);
          void connectControl();
          return;
        }
        if (message.id === heartbeatCallId) {
          heartbeatCallId = 0;
          heartbeatSentAt = 0;
          if (hasReceivedFrame && statusRef.current !== "live") updateStatus("live");
          return;
        }
        if (message.method !== "Page.screencastFrame") return;
        const { data, sessionId } = message.params ?? {};
        if (!data || disposed) return;
        enqueueFrame(base64JpegBlob(data), sessionId);
      });
      socket.addEventListener("close", () => {
        window.clearTimeout(attachTimer);
        if (disposed || socketRef.current !== socket) return;
        pageSessionIdRef.current = "";
        scheduleReconnect();
      });
      socket.addEventListener("error", () => socket.close());
    };
    connectionWatchdog = window.setInterval(() => {
      if (!pageSessionIdRef.current) return;
      const now = Date.now();
      if (!hasReceivedFrame && attachedAt && now - attachedAt > 12_000) {
        socketRef.current?.close();
        return;
      }
      if (heartbeatCallId) {
        if (now - heartbeatSentAt > 12_000) socketRef.current?.close();
        return;
      }
      heartbeatCallId = sendControlLocal("Page.enable") || 0;
      heartbeatSentAt = heartbeatCallId ? now : 0;
    }, 5_000);
    hubRef.current?.setTransport({
      sendControl: sendControlLocal,
      retry: () => setRetryKey((value) => value + 1),
      close: () => {
        controlSocketRef.current?.close();
        socketRef.current?.close();
      },
    });
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(attachTimer);
      window.clearTimeout(controlReconnectTimer);
      window.clearInterval(connectionWatchdog);
      window.cancelAnimationFrame(wheelFrameRef.current);
      wheelFrameRef.current = 0;
      pendingWheelRef.current = null;
      hubRef.current?.setTransport(null);
      const controlSocket = controlSocketRef.current;
      controlSocketRef.current = null;
      controlSessionIdRef.current = "";
      controlSocket?.close();
      const socket = socketRef.current;
      if (!socket) return;
      if (socket.readyState === WebSocket.OPEN) {
        const message = { id: 999999, method: "Page.stopScreencast", params: {} };
        if (pageSessionIdRef.current) message.sessionId = pageSessionIdRef.current;
        socket.send(JSON.stringify(message));
      }
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [connectionIdentity, isProducer, producerEpoch, retryKey, send, sendControlLocal, syncViewport, updateStatus]);

  const dispatchPointer = useCallback((event, type) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (type === "mousePressed") {
      (inputRef.current || canvas).focus({ preventScroll: true });
      canvas.setPointerCapture?.(event.pointerId);
    }
    const bounds = canvas.getBoundingClientRect();
    const point = relayPoint(bounds, remoteViewportRef.current, event.clientX, event.clientY);
    if (!point) return;
    const { x, y, scaleX, scaleY } = point;
    if (event.pointerType === "touch") {
      if (type === "mousePressed" || type === "mouseMoved") {
        if (type === "mousePressed" && touchPointsRef.current.size && !touchPointsRef.current.has(event.pointerId)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (type === "mouseMoved" && !touchPointsRef.current.has(event.pointerId)) return;
        touchPointsRef.current.set(event.pointerId, { x, y, id: event.pointerId, radiusX: 1, radiusY: 1, force: event.pressure || 1 });
      } else {
        touchPointsRef.current.delete(event.pointerId);
      }
      const touchType = type === "mousePressed" ? "touchStart" : type === "mouseMoved" ? "touchMove" : type === "mouseCanceled" ? "touchCancel" : "touchEnd";
      sendControl("Input.dispatchTouchEvent", { type: touchType, touchPoints: [...touchPointsRef.current.values()], modifiers: 0 });
    } else {
    const mouseType = type === "mouseCanceled" ? "mouseReleased" : type;
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    sendControl("Input.dispatchMouseEvent", {
      type: mouseType,
      x,
      y,
      button: mouseType === "mouseMoved" ? "none" : button,
      buttons: event.buttons,
      clickCount: ["mousePressed", "mouseReleased"].includes(mouseType) ? Math.max(1, event.detail || 1) : 0,
      deltaX: mouseType === "mouseWheel" ? Math.max(-2000, Math.min(2000, event.deltaX * scaleX)) : 0,
      deltaY: mouseType === "mouseWheel" ? Math.max(-2000, Math.min(2000, event.deltaY * scaleY)) : 0,
      pointerType: event.pointerType === "pen" ? "pen" : "mouse",
    });
    }
    if (["mouseReleased", "mouseCanceled"].includes(type) && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (type === "mouseReleased" && event.pointerType === "touch") inputRef.current?.focus({ preventScroll: true });
    event.preventDefault();
    event.stopPropagation();
  }, [sendControl]);

  const dispatchKey = useCallback((event, type) => {
    if (event.isComposing) return;
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    sendControl("Input.dispatchKeyEvent", {
      type,
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      nativeVirtualKeyCode: event.keyCode,
      modifiers,
    });
    event.preventDefault();
    event.stopPropagation();
  }, [sendControl]);

  const insertText = useCallback((text) => {
    const safeText = clampRelayText(text);
    if (safeText) sendControl("Input.insertText", { text: safeText });
  }, [sendControl]);

  const handleTextInput = useCallback((event) => {
    if (event.nativeEvent?.isComposing) return;
    insertText(event.currentTarget.value);
    event.currentTarget.value = "";
  }, [insertText]);

  const handlePaste = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    insertText(event.clipboardData.getData("text/plain"));
  }, [insertText]);

  const handleInputKeyDown = useCallback((event) => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    dispatchKey(event, "keyDown");
  }, [dispatchKey]);

  const handleInputKeyUp = useCallback((event) => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    dispatchKey(event, "keyUp");
  }, [dispatchKey]);

  const handleMouseMove = useCallback((event) => {
    const now = performance.now();
    if (now - lastPointerMoveAtRef.current < 16) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    lastPointerMoveAtRef.current = now;
    dispatchPointer(event, "mouseMoved");
  }, [dispatchPointer]);
  const handleMouseDown = useCallback((event) => dispatchPointer(event, "mousePressed"), [dispatchPointer]);
  const handleMouseUp = useCallback((event) => dispatchPointer(event, "mouseReleased"), [dispatchPointer]);
  const handlePointerCancel = useCallback((event) => dispatchPointer(event, "mouseCanceled"), [dispatchPointer]);
  const handleWheel = useCallback((event) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const point = relayPoint(bounds, remoteViewportRef.current, event.clientX, event.clientY);
    if (!point) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
    const previous = pendingWheelRef.current;
    pendingWheelRef.current = {
      x: point.x,
      y: point.y,
      deltaX: Math.max(-2000, Math.min(2000, (previous?.deltaX || 0) + event.deltaX * unit * point.scaleX)),
      deltaY: Math.max(-2000, Math.min(2000, (previous?.deltaY || 0) + event.deltaY * unit * point.scaleY)),
    };
    if (!wheelFrameRef.current) {
      wheelFrameRef.current = window.requestAnimationFrame(() => {
        wheelFrameRef.current = 0;
        const pending = pendingWheelRef.current;
        pendingWheelRef.current = null;
        if (!pending) return;
        sendControl("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: pending.x,
          y: pending.y,
          button: "none",
          buttons: 0,
          clickCount: 0,
          deltaX: pending.deltaX,
          deltaY: pending.deltaY,
          pointerType: "mouse",
        });
      });
    }
    event.preventDefault();
    event.stopPropagation();
  }, [sendControl]);
  const handleKeyDown = useCallback((event) => dispatchKey(event, "keyDown"), [dispatchKey]);
  const handleKeyUp = useCallback((event) => dispatchKey(event, "keyUp"), [dispatchKey]);

  const reconnect = useCallback(() => {
    if (hubRef.current?.retry) hubRef.current.retry();
    else setRetryKey((value) => value + 1);
  }, []);

  const statusLabel = {
    connecting: "브라우저 연결 중",
    reconnecting: "브라우저 재연결 중",
    error: "Live Screen 연결을 복구하지 못했습니다.",
    expired: "Live Screen 연결 정보가 만료되었습니다.",
    live: hasFrame ? "Live Screen 연결됨" : "첫 화면을 기다리는 중",
  }[status] || "Live Screen 상태 확인 중";
  const isLive = status === "live" && hasFrame;
  const showBlockingStatus = liveScreenBlocksFrame(status, hasFrame);
  const presenceLabel = isLive
    ? "실시간 연결"
    : status === "reconnecting"
      ? "재연결 중"
      : status === "connecting"
        ? "연결 중"
        : "확인 필요";

  return (
    <div className={`chrome-relay ${status}`} data-relay-status={status} data-control-state={controlState.busy ? "busy" : controlState.owned ? "owned" : "available"} aria-busy={!isLive}>
      <div className="chrome-relay-presence" role="status" aria-live="polite">
        <i aria-hidden="true" />
        <span>{presenceLabel}</span>
      </div>
      <canvas
        ref={canvasRef}
        style={{ "--live-screen-aspect-ratio": frameAspectRatio }}
        aria-label={`${title} 원격 브라우저`}
        aria-describedby={instructionsId}
        role="application"
        tabIndex={0}
        onContextMenu={(event) => event.preventDefault()}
        onPointerMove={handleMouseMove}
        onPointerDown={handleMouseDown}
        onPointerUp={handleMouseUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      />
      <textarea
        ref={inputRef}
        className="chrome-relay-input"
        aria-label={`${title} 원격 키보드 입력`}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        tabIndex={-1}
        onInput={handleTextInput}
        onPaste={handlePaste}
        onKeyDown={handleInputKeyDown}
        onKeyUp={handleInputKeyUp}
      />
      <p id={instructionsId} className="chrome-relay-instructions">클릭하거나 터치한 뒤 키보드로 원격 브라우저를 조작할 수 있습니다.</p>
      {controlState.busy && (
        <div className="chrome-relay-control-busy" role="status" aria-live="polite">
          같은 세션의 다른 화면에서 조작 중입니다. 잠시 후 다시 시도해주세요.
        </div>
      )}
      {showBlockingStatus && (
        <div className="chrome-relay-status" role="status" aria-live="polite" aria-atomic="true">
          <span>{statusLabel}</span>
          {["error", "expired"].includes(status) && <button type="button" onClick={reconnect}>다시 연결</button>}
        </div>
      )}
    </div>
  );
}

function LiveScreenTabs({ workspace, selectedTargetId, followAgent = true, onSelectTarget, onFollowAgent }) {
  const stripRef = useRef(null);
  const tabs = Array.isArray(workspace?.tabs) ? workspace.tabs : [];
  const activeTargetId = String(workspace?.activeTargetId || "");
  useEffect(() => {
    if (!followAgent || !activeTargetId) return;
    stripRef.current?.querySelector(`[data-target-id="${CSS.escape(activeTargetId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeTargetId, followAgent, tabs.length]);
  if (tabs.length < 2) return null;
  const userPinnedAway = !followAgent && selectedTargetId && selectedTargetId !== activeTargetId;
  return (
    <div className="live-screen-tabbar">
      <div ref={stripRef} className="live-screen-tabs" role="tablist" aria-label="이 세션의 브라우저 탭">
        {tabs.map((tab) => {
          const selected = String(selectedTargetId || activeTargetId) === tab.targetId;
          return (
            <button
              type="button"
              role="tab"
              key={tab.targetId}
              data-target-id={tab.targetId}
              className={`${selected ? "selected" : ""} ${tab.targetId === activeTargetId ? "agent-active" : ""}`.trim()}
              aria-selected={selected}
              aria-label={`브라우저 탭 ${tab.slot}: ${tab.title || tab.url || "페이지"}`}
              title={tab.title || tab.url || `탭 ${tab.slot}`}
              onClick={() => onSelectTarget?.(tab.targetId)}
            >
              <span>{tab.slot}</span>
              {tab.targetId === activeTargetId && <i aria-label="구성원이 사용 중" />}
            </button>
          );
        })}
      </div>
      {userPinnedAway && <button type="button" className="live-screen-follow" onClick={onFollowAgent}>구성원 화면으로</button>}
    </div>
  );
}

export function LiveScreenPanel({ activity, workspace = null, selectedTargetId = "", followAgent = true, onSelectTarget, onFollowAgent, profileName = "", sessionId = "", variant = "panel", onFullscreen, fullscreenLabel = "전체 화면", onClose, headingId }) {
  const view = activity?.view;
  const meta = TEAM_META[profileName] ?? TEAM_META.default;
  if (!view?.viewerSocketUrl) {
    return (
      <div className={`agent-live-empty ${variant}`} role="status">
        <span>LIVE BROWSER</span>
        <strong>공유 중인 화면이 없습니다.</strong>
        <p>에이전트가 브라우저 작업을 시작하면 이 화면에 자동으로 표시됩니다.</p>
      </div>
    );
  }

  let hostname = view.url;
  let displayLocation = view.url;
  try {
    const location = new URL(view.url);
    hostname = location.hostname;
    displayLocation = `${location.hostname}${location.pathname === "/" ? "" : location.pathname}`;
  } catch { /* keep raw URL */ }
  const title = view.title || hostname;
  const immersive = variant === "modal" || variant === "page";
  return (
    <div className={`agent-live-view ${variant}`}>
      <header>
        <span className="console-avatar" style={{ "--avatar": meta.color }}>{meta.initials}</span>
        <div>
          <span>LIVE BROWSER</span>
          <strong id={headingId}>{title}</strong>
          <small>{meta.name} · 이 대화의 Chrome · {formatViewTime(view.updatedAt)}</small>
        </div>
        <nav className="agent-live-actions" aria-label="Live Browser 화면 작업">
          {onFullscreen && <button type="button" aria-pressed={fullscreenLabel === "전체 화면 종료"} title={fullscreenLabel} onClick={onFullscreen}><span aria-hidden="true">⛶</span>{fullscreenLabel}</button>}
          <a href={liveViewerUrl(profileName, sessionId)} target="_blank" rel="noreferrer" aria-label="Live Browser를 새 창에서 열기" title="새 창에서 열기"><span aria-hidden="true">↗</span>새 창</a>
          {onClose && <button type="button" aria-label="Live Screen 닫기" title="닫기" onClick={onClose}><span aria-hidden="true">×</span>닫기</button>}
        </nav>
      </header>
      <LiveScreenTabs workspace={workspace} selectedTargetId={selectedTargetId} followAgent={followAgent} onSelectTarget={onSelectTarget} onFollowAgent={onFollowAgent} />
      <div className="agent-live-location" title={view.url}>
        <i aria-hidden="true" />
        <span>보안 중계</span>
        <strong>{displayLocation || hostname || "브라우저"}</strong>
        <small>이 대화 세션 전용</small>
      </div>
      <div className="agent-live-frame">
        <ChromeRelay
          view={view}
          title={title}
          profileName={profileName}
          sessionId={sessionId}
          fixedAspectRatio={["chat", "dock"].includes(variant) ? 16 / 9 : 0}
        />
      </div>
      {immersive && (
        <footer className="agent-live-help">
          <span><kbd>Esc</kbd> 전체화면 닫기</span>
          <span>화면을 클릭한 뒤 키보드 입력 · 휠 스크롤 · 터치 조작</span>
          <small>화면 비율을 유지해 자동 맞춤</small>
        </footer>
      )}
    </div>
  );
}

export function LiveScreenModal({ activity, workspace, selectedTargetId, followAgent, onSelectTarget, onFollowAgent, profileName, sessionId, onClose }) {
  const modalRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);

  const close = useCallback(async () => {
    if (document.fullscreenElement === modalRef.current) {
      try { await document.exitFullscreen(); } catch { /* already leaving fullscreen */ }
    }
    onClose?.();
  }, [onClose]);

  const dialogRef = useModalFocus(true, close);

  const setModalRef = useCallback((node) => {
    modalRef.current = node;
    dialogRef.current = node;
  }, [dialogRef]);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === modalRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.classList.add("live-screen-open");
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      document.documentElement.classList.remove("live-screen-open");
    };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === modalRef.current) await document.exitFullscreen();
      else await modalRef.current?.requestFullscreen?.();
    } catch {
      // The browser can reject fullscreen outside a trusted user gesture.
    }
  }, []);

  return (
    <div className="live-screen-backdrop" onMouseDown={close}>
      <section ref={setModalRef} className="live-screen-modal" data-native-fullscreen={fullscreen ? "true" : "false"} role="dialog" aria-modal="true" aria-labelledby="live-screen-title" aria-describedby="live-screen-usage" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <LiveScreenPanel activity={activity} workspace={workspace} selectedTargetId={selectedTargetId} followAgent={followAgent} onSelectTarget={onSelectTarget} onFollowAgent={onFollowAgent} profileName={profileName} sessionId={sessionId} variant="modal" headingId="live-screen-title" onFullscreen={toggleFullscreen} fullscreenLabel={fullscreen ? "전체 화면 종료" : "전체 화면"} onClose={close} />
        <span id="live-screen-usage" className="sr-only">원격 브라우저 화면입니다. 화면을 클릭한 뒤 키보드, 마우스, 터치로 조작할 수 있습니다.</span>
      </section>
    </div>
  );
}

export default function AgentLivePage() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const profileName = query.get("profile") || "default";
  const sessionId = query.get("sessionId") || "";
  const [activity, setActivity] = useState(() => readLiveActivity(profileName, sessionId));
  const [workspace, setWorkspace] = useState(null);
  const [selection, setSelection] = useState({ followAgent: true, targetId: "" });

  useEffect(() => {
    if (!profileName || !sessionId) return undefined;
    let stopped = false;
    let timer = 0;
    const syncDirectViewer = async () => {
      try {
        const payload = await loadLiveScreen(profileName, sessionId, selection.followAgent ? "" : selection.targetId, "", sessionId, true);
        if (!stopped && payload?.workspace) setWorkspace(payload.workspace);
        if (!stopped && payload?.activity?.view?.viewerSocketUrl) setActivity(payload.activity);
      } catch {
        // Preserve the last good frame while the managed browser session recovers.
      } finally {
        if (!stopped) timer = window.setTimeout(syncDirectViewer, 1800);
      }
    };
    syncDirectViewer();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [profileName, selection.followAgent, selection.targetId, sessionId]);

  useEffect(() => {
    const channel = new BroadcastChannel(LIVE_CHANNEL);
    const onMessage = (event) => {
      if (event.data?.profileName === profileName && (event.data?.sessionId || "") === sessionId) setActivity(event.data.activity);
    };
    const onStorage = (event) => {
      if (event.key === LIVE_ACTIVITY_KEY) setActivity(readLiveActivity(profileName, sessionId));
    };
    channel.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
      window.removeEventListener("storage", onStorage);
    };
  }, [profileName, sessionId]);

  return <main className="agent-live-page"><LiveScreenPanel activity={activity} workspace={workspace} selectedTargetId={selection.followAgent ? (workspace?.activeTargetId || "") : selection.targetId} followAgent={selection.followAgent} onSelectTarget={(targetId) => setSelection({ followAgent: false, targetId })} onFollowAgent={() => setSelection({ followAgent: true, targetId: "" })} profileName={profileName} sessionId={sessionId} variant="page" /></main>;
}
