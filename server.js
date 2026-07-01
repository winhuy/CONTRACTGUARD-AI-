const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join("=").trim().replace(/^['"]|['"]$/g, "");
        process.env[key] = value;
      }
    }
  }
}
loadEnv();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "work", "uploads");
const SAMPLE_FILE = path.join(ROOT, "data", "sample-rental-contract.txt");
const ANALYZER = path.join(ROOT, "backend", "analyze_contract.py");
const PORT = Number(process.env.PORT || 4173);
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const ANALYZE_TIMEOUT_MS = 300 * 1000;
const ANALYSIS_CACHE_LIMIT = 24;
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

const analysisCache = new Map();

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

function analysisCacheKey(filePath, contractType) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  hash.update("\0");
  hash.update(contractType || "");
  hash.update("\0");
  hash.update(String(fs.statSync(ANALYZER).mtimeMs));
  return hash.digest("hex");
}

function cloneAnalysisResult(result, filename) {
  const cloned = JSON.parse(JSON.stringify(result));
  cloned.fileName = filename;
  return cloned;
}

function rememberAnalysis(cacheKey, result) {
  analysisCache.set(cacheKey, result);
  if (analysisCache.size <= ANALYSIS_CACHE_LIMIT) return;
  const oldestKey = analysisCache.keys().next().value;
  if (oldestKey) analysisCache.delete(oldestKey);
}

