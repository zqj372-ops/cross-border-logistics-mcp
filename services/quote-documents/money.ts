import Decimal from 'decimal.js';

export const MONEY_DECIMAL_PRECISION=48;
export const MONEY_DECIMAL_ROUNDING=Decimal.ROUND_HALF_UP;
export const D=Decimal.clone({precision:MONEY_DECIMAL_PRECISION,rounding:MONEY_DECIMAL_ROUNDING});

export function roundMoney(value:Decimal.Value):string{
  return new D(value).toFixed(2);
}

export function divideRatio(numerator:Decimal.Value,denominator:Decimal.Value):string|null{
  const divisor=new D(denominator);
  if(divisor.isZero())return null;
  return new D(numerator).div(divisor).toDecimalPlaces(6,D.rounding).toFixed(6);
}
