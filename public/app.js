// Particle animation variables declared at top to avoid TDZ (Temporal Dead Zone) issues
var pCanvas, pCtx, pAnimFrameId;
var pParticles = [];

const state = {
  analysis: null,
  activeFilter: "ALL",
  contractType: "Hợp đồng thuê nhà",
  pendingFile: null,
  loadingTimer: null,
  activeView: "intro",
};

const MAX_FILE_BYTES = 80 * 1024 * 1024;
const DEFAULT_FILE_LABEL = "Chọn DOCX, TXT hoặc PDF";
const DEFAULT_FILE_SUBLABEL = "80MB tối đa";

const severity = {
  RED: { label: "Đỏ", weight: 3, summary: "Rủi ro cao cần sửa trước khi ký" },
  YELLOW: { label: "Vàng", weight: 2, summary: "Điểm mơ hồ cần thương lượng" },
  GREEN: { label: "Xanh", weight: 1, summary: "Điểm đang tương đối an toàn" },
};

const selectors = {
  introView: document.querySelector("#introView"),
  reportView: document.querySelector("#reportView"),
  homeBtn: document.querySelector("#homeBtn"),
  heroFileInput: document.querySelector("#heroFileInput"),
  heroFileLabel: document.querySelector("#heroFileLabel"),
  heroFileSubLabel: document.querySelector("#heroFileSubLabel"),
  heroDropzone: document.querySelector("#heroDropzone"),
  heroScanBtn: document.querySelector("#heroScanBtn"),
  heroPasteBtn: document.querySelector("#heroPasteBtn"),
  heroSampleBtn: document.querySelector("#heroSampleBtn"),
  fileInput: document.querySelector("#fileInput"),
  fileLabel: document.querySelector("#fileLabel"),
  fileSubLabel: document.querySelector("#fileSubLabel"),
  dropzone: document.querySelector("#dropzone"),
  scanBtn: document.querySelector("#scanBtn"),
  sampleBtn: document.querySelector("#sampleBtn"),
  pasteBtn: document.querySelector("#pasteBtn"),
  pasteDialog: document.querySelector("#pasteDialog"),
  pasteForm: document.querySelector("#pasteForm"),
  pasteText: document.querySelector("#pasteText"),
  exportBtn: document.querySelector("#exportBtn"),
  documentTitle: document.querySelector("#documentTitle"),
  documentViewer: document.querySelector("#documentViewer"),
  categoryCount: document.querySelector("#categoryCount"),
  privacyStatus: document.querySelector("#privacyStatus"),
  scoreRing: document.querySelector("#scoreRing"),
  scoreValue: document.querySelector("#scoreValue"),
  riskLevel: document.querySelector("#riskLevel"),
  riskSummary: document.querySelector("#riskSummary"),
  countAll: document.querySelector("#countAll"),
  countRed: document.querySelector("#countRed"),
  countYellow: document.querySelector("#countYellow"),
  countGreen: document.querySelector("#countGreen"),
  pipeline: document.querySelector("#pipeline"),
  deepInsights: document.querySelector("#deepInsights"),
  findingsList: document.querySelector("#findingsList"),
  disclaimer: document.querySelector("#disclaimer"),
  toast: document.querySelector("#toast"),
};

function showIntro() {
  state.activeView = "intro";
  document.body.classList.add("intro-mode");
  selectors.introView.classList.remove("is-hidden");
  selectors.reportView.classList.add("is-hidden");
  selectors.homeBtn.disabled = true;
  selectors.exportBtn.disabled = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
  initParticles();
}

