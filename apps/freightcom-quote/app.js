import { buildFreightcomRequest, formatDisplayMoney } from "./form-model.mjs";

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

let pollGeneration = 0;
let palletSequence = 0;

function elementValue(name) {
  const element = form.elements.namedItem(name);
  return element && "value" in element ? element.value : "";
}

function elementChecked(name) {
  const element = form.elements.namedItem(name);
  return Boolean(element && "checked" in element && element.checked);
}

function readAddress(prefix) {
  return {
    name: elementValue(`${prefix}.name`),
    address_line_1: elementValue(`${prefix}.address_line_1`),
    address_line_2: elementValue(`${prefix}.address_line_2`),
    unit_number: elementValue(`${prefix}.unit_number`),
    city: elementValue(`${prefix}.city`),
    region: elementValue(`${prefix}.region`),
    country: elementValue(`${prefix}.country`),
    postal_code: elementValue(`${prefix}.postal_code`),
    residential: elementChecked(`${prefix}.residential`),
    tailgate_required: elementChecked(`${prefix}.tailgate_required`),
    instructions: elementValue(`${prefix}.instructions`),
    contact_name: elementValue(`${prefix}.contact_name`),
    phone_number: elementValue(`${prefix}.phone_number`),
    phone_extension: elementValue(`${prefix}.phone_extension`),
    email_addresses: elementValue(`${prefix}.email_addresses`),
    receives_email_updates: elementChecked(`${prefix}.receives_email_updates`),
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
    nmfc: value("nmfc"),
    contentsType: value("contentsType"),
    numPieces: value("numPieces"),
  };
}

