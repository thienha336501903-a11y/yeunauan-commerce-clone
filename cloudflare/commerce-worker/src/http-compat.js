// Copied verbatim from yeunauan-lms-clone edge/tenant/src/http-compat.js (live in systemb-tenant-edge since Đợt 2).
// Keep in sync by copy; do not edit here without porting the change back.
const MAX_BODY_BYTES = 1024 * 1024;
const DROPPED_HEADERS = new Set([
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "cf-access-authenticated-user-email",
  "cf-access-jwt-assertion"
]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TRUSTED_EXTRAS = new Set(["__env", "__options", "__routeDecision", "__supabase", "maxBodyBytes"]);

export class HttpCompatError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "HttpCompatError";
    this.status = status;
    this.code = code;
  }
}

function toUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new TextEncoder().encode(String(chunk));
}

function concatUint8Arrays(arrays) {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.byteLength;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}

function appendValue(target, key, value) {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    target[key] = Array.isArray(target[key]) ? [...target[key], value] : [target[key], value];
  } else {
    target[key] = value;
  }
}

function entriesObject(entries) {
  const result = {};
  for (const [key, value] of entries) appendValue(result, key, value);
  return result;
}

async function parseBody(request, maxBodyBytes = MAX_BODY_BYTES) {
  if (request.method === "GET" || request.method === "HEAD") return { body: undefined, rawBodyBytes: 0, rawBody: undefined };
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HttpCompatError(413, "request_body_too_large");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBodyBytes) throw new HttpCompatError(413, "request_body_too_large");
  if (!bytes.byteLength) return { body: undefined, rawBodyBytes: 0, rawBody: bytes };

  const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  // Receipt images: the handler validates the bytes (magic number) itself.
  if (IMAGE_TYPES.has(contentType)) return { body: bytes, rawBodyBytes: bytes.byteLength, rawBody: bytes };
  const text = new TextDecoder().decode(bytes);
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    try {
      return { body: JSON.parse(text), rawBodyBytes: bytes.byteLength, rawBody: bytes };
    } catch {
      throw new HttpCompatError(400, "invalid_json");
    }
  }
  if (contentType === "application/x-www-form-urlencoded") {
    return { body: entriesObject(new URLSearchParams(text)), rawBodyBytes: bytes.byteLength, rawBody: bytes };
  }
  return { body: undefined, rawBodyBytes: bytes.byteLength, rawBody: bytes };
}

export async function createCompatRequest(request, extras = {}) {
  const url = new URL(request.url);
  const headers = {};
  for (const [rawName, value] of request.headers) {
    const name = rawName.toLowerCase();
    if (!DROPPED_HEADERS.has(name)) headers[name] = value;
  }
  headers.host = url.hostname.toLowerCase();

  const maxBodyBytes = extras.maxBodyBytes || MAX_BODY_BYTES;
  const parsed = await parseBody(request, maxBodyBytes);
  const req = {
    method: request.method.toUpperCase(),
    url: `${url.pathname}${url.search}`,
    headers,
    query: entriesObject(url.searchParams),
    body: parsed.body,
    rawBodyBytes: parsed.rawBodyBytes,
    rawBody: parsed.rawBody
  };
  for (const [key, value] of Object.entries(extras)) {
    if (TRUSTED_EXTRAS.has(key)) req[key] = value;
  }
  return req;
}