function showReport() {
  state.activeView = "report";
  document.body.classList.remove("intro-mode");
  selectors.introView.classList.add("is-hidden");
  selectors.reportView.classList.remove("is-hidden");
  selectors.homeBtn.disabled = false;
  selectors.exportBtn.disabled = !state.analysis;
  window.scrollTo({ top: 0, behavior: "smooth" });
  stopParticles();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function showToast(message) {
  selectors.toast.textContent = message;
  selectors.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => selectors.toast.classList.remove("is-visible"), 2600);
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function setFileLabels(label, subLabel) {
  selectors.fileLabel.textContent = label;
  selectors.fileSubLabel.textContent = subLabel;
  selectors.heroFileLabel.textContent = label;
  selectors.heroFileSubLabel.textContent = subLabel;
}

function loadingMessageForFile(file) {
  if (/\.pdf$/i.test(file.name)) {
    return "Đang trích xuất chữ từ PDF. Nếu là PDF scan ảnh, OCR tiếng Việt có thể mất 1-3 phút cho 30-40 trang.";
  }
  return "Đang đọc nội dung hợp đồng và đối chiếu với checklist rủi ro.";
}

function renderProcessingState(title, message) {
  state.analysis = null;
  selectors.scoreRing.style.setProperty("--score", 0);
  selectors.scoreValue.textContent = "--";
  selectors.riskLevel.textContent = "Đang phân tích";
  selectors.riskSummary.textContent = message;
  selectors.countAll.textContent = "0";
  selectors.countRed.textContent = "0";
  selectors.countYellow.textContent = "0";
  selectors.countGreen.textContent = "0";
  selectors.documentTitle.textContent = title;
  selectors.categoryCount.textContent = "40 hạng mục";
  selectors.privacyStatus.textContent = "Đang ẩn PII";
  selectors.disclaimer.textContent = "Đang phân tích, vui lòng giữ tab này mở cho đến khi có báo cáo.";
  selectors.deepInsights.innerHTML = `
    <div class="empty-state compact">
      <strong>Đang chạy deep scan</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  selectors.findingsList.innerHTML = `
    <div class="empty-state compact">
      <strong>Đang tạo thẻ hành động</strong>
      <span>Hệ thống đang tìm điều khoản Đỏ, Vàng và Xanh.</span>
    </div>
  `;
  selectors.documentViewer.innerHTML = `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  selectors.exportBtn.disabled = true;
  showReport();
}

function renderErrorState(message) {
  state.analysis = null;
  selectors.scoreRing.style.setProperty("--score", 0);
  selectors.scoreValue.textContent = "--";
  selectors.riskLevel.textContent = "Không phân tích được";
  selectors.riskSummary.textContent = message;
  selectors.countAll.textContent = "0";
  selectors.countRed.textContent = "0";
  selectors.countYellow.textContent = "0";
  selectors.countGreen.textContent = "0";
  selectors.categoryCount.textContent = "40 hạng mục";
  selectors.privacyStatus.textContent = "Chưa xử lý PII";
  selectors.deepInsights.innerHTML = `
    <div class="empty-state compact">
      <strong>Cần file có lớp chữ</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  selectors.findingsList.innerHTML = `
    <div class="empty-state compact">
      <strong>Chưa tạo được thẻ rủi ro</strong>
      <span>Hãy thử PDF có text layer, DOCX hoặc dán trực tiếp nội dung hợp đồng.</span>
    </div>
  `;
  selectors.documentViewer.innerHTML = `
    <div class="empty-state">
      <strong>Không đọc được nội dung</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  selectors.disclaimer.textContent = "PDF scan ảnh cần ảnh rõ, thẳng trang và đủ tương phản để OCR nhận chữ chính xác.";
  selectors.exportBtn.disabled = true;
  showReport();
}

function setLoading(isLoading) {
  document.body.classList.toggle("is-loading", isLoading);
  selectors.scanBtn.disabled = isLoading || !state.pendingFile;
  selectors.heroScanBtn.disabled = isLoading || !state.pendingFile;
  selectors.sampleBtn.disabled = isLoading;
  selectors.heroSampleBtn.disabled = isLoading;
  selectors.pasteBtn.disabled = isLoading;
  selectors.heroPasteBtn.disabled = isLoading;
  selectors.exportBtn.disabled = isLoading || !state.analysis;
  selectors.scanBtn.textContent = isLoading ? "Đang quét" : "Quét rủi ro";
  selectors.heroScanBtn.textContent = isLoading ? "Đang quét" : "Quét rủi ro";

  const steps = [...selectors.pipeline.querySelectorAll(".pipeline-step")];
  window.clearInterval(state.loadingTimer);
  steps.forEach((step, index) => step.classList.toggle("is-active", index === 0));

  if (!isLoading) return;
  let active = 0;
  state.loadingTimer = window.setInterval(() => {
    active = (active + 1) % steps.length;
    steps.forEach((step, index) => step.classList.toggle("is-active", index <= active));
  }, 430);
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || "Không thể xử lý yêu cầu");
  }
  return payload;
}

