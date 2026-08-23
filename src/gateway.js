import { mintHermesWsTicket } from "./hermes.js";
import { withHermesProfile } from "./profileIds.js";

const CONNECT_TIMEOUT_MS = 15000;

export class HermesGatewayRequestError extends Error {
  constructor(message, { code = "GATEWAY_REQUEST_ERROR", data, transient = false, cause } = {}) {
    super(message, { cause });
    this.name = "HermesGatewayRequestError";
    this.code = code;
    this.data = data;
    this.transient = transient;
  }
}

export class HermesGateway {
  constructor() {
    this.socket = null;
    this.requestId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.stateListeners = new Set();
    this.state = "idle";
  }

  setState(state) {
    this.state = state;
    this.stateListeners.forEach((listener) => listener(state));
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener) {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  async connect() {
    if (this.state === "open") return;
    if (this.state === "connecting") {
      await new Promise((resolve, reject) => {
        const remove = this.onState((state) => {
          if (state === "open") {
            remove();
            resolve();
          } else if (state === "error" || state === "closed") {
            remove();
            reject(new Error("Hermes Gateway 연결에 실패했습니다."));
          }
        });
      });
      return;
    }

    this.setState("connecting");
    const ticket = await mintHermesWsTicket();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/hermes/api/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      if (frame.id && this.pending.has(frame.id)) {
        const request = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        window.clearTimeout(request.timer);
        request.detach?.();
        if (frame.error) request.reject(new HermesGatewayRequestError(frame.error.message ?? "Hermes 요청 실패", {
          code: frame.error.code ?? "GATEWAY_RPC_ERROR",
          data: frame.error.data,
        }));
        else request.resolve(frame.result);
        return;
      }

      if (frame.method === "event" && frame.params?.type) {
        this.listeners.forEach((listener) => listener(frame.params));
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setState("closed");
      this.rejectPending(new HermesGatewayRequestError("Hermes Gateway 연결이 종료되었습니다.", {
        code: "GATEWAY_DISCONNECTED",
        transient: true,
      }));
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.setState("error");
      this.rejectPending(new HermesGatewayRequestError("Hermes Gateway WebSocket 연결에 문제가 발생했습니다.", {
        code: "GATEWAY_TRANSPORT_ERROR",
        transient: true,
      }));
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const fail = (message = "Hermes Gateway WebSocket 연결에 실패했습니다.") => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        this.setState("error");
        reject(new Error(message));
      };

      socket.addEventListener("open", () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        window.clearTimeout(timer);
        this.setState("open");
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => fail(), { once: true });
      timer = window.setTimeout(() => {
        if (settled || this.socket !== socket) return;
        try {
          socket.close();
        } catch {
          // Best-effort cleanup for a half-open connection.
        }
        fail("Hermes Gateway WebSocket 연결 시간이 초과되었습니다.");
      }, CONNECT_TIMEOUT_MS);
    });
  }
  request(method, params = {}, timeoutMs = 120000, signal) {
    if (!this.socket || this.state !== "open") {
      return Promise.reject(new Error("Hermes Gateway가 연결되지 않았습니다."));
    }
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    const id = `office-${++this.requestId}`;
    return new Promise((resolve, reject) => {
      let onAbort;
      const detach = () => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      const timer = window.setTimeout(() => {
        if (this.pending.delete(id)) detach();
        reject(new HermesGatewayRequestError(`${method} 요청 시간이 초과되었습니다.`, {
          code: "GATEWAY_TIMEOUT",
          transient: true,
        }));
      }, timeoutMs);
      if (signal) {
        onAbort = () => {
          const request = this.pending.get(id);
          if (request?.timer) window.clearTimeout(request.timer);
          this.pending.delete(id);
          detach();
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, { resolve, reject, timer, detach });
      try {
        this.socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: withHermesProfile(params),
        }));
      } catch (error) {
        window.clearTimeout(timer);
        this.pending.delete(id);
        detach();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  rejectPending(error) {
    this.pending.forEach((request) => {
      window.clearTimeout(request.timer);
      request.detach?.();
      request.reject(error);
    });
    this.pending.clear();
  }

  close() {
    this.socket?.close(1000);
    this.socket = null;
  }
}