export function createCompatResponse(request = null) {
  let statusCode = 200;
  let body = null;
  const chunks = [];
  const headers = new Map();
  const listeners = new Map();
  let headersSent = false;
  let writableEnded = false;
  let destroyed = false;
  let isStreaming = false;
  let transformStream = null;
  let writer = null;
  let streamResponse = null;

  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  const emit = (event, ...args) => {
    const list = listeners.get(event);
    if (list) {
      for (const fn of [...list]) {
        try {
          fn(...args);
        } catch (e) {
          console.error(`[http-compat] listener error for ${event}:`, e);
        }
      }
    }
    return Boolean(list && list.length);
  };

  const on = (event, fn) => {
    if (typeof fn !== "function") return api;
    let list = listeners.get(event);
    if (!list) {
      list = [];
      listeners.set(event, list);
    }
    list.push(fn);
    return api;
  };

  const once = (event, fn) => {
    if (typeof fn !== "function") return api;
    const wrapper = (...args) => {
      off(event, wrapper);
      fn(...args);
    };
    wrapper.__original = fn;
    return on(event, wrapper);
  };

  const off = (event, fn) => {
    const list = listeners.get(event);
    if (!list) return api;
    listeners.set(
      event,
      list.filter((f) => f !== fn && f.__original !== fn)
    );
    return api;
  };

  function buildHeaders() {
    const outputHeaders = new Headers();
    for (const { name, value } of headers.values()) {
      if (String(name).toLowerCase() === "set-cookie" && Array.isArray(value)) {
        for (const cookie of value) outputHeaders.append(name, String(cookie));
      } else if (Array.isArray(value)) {
        for (const item of value) outputHeaders.append(name, String(item));
      } else if (value !== undefined) {
        outputHeaders.set(name, String(value));
      }
    }
    return outputHeaders;
  }

  function initStreaming() {
    if (isStreaming) return;
    isStreaming = true;
    headersSent = true;
    transformStream = new TransformStream();
    writer = transformStream.writable.getWriter();
    const outputHeaders = buildHeaders();
    const finalBody = request?.method?.toUpperCase() === "HEAD" ? null : transformStream.readable;
    streamResponse = new Response(finalBody, { status: statusCode, headers: outputHeaders });
    resolveResponse(streamResponse);
  }

  if (request?.signal) {
    if (request.signal.aborted) {
      destroyed = true;
    } else {
      request.signal.addEventListener(
        "abort",
        () => {
          destroyed = true;
          emit("close");
          if (writer) {
            try {
              writer.abort(new Error("Request aborted")).catch(() => {});
            } catch (_) {}
          }
        },
        { once: true }
      );
    }
  }

  const writeHead = (code, maybeHeaders) => {
    if (headersSent) return api;
    statusCode = Number(code);
    if (maybeHeaders && typeof maybeHeaders === "object") {
      if (Array.isArray(maybeHeaders)) {
        for (let i = 0; i < maybeHeaders.length; i += 2) {
          api.setHeader(maybeHeaders[i], maybeHeaders[i + 1]);
        }
      } else {
        for (const [k, v] of Object.entries(maybeHeaders)) {
          api.setHeader(k, v);
        }
      }
    }
    initStreaming();
    return api;
  };

  const flushHeaders = () => {
    if (!headersSent) {
      initStreaming();
    }
    return api;
  };

  const write = (chunk, encoding, callback) => {
    if (destroyed) {
      const err = new Error("Cannot write after request aborted");
      err.code = "request_aborted";
      throw err;
    }
    if (writableEnded) {
      throw new Error("Cannot write after end");
    }

    if (!isStreaming) {
      initStreaming();
    }

    const data = toUint8Array(chunk);
    let canAcceptMore = true;

    if (writer) {
      const writePromise = writer.write(data);
      if (writer.desiredSize !== null && writer.desiredSize <= 0) {
        canAcceptMore = false;
        writer.ready.then(() => {
          if (!destroyed && !writableEnded) emit("drain");
        }).catch(() => {});
      }
      writePromise.catch(() => {
        destroyed = true;
        emit("close");
      });
    }

    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return canAcceptMore;
  };

  const end = (value, encoding, callback) => {
    if (writableEnded) return api;
    writableEnded = true;

    if (isStreaming) {
      if (value !== undefined && value !== null) {
        try {
          const data = toUint8Array(value);
          writer.write(data).catch(() => {});
        } catch (_) {}
      }
      headersSent = true;
      emit("finish");
      if (writer) {
        writer.close().catch(() => {});
      }
      if (typeof encoding === "function") encoding();
      else if (typeof callback === "function") callback();
      return api;
    }

    if (value !== undefined && value !== null) {
      if (typeof value === "string" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        body = value;
      } else {
        api.json(value);
      }
    }
    headersSent = true;
    emit("finish");
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();

    resolveResponse(api.toResponse());
    return api;
  };

  const api = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code) {
      statusCode = Number(code);
    },
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    get destroyed() {
      return destroyed;
    },
    set destroyed(val) {
      destroyed = Boolean(val);
      if (destroyed) {
        emit("close");
        if (writer) {
          try {
            writer.abort(new Error("Stream destroyed")).catch(() => {});
          } catch (_) {}
        }
      }
    },
    destroy(err) {
      destroyed = true;
      emit("close");
      if (writer) {
        try {
          writer.abort(err || new Error("Stream destroyed")).catch(() => {});
        } catch (_) {}
      }
      return api;
    },
    status(code) {
      statusCode = Number(code);
      return api;
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), { name: String(name), value });
      return api;
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase())?.value;
    },
    removeHeader(name) {
      headers.delete(String(name).toLowerCase());
      return api;
    },
    writeHead,
    flushHeaders,
    json(value) {
      api.setHeader("Content-Type", "application/json; charset=utf-8");
      body = JSON.stringify(value);
      headersSent = true;
      return api;
    },
    send(value) {
      if (value === undefined || value === null) body = null;
      else if (typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) body = value;
      else return api.json(value);
      headersSent = true;
      return api;
    },
    redirect(codeOrUrl, maybeUrl) {
      const hasCode = typeof codeOrUrl === "number";
      statusCode = hasCode ? codeOrUrl : 302;
      api.setHeader("Location", hasCode ? maybeUrl : codeOrUrl);
      headersSent = true;
      return api;
    },
    write,
    end,
    on,
    once,
    off,
    emit,
    responsePromise,
    toResponse() {
      if (streamResponse) return streamResponse;
      if (isStreaming) {
        const outputHeaders = buildHeaders();
        const finalBody = request?.method?.toUpperCase() === "HEAD" ? null : transformStream.readable;
        streamResponse = new Response(finalBody, { status: statusCode, headers: outputHeaders });
        return streamResponse;
      }
      const outputHeaders = buildHeaders();
      let finalBody = null;
      if (request?.method?.toUpperCase() !== "HEAD") {
        if (chunks.length > 0) {
          finalBody = concatUint8Arrays(chunks);
        } else if (body !== null) {
          finalBody = body;
        }
      }
      return new Response(finalBody, { status: statusCode, headers: outputHeaders });
    }
  };
  return api;
}

export async function runCompatHandler(handler, request, extras = {}) {
  let req;
  try {
    req = await createCompatRequest(request, extras);
  } catch (error) {
    if (!(error instanceof HttpCompatError)) throw error;
    return new Response(JSON.stringify({ success: false, code: error.code }), {
      status: error.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" }
    });
  }
  const res = createCompatResponse(request);

  const handlerPromise = Promise.resolve().then(() => handler(req, res));
  handlerPromise.catch((err) => {
    if (!res.headersSent) {
      try {
        res.status(500).json({ ok: false, error: err?.message || "internal_error" });
      } catch (_) {}
    } else {
      res.destroy(err);
    }
  });

  const response = await Promise.race([
    handlerPromise.then((returned) => {
      if (returned instanceof Response) return returned;
      return res.toResponse();
    }),
    res.responsePromise
  ]);

  return response;
}