async function analyzeSample() {
  renderProcessingState("Đang quét hợp đồng mẫu", "Đang tải hợp đồng mẫu và tạo báo cáo demo.");
  setLoading(true);
  try {
    const result = await fetch("/api/analyze-sample").then(readJson);
    state.analysis = result;
    state.pendingFile = null;
    setFileLabels(DEFAULT_FILE_LABEL, DEFAULT_FILE_SUBLABEL);
    render();
    showToast("Đã tải báo cáo demo");
  } catch (error) {
    renderErrorState(error.message);
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

async function analyzePendingFile() {
  if (!state.pendingFile) return;
  renderProcessingState(`Đang quét ${state.pendingFile.name}`, loadingMessageForFile(state.pendingFile));
  setLoading(true);
  try {
    const formData = new FormData();
    formData.append("file", state.pendingFile);
    formData.append("contractType", state.contractType);
    const result = await fetch("/api/analyze", { method: "POST", body: formData }).then(readJson);
    state.analysis = result;
    render();
    showToast("Đã hoàn tất phân tích");
  } catch (error) {
    renderErrorState(error.message);
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

async function analyzePastedText(text) {
  renderProcessingState("Đang quét nội dung dán", "Đang đọc nội dung đã dán và tạo báo cáo rủi ro.");
  setLoading(true);
  try {
    const result = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        fileName: "pasted-contract.txt",
        contractType: state.contractType,
      }),
    }).then(readJson);
    state.analysis = result;
    render();
    showToast("Đã phân tích nội dung dán");
  } catch (error) {
    renderErrorState(error.message);
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

function riskLabel(overallRisk) {
  if (overallRisk === "HIGH") return "Rủi ro cao";
  if (overallRisk === "MEDIUM") return "Rủi ro trung bình";
  return "Rủi ro thấp";
}

function renderSummary() {
  const analysis = state.analysis;
  if (!analysis) return;

  const { summary } = analysis;
  const counts = summary.counts;
  const total = counts.RED + counts.YELLOW + counts.GREEN;
  selectors.scoreRing.style.setProperty("--score", summary.riskScore);
  selectors.scoreValue.textContent = summary.riskScore;
  selectors.riskLevel.textContent = riskLabel(summary.overallRisk);
  const readiness = analysis.deepAnalysis?.readiness?.label;
  selectors.riskSummary.textContent = `${counts.RED} Đỏ, ${counts.YELLOW} Vàng, ${counts.GREEN} Xanh sau khi quét ${summary.scannedCategories} hạng mục.${readiness ? ` ${readiness}.` : ""}`;
  selectors.countAll.textContent = total;
  selectors.countRed.textContent = counts.RED;
  selectors.countYellow.textContent = counts.YELLOW;
  selectors.countGreen.textContent = counts.GREEN;
  selectors.documentTitle.textContent = analysis.fileName;
  selectors.categoryCount.textContent = `${summary.scannedCategories} hạng mục`;
  selectors.privacyStatus.textContent = `Đã ẩn ${summary.piiItemsRedacted} PII`;
  selectors.disclaimer.textContent = analysis.disclaimer;
}

function renderDeepInsights() {
  const deep = state.analysis?.deepAnalysis;
  if (!deep) return;

  const exposure = deep.financialExposure?.display || {};
  const timeline = deep.timeline || [];
  const missing = deep.missingClauses || [];
  const priorities = deep.priorityActions || [];

  selectors.deepInsights.innerHTML = `
    <div class="insight-head">
      <div>
        <p class="eyebrow">Deep scan</p>
        <h2>${escapeHtml(deep.readiness.label)}</h2>
      </div>
      <span class="readiness-chip">${escapeHtml(String(deep.readiness.score))}/100</span>
    </div>
    <p class="insight-reason">${escapeHtml(deep.readiness.reason)}</p>
    <div class="insight-metrics">
      <div class="metric-card">
        <span>Tiền cọc</span>
        <strong>${escapeHtml(exposure.deposit || "Chưa xác định")}</strong>
      </div>
      <div class="metric-card">
        <span>Phạt dự kiến</span>
        <strong>${escapeHtml(exposure.possiblePenalty || "Chưa xác định")}</strong>
      </div>
      <div class="metric-card metric-card-wide">
        <span>Ước tính đang chịu rủi ro</span>
        <strong>${escapeHtml(exposure.estimatedExposure || "Chưa xác định")}</strong>
      </div>
    </div>
    <div class="deep-columns">
      <div class="deep-block">
        <h3>Timeline nghĩa vụ</h3>
        ${timeline.length ? timeline.map((item) => `
          <div class="timeline-row">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(item.value)}</strong>
            <small>${escapeHtml(item.risk)}</small>
          </div>
        `).join("") : `<p class="muted-line">Chưa trích xuất được mốc thời gian quan trọng.</p>`}
      </div>
      <div class="deep-block">
        <h3>Điều khoản nên bổ sung</h3>
        ${missing.length ? missing.map((item) => `
          <div class="missing-row">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.advice)}</span>
          </div>
        `).join("") : `<p class="muted-line">Chưa thấy khoảng trống lớn trong bộ rule hiện tại.</p>`}
      </div>
    </div>
    <div class="priority-strip">
      ${priorities.map((item, index) => `
        <button class="priority-action ${item.severity}" type="button" data-priority-index="${index}">
          <span>${escapeHtml(severity[item.severity].label)}</span>
          <strong>${escapeHtml(item.title)}</strong>
        </button>
      `).join("")}
    </div>
  `;
}