function analyzeFile(filePath, filename, contractType = "") {
  const cacheKey = analysisCacheKey(filePath, contractType);
  const cached = analysisCache.get(cacheKey);
  if (cached) {
    console.log(`\n[INFO] Dùng lại kết quả đã cache cho tệp: ${filename} (Loại: ${contractType})`);
    return Promise.resolve(cloneAnalysisResult(cached, filename));
  }

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
        const parsed = JSON.parse(stdout);
        rememberAnalysis(cacheKey, parsed);
        resolve(cloneAnalysisResult(parsed, filename));
      } catch (error) {
        console.error(`[ERROR] Lỗi phân giải JSON kết quả:`, error.message);
        reject(new Error(`Không đọc được JSON từ analyzer: ${error.message}`));
      }
    });
  });
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// ── Web Search via DuckDuckGo Instant Answer API ──────────────────────────
async function webSearch(query) {
  const https = require("https");
  const encoded = encodeURIComponent(query);
  return new Promise((resolve) => {
    const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const opts = { headers: { "User-Agent": "ContractGuard-AI/1.0" }, timeout: 8000 };
    const req = https.get(url, opts, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(raw);
          const parts = [];
          if (data.AbstractText) parts.push(`Tóm tắt: ${data.AbstractText} (${data.AbstractURL || ""})`);
          if (data.Answer) parts.push(`Câu trả lời nhanh: ${data.Answer}`);
          (data.RelatedTopics || []).slice(0, 4).forEach((t) => {
            if (t.Text) parts.push(`- ${t.Text}`);
          });
          resolve(parts.length ? parts.join("\n") : "");
        } catch {
          resolve("");
        }
      });
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

// ── Build full contract + analysis system context ─────────────────────────
function buildFullContext(analysis, contractType) {
  if (!analysis) return "Chưa có dữ liệu hợp đồng.";
  const lines = [];

  // Contract summary
  const s = analysis.summary || {};
  lines.push(`=== THÔNG TIN HỢP ĐỒNG ===`);
  lines.push(`Loại: ${contractType || "Hợp đồng"}`);
  lines.push(`Tên file: ${analysis.fileName || "N/A"}`);
  lines.push(`Điểm rủi ro tổng thể: ${s.riskScore ?? "N/A"}/100`);
  lines.push(`Đánh giá: ${s.riskLevel || "N/A"}`);
  if (s.summary) lines.push(`Tóm tắt: ${s.summary}`);

  // Findings
  const findings = analysis.findings || [];
  if (findings.length) {
    lines.push(`\n=== CÁC THẺ RỦI RO (${findings.length} thẻ) ===`);
    findings.forEach((f, i) => {
      const level = f.muc_do_rui_ro || "N/A";
      lines.push(`\n[${i + 1}] ${level} – ${f.muc_ra_soat || ""}`);
      if (f.giai_thich_binh_dan) lines.push(`  Giải thích: ${f.giai_thich_binh_dan}`);
      if (f.goi_y_dam_phan) lines.push(`  Đề xuất: ${f.goi_y_dam_phan}`);
      const rewrite = f.cau_sua_bo_sung || f.rewriteSuggestion || "";
      if (rewrite) lines.push(`  Câu sửa: ${rewrite}`);
      if (f.co_so_phap_ly) lines.push(`  Cơ sở pháp lý: ${f.co_so_phap_ly}`);
      if (f.van_ban_goc_highlight) lines.push(`  Đoạn gốc: "${f.van_ban_goc_highlight}"`);
    });
  }

  // Deep analysis
  const deep = analysis.deepAnalysis;
  if (deep) {
    lines.push(`\n=== DEEP ANALYSIS ===`);
    if (deep.readiness) {
      lines.push(`Mức sẵn sàng ký: ${deep.readiness.label} (${deep.readiness.score}/100)`);
      if (deep.readiness.reason) lines.push(`Lý do: ${deep.readiness.reason}`);
    }
    if (deep.financialExposure?.display) {
      const exp = deep.financialExposure.display;
      lines.push(`Tiền cọc: ${exp.deposit || "N/A"}, Phạt: ${exp.possiblePenalty || "N/A"}, Ước tính rủi ro: ${exp.estimatedExposure || "N/A"}`);
    }
    (deep.timeline || []).forEach((t) => {
      lines.push(`Timeline – ${t.label}: ${t.value} (${t.risk})`);
    });
    (deep.missingClauses || []).forEach((m) => {
      lines.push(`Thiếu điều khoản: ${m.title} – ${m.advice}`);
    });
    if (deep.scoringFramework) {
      const fw = deep.scoringFramework;
      lines.push(`Điểm: ${fw.baseScore} - ${fw.penaltyPoints} + ${fw.greenCredit} = ${s.riskScore}`);
    }
  }

  // Contract raw text (trimmed to keep context manageable)
  if (analysis.text) {
    const trimmed = analysis.text.slice(0, 6000);
    lines.push(`\n=== NỘI DUNG HỢP ĐỒNG (trích) ===\n${trimmed}${analysis.text.length > 6000 ? "\n...(đã cắt bớt)" : ""}`);
  }

  return lines.join("\n");
}

async function handleChat(req, res) {
  try {
    const bodyBuffer = await readBody(req);
    const body = JSON.parse(bodyBuffer.toString("utf8") || "{}");
    const { query, history = [], analysis, contractType, enableWebSearch = true } = body;

    if (!query) return sendJson(res, 400, { error: "Thiếu câu hỏi." });
    if (!GROQ_API_KEY) return sendJson(res, 400, { error: "Chưa cấu hình GROQ_API_KEY trong file .env." });

    // ── Web search (async, non-blocking) ──
    let webSnippet = "";
    if (enableWebSearch) {
      webSnippet = await webSearch(`${query} luật Việt Nam`);
    }

    // ── Build full context from analysis data ──
    const contractContext = buildFullContext(analysis, contractType);

    // ── System prompt ──
    const systemPrompt = [
      `Bạn là **ContractGuard AI** – trợ lý pháp lý thông minh chuyên phân tích hợp đồng Việt Nam.`,
      `Bạn có khả năng đọc toàn bộ nội dung hợp đồng, các thẻ rủi ro (Đỏ/Vàng/Xanh), deep analysis và kết quả tìm kiếm web.`,
      ``,
      `=== DỮ LIỆU HỢP ĐỒNG VÀ BÁO CÁO ===`,
      contractContext,
      webSnippet ? `\n=== KẾT QUẢ TÌM KIẾM WEB ===\n${webSnippet}` : "",
      ``,
      `=== HƯỚNG DẪN TRẢ LỜI ===`,
      `1. Đọc kỹ TOÀN BỘ dữ liệu hợp đồng và báo cáo ở trên trước khi trả lời.`,
      `2. Trả lời câu hỏi dựa trên: (a) nội dung hợp đồng thực tế, (b) các thẻ rủi ro, (c) luật Việt Nam hiện hành, (d) kết quả web nếu có.`,
      `3. Khi trả lời về quy định pháp luật: trích dẫn điều luật cụ thể (BLDS 2015, Luật Nhà ở 2023, Luật Thương mại 2005...) và so sánh với điều khoản hợp đồng hiện tại.`,
      `4. Định dạng câu trả lời bằng Markdown: dùng **in đậm**, danh sách - hoặc 1. 2. 3., trích dẫn > để làm nổi bật điều khoản hợp đồng gốc.`,
      `5. Cuối câu trả lời, nếu có rủi ro quan trọng chưa được hỏi, hãy proactively đề cập.`,
      `6. Ngôn ngữ: Tiếng Việt, giọng chuyên nghiệp, ngắn gọn nhưng đầy đủ.`,
    ].filter(Boolean).join("\n");

    // ── Multi-turn message history ──
    const messages = [{ role: "system", content: systemPrompt }];

    // Append prior conversation turns (max 10 turns to save tokens)
    const recentHistory = (history || []).slice(-20);
    for (const msg of recentHistory) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.text || msg.content || "" });
      }
    }

    // Current user query
    messages.push({ role: "user", content: query });

    const requestData = JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 1500,
    });

    const https = require("https");
    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(requestData),
      },
      timeout: 25000,
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = "";
      apiRes.on("data", (chunk) => { data += chunk; });
      apiRes.on("end", () => {
        if (apiRes.statusCode >= 400) {
          console.error("Groq API error:", data);
          return sendJson(res, 500, { error: "Lỗi từ Groq API.", detail: data.slice(0, 300) });
        }
        try {
          const parsed = JSON.parse(data);
          const answer = parsed.choices?.[0]?.message?.content || "";
          const usedWebSearch = !!webSnippet;
          sendJson(res, 200, { answer, usedWebSearch });
        } catch (e) {
          sendJson(res, 500, { error: "Không phân tích được response từ Groq.", detail: e.message });
        }
      });
    });

    apiReq.on("error", (error) => {
      console.error("HTTPS request error:", error.message);
      sendJson(res, 500, { error: "Lỗi kết nối mạng tới Groq.", detail: error.message });
    });

    apiReq.on("timeout", () => {
      apiReq.destroy();
      sendJson(res, 504, { error: "Groq API timeout sau 25 giây." });
    });

    apiReq.write(requestData);
    apiReq.end();

  } catch (error) {
    console.error("handleChat error:", error.message);
    sendJson(res, 500, { error: "Lỗi hệ thống.", detail: error.message });
  }
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

  if (req.method === "POST" && req.url === "/api/chat") {
    handleChat(req, res);
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
