function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value) {
  const result = text(value);
  return result === "" ? undefined : result;
}

function list(value) {
  return String(value ?? "")
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function error(errors, field, message) {
  if (!errors.some((item) => item.field === field)) errors.push({ field, message });
}

function positiveNumber(value, field, errors) {
  const raw = text(value);
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed) || parsed <= 0) {
    error(errors, field, "请输入大于 0 的数字。");
    return null;
  }
  return parsed;
}

function positiveDecimalString(value, field, errors) {
  const raw = text(value);
  if (
    raw.length > 128 ||
    !/^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/u.test(raw)
  ) {
    error(errors, field, "请输入大于 0 的普通十进制数字。");
    return null;
  }
  return raw;
}

function positiveInteger(value, field, errors) {
  const parsed = positiveNumber(value, field, errors);
  if (parsed === null) return null;
  if (!Number.isSafeInteger(parsed)) {
    error(errors, field, "请输入正整数。");
    return null;
  }
  return parsed;
}

function isoCountry(value, field, errors) {
  const result = text(value).toUpperCase();
  if (!/^[A-Z]{2}$/u.test(result)) {
    error(errors, field, "请输入 ISO alpha-2 国家代码，例如 CA 或 US。");
    return null;
  }
  return result;
}

function emailList(value, field, errors) {
  const values = list(value);
  for (const item of values) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(item)) {
      error(errors, field, `邮箱格式无效：${item}`);
    }
  }
  return values;
}

function locationFlags(values, prefix, errors) {
  const locationType = text(values?.locationType);
  if (locationType === "") {
    return {
      ...(values?.residential === undefined ? {} : { residential: Boolean(values.residential) }),
      ...(values?.tailgate_required === undefined ? {} : { tailgate_required: Boolean(values.tailgate_required) }),
    };
  }
  const mappings = {
    "commercial-no-tailgate": { residential: false, tailgate_required: false },
    "commercial-tailgate": { residential: false, tailgate_required: true },
    "residential-no-tailgate": { residential: true, tailgate_required: false },
    "residential-tailgate": { residential: true, tailgate_required: true },
  };
  const mapped = mappings[locationType];
  if (mapped === undefined) {
    error(errors, `${prefix}.locationType`, "请选择有效的地点类型。");
    return {};
  }
  return mapped;
}

