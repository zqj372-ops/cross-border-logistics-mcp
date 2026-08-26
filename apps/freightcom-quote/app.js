import { buildFreightcomRequest, formatDisplayMoney } from "./form-model.mjs";
import { suggestFreightClass } from "./freight-class.mjs";
import { findOriginAddressPreset, ORIGIN_ADDRESS_PRESETS } from "./origin-presets.mjs";
import { schedulePollingTask } from "./polling.mjs";

const form = document.querySelector("#quote-form");
const palletList = document.querySelector("#pallet-list");
const formErrors = document.querySelector("#form-errors");
const liveRegion = document.querySelector("#live-region");
const submitButton = document.querySelector("#submit-quote");
const emptyState = document.querySelector("#empty-state");
const progressCard = document.querySelector("#progress-card");
const resultsCard = document.querySelector("#results-card");
const resultStatus = document.querySelector("#result-status");
const progressBar = document.querySelector("#progress-bar");
const progressComplete = document.querySelector("#progress-complete");
const progressTotal = document.querySelector("#progress-total");
const progressPercent = document.querySelector("#progress-percent");
const progressLabel = document.querySelector("#progress-label");
const progressPhase = document.querySelector("#progress-phase");
const progressRequestId = document.querySelector("#progress-request-id");
const resultsTableBody = document.querySelector("#results-table-body");
const evidenceJson = document.querySelector("#evidence-json");
const evidenceSource = document.querySelector("#evidence-source");
const originAddressPreset = document.querySelector("#origin-address-preset");
const originAddressSummary = document.querySelector("#origin-address-summary");

const postalTimers = new Map();
const postalResolvedKeys = new Map();
let pollGeneration = 0;
let palletSequence = 0;

function elementValue(name) {
  const element = form.elements.namedItem(name);
  return element && "value" in element ? element.value : "";
}

function setElementValue(name, value) {
  const element = form.elements.namedItem(name);
  if (element && "value" in element) element.value = value;
}

