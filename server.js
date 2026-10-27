"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const PORT = Number(process.env.BRI_PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "bris-cuisine-data.json");
const BACKUP_FILE = path.join(DATA_DIR, "bris-cuisine-data.backup.json");
const TEMP_FILE = path.join(DATA_DIR, "bris-cuisine-data.next.json");
const MAX_BODY = 10 * 1024 * 1024;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".pdf": "application/pdf"
};

function sendJSON(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function validState(value) {
  return value && Array.isArray(value.users) && Array.isArray(value.inventory) &&
    Array.isArray(value.sales) && Array.isArray(value.expenses) && Array.isArray(value.sessions);
}

function readDatabaseFile() {
  for (const filename of [DATA_FILE, BACKUP_FILE]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (parsed?.data == null || validState(parsed?.data)) return parsed;
    } catch { /* Try the recovery file. */ }
  }
  return { app: "BRIS_CUISINE", formatVersion: 1, savedAt: null, data: null };
}

function writeDatabaseFile(data) {
  if (!validState(data)) throw new Error("Invalid BRI data structure");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const document = JSON.stringify({ app: "BRIS_CUISINE", formatVersion: 1, savedAt: new Date().toISOString(), data }, null, 2);

  const descriptor = fs.openSync(TEMP_FILE, "w");
  try {
    fs.writeFileSync(descriptor, document, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, BACKUP_FILE); } catch { /* The current primary remains readable. */ }
  }
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

function collectBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body is too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function handleAPI(request, response, pathname) {
  if (pathname !== "/api/data") return false;
  if (request.method === "GET") {
    sendJSON(response, 200, readDatabaseFile());
    return true;
  }
  if (request.method === "POST") {
    try {
      const parsed = JSON.parse(await collectBody(request));
      writeDatabaseFile(parsed.data || parsed);
      sendJSON(response, 200, { ok: true, savedAt: new Date().toISOString() });
    } catch (error) {
      sendJSON(response, 400, { ok: false, error: error.message });
    }
    return true;
  }
  sendJSON(response, 405, { ok: false, error: "Method not allowed" });
  return true;
}

function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filename = path.resolve(ROOT, `.${requested}`);
  if (!filename.startsWith(ROOT + path.sep) || filename.startsWith(DATA_DIR + path.sep)) {
    response.writeHead(403); response.end("Forbidden"); return;
  }
  fs.readFile(filename, (error, content) => {
    if (error) { response.writeHead(error.code === "ENOENT" ? 404 : 500); response.end("Not found"); return; }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filename).toLowerCase()] || "application/octet-stream",
      "Cache-Control": path.extname(filename) === ".html" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://${HOST}:${PORT}`).pathname);
    if (await handleAPI(request, response, pathname)) return;
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end("Method not allowed"); return; }
    serveStatic(request, response, pathname);
  } catch (error) {
    sendJSON(response, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  const address = `http://${HOST}:${PORT}`;
  console.log("=======================================================");
  console.log(" BRI'S CUISINE is running offline");
  console.log(` Open: ${address}`);
  console.log(` JSON: ${DATA_FILE}`);
  console.log(" Keep this window open while the system is in use.");
  console.log(" Press Ctrl+C to stop at the end of the business day.");
  console.log("=======================================================");
  if (!process.argv.includes("--no-open")) {
    const child = spawn("cmd.exe", ["/c", "start", "", address], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") console.error(`Port ${PORT} is already in use. Close the other BRI launcher window and try again.`);
  else console.error(error.message);
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
