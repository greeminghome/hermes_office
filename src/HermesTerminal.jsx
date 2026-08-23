import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createPtyUrl, mintHermesWsTicket } from "./hermes.js";

function makeChannel() {
  return globalThis.crypto?.randomUUID?.() ?? `room-${Date.now().toString(36)}`;
}

function terminalWidth(host) {
  const hostWidth = host?.clientWidth ?? 0;
  if (hostWidth > 2) return Math.round(hostWidth);
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  return Math.max(1, Math.round(Math.min(window.innerWidth, viewportWidth, document.documentElement.clientWidth)));
}

function terminalFontSize(width) {
  if (width < 300) return 7;
  if (width < 360) return 8;
  if (width < 420) return 9;
  if (width < 520) return 10;
  if (width < 720) return 11;
  if (width < 1024) return 12;
  return 14;
}

export default function HermesTerminal({ resumeSessionId, onStatusChange }) {
  const hostRef = useRef(null);
  const [status, setStatus] = useState("connecting");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    let socket;
    let reconnectTimer;
    let fitFrame = 0;
    let settleFrame = 0;
    const host = hostRef.current;
    const initialWidth = terminalWidth(host);
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"IBM Plex Mono", "Cascadia Code", Consolas, monospace',
      fontSize: terminalFontSize(initialWidth),
      lineHeight: initialWidth < 1024 ? 1.02 : 1.15,
      theme: {
        background: "#0b1714",
        foreground: "#f3eadc",
        cursor: "#ee8b64",
        selectionBackground: "#759f8d55",
        black: "#0b1714",
        green: "#88b39c",
        yellow: "#e6bb75",
        blue: "#79a9b4",
        magenta: "#c79abb",
        cyan: "#8cbfc1",
        white: "#f3eadc",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    const updateStatus = (next) => {
      setStatus(next);
      onStatusChange?.(next);
    };

    const syncTerminalMetrics = () => {
      if (!host?.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        const width = terminalWidth(host);
        terminal.options.fontSize = terminalFontSize(width);
        terminal.options.lineHeight = width < 1024 ? 1.02 : 1.15;
        fitAddon.fit();
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(`\u001b[RESIZE:${terminal.cols};${terminal.rows}]`);
        }
      } catch {
        // The terminal can be between layout passes on mobile rotation.
      }
    };

    const scheduleFit = () => {
      if (fitFrame) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = 0;
        syncTerminalMetrics();
      });
    };

    const settleFit = () => {
      window.cancelAnimationFrame(settleFrame);
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = window.requestAnimationFrame(() => {
          settleFrame = 0;
          syncTerminalMetrics();
        });
      });
    };

    const connect = async () => {
      updateStatus("connecting");
      try {
        const ticket = await mintHermesWsTicket();
        if (disposed) return;
        socket = new WebSocket(createPtyUrl(ticket, makeChannel(), resumeSessionId));
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          updateStatus("online");
          scheduleFit();
          settleFit();
          terminal.focus();
        };
        socket.onmessage = (event) => {
          terminal.write(
            typeof event.data === "string" ? event.data : new Uint8Array(event.data),
          );
        };
        socket.onerror = () => updateStatus("error");
        socket.onclose = () => {
          if (disposed) return;
          updateStatus("offline");
          terminal.write("\r\n\u001b[90m연결이 끊겼습니다. 잠시 후 다시 연결합니다.\u001b[0m\r\n");
          reconnectTimer = window.setTimeout(connect, 3000);
        };
      } catch (error) {
        terminal.write(`\r\n\u001b[31m${error.message}\u001b[0m\r\n`);
        updateStatus("error");
        reconnectTimer = window.setTimeout(connect, 5000);
      }
    };

    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    });
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);
    window.addEventListener("resize", scheduleFit);
    window.visualViewport?.addEventListener("resize", scheduleFit);
    document.fonts?.ready.then(() => {
      if (!disposed) settleFit();
    });
    scheduleFit();
    settleFit();
    connect();

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.cancelAnimationFrame(fitFrame);
      window.cancelAnimationFrame(settleFrame);
      window.removeEventListener("resize", scheduleFit);
      window.visualViewport?.removeEventListener("resize", scheduleFit);
      resizeObserver.disconnect();
      input.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [resumeSessionId, retryKey, onStatusChange]);

  return (
    <section className="terminal-shell">
      <div className="terminal-bar">
        <div className="terminal-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <span>HERMES LIVE CONSOLE</span>
        <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
          재연결
        </button>
      </div>
      <div ref={hostRef} className="terminal-host" role="application" aria-label="Hermes 채팅 터미널" />
      <div className={`connection-label ${status}`} role="status" aria-live="polite">
        <span />
        {status === "online" ? "Hermes 연결됨" : status === "connecting" ? "연결 중" : "재연결 대기"}
      </div>
    </section>
  );
}