function splitParagraphs(text) {
  return String(text || "")
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sortedFindings() {
  return [...(state.analysis?.findings || [])].sort((a, b) => {
    return severity[b.muc_do_rui_ro].weight - severity[a.muc_do_rui_ro].weight;
  });
}

function findingRewriteText(finding) {
  return compact(finding.cau_sua_bo_sung || finding.rewriteSuggestion || finding.goi_y_dam_phan || "");
}

function renderLegalReferences(finding) {
  const references = Array.isArray(finding.legalReferences)
    ? finding.legalReferences.filter((ref) => ref && ref.url && ref.label)
    : [];

  if (!references.length) {
    return `
      <div class="finding-meta">
        <span>Cơ sở: ${escapeHtml(finding.co_so_phap_ly || "Đang cập nhật")}</span>
        <span>Độ tin cậy: ${Math.round(finding.confidence * 100)}%</span>
      </div>
    `;
  }

  return `
    <div class="legal-links">
      <strong>Căn cứ pháp lý</strong>
      <div class="legal-link-list">
        ${references.map((ref) => `
          <a class="legal-link" href="${escapeHtml(ref.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(ref.title || ref.label)}">
            ${escapeHtml(ref.label)}
          </a>
        `).join("")}
      </div>
      <span>${escapeHtml(finding.co_so_phap_ly || "Mở liên kết để xem điều luật cụ thể")}</span>
    </div>
    <div class="finding-meta compact-meta">
      <span>Độ tin cậy: ${Math.round(finding.confidence * 100)}%</span>
    </div>
  `;
}

function findingForParagraph(paragraph) {
  const para = compact(paragraph);
  return sortedFindings().find((finding) => {
    const quote = compact(finding.van_ban_goc_highlight);
    return quote && para.includes(quote);
  });
}

function renderParagraph(paragraph, index) {
  const isPageIndicator = /^\[Trang \d+(?:\s*-\s*OCR)?\]/i.test(paragraph);
  if (isPageIndicator) {
    return `<div class="doc-page-indicator">${escapeHtml(paragraph)}</div>`;
  }

  const finding = findingForParagraph(paragraph);
  const centerish = /^(?:HỢP ĐỒNG|CỘNG HÒA|ĐỘC LẬP|ĐỀ NGHỊ|THỎA THUẬN|BIÊN BẢN|CAM KẾT|QUYẾT ĐỊNH|BẢN CAM KẾT|GIẤY)/i.test(paragraph.trim());

  if (!finding) {
    return `<p class="doc-paragraph${centerish ? " centerish" : ""}">${escapeHtml(paragraph)}</p>`;
  }

  const quote = compact(finding.van_ban_goc_highlight);
  const exactIndex = paragraph.indexOf(quote);
  const mark = (value) =>
    `<mark class="risk-mark ${finding.muc_do_rui_ro}" data-finding-id="${finding.id}" id="hl-${finding.id}">${escapeHtml(value)}</mark>`;

  let html;
  if (exactIndex >= 0) {
    html =
      escapeHtml(paragraph.slice(0, exactIndex)) +
      mark(paragraph.slice(exactIndex, exactIndex + quote.length)) +
      escapeHtml(paragraph.slice(exactIndex + quote.length));
  } else {
    html = mark(paragraph);
  }

  return `<p class="doc-paragraph${centerish ? " centerish" : ""}">${html}</p>`;
}

function renderDocument() {
  const analysis = state.analysis;
  if (!analysis) return;
  const paragraphs = splitParagraphs(analysis.text);
  selectors.documentViewer.innerHTML = `
    <div class="document-pages">
      ${paragraphs.map(renderParagraph).join("")}
    </div>
  `;
}

function renderFindings() {
  const analysis = state.analysis;
  if (!analysis) return;
  const findings = sortedFindings().filter((finding) => {
    return state.activeFilter === "ALL" || finding.muc_do_rui_ro === state.activeFilter;
  });

  if (!findings.length) {
    selectors.findingsList.innerHTML = `
      <div class="empty-state compact">
        <strong>Không có thẻ trong bộ lọc này</strong>
        <span>Chọn bộ lọc khác để xem tiếp.</span>
      </div>
    `;
    return;
  }

  selectors.findingsList.innerHTML = findings
    .map((finding) => {
      const level = severity[finding.muc_do_rui_ro];
      const rewriteText = findingRewriteText(finding);
      return `
        <article class="finding-card ${finding.muc_do_rui_ro}" data-finding-id="${finding.id}">
          <div class="finding-head">
            <h3>${escapeHtml(finding.muc_ra_soat)}</h3>
            <div class="badges">
              <span class="priority-badge">${escapeHtml(finding.impact?.priority || "P3")}</span>
              <span class="severity-badge ${finding.muc_do_rui_ro}">${level.label}</span>
            </div>
          </div>
          <p>${escapeHtml(finding.giai_thich_binh_dan)}</p>
          <div class="impact-grid">
            <span><strong>Bị ảnh hưởng</strong>${escapeHtml(finding.impact?.affectedParty || "Người ký")}</span>
            <span><strong>Exposure</strong>${escapeHtml(finding.impact?.financialExposure || "Không định lượng trực tiếp")}</span>
          </div>
          <div class="suggestion-box">
            <strong>Câu đề xuất</strong>
            <span>${escapeHtml(finding.goi_y_dam_phan)}</span>
          </div>
          <div class="suggestion-box rewrite-box">
            <strong>Câu sửa bổ sung</strong>
            <span>${escapeHtml(rewriteText)}</span>
          </div>
          ${renderLegalReferences(finding)}
          <div class="card-actions">
            <button class="mini-btn jump-btn" type="button" data-finding-id="${finding.id}" ${
        finding.van_ban_goc_highlight ? "" : "disabled"
      }>Tới đoạn gốc</button>
            <button class="mini-btn copy-btn" type="button" data-copy="${escapeHtml(rewriteText)}">Copy câu sửa</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function render() {
  renderSummary();
  renderDeepInsights();
  renderDocument();
  renderFindings();
  selectors.exportBtn.disabled = !state.analysis;
}

function setPendingFile(file) {
  state.pendingFile = file || null;
  selectors.scanBtn.disabled = !file;
  selectors.heroScanBtn.disabled = !file;
  if (!file) {
    setFileLabels(DEFAULT_FILE_LABEL, DEFAULT_FILE_SUBLABEL);
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    state.pendingFile = null;
    selectors.scanBtn.disabled = true;
    selectors.heroScanBtn.disabled = true;
    selectors.fileInput.value = "";
    selectors.heroFileInput.value = "";
    setFileLabels("File vượt 80MB", "Hãy nén PDF hoặc chia file để phân tích");
    showToast("File vượt 80MB. Hãy nén PDF hoặc chia thành từng phần nhỏ hơn.");
    return;
  }
  setFileLabels(file.name, formatBytes(file.size));
}

function scrollToFinding(id) {
  const highlight = document.querySelector(`#hl-${CSS.escape(id)}`);
  if (!highlight) {
    showToast("Thẻ này không có đoạn highlight trực tiếp");
    return;
  }
  highlight.scrollIntoView({ behavior: "smooth", block: "center" });
  highlight.animate(
    [
      { outline: "0 solid transparent" },
      { outline: "4px solid rgba(15, 118, 110, 0.28)" },
      { outline: "0 solid transparent" },
    ],
    { duration: 900 }
  );
}

function bindEvents() {
  selectors.homeBtn.addEventListener("click", showIntro);
  selectors.heroFileInput.addEventListener("change", (event) => {
    setPendingFile(event.target.files[0]);
  });

  selectors.fileInput.addEventListener("change", (event) => {
    setPendingFile(event.target.files[0]);
  });

  selectors.heroScanBtn.addEventListener("click", analyzePendingFile);
  selectors.scanBtn.addEventListener("click", analyzePendingFile);
  selectors.sampleBtn.addEventListener("click", analyzeSample);
  selectors.heroSampleBtn.addEventListener("click", analyzeSample);
  selectors.exportBtn.addEventListener("click", () => window.print());

  document.querySelectorAll(".switch-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".switch-btn").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      state.contractType = button.dataset.contractType;
    });
  });

  document.querySelectorAll(".risk-pill").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".risk-pill").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      state.activeFilter = button.dataset.filter;
      renderFindings();
    });
  });

  bindDropzone(selectors.dropzone);
  bindDropzone(selectors.heroDropzone);

  selectors.pasteBtn.addEventListener("click", () => {
    selectors.pasteDialog.showModal();
    selectors.pasteText.focus();
  });
  selectors.heroPasteBtn.addEventListener("click", () => {
    selectors.pasteDialog.showModal();
    selectors.pasteText.focus();
  });

  selectors.pasteForm.addEventListener("submit", (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const text = selectors.pasteText.value.trim();
    if (!text) {
      showToast("Chưa có nội dung để phân tích");
      return;
    }
    selectors.pasteDialog.close();
    analyzePastedText(text);
  });

  selectors.findingsList.addEventListener("click", async (event) => {
    const jump = event.target.closest(".jump-btn");
    const copy = event.target.closest(".copy-btn");

    if (jump) {
      scrollToFinding(jump.dataset.findingId);
    }

    if (copy) {
      const text = copy.dataset.copy;
      await navigator.clipboard.writeText(text);
      showToast("Đã copy câu sửa");
    }
  });

  selectors.deepInsights.addEventListener("click", (event) => {
    const action = event.target.closest(".priority-action");
    if (!action || !state.analysis?.deepAnalysis?.priorityActions) return;
    const item = state.analysis.deepAnalysis.priorityActions[Number(action.dataset.priorityIndex)];
    const finding = sortedFindings().find((candidate) => candidate.muc_ra_soat === item.title);
    if (finding?.id) scrollToFinding(finding.id);
  });

  selectors.documentViewer.addEventListener("click", (event) => {
    const mark = event.target.closest(".risk-mark");
    if (!mark) return;
    const card = document.querySelector(`.finding-card[data-finding-id="${CSS.escape(mark.dataset.findingId)}"]`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function bindDropzone(dropzone) {
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("is-dragover");
  });

  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragover");
    setPendingFile(event.dataTransfer.files[0]);
  });
}