function readForm() {
  return {
    services: elementValue("services"),
    excludedServices: elementValue("excludedServices"),
    expectedShipDate: elementValue("expectedShipDate"),
    origin: readAddress("origin"),
    destination: {
      ...readAddress("destination"),
      readyAt: elementValue("destination.readyAt"),
      readyUntil: elementValue("destination.readyUntil"),
      signatureRequirement: elementValue("destination.signatureRequirement"),
    },
    pallet: {
      hasStackablePallets: elementChecked("pallet.hasStackablePallets"),
      dangerousGoods: elementValue("pallet.dangerousGoods"),
      dangerousGoodsDetails: {
        packaging_group: elementValue("pallet.dg.packaging_group"),
        goods_class: elementValue("pallet.dg.goods_class"),
        description: elementValue("pallet.dg.description"),
        united_nations_number: elementValue("pallet.dg.united_nations_number"),
        emergency_contact_name: elementValue("pallet.dg.emergency_contact_name"),
        emergency_contact_number: elementValue("pallet.dg.emergency_contact_number"),
        emergency_contact_extension: elementValue("pallet.dg.emergency_contact_extension"),
      },
      limitedAccessDeliveryType: elementValue("pallet.limitedAccessDeliveryType"),
      limitedAccessDeliveryOtherName: elementValue("pallet.limitedAccessDeliveryOtherName"),
      inBond: elementChecked("pallet.inBond"),
      inBondType: elementValue("pallet.inBondType"),
      inBondName: elementValue("pallet.inBondName"),
      inBondAddress: elementValue("pallet.inBondAddress"),
      inBondContactMethod: elementValue("pallet.inBondContactMethod"),
      inBondContactEmail: elementValue("pallet.inBondContactEmail"),
      inBondContactPhone: elementValue("pallet.inBondContactPhone"),
      inBondContactExtension: elementValue("pallet.inBondContactExtension"),
      appointmentDelivery: elementChecked("pallet.appointmentDelivery"),
      protectFromFreeze: elementChecked("pallet.protectFromFreeze"),
      thresholdPickup: elementChecked("pallet.thresholdPickup"),
      thresholdDelivery: elementChecked("pallet.thresholdDelivery"),
      amazonOrFbaDelivery: elementChecked("pallet.amazonOrFbaDelivery"),
      fbaNumber: elementValue("pallet.fbaNumber"),
      orderId: elementValue("pallet.orderId"),
      pallets: [...palletList.querySelectorAll(".pallet-row")].map(readPalletRow),
    },
    advanced: {
      insuranceType: elementValue("advanced.insuranceType"),
      insuranceValue: elementValue("advanced.insuranceValue"),
      insuranceCurrency: elementValue("advanced.insuranceCurrency"),
      referenceCodes: elementValue("advanced.referenceCodes"),
      shipmentClassification: elementValue("advanced.shipmentClassification"),
    },
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

function updateConditionals() {
  const dangerousGoods = elementValue("pallet.dangerousGoods");
  document.querySelector("#dangerous-goods-block").hidden = dangerousGoods === "";
  document.querySelector("#in-bond-block").hidden = !elementChecked("pallet.inBond");
  document.querySelector("#amazon-fba-block").hidden = !elementChecked("pallet.amazonOrFbaDelivery");
}

function palletRowTemplate(index) {
  return `<article class="pallet-row" data-pallet-index="${index}">
    <div class="pallet-row-head"><div><span class="pallet-index">${String(index + 1).padStart(2, "0")}</span><strong>Pallet ${index + 1}</strong></div><button class="icon-button remove-pallet" type="button" aria-label="删除 pallet ${index + 1}" ${index === 0 ? "disabled" : ""}>×</button></div>
    <div class="field-grid field-grid-4 pallet-line-grid">
      <label class="field field-span-2"><span>weight <em>*</em></span><div class="input-with-unit"><input data-name="weightValue" type="number" min="0.01" step="any" placeholder="100" /><select data-name="weightUnit" aria-label="weight unit"><option value="lb">lb</option><option value="kg">kg</option><option value="g">g</option><option value="oz">oz</option></select></div></label>
      <label class="field field-span-2"><span>dimensions L × W × H <em>*</em></span><div class="dimensions-input"><input data-name="length" type="number" min="0.01" step="any" placeholder="48" /><input data-name="width" type="number" min="0.01" step="any" placeholder="40" /><input data-name="height" type="number" min="0.01" step="any" placeholder="52" /><select data-name="dimensionUnit" aria-label="dimension unit"><option value="in">in</option><option value="cm">cm</option><option value="ft">ft</option><option value="mm">mm</option><option value="m">m</option></select></div></label>
      <label class="field field-span-2"><span>description <em>*</em></span><input data-name="description" type="text" placeholder="Industrial parts" /></label>
      <label class="field"><span>freight_class <em>*</em></span><input data-name="freightClass" type="text" placeholder="70" /></label>
      <label class="field"><span>num_pieces</span><input data-name="numPieces" type="number" min="1" step="1" placeholder="1" /></label>
      <label class="field"><span>nmfc</span><input data-name="nmfc" type="text" /></label>
      <label class="field"><span>contents_type</span><input data-name="contentsType" type="text" placeholder="machinery" /></label>
    </div>
  </article>`;
}

function refreshPalletRows() {
  [...palletList.querySelectorAll(".pallet-row")].forEach((row, index) => {
    row.querySelector(".pallet-index").textContent = String(index + 1).padStart(2, "0");
    row.querySelector(".pallet-row-head strong").textContent = `Pallet ${index + 1}`;
    const remove = row.querySelector(".remove-pallet");
    remove.disabled = index === 0;
    remove.setAttribute("aria-label", `删除 pallet ${index + 1}`);
  });
}

function addPalletRow() {
  palletSequence += 1;
  palletList.insertAdjacentHTML("beforeend", palletRowTemplate(palletSequence));
  refreshPalletRows();
}

function resetResults() {
  pollGeneration += 1;
  emptyState.hidden = false;
  progressCard.hidden = true;
  resultsCard.hidden = true;
  setResultStatus("待查询", "neutral");
  progressBar.style.width = "0%";
  evidenceJson.textContent = "尚未收到 provider 响应。";
  evidenceSource.textContent = "—";
}

function formatMoney(money) {
  const display = formatDisplayMoney(money);
  return `<strong class="money">${escapeHtml(display.displayCurrency)} ${escapeHtml(display.amount)}</strong><small class="source-currency">source: ${escapeHtml(display.sourceCurrency)}</small>`;
}

function formatChargeList(items) {
  if (!Array.isArray(items) || items.length === 0) return "—";
  return items.map((item) => `${escapeHtml(item.type ?? "charge")}: ${formatDisplayMoney(item.amount).displayCurrency} ${formatDisplayMoney(item.amount).amount}`).join("<br />");
}

function renderRates(data) {
  const rates = Array.isArray(data.rates) ? data.rates : [];
  document.querySelector("#rate-count").textContent = String(rates.length);
  resultsTableBody.innerHTML = rates.map((rate, index) => {
    const carrier = rate.carrier_name ?? "Unknown carrier";
    const service = rate.service_name ?? rate.service_id ?? "Unknown service";
    const transit = rate.transit_time_not_available === true ? "N/A" : rate.transit_time_days === undefined ? "—" : `${rate.transit_time_days} days`;
    return `<tr>
      <td><div class="carrier-cell"><span class="carrier-mark">${escapeHtml(carrier.slice(0, 2).toUpperCase())}</span><div><strong>${escapeHtml(carrier)}</strong><small>${escapeHtml(service)}</small></div></div></td>
      <td>${rate.total === undefined ? "<span class='missing-value'>manual review</span>" : formatMoney(rate.total)}</td>
      <td>${rate.base === undefined ? "—" : formatMoney(rate.base)}</td>
      <td class="charge-cell">${formatChargeList([...(Array.isArray(rate.surcharges) ? rate.surcharges : []), ...(Array.isArray(rate.taxes) ? rate.taxes : [])])}</td>
      <td>${escapeHtml(transit)}</td>
      <td><span class="row-status">TEST · review</span></td>
    </tr>`;
  }).join("");
  if (rates.length === 0) {
    resultsTableBody.innerHTML = `<tr><td colspan="6" class="no-rates">provider 尚未返回可比较的 rate，保持 manual_review。</td></tr>`;
  }
  resultsCard.hidden = false;
  emptyState.hidden = true;
  document.querySelector("#completed-at").textContent = data.retrieved_at ? new Date(data.retrieved_at).toLocaleString("zh-CN", { hour12: false }) : "—";
  evidenceSource.textContent = data.source_refs?.[0]?.source_id ?? "opaque source";
  evidenceJson.textContent = JSON.stringify({
    environment: data.environment,
    request_id: data.request_id,
    status: data.status,
    rates: data.rates,
    source_refs: data.source_refs,
    display_currency: data.display_currency,
    conversion_applied: data.conversion_applied,
  }, null, 2);
  setResultStatus("人工复核", "warning");
  setLive(`收到 ${rates.length} 条 Freightcom 测试报价，状态为人工复核`);
}

function renderProgress(data) {
  const complete = Number(data.status?.complete ?? 0);
  const total = Number(data.status?.total ?? 0);
  const percent = total === 0 ? 0 : Math.min(100, Math.round((complete / total) * 100));
  progressComplete.textContent = String(complete);
  progressTotal.textContent = total === 0 ? "—" : String(total);
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;
  progressLabel.textContent = data.status?.done === true ? "Rates ready · provider response validated" : "正在读取 Freightcom provider rates…";
  progressPhase.textContent = data.status?.done === true ? "GET /rate/{request_id} complete" : "GET /rate/{request_id} polling";
  setResultStatus(data.status?.done === true ? "已返回" : "轮询中", data.status?.done === true ? "warning" : "info");
}

async function parseResponse(response) {
  try {
    return await response.json();
  } catch {
    return { status: "unavailable", code: "INVALID_PAGE_RESPONSE", message: "页面 API 返回了无法读取的响应。" };
  }
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
  window.setTimeout(() => void poll(pollUrl, requestId, generation), 1200);
}

async function submitQuote(event) {
  event.preventDefault();
  clearErrors();
  const model = readForm();
  const mapped = buildFreightcomRequest(model);
  if (mapped.errors.length > 0 || mapped.request === null) {
    showErrors(mapped.errors);
    return;
  }
  pollGeneration += 1;
  const generation = pollGeneration;
  submitButton.disabled = true;
  submitButton.querySelector("span:last-child").textContent = "正在提交…";
  emptyState.hidden = true;
  resultsCard.hidden = true;
  progressCard.hidden = false;
  setResultStatus("提交中", "info");
  progressRequestId.textContent = "pending";
  progressLabel.textContent = "正在 POST /rate…";
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
    progressCard.hidden = true;
    emptyState.hidden = false;
    setResultStatus("不可用", "error");
    showErrors([{ field: "network", message: "无法连接页面测试服务，请检查本地服务是否仍在运行。" }]);
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
    document.querySelector("#api-environment").textContent = body.data.token_configured === true ? "TEST · READY" : "TEST · TOKEN NEEDED";
  } catch {
    document.querySelector("#api-endpoint").textContent = "页面服务不可用";
    document.querySelector("#api-dot").classList.add("is-off");
    document.querySelector("#api-environment").textContent = "TEST · OFFLINE";
  }
}

form.addEventListener("submit", (event) => void submitQuote(event));
document.querySelector("#add-pallet").addEventListener("click", addPalletRow);
document.querySelector("#dangerous-goods").addEventListener("change", updateConditionals);
document.querySelector("#in-bond").addEventListener("change", updateConditionals);
document.querySelector("#amazon-fba").addEventListener("change", updateConditionals);
palletList.addEventListener("click", (event) => {
  const button = event.target.closest(".remove-pallet");
  if (!button || button.disabled) return;
  button.closest(".pallet-row")?.remove();
  refreshPalletRows();
});
document.querySelector("#stop-polling").addEventListener("click", () => {
  pollGeneration += 1;
  progressCard.hidden = true;
  emptyState.hidden = false;
  setResultStatus("已停止", "neutral");
  setLive("已停止当前页面轮询");
});
document.querySelector("#reset-form").addEventListener("click", () => {
  form.reset();
  palletList.innerHTML = "";
  palletSequence = 0;
  addPalletRow();
  updateConditionals();
  clearErrors();
  resetResults();
});

addPalletRow();
updateConditionals();
void loadConfig();
