const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "work", "uploads");
const SAMPLE_FILE = path.join(ROOT, "data", "sample-rental-contract.txt");
const ANALYZER = path.join(ROOT, "backend", "analyze_contract.py");
const PORT = Number(process.env.PORT || 4173);
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const ANALYZE_TIMEOUT_MS = 300 * 1000;
const localVenvPython = path.join(ROOT, ".venv", "bin", "python");
const PYTHON =
  process.env.CONTRACTGUARD_PYTHON ||
  (fs.existsSync(localVenvPython) ? localVenvPython : null) ||
  "/Users/huynhquochuy/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function send(res, status, payload, headers = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  res.writeHead(status, {
    "Content-Length": body.length,
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function safeFileName(value) {
  return path
    .basename(value || "contract.txt")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .slice(0, 120);
}

function readBody(req, limitBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("File quá lớn. Prototype hiện giới hạn 80MB cho mỗi lần phân tích."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  return match ? match[1] || match[2] : "";
}

function parseContentDisposition(value) {
  const result = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawValue.length) continue;
    const key = rawKey.toLowerCase();
    result[key] = rawValue.join("=").replace(/^"|"$/g, "");
  }
  return result;
}

function trimPartCrlf(buffer) {
  let start = 0;
  let end = buffer.length;
  if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
  if (buffer[end - 2] === 13 && buffer[end - 1] === 10) end -= 2;
  return buffer.slice(start, end);
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const headerBreak = Buffer.from("\r\n\r\n");
  const parts = {};
  let cursor = buffer.indexOf(delimiter);

  while (cursor !== -1) {
    const next = buffer.indexOf(delimiter, cursor + delimiter.length);
    if (next === -1) break;

    const rawPart = trimPartCrlf(buffer.slice(cursor + delimiter.length, next));
    cursor = next;

    if (!rawPart.length || rawPart[0] === 45) continue;
    const headerEnd = rawPart.indexOf(headerBreak);
    if (headerEnd === -1) continue;

    const rawHeaders = rawPart.slice(0, headerEnd).toString("latin1");
    const content = rawPart.slice(headerEnd + headerBreak.length);
    const headers = Object.fromEntries(
      rawHeaders
        .split("\r\n")
        .map((line) => line.split(":"))
        .filter((pair) => pair.length >= 2)
        .map(([key, ...rest]) => [key.toLowerCase(), rest.join(":").trim()])
    );
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    if (!disposition.name) continue;

    parts[disposition.name] = {
      filename: disposition.filename,
      contentType: headers["content-type"],
      content,
      text: content.toString("utf8"),
    };
  }

  return parts;
}

function analyzeFile(filePath, filename, contractType = "") {
  return new Promise((resolve, reject) => {
    let settled = false;
    console.log(`\n[INFO] Khởi chạy tiến trình Python để phân tích tệp: ${filename} (Loại: ${contractType})`);
    const child = spawn(PYTHON, [
      ANALYZER,
      "--input",
      filePath,
      "--filename",
      filename,
      "--contract-type",
      contractType,
    ]);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      console.error(`[TIMEOUT] Tiến trình phân tích ${filename} vượt quá giới hạn 300 giây.`);
      reject(new Error("Phân tích quá 300 giây. Hãy thử PDF scan rõ hơn, giảm số trang hoặc chia file thành từng phần nhỏ hơn."));
    }, ANALYZE_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      // In log thời gian thực từ Python ra Node.js console
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.log(`  [PYTHON] ${line.trim()}`);
        }
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.error(`[ERROR] Lỗi khởi chạy tiến trình Python:`, error);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        console.error(`[ERROR] Tiến trình Python thoát với mã lỗi ${code}`);
        reject(new Error((stderr || `Analyzer exited with code ${code}`).trim()));
        return;
      }
      try {
        console.log(`[INFO] Hoàn thành phân tích thành công tệp: ${filename}`);
        resolve(JSON.parse(stdout));
      } catch (error) {
        console.error(`[ERROR] Lỗi phân giải JSON kết quả:`, error.message);
        reject(new Error(`Không đọc được JSON từ analyzer: ${error.message}`));
      }
    });
  });
}

async function handleAnalyze(req, res) {
  let filePath = SAMPLE_FILE;
  try {
    const contentType = req.headers["content-type"] || "";
    const buffer = await readBody(req);
    let filename = "sample-rental-contract.txt";
    let contractType = "Hợp đồng thuê nhà";

    if (contentType.includes("multipart/form-data")) {
      const boundary = parseBoundary(contentType);
      if (!boundary) throw new Error("Thiếu boundary trong multipart form.");
      const parts = parseMultipart(buffer, boundary);
      contractType = compactField(parts.contractType?.text) || contractType;

      if (compactField(parts.useSample?.text) !== "true" && parts.file?.content?.length) {
        filename = safeFileName(parts.file.filename || "uploaded-contract.txt");
        const id = crypto.randomBytes(6).toString("hex");
        filePath = path.join(UPLOAD_DIR, `${Date.now()}-${id}-${filename}`);
        fs.writeFileSync(filePath, parts.file.content);
      }
    } else if (contentType.includes("application/json")) {
      const body = JSON.parse(buffer.toString("utf8") || "{}");
      if (body.text) {
        filename = safeFileName(body.fileName || "pasted-contract.txt");
        contractType = body.contractType || contractType;
        filePath = path.join(UPLOAD_DIR, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${filename}`);
        fs.writeFileSync(filePath, body.text, "utf8");
      }
    }

    const result = await analyzeFile(filePath, filename, contractType);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 400, {
      error: "Không thể phân tích hợp đồng",
      detail: error.message,
    });
  } finally {
    if (filePath !== SAMPLE_FILE) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.error(`Không thể xóa file tạm ${filePath}:`, err);
      }
    }
  }
}

function compactField(value = "") {
  return String(value).replace(/\0/g, "").trim();
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  const target = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!target.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  fs.readFile(target, (error, data) => {
    if (error) {
      send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    send(res, 200, data, {
      "Content-Type": MIME_TYPES[path.extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/analyze") {
    handleAnalyze(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/analyze-sample") {
    analyzeFile(SAMPLE_FILE, "sample-rental-contract.txt", "Hợp đồng thuê nhà")
      .then((result) => sendJson(res, 200, result))
      .catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  send(res, 405, "Method not allowed", { "Content-Type": "text/plain; charset=utf-8" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ContractGuard AI running at http://localhost:${PORT}`);
});
