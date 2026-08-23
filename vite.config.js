import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import Busboy from "busboy";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const hermesTarget = "http://127.0.0.1:9119";
const remoteFilesRoot = "/opt/data/home/hermes-chat-files";
const maxFileSize = 100 * 1024 * 1024;
const officeBrandName = String(process.env.VITE_OFFICE_BRAND_NAME || "Hermes Office").trim() || "Hermes Office";
const officeBrandShortName = String(process.env.VITE_OFFICE_BRAND_SHORT_NAME || "Hermes").trim() || "Hermes";
const officeBrandDescription = String(
  process.env.VITE_OFFICE_BRAND_DESCRIPTION || "Self-hosted AI team workspace",
).trim() || "Self-hosted AI team workspace";

function htmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function officeBrandHtml() {
  return {
    name: "office-brand-html",
    transformIndexHtml(source) {
      return source
        .replaceAll("__OFFICE_BRAND_NAME__", htmlText(officeBrandName))
        .replaceAll("__OFFICE_BRAND_DESCRIPTION__", htmlText(officeBrandDescription));
    },
  };
}

function safeSegment(value, fallback = "chat") {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || fallback;
}

function safeFilename(value) {
  const extension = path.extname(value).slice(0, 20);
  const stem = path.basename(value, extension).replace(/[^a-zA-Z0-9가-힣._ -]/g, "_").slice(0, 120);
  return `${stem || "file"}${extension}`;
}

function contentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
  }[extension] ?? "application/octet-stream";
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} failed (${code})`));
    });
  });
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function fileBridge() {
  return {
    name: "hermes-file-bridge",
    configureServer(server) {
      server.middlewares.use("/bridge/files", async (request, response, next) => {
        const url = new URL(request.url, "http://localhost");
        const conversation = safeSegment(url.searchParams.get("conversation"));
        const remoteBase = `${remoteFilesRoot}/${conversation}`;

        try {
          if (request.method === "POST" && url.pathname === "/prepare") {
            await run("ssh", ["hermes", `mkdir -p '${remoteBase}/inputs' '${remoteBase}/outputs'`]);
            sendJson(response, 200, {
              inputDirectory: `${remoteBase}/inputs`,
              outputDirectory: `${remoteBase}/outputs`,
            });
            return;
          }

          if (request.method === "POST" && url.pathname === "/upload") {
            const busboy = Busboy({
              headers: request.headers,
              defParamCharset: "utf8",
              limits: { fileSize: maxFileSize, files: 20 },
            });
            const uploads = [];
            const pending = [];
            busboy.on("file", (_field, stream, info) => {
              const originalName = safeFilename(info.filename);
              const storedName = `${randomUUID()}-${originalName}`;
              const localPath = path.join(tmpdir(), `hermes-${storedName}`);
              const promise = new Promise((resolve, reject) => {
                let size = 0;
                const output = createWriteStream(localPath, { flags: "wx" });
                stream.on("data", (chunk) => { size += chunk.length; });
                stream.on("limit", () => reject(new Error(`${originalName}: 100MB 제한을 초과했습니다.`)));
                stream.on("error", reject);
                output.on("error", reject);
                output.on("finish", () => resolve({ localPath, originalName, storedName, size, mime: info.mimeType }));
                stream.pipe(output);
              });
              pending.push(promise);
            });
            busboy.on("error", (error) => sendJson(response, 400, { error: error.message }));
            busboy.on("finish", async () => {
              try {
                const files = await Promise.all(pending);
                await run("ssh", ["hermes", `mkdir -p '${remoteBase}/inputs' '${remoteBase}/outputs'`]);
                for (const file of files) {
                  await run("scp", ["-q", file.localPath, `hermes:${remoteBase}/inputs/${file.storedName}`]);
                  await fs.unlink(file.localPath).catch(() => {});
                  uploads.push({
                    name: file.storedName,
                    originalName: file.originalName,
                    storedName: file.storedName,
                    size: file.size,
                    mime: file.mime,
                    scope: "inputs",
                    path: `${remoteBase}/inputs/${file.storedName}`,
                  });
                }
                sendJson(response, 200, { files: uploads, outputDirectory: `${remoteBase}/outputs` });
              } catch (error) {
                sendJson(response, 500, { error: error.message });
              }
            });
            request.pipe(busboy);
            return;
          }

          if (request.method === "GET" && url.pathname === "/list") {
            const script = [
              "import json, pathlib, mimetypes",
              `root=pathlib.Path(${JSON.stringify(remoteBase)})`,
              "items=[]",
              "for scope in ('inputs','outputs'):",
              " p=root/scope",
              " if p.exists():",
              "  for f in p.iterdir():",
              "   if f.is_file():",
              "    s=f.stat()",
              "    items.append({'name':f.name,'scope':scope,'size':s.st_size,'modified':s.st_mtime,'mime':mimetypes.guess_type(f.name)[0] or 'application/octet-stream','path':str(f)})",
              "print(json.dumps(sorted(items,key=lambda x:x['modified'])))",
            ].join("\n");
            const encodedScript = Buffer.from(script, "utf8").toString("base64");
            const remoteCommand = `/opt/hermes/.venv/bin/python3 -c "import base64;exec(base64.b64decode('${encodedScript}'))"`;
            const output = await run("ssh", ["hermes", remoteCommand]);
            sendJson(response, 200, { files: JSON.parse(output || "[]"), outputDirectory: `${remoteBase}/outputs` });
            return;
          }

          if (request.method === "GET" && url.pathname === "/download") {
            const scope = url.searchParams.get("scope");
            const name = url.searchParams.get("name");
            if (
              !["inputs", "outputs"].includes(scope) ||
              !name ||
              [".", ".."].includes(name) ||
              path.basename(name) !== name ||
              safeFilename(name) !== name
            ) {
              sendJson(response, 400, { error: "잘못된 파일 경로입니다." });
              return;
            }
            const remotePath = `${remoteBase}/${scope}/${name}`;
            const inline = url.searchParams.get("inline") === "1";
            response.setHeader("Content-Type", contentType(name));
            response.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
            response.setHeader("X-Content-Type-Options", "nosniff");
            const child = spawn("ssh", ["hermes", `cat -- '${remotePath}'`], { windowsHide: true });
            child.stdout.pipe(response);
            child.stderr.on("data", () => {});
            child.on("close", (code) => {
              if (code !== 0 && !response.headersSent) sendJson(response, 404, { error: "파일을 찾을 수 없습니다." });
              else if (code !== 0) response.destroy();
            });
            return;
          }

          if (request.method === "DELETE" && url.pathname === "/item") {
            const scope = url.searchParams.get("scope");
            const name = url.searchParams.get("name");
            if (
              !["inputs", "outputs"].includes(scope) ||
              !name ||
              [".", ".."].includes(name) ||
              path.basename(name) !== name ||
              safeFilename(name) !== name
            ) {
              sendJson(response, 400, { error: "잘못된 파일 경로입니다." });
              return;
            }
            await run("ssh", ["hermes", `rm -f -- '${remoteBase}/${scope}/${name}'`]);
            sendJson(response, 200, { removed: true });
            return;
          }

          next();
        } catch (error) {
          sendJson(response, 500, { error: error.message });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    officeBrandHtml(),
    fileBridge(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["hermes-mark.svg", "agent-office-open-topdown-v1.png", "agents/pixel-agent-atlas-v1.png"],
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [
          /^\/login(?:\/|\?|$)/,
          /^\/logout(?:\/|\?|$)/,
          /^\/bridge(?:\/|\?|$)/,
          /^\/hermes(?:\/|\?|$)/,
        ],
      },
      devOptions: {
        enabled: true,
      },
      manifest: {
        name: officeBrandName,
        short_name: officeBrandShortName,
        description: officeBrandDescription,
        theme_color: "#101b18",
        background_color: "#e7e0d3",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/hermes-mark.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/hermes": {
        target: hermesTarget,
        changeOrigin: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/hermes/, ""),
        headers: {
          "X-Forwarded-Prefix": "/hermes",
          "X-Forwarded-Proto": "http",
          "X-Forwarded-Host": "127.0.0.1:4173",
        },
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash]-office-map-v2.js",
        chunkFileNames: "assets/[name]-[hash]-office-map-v2.js",
      },
    },
  },
});
