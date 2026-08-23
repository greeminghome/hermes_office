import { liveSessionKey } from "./liveSessionState.js";

const STREAM_DISPOSE_GRACE_MS = 1500;
export const LIVE_SCREEN_CONTROL_LEASE_MS = 2000;
const hubs = new Map();
let consumerSequence = 0;

export function liveScreenStreamKey(profileName, sessionId, view = {}) {
  const pageId = String(view?.pageId || view?.targetId || "").trim();
  return pageId ? `${liveSessionKey(profileName, sessionId)}:${pageId}` : "";
}

class LiveScreenHub {
  constructor(key, onEmpty) {
    this.key = key;
    this.onEmpty = onEmpty;
    this.consumers = new Map();
    this.producerId = "";
    this.transport = null;
    this.status = "connecting";
    this.lastFrame = null;
    this.disposeTimer = 0;
    this.controlOwnerId = "";
    this.controlLeaseUntil = 0;
    this.controlTimer = 0;
  }

  join(callbacks) {
    clearTimeout(this.disposeTimer);
    this.disposeTimer = 0;
    const id = `viewer-${++consumerSequence}`;
    this.consumers.set(id, callbacks);
    if (!this.producerId) this.producerId = id;
    callbacks.onStatus?.(this.status);
    if (this.lastFrame) callbacks.onFrame?.(this.lastFrame);
    callbacks.onProducerChange?.(this.producerId === id);
    callbacks.onControlChange?.(this.controlSnapshot(id));

    let released = false;
    return {
      id,
      isProducer: () => this.producerId === id,
      publishFrame: (frame) => {
        if (this.producerId !== id || !frame) return false;
        this.lastFrame = frame;
        for (const consumer of this.consumers.values()) consumer.onFrame?.(frame);
        return true;
      },
      clearFrame: () => {
        if (this.producerId !== id) return false;
        this.lastFrame = null;
        for (const consumer of this.consumers.values()) consumer.onFrame?.(null);
        return true;
      },
      publishStatus: (status) => {
        if (this.producerId !== id || !status) return false;
        this.status = status;
        for (const consumer of this.consumers.values()) consumer.onStatus?.(status);
        return true;
      },
      setTransport: (transport) => {
        if (this.producerId !== id) return false;
        this.transport = transport || null;
        return true;
      },
      sendControl: (method, params) => {
        if (!this.claimControl(id)) return false;
        return this.transport?.sendControl?.(method, params);
      },
      releaseControl: () => this.releaseControl(id),
      retry: () => this.transport?.retry?.(),
      release: () => {
        if (released) return;
        released = true;
        this.leave(id);
      },
    };
  }

  leave(id) {
    const wasProducer = this.producerId === id;
    this.consumers.delete(id);
    if (this.controlOwnerId === id) this.releaseControl(id);
    if (wasProducer) {
      this.transport?.close?.();
      this.transport = null;
      this.producerId = this.consumers.keys().next().value || "";
      if (this.producerId) this.consumers.get(this.producerId)?.onProducerChange?.(true);
    }
    if (this.consumers.size) return;
    this.disposeTimer = setTimeout(() => {
      if (!this.consumers.size) this.onEmpty(this.key, this);
    }, STREAM_DISPOSE_GRACE_MS);
  }

  controlSnapshot(consumerId) {
    const active = Boolean(this.controlOwnerId && this.controlLeaseUntil > Date.now());
    return {
      owned: active && this.controlOwnerId === consumerId,
      busy: active && this.controlOwnerId !== consumerId,
      expiresAt: active ? this.controlLeaseUntil : 0,
    };
  }

  notifyControlChange() {
    for (const [consumerId, consumer] of this.consumers) {
      consumer.onControlChange?.(this.controlSnapshot(consumerId));
    }
  }

  claimControl(id) {
    const current = Date.now();
    if (this.controlOwnerId && this.controlOwnerId !== id && this.controlLeaseUntil > current) {
      this.consumers.get(id)?.onControlChange?.(this.controlSnapshot(id));
      return false;
    }
    this.controlOwnerId = id;
    this.controlLeaseUntil = current + LIVE_SCREEN_CONTROL_LEASE_MS;
    clearTimeout(this.controlTimer);
    this.controlTimer = setTimeout(() => {
      if (this.controlLeaseUntil <= Date.now()) this.releaseControl(this.controlOwnerId);
    }, LIVE_SCREEN_CONTROL_LEASE_MS + 10);
    this.notifyControlChange();
    return true;
  }

  releaseControl(id) {
    if (!id || this.controlOwnerId !== id) return false;
    clearTimeout(this.controlTimer);
    this.controlTimer = 0;
    this.controlOwnerId = "";
    this.controlLeaseUntil = 0;
    this.notifyControlChange();
    return true;
  }

  snapshot() {
    return {
      key: this.key,
      consumers: this.consumers.size,
      producers: this.producerId ? 1 : 0,
      status: this.status,
      hasFrame: Boolean(this.lastFrame),
      controlOwner: Boolean(this.controlOwnerId && this.controlLeaseUntil > Date.now()),
    };
  }
}

export function subscribeLiveScreenStream(key, callbacks = {}) {
  if (!key) return null;
  let hub = hubs.get(key);
  if (!hub) {
    hub = new LiveScreenHub(key, (emptyKey, instance) => {
      if (hubs.get(emptyKey) === instance) hubs.delete(emptyKey);
    });
    hubs.set(key, hub);
  }
  return hub.join(callbacks);
}

export function liveScreenHubSnapshot() {
  return [...hubs.values()].map((hub) => hub.snapshot());
}

export function resetLiveScreenHubsForTest() {
  for (const hub of hubs.values()) {
    clearTimeout(hub.disposeTimer);
    clearTimeout(hub.controlTimer);
  }
  hubs.clear();
  consumerSequence = 0;
}