function initializeOriginAddressPresets() {
  for (const preset of ORIGIN_ADDRESS_PRESETS) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.label}, ${preset.city}, ${preset.region} ${preset.postal_code}, Canada`;
    originAddressPreset.append(option);
  }
}

function applyOriginAddressPreset() {
  const preset = findOriginAddressPreset(elementValue("origin.addressPreset"));
  for (const field of ["address_line_1", "city", "region", "country", "postal_code"]) {
    setElementValue(`origin.${field}`, preset?.[field] ?? "");
  }
  if (preset === null) {
    originAddressSummary.textContent = "请选择 Calgary 或 Markham 发货地址";
    originAddressSummary.classList.remove("is-selected");
    return false;
  }
  originAddressSummary.textContent = `${preset.address_line_1}, ${preset.city}, ${preset.region} ${preset.postal_code}, Canada`;
  originAddressSummary.classList.add("is-selected");
  setLive(`已选择 ${preset.label} 发货地址`);
  return true;
}

function currentLocalDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initializeDefaults() {
  const expectedShipDate = form.elements.namedItem("expectedShipDate");
  if (expectedShipDate && "value" in expectedShipDate) expectedShipDate.value = currentLocalDate();
}

function readAddress(prefix) {
  return {
    address_line_1: elementValue(`${prefix}.address_line_1`),
    city: elementValue(`${prefix}.city`),
    region: elementValue(`${prefix}.region`),
    country: elementValue(`${prefix}.country`),
    postal_code: elementValue(`${prefix}.postal_code`),
    locationType: elementValue(`${prefix}.locationType`),
  };
}

function readPalletRow(row) {
  const value = (name) => row.querySelector(`[data-name="${name}"]`)?.value ?? "";
  return {
    weightValue: value("weightValue"),
    weightUnit: value("weightUnit"),
    length: value("length"),
    width: value("width"),
    height: value("height"),
    dimensionUnit: value("dimensionUnit"),
    description: value("description"),
    freightClass: value("freightClass"),
  };
}

function readForm() {
  return {
    services: "",
    excludedServices: "",
    expectedShipDate: elementValue("expectedShipDate"),
    origin: readAddress("origin"),
    destination: {
      ...readAddress("destination"),
      readyAt: elementValue("destination.readyAt"),
      readyUntil: elementValue("destination.readyUntil"),
      signatureRequirement: elementValue("destination.signatureRequirement"),
    },
    pallet: {
      pallets: [...palletList.querySelectorAll(".pallet-row")].map(readPalletRow),
    },
    advanced: {},
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setLive(message) {
  liveRegion.textContent = message;
}

function setResultStatus(label, tone = "neutral") {
  resultStatus.textContent = label;
  resultStatus.className = `result-status status-${tone}`;
}

function clearErrors() {
  formErrors.hidden = true;
  formErrors.innerHTML = "";
}

function showErrors(errors) {
  if (errors.length === 0) {
    clearErrors();
    return;
  }
  formErrors.hidden = false;
  formErrors.innerHTML = `<strong>请先补齐以下字段</strong><ul>${errors.map((item) => `<li><code>${escapeHtml(item.field)}</code> ${escapeHtml(item.message)}</li>`).join("")}</ul>`;
  formErrors.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setLive(`有 ${errors.length} 个字段需要补充`);
}

function postalInput(prefix) {
  return document.querySelector(`[data-postal-input="${prefix}"]`);
}

function postalStatus(prefix) {
  return document.querySelector(`[data-postal-status="${prefix}"]`);
}

function locationField(prefix, field) {
  return document.querySelector(`[data-location-field="${prefix}.${field}"]`);
}

function postalKey(value) {
  return String(value ?? "").trim().toUpperCase().replaceAll(" ", "");
}

function isCompletePostal(value) {
  const compact = postalKey(value);
  return /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/u.test(compact)
    || /^\d{5}(?:-\d{4})?$/u.test(compact);
}

function setPostalStatus(prefix, message, tone = "neutral") {
  const status = postalStatus(prefix);
  status.textContent = message;
  status.className = `postal-status postal-${tone}`;
}

function clearLocation(prefix) {
  postalResolvedKeys.delete(prefix);
  for (const field of ["city", "region", "country"]) locationField(prefix, field).value = "";
}

async function parseResponse(response) {
  try {
    return await response.json();
  } catch {
    return { status: "unavailable", code: "INVALID_PAGE_RESPONSE", message: "页面接口返回了无法读取的响应。" };
  }
}

async function lookupPostal(prefix, options = {}) {
  const input = postalInput(prefix);
  const rawPostal = input.value;
  const requestKey = postalKey(rawPostal);
  if (!isCompletePostal(rawPostal)) {
    clearLocation(prefix);
    setPostalStatus(prefix, rawPostal.trim() === "" ? "等待输入邮编" : "请输入完整的加拿大邮编或美国 ZIP Code", rawPostal.trim() === "" ? "neutral" : "error");
    return options.required !== true;
  }
  if (postalResolvedKeys.get(prefix) === requestKey) return true;
  setPostalStatus(prefix, "正在识别邮编…", "loading");
  try {
    const response = await fetch(`/api/postal-lookup?postal=${encodeURIComponent(rawPostal)}`, {
      headers: { accept: "application/json" },
    });
    const body = await parseResponse(response);
    if (postalKey(input.value) !== requestKey) return false;
    if (!response.ok || body.status !== "success") {
      clearLocation(prefix);
      setPostalStatus(prefix, body.message ?? "无法识别该邮编。", "error");
      return false;
    }
    input.value = body.data.postal_code;
    locationField(prefix, "city").value = body.data.city;
    locationField(prefix, "region").value = body.data.region;
    locationField(prefix, "country").value = body.data.country;
    postalResolvedKeys.set(prefix, postalKey(body.data.postal_code));
    const location = `${body.data.city}, ${body.data.region}, ${body.data.country}`;
    setPostalStatus(prefix, body.data.approximate === true ? `已按加拿大 FSA 自动识别：${location} · 请核对` : `已自动识别：${location}`, "success");
    return true;
  } catch {
    if (postalKey(input.value) !== requestKey) return false;
    clearLocation(prefix);
    setPostalStatus(prefix, "邮编自动识别服务暂时不可用。", "error");
    return false;
  }
}

function schedulePostalLookup(prefix) {
  const existing = postalTimers.get(prefix);
  if (existing !== undefined) window.clearTimeout(existing);
  clearLocation(prefix);
  const value = postalInput(prefix).value;
  setPostalStatus(prefix, value.trim() === "" ? "等待输入邮编" : "继续输入，完成后自动识别", "neutral");
  if (!isCompletePostal(value)) return;
  postalTimers.set(prefix, window.setTimeout(() => void lookupPostal(prefix), 350));
}

function palletRowTemplate(index, sequence) {
  return `<article class="pallet-row" data-pallet-id="${sequence}">
    <div class="pallet-row-head"><div><span class="pallet-index">${String(index + 1).padStart(2, "0")}</span><strong>托盘 ${index + 1}</strong></div><button class="icon-button remove-pallet" type="button" aria-label="删除托盘 ${index + 1}" ${index === 0 ? "disabled" : ""}>×</button></div>
    <div class="field-grid field-grid-4 pallet-line-grid">
      <label class="field field-span-2"><span>重量 <em>*</em></span><div class="input-with-unit"><input data-name="weightValue" type="number" min="0.01" step="any" placeholder="100" required /><select data-name="weightUnit" aria-label="重量单位"><option value="kg" selected>kg</option><option value="lb">lb</option><option value="g">g</option><option value="oz">oz</option></select></div></label>
      <label class="field field-span-2"><span>尺寸：长 × 宽 × 高 <em>*</em></span><div class="dimensions-input"><input data-name="length" type="number" min="0.01" step="any" placeholder="120" required /><input data-name="width" type="number" min="0.01" step="any" placeholder="100" aria-label="宽度" required /><input data-name="height" type="number" min="0.01" step="any" placeholder="130" aria-label="高度" required /><select data-name="dimensionUnit" aria-label="尺寸单位"><option value="cm" selected>cm</option><option value="in">in</option><option value="ft">ft</option><option value="mm">mm</option><option value="m">m</option></select></div></label>
      <label class="field field-span-2"><span>货物描述 <em>*</em></span><input data-name="description" type="text" placeholder="例如：工业零件" required /></label>
      <label class="field field-span-2"><span>货运等级（自动） <em>*</em></span><input data-name="freightClass" type="text" inputmode="decimal" placeholder="输入重量和尺寸后自动计算" aria-describedby="freight-class-status-${sequence}" required /><small class="freight-class-status" id="freight-class-status-${sequence}">输入重量和尺寸后自动计算；特殊商品请核对 NMFC</small></label>
    </div>
  </article>`;
}

function refreshPalletRows() {
  [...palletList.querySelectorAll(".pallet-row")].forEach((row, index) => {
    row.querySelector(".pallet-index").textContent = String(index + 1).padStart(2, "0");
    row.querySelector(".pallet-row-head strong").textContent = `托盘 ${index + 1}`;
    const remove = row.querySelector(".remove-pallet");
    remove.disabled = index === 0;
    remove.setAttribute("aria-label", `删除托盘 ${index + 1}`);
  });
}

function updatePalletFreightClass(row) {
  const value = (name) => row.querySelector(`[data-name="${name}"]`)?.value ?? "";
  const result = suggestFreightClass({
    weightValue: value("weightValue"),
    weightUnit: value("weightUnit"),
    length: value("length"),
    width: value("width"),
    height: value("height"),
    dimensionUnit: value("dimensionUnit"),
  });
  const freightClass = row.querySelector('[data-name="freightClass"]');
  const status = row.querySelector(".freight-class-status");
  if (result === null) {
    freightClass.value = "";
    status.textContent = "输入重量和尺寸后自动计算；特殊商品请核对 NMFC";
    status.classList.remove("is-calculated");
    return;
  }
  freightClass.value = result.suggestedClass;
  status.textContent = `密度 ${result.densityPcf} lb/ft³ · NMFTA 2025 密度建议；特殊商品请核对 NMFC`;
  status.classList.add("is-calculated");
}

function addPalletRow() {
  const index = palletList.querySelectorAll(".pallet-row").length;
  palletSequence += 1;
  palletList.insertAdjacentHTML("beforeend", palletRowTemplate(index, palletSequence));
  refreshPalletRows();
  updatePalletFreightClass(palletList.lastElementChild);
}

function resetResults() {
  pollGeneration += 1;
  emptyState.hidden = false;
  progressCard.hidden = true;
  resultsCard.hidden = true;
  setResultStatus("待查询", "neutral");
  progressBar.style.width = "0%";
  evidenceJson.textContent = "尚未收到承运商响应。";
  evidenceSource.textContent = "—";
}

function formatMoney(money) {
  const display = formatDisplayMoney(money);
  if (!display.available) {
    return `<span class="missing-value">暂不支持该来源币种</span><small class="source-currency">来源币种：${escapeHtml(display.sourceCurrency)}</small>`;
  }
  const sourceNote = display.relabelApplied
    ? `来源币种：${display.sourceCurrency} · 数字原样改标 USD（未换算）`
    : `来源币种：${display.sourceCurrency}`;
  return `<strong class="money">${escapeHtml(display.displayCurrency)} ${escapeHtml(display.amount)}</strong><small class="source-currency">${escapeHtml(sourceNote)}</small>`;
}

function renderRates(data) {
  const rates = Array.isArray(data.rates) ? data.rates : [];
  document.querySelector("#rate-count").textContent = String(rates.length);
  resultsTableBody.innerHTML = rates.map((rate) => {
    const carrier = rate.carrier_name ?? "未知承运商";
    const service = rate.service_name ?? rate.service_id ?? "未知服务";
    const transit = rate.transit_time_not_available === true ? "不可用" : rate.transit_time_days === undefined ? "—" : `${rate.transit_time_days} 天`;
    return `<tr>
      <td><div class="carrier-cell"><span class="carrier-mark">${escapeHtml(carrier.slice(0, 2).toUpperCase())}</span><div><strong>${escapeHtml(carrier)}</strong><small>${escapeHtml(service)}</small></div></div></td>
      <td>${rate.total === undefined ? "<span class='missing-value'>需要人工复核</span>" : formatMoney(rate.total)}</td>
      <td>${escapeHtml(transit)}</td>
    </tr>`;
  }).join("");
  if (rates.length === 0) resultsTableBody.innerHTML = `<tr><td colspan="3" class="no-rates">承运商尚未返回可比较报价，保持人工复核状态。</td></tr>`;
  resultsCard.hidden = false;
  emptyState.hidden = true;
  document.querySelector("#completed-at").textContent = data.retrieved_at ? new Date(data.retrieved_at).toLocaleString("zh-CN", { hour12: false }) : "—";
  evidenceSource.textContent = data.source_refs?.[0]?.source_id ?? "不透明来源引用";
  evidenceJson.textContent = JSON.stringify({
    environment: data.environment,
    request_id: data.request_id,
    status: data.status,
    rates: data.rates,
    source_refs: data.source_refs,
    display_currency: data.display_currency,
    currency_policy: data.currency_policy,
    conversion_applied: data.conversion_applied,
  }, null, 2);
  setResultStatus("人工复核", "warning");
  setLive(`收到 ${rates.length} 条 Freightcom 测试报价，结果需要人工复核`);
}

function renderProgress(data) {
  const complete = Number(data.status?.complete ?? 0);
  const total = Number(data.status?.total ?? 0);
  const percent = total === 0 ? 0 : Math.min(100, Math.round((complete / total) * 100));
  progressComplete.textContent = String(complete);
  progressTotal.textContent = total === 0 ? "—" : String(total);
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;
  progressLabel.textContent = data.status?.done === true ? "报价已返回，响应结构已校验" : "正在读取 Freightcom 承运商报价…";
  progressPhase.textContent = data.status?.done === true ? "GET /rate/{request_id} 已完成" : "GET /rate/{request_id} 轮询中";
  setResultStatus(data.status?.done === true ? "已返回" : "轮询中", data.status?.done === true ? "warning" : "info");
}

function handlePollingFailure(generation) {
  if (generation !== pollGeneration) return;
  progressCard.hidden = true;
  emptyState.hidden = false;
  setResultStatus("不可用", "error");
  showErrors([{ field: "network", message: "无法连接页面测试服务，请检查本地服务是否仍在运行。" }]);
  setLive("页面测试服务连接失败");
}

async function poll(pollUrl, requestId, generation) {
  if (generation !== pollGeneration) return;
  const response = await fetch(pollUrl, { headers: { accept: "application/json" } });
  const body = await parseResponse(response);
  if (generation !== pollGeneration) return;
  if (!response.ok || body.status === "unavailable" || body.status === "manual_review" && body.data === undefined) {
    progressCard.hidden = true;
    setResultStatus(body.status === "manual_review" ? "人工复核" : "不可用", body.status === "manual_review" ? "warning" : "error");
    showErrors([{ field: body.code ?? "provider", message: body.message ?? "测试接口不可用。" }]);
    setLive(body.message ?? "测试接口不可用");
    return;
  }
  renderProgress(body.data);
  if (body.data?.status?.done === true) {
    renderRates(body.data);
    return;
  }
  schedulePollingTask({
    schedule: window.setTimeout.bind(window),
    delayMs: 1200,
    task: () => poll(pollUrl, requestId, generation),
    onFailure: () => handlePollingFailure(generation),
  });
}

async function submitQuote(event) {
  event.preventDefault();
  clearErrors();
  submitButton.disabled = true;
  submitButton.querySelector("span:last-child").textContent = "正在核对地址…";
  if (!applyOriginAddressPreset()) {
    showErrors([{ field: "origin.addressPreset", message: "请选择 Calgary 或 Markham 发货地址。" }]);
    submitButton.disabled = false;
    submitButton.querySelector("span:last-child").textContent = "获取测试报价";
    return;
  }
  const destinationPostalReady = await lookupPostal("destination", { required: true });
  if (destinationPostalReady !== true) {
    showErrors([{ field: "destination.postal_code", message: "请先输入并识别有效的加拿大或美国收货邮编。" }]);
    submitButton.disabled = false;
    submitButton.querySelector("span:last-child").textContent = "获取测试报价";
    return;
  }
  const mapped = buildFreightcomRequest(readForm());
  if (mapped.errors.length > 0 || mapped.request === null) {
    showErrors(mapped.errors);
    submitButton.disabled = false;
    submitButton.querySelector("span:last-child").textContent = "获取测试报价";
    return;
  }
  pollGeneration += 1;
  const generation = pollGeneration;
  submitButton.querySelector("span:last-child").textContent = "正在提交…";
  emptyState.hidden = true;
  resultsCard.hidden = true;
  progressCard.hidden = false;
  setResultStatus("提交中", "info");
  progressRequestId.textContent = "等待接收";
  progressLabel.textContent = "正在提交 POST /rate…";
  progressPhase.textContent = "POST /rate";
  setLive("正在提交 Freightcom 测试询价");
  try {
    const response = await fetch("/api/freightcom-test/rate", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(mapped.request),
    });
    const body = await parseResponse(response);
    if (!response.ok || body.status !== "success") {
      showErrors(body.errors ?? [{ field: body.code ?? "provider", message: body.message ?? "测试接口未接受请求。" }]);
      progressCard.hidden = true;
      emptyState.hidden = false;
      setResultStatus(body.status === "needs_input" ? "需补充" : "不可用", body.status === "needs_input" ? "info" : "error");
      return;
    }
    const requestId = body.data.request_id;
    const pollUrl = body.data.poll_url;
    progressRequestId.textContent = requestId;
    document.querySelector("#last-query-time").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    await poll(pollUrl, requestId, generation);
  } catch {
    handlePollingFailure(generation);
  } finally {
    submitButton.disabled = false;
    submitButton.querySelector("span:last-child").textContent = "获取测试报价";
  }
}

async function loadConfig() {
  try {
    const response = await fetch("/api/freightcom-test/config", { headers: { accept: "application/json" } });
    const body = await parseResponse(response);
    if (!response.ok || body.status !== "success") throw new Error("config_unavailable");
    document.querySelector("#api-endpoint").textContent = body.data.endpoint;
    document.querySelector("#api-dot").classList.toggle("is-off", body.data.token_configured !== true);
    document.querySelector("#api-environment").textContent = body.data.token_configured === true ? "测试 · 就绪" : "测试 · 需要令牌";
  } catch {
    document.querySelector("#api-endpoint").textContent = "页面服务不可用";
    document.querySelector("#api-dot").classList.add("is-off");
    document.querySelector("#api-environment").textContent = "测试 · 离线";
  }
}

originAddressPreset.addEventListener("change", applyOriginAddressPreset);
postalInput("destination").addEventListener("input", () => schedulePostalLookup("destination"));
postalInput("destination").addEventListener("blur", () => void lookupPostal("destination"));
form.addEventListener("submit", (event) => void submitQuote(event));
document.querySelector("#add-pallet").addEventListener("click", addPalletRow);
palletList.addEventListener("click", (event) => {
  const button = event.target.closest(".remove-pallet");
  if (!button || button.disabled) return;
  button.closest(".pallet-row")?.remove();
  refreshPalletRows();
});
const freightClassInputs = new Set(["weightValue", "weightUnit", "length", "width", "height", "dimensionUnit"]);
function updateFreightClassFromEvent(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (!freightClassInputs.has(target.dataset.name)) return;
  const row = target.closest(".pallet-row");
  if (row !== null) updatePalletFreightClass(row);
}
palletList.addEventListener("input", updateFreightClassFromEvent);
palletList.addEventListener("change", updateFreightClassFromEvent);
document.querySelector("#stop-polling").addEventListener("click", () => {
  pollGeneration += 1;
  progressCard.hidden = true;
  emptyState.hidden = false;
  setResultStatus("已停止", "neutral");
  setLive("已停止当前页面轮询");
});
document.querySelector("#reset-form").addEventListener("click", () => {
  form.reset();
  initializeDefaults();
  applyOriginAddressPreset();
  const destinationTimer = postalTimers.get("destination");
  if (destinationTimer !== undefined) window.clearTimeout(destinationTimer);
  clearLocation("destination");
  setPostalStatus("destination", "等待输入邮编");
  palletList.innerHTML = "";
  palletSequence = 0;
  addPalletRow();
  clearErrors();
  resetResults();
});

initializeDefaults();
initializeOriginAddressPresets();
applyOriginAddressPreset();
addPalletRow();
void loadConfig();