// Ambient particles animation loop for world-class landing page
function initParticles() {
  pCanvas = document.getElementById("ambientParticles");
  if (!pCanvas) return;
  pCtx = pCanvas.getContext("2d");
  
  const resizeCanvas = () => {
    if (pCanvas) {
      pCanvas.width = pCanvas.parentElement.offsetWidth;
      pCanvas.height = pCanvas.parentElement.offsetHeight;
    }
  };
  
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  
  pParticles = [];
  for (let i = 0; i < 40; i++) {
    pParticles.push({
      x: Math.random() * pCanvas.width,
      y: Math.random() * pCanvas.height,
      radius: Math.random() * 2 + 1,
      speedY: -(Math.random() * 0.4 + 0.15),
      speedX: (Math.random() * 0.4 - 0.2),
      alpha: Math.random() * 0.5 + 0.15,
      color: Math.random() > 0.4 ? "200, 155, 39" : "139, 28, 28" // Gold or Red
    });
  }
  
  const runParticleLoop = () => {
    if (!pCanvas || state.activeView !== "intro") return;
    pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
    
    pParticles.forEach(p => {
      p.y += p.speedY;
      p.x += p.speedX;
      if (p.y < 0) {
        p.y = pCanvas.height;
        p.x = Math.random() * pCanvas.width;
      }
      if (p.x < 0 || p.x > pCanvas.width) {
        p.x = Math.random() * pCanvas.width;
      }
      pCtx.beginPath();
      pCtx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      pCtx.fillStyle = `rgba(${p.color}, ${p.alpha})`;
      pCtx.fill();
    });
    
    pAnimFrameId = requestAnimationFrame(runParticleLoop);
  };
  
  runParticleLoop();
}

function stopParticles() {
  if (pAnimFrameId) {
    cancelAnimationFrame(pAnimFrameId);
  }
}

bindEvents();
showIntro();
