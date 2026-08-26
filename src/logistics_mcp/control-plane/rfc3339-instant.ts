export const ADMIN_CONTROL_RFC3339_PATTERN = /^(?:(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))|(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:[.][0-9]{1,9})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/;

const RFC3339_INSTANT_COMPONENTS_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[.]([0-9]{1,9}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/u;

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const SECONDS_PER_DAY = 86_400n;
const CIVIL_EPOCH_OFFSET_DAYS = 719_468n;
const DAYS_PER_400_YEARS = 146_097n;

declare const RFC3339_INSTANT_NANOSECONDS: unique symbol;

export type Rfc3339InstantNanoseconds = bigint & {
  readonly [RFC3339_INSTANT_NANOSECONDS]: true;
};

export type Rfc3339InstantComparison = -1 | 0 | 1;

function floorDivide(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  return dividend % divisor < 0n ? quotient - 1n : quotient;
}

function parseComponents(value: string): RegExpExecArray | null {
  if (
    typeof value !== "string" ||
    !ADMIN_CONTROL_RFC3339_PATTERN.test(value)
  ) {
    return null;
  }
  return RFC3339_INSTANT_COMPONENTS_PATTERN.exec(value);
}

export function parseRfc3339Instant(
  value: string,
): Rfc3339InstantNanoseconds | null {
  const match = parseComponents(value);
  if (match === null) return null;

  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  const hourText = match[4];
  const minuteText = match[5];
  const secondText = match[6];
  const fractionText = match[7];
  const zoneText = match[8];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined ||
    zoneText === undefined
  ) {
    return null;
  }

  const year = BigInt(yearText);
  const month = BigInt(monthText);
  const day = BigInt(dayText);
  const adjustedYear = year - (month <= 2n ? 1n : 0n);
  const era = floorDivide(adjustedYear, 400n);
  const yearOfEra = adjustedYear - era * 400n;
  const shiftedMonth = month + (month > 2n ? -3n : 9n);
  const dayOfYear = (153n * shiftedMonth + 2n) / 5n + day - 1n;
  const dayOfEra =
    yearOfEra * 365n +
    yearOfEra / 4n -
    yearOfEra / 100n +
    dayOfYear;
  const epochDays =
    era * DAYS_PER_400_YEARS + dayOfEra - CIVIL_EPOCH_OFFSET_DAYS;
  const localSeconds =
    epochDays * SECONDS_PER_DAY +
    BigInt(hourText) * 3_600n +
    BigInt(minuteText) * 60n +
    BigInt(secondText);

  let offsetMinutes = 0n;
  if (zoneText !== "Z") {
    const offsetSign = match[9];
    const offsetHourText = match[10];
    const offsetMinuteText = match[11];
    if (
      offsetSign === undefined ||
      offsetHourText === undefined ||
      offsetMinuteText === undefined
    ) {
      return null;
    }
    const offsetMagnitude =
      BigInt(offsetHourText) * 60n + BigInt(offsetMinuteText);
    offsetMinutes = offsetSign === "+" ? offsetMagnitude : -offsetMagnitude;
  }

  const fractionNanoseconds =
    fractionText === undefined
      ? 0n
      : BigInt(fractionText.padEnd(9, "0"));
  return (
    (localSeconds - offsetMinutes * 60n) * NANOSECONDS_PER_SECOND +
    fractionNanoseconds
  ) as Rfc3339InstantNanoseconds;
}

export function compareRfc3339Instants(
  left: string,
  right: string,
): Rfc3339InstantComparison | null {
  const leftInstant = parseRfc3339Instant(left);
  const rightInstant = parseRfc3339Instant(right);
  if (leftInstant === null || rightInstant === null) return null;
  if (leftInstant < rightInstant) return -1;
  if (leftInstant > rightInstant) return 1;
  return 0;
}

export function formatRfc3339InstantUtc(
  instantNanoseconds: bigint,
): string | null {
  if (typeof instantNanoseconds !== "bigint") return null;

  const epochSeconds = floorDivide(
    instantNanoseconds,
    NANOSECONDS_PER_SECOND,
  );
  const fractionNanoseconds =
    instantNanoseconds - epochSeconds * NANOSECONDS_PER_SECOND;
  const epochDays = floorDivide(epochSeconds, SECONDS_PER_DAY);
  const secondOfDay = epochSeconds - epochDays * SECONDS_PER_DAY;

  const shiftedDays = epochDays + CIVIL_EPOCH_OFFSET_DAYS;
  const era = floorDivide(shiftedDays, DAYS_PER_400_YEARS);
  const dayOfEra = shiftedDays - era * DAYS_PER_400_YEARS;
  const yearOfEra =
    (dayOfEra -
      dayOfEra / 1_460n +
      dayOfEra / 36_524n -
      dayOfEra / 146_096n) /
    365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear =
    dayOfEra -
    (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * monthPrime + 2n) / 5n + 1n;
  const month = monthPrime + (monthPrime < 10n ? 3n : -9n);
  year += month <= 2n ? 1n : 0n;
  if (year < 0n || year > 9_999n) return null;

  const hour = secondOfDay / 3_600n;
  const minute = (secondOfDay % 3_600n) / 60n;
  const second = secondOfDay % 60n;
  const fraction = fractionNanoseconds
    .toString()
    .padStart(9, "0")
    .replace(/0+$/u, "");
  const formatted = `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}T${hour
    .toString()
    .padStart(2, "0")}:${minute.toString().padStart(2, "0")}:${second
    .toString()
    .padStart(2, "0")}${fraction.length === 0 ? "" : `.${fraction}`}Z`;

  return ADMIN_CONTROL_RFC3339_PATTERN.test(formatted) ? formatted : null;
}

export function addRfc3339Milliseconds(
  value: string,
  milliseconds: bigint,
): string | null {
  if (typeof milliseconds !== "bigint") return null;
  const instant = parseRfc3339Instant(value);
  if (instant === null) return null;
  return formatRfc3339InstantUtc(
    instant + milliseconds * NANOSECONDS_PER_MILLISECOND,
  );
}