function parseDate(value, field, errors) {
  const raw = text(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  if (match === null) {
    error(errors, field, "请选择发货日期。");
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    error(errors, field, "发货日期无效。");
    return null;
  }
  return { year, month, day };
}

function parseTime(value, field, errors) {
  const raw = text(value);
  const match = /^(\d{2}):(\d{2})$/u.exec(raw);
  if (match === null) {
    error(errors, field, "请选择时间。");
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    error(errors, field, "时间无效。");
    return null;
  }
  return { hour, minute };
}

function buildEstablishment(values, prefix, errors, destination = false) {
  const addressLine1 = text(values?.address_line_1);
  const city = text(values?.city);
  const region = text(values?.region);
  const country = isoCountry(values?.country, `${prefix}.country`, errors);
  const postalCode = text(values?.postal_code);
  if (addressLine1 === "") error(errors, `${prefix}.address_line_1`, "请输入街道地址。");
  if (city === "") error(errors, `${prefix}.city`, "请输入城市。");
  if (region === "") error(errors, `${prefix}.region`, "请输入省/州。");
  if (postalCode === "") error(errors, `${prefix}.postal_code`, "请输入邮编。");

  const phone = optionalText(values?.phone_number);
  const phoneExtension = optionalText(values?.phone_extension);
  const emailAddresses = emailList(values?.email_addresses, `${prefix}.email_addresses`, errors);
  const access = locationFlags(values, prefix, errors);
  const establishment = {
    ...(optionalText(values?.name) === undefined ? {} : { name: optionalText(values?.name) }),
    address: {
      address_line_1: addressLine1,
      ...(optionalText(values?.address_line_2) === undefined ? {} : { address_line_2: optionalText(values?.address_line_2) }),
      ...(optionalText(values?.unit_number) === undefined ? {} : { unit_number: optionalText(values?.unit_number) }),
      city,
      region,
      ...(country === null ? {} : { country }),
      postal_code: postalCode,
    },
    ...access,
    ...(optionalText(values?.instructions) === undefined ? {} : { instructions: optionalText(values?.instructions) }),
    ...(optionalText(values?.contact_name) === undefined ? {} : { contact_name: optionalText(values?.contact_name) }),
    ...(phone === undefined ? {} : { phone_number: { number: phone, ...(phoneExtension === undefined ? {} : { extension: phoneExtension }) } }),
    ...(emailAddresses.length === 0 ? {} : { email_addresses: emailAddresses }),
    ...(values?.receives_email_updates === undefined ? {} : { receives_email_updates: Boolean(values.receives_email_updates) }),
  };

  if (destination) {
    const readyAt = parseTime(values?.readyAt, `${prefix}.readyAt`, errors);
    const readyUntil = parseTime(values?.readyUntil, `${prefix}.readyUntil`, errors);
    const signatureRequirement = text(values?.signatureRequirement);
    if (!["not-required", "required", "adult-required"].includes(signatureRequirement)) {
      error(errors, `${prefix}.signatureRequirement`, "请选择签名要求。");
    }
    return {
      ...establishment,
      ...(readyAt === null ? {} : { ready_at: readyAt }),
      ...(readyUntil === null ? {} : { ready_until: readyUntil }),
      signature_requirement: signatureRequirement,
    };
  }
  return establishment;
}

function lowestUnitValue(value, field, errors) {
  const raw = text(value);
  if (!/^\d+(?:\.\d{1,2})?$/u.test(raw)) {
    error(errors, field, "请输入非负金额，最多两位小数。");
    return null;
  }
  const [whole, fraction = ""] = raw.split(".");
  return `${whole}${fraction.padEnd(2, "0")}`.replace(/^0+(?=\d)/u, "");
}

function buildPallet(values, errors) {
  const pallets = Array.isArray(values?.pallets) ? values.pallets : [];
  if (pallets.length === 0) error(errors, "pallet.pallets", "至少添加一件 pallet。");
  const palletRequests = pallets.map((item, index) => {
    const prefix = `pallet.pallets.${index}`;
    const weight = positiveDecimalString(item?.weightValue, `${prefix}.weightValue`, errors);
    const length = positiveNumber(item?.length, `${prefix}.length`, errors);
    const width = positiveNumber(item?.width, `${prefix}.width`, errors);
    const height = positiveNumber(item?.height, `${prefix}.height`, errors);
    const numPieces = text(item?.numPieces) === "" ? undefined : positiveInteger(item.numPieces, `${prefix}.numPieces`, errors);
    const description = text(item?.description);
    const freightClass = text(item?.freightClass);
    if (description === "") error(errors, `${prefix}.description`, "请输入货物描述。");
    if (freightClass === "") error(errors, `${prefix}.freightClass`, "请输入 freight class。");
    const weightUnit = text(item?.weightUnit);
    const dimensionUnit = text(item?.dimensionUnit);
    if (!["kg", "lb", "g", "oz"].includes(weightUnit)) error(errors, `${prefix}.weightUnit`, "重量单位无效。");
    if (!["mm", "cm", "m", "in", "ft"].includes(dimensionUnit)) error(errors, `${prefix}.dimensionUnit`, "尺寸单位无效。");
    return {
      measurements: {
        ...(weight === null ? {} : { weight: { unit: weightUnit, value: weight } }),
        ...(length === null || width === null || height === null ? {} : { cuboid: { unit: dimensionUnit, l: length, w: width, h: height } }),
      },
      description,
      freight_class: freightClass,
      ...(optionalText(item?.nmfc) === undefined ? {} : { nmfc: optionalText(item?.nmfc) }),
      ...(optionalText(item?.contentsType) === undefined ? {} : { contents_type: optionalText(item?.contentsType) }),
      ...(numPieces === undefined || numPieces === null ? {} : { num_pieces: numPieces }),
    };
  });

  const dangerousGoods = text(values?.dangerousGoods);
  const dangerousGoodsDetails = values?.dangerousGoodsDetails;
  const hasDangerousGoodsDetail = Object.values(dangerousGoodsDetails ?? {}).some((value) => text(value) !== "");
  if (dangerousGoods === "" && hasDangerousGoodsDetail) {
    error(errors, "pallet.dangerousGoods", "填写危险品资料前请先选择 dangerous_goods 类型。");
  }
  let dangerousDetails;
  if (dangerousGoods !== "") {
    if (!["limited-quantity", "exemption-500-kg", "fully-regulated"].includes(dangerousGoods)) {
      error(errors, "pallet.dangerousGoods", "危险品类型无效。");
    }
    const phone = text(dangerousGoodsDetails?.emergency_contact_number);
    if (dangerousGoodsDetails === undefined) {
      error(errors, "pallet.dangerousGoodsDetails", "选择危险品时必须填写完整危险品资料。");
    } else {
      for (const [key, label] of [
        ["packaging_group", "包装组"],
        ["goods_class", "货物类别"],
        ["description", "危险品描述"],
        ["united_nations_number", "UN 编号"],
        ["emergency_contact_name", "紧急联系人"],
      ]) {
        if (text(dangerousGoodsDetails[key]) === "") error(errors, `pallet.dangerousGoodsDetails.${key}`, `请输入${label}。`);
      }
      if (phone === "") error(errors, "pallet.dangerousGoodsDetails.emergency_contact_number", "请输入紧急联系电话。");
      dangerousDetails = {
        packaging_group: text(dangerousGoodsDetails.packaging_group),
        goods_class: text(dangerousGoodsDetails.goods_class),
        description: text(dangerousGoodsDetails.description),
        united_nations_number: text(dangerousGoodsDetails.united_nations_number),
        emergency_contact_name: text(dangerousGoodsDetails.emergency_contact_name),
        emergency_contact_phone_number: {
          number: phone,
          ...(optionalText(dangerousGoodsDetails.emergency_contact_extension) === undefined ? {} : { extension: optionalText(dangerousGoodsDetails.emergency_contact_extension) }),
        },
      };
    }
  }

  const service = values?.palletService ?? values ?? {};
  const hasInBondInput = [
    service.inBondType,
    service.inBondName,
    service.inBondAddress,
    service.inBondContactMethod,
    service.inBondContactEmail,
    service.inBondContactPhone,
    service.inBondContactExtension,
  ].some((value) => text(value) !== "");
  if (service.inBond !== true && hasInBondInput) {
    error(errors, "pallet.inBond", "填写 in-bond 资料前请先启用 in_bond。");
  }
  const hasFbaInput = [service.fbaNumber, service.orderId].some((value) => text(value) !== "");
  if (service.amazonOrFbaDelivery !== true && hasFbaInput) {
    error(errors, "pallet.amazonOrFbaDelivery", "填写 FBA 资料前请先启用 amazon_or_fba_delivery。");
  }
  if (text(service.limitedAccessDeliveryOtherName) !== "" && text(service.limitedAccessDeliveryType) !== "other") {
    error(errors, "pallet.limitedAccessDeliveryType", "填写 limited access other name 前请选择 other。");
  }
  const serviceHasValue = [
    service.limitedAccessDeliveryType,
    service.inBond,
    service.appointmentDelivery,
    service.protectFromFreeze,
    service.thresholdPickup,
    service.thresholdDelivery,
    service.amazonOrFbaDelivery,
  ].some((value) => value !== undefined && value !== "" && value !== false);
  let serviceDetails;
  if (serviceHasValue) {
    const limitedAccess = text(service.limitedAccessDeliveryType);
    if (limitedAccess !== "" && ![
      "construction-site", "fair", "farm", "mall", "mini-storage-unit", "place-of-worship", "school", "secured-location", "other",
    ].includes(limitedAccess)) error(errors, "pallet.limitedAccessDeliveryType", "limited access 类型无效。");
    const otherName = optionalText(service.limitedAccessDeliveryOtherName);
    if (limitedAccess === "other" && otherName === undefined) error(errors, "pallet.limitedAccessDeliveryOtherName", "请选择 other 时必须填写名称。");

    let inBondDetails;
    if (service.inBond === true) {
      const contactMethod = text(service.inBondContactMethod);
      const contactEmail = optionalText(service.inBondContactEmail);
      const contactPhone = optionalText(service.inBondContactPhone);
      if (!["immediate-exportation", "transportation-and-exportation"].includes(text(service.inBondType))) error(errors, "pallet.inBondType", "in-bond 类型无效。");
      if (text(service.inBondName) === "") error(errors, "pallet.inBondName", "请输入 in-bond 名称。");
      if (text(service.inBondAddress) === "") error(errors, "pallet.inBondAddress", "请输入 in-bond 地址。");
      if (!["email-address", "phone-number", "fax-number"].includes(contactMethod)) error(errors, "pallet.inBondContactMethod", "请选择 in-bond 联系方式。");
      if (contactMethod === "email-address" && contactEmail === undefined) error(errors, "pallet.inBondContactEmail", "请输入 in-bond 联系邮箱。");
      if (contactMethod === "phone-number" && contactPhone === undefined) error(errors, "pallet.inBondContactPhone", "请输入 in-bond 联系电话。");
      inBondDetails = {
        type: text(service.inBondType),
        name: text(service.inBondName),
        address: text(service.inBondAddress),
        contact_method: contactMethod,
        ...(contactEmail === undefined ? {} : { contact_email_address: contactEmail }),
        ...(contactPhone === undefined ? {} : { contact_phone_number: { number: contactPhone, ...(optionalText(service.inBondContactExtension) === undefined ? {} : { extension: optionalText(service.inBondContactExtension) }) } }),
      };
    }

    let fbaDetails;
    if (service.amazonOrFbaDelivery === true) {
      if (text(service.fbaNumber) === "") error(errors, "pallet.fbaNumber", "请输入 FBA 编号。");
      if (text(service.orderId) === "") error(errors, "pallet.orderId", "请输入订单号。");
      fbaDetails = { fba_number: text(service.fbaNumber), order_id: text(service.orderId) };
    }
    serviceDetails = {
      ...(limitedAccess === "" ? {} : { limited_access_delivery_type: limitedAccess, ...(otherName === undefined ? {} : { limited_access_delivery_other_name: otherName }) }),
      ...(service.inBond === undefined ? {} : { in_bond: Boolean(service.inBond), ...(inBondDetails === undefined ? {} : { in_bond_details: inBondDetails }) }),
      ...(service.appointmentDelivery === undefined ? {} : { appointment_delivery: Boolean(service.appointmentDelivery) }),
      ...(service.protectFromFreeze === undefined ? {} : { protect_from_freeze: Boolean(service.protectFromFreeze) }),
      ...(service.thresholdPickup === undefined ? {} : { threshold_pickup: Boolean(service.thresholdPickup) }),
      ...(service.thresholdDelivery === undefined ? {} : { threshold_delivery: Boolean(service.thresholdDelivery) }),
      ...(service.amazonOrFbaDelivery === undefined ? {} : { amazon_or_fba_delivery: Boolean(service.amazonOrFbaDelivery), ...(fbaDetails === undefined ? {} : { amazon_or_fba_delivery_details: fbaDetails }) }),
    };
  }

  return {
    pallet_type: "ltl",
    ...(values?.hasStackablePallets === undefined ? {} : { has_stackable_pallets: Boolean(values.hasStackablePallets) }),
    ...(dangerousGoods === "" ? {} : { dangerous_goods: dangerousGoods, ...(dangerousDetails === undefined ? {} : { dangerous_goods_details: dangerousDetails }) }),
    pallets: palletRequests,
    ...(serviceDetails === undefined ? {} : { pallet_service_details: serviceDetails }),
  };
}

export function buildFreightcomRequest(values) {
  const errors = [];
  const expectedShipDate = parseDate(values?.expectedShipDate, "expectedShipDate", errors);
  const origin = buildEstablishment(values?.origin ?? {}, "origin", errors);
  const destination = buildEstablishment(values?.destination ?? {}, "destination", errors, true);
  const pallet = buildPallet(values?.pallet ?? {}, errors);
  const advanced = values?.advanced ?? {};
  const insuranceType = text(advanced.insuranceType);
  const insuranceValue = text(advanced.insuranceValue);
  const insuranceCurrency = text(advanced.insuranceCurrency).toUpperCase();
  let insurance;
  if (insuranceType !== "" || insuranceValue !== "" || insuranceCurrency !== "") {
    if (!["internal", "carrier"].includes(insuranceType)) error(errors, "advanced.insuranceType", "请选择保险类型。");
    if (!/^[A-Z]{3}$/u.test(insuranceCurrency)) error(errors, "advanced.insuranceCurrency", "请输入三位 ISO 币种。");
    const lowestValue = lowestUnitValue(insuranceValue, "advanced.insuranceValue", errors);
    if (lowestValue !== null) insurance = { type: insuranceType, total_cost: { value: lowestValue, currency: insuranceCurrency } };
  }
  const shipmentClassification = optionalText(advanced.shipmentClassification);
  if (shipmentClassification !== undefined && !["B2B", "B2C", "C2B", "C2C"].includes(shipmentClassification)) {
    error(errors, "advanced.shipmentClassification", "shipment classification 无效。");
  }
  const services = list(values?.services);
  const excludedServices = list(values?.excludedServices);
  const request = {
    ...(services.length === 0 ? {} : { services }),
    ...(excludedServices.length === 0 ? {} : { excluded_services: excludedServices }),
    details: {
      ...(origin === null ? {} : { origin }),
      ...(destination === null ? {} : { destination }),
      ...(expectedShipDate === null ? {} : { expected_ship_date: expectedShipDate }),
      packaging_type: "pallet",
      packaging_properties: pallet,
      ...(insurance === undefined ? {} : { insurance }),
      ...(list(advanced.referenceCodes).length === 0 ? {} : { reference_codes: list(advanced.referenceCodes) }),
      ...(shipmentClassification === undefined ? {} : { shipment_classification: shipmentClassification }),
    },
  };
  return { request: errors.length === 0 ? request : null, errors };
}

export function formatDisplayMoney(money) {
  const value = String(money?.value ?? "");
  const sourceCurrency = text(money?.currency).toUpperCase() || "unknown";
  const relabelApplied = sourceCurrency === "CAD";
  if (!/^\d+$/u.test(value) || !["CAD", "USD"].includes(sourceCurrency)) {
    return {
      amount: "—",
      displayCurrency: "USD",
      sourceCurrency,
      conversionApplied: false,
      relabelApplied: false,
      available: false,
    };
  }
  const normalized = value.padStart(3, "0");
  const amount = `${normalized.slice(0, -2)}.${normalized.slice(-2)}`;
  return {
    amount,
    displayCurrency: "USD",
    sourceCurrency,
    conversionApplied: false,
    relabelApplied,
    available: true,
  };
}
